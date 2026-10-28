import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlarmClock, CheckCircle2, ClipboardList, FileText, Plus, Search, Wrench } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { RequireAccess } from '@/components/RequireAccess'
import { ActionMenu, type ActionItem } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Field, Input } from '@/components/ui/Input'
import { Pagination, paginate } from '@/components/ui/Pagination'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useCustomers } from '@/hooks/core'
import { useTeamMembers } from '@/hooks/team'
import { useWorkOrders, WORK_ORDER_HISTORY_LIMIT, type WorkOrderFilters, type WorkOrderRow } from '@/hooks/workshop'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import { fmtDateShort, fmtDateTime, norm } from '@/lib/format'
import { WORK_ORDER_STATUS } from '@/lib/labels'
import type { WorkOrderStatus } from '@/types/erp'
import { ACTIVE_STATUSES, assetLabel, isOverdue } from './shared'

const PAGE_SIZE = 25

type StatusFilter = WorkOrderStatus | 'all'
type View = 'list' | 'board'

export function WorkOrdersPage() {
  return (
    <RequireAccess module="workshop" perm="workshop.manage">
      <WorkOrdersContent />
    </RequireAccess>
  )
}

function WorkOrdersContent() {
  const navigate = useNavigate()
  const [scope, setScope] = useState<WorkOrderFilters['scope']>('active')
  const [technician, setTechnician] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [view, setView] = useState<View>('list')

  const orders = useWorkOrders({ scope, technician })
  const customers = useCustomers()
  const members = useTeamMembers()

  const customerName = useMemo(() => new Map((customers.data ?? []).map((c) => [c.id, c.name])), [customers.data])
  const memberName = useMemo(
    () => new Map((members.data ?? []).map((m) => [m.user_id, m.full_name ?? m.email ?? 'Sin nombre'])),
    [members.data],
  )
  const technicians = useMemo(() => (members.data ?? []).filter((m) => m.is_active), [members.data])

  const all = orders.data ?? []
  const nameOf = (o: WorkOrderRow) => customerName.get(o.customer_id) ?? 'Cliente'
  const techOf = (o: WorkOrderRow) => (o.technician_id ? (memberName.get(o.technician_id) ?? 'Técnico') : 'Sin asignar')

  // La búsqueda va antes que el estado: así los contadores de los filtros
  // dicen cuántas hay de cada estado DENTRO de lo que se buscó.
  const searched = useMemo(() => {
    const s = norm(search)
    if (!s) return all
    return all.filter(
      (o) =>
        norm(o.number).includes(s) ||
        norm(customerName.get(o.customer_id)).includes(s) ||
        norm(o.asset?.plate).includes(s) ||
        norm(o.asset?.serial).includes(s) ||
        norm([o.asset?.brand, o.asset?.model].filter(Boolean).join(' ')).includes(s),
    )
  }, [all, search, customerName])

  const counts = useMemo(() => {
    const c: Partial<Record<WorkOrderStatus, number>> = {}
    for (const o of searched) c[o.status] = (c[o.status] ?? 0) + 1
    return c
  }, [searched])

  const rows = status === 'all' ? searched : searched.filter((o) => o.status === status)
  const { slice, safePage } = paginate(rows, page, PAGE_SIZE)

  const statusOptions: WorkOrderStatus[] = scope === 'active' ? ACTIVE_STATUSES : ['delivered', 'canceled']
  const overdue = all.filter(isOverdue).length

  const setStatusAndReset = (s: StatusFilter) => {
    setStatus(s)
    setPage(0)
  }
  const changeScope = (s: WorkOrderFilters['scope']) => {
    setScope(s)
    setStatus('all')
    setPage(0)
  }

  const open = (o: WorkOrderRow) => navigate(`/taller/${o.id}`)
  const actionsFor = (o: WorkOrderRow): ActionItem[] => {
    const items: ActionItem[] = [{ label: 'Abrir orden', icon: <FileText className="h-4 w-4" />, onClick: () => open(o) }]
    if (o.sale_id) {
      items.push({ label: 'Ver venta', icon: <CheckCircle2 className="h-4 w-4" />, onClick: () => navigate(`/ventas/${o.sale_id}`) })
    }
    return items
  }

  return (
    <div>
      <PageHeader
        title="Órdenes de trabajo"
        description="Vehículos y equipos en el taller: diagnóstico, cotización, reparación y entrega."
        action={
          <Button onClick={() => navigate('/taller/nueva')}>
            <Plus className="h-4 w-4" /> Nueva orden
          </Button>
        }
      />

      {scope === 'active' && !orders.isLoading && !orders.isError && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-3">
          <StatCard label="En el taller" value={all.length} icon={<Wrench className="h-5 w-5" />} />
          <StatCard
            label="Atrasadas"
            value={overdue}
            icon={<AlarmClock className="h-5 w-5" />}
            tone={overdue > 0 ? 'red' : 'slate'}
            hint="Pasada la fecha prometida"
          />
          <StatCard
            label="Listas para entregar"
            value={all.filter((o) => o.status === 'done').length}
            icon={<CheckCircle2 className="h-5 w-5" />}
            tone="green"
            className="col-span-2 lg:col-span-1"
          />
        </div>
      )}

      <div className="mb-4 space-y-3">
        <Segmented<WorkOrderFilters['scope']>
          value={scope}
          onChange={changeScope}
          label="Órdenes"
          options={[
            { value: 'active', label: 'En curso' },
            { value: 'history', label: 'Historial' },
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Buscar">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setPage(0)
                }}
                placeholder="Número, cliente o placa"
                className="pl-9"
              />
            </div>
          </Field>
          <Field label="Técnico">
            <Select
              value={technician}
              onChange={(e) => {
                setTechnician(e.target.value)
                setPage(0)
              }}
            >
              <option value="">Todos</option>
              <option value="none">Sin asignar</option>
              {technicians.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.full_name ?? m.email ?? 'Sin nombre'}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {/* Chips que se parten en varias líneas: a 360px no caben en una y no
            puede haber desplazamiento horizontal. */}
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar por estado">
          <StatusChip active={status === 'all'} onClick={() => setStatusAndReset('all')}>
            Todas · {searched.length}
          </StatusChip>
          {statusOptions.map((s) => (
            <StatusChip key={s} active={status === s} onClick={() => setStatusAndReset(s)}>
              {WORK_ORDER_STATUS[s].label} · {counts[s] ?? 0}
            </StatusChip>
          ))}
        </div>

        {scope === 'active' && (
          // El tablero solo cabe con pantalla ancha: seis columnas por debajo de
          // `xl` quedan de menos de 150px y las tarjetas se vuelven ilegibles.
          <div className="hidden w-64 xl:block">
            <Segmented<View>
              value={view}
              onChange={setView}
              label="Vista"
              options={[
                { value: 'list', label: 'Lista' },
                { value: 'board', label: 'Tablero' },
              ]}
            />
          </div>
        )}
      </div>

      {orders.isLoading ? (
        <PageLoader label="Cargando órdenes…" />
      ) : orders.isError ? (
        <EmptyState
          icon={<ClipboardList className="h-6 w-6" />}
          title="No se pudieron cargar las órdenes"
          description={errorMessage(orders.error)}
          action={<Button onClick={() => orders.refetch()}>Reintentar</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ClipboardList className="h-6 w-6" />}
          title={all.length ? 'Ninguna orden coincide' : scope === 'active' ? 'No hay órdenes en curso' : 'Aún no hay órdenes cerradas'}
          description={
            all.length
              ? 'Cambia la búsqueda o los filtros.'
              : scope === 'active'
                ? 'Registra el vehículo o equipo que entra al taller, el problema que reporta el cliente y a quién se le asigna.'
                : 'Aquí aparecen las órdenes entregadas y canceladas.'
          }
          action={
            !all.length && scope === 'active' ? (
              <Button onClick={() => navigate('/taller/nueva')}>
                <Plus className="h-4 w-4" /> Nueva orden
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {scope === 'active' && view === 'board' && (
            <Board rows={rows} nameOf={nameOf} techOf={techOf} onOpen={open} />
          )}
          <Card className={cn(scope === 'active' && view === 'board' && 'xl:hidden')}>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3 font-medium">Orden</th>
                    <th className="px-4 py-3 font-medium">Cliente</th>
                    <th className="px-4 py-3 font-medium">Vehículo / equipo</th>
                    <th className="px-4 py-3 font-medium">Técnico</th>
                    <th className="px-4 py-3 font-medium">Prometida</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {slice.map((o) => {
                    const late = isOverdue(o)
                    return (
                      <tr key={o.id} className={cn('hover:bg-slate-50/60', late && 'bg-red-50/40')}>
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            onClick={() => open(o)}
                            className="font-medium text-slate-800 hover:text-brand-600"
                          >
                            {o.number}
                          </button>
                          <p className="text-xs text-slate-400">{fmtDateShort(o.received_at)}</p>
                        </td>
                        <td className="max-w-[14rem] truncate px-4 py-3 text-slate-700">{nameOf(o)}</td>
                        <td className="max-w-[16rem] truncate px-4 py-3 text-slate-600">{assetLabel(o.asset)}</td>
                        <td className="px-4 py-3 text-slate-600">{techOf(o)}</td>
                        <td className={cn('px-4 py-3', late ? 'font-medium text-red-600' : 'text-slate-600')}>
                          {o.promised_at ? fmtDateTime(o.promised_at) : '—'}
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadges o={o} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <ActionMenu items={actionsFor(o)} title={o.number} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <DataList>
              {slice.map((o) => (
                <DataRow
                  key={o.id}
                  title={`${o.number} · ${nameOf(o)}`}
                  titleExtra={assetLabel(o.asset)}
                  onClick={() => open(o)}
                  tone={isOverdue(o) ? 'danger' : undefined}
                  badges={<StatusBadges o={o} />}
                  actions={<ActionMenu items={actionsFor(o)} title={o.number} />}
                >
                  <DataFields>
                    <DataField label="Técnico">{techOf(o)}</DataField>
                    <DataField label="Prometida">{o.promised_at ? fmtDateTime(o.promised_at) : '—'}</DataField>
                  </DataFields>
                </DataRow>
              ))}
            </DataList>
            <Pagination page={safePage} pageSize={PAGE_SIZE} total={rows.length} onPage={setPage} label="órdenes" />
          </Card>
          {scope === 'history' && all.length >= WORK_ORDER_HISTORY_LIMIT && (
            <p className="mt-3 text-center text-xs text-slate-400">
              Se muestran las {WORK_ORDER_HISTORY_LIMIT} órdenes cerradas más recientes.
            </p>
          )}
        </>
      )}
    </div>
  )
}

function StatusChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'h-9 rounded-full px-3.5 text-sm font-medium transition-colors',
        active ? 'bg-brand-600 text-white' : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
      )}
    >
      {children}
    </button>
  )
}

function StatusBadges({ o }: { o: WorkOrderRow }) {
  const s = WORK_ORDER_STATUS[o.status]
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge tone={s.tone}>{s.label}</Badge>
      {isOverdue(o) && <Badge tone="red">Atrasada</Badge>}
      {o.sale_id && <Badge tone="green">Facturada</Badge>}
    </span>
  )
}

/** Tablero por estado (solo `xl`). Las columnas se desplazan por dentro, nunca la página. */
function Board({
  rows,
  nameOf,
  techOf,
  onOpen,
}: {
  rows: WorkOrderRow[]
  nameOf: (o: WorkOrderRow) => string
  techOf: (o: WorkOrderRow) => string
  onOpen: (o: WorkOrderRow) => void
}) {
  return (
    <div className="hidden grid-cols-6 gap-3 xl:grid">
      {ACTIVE_STATUSES.map((s) => {
        const col = rows.filter((o) => o.status === s)
        return (
          <section key={s} className="min-w-0 rounded-2xl bg-slate-100/70 p-2">
            <header className="flex items-center justify-between px-1.5 pb-2">
              <h3 className="truncate text-sm font-semibold text-slate-700">{WORK_ORDER_STATUS[s].label}</h3>
              <span className="text-xs font-medium text-slate-500">{col.length}</span>
            </header>
            <div className="max-h-[65vh] space-y-2 overflow-y-auto">
              {col.length === 0 && <p className="px-1.5 py-4 text-center text-xs text-slate-400">Ninguna</p>}
              {col.map((o) => {
                const late = isOverdue(o)
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => onOpen(o)}
                    className={cn(
                      'block w-full rounded-xl border bg-white p-2.5 text-left shadow-sm transition-colors hover:border-brand-300',
                      late ? 'border-red-200' : 'border-slate-200',
                    )}
                  >
                    <p className="truncate text-sm font-semibold text-slate-800">{o.number}</p>
                    <p className="truncate text-xs text-slate-600">{nameOf(o)}</p>
                    <p className="truncate text-xs text-slate-400">{assetLabel(o.asset)}</p>
                    <p className="mt-1 truncate text-xs text-slate-500">{techOf(o)}</p>
                    {o.promised_at && (
                      <p className={cn('truncate text-xs', late ? 'font-medium text-red-600' : 'text-slate-400')}>
                        {late ? 'Atrasada · ' : 'Para '}
                        {fmtDateTime(o.promised_at)}
                      </p>
                    )}
                  </button>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
