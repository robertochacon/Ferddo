import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Building2, Lock, Sparkles, Upload } from 'lucide-react'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Avatar } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/auth/AuthProvider'
import { useUpdateTenant, type TenantUpdate } from '@/hooks/tenant'
import { useBusinessTypes } from '@/hooks/core'
import { uploadFile } from '@/lib/storage'
import { errorMessage } from '@/lib/errors'
import { DR_PROVINCES, MODULE_LABEL, checkDocNumber } from '@/lib/labels'
import type { ModuleCode, Tenant } from '@/types/db'
import { CheckRow, onlyDigits } from './parts'

/**
 * Monedas del desplegable. Es la misma lista que sabe pintar `money()` en
 * `@/lib/format`: una que allí no esté saldría con el código por delante.
 */
const CURRENCIES: { code: string; label: string }[] = [
  { code: 'DOP', label: 'DOP · Peso dominicano (RD$)' },
  { code: 'USD', label: 'USD · Dólar (US$)' },
  { code: 'EUR', label: 'EUR · Euro (€)' },
]

/**
 * Zonas horarias ofrecidas. Deciden dónde corta "hoy" y "este mes" en el
 * tablero, el cierre de caja y el conteo mensual de e-CF (`my_plan_usage`).
 */
const TIMEZONES: { value: string; label: string }[] = [
  { value: 'America/Santo_Domingo', label: 'República Dominicana (UTC−4)' },
  { value: 'America/Puerto_Rico', label: 'Puerto Rico (UTC−4)' },
  { value: 'America/New_York', label: 'Nueva York (UTC−5/−4)' },
  { value: 'America/Bogota', label: 'Bogotá (UTC−5)' },
  { value: 'America/Mexico_City', label: 'Ciudad de México (UTC−6)' },
]

const ALL_MODULES = Object.keys(MODULE_LABEL) as ModuleCode[]

/**
 * Aviso bajo el RNC. El dígito verificador es solo un aviso (la existencia real
 * la confirma la DGII); el formato sí lo exige la base.
 */
const RNC_WARNING: Record<'bad_format' | 'bad_check', string> = {
  bad_format: 'Debe tener 9 dígitos (RNC) u 11 (cédula)',
  bad_check: 'El dígito verificador no cuadra: revísalo (se puede guardar igual)',
}

/** Lo que edita el formulario principal: todo menos logo y módulos, que se guardan aparte. */
type CompanyForm = Required<
  Pick<
    TenantUpdate,
    | 'name'
    | 'legal_name'
    | 'rnc'
    | 'business_type'
    | 'phone'
    | 'whatsapp'
    | 'email'
    | 'address'
    | 'province'
    | 'municipality'
    | 'currency'
    | 'timezone'
    | 'receipt_footer'
    | 'prices_include_tax'
    | 'allow_negative_stock'
  >
>

function formFrom(t: Tenant): CompanyForm {
  return {
    name: t.name,
    legal_name: t.legal_name ?? '',
    rnc: t.rnc ?? '',
    business_type: t.business_type,
    phone: t.phone ?? '',
    whatsapp: t.whatsapp ?? '',
    email: t.email ?? '',
    address: t.address ?? '',
    province: t.province ?? '',
    municipality: t.municipality ?? '',
    currency: t.currency,
    timezone: t.timezone,
    receipt_footer: t.receipt_footer ?? '',
    prices_include_tax: t.prices_include_tax,
    allow_negative_stock: t.allow_negative_stock,
  }
}

/** Texto vacío → null: la base guarda "sin dato" como NULL, no como ''. */
const blank = (v: string | null) => (v && v.trim() ? v.trim() : null)

export function CompanySettings() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <CompanyDataCard />
      </div>
      <div className="space-y-4">
        <LogoCard />
        <ModulesCard />
      </div>
    </div>
  )
}

function CompanyDataCard() {
  const { tenant } = useAuth()
  const update = useUpdateTenant()
  const types = useBusinessTypes()
  const toast = useToast()
  const [form, setForm] = useState<CompanyForm | null>(null)

  // Se rehidrata cuando cambia la empresa cargada (también tras el `refresh()`
  // que hace la propia mutación, para que lo guardado sea lo que se ve).
  useEffect(() => {
    if (tenant) setForm(formFrom(tenant))
  }, [tenant])

  if (!tenant || !form) return null

  const set = <K extends keyof CompanyForm>(key: K, value: CompanyForm[K]) => setForm({ ...form, [key]: value })
  const rnc = onlyDigits(form.rnc ?? '')
  const rncCheck = rnc ? checkDocNumber(rnc) : null

  const save = async (e: FormEvent) => {
    e.preventDefault()
    const name = form.name?.trim()
    if (!name) return toast.error('La empresa necesita un nombre comercial.')
    // El formato lo exige la base (check tenants_rnc_format); se avisa antes para
    // no enseñar el error técnico de la restricción.
    if (rnc && rncCheck === 'bad_format') {
      return toast.error('El RNC tiene 9 dígitos y la cédula 11. Revísalo o déjalo vacío.')
    }
    try {
      await update.mutateAsync({
        ...form,
        name,
        rnc: rnc || null,
        legal_name: blank(form.legal_name),
        phone: blank(form.phone),
        whatsapp: onlyDigits(form.whatsapp ?? '') || null,
        email: blank(form.email),
        address: blank(form.address),
        province: blank(form.province),
        municipality: blank(form.municipality),
        receipt_footer: blank(form.receipt_footer),
      })
      toast.success('Datos de la empresa guardados')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudieron guardar los cambios'))
    }
  }

  return (
    <Card>
      <CardHeader title="Datos de la empresa" subtitle="Aparecen en tus facturas, recibos y comprobantes" />
      <CardBody>
        <form onSubmit={save} className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Nombre comercial" required>
              <div className="relative">
                <Building2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input required value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} className="pl-9" />
              </div>
            </Field>
            <Field label="Razón social" hint="Como aparece en la DGII">
              <Input value={form.legal_name ?? ''} onChange={(e) => set('legal_name', e.target.value)} />
            </Field>
            <Field
              label="RNC o cédula"
              hint="Solo números: 9 dígitos (RNC) u 11 (cédula)"
              error={rncCheck && rncCheck !== 'ok' ? RNC_WARNING[rncCheck] : undefined}
            >
              <Input
                inputMode="numeric"
                maxLength={13}
                value={form.rnc ?? ''}
                onChange={(e) => set('rnc', onlyDigits(e.target.value))}
              />
            </Field>
            <Field label="Tipo de negocio">
              <Select value={form.business_type ?? 'other'} onChange={(e) => set('business_type', e.target.value)}>
                {(types.data ?? []).map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.label}
                  </option>
                ))}
                {/* Mientras carga el catálogo, que el valor actual no quede huérfano. */}
                {!types.data && <option value={form.business_type ?? 'other'}>{form.business_type}</option>}
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Teléfono">
              <Input inputMode="tel" value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
            </Field>
            <Field label="WhatsApp" hint="Ej. 18095551234">
              <Input inputMode="tel" value={form.whatsapp ?? ''} onChange={(e) => set('whatsapp', e.target.value)} />
            </Field>
            <Field label="Correo">
              <Input type="email" inputMode="email" value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Provincia">
              <Select value={form.province ?? ''} onChange={(e) => set('province', e.target.value)}>
                <option value="">Selecciona…</option>
                {DR_PROVINCES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Municipio">
              <Input value={form.municipality ?? ''} onChange={(e) => set('municipality', e.target.value)} />
            </Field>
          </div>
          <Field label="Dirección">
            <Input value={form.address ?? ''} onChange={(e) => set('address', e.target.value)} />
          </Field>

          <div className="border-t border-slate-100 pt-5">
            <p className="mb-3 text-sm font-semibold text-slate-800">Ventas y recibos</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Moneda" hint="Con la que se muestran los importes">
                <Select value={form.currency ?? 'DOP'} onChange={(e) => set('currency', e.target.value)}>
                  {CURRENCIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Zona horaria" hint="Define cuándo empieza el día y el mes">
                <Select value={form.timezone ?? 'America/Santo_Domingo'} onChange={(e) => set('timezone', e.target.value)}>
                  {TIMEZONES.map((z) => (
                    <option key={z.value} value={z.value}>
                      {z.label}
                    </option>
                  ))}
                  {!TIMEZONES.some((z) => z.value === form.timezone) && (
                    <option value={form.timezone ?? ''}>{form.timezone}</option>
                  )}
                </Select>
              </Field>
            </div>
            <div className="mt-4 space-y-2">
              <CheckRow
                checked={Boolean(form.prices_include_tax)}
                onChange={(v) => set('prices_include_tax', v)}
                label="Los precios ya incluyen ITBIS"
                hint="Lo habitual en RD: el precio de góndola es el final y el impuesto se despeja de él. Desmárcalo si tus precios son antes de impuestos."
              />
              <CheckRow
                checked={Boolean(form.allow_negative_stock)}
                onChange={(v) => set('allow_negative_stock', v)}
                label="Permitir vender sin existencia"
                hint="Deja vender aunque el inventario marque cero (queda en negativo y el reporte lo señala). Apágalo si necesitas control estricto."
              />
            </div>
            <Field label="Pie del recibo" hint="Se imprime al final de cada recibo: políticas de cambio, redes, agradecimiento…" className="mt-4">
              <Textarea rows={3} maxLength={300} value={form.receipt_footer ?? ''} onChange={(e) => set('receipt_footer', e.target.value)} />
            </Field>
          </div>

          <div className="flex justify-end">
            <Button type="submit" loading={update.isPending}>
              Guardar cambios
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}

function LogoCard() {
  const { tenant } = useAuth()
  const update = useUpdateTenant()
  const toast = useToast()
  const [uploading, setUploading] = useState(false)
  if (!tenant) return null

  const onLogo = async (file: File) => {
    if (!file.type.startsWith('image/')) return toast.error('El logo tiene que ser una imagen.')
    if (file.size > 2 * 1024 * 1024) return toast.error('El logo pesa más de 2 MB. Usa una imagen más liviana.')
    setUploading(true)
    try {
      // Bucket `logos`: es el público, y su política solo deja escribir dentro
      // de la carpeta `<tenant_id>/` (ver @/lib/storage).
      const { publicUrl } = await uploadFile('logos', tenant.id, file, 'logo-')
      await update.mutateAsync({ logo_url: publicUrl })
      toast.success('Logo actualizado')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo subir el logo'))
    } finally {
      setUploading(false)
    }
  }

  return (
    <Card>
      <CardHeader title="Logo" subtitle="Sale en la cabecera y en los recibos" />
      <CardBody className="flex items-center gap-4">
        <Avatar name={tenant.name} src={tenant.logo_url} size="lg" />
        {/* Un <label> con el input escondido dentro: el selector de archivos
            nativo no se puede estilar, y así el área visible es un botón normal
            de 44px que sí se puede tocar con el pulgar. */}
        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
          <Upload className="h-4 w-4" />
          {uploading ? 'Subiendo…' : 'Cambiar logo'}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void onLogo(f)
              // Se limpia el valor: sin esto, volver a elegir EL MISMO archivo
              // no dispara `change` y parecería que la app se quedó colgada.
              e.target.value = ''
            }}
          />
        </label>
      </CardBody>
    </Card>
  )
}

/**
 * Módulos encendidos en la empresa. El efectivo es este ∩ los del plan
 * (`tenant_has_module`, 0013): uno que el plan no incluye se puede dejar
 * marcado, pero no funciona hasta cambiar de plan — por eso se enseña bloqueado.
 */
function ModulesCard() {
  const { tenant, plan } = useAuth()
  const types = useBusinessTypes()
  const update = useUpdateTenant()
  const toast = useToast()
  const [selected, setSelected] = useState<ModuleCode[]>([])

  useEffect(() => {
    if (tenant) setSelected(tenant.modules ?? [])
  }, [tenant])

  const suggested = useMemo(
    () => (types.data ?? []).find((t) => t.code === tenant?.business_type)?.modules ?? null,
    [types.data, tenant?.business_type],
  )

  if (!tenant) return null

  const allowed = (m: ModuleCode) => plan.modules == null || plan.modules.includes(m)
  const dirty =
    selected.length !== tenant.modules.length || selected.some((m) => !tenant.modules.includes(m))

  const toggle = (m: ModuleCode, on: boolean) =>
    setSelected((prev) => (on ? [...prev.filter((x) => x !== m), m] : prev.filter((x) => x !== m)))

  const save = async () => {
    if (!selected.includes('pos')) {
      if (!window.confirm('Sin el Punto de venta no se pueden registrar ventas. ¿Guardar igual?')) return
    }
    try {
      // Orden estable (el del catálogo) para que dos guardados iguales no
      // parezcan cambios en la bitácora.
      await update.mutateAsync({ modules: ALL_MODULES.filter((m) => selected.includes(m)) })
      toast.success('Módulos actualizados')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudieron guardar los módulos'))
    }
  }

  return (
    <Card>
      <CardHeader title="Módulos" subtitle={`Tu plan ${plan.name} decide cuáles puedes usar`} />
      <CardBody className="space-y-2">
        {ALL_MODULES.map((m) => {
          const ok = allowed(m)
          return (
            <CheckRow
              key={m}
              checked={selected.includes(m)}
              onChange={(v) => toggle(m, v)}
              label={MODULE_LABEL[m]}
              extra={
                !ok && (
                  <Badge tone="amber">
                    <Lock className="h-3 w-3" /> No incluido en tu plan
                  </Badge>
                )
              }
            />
          )
        })}
        {suggested && (
          <button
            type="button"
            onClick={() => setSelected(suggested)}
            className="flex items-center gap-1.5 pt-1 text-xs font-medium text-brand-600 hover:underline"
          >
            <Sparkles className="h-3.5 w-3.5" /> Usar los recomendados para mi tipo de negocio
          </button>
        )}
        <div className="flex justify-end pt-2">
          <Button size="sm" onClick={() => void save()} disabled={!dirty} loading={update.isPending}>
            Guardar módulos
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}
