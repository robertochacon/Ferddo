import { useEffect, useMemo, useState } from 'react'
import { ArrowRightLeft, FileCheck2, Pencil, Plus, Trash2, X } from 'lucide-react'
import { ActionMenu, type ActionItem } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { errorMessage } from '@/lib/errors'
import { num } from '@/lib/format'
import { CheckRow } from '@/features/settings/parts'
import {
  useAdminDeleteEcfProvider, useAdminEcfProviders, useAdminInstalledEcfProviders, useAdminMigrateEcfProvider,
  useAdminSaveEcfProvider, useAdminSetTenantEcfProvider, type EcfProviderInput,
} from '@/hooks/admin'
import type { AdminEcfProviderRow, AdminTenantEcf } from '@/types/db'

/*
 * Proveedores de facturación electrónica (0031), vistos desde el panel.
 *
 * Dos capas que hay que tener claras:
 *   · El CATÁLOGO (`ecf_providers`) dice qué se ofrece a los negocios y qué
 *     datos pide cada proveedor. Se edita aquí.
 *   · El ADAPTADOR (código en supabase/functions/_shared/ecf/) es lo que sabe
 *     hablar con el proveedor. No se crea desde el panel: se escribe con la
 *     documentación técnica del proveedor y se despliega. Por eso cada fila
 *     dice si la función desplegada trae su adaptador.
 */

type FieldDef = AdminEcfProviderRow['config_fields'][number]

/** Lo que el panel sabe del adaptador de un proveedor. */
type AdapterState = 'installed' | 'missing' | 'unknown'
const ADAPTER_BADGE: Record<AdapterState, { label: string; tone: 'green' | 'red' | 'slate' }> = {
  installed: { label: 'Adaptador instalado', tone: 'green' },
  missing: { label: 'Sin adaptador', tone: 'red' },
  unknown: { label: 'Adaptador sin verificar', tone: 'slate' },
}

export function EcfProvidersAdmin() {
  const toast = useToast()
  const providers = useAdminEcfProviders()
  const adapters = useAdminInstalledEcfProviders()
  const remove = useAdminDeleteEcfProvider()
  const [editing, setEditing] = useState<AdminEcfProviderRow | 'new' | null>(null)
  const [migrating, setMigrating] = useState<AdminEcfProviderRow | null>(null)

  const rows = providers.data ?? []
  const adapterOf = (code: string): AdapterState =>
    adapters.data == null ? 'unknown' : adapters.data.has(code) ? 'installed' : 'missing'

  const del = async (p: AdminEcfProviderRow) => {
    if (!window.confirm(`¿Eliminar ${p.name} del catálogo?`)) return
    try {
      await remove.mutateAsync(p.code)
      toast.success('Proveedor eliminado.')
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  // Una sola lista de acciones para la tabla y para las tarjetas.
  const actionsFor = (p: AdminEcfProviderRow): ActionItem[] => {
    const items: ActionItem[] = [{ label: 'Editar', icon: <Pencil className="h-4 w-4" />, onClick: () => setEditing(p) }]
    if (p.tenants > 0) {
      items.push({
        label: 'Migrar negocios a otro proveedor',
        icon: <ArrowRightLeft className="h-4 w-4" />,
        hint: `${num(p.tenants)} negocio(s) lo usan`,
        onClick: () => setMigrating(p),
      })
    }
    if (p.tenants === 0 && p.total_invoices === 0) {
      items.push({ label: 'Eliminar', icon: <Trash2 className="h-4 w-4" />, tone: 'danger', onClick: () => void del(p) })
    }
    return items
  }

  const badges = (p: AdminEcfProviderRow) => (
    <>
      <Badge tone={p.is_enabled ? 'green' : 'slate'}>{p.is_enabled ? 'Ofrecido' : 'No se ofrece'}</Badge>
      {p.is_simulated && <Badge tone="amber">Simulado</Badge>}
      <Badge tone={p.allows_production ? 'brand' : 'slate'}>{p.allows_production ? 'Producción' : 'Sin producción'}</Badge>
      <Badge tone={ADAPTER_BADGE[adapterOf(p.code)].tone}>{ADAPTER_BADGE[adapterOf(p.code)].label}</Badge>
    </>
  )
  const usage = (p: AdminEcfProviderRow) =>
    `${num(p.tenants)} negocios · ${num(p.enabled_tenants)} emitiendo · ${num(p.production_tenants)} en producción`
  const queue = (p: AdminEcfProviderRow) =>
    `${num(p.unsent_invoices)} sin enviar · ${num(p.in_flight_invoices)} en el proveedor`

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Proveedores de facturación electrónica"
          subtitle="Qué proveedores se ofrecen a los negocios y qué datos pide cada uno."
          action={
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus className="h-4 w-4" /> Nuevo
            </Button>
          }
        />
        {providers.isLoading ? (
          <PageLoader label="Cargando proveedores…" />
        ) : providers.isError ? (
          <p className="p-6 text-center text-sm text-red-600">{errorMessage(providers.error, 'No se pudieron cargar los proveedores.')}</p>
        ) : rows.length === 0 ? (
          <EmptyState className="m-5" icon={<FileCheck2 className="h-5 w-5" />} title="Sin proveedores" />
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3 font-medium">Proveedor</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    <th className="px-4 py-3 font-medium">Uso</th>
                    <th className="px-4 py-3 font-medium">Comprobantes</th>
                    <th className="px-4 py-3 text-right font-medium">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {rows.map((p) => (
                    <tr key={p.code} className="align-top">
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-800">{p.name}</p>
                        <p className="font-mono text-xs text-slate-400">{p.code}</p>
                      </td>
                      <td className="px-4 py-3"><div className="flex max-w-xs flex-wrap gap-1">{badges(p)}</div></td>
                      <td className="px-4 py-3 text-slate-600">{usage(p)}</td>
                      <td className="px-4 py-3 text-slate-600">{queue(p)}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end">
                          <ActionMenu title={p.name} label={`Opciones de ${p.name}`} items={actionsFor(p)} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <DataList>
              {rows.map((p) => (
                <DataRow key={p.code} title={p.name} titleExtra={p.code} badges={badges(p)}
                  actions={<ActionMenu title={p.name} label={`Opciones de ${p.name}`} items={actionsFor(p)} />}>
                  <DataFields>
                    <DataField label="Uso" wrap className="col-span-2">{usage(p)}</DataField>
                    <DataField label="Comprobantes" wrap className="col-span-2">{queue(p)}</DataField>
                  </DataFields>
                </DataRow>
              ))}
            </DataList>
          </>
        )}
        <CardBody className="space-y-1 border-t border-slate-100 text-xs text-slate-500">
          <p>
            <strong>Catálogo y adaptador son dos cosas.</strong> Aquí decides qué se ofrece y qué datos pide. Para que un
            proveedor envíe de verdad hace falta su adaptador en la función <code>ecf</code>, escrito con su documentación
            técnica y desplegado; el código del proveedor debe coincidir con el del adaptador.
          </p>
          {adapters.data == null && !adapters.isLoading && (
            <p>No se pudo consultar la función desplegada: despliega <code>ecf</code> para ver qué adaptadores trae.</p>
          )}
        </CardBody>
      </Card>

      <ProviderFormModal provider={editing} onClose={() => setEditing(null)} />
      <MigrateModal from={migrating} providers={rows} onClose={() => setMigrating(null)} />
    </div>
  )
}

// ── Alta y edición ───────────────────────────────────────────────────────────

const EMPTY: EcfProviderInput = {
  code: '', name: '', description: null, website: null, is_enabled: false, is_simulated: false,
  allows_production: true, config_fields: [], credential_fields: [], sort_order: 100,
}

function ProviderFormModal({ provider, onClose }: { provider: AdminEcfProviderRow | 'new' | null; onClose: () => void }) {
  const toast = useToast()
  const save = useAdminSaveEcfProvider()
  const isNew = provider === 'new'
  const [form, setForm] = useState<EcfProviderInput>(EMPTY)

  // Cada apertura parte de ESE proveedor (o de cero), no del anterior.
  useEffect(() => {
    if (!provider) return
    if (provider === 'new') return setForm(EMPTY)
    const { tenants: _t, enabled_tenants: _e, production_tenants: _p, unsent_invoices: _u, in_flight_invoices: _i,
      total_invoices: _n, ...rest } = provider
    setForm(rest)
  }, [provider])

  const set = <K extends keyof EcfProviderInput>(k: K, v: EcfProviderInput[K]) => setForm((f) => ({ ...f, [k]: v }))

  const submit = async () => {
    try {
      await save.mutateAsync({
        ...form,
        code: form.code.trim(),
        // Simulado y producción se excluyen: la base lo rechaza, aquí se evita.
        allows_production: form.is_simulated ? false : form.allows_production,
      })
      toast.success(isNew ? 'Proveedor agregado.' : 'Proveedor actualizado.')
      onClose()
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo guardar el proveedor.'))
    }
  }

  return (
    <Modal
      open={Boolean(provider)}
      onClose={onClose}
      title={isNew ? 'Nuevo proveedor de e-CF' : `Editar ${typeof provider === 'object' && provider ? provider.name : ''}`}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => void submit()} loading={save.isPending} disabled={!form.code.trim() || form.name.trim().length < 2}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Código" required hint={isNew ? 'Igual al nombre del adaptador. No se cambia después.' : 'No se cambia: lo usan negocios y comprobantes.'}>
            <Input value={form.code} onChange={(e) => set('code', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
              disabled={!isNew} placeholder="p. ej. mi_proveedor" className="font-mono" maxLength={40} />
          </Field>
          <Field label="Nombre" required>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={80} />
          </Field>
          <Field label="Descripción" className="sm:col-span-2" hint="La ve el negocio al elegirlo.">
            <Textarea rows={2} value={form.description ?? ''} onChange={(e) => set('description', e.target.value)} maxLength={500} />
          </Field>
          <Field label="Sitio web" hint="https://…">
            <Input type="url" value={form.website ?? ''} onChange={(e) => set('website', e.target.value)} />
          </Field>
          <Field label="Orden en la lista">
            <Input type="number" value={form.sort_order} onChange={(e) => set('sort_order', Number(e.target.value) || 0)} />
          </Field>
        </div>

        <div className="space-y-2">
          <CheckRow checked={form.is_enabled} onChange={(v) => set('is_enabled', v)} label="Ofrecer a los negocios"
            hint="Apagarlo no saca a quien ya lo usa: solo deja de aparecer para elegirlo." />
          <CheckRow checked={form.is_simulated} onChange={(v) => set('is_simulated', v)} label="Es un simulador"
            hint="Sus comprobantes no tienen validez fiscal; nunca podrá usarse en producción." />
          <CheckRow checked={!form.is_simulated && form.allows_production} disabled={form.is_simulated}
            onChange={(v) => set('allows_production', v)} label="Permite producción"
            hint="Solo para proveedores autorizados por la DGII." />
        </div>

        <FieldsEditor title="Datos de configuración" withRequired
          hint="No secretos (ID de emisor, sucursal…). El negocio los llena en Facturación → Configuración."
          fields={form.config_fields} onChange={(v) => set('config_fields', v)} />
        <FieldsEditor title="Credenciales"
          hint="Solo los NOMBRES de las claves que espera el adaptador. Los valores los carga el negocio y se guardan cifrados."
          fields={form.credential_fields} onChange={(v) => set('credential_fields', v)} />
      </div>
    </Modal>
  )
}

/** Lista editable de campos {clave, etiqueta, obligatorio, ayuda}. */
function FieldsEditor({
  title, hint, fields, onChange, withRequired = false,
}: {
  title: string
  hint: string
  fields: FieldDef[]
  onChange: (fields: FieldDef[]) => void
  withRequired?: boolean
}) {
  const update = (i: number, patch: Partial<FieldDef>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  return (
    <div className="space-y-2 rounded-xl border border-slate-200 p-3">
      <div>
        <p className="text-sm font-semibold text-slate-800">{title}</p>
        <p className="text-xs text-slate-500">{hint}</p>
      </div>
      {fields.map((f, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 rounded-lg bg-slate-50 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto]">
          <Input value={f.key} placeholder="clave (issuer_id)" aria-label="Clave" className="font-mono" maxLength={40}
            onChange={(e) => update(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} />
          <Input value={f.label} placeholder="Etiqueta visible" aria-label="Etiqueta" maxLength={80}
            onChange={(e) => update(i, { label: e.target.value })} />
          <div className="flex items-center gap-2">
            {withRequired && (
              <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-slate-600">
                <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600"
                  checked={Boolean(f.required)} onChange={(e) => update(i, { required: e.target.checked })} />
                Obligatorio
              </label>
            )}
            <Button variant="ghost" size="icon" aria-label="Quitar campo" className="ml-auto text-red-600 hover:bg-red-50"
              onClick={() => onChange(fields.filter((_, j) => j !== i))}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <Input value={f.help ?? ''} placeholder="Ayuda (opcional)" aria-label="Ayuda" maxLength={200}
            className="sm:col-span-3" onChange={(e) => update(i, { help: e.target.value || undefined })} />
        </div>
      ))}
      <Button variant="outline" size="sm" disabled={fields.length >= 20}
        onClick={() => onChange([...fields, { key: '', label: '' }])}>
        <Plus className="h-4 w-4" /> Agregar campo
      </Button>
    </div>
  )
}

// ── Migración masiva ─────────────────────────────────────────────────────────

function MigrateModal({
  from, providers, onClose,
}: {
  from: AdminEcfProviderRow | null
  providers: AdminEcfProviderRow[]
  onClose: () => void
}) {
  const toast = useToast()
  const migrate = useAdminMigrateEcfProvider()
  const [to, setTo] = useState('')
  const [reason, setReason] = useState('')
  const targets = providers.filter((p) => p.is_enabled && p.code !== from?.code)
  const dest = targets.find((p) => p.code === to)

  useEffect(() => {
    setTo('')
    setReason('')
  }, [from?.code])

  const run = async () => {
    if (!from || !dest) return
    try {
      const r = await migrate.mutateAsync({ from: from.code, to: dest.code, reason: reason.trim() })
      toast.success(
        `${num(r.moved ?? 0)} negocio(s) pasaron a ${dest.name}` +
          (r.skipped_production ? `; ${num(r.skipped_production)} en producción se quedaron` : '') +
          `. ${num(r.repointed)} comprobante(s) reasignados.`,
      )
      onClose()
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo migrar.'))
    }
  }

  return (
    <Modal
      open={Boolean(from)}
      onClose={onClose}
      title={from ? `Migrar negocios de ${from.name}` : 'Migrar negocios'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => void run()} loading={migrate.isPending} disabled={!dest || reason.trim().length < 5}>
            <ArrowRightLeft className="h-4 w-4" /> Migrar
          </Button>
        </>
      }
    >
      {from && (
        <div className="space-y-4">
          <Field label="Proveedor de destino" required>
            <Select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Elige…</option>
              {targets.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
            </Select>
          </Field>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
            <li>Pasan <b>{num(from.tenants)}</b> negocio(s) que hoy usan {from.name}. Su configuración del proveedor se descarta; el certificado se conserva.</li>
            {dest && !dest.allows_production && from.production_tenants > 0 && (
              <li className="text-amber-700">
                <b>{num(from.production_tenants)}</b> en producción se quedan donde están: {dest.name} no permite producción.
              </li>
            )}
            <li><b>{num(from.unsent_invoices)}</b> comprobante(s) sin enviar se reasignan al nuevo proveedor.</li>
            <li><b>{num(from.in_flight_invoices)}</b> ya en {from.name} se quedan con él: solo él puede responder por ellos.</li>
          </ul>
          <Field label="Motivo" required hint="Queda en la bitácora de cada negocio y en la del panel.">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </Field>
        </div>
      )}
    </Modal>
  )
}

// ── Cambio para un negocio (lo usa la ficha del negocio) ─────────────────────

export function ChangeTenantProviderModal({
  tenant, ecf, onClose,
}: {
  tenant: { id: string; name: string } | null
  ecf: AdminTenantEcf | undefined
  onClose: () => void
}) {
  const toast = useToast()
  const providers = useAdminEcfProviders()
  const change = useAdminSetTenantEcfProvider()
  const [to, setTo] = useState('')
  const [reason, setReason] = useState('')
  const targets = useMemo(
    () => (providers.data ?? []).filter((p) => p.is_enabled && p.code !== ecf?.provider
      && (ecf?.environment !== 'production' || p.allows_production)),
    [providers.data, ecf],
  )
  const dest = targets.find((p) => p.code === to)

  useEffect(() => {
    setTo('')
    setReason('')
  }, [tenant?.id])

  const run = async () => {
    if (!tenant || !dest) return
    try {
      const r = await change.mutateAsync({ tenant: tenant.id, provider: dest.code, reason: reason.trim() })
      const pending = r.missing_config?.length ? ` El negocio tendrá que completar: ${r.missing_config.join(', ')}.` : ''
      toast.success(`${tenant.name} usa ahora ${dest.name}. ${num(r.repointed)} comprobante(s) reasignados.${pending}`)
      onClose()
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo cambiar el proveedor.'))
    }
  }

  return (
    <Modal
      open={Boolean(tenant)}
      onClose={onClose}
      title={tenant ? `Proveedor de e-CF · ${tenant.name}` : 'Proveedor de e-CF'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => void run()} loading={change.isPending} disabled={!dest || reason.trim().length < 5}>
            Cambiar proveedor
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Nuevo proveedor" required
          hint={ecf?.environment === 'production' ? 'El negocio está en producción: solo se listan proveedores que la permiten.' : undefined}>
          <Select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Elige…</option>
            {targets.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
          </Select>
        </Field>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
          <li>La configuración del proveedor actual se descarta; el certificado del negocio se conserva.</li>
          <li><b>{num(ecf?.unsent_invoices ?? 0)}</b> comprobante(s) sin enviar pasan al nuevo proveedor.</li>
          <li><b>{num(ecf?.in_flight_invoices ?? 0)}</b> ya enviados se quedan con el actual hasta que respondan.</li>
          {dest && dest.config_fields.some((f) => f.required) && (
            <li className="text-amber-700">
              {dest.name} pide datos que el negocio tendrá que llenar: {dest.config_fields.filter((f) => f.required).map((f) => f.label).join(', ')}.
            </li>
          )}
        </ul>
        <Field label="Motivo" required hint="Lo verá el negocio en su bitácora.">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
        </Field>
      </div>
    </Modal>
  )
}
