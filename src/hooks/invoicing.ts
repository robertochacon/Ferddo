import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { functionsUrl, supabase } from '@/lib/supabase'
import { dayStartIso, addDays } from '@/hooks/reports'
import type {
  EcfStatus,
  EcfType,
  ElectronicInvoice,
  ElectronicInvoiceEvent,
  FiscalSequence,
  FiscalSettings,
} from '@/types/erp'

/*
 * Facturación electrónica (e-CF). Lecturas por RLS y escrituras por las RPC de
 * la migración 0016. Lo que toca secretos o la cola del procesador NO pasa por
 * aquí: va a la Edge Function `ecf`, que es la única con service_role.
 */

// ── Lecturas ────────────────────────────────────────────────────────────────

/** null = la empresa aún no guardó su configuración fiscal. */
export function useFiscalSettings() {
  return useQuery({
    queryKey: ['ecf', 'settings'],
    queryFn: async (): Promise<FiscalSettings | null> => {
      const { data, error } = await supabase.from('fiscal_settings').select('*').maybeSingle()
      if (error) throw error
      return (data as FiscalSettings | null) ?? null
    },
  })
}

export function useEcfTypes() {
  return useQuery({
    queryKey: ['ecf', 'types'],
    // Catálogo global que casi nunca cambia.
    staleTime: 60 * 60_000,
    queryFn: async (): Promise<EcfType[]> => {
      const { data, error } = await supabase.from('ecf_types').select('*').order('sort_order')
      if (error) throw error
      return (data ?? []) as EcfType[]
    },
  })
}

export function useFiscalSequences() {
  return useQuery({
    queryKey: ['ecf', 'sequences'],
    queryFn: async (): Promise<FiscalSequence[]> => {
      const { data, error } = await supabase
        .from('fiscal_sequences')
        .select('*')
        .order('ecf_type')
        .order('start_number')
      if (error) throw error
      // bigint llega como number mientras quepa en 2^53; los e-NCF tienen 10
      // dígitos, así que cabe de sobra.
      return ((data ?? []) as FiscalSequence[]).map((s) => ({
        ...s,
        start_number: Number(s.start_number),
        end_number: Number(s.end_number),
        next_number: Number(s.next_number),
      }))
    },
  })
}

export interface EcfInvoiceFilters {
  status: EcfStatus | ''
  type: string
  /** Días locales 'YYYY-MM-DD' (vacío = sin límite). */
  from: string
  to: string
}

/** Tope de filas: la pantalla es de seguimiento, no un archivo histórico. */
export const ECF_LIST_LIMIT = 200

export function useElectronicInvoices(filters: EcfInvoiceFilters, timezone: string) {
  return useQuery({
    queryKey: ['ecf', 'invoices', filters],
    queryFn: async (): Promise<ElectronicInvoice[]> => {
      let q = supabase
        .from('electronic_invoices')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(ECF_LIST_LIMIT)
      if (filters.status) q = q.eq('status', filters.status)
      if (filters.type) q = q.eq('ecf_type', filters.type)
      // Los días se cortan en la zona de la empresa, igual que los reportes.
      if (filters.from) q = q.gte('issue_date', dayStartIso(filters.from, timezone))
      if (filters.to) q = q.lt('issue_date', dayStartIso(addDays(filters.to, 1), timezone))
      const { data, error } = await q
      if (error) throw error
      return ((data ?? []) as ElectronicInvoice[]).map((i) => ({
        ...i,
        subtotal: Number(i.subtotal),
        tax_total: Number(i.tax_total),
        total: Number(i.total),
        messages: Array.isArray(i.messages) ? i.messages : [],
      }))
    },
  })
}

export function useInvoiceEvents(invoiceId: string | null) {
  return useQuery({
    queryKey: ['ecf', 'events', invoiceId],
    enabled: Boolean(invoiceId),
    queryFn: async (): Promise<ElectronicInvoiceEvent[]> => {
      const { data, error } = await supabase
        .from('electronic_invoice_events')
        .select('id, invoice_id, event, status_from, status_to, detail, created_at')
        .eq('invoice_id', invoiceId as string)
        .order('created_at')
      if (error) throw error
      return (data ?? []) as ElectronicInvoiceEvent[]
    },
  })
}

// ── Escrituras por RPC ──────────────────────────────────────────────────────

export interface FiscalSettingsInput {
  rnc: string
  legal_name: string
  trade_name: string
  fiscal_address: string
  email: string
  phone: string
  environment: FiscalSettings['environment']
  provider: string
  default_ecf_type: string
  ecf_enabled: boolean
}

export function useSaveFiscalSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: FiscalSettingsInput) => {
      const { error } = await supabase.rpc('save_fiscal_settings', { p: input })
      if (error) throw error
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ecf', 'settings'] })
      void qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export interface AddSequenceInput {
  type: string
  start: number
  end: number
  expires_on: string | null
  authorization_ref: string | null
}

export function useAddFiscalSequence() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: AddSequenceInput) => {
      const { data, error } = await supabase.rpc('add_fiscal_sequence', {
        p_type: input.type,
        p_start: input.start,
        p_end: input.end,
        p_expires_on: input.expires_on,
        p_authorization_ref: input.authorization_ref,
      })
      if (error) throw error
      return data as string
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ecf', 'sequences'] }),
  })
}

export function useSetSequenceActive() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { error } = await supabase.rpc('set_fiscal_sequence_active', { p_id: id, p_active: active })
      if (error) throw error
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ecf', 'sequences'] }),
  })
}

export function useRetryEcf() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc('ecf_retry', { p_id: id })
      if (error) throw error
    },
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: ['ecf', 'invoices'] })
      void qc.invalidateQueries({ queryKey: ['ecf', 'events', id] })
      void qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

// ── Edge Function `ecf` ─────────────────────────────────────────────────────

/**
 * Error al hablar con la Edge Function. `notDeployed` distingue "la función no
 * existe / no responde" (hay que desplegarla) de un error que la función SÍ
 * devolvió (permiso, validación), para que la pantalla diga qué hacer.
 */
export class EcfFunctionError extends Error {
  constructor(
    message: string,
    readonly notDeployed: boolean,
  ) {
    super(message)
    this.name = 'EcfFunctionError'
  }
}

export function isEcfNotDeployed(err: unknown): boolean {
  return err instanceof EcfFunctionError && err.notDeployed
}

async function callEcf<T>(route: 'process' | 'credentials', body: unknown): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) throw new Error('Tu sesión expiró. Vuelve a iniciar sesión.')
  if (!functionsUrl) {
    throw new EcfFunctionError('Falta la URL de Supabase en la configuración de la app.', true)
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('Sin conexión a internet. Inténtalo cuando vuelva la señal.')
  }

  let res: Response
  try {
    res = await fetch(`${functionsUrl}/ecf/${route}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        // La anon key es pública (va en el bundle); el gateway la pide.
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body ?? {}),
    })
  } catch {
    // Con conexión, un fallo de red aquí es casi siempre que la función no está
    // desplegada: el gateway responde sin cabeceras CORS y el navegador lo
    // reporta como error de red.
    throw new EcfFunctionError('No se pudo contactar la función de facturación electrónica.', true)
  }

  let payload: Record<string, unknown> = {}
  try {
    payload = (await res.json()) as Record<string, unknown>
  } catch {
    // Respuesta sin JSON (p. ej. el 404 del gateway).
  }
  if (res.status === 404) {
    throw new EcfFunctionError('La función de facturación electrónica no está desplegada.', true)
  }
  if (!res.ok) {
    const msg = typeof payload.error === 'string' ? payload.error : `Error ${res.status}`
    throw new EcfFunctionError(msg, false)
  }
  return payload as T
}

export interface EcfProcessSummary {
  ok: boolean
  claimed: number
  submitted: number
  status_checked: number
  sent: number
  accepted: number
  accepted_conditional: number
  rejected: number
  errors: number
}

/** "Procesar cola ahora": envía/consulta los pendientes de la empresa activa. */
export function useProcessEcfQueue() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => callEcf<EcfProcessSummary>('process', {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ecf', 'invoices'] })
      void qc.invalidateQueries({ queryKey: ['ecf', 'events'] })
      void qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export interface FiscalCredentialsInput {
  /** Contenido del .p12 en base64 (o data-URL). */
  certificate_base64?: string
  certificate_password?: string
  certificate_filename?: string
  provider_credentials?: Record<string, string>
}

export interface FiscalCredentialsResult {
  ok: boolean
  credentials_set: boolean
  certificate_info: Record<string, unknown>
}

/** Sube certificado/credenciales. La función los cifra; nunca vuelven al navegador. */
export function useUploadFiscalCredentials() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: FiscalCredentialsInput) => callEcf<FiscalCredentialsResult>('credentials', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ecf', 'settings'] }),
  })
}
