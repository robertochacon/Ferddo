import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Activity, AlertTriangle, ArrowRight, Ban, Building2, Check, Eye, FileCheck2, LogOut, Play,
  Receipt, RefreshCw, Search, ShieldCheck, ShieldPlus, SlidersHorizontal, Store, Trash2,
  UserRound, Users,
} from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { ActionMenu, type ActionItem } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Pagination, paginate } from '@/components/ui/Pagination'
import { Segmented } from '@/components/ui/Segmented'
import { StatCard } from '@/components/ui/StatCard'
import { Avatar, EmptyState, PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { APP_NAME, planOrderFrom, type PlanInfo } from '@/lib/constants'
import { errorMessage } from '@/lib/errors'
import { fmtDate, fmtDateShort, num } from '@/lib/format'
import {
  useAdminGrantPlatformAdmin, useAdminOverview, useAdminPlanRequests, useAdminPlatformAdmins,
  useAdminResolvePlanRequest, useAdminRevokePlatformAdmin,
  useAdminSetTenantSuspended, useAdminTenantPurges, useAdminTenants,
} from '@/hooks/admin'
import { useBusinessTypes } from '@/hooks/core'
import type { AdminPlanRequestRow, AdminTenantRow, PlanCode, SubscriptionStatus } from '@/types/db'
import { DeleteTenantModal } from './DeleteTenantModal'
import { PlansCard } from './PlansCard'
import { SUB_STATUS_LABEL, SUB_STATUS_TONE, SubscriptionEditor } from './SubscriptionEditor'

/**
 * Panel de plataforma: la vista del super-admin sobre TODAS las cuentas.
 *
 * Vive fuera de `Layout` a propósito. Un super-admin no tiene negocio propio
 * (`auth_tenant_id()` es null, requisito de las políticas cross-tenant), así que
 * la navegación de la app —POS, Inventario, Configuración— no le lleva a ninguna
 * parte: esta pantalla trae su propio cascarón.
 *
 * Privacidad por diseño: aquí solo hay AGREGADOS (conteos, fechas, estados).
 * Ninguna RPC del panel devuelve ventas, clientes ni productos concretos.
 */

const SUB_STATUSES: SubscriptionStatus[] = ['trial', 'active', 'past_due', 'canceled']

/** Mapa código → etiqueta de los tipos de negocio (tabla global `business_types`). */
function useBusinessTypeLabels(): Record<string, string> {
  const { data } = useBusinessTypes()
  return useMemo(() => Object.fromEntries((data ?? []).map((b) => [b.code, b.label])), [data])
}

const TENANTS_PAGE_SIZE = 10
const REQUESTS_PAGE_SIZE = 5

type SectionId = 'resumen' | 'negocios' | 'planes' | 'equipo'
const SECTIONS: { value: SectionId; label: string }[] = [
  { value: 'resumen', label: 'Resumen' }, { value: 'negocios', label: 'Negocios' },
  { value: 'planes', label: 'Planes' }, { value: 'equipo', label: 'Super-admins' },
]

export function AdminPage() {
  const { user, plans, signOut } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const overview = useAdminOverview()
  const tenants = useAdminTenants()
  // Solo las pendientes: son las únicas sobre las que hay algo que decidir.
  const requests = useAdminPlanRequests('pending')
  const resolveRequest = useAdminResolvePlanRequest()
  const setSuspended = useAdminSetTenantSuspended()

  const [query, setQuery] = useState('')
  // Se guarda el ID y no la fila: al invalidar ['admin'] tras guardar, el modal
  // debe leer el plan recién escrito; con una copia se quedaba con el anterior.
  const [planForId, setPlanForId] = useState<string | null>(null)
  const [deleteFor, setDeleteFor] = useState<AdminTenantRow | null>(null)

  // La sección va en la URL (?s=negocios): así el botón «atrás» funciona y se
  // puede compartir el enlace directo a una pestaña.
  const [params, setParams] = useSearchParams()
  const section = (params.get('s') ?? 'resumen') as SectionId
  const setSection = (id: SectionId) => {
    setParams(id === 'resumen' ? {} : { s: id })
    // Sin esto la sección nueva hereda el scroll de la anterior y aparece «por
    // la mitad».
    window.scrollTo({ top: 0 })
  }

  const typeLabels = useBusinessTypeLabels()

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = tenants.data ?? []
    if (!q) return list
    return list.filter((t) =>
      [t.name, t.owner_name ?? '', t.owner_email ?? '', t.rnc ?? '', typeLabels[t.business_type] ?? '']
        .some((v) => v.toLowerCase().includes(q)),
    )
  }, [tenants.data, query, typeLabels])

  const ov = overview.data
  const planFor = planForId ? ((tenants.data ?? []).find((t) => t.id === planForId) ?? null) : null

  const toggleSuspend = async (t: AdminTenantRow) => {
    const next = !t.suspended
    const ask = next
      ? `¿Suspender "${t.name}"? Su equipo podrá entrar, pero no crear ni cambiar nada.`
      : `¿Reactivar "${t.name}"?`
    if (!window.confirm(ask)) return
    try {
      await setSuspended.mutateAsync({ tenant: t.id, suspended: next })
      toast.success(next ? 'Negocio suspendido.' : 'Negocio reactivado.')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo cambiar el estado.'))
    }
  }

  const resolve = async (r: AdminPlanRequestRow, approve: boolean) => {
    const target = plans[r.requested_plan]?.name ?? r.requested_plan
    const ask = approve
      ? `¿Cambiar "${r.tenant_name}" al plan ${target}?`
      : `¿Rechazar la solicitud de ${target} de "${r.tenant_name}"?`
    if (!window.confirm(ask)) return
    try {
      await resolveRequest.mutateAsync({ id: r.id, approve })
      toast.success(approve ? `Plan cambiado a ${target}.` : 'Solicitud rechazada.')
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  const refetchAll = () => {
    overview.refetch()
    tenants.refetch()
    requests.refetch()
  }

  const handleSignOut = async () => {
    await signOut()
    navigate('/login')
  }

  // Mismo gris que el armazón de la app (ver Layout): sobre él las tarjetas
  // blancas se despegan y la pantalla se lee como capas.
  return (
    <div className="min-h-[100dvh] bg-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4">
          <span className="truncate text-lg font-extrabold tracking-tight text-brand-950">{APP_NAME}</span>
          <Badge tone="brand" className="shrink-0">
            <ShieldCheck className="h-3.5 w-3.5" /> Super-admin
          </Badge>
          <span className="ml-auto hidden min-w-0 truncate text-sm text-slate-500 lg:block">{user?.email}</span>
          <Button variant="outline" size="sm" className="ml-auto lg:ml-0" onClick={refetchAll}>
            <RefreshCw className="h-4 w-4" />
            <span className="hidden sm:inline">Actualizar</span>
          </Button>
          <Button variant="ghost" size="icon" onClick={handleSignOut} aria-label="Cerrar sesión">
            <LogOut className="h-5 w-5 text-red-600" />
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-6">
        <Segmented value={section} onChange={setSection} options={SECTIONS} label="Secciones del panel" />

        <div className="mt-6">
          {section === 'resumen' && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard label="Negocios" value={ov ? num(ov.tenants) : '—'} icon={<Building2 className="h-5 w-5" />} tone="brand" />
                <StatCard label="Activos 30 días" value={ov ? num(ov.active_tenants_30d) : '—'} icon={<Activity className="h-5 w-5" />} tone="green"
                  hint="Con al menos una venta" />
                <StatCard label="Usuarios" value={ov ? num(ov.members) : '—'} icon={<UserRound className="h-5 w-5" />} tone="slate" />
                <StatCard label="Sucursales" value={ov ? num(ov.branches) : '—'} icon={<Store className="h-5 w-5" />} tone="slate" />
                <StatCard label="Ventas 30 días" value={ov ? num(ov.sales_30d) : '—'} icon={<Receipt className="h-5 w-5" />} tone="accent"
                  hint="Cantidad de ventas, no montos" />
                <StatCard label="e-CF 30 días" value={ov ? num(ov.ecf_30d) : '—'} icon={<FileCheck2 className="h-5 w-5" />} tone="brand" />
                <StatCard label="e-CF con error" value={ov ? num(ov.ecf_errors) : '—'} icon={<AlertTriangle className="h-5 w-5" />}
                  tone={ov && ov.ecf_errors > 0 ? 'red' : 'slate'} hint="Rechazados o con error de envío" />
                <StatCard label="Super-admins" value={ov ? num(ov.platform_admins) : '—'} icon={<ShieldCheck className="h-5 w-5" />} tone="slate" />
              </div>

              {overview.isError && (
                <p className="mt-4 text-sm text-red-600">{errorMessage(overview.error, 'No se pudo cargar el resumen.')}</p>
              )}

              {ov && (
                <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <BreakdownCard
                    title="Por plan"
                    rows={planOrderFrom(plans).map((p) => ({ key: p, label: plans[p].name, value: ov.by_plan?.[p] ?? 0 }))}
                  />
                  <BreakdownCard
                    title="Por estado"
                    rows={SUB_STATUSES.map((st) => ({ key: st, label: SUB_STATUS_LABEL[st], value: ov.by_status?.[st] ?? 0 }))}
                  />
                  <BreakdownCard
                    title="Por tipo de negocio"
                    rows={Object.entries(ov.by_business_type ?? {})
                      .sort((a, b) => b[1] - a[1])
                      .map(([code, n]) => ({ key: code, label: typeLabels[code] ?? code, value: n }))}
                  />
                </div>
              )}

              <PlanRequestsCard requests={requests.data ?? []} plans={plans} busy={resolveRequest.isPending} onResolve={resolve} />
            </>
          )}

          {section === 'negocios' && (
            <>
              <div className="relative max-w-sm">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9"
                  placeholder="Buscar por negocio, RNC, dueño o correo…" />
              </div>
              <TenantsTable
                rows={rows} query={query} plans={plans} typeLabels={typeLabels} loading={tenants.isLoading}
                error={tenants.isError ? tenants.error : null}
                onDetail={(id) => navigate(`/admin/negocio/${id}`)}
                // Los usuarios se gestionan en el detalle y no en un modal aquí:
                // una sola pantalla para roles, bloqueos y bajas.
                onMembers={(id) => navigate(`/admin/negocio/${id}?ir=miembros`)}
                onPlan={setPlanForId} onToggleSuspend={toggleSuspend} onDelete={setDeleteFor}
              />
              <PurgeLogCard />
            </>
          )}

          {section === 'planes' && <PlansCard />}
          {section === 'equipo' && <SuperAdminsCard />}
        </div>
      </main>

      <Modal open={Boolean(planFor)} onClose={() => setPlanForId(null)}
        title={planFor ? `Suscripción · ${planFor.name}` : 'Suscripción'}>
        {planFor && (
          <SubscriptionEditor
            sub={{
              tenantId: planFor.id, tenantName: planFor.name, plan: planFor.plan, status: planFor.sub_status,
              currentPeriodEnd: planFor.current_period_end, trialEndsAt: planFor.trial_ends_at,
            }}
            onSaved={() => setPlanForId(null)}
            onCancel={() => setPlanForId(null)}
          />
        )}
      </Modal>
      <DeleteTenantModal tenantId={deleteFor?.id ?? null} tenantName={deleteFor?.name}
        onClose={() => setDeleteFor(null)} />
    </div>
  )
}

/** Reparto de negocios por una dimensión, con una barra proporcional al total. */
function BreakdownCard({ title, rows }: { title: string; rows: { key: string; label: string; value: number }[] }) {
  const total = rows.reduce((s, r) => s + r.value, 0)
  return (
    <Card>
      <CardHeader title={title} />
      <CardBody className="space-y-2.5">
        {rows.length === 0 || total === 0 ? (
          <p className="text-sm text-slate-400">Sin datos todavía.</p>
        ) : (
          rows.map((r) => (
            <div key={r.key}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="min-w-0 truncate text-slate-600">{r.label}</span>
                <span className="shrink-0 font-semibold tabular-nums text-slate-800">{num(r.value)}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-brand-500" style={{ width: `${(r.value / total) * 100}%` }} />
              </div>
            </div>
          ))
        )}
      </CardBody>
    </Card>
  )
}

// ── Solicitudes de plan ──────────────────────────────────────────────────────

function PlanRequestsCard({
  requests, plans, busy, onResolve,
}: {
  requests: AdminPlanRequestRow[]
  plans: Record<PlanCode, PlanInfo>
  busy: boolean
  onResolve: (r: AdminPlanRequestRow, approve: boolean) => void
}) {
  const [page, setPage] = useState(0)
  const { slice, safePage } = paginate(requests, page, REQUESTS_PAGE_SIZE)

  if (requests.length === 0) {
    return (
      <Card className="mt-6">
        <CardBody>
          <EmptyState icon={<Check className="h-5 w-5" />} title="Sin solicitudes pendientes"
            description="Cuando un negocio pida cambiar de plan, aparecerá aquí." />
        </CardBody>
      </Card>
    )
  }

  return (
    <Card className="mt-6 border-accent-300">
      <CardHeader title={`Solicitudes de plan (${requests.length})`} subtitle="Cuentas que pidieron cambiar de plan" />
      <CardBody className="space-y-2">
        {slice.map((r) => (
          <div key={r.id} className="flex flex-col gap-3 rounded-xl border border-slate-200 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="truncate font-semibold text-slate-800">{r.tenant_name}</p>
              <p className="truncate text-xs text-slate-500">{r.owner_name ?? '—'} · {r.owner_email ?? '—'}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Badge>{r.current_plan ? plans[r.current_plan].name : '—'}</Badge>
                <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
                <Badge tone="brand">{plans[r.requested_plan].name}</Badge>
                <span className="text-xs text-slate-400">· {fmtDate(r.created_at)}</span>
              </div>
              {r.note && <p className="mt-1.5 text-xs italic text-slate-500">«{r.note}»</p>}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="outline" loading={busy} onClick={() => onResolve(r, false)}>Rechazar</Button>
              <Button size="sm" loading={busy} onClick={() => onResolve(r, true)}>
                <Check className="h-4 w-4" /> Aprobar
              </Button>
            </div>
          </div>
        ))}
      </CardBody>
      <Pagination page={safePage} pageSize={REQUESTS_PAGE_SIZE} total={requests.length} onPage={setPage} label="solicitudes" />
    </Card>
  )
}

// ── Negocios ─────────────────────────────────────────────────────────────────

function TenantsTable({
  rows, loading, error, query, plans, typeLabels, onDetail, onMembers, onPlan, onToggleSuspend, onDelete,
}: {
  rows: AdminTenantRow[]
  loading: boolean
  error: unknown
  query: string
  plans: Record<PlanCode, PlanInfo>
  typeLabels: Record<string, string>
  onDetail: (id: string) => void
  onMembers: (id: string) => void
  onPlan: (id: string) => void
  onToggleSuspend: (t: AdminTenantRow) => void
  onDelete: (t: AdminTenantRow) => void
}) {
  const [page, setPage] = useState(0)
  const { slice, safePage } = paginate(rows, page, TENANTS_PAGE_SIZE)
  // El buscador filtra sobre TODA la lista (ya viene entera del servidor); al
  // cambiar el texto hay que volver a la primera página o se ve un hueco.
  useEffect(() => setPage(0), [query])

  // Una sola lista de acciones para la tabla y para las tarjetas: así una opción
  // nueva no aparece en escritorio y falta en el teléfono.
  const actionsFor = (t: AdminTenantRow): ActionItem[] => [
    { label: 'Ver detalle', icon: <Eye className="h-4 w-4" />, onClick: () => onDetail(t.id) },
    { label: 'Usuarios', icon: <Users className="h-4 w-4" />, hint: 'Roles, bloqueo de acceso y bajas', onClick: () => onMembers(t.id) },
    { label: 'Suscripción', icon: <SlidersHorizontal className="h-4 w-4" />, hint: 'Plan, estado y fechas', onClick: () => onPlan(t.id) },
    t.suspended
      ? { label: 'Reactivar negocio', icon: <Play className="h-4 w-4" />, tone: 'success', onClick: () => onToggleSuspend(t) }
      : { label: 'Suspender negocio', icon: <Ban className="h-4 w-4" />, tone: 'danger', hint: 'Lo deja en solo lectura', onClick: () => onToggleSuspend(t) },
    { label: 'Eliminar negocio', icon: <Trash2 className="h-4 w-4" />, tone: 'danger', hint: 'Borra todos sus datos, sin vuelta atrás', onClick: () => onDelete(t) },
  ]

  const statusBadge = (t: AdminTenantRow) => (
    <Badge tone={t.sub_status ? SUB_STATUS_TONE[t.sub_status] : 'slate'}>
      {t.sub_status ? SUB_STATUS_LABEL[t.sub_status] : '—'}
    </Badge>
  )
  const planBadge = (t: AdminTenantRow) => <Badge tone="brand">{t.plan ? plans[t.plan].name : '—'}</Badge>
  const typeLabel = (t: AdminTenantRow) => typeLabels[t.business_type] ?? t.business_type
  const ecfErrors = (t: AdminTenantRow) =>
    t.ecf_errors > 0 ? <span className="font-semibold text-red-600">{num(t.ecf_errors)}</span> : <span>0</span>

  return (
    <Card className="mt-4">
      {loading ? (
        <PageLoader label="Cargando negocios…" />
      ) : error ? (
        <p className="p-6 text-center text-sm text-red-600">{errorMessage(error, 'No se pudieron cargar los negocios.')}</p>
      ) : rows.length === 0 ? (
        <EmptyState className="m-5" icon={<Building2 className="h-6 w-6" />}
          title={query ? 'Sin resultados' : 'Aún no hay negocios'}
          description={query ? 'Prueba con otro término.' : 'Cuando alguien cree su cuenta, aparecerá aquí.'} />
      ) : (
        <>
          {/* Ocho columnas no caben en un teléfono: por debajo de `lg` la tabla
              cede el sitio a la <DataList> de más abajo. */}
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[920px] text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3 font-medium">Negocio</th>
                  <th className="px-4 py-3 font-medium">Dueño</th>
                  <th className="px-4 py-3 font-medium">Plan</th>
                  <th className="px-4 py-3 text-right font-medium">Productos</th>
                  <th className="px-4 py-3 text-right font-medium">Ventas 30d</th>
                  <th className="px-4 py-3 text-right font-medium">e-CF error</th>
                  <th className="px-4 py-3 font-medium">Última venta</th>
                  <th className="px-4 py-3 text-right font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {slice.map((t) => (
                  <tr key={t.id} className={t.suspended ? 'bg-red-50/40' : 'hover:bg-slate-50/60'}>
                    <td className="px-4 py-3">
                      <button onClick={() => onDetail(t.id)} className="text-left font-medium text-slate-800 hover:text-brand-600">
                        {t.name}
                      </button>
                      <p className="text-xs text-slate-400">
                        {typeLabel(t)}{t.rnc ? ` · RNC ${t.rnc}` : ''} · alta {fmtDateShort(t.created_at)}
                      </p>
                      {t.suspended && <p className="mt-1"><Badge tone="red">Suspendido</Badge></p>}
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-slate-700">{t.owner_name ?? '—'}</p>
                      {t.owner_email && <p className="text-xs text-slate-400">{t.owner_email}</p>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">{planBadge(t)}{statusBadge(t)}</div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{num(t.products)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{num(t.sales_30d)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{ecfErrors(t)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-500">{t.last_sale_at ? fmtDate(t.last_sale_at) : 'Nunca'}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <ActionMenu title={t.name} label={`Opciones de ${t.name}`} items={actionsFor(t)} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <DataList>
            {slice.map((t) => (
              <DataRow
                key={t.id}
                title={t.name}
                titleExtra={`${typeLabel(t)}${t.rnc ? ` · RNC ${t.rnc}` : ''}`}
                onClick={() => onDetail(t.id)}
                tone={t.suspended ? 'danger' : undefined}
                badges={<>{planBadge(t)}{statusBadge(t)}{t.suspended && <Badge tone="red">Suspendido</Badge>}</>}
                actions={<ActionMenu title={t.name} label={`Opciones de ${t.name}`} items={actionsFor(t)} />}
              >
                <DataFields>
                  {/* El dueño va etiquetado y a dos columnas: sin la cabecera de
                      la tabla, un nombre suelto bajo el del negocio se confunde
                      con el tipo de negocio de arriba. */}
                  <DataField label="Dueño" wrap className="col-span-2">
                    {t.owner_name ?? '—'}
                    {t.owner_email && <span className="block break-all text-xs font-normal text-slate-400">{t.owner_email}</span>}
                  </DataField>
                  <DataField label="Productos">{num(t.products)}</DataField>
                  <DataField label="Ventas 30d">{num(t.sales_30d)}</DataField>
                  <DataField label="e-CF con error">{ecfErrors(t)}</DataField>
                  <DataField label="Última venta">{t.last_sale_at ? fmtDate(t.last_sale_at) : 'Nunca'}</DataField>
                </DataFields>
              </DataRow>
            ))}
          </DataList>
        </>
      )}
      <Pagination page={safePage} pageSize={TENANTS_PAGE_SIZE} total={rows.length} onPage={setPage} label="negocios" />
    </Card>
  )
}

/**
 * Bitácora de negocios eliminados.
 *
 * Es lo único que queda de un negocio borrado —sus `audit_logs` se fueron con
 * él—, y guarda lo que ya no se puede reconstruir: quién lo borró, cuándo y
 * cuánto había dentro. Se oculta mientras no haya ninguno.
 */
function PurgeLogCard() {
  const rows = useAdminTenantPurges(10).data ?? []
  if (rows.length === 0) return null

  return (
    <Card className="mt-4">
      <CardHeader title="Negocios eliminados"
        subtitle={`${rows.length === 10 ? 'Últimos 10' : `${rows.length} en total`} · el rastro del borrado, no los datos`} />
      <ul className="divide-y divide-slate-50">
        {rows.map((r) => (
          <li key={r.id} className="px-5 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">{r.tenant_name}</p>
              {r.deleted_users && <Badge tone="red">Cuentas borradas</Badge>}
              <span className="whitespace-nowrap text-xs text-slate-400">{fmtDate(r.created_at)}</span>
            </div>
            <p className="mt-0.5 break-all text-xs text-slate-400">
              {r.owner_email ?? 'sin dueño'}
              {r.deleted_by_email ? ` · borrado por ${r.deleted_by_email}` : ''}
              {/* Las purgas anteriores a la 0018 contaban `profiles` en vez de
                  `tenant_members`: se acepta cualquiera de los dos. */}
              {` · ${num(r.counts?.products ?? 0)} productos · ${num(r.counts?.sales ?? 0)} ventas · ${num(r.counts?.tenant_members ?? r.counts?.profiles ?? 0)} usuarios`}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  )
}

// ── Super-admins de plataforma ───────────────────────────────────────────────

function SuperAdminsCard() {
  const { user } = useAuth()
  const toast = useToast()
  const admins = useAdminPlatformAdmins()
  const grant = useAdminGrantPlatformAdmin()
  const revoke = useAdminRevokePlatformAdmin()
  const [email, setEmail] = useState('')

  const add = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await grant.mutateAsync({ email })
      toast.success('Super-admin agregado.')
      setEmail('')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo agregar.'))
    }
  }

  const remove = async (userId: string, label: string) => {
    if (!window.confirm(`¿Quitar a ${label} como super-admin?`)) return
    try {
      await revoke.mutateAsync(userId)
      toast.success('Super-admin removido.')
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <Card>
      <CardHeader title="Super-admins de plataforma" subtitle="Cuentas con acceso a este panel (sin negocio propio)" />
      <CardBody className="space-y-4">
        {/* Sin paginar a propósito: son un puñado de cuentas, y una lista de tres
            con paginador debajo se lee como si faltara algo. */}
        {admins.isLoading ? (
          <PageLoader label="Cargando…" />
        ) : (
          <ul className="space-y-2">
            {(admins.data ?? []).map((a) => (
              <li key={a.user_id} className="flex items-center gap-3 rounded-xl border border-slate-200 p-3">
                <Avatar name={a.email} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">{a.email ?? a.user_id}</span>
                {a.user_id === user?.id && <Badge tone="brand">Tú</Badge>}
                <Button variant="ghost" size="icon" className="shrink-0 text-red-600 hover:bg-red-50"
                  aria-label={`Quitar a ${a.email ?? a.user_id}`}
                  onClick={() => remove(a.user_id, a.email ?? a.user_id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={add} className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="correo@ejemplo.com" className="min-w-[220px] flex-1" />
          <Button type="submit" loading={grant.isPending}>
            <ShieldPlus className="h-4 w-4" /> Agregar
          </Button>
        </form>
        {/* La restricción no es capricho de la UI: las políticas cross-tenant
            piden `auth_tenant_id() is null`, así que un super-admin con negocio
            propio no vería nada aquí dentro. */}
        <p className="text-xs text-slate-500">
          Tiene que ser una cuenta que ya exista y que NO pertenezca a ningún negocio. Siempre queda
          al menos un super-admin: la base rechaza quitar al último.
        </p>
      </CardBody>
    </Card>
  )
}
