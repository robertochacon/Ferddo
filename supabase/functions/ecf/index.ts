// ═══════════════════════════════════════════════════════════════════════════
// Ferddo · Edge Function `ecf` — procesador de la cola de e-CF
//
// Rutas (todas POST):
//   /ecf/process      La app, con el JWT del usuario: procesa la cola de SU
//                     empresa activa (botón "Procesar cola ahora").
//   /ecf/cron         Un programador (pg_cron + pg_net o uno externo), con la
//                     cabecera `x-cron-secret`: procesa todas las empresas.
//   /ecf/credentials  Dueño o `fiscal.manage`: sube certificado/credenciales,
//                     que se guardan CIFRADOS en fiscal_secrets.
//
// SEGURIDAD
//   • `verify_jwt = false` en config.toml SOLO porque /cron no lleva JWT. Las
//     rutas de la app validan el token aquí con auth.getUser(): el gateway
//     aceptaría también la anon key —pública— como JWT, así que esa
//     verificación no identificaría a nadie de todos modos.
//   • La empresa se deriva en el servidor (profiles.tenant_id + membresía
//     activa). Nunca se acepta un tenant_id del cuerpo.
//   • La cola (ecf_claim / ecf_record_result) es exclusiva de service_role.
//   • Ningún secreto vuelve en una respuesta ni se escribe en logs o eventos.
//
// Despliegue (no lo hace este repo solo):
//   supabase functions deploy ecf
//   supabase secrets set FISCAL_ENC_KEY="$(openssl rand -base64 32)" ECF_CRON_SECRET="…"
// ═══════════════════════════════════════════════════════════════════════════
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/cors.ts'
import type {
  EcfQueueItem,
  FiscalSecretKind,
  ProviderContext,
  ProviderMessage,
  ProviderResult,
  ProviderResultStatus,
} from '../_shared/ecf/provider.ts'
import { getProvider, providerNotConfiguredMessage } from '../_shared/ecf/registry.ts'
import { decryptSecret, encryptSecret, hasValidKey } from '../_shared/ecf/crypto.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const CRON_SECRET = Deno.env.get('ECF_CRON_SECRET') ?? ''

/** Lote por llamada: el de la app es pequeño para que el botón responda rápido. */
const APP_BATCH = 20
const CRON_BATCH = 50
/**
 * Margen de tiempo de la invocación. Lo que quede sin procesar al pasarlo se
 * devuelve a la cola con un reintento en vez de esperar los 10 minutos con que
 * ecf_claim() recupera un `sending` huérfano.
 */
const TIME_BUDGET_MS = 100_000

const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }

function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: NO_SESSION })
}

/** Cliente "como el usuario": las RPC se evalúan con SU auth.uid(). */
function userClient(jwt: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: NO_SESSION,
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  })
}

// ── Saneado ─────────────────────────────────────────────────────────────────
// Todo lo que vuelve de un proveedor acaba en electronic_invoices y en la
// bitácora inmutable de eventos, que lee el negocio. Un proveedor mal escrito
// podría devolver un token o un trozo del certificado en un mensaje de error:
// se recorta aquí, antes de tocar la base, y no se puede borrar después.

function sanitizeText(value: unknown, max: number): string {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value)
  return s
    // Cadenas largas tipo base64/hex/JWT: certificados, tokens, firmas.
    .replace(/[A-Za-z0-9+/_=.-]{48,}/g, '[redactado]')
    .replace(/\b(bearer|token|password|passwd|secret|apikey|api_key|authorization|contraseña)\b\s*[:=]?\s*\S+/gi, '$1 [redactado]')
    .slice(0, max)
}

function describeError(err: unknown): string {
  if (err instanceof Error) return sanitizeText(err.message, 1000)
  if (err && typeof err === 'object' && 'message' in err) {
    return sanitizeText((err as { message: unknown }).message, 1000)
  }
  return 'Error desconocido'
}

const RESULT_STATUSES: ProviderResultStatus[] = ['sent', 'accepted', 'accepted_conditional', 'rejected', 'error']

function sanitizeResult(r: ProviderResult, simulated: boolean): ProviderResult {
  const status = RESULT_STATUSES.includes(r.status) ? r.status : 'error'
  const out: ProviderResult = { status }
  if (r.track_id && /^[A-Za-z0-9._:-]{1,100}$/.test(r.track_id)) out.track_id = r.track_id
  if (r.security_code && /^[A-Za-z0-9]{1,20}$/.test(r.security_code)) out.security_code = r.security_code
  // Un QR solo si viene de un proveedor REAL y es https: el simulador no debe
  // poder fabricar un enlace de verificación que parezca oficial.
  if (!simulated && r.qr_url && /^https:\/\/\S{1,1000}$/.test(r.qr_url)) out.qr_url = r.qr_url
  if (r.signed_at && !Number.isNaN(Date.parse(r.signed_at))) out.signed_at = new Date(r.signed_at).toISOString()
  if (r.xml_path && /^[A-Za-z0-9/_.-]{1,300}$/.test(r.xml_path) && !r.xml_path.includes('..')) out.xml_path = r.xml_path
  if (Array.isArray(r.messages)) {
    out.messages = r.messages.slice(0, 20).map((m): ProviderMessage => {
      const msg: ProviderMessage = { message: sanitizeText(m?.message, 500) }
      if (m?.code) msg.code = sanitizeText(m.code, 40)
      return msg
    })
  }
  if (r.error) out.error = sanitizeText(r.error, 1000)
  if (status === 'error' && !out.error) out.error = 'Error del proveedor sin detalle'
  return out
}

// ── Autenticación de la app ─────────────────────────────────────────────────
interface Caller {
  userId: string
  tenantId: string
  client: SupabaseClient
}

function bearer(req: Request): string {
  const h = req.headers.get('Authorization') ?? ''
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : ''
}

async function resolveCaller(req: Request, admin: SupabaseClient): Promise<Caller | Response> {
  const jwt = bearer(req)
  if (!jwt) return json({ error: 'No autorizado' }, 401)

  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: NO_SESSION })
  const { data, error } = await anon.auth.getUser(jwt)
  const user = data?.user
  if (error || !user) return json({ error: 'Sesión inválida o vencida. Vuelve a iniciar sesión.' }, 401)

  // Empresa ACTIVA = puntero del perfil + membresía activa (mismo criterio que
  // auth_tenant_id()). Desactivar a un empleado le corta esto en el acto.
  const { data: prof, error: profErr } = await admin
    .from('profiles')
    .select('tenant_id')
    .eq('id', user.id)
    .maybeSingle()
  if (profErr) throw profErr
  const tenantId = (prof as { tenant_id: string | null } | null)?.tenant_id ?? null
  if (!tenantId) return json({ error: 'Tu cuenta no tiene una empresa activa.' }, 403)

  const { data: member, error: memErr } = await admin
    .from('tenant_members')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('user_id', user.id)
    .eq('is_active', true)
    .maybeSingle()
  if (memErr) throw memErr
  if (!member) return json({ error: 'Tu acceso a esta empresa no está activo.' }, 403)

  return { userId: user.id, tenantId, client: userClient(jwt) }
}

/** has_perm() evaluado COMO el usuario: la misma autoridad que usa la RLS. */
async function hasPerm(client: SupabaseClient, perm: string): Promise<boolean> {
  const { data, error } = await client.rpc('has_perm', { p_perm: perm })
  if (error) throw error
  return data === true
}

// ── Cola ────────────────────────────────────────────────────────────────────
interface Summary {
  claimed: number
  submitted: number
  status_checked: number
  sent: number
  accepted: number
  accepted_conditional: number
  rejected: number
  errors: number
}

function emptySummary(): Summary {
  return {
    claimed: 0,
    submitted: 0,
    status_checked: 0,
    sent: 0,
    accepted: 0,
    accepted_conditional: 0,
    rejected: 0,
    errors: 0,
  }
}

function makeContext(admin: SupabaseClient, item: EcfQueueItem): ProviderContext {
  const cache = new Map<FiscalSecretKind, string | null>()
  const p = item.payload
  return {
    tenantId: p.tenant_id,
    environment: p.environment,
    config: p.provider_config ?? {},
    async getSecret(kind) {
      if (cache.has(kind)) return cache.get(kind) ?? null
      const { data, error } = await admin
        .from('fiscal_secrets')
        .select('ciphertext, iv')
        .eq('tenant_id', p.tenant_id)
        .eq('kind', kind)
        .maybeSingle()
      if (error) throw error
      const row = data as { ciphertext: string; iv: string } | null
      const value = row ? await decryptSecret(row) : null
      cache.set(kind, value)
      return value
    },
  }
}

/**
 * Fallo técnico. OJO con la acción: si el documento ya estaba `sent` (la DGII
 * ya lo tiene) y lo que falló fue la CONSULTA, se deja en `sent` con el error
 * en la bitácora. Pasarlo a `error` haría que ecf_claim() lo ENVIARA de nuevo.
 */
function technicalFailure(trackId: string | null, message: string): ProviderResult {
  if (trackId) return { status: 'sent', track_id: trackId, error: message }
  return { status: 'error', error: message }
}

async function record(admin: SupabaseClient, invoiceId: string, result: ProviderResult, summary: Summary) {
  const { error } = await admin.rpc('ecf_record_result', { p_id: invoiceId, p_result: result })
  if (error) throw error
  if (result.status === 'error') summary.errors++
  else summary[result.status]++
}

async function processItem(admin: SupabaseClient, item: EcfQueueItem, summary: Summary, deadline: number) {
  const p = item.payload
  // trackId conocido = la DGII/proveedor YA tiene el documento.
  let knownTrack: string | null = item.action === 'status' ? p.track_id : null
  if (Date.now() > deadline) {
    await record(admin, p.invoice_id, technicalFailure(knownTrack, 'Lote interrumpido por tiempo; se reintentará automáticamente.'), summary)
    return
  }

  const provider = getProvider(p.provider)
  if (!provider) {
    await record(admin, p.invoice_id, technicalFailure(knownTrack, providerNotConfiguredMessage(p.provider)), summary)
    return
  }

  let result: ProviderResult
  try {
    const check = provider.validateConfiguration({ environment: p.environment, config: p.provider_config ?? {} })
    if (!check.ok) {
      result = technicalFailure(knownTrack, check.errors.join(' '))
    } else {
      const ctx = makeContext(admin, item)
      await provider.authenticate(ctx)
      if (item.action === 'status' && p.track_id) {
        summary.status_checked++
        result = await provider.getInvoiceStatus(p.track_id, p, ctx)
      } else {
        // Un `status` sin trackId no debería existir; si aparece, se envía.
        summary.submitted++
        result = await provider.submitInvoice(p, ctx)
      }
      result = sanitizeResult(result, provider.simulated)
      // Proveedor que resuelve en el acto (el simulador): se registra el
      // `sent` —queda en la bitácora como paso propio— y se consulta ya.
      if (result.status === 'sent' && result.track_id && provider.resolvesImmediately) {
        await record(admin, p.invoice_id, result, summary)
        knownTrack = result.track_id
        summary.status_checked++
        const verdict = await provider.getInvoiceStatus(result.track_id, { ...p, track_id: result.track_id }, ctx)
        result = verdict
      }
    }
  } catch (err) {
    result = technicalFailure(knownTrack, describeError(err))
  }
  await record(admin, p.invoice_id, sanitizeResult(result, provider.simulated), summary)
}

async function processQueue(admin: SupabaseClient, tenantId: string | null, limit: number): Promise<Summary> {
  const deadline = Date.now() + TIME_BUDGET_MS
  const { data, error } = await admin.rpc('ecf_claim', { p_tenant: tenantId, p_limit: limit })
  if (error) throw error
  // Cast acotado: jsonb de ecf_claim(), forma fijada en la migración 0016.
  const items = (Array.isArray(data) ? data : []) as EcfQueueItem[]
  const summary = emptySummary()
  summary.claimed = items.length
  // En serie a propósito: los proveedores reales limitan la tasa por emisor y
  // un lote de 20–50 cabe de sobra en el tiempo de la invocación.
  for (const item of items) {
    try {
      await processItem(admin, item, summary, deadline)
    } catch (err) {
      // Falló la propia base al registrar: el documento queda `sending` y
      // ecf_claim() lo recupera a los 10 minutos. Se sigue con el resto.
      summary.errors++
      console.error('[ecf] no se pudo registrar el resultado de', item.payload?.invoice_id, describeError(err))
    }
  }
  return summary
}

// ── Credenciales ────────────────────────────────────────────────────────────
interface CredentialsBody {
  certificate_base64?: unknown
  certificate_password?: unknown
  certificate_filename?: unknown
  provider_credentials?: unknown
}

const MAX_CERT_B64 = 200_000 // ~150 KB: un .p12 típico pesa unos pocos KB.

async function saveCredentials(req: Request, admin: SupabaseClient, caller: Caller): Promise<Response> {
  if (!(await hasPerm(caller.client, 'fiscal.manage'))) {
    return json({ error: 'No tienes permiso para configurar la facturación electrónica.' }, 403)
  }

  let body: CredentialsBody
  try {
    body = (await req.json()) as CredentialsBody
  } catch {
    return json({ error: 'Cuerpo inválido' }, 400)
  }

  const toStore: { kind: FiscalSecretKind; value: string }[] = []

  if (typeof body.certificate_base64 === 'string' && body.certificate_base64.trim()) {
    // Acepta un data-URL (FileReader.readAsDataURL) o base64 a secas.
    const cert = body.certificate_base64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '')
    if (cert.length > MAX_CERT_B64) return json({ error: 'El certificado es demasiado grande.' }, 400)
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cert)) return json({ error: 'El certificado no es un archivo válido.' }, 400)
    try {
      atob(cert)
    } catch {
      return json({ error: 'El certificado no es un archivo válido.' }, 400)
    }
    toStore.push({ kind: 'certificate', value: cert })
  }
  if (typeof body.certificate_password === 'string' && body.certificate_password !== '') {
    if (body.certificate_password.length > 256) return json({ error: 'La contraseña es demasiado larga.' }, 400)
    toStore.push({ kind: 'certificate_password', value: body.certificate_password })
  }
  if (body.provider_credentials != null && body.provider_credentials !== '') {
    const pc = body.provider_credentials
    const serialized = typeof pc === 'string' ? pc : JSON.stringify(pc)
    if (typeof pc !== 'string' && (typeof pc !== 'object' || Array.isArray(pc))) {
      return json({ error: 'Las credenciales del proveedor deben ser un objeto clave-valor.' }, 400)
    }
    if (serialized.length > 10_000) return json({ error: 'Las credenciales del proveedor son demasiado largas.' }, 400)
    if (serialized.trim() && serialized !== '{}') toStore.push({ kind: 'provider_credentials', value: serialized })
  }

  if (!toStore.length) {
    return json({ error: 'Envía al menos el certificado, su contraseña o las credenciales del proveedor.' }, 400)
  }
  if (!(await hasValidKey())) {
    console.error('[ecf] FISCAL_ENC_KEY ausente o inválida: no se guardan credenciales.')
    return json({ error: 'El servidor no tiene configurada la clave de cifrado. Contacta a soporte.' }, 503)
  }

  const { data: existing, error: exErr } = await admin
    .from('fiscal_secrets')
    .select('kind')
    .eq('tenant_id', caller.tenantId)
  if (exErr) throw exErr
  const had = new Set(((existing ?? []) as { kind: FiscalSecretKind }[]).map((r) => r.kind))

  const now = new Date().toISOString()
  const rows = []
  for (const s of toStore) {
    const enc = await encryptSecret(s.value)
    rows.push({
      tenant_id: caller.tenantId,
      kind: s.kind,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      key_version: enc.key_version,
      rotated_at: had.has(s.kind) ? now : null,
    })
  }
  const { error: upErr } = await admin.from('fiscal_secrets').upsert(rows, { onConflict: 'tenant_id,kind' })
  if (upErr) throw upErr

  const kinds = new Set<FiscalSecretKind>([...had, ...toStore.map((s) => s.kind)])
  const { data: fs, error: fsErr } = await admin
    .from('fiscal_settings')
    .select('certificate_info')
    .eq('tenant_id', caller.tenantId)
    .maybeSingle()
  if (fsErr) throw fsErr
  const prev = ((fs as { certificate_info: Record<string, unknown> | null } | null)?.certificate_info ?? {}) as Record<
    string,
    unknown
  >

  // Solo metadatos NO secretos: qué hay cargado y cuándo. El nombre de
  // archivo se limpia de rutas y caracteres raros.
  const filename = typeof body.certificate_filename === 'string'
    ? body.certificate_filename.split(/[\\/]/).pop()?.replace(/[^\w.\- ()]/g, '').slice(0, 120) || null
    : null
  const uploadedCert = toStore.some((s) => s.kind === 'certificate')
  const info: Record<string, unknown> = {
    uploaded_at: now,
    certificate_filename: uploadedCert ? filename : prev.certificate_filename ?? null,
    certificate_uploaded_at: uploadedCert ? now : prev.certificate_uploaded_at ?? null,
    has_certificate: kinds.has('certificate'),
    has_certificate_password: kinds.has('certificate_password'),
    has_provider_credentials: kinds.has('provider_credentials'),
  }

  const { error: setErr } = await admin
    .from('fiscal_settings')
    .upsert(
      { tenant_id: caller.tenantId, credentials_set: true, certificate_info: info, updated_by: caller.userId },
      { onConflict: 'tenant_id' },
    )
  if (setErr) throw setErr

  const { error: auditErr } = await admin.from('audit_logs').insert({
    tenant_id: caller.tenantId,
    user_id: caller.userId,
    action: 'fiscal.credentials_uploaded',
    entity: 'fiscal_settings',
    entity_id: caller.tenantId,
    meta: { kinds: toStore.map((s) => s.kind) },
  })
  // La bitácora no debe tumbar una carga ya guardada.
  if (auditErr) console.error('[ecf] no se pudo auditar la carga de credenciales', auditErr.message)

  return json({ ok: true, credentials_set: true, certificate_info: info })
}

// ── Cron ────────────────────────────────────────────────────────────────────
/** Comparación en tiempo constante: no filtra por tiempos cuántos caracteres acertó. */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  let diff = ea.length ^ eb.length
  const n = Math.max(ea.length, eb.length)
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0)
  return diff === 0
}

// ── Entrada ─────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405)
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    return json({ error: 'La función no tiene las variables de Supabase configuradas.' }, 500)
  }

  const route = new URL(req.url).pathname.replace(/\/+$/, '').split('/').pop() ?? ''
  const admin = adminClient()

  try {
    if (route === 'cron') {
      if (!CRON_SECRET) return json({ error: 'ECF_CRON_SECRET no está configurado.' }, 503)
      if (!safeEqual(req.headers.get('x-cron-secret') ?? '', CRON_SECRET)) {
        return json({ error: 'No autorizado' }, 401)
      }
      const summary = await processQueue(admin, null, CRON_BATCH)
      return json({ ok: true, ...summary })
    }

    if (route === 'process' || route === 'credentials') {
      const caller = await resolveCaller(req, admin)
      if (caller instanceof Response) return caller

      if (route === 'credentials') return await saveCredentials(req, admin, caller)

      const allowed = (await hasPerm(caller.client, 'ecf.view')) || (await hasPerm(caller.client, 'sales.create'))
      if (!allowed) return json({ error: 'No tienes permiso para procesar comprobantes.' }, 403)
      const summary = await processQueue(admin, caller.tenantId, APP_BATCH)
      return json({ ok: true, ...summary })
    }

    return json({ error: 'Ruta no encontrada' }, 404)
  } catch (err) {
    // Solo el mensaje saneado: nunca el cuerpo de la petición.
    console.error('[ecf]', route, describeError(err))
    return json({ error: 'No se pudo completar la operación. Inténtalo de nuevo en unos minutos.' }, 500)
  }
})
