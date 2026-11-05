import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Activity, AlertTriangle, ArrowRight, Ban, BellRing, Building2, Check, Eye, FileCheck2, LifeBuoy, LogIn,
  LogOut, Play, Receipt, RefreshCw, Search, ShieldCheck, ShieldPlus, SlidersHorizontal, Store, Trash2,
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
import { Pagination, paginate, usePaged, DEFAULT_PAGE_SIZE } from '@/components/ui/Pagination'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
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
import { AuditLogCard } from './AuditLogCard'
import { DeleteTenantModal } from './DeleteTenantModal'
import { EnterSupportModal } from './EnterSupportModal'
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
 * Ninguna RPC del panel devuelve ventas, clientes ni productos concretos. Para
 * ver un negocio por dentro hay una sola puerta, «Entrar como gestor» (0028):
 * temporal, con motivo, visible para el dueño y registrada en la bitácora.
 */

const SUB_STATUSES: SubscriptionStatus[] = ['trial', 'active', 'past_due', 'canceled']

/** Mapa código → etiqueta de los tipos de negocio (tabla global `business_types`). */
function useBusinessTypeLabels(): Record<string, string> {
  const { data } = useBusinessTypes()
  return useMemo(() => Object.fromEntries((data ?? []).map((b) => [b.code, b.label])), [data])
}

const TENANTS_PAGE_SIZE = DEFAULT_PAGE_SIZE
const REQUESTS_PAGE_SIZE = DEFAULT_PAGE_SIZE

type SectionId = 'resumen' | 'negocios' | 'planes' | 'bitacora' | 'equipo'
const SECTIONS: { value: SectionId; label: string }[] = [
  { value: 'resumen', label: 'Resumen' }, { value: 'negocios', label: 'Negocios' },
  { value: 'planes', label: 'Planes' }, { value: 'bitacora', label: 'Bitácora' },
  { value: 'equipo', label: 'Super-admins' },
]

/** Filtro de estado: los de la suscripción más «suspendido», que es del negocio. */
type StatusFilter = SubscriptionStatus | 'suspended' | ''

/** Días de aviso antes de que termine una prueba. */
const TRIAL_WARNING_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

export function AdminPage() {
  const { user, plans, signOut, tenant: supportTenant, exitSupport } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const overview = useAdminOverview()
  const tenants = useAdminTenants()
  // Solo las pendientes: son las únicas sobre las que hay algo que decidir.
  const requests = useAdminPlanRequests('pending')
  const resolveRequest = useAdminResolvePlanRequest()
  const setSuspended = useAdminSetTenantSuspended()

  const [query, setQuery] = useState('')
  const [planFilter, setPlanFilter] = useState<PlanCode | ''>('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('')
  const [typeFilter, setTypeFilter] = useState('')
  const [enterFor, setEnterFor] = useState<{ id: string; name: string } | null>(null)
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
    return (tenants.data ?? []).filter((t) => {
      if (planFilter && t.plan !== planFilter) return false
      if (statusFilter === 'suspended' ? !t.suspended : statusFilter && t.sub_status !== statusFilter) return false
      if (typeFilter && t.business_type !== typeFilter) return false
      if (!q) return true
      return [t.name, t.owner_name ?? '', t.owner_email ?? '', t.rnc ?? '', typeLabels[t.business_type] ?? '']
        .some((v) => v.toLowerCase().includes(q))
    })
  }, [tenants.data, query, planFilter, statusFilter, typeFilter, typeLabels])
  const filtered = Boolean(query.trim() || planFilter || statusFilter || typeFilter)
  // Solo los tipos que de verdad tiene algún negocio: un filtro con opciones que
  // siempre dan cero resultados es ruido.
  const typesInUse = useMemo(
    () => [...new Set((tenants.data ?? []).map((t) => t.business_type))].sort((a, b) =>
      (typeLabels[a] ?? a).localeCompare(typeLabels[b] ?? b)),
    [tenants.data, typeLabels],
  )

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

      {/* Si se vuelve al panel sin salir del modo soporte, el acceso sigue
          abierto: se recuerda aquí para que no quede olvidado hasta que caduque. */}
      {supportTenant && (
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-500 px-4 py-1.5 text-center text-xs font-semibold text-amber-950">
          <span className="inline-flex items-center gap-1.5">
            <LifeBuoy className="h-3.5 w-3.5" /> Sigues dentro de {supportTenant.name} en modo soporte
          </span>
          <button type="button" onClick={() => navigate('/')} className="rounded-md bg-amber-950/10 px-2 py-0.5 hover:bg-amber-950/20">
            Volver al negocio
          </button>
          <button type="button" onClick={() => void exitSupport().catch((err) => toast.error(errorMessage(err)))}
            className="rounded-md bg-amber-950/10 px-2 py-0.5 hover:bg-amber-950/20">
            Salir del modo soporte
          </button>
        </div>
      )}

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

              <AlertsCard tenants={tenants.data ?? []} plans={plans} onOpen={(id) => navigate(`/admin/negocio/${id}`)} />
              <PlanRequestsCard requests={requests.data ?? []} plans={plans} busy={resolveRequest.isPending} onResolve={resolve} />
            </>
          )}

          {section === 'negocios' && (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
                <div className="relative sm:col-span-2 lg:col-span-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9"
                    placeholder="Buscar por negocio, RNC, dueño o correo…" />
                </div>
                <Select value={planFilter} onChange={(e) => setPlanFilter(e.target.value as PlanCode | '')} aria-label="Plan">
                  <option value="">Todos los planes</option>
                  {planOrderFrom(plans).map((p) => <option key={p} value={p}>{plans[p].name}</option>)}
                </Select>
                <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} aria-label="Estado">
                  <option value="">Todos los estados</option>
                  {SUB_STATUSES.map((st) => <option key={st} value={st}>{SUB_STATUS_LABEL[st]}</option>)}
                  <option value="suspended">Suspendido</option>
                </Select>
                <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Tipo de negocio">
                  <option value="">Todos los tipos</option>
                  {typesInUse.map((code) => <option key={code} value={code}>{typeLabels[code] ?? code}</option>)}
                </Select>
              </div>
              {filtered && (
                <button type="button" className="mt-2 text-xs font-medium text-brand-600 hover:underline"
                  onClick={() => { setQuery(''); setPlanFilter(''); setStatusFilter(''); setTypeFilter('') }}>
                  Quitar filtros
                </button>
              )}
              <TenantsTable
                rows={rows} filtered={filtered} filterKey={`${query}|${planFilter}|${statusFilter}|${typeFilter}`}
                plans={plans} typeLabels={typeLabels} loading={tenants.isLoading}
                error={tenants.isError ? tenants.error : null}
                onDetail={(id) => navigate(`/admin/negocio/${id}`)}
                // Los usuarios se gestionan en el detalle y no en un modal aquí:
                // una sola pantalla para roles, bloqueos y bajas.
                onMembers={(id) => navigate(`/admin/negocio/${id}?ir=miembros`)}
                onPlan={setPlanForId} onToggleSuspend={toggleSuspend} onDelete={setDeleteFor}
                onEnter={(t) => setEnterFor({ id: t.id, name: t.name })}
              />
              <PurgeLogCard />
            </>
          )}

          {section === 'planes' && <PlansCard />}
          {section === 'bitacora' && <AuditLogCard />}
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
      <EnterSupportModal tenant={enterFor} onClose={() => setEnterFor(null)} />
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

// ── Alertas de suscripción ───────────────────────────────────────────────────

type AlertKind = 'trial_ending' | 'trial_ended' | 'past_due' | 'period_ended'

const ALERT_INFO: Record<AlertKind, { label: string; tone: 'amber' | 'red' }> = {
  trial_ending: { label: 'Prueba por vencer', tone: 'amber' },
  trial_ended: { label: 'Prueba terminada', tone: 'red' },
  past_due: { label: 'Pago vencido', tone: 'red' },
  period_ended: { label: 'Periodo pagado vencido', tone: 'red' },
}

/**
 * Lo que pide una llamada: pruebas que terminan en los próximos días, pruebas
 * ya terminadas sin pasar a pago, y cuentas vencidas. Se calcula con la lista
 * de negocios que el panel ya tiene: no hace falta otra consulta.
 */
function AlertsCard({
  tenants, plans, onOpen,
}: {
  tenants: AdminTenantRow[]
  plans: Record<PlanCode, PlanInfo>
  onOpen: (id: string) => void
}) {
  const alerts = useMemo(() => {
    const now = Date.now()
    const out: { t: AdminTenantRow; kind: AlertKind; date: string | null; at: number }[] = []
    for (const t of tenants) {
      if (t.suspended) continue // ya tiene quien lo atienda: se suspendió a propósito
      const trialEnd = t.trial_ends_at ? Date.parse(t.trial_ends_at) : null
      const periodEnd = t.current_period_end ? Date.parse(t.current_period_end) : null
      if (t.sub_status === 'trial' && trialEnd != null) {
        if (trialEnd < now) out.push({ t, kind: 'trial_ended', date: t.trial_ends_at, at: trialEnd })
        else if (trialEnd - now <= TRIAL_WARNING_DAYS * DAY_MS) out.push({ t, kind: 'trial_ending', date: t.trial_ends_at, at: trialEnd })
      } else if (t.sub_status === 'past_due') {
        out.push({ t, kind: 'past_due', date: t.current_period_end, at: periodEnd ?? 0 })
      } else if (t.sub_status === 'active' && periodEnd != null && periodEnd < now) {
        out.push({ t, kind: 'period_ended', date: t.current_period_end, at: periodEnd })
      }
    }
    // Lo más urgente arriba: la fecha más antigua primero.
    return out.sort((a, b) => a.at - b.at)
  }, [tenants])
  const paged = usePaged(alerts)

  return (
    <Card className={alerts.length ? 'mt-6 border-amber-300' : 'mt-6'}>
      <CardHeader
        title={alerts.length ? `Requieren atención (${alerts.length})` : 'Suscripciones al día'}
        subtitle={`Pruebas que terminan en ${TRIAL_WARNING_DAYS} días o menos, pruebas terminadas y cuentas vencidas`}
      />
      {alerts.length === 0 ? (
        <CardBody>
          <EmptyState icon={<BellRing className="h-5 w-5" />} title="Nada pendiente"
            description="Ninguna prueba vence esta semana y no hay cuentas vencidas." />
        </CardBody>
      ) : (
        <>
          <ul className="divide-y divide-slate-100">
            {paged.slice.map(({ t, kind, date }) => (
              <li key={t.id}>
                <button type="button" onClick={() => onOpen(t.id)}
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-slate-50">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-800">{t.name}</span>
                    <span className="block truncate text-xs text-slate-400">{t.owner_email ?? 'sin correo'}</span>
                  </span>
                  <Badge tone="brand">{t.plan ? plans[t.plan].name : '—'}</Badge>
                  <Badge tone={ALERT_INFO[kind].tone}>{ALERT_INFO[kind].label}</Badge>
                  <span className="w-full text-xs tabular-nums text-slate-500 sm:w-24 sm:text-right">{date ? fmtDate(date) : '—'}</span>
                </button>
              </li>
            ))}
          </ul>
          <Pagination {...paged.pager} label="alertas" />
        </>
      )}
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
  rows, loading, error, filtered, filterKey, plans, typeLabels, onDetail, onMembers, onPlan, onToggleSuspend, onDelete, onEnter,
}: {
  rows: AdminTenantRow[]
  loading: boolean
  error: unknown
  /** ¿Hay búsqueda o filtros? Cambia el texto de la lista vacía. */
  filtered: boolean
  /** Cambia con cualquier filtro: al cambiar, se vuelve a la primera página. */
  filterKey: string
  plans: Record<PlanCode, PlanInfo>
  typeLabels: Record<string, string>
  onDetail: (id: string) => void
  onMembers: (id: string) => void
  onPlan: (id: string) => void
  onToggleSuspend: (t: AdminTenantRow) => void
  onDelete: (t: AdminTenantRow) => void
  onEnter: (t: AdminTenantRow) => void
}) {
  const [page, setPage] = useState(0)
  const { slice, safePage } = paginate(rows, page, TENANTS_PAGE_SIZE)
  // Los filtros trabajan sobre TODA la lista (ya viene entera del servidor); al
  // cambiar cualquiera hay que volver a la primera página o se ve un hueco.
  useEffect(() => setPage(0), [filterKey])

  // Una sola lista de acciones para la tabla y para las tarjetas: así una opción
  // nueva no aparece en escritorio y falta en el teléfono.
  const actionsFor = (t: AdminTenantRow): ActionItem[] => [
    { label: 'Ver detalle', icon: <Eye className="h-4 w-4" />, onClick: () => onDetail(t.id) },
    { label: 'Entrar como gestor', icon: <LogIn className="h-4 w-4" />, hint: '2 horas, con motivo, queda registrado', onClick: () => onEnter(t) },
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
          title={filtered ? 'Sin resultados' : 'Aún no hay negocios'}
          description={filtered ? 'Prueba con otro término o quita los filtros.' : 'Cuando alguien cree su cuenta, aparecerá aquí.'} />
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
