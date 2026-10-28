import { useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { BellRing, Clock, Plus, ShoppingBag, Store, Users, UtensilsCrossed } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { PageHeader } from '@/components/PageHeader'
import { RequireAccess } from '@/components/RequireAccess'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import {
  useOpenOrder,
  useOpenOrders,
  useRestaurantAreas,
  useRestaurantTables,
  type OpenOrder,
} from '@/hooks/restaurant'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import { money } from '@/lib/format'
import type { RestaurantTable } from '@/types/erp'
import { AccountView } from './AccountView'
import { AdminView } from './AdminView'
import {
  fmtMinutes,
  isBillable,
  minutesSince,
  pricePreview,
  useBranchChoice,
  useMyBranches,
  useNow,
  usePriceContext,
  useServiceChargePref,
  type PriceContext,
} from './shared'

/*
 * Mesas y cuentas (restaurante).
 *
 * Decisiones que no se ven en el código:
 *   · La cuenta abierta va en la URL (?cuenta=<id>): "atrás" del navegador o
 *     del teléfono vuelve al salón, y recargar no saca al mesero de la mesa.
 *   · Una mesa puede tener varias cuentas abiertas (cuentas separadas). Con una
 *     sola, tocar la mesa entra directo; con varias, se elige.
 *   · Los importes del salón son VISTA PREVIA con los precios del menú; el
 *     importe que vale lo calcula la base al cobrar.
 */

export function RestaurantPage() {
  return (
    <RequireAccess module="restaurant" perm="restaurant.orders">
      <RestaurantScreen />
    </RequireAccess>
  )
}

type Tab = 'floor' | 'admin'

function RestaurantScreen() {
  const { can } = useAuth()
  const my = useMyBranches()
  const [branchId, setBranchId] = useBranchChoice('floor', my.branches)
  const [params, setParams] = useSearchParams()
  const orderId = params.get('cuenta')
  const [tab, setTab] = useState<Tab>('floor')
  const [service, setService] = useServiceChargePref()
  const tables = useRestaurantTables()
  const [newFor, setNewFor] = useState<{ tableId: string | null; branchId: string } | null>(null)

  const openOrder = (id: string) => setParams({ cuenta: id })
  const back = () => setParams({})

  if (my.isLoading) return <PageLoader label="Cargando el salón…" />
  if (my.isError) {
    return (
      <EmptyState
        icon={<Store className="h-6 w-6" />}
        title="No se pudo cargar el salón"
        description={errorMessage(my.error)}
        action={
          <Button variant="outline" onClick={() => void my.refetch()}>
            Reintentar
          </Button>
        }
      />
    )
  }
  if (!branchId) {
    return (
      <EmptyState
        icon={<Store className="h-6 w-6" />}
        title="No tienes sucursales disponibles"
        description="Pide acceso a una sucursal para tomar pedidos."
      />
    )
  }

  const allTables = tables.data ?? []
  // La cuenta nueva va a la sucursal de donde se pidió (puede no ser la elegida
  // si se entró a una cuenta por enlace).
  const newModal = newFor && (
    <NewOrderModal
      branchId={newFor.branchId}
      table={newFor.tableId ? (allTables.find((t) => t.id === newFor.tableId) ?? null) : null}
      onClose={() => setNewFor(null)}
      onOpened={(id) => {
        setNewFor(null)
        openOrder(id)
      }}
    />
  )

  if (orderId) {
    return (
      <>
        <AccountView
          key={orderId}
          orderId={orderId}
          tables={allTables}
          service={service}
          onServiceChange={setService}
          onBack={back}
          onOpenOrder={openOrder}
          onNewAccount={(tableId, orderBranch) => setNewFor({ tableId, branchId: orderBranch })}
        />
        {newModal}
      </>
    )
  }

  const canManage = can('restaurant.manage')
  const activeTab: Tab = canManage ? tab : 'floor'

  return (
    <div>
      <PageHeader
        title="Mesas y cuentas"
        description="Toca una mesa para abrir o continuar su cuenta."
        action={
          my.branches.length > 1 ? (
            <Select
              aria-label="Sucursal"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              className="w-full sm:w-56"
            >
              {my.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          ) : undefined
        }
      />

      {canManage && (
        <Segmented
          label="Vista"
          className="mb-4 sm:max-w-sm"
          value={activeTab}
          onChange={setTab}
          options={[
            { value: 'floor', label: 'Salón' },
            { value: 'admin', label: 'Áreas y mesas' },
          ]}
        />
      )}

      {activeTab === 'floor' ? (
        <FloorView
          branchId={branchId}
          onOpenOrder={openOrder}
          onNewOrder={(tableId) => setNewFor({ tableId, branchId })}
          onConfigure={canManage ? () => setTab('admin') : undefined}
        />
      ) : (
        <AdminView branchId={branchId} />
      )}
      {newModal}
    </div>
  )
}

// ── Salón ───────────────────────────────────────────────────────────────────

type TableState = 'free' | 'busy' | 'ready'

const TABLE_TONE: Record<TableState, string> = {
  free: 'border-slate-200 bg-white hover:border-brand-300',
  busy: 'border-brand-300 bg-brand-50/60 hover:border-brand-400',
  ready: 'border-emerald-400 bg-emerald-50 hover:border-emerald-500 ring-2 ring-emerald-400/30',
}

interface OrderSummary {
  order: OpenOrder
  total: number
  ready: number
  pending: number
}

function summarize(order: OpenOrder, ctx: PriceContext): OrderSummary {
  return {
    order,
    total: pricePreview(order.items.filter(isBillable), ctx).total,
    ready: order.items.filter((i) => i.kitchen_status === 'ready').length,
    pending: order.items.filter((i) => i.kitchen_status === 'pending').length,
  }
}

function FloorView({
  branchId,
  onOpenOrder,
  onNewOrder,
  onConfigure,
}: {
  branchId: string
  onOpenOrder: (id: string) => void
  onNewOrder: (tableId: string | null) => void
  onConfigure?: () => void
}) {
  const { tenant } = useAuth()
  const areas = useRestaurantAreas()
  const tables = useRestaurantTables()
  const orders = useOpenOrders(branchId)
  const priceCtx = usePriceContext()
  const now = useNow()
  const [chooser, setChooser] = useState<RestaurantTable | null>(null)
  const currency = tenant?.currency ?? 'DOP'

  const { productMap, taxRate, pricesIncludeTax } = priceCtx
  const byTable = useMemo(() => {
    const ctx = { productMap, taxRate, pricesIncludeTax }
    const map = new Map<string, OrderSummary[]>()
    for (const o of orders.data ?? []) {
      const key = o.table_id ?? ''
      map.set(key, [...(map.get(key) ?? []), summarize(o, ctx)])
    }
    return map
  }, [orders.data, productMap, taxRate, pricesIncludeTax])

  if (areas.isLoading || tables.isLoading || orders.isLoading) return <PageLoader label="Cargando el salón…" />
  // Solo sin datos: con el refresco cada 10 s, un corte breve de red no debe
  // tapar el salón que ya se ve.
  const err = (!areas.data && areas.error) || (!tables.data && tables.error) || (!orders.data && orders.error)
  if (err) {
    return (
      <EmptyState
        title="No se pudo cargar el salón"
        description={errorMessage(err)}
        action={
          <Button
            variant="outline"
            onClick={() => {
              void areas.refetch()
              void tables.refetch()
              void orders.refetch()
            }}
          >
            Reintentar
          </Button>
        }
      />
    )
  }

  // Una mesa desactivada con cuentas abiertas se sigue mostrando: si no, esas
  // cuentas quedarían fuera de la vista sin forma de cobrarlas.
  const visibleTables = (tables.data ?? []).filter(
    (t) => t.branch_id === branchId && (t.is_active || byTable.has(t.id)),
  )
  const branchAreas = (areas.data ?? []).filter((a) => a.branch_id === branchId && a.is_active)
  const areaIds = new Set(branchAreas.map((a) => a.id))
  const groups = [
    ...branchAreas.map((a) => ({ id: a.id, name: a.name, tables: visibleTables.filter((t) => t.area_id === a.id) })),
    {
      id: '__other',
      name: branchAreas.length ? 'Otras mesas' : 'Mesas',
      tables: visibleTables.filter((t) => !t.area_id || !areaIds.has(t.area_id)),
    },
  ].filter((g) => g.tables.length > 0)

  const takeout = byTable.get('') ?? []
  const allOrders = orders.data ?? []
  const busyCount = visibleTables.filter((t) => byTable.has(t.id)).length
  const readyCount = allOrders.reduce((s, o) => s + o.items.filter((i) => i.kitchen_status === 'ready').length, 0)

  const tapTable = (t: RestaurantTable) => {
    const list = byTable.get(t.id) ?? []
    if (list.length === 0) onNewOrder(t.id)
    else if (list.length === 1) onOpenOrder(list[0].order.id)
    else setChooser(t)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="brand">
          {busyCount}/{visibleTables.length} mesas ocupadas
        </Badge>
        <Badge tone="slate">{allOrders.length} cuentas abiertas</Badge>
        {readyCount > 0 && (
          <Badge tone="green">
            <BellRing className="h-3.5 w-3.5" /> {readyCount} para servir
          </Badge>
        )}
      </div>

      {visibleTables.length === 0 && (
        <EmptyState
          icon={<UtensilsCrossed className="h-6 w-6" />}
          title="Esta sucursal aún no tiene mesas"
          description={
            onConfigure
              ? 'Crea las mesas para tomar pedidos por mesa. Mientras tanto puedes abrir cuentas para llevar.'
              : 'Pide a quien administra el restaurante que cree las mesas. Mientras tanto puedes abrir cuentas para llevar.'
          }
          action={onConfigure ? <Button onClick={onConfigure}>Configurar mesas</Button> : undefined}
        />
      )}

      {groups.map((g) => (
        <section key={g.id}>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{g.name}</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
            {g.tables.map((t) => (
              <TableCard
                key={t.id}
                table={t}
                summaries={byTable.get(t.id) ?? []}
                now={now}
                currency={currency}
                onClick={() => tapTable(t)}
              />
            ))}
          </div>
        </section>
      ))}

      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Para llevar</h2>
          <Button size="sm" variant="secondary" onClick={() => onNewOrder(null)}>
            <Plus className="h-4 w-4" /> Nueva para llevar
          </Button>
        </div>
        {takeout.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
            No hay pedidos para llevar abiertos.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {takeout.map((s) => (
              <AccountButton key={s.order.id} summary={s} now={now} currency={currency} onClick={() => onOpenOrder(s.order.id)} />
            ))}
          </div>
        )}
      </section>

      {chooser && (
        <Modal
          open
          onClose={() => setChooser(null)}
          title={`${chooser.name} · cuentas abiertas`}
          footer={
            <Button
              variant="outline"
              onClick={() => {
                const id = chooser.id
                setChooser(null)
                onNewOrder(id)
              }}
            >
              <Plus className="h-4 w-4" /> Nueva cuenta en esta mesa
            </Button>
          }
        >
          <div className="space-y-2">
            {(byTable.get(chooser.id) ?? []).map((s) => (
              <AccountButton
                key={s.order.id}
                summary={s}
                now={now}
                currency={currency}
                onClick={() => {
                  setChooser(null)
                  onOpenOrder(s.order.id)
                }}
              />
            ))}
          </div>
        </Modal>
      )}

    </div>
  )
}

function TableCard({
  table,
  summaries,
  now,
  currency,
  onClick,
}: {
  table: RestaurantTable
  summaries: OrderSummary[]
  now: number
  currency: string
  onClick: () => void
}) {
  const busy = summaries.length > 0
  const ready = summaries.reduce((s, x) => s + x.ready, 0)
  const pending = summaries.reduce((s, x) => s + x.pending, 0)
  const total = summaries.reduce((s, x) => s + x.total, 0)
  const guests = summaries.reduce((s, x) => s + x.order.guests, 0)
  const oldest = summaries.reduce<string | null>(
    (min, x) => (!min || x.order.opened_at < min ? x.order.opened_at : min),
    null,
  )
  const state: TableState = ready > 0 ? 'ready' : busy ? 'busy' : 'free'

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-h-[112px] flex-col justify-between rounded-2xl border p-3 text-left shadow-sm transition active:scale-[0.98]',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40',
        TABLE_TONE[state],
      )}
    >
      <div className="flex items-start justify-between gap-1">
        <span className="min-w-0 truncate text-base font-bold text-slate-900">{table.name}</span>
        <span className="flex shrink-0 items-center gap-0.5 text-xs text-slate-500">
          <Users className="h-3.5 w-3.5" /> {busy ? `${guests}/${table.seats}` : table.seats}
        </span>
      </div>
      {busy ? (
        <div className="mt-2 space-y-1">
          <p className="text-base font-bold tabular-nums text-slate-900">{money(total, currency)}</p>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-slate-600">
            <span className="inline-flex items-center gap-0.5">
              <Clock className="h-3.5 w-3.5" /> {fmtMinutes(minutesSince(oldest, now))}
            </span>
            {summaries.length > 1 && <span>{summaries.length} cuentas</span>}
          </p>
          <div className="flex flex-wrap gap-1">
            {ready > 0 && <Badge tone="green">{ready} listo(s)</Badge>}
            {pending > 0 && <Badge tone="amber">{pending} sin enviar</Badge>}
          </div>
        </div>
      ) : (
        <p className="mt-2 text-sm font-medium text-slate-400">
          Libre{!table.is_active && ' · inactiva'}
        </p>
      )}
    </button>
  )
}

function AccountButton({
  summary,
  now,
  currency,
  onClick,
}: {
  summary: OrderSummary
  now: number
  currency: string
  onClick: () => void
}) {
  const { order, total, ready, pending } = summary
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl border bg-white px-3 py-2.5 text-left shadow-sm hover:bg-slate-50',
        ready > 0 ? 'border-emerald-400' : 'border-slate-200',
      )}
    >
      <ShoppingBag className="h-5 w-5 shrink-0 text-slate-400" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-slate-800">{order.label || order.number}</span>
        <span className="block truncate text-xs text-slate-500">
          {order.label ? `${order.number} · ` : ''}
          {order.guests} pers. · {fmtMinutes(minutesSince(order.opened_at, now))}
        </span>
        {(ready > 0 || pending > 0) && (
          <span className="mt-1 flex flex-wrap gap-1">
            {ready > 0 && <Badge tone="green">{ready} listo(s)</Badge>}
            {pending > 0 && <Badge tone="amber">{pending} sin enviar</Badge>}
          </span>
        )}
      </span>
      <span className="shrink-0 text-sm font-bold tabular-nums text-slate-900">{money(total, currency)}</span>
    </button>
  )
}

// ── Abrir cuenta ────────────────────────────────────────────────────────────

function NewOrderModal({
  branchId,
  table,
  onClose,
  onOpened,
}: {
  branchId: string
  /** null = para llevar. */
  table: RestaurantTable | null
  onClose: () => void
  onOpened: (id: string) => void
}) {
  const toast = useToast()
  const open = useOpenOrder()
  const [guests, setGuests] = useState(String(table ? Math.min(2, table.seats) : 1))
  const [label, setLabel] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string>()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const n = Math.trunc(Number(guests))
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      setError('Entre 1 y 100 personas')
      return
    }
    open.mutate(
      { branchId, tableId: table?.id ?? null, guests: n, label: label.trim() || null, notes: notes.trim() || null },
      {
        onSuccess: (id) => onOpened(id),
        onError: (err) => toast.error(errorMessage(err, 'No se pudo abrir la cuenta')),
      },
    )
  }

  const step = (d: number) => {
    const n = Math.trunc(Number(guests)) || 0
    setGuests(String(Math.min(100, Math.max(1, n + d))))
    setError(undefined)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={table ? `Abrir cuenta · ${table.name}` : 'Nueva cuenta para llevar'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="new-order-form" loading={open.isPending}>
            Abrir cuenta
          </Button>
        </>
      }
    >
      <form id="new-order-form" onSubmit={submit} className="space-y-4">
        <Field label="Personas" htmlFor="guests" error={error}>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="icon" aria-label="Una persona menos" onClick={() => step(-1)}>
              −
            </Button>
            <Input
              id="guests"
              inputMode="numeric"
              value={guests}
              onChange={(e) => {
                setGuests(e.target.value)
                setError(undefined)
              }}
              className="w-20 text-center text-lg"
            />
            <Button type="button" variant="outline" size="icon" aria-label="Una persona más" onClick={() => step(1)}>
              +
            </Button>
          </div>
        </Field>
        <Field
          label={table ? 'Nombre de la cuenta (opcional)' : 'Nombre del cliente (opcional)'}
          htmlFor="order-label"
          hint={table ? 'Útil si la mesa tiene cuentas separadas: "Juan", "Pareja ventana"…' : 'Para llamarlo cuando esté listo.'}
        >
          <Input id="order-label" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Nota (opcional)" htmlFor="order-notes">
          <Input id="order-notes" value={notes} maxLength={200} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </form>
    </Modal>
  )
}
