import { useMemo, useState } from 'react'
import { BellRing, ChefHat, Clock, CookingPot, RefreshCw, Undo2 } from 'lucide-react'
import { RequireAccess } from '@/components/RequireAccess'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useProducts } from '@/hooks/core'
import { useKitchenQueue, useRestaurantTables, useSetKitchenStatus, type KitchenQueueItem } from '@/hooks/restaurant'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import { KITCHEN_STATUS } from '@/lib/labels'
import type { KitchenStatus, Product } from '@/types/erp'
import { fmtMinutes, fmtQty, minutesSince, productLabel, useBranchChoice, useMyBranches, useNow } from './shared'

/*
 * Pantalla de cocina (KDS). Pensada para una tableta apaisada en la pared:
 * tarjetas grandes por comanda, botones que se aciertan con el dedo mojado, y
 * sin nada que escribir. En un teléfono las dos columnas pasan a pestañas.
 *
 * Se refresca sola cada 5 s (useKitchenQueue) y los cambios de estado se
 * pintan al instante (actualización optimista en el hook).
 */

export function KitchenPage() {
  return (
    <RequireAccess module="restaurant" perm="restaurant.kitchen">
      <KitchenScreen />
    </RequireAccess>
  )
}

type Column = 'cook' | 'ready'

/** Antigüedad de la comanda: a los 10 min se avisa, a los 15 llega tarde. */
type Age = 'ok' | 'warn' | 'late'
const AGE_TONE: Record<Age, { card: string; clock: string }> = {
  ok: { card: 'border-slate-200', clock: 'bg-slate-100 text-slate-700' },
  warn: { card: 'border-amber-400', clock: 'bg-amber-100 text-amber-800' },
  late: { card: 'border-red-500 ring-2 ring-red-500/30', clock: 'bg-red-600 text-white' },
}
const ageOf = (min: number): Age => (min > 15 ? 'late' : min >= 10 ? 'warn' : 'ok')

interface TicketCard {
  key: string
  ticketNumber: string | null
  orderNumber: string
  title: string
  guests: number
  /** Desde cuándo se cuenta (envío a cocina). */
  since: string | null
  items: KitchenQueueItem[]
}

function groupCards(
  items: KitchenQueueItem[],
  tableName: (id: string | null) => string,
  sinceOf: (it: KitchenQueueItem) => string | null,
): TicketCard[] {
  const map = new Map<string, TicketCard>()
  for (const it of items) {
    const key = it.ticket_id ?? `order:${it.order_id}`
    let card = map.get(key)
    if (!card) {
      card = {
        key,
        ticketNumber: it.ticket?.number ?? null,
        orderNumber: it.order.number,
        title: [tableName(it.order.table_id), it.order.label].filter(Boolean).join(' · '),
        guests: it.order.guests,
        since: null,
        items: [],
      }
      map.set(key, card)
    }
    card.items.push(it)
    const s = sinceOf(it)
    if (s && (!card.since || s < card.since)) card.since = s
  }
  // La más antigua primero: es la que la sala está esperando.
  return [...map.values()].sort((a, b) => (a.since ?? '').localeCompare(b.since ?? ''))
}

function KitchenScreen() {
  const toast = useToast()
  const my = useMyBranches()
  const [branchId, setBranchId] = useBranchChoice('kitchen', my.branches, my.branches.length > 1)
  const queue = useKitchenQueue(branchId)
  const tables = useRestaurantTables()
  const products = useProducts()
  const setStatus = useSetKitchenStatus()
  const now = useNow(15_000)
  const [column, setColumn] = useState<Column>('cook')

  const productMap = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p])), [products.data])
  const tableMap = useMemo(() => new Map((tables.data ?? []).map((t) => [t.id, t.name])), [tables.data])
  const tableName = (id: string | null) => (id ? (tableMap.get(id) ?? 'Mesa') : 'Para llevar')

  // "Todas" = todas las sucursales A LAS QUE ESTA PERSONA TIENE ACCESO; la
  // lectura de líneas no filtra por sucursal en la base.
  const allowed = new Set(my.branches.map((b) => b.id))
  const items = (queue.data ?? []).filter((i) => allowed.has(i.order.branch_id))
  const cooking = groupCards(
    items.filter((i) => i.kitchen_status === 'sent' || i.kitchen_status === 'preparing'),
    tableName,
    (i) => i.ticket?.created_at ?? i.sent_at,
  )
  const ready = groupCards(
    items.filter((i) => i.kitchen_status === 'ready'),
    tableName,
    (i) => i.ready_at ?? i.sent_at,
  )

  const change = (it: KitchenQueueItem, status: KitchenStatus) =>
    setStatus.mutate(
      { itemId: it.id, status },
      { onError: (err) => toast.error(errorMessage(err, 'No se pudo cambiar el estado')) },
    )
  const changeAll = (card: TicketCard, from: KitchenStatus[], status: KitchenStatus) => {
    for (const it of card.items) if (from.includes(it.kitchen_status)) change(it, status)
  }

  if (my.isLoading || (queue.isLoading && !queue.data)) return <PageLoader label="Cargando la cocina…" />

  return (
    <div>
      <PageHeader
        title="Cocina"
        description={
          queue.dataUpdatedAt
            ? `Se actualiza sola · ${new Date(queue.dataUpdatedAt).toLocaleTimeString('es-DO', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`
            : 'Se actualiza sola cada pocos segundos'
        }
        action={
          <>
            {my.branches.length > 1 && (
              <Select
                aria-label="Sucursal"
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                className="w-full sm:w-52"
              >
                <option value="">Todas las sucursales</option>
                {my.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            )}
            <Button
              variant="outline"
              size="icon"
              aria-label="Actualizar ahora"
              onClick={() => void queue.refetch()}
              className="shrink-0"
            >
              <RefreshCw className={cn('h-5 w-5', queue.isFetching && 'animate-spin')} />
            </Button>
          </>
        }
      />

      {queue.isError && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          <span className="min-w-0">
            {queue.data ? 'Sin conexión: lo que ves puede estar desactualizado. ' : ''}
            {errorMessage(queue.error)}
          </span>
          <Button size="sm" variant="outline" onClick={() => void queue.refetch()}>
            Reintentar
          </Button>
        </div>
      )}

      <Segmented
        label="Columna"
        className="mb-4 lg:hidden"
        value={column}
        onChange={setColumn}
        options={[
          { value: 'cook', label: `En cocina (${cooking.length})` },
          { value: 'ready', label: `Para servir (${ready.length})` },
        ]}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section className={cn(column !== 'cook' && 'hidden lg:block')}>
          <h2 className="mb-2 hidden items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500 lg:flex">
            <CookingPot className="h-4 w-4" /> En cocina ({cooking.length})
          </h2>
          {cooking.length === 0 ? (
            <EmptyState
              icon={<ChefHat className="h-6 w-6" />}
              title="Nada pendiente"
              description="Las comandas aparecen aquí en cuanto la sala las envía."
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {cooking.map((card) => {
                const min = minutesSince(card.since, now)
                const age = ageOf(min)
                const busy = card.items.some((i) => i.kitchen_status !== 'ready')
                return (
                  <article key={card.key} className={cn('rounded-2xl border-2 bg-white shadow-sm', AGE_TONE[age].card)}>
                    <CardHead card={card} minutes={min} clockTone={AGE_TONE[age].clock} />
                    <ul className="divide-y divide-slate-100">
                      {card.items.map((it) => (
                        <li key={it.id} className="px-4 py-3">
                          <ItemText item={it} productMap={productMap} />
                          <div className="mt-2 grid grid-cols-2 gap-2">
                            {it.kitchen_status === 'sent' ? (
                              <Button variant="outline" onClick={() => change(it, 'preparing')}>
                                Preparando
                              </Button>
                            ) : (
                              <Badge tone={KITCHEN_STATUS[it.kitchen_status].tone} className="h-11 justify-center text-sm">
                                {KITCHEN_STATUS[it.kitchen_status].label}
                              </Badge>
                            )}
                            <Button onClick={() => change(it, 'ready')}>
                              Listo
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                    {card.items.length > 1 && busy && (
                      <div className="border-t border-slate-100 p-3">
                        <Button
                          size="lg"
                          variant="secondary"
                          className="w-full"
                          onClick={() => changeAll(card, ['sent', 'preparing'], 'ready')}
                        >
                          Toda la comanda lista
                        </Button>
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          )}
        </section>

        <section className={cn(column !== 'ready' && 'hidden lg:block')}>
          <h2 className="mb-2 hidden items-center gap-2 text-sm font-semibold uppercase tracking-wide text-emerald-700 lg:flex">
            <BellRing className="h-4 w-4" /> Listos para servir ({ready.length})
          </h2>
          {ready.length === 0 ? (
            <EmptyState
              icon={<BellRing className="h-6 w-6" />}
              title="Nada esperando"
              description="Lo que marques como listo queda aquí hasta que la sala lo sirva."
            />
          ) : (
            <div className="space-y-3">
              {ready.map((card) => (
                <article key={card.key} className="rounded-2xl border-2 border-emerald-400 bg-emerald-50/60 shadow-sm">
                  <CardHead
                    card={card}
                    minutes={minutesSince(card.since, now)}
                    clockTone="bg-emerald-100 text-emerald-800"
                    clockPrefix="listo hace "
                  />
                  <ul className="divide-y divide-emerald-100">
                    {card.items.map((it) => (
                      <li key={it.id} className="px-4 py-3">
                        <ItemText item={it} productMap={productMap} />
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <Button variant="outline" onClick={() => change(it, 'preparing')}>
                            <Undo2 className="h-4 w-4" /> Deshacer
                          </Button>
                          <Button variant="secondary" onClick={() => change(it, 'served')}>
                            Entregado
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {card.items.length > 1 && (
                    <div className="border-t border-emerald-100 p-3">
                      <Button size="lg" variant="outline" className="w-full" onClick={() => changeAll(card, ['ready'], 'served')}>
                        Todo entregado
                      </Button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function CardHead({
  card,
  minutes,
  clockTone,
  clockPrefix = '',
}: {
  card: TicketCard
  minutes: number
  clockTone: string
  clockPrefix?: string
}) {
  return (
    <header className="flex items-start justify-between gap-2 border-b border-slate-100 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-xl font-bold text-slate-900">{card.title}</p>
        <p className="truncate text-xs text-slate-500">
          {[card.ticketNumber, card.orderNumber, `${card.guests} pers.`].filter(Boolean).join(' · ')}
        </p>
      </div>
      <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-sm font-bold tabular-nums', clockTone)}>
        <Clock className="h-4 w-4" /> {clockPrefix}
        {fmtMinutes(minutes)}
      </span>
    </header>
  )
}

function ItemText({ item, productMap }: { item: KitchenQueueItem; productMap: Map<string, Product> }) {
  const p = productMap.get(item.product_id)
  return (
    <>
      <p className="text-lg font-semibold leading-snug text-slate-900">
        <span className="tabular-nums">{fmtQty(item.quantity)} ×</span> {p ? productLabel(p) : 'Producto'}
      </p>
      {/* La nota es lo que más se pasa por alto: va resaltada, no en gris. */}
      {item.notes && (
        <p className="mt-1 rounded-lg bg-amber-100 px-2.5 py-1.5 text-base font-semibold text-amber-900">» {item.notes}</p>
      )}
    </>
  )
}
