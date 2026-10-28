import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { AlertTriangle, KeyRound, Lock, ShieldAlert, ShieldCheck, Upload } from 'lucide-react'
import {
  useEcfTypes,
  useSaveFiscalSettings,
  useUploadFiscalCredentials,
  type FiscalCredentialsInput,
  type FiscalSettingsInput,
} from '@/hooks/invoicing'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { useToast } from '@/components/ui/toast'
import { checkDocNumber } from '@/lib/labels'
import { errorMessage } from '@/lib/errors'
import { fmtDateTime } from '@/lib/format'
import { ENV_INFO, FISCAL_STATUS, FunctionError, PROVIDER_LABEL, providerLabel } from '@/features/invoicing/shared'
import type { FiscalSettings } from '@/types/erp'

const ENVIRONMENTS: FiscalSettings['environment'][] = ['test', 'certification', 'production']

function initialForm(s: FiscalSettings | null): FiscalSettingsInput {
  return {
    rnc: s?.rnc ?? '',
    legal_name: s?.legal_name ?? '',
    trade_name: s?.trade_name ?? '',
    fiscal_address: s?.fiscal_address ?? '',
    email: s?.email ?? '',
    phone: s?.phone ?? '',
    environment: s?.environment ?? 'test',
    provider: s?.provider ?? 'simulator',
    default_ecf_type: s?.default_ecf_type ?? '32',
    ecf_enabled: s?.ecf_enabled ?? false,
  }
}

const RNC_HINT: Record<ReturnType<typeof checkDocNumber>, string | undefined> = {
  ok: undefined,
  bad_format: 'El RNC tiene 9 dígitos (o 11 si es una cédula).',
  bad_check: 'El dígito verificador no cuadra: revisa el número. La DGII lo rechazará.',
}

export function ConfigTab({ settings }: { settings: FiscalSettings | null }) {
  return (
    <div className="space-y-4">
      <LegalWarning />
      {/* `key`: al guardar, la fila vuelve con otro updated_at y el formulario
          se reinicia con lo que de verdad quedó en la base. */}
      <SettingsForm key={settings?.updated_at ?? 'new'} settings={settings} />
      <CredentialsCard settings={settings} />
    </div>
  )
}

function LegalWarning() {
  return (
    <Card className="border-amber-200 bg-amber-50/60">
      <CardBody className="flex gap-3 text-sm text-amber-900">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="space-y-1">
          <p className="font-semibold">Antes de emitir con validez fiscal</p>
          <p>
            Producción exige estar <strong>autorizado por la DGII como emisor electrónico</strong>, tener un certificado
            digital vigente y un <strong>proveedor certificado</strong> integrado. Hoy Ferddo solo trae el{' '}
            <strong>simulador</strong>, que sirve para practicar y <strong>no tiene validez fiscal</strong>: sus
            comprobantes no existen para la DGII.
          </p>
        </div>
      </CardBody>
    </Card>
  )
}

function SettingsForm({ settings }: { settings: FiscalSettings | null }) {
  const [form, setForm] = useState<FiscalSettingsInput>(() => initialForm(settings))
  const save = useSaveFiscalSettings()
  const types = useEcfTypes()
  const toast = useToast()
  const set = <K extends keyof FiscalSettingsInput>(k: K, v: FiscalSettingsInput[K]) => setForm((f) => ({ ...f, [k]: v }))

  const rncDigits = form.rnc.replace(/\D/g, '')
  const rncHint = rncDigits ? RNC_HINT[checkDocNumber(rncDigits)] : undefined
  const isSim = form.provider === 'simulator'
  const missingForEnable = form.ecf_enabled && (!rncDigits || !form.legal_name.trim() || !form.fiscal_address.trim())
  const blockedProd = isSim && form.environment === 'production'
  const saleTypes = (types.data ?? []).filter((t) => t.is_supported && !t.is_note)
  const status = settings ? FISCAL_STATUS[settings.status] : FISCAL_STATUS.not_configured

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (blockedProd || missingForEnable) return
    save.mutate(
      { ...form, rnc: rncDigits },
      {
        onSuccess: () => toast.success('Configuración fiscal guardada.'),
        onError: (err) => toast.error(errorMessage(err, 'No se pudo guardar la configuración.')),
      },
    )
  }

  return (
    <Card>
      <CardHeader
        title="Datos fiscales y emisión"
        subtitle="Cada empresa factura con su propio RNC."
        action={<Badge tone={status.tone}>{status.label}</Badge>}
      />
      <CardBody>
        <form onSubmit={submit} className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="RNC" required hint={rncHint ?? 'Solo números.'}>
              <Input inputMode="numeric" value={form.rnc} onChange={(e) => set('rnc', e.target.value)} maxLength={13} />
            </Field>
            <Field label="Razón social" required>
              <Input value={form.legal_name} onChange={(e) => set('legal_name', e.target.value)} />
            </Field>
            <Field label="Nombre comercial">
              <Input value={form.trade_name} onChange={(e) => set('trade_name', e.target.value)} />
            </Field>
            <Field label="Correo">
              <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
            </Field>
            <Field label="Teléfono">
              <Input type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
            </Field>
            <Field label="Tipo de comprobante por defecto" hint="El que se propone al vender.">
              <Select value={form.default_ecf_type} onChange={(e) => set('default_ecf_type', e.target.value)}>
                {(saleTypes.length ? saleTypes : [{ code: '31', name: 'Crédito fiscal' }, { code: '32', name: 'Consumo' }]).map(
                  (t) => (
                    <option key={t.code} value={t.code}>
                      {t.code} · {t.name}
                    </option>
                  ),
                )}
              </Select>
            </Field>
            <Field label="Dirección fiscal" required className="sm:col-span-2">
              <Textarea rows={2} value={form.fiscal_address} onChange={(e) => set('fiscal_address', e.target.value)} />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Proveedor">
              <Select value={form.provider} onChange={(e) => set('provider', e.target.value)}>
                {Object.entries(PROVIDER_LABEL).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
                {/* El valor guardado se respeta aunque no esté integrado, para no
                    cambiarlo a escondidas al guardar otra cosa. */}
                {!PROVIDER_LABEL[form.provider] && <option value={form.provider}>{providerLabel(form.provider)}</option>}
                <option value="" disabled>
                  Proveedor autorizado DGII — pendiente de integrar
                </option>
              </Select>
            </Field>
            <Field label="Ambiente">
              <Select
                value={form.environment}
                onChange={(e) => set('environment', e.target.value as FiscalSettings['environment'])}
              >
                {ENVIRONMENTS.map((env) => (
                  <option key={env} value={env} disabled={env === 'production' && isSim}>
                    {ENV_INFO[env].label}
                    {env === 'production' && isSim ? ' (requiere proveedor autorizado)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">
            <strong>{ENV_INFO[form.environment].label}:</strong> {ENV_INFO[form.environment].description}
          </p>

          <label className="flex items-start gap-3 rounded-xl border border-slate-200 p-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-slate-300 text-brand-600"
              checked={form.ecf_enabled}
              onChange={(e) => set('ecf_enabled', e.target.checked)}
            />
            <span className="text-sm">
              <span className="font-medium text-slate-800">Activar comprobantes electrónicos al vender</span>
              <span className="block text-slate-500">
                Cada venta reservará un e-NCF de tus secuencias y quedará en cola para enviarse
                {isSim ? ' al simulador (sin validez fiscal)' : ''}.
              </span>
            </span>
          </label>

          {(missingForEnable || blockedProd) && (
            <p className="flex items-start gap-2 text-sm font-medium text-red-600">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {blockedProd
                ? 'El simulador no puede usarse en producción.'
                : 'Para activar completa RNC, razón social y dirección fiscal.'}
            </p>
          )}

          <div className="flex justify-end">
            <Button type="submit" loading={save.isPending} disabled={missingForEnable || blockedProd}>
              Guardar configuración
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}

// ── Certificado y credenciales ──────────────────────────────────────────────

/** Un .p12/.pfx real pesa unos pocos KB; esto solo frena archivos equivocados. */
const MAX_CERT_BYTES = 150 * 1024

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? '').replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'))
    reader.readAsDataURL(file)
  })
}

interface CertificateMeta {
  uploaded_at?: string
  certificate_filename?: string | null
  certificate_uploaded_at?: string | null
  has_certificate?: boolean
  has_certificate_password?: boolean
  has_provider_credentials?: boolean
}

function CredentialsCard({ settings }: { settings: FiscalSettings | null }) {
  const upload = useUploadFiscalCredentials()
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [password, setPassword] = useState('')
  const [creds, setCreds] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  // Cast acotado: certificate_info es jsonb; la función guarda solo estos campos.
  const meta = (settings?.certificate_info ?? {}) as CertificateMeta

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setFormError(null)
    const input: FiscalCredentialsInput = {}
    if (file) {
      if (file.size > MAX_CERT_BYTES) return setFormError('El archivo es demasiado grande para ser un certificado.')
      try {
        input.certificate_base64 = await readAsBase64(file)
      } catch (err) {
        return setFormError(errorMessage(err))
      }
      input.certificate_filename = file.name
    }
    if (password) input.certificate_password = password
    if (creds.trim()) {
      let parsed: unknown
      try {
        parsed = JSON.parse(creds)
      } catch {
        return setFormError('Las credenciales del proveedor deben ser JSON válido, p. ej. {"usuario": "…", "clave": "…"}.')
      }
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        !Object.values(parsed).every((v) => typeof v === 'string')
      ) {
        return setFormError('Las credenciales deben ser un objeto con valores de texto.')
      }
      input.provider_credentials = parsed as Record<string, string>
    }
    if (!input.certificate_base64 && !input.certificate_password && !input.provider_credentials) {
      return setFormError('Elige el certificado o escribe la contraseña o las credenciales.')
    }
    upload.mutate(input, {
      onSuccess: () => {
        toast.success('Credenciales guardadas y cifradas.')
        // Se borran del formulario: no deben quedarse en memoria de la pantalla.
        setFile(null)
        setPassword('')
        setCreds('')
        if (fileRef.current) fileRef.current.value = ''
      },
      onError: (err) => toast.error(errorMessage(err, 'No se pudieron guardar las credenciales.')),
    })
  }

  return (
    <Card>
      <CardHeader
        title="Certificado digital y credenciales"
        subtitle="Se cifran en el servidor y nunca se muestran de vuelta, ni siquiera al dueño."
        action={
          settings?.credentials_set ? (
            <Badge tone="green">
              <ShieldCheck className="h-3 w-3" /> Cargadas
            </Badge>
          ) : (
            <Badge tone="slate">Sin cargar</Badge>
          )
        }
      />
      <CardBody className="space-y-5">
        {settings?.credentials_set && (
          <dl className="grid grid-cols-1 gap-3 rounded-xl bg-slate-50 p-3 text-sm sm:grid-cols-2">
            <MetaItem label="Certificado" ok={meta.has_certificate}>
              {meta.certificate_filename ?? (meta.has_certificate ? 'Cargado' : 'No cargado')}
              {meta.certificate_uploaded_at && (
                <span className="block text-xs text-slate-500">{fmtDateTime(meta.certificate_uploaded_at)}</span>
              )}
            </MetaItem>
            <MetaItem label="Contraseña del certificado" ok={meta.has_certificate_password}>
              {meta.has_certificate_password ? 'Guardada' : 'No guardada'}
            </MetaItem>
            <MetaItem label="Credenciales del proveedor" ok={meta.has_provider_credentials}>
              {meta.has_provider_credentials ? 'Guardadas' : 'No guardadas'}
            </MetaItem>
            <MetaItem label="Última actualización">{meta.uploaded_at ? fmtDateTime(meta.uploaded_at) : '—'}</MetaItem>
          </dl>
        )}

        <FunctionError error={upload.error} />

        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <Field label="Certificado (.p12 / .pfx)" hint="Lo emite una entidad de certificación autorizada a nombre de la persona o empresa.">
            <Input
              ref={fileRef}
              type="file"
              accept=".p12,.pfx,application/x-pkcs12"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="py-2"
            />
          </Field>
          <Field label="Contraseña del certificado">
            <Input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field
            label="Credenciales del proveedor (opcional)"
            hint="JSON con los datos que te entregue el proveedor autorizado. Se usarán cuando su integración esté disponible."
          >
            <Textarea
              rows={3}
              value={creds}
              onChange={(e) => setCreds(e.target.value)}
              placeholder='{"usuario": "…", "clave": "…"}'
              spellCheck={false}
              autoComplete="off"
              className="font-mono"
            />
          </Field>
          {formError && <p className="text-sm font-medium text-red-600">{formError}</p>}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-2 text-xs text-slate-500">
              <Lock className="h-3.5 w-3.5" /> Cifrado AES-256 con una clave que no vive en la base de datos.
            </p>
            <Button type="submit" loading={upload.isPending}>
              <Upload className="h-4 w-4" /> Guardar credenciales
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}

function MetaItem({ label, ok, children }: { label: string; ok?: boolean; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <KeyRound className={ok ? 'mt-0.5 h-4 w-4 shrink-0 text-emerald-600' : 'mt-0.5 h-4 w-4 shrink-0 text-slate-400'} />
      <div className="min-w-0">
        <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
        <dd className="break-words text-slate-800">{children}</dd>
      </div>
    </div>
  )
}
