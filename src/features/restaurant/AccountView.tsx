import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  Ban,
  ChefHat,
  Combine,
  MessageSquareText,
  Minus,
  MoveRight,
  Pencil,
  Plus,
  Printer,
  ReceiptText,
  Search,
  Trash2,
  UtensilsCrossed,
  Users,
  X,
} from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { ActionMenu, type ActionItem } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useCategories } from '@/hooks/core'
import {
  useAddOrderItems,
  useCancelOrder,
  useCancelOrderItem,
  useMergeOrders,
  useMoveOrder,
  useOpenOrders,
  useRestaurantOrder,
  useRestaurantOrderFetcher,
  useSendToKitchen,
  useSetKitchenStatus,
  useUpdateOrderItem,
} from '@/hooks/restaurant'
import { useMemberNames } from '@/hooks/team'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import { money, num } from '@/lib/format'
import { KITCHEN_STATUS } from '@/lib/labels'
import type { Product, RestaurantOrder, RestaurantOrderItem, RestaurantTable } from '@/types/erp'
import { CheckoutModal } from './CheckoutModal'
import { printKitchenTicket, printPreBill } from './print'
import {
  Chip,
  NumberInput,
  finePointer,
  fmtMinutes,
  fmtQty,
  fold,
  isBillable,
  minutesSince,
  pricePreview,
  productLabel,
  r2,
  r3,
  readStorage,
  serviceChargeOf,
  useNow,
  usePriceContext,
  writeStorage,
  type PriceContext,
} from './shared'

/*
 * Una cuenta abierta: catálogo a la izquierda (en móvil, arriba) y la cuenta a
 * la derecha (en móvil, en una hoja).
 *
 * Lo que se va tocando en el catálogo NO se guarda al momento: queda como
 * "borrador" en este dispositivo (y en localStorage, por si se recarga) hasta
 * pulsar Guardar o Enviar a cocina. Así un toque de más no viaja a la base ni a
 * la cocina, y varios platos salen en UNA comanda.
 */

interface DraftLine {
  key: string
  product_id: string
  quantity: number
  notes: string
}

const draftKey = (tenantId: string, orderId: string) => `ferddo-rest-draft:${tenantId}:${orderId}`
const printKitchenKey = (tenantId: string) => `ferddo-rest-print-kitchen:${tenantId}`

let draftSeq = 0
const newDraftKey = () => `d${Date.now().toString(36)}${++draftSeq}`

function loadDraft(key: string): DraftLine[] {
  const raw = readStorage(key)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as DraftLine[]).filter((l) => l && typeof l.product_id === 'string') : []
  } catch {
    return []
  }
}

const ORDER_CLOSED_TEXT: Record<RestaurantOrder['status'], string> = {
  open: '',
  closed: 'Esta cuenta ya está cerrada.',
  canceled: 'Esta cuenta fue cancelada.',
}

export function AccountView({
  orderId,
  tables,
  service,
  onServiceChange,
  onBack,
  onOpenOrder,
  onNewAccount,
}: {
  orderId: string
  /** Mesas de la empresa (activas e inactivas), para nombres y para mover. */
  tables: RestaurantTable[]
  service: boolean
  onServiceChange: (v: boolean) => void
  onBack: () => void
  onOpenOrder: (id: string) => void
  onNewAccount: (tableId: string | null, branchId: string) => void
}) {
  const { tenant, can, hasModule } = useAuth()
  const toast = useToast()
  const detail = useRestaurantOrder(orderId)
  const priceCtx = usePriceContext()
  const names = useMemberNames()
  const now = useNow()

  const add = useAddOrderItems()
  const send = useSendToKitchen()
  const fetchOrder = useRestaurantOrderFetcher()

  const tenantId = tenant?.id ?? ''
  const currency = tenant?.currency ?? 'DOP'
  const m = (n: number) => money(n, currency)

  // ── Borrador local ──
  const dKey = draftKey(tenantId, orderId)
  const [draft, setDraft] = useState<DraftLine[]>(() => loadDraft(dKey))
  useEffect(() => {
    writeStorage(dKey, draft.length ? JSON.stringify(draft) : null)
  }, [draft, dKey])

  const [printKitchen, setPrintKitchenState] = useState(() => readStorage(printKitchenKey(tenantId)) !== '0')
  const setPrintKitchen = (v: boolean) => {
    setPrintKitchenState(v)
    writeStorage(printKitchenKey(tenantId), v ? '1' : '0')
  }

  const [panelOpen, setPanelOpen] = useState(false)
  const [modal, setModal] = useState<'move' | 'merge' | 'cancel' | 'checkout' | null>(null)

  // Una cuenta cerrada (cobrada, cancelada o unida a otra) no admite platos:
  // su borrador ya no tiene a dónde ir.
  const closed = Boolean(detail.data && detail.data.order.status !== 'open')
  useEffect(() => {
    if (closed) setDraft([])
  }, [closed])

  const addToDraft = (p: Product) =>
    setDraft((d) => {
      // Se suma a la línea del mismo producto SIN nota; con nota ("sin cebolla")
      // es otro plato y va aparte.
      const same = d.find((l) => l.product_id === p.id && !l.notes.trim())
      if (same) return d.map((l) => (l.key === same.key ? { ...l, quantity: r3(l.quantity + 1) } : l))
      return [...d, { key: newDraftKey(), product_id: p.id, quantity: 1, notes: '' }]
    })
  const patchDraft = (key: string, patch: Partial<DraftLine>) =>
    setDraft((d) => d.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const removeDraft = (key: string) => setDraft((d) => d.filter((l) => l.key !== key))

  if (detail.isLoading || priceCtx.isLoading) return <PageLoader label="Abriendo la cuenta…" />
  // Solo sin datos: un refresco fallido (red inestable) no debe tapar la cuenta
  // que ya se estaba viendo.
  if (!detail.data) {
    return (
      <EmptyState
        icon={<UtensilsCrossed className="h-6 w-6" />}
        title="No se pudo abrir la cuenta"
        description={errorMessage(detail.error)}
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={onBack}>
              Volver a mesas
            </Button>
            <Button variant="outline" onClick={() => detail.refetch()}>
              Reintentar
            </Button>
          </div>
        }
      />
    )
  }

  const { order, items, tickets } = detail.data
  const isOpen = order.status === 'open'
  const table = order.table_id ? (tables.find((t) => t.id === order.table_id) ?? null) : null
  const tableName = table?.name ?? null
  const title = [tableName ?? 'Para llevar', order.label].filter(Boolean).join(' · ')
  const waiterName = order.waiter_id ? (names[order.waiter_id] ?? null) : null
  const billable = items.filter(isBillable)
  const pendingCount = items.filter((i) => i.kitchen_status === 'pending').length
  const draftItems = draft.filter((l) => l.quantity > 0)
  const draftCount = draftItems.reduce((s, l) => s + l.quantity, 0)

  const priced = pricePreview(billable, priceCtx)
  const svc = service ? serviceChargeOf(priced.subtotal) : 0
  const draftTotal = pricePreview(draftItems, priceCtx).total
  const previewTotal = r2(priced.total + svc)

  // rest_checkout pasa por create_sale, que exige el módulo de ventas (pos).
  const canCharge = can('sales.create') && hasModule('pos')

  const payloadOfDraft = () =>
    draftItems.map((l) => ({ product_id: l.product_id, quantity: l.quantity, notes: l.notes.trim() || null }))

  const saveDraft = async (): Promise<boolean> => {
    if (!draftItems.length) return true
    try {
      await add.mutateAsync({ orderId, items: payloadOfDraft() })
      setDraft([])
      return true
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudieron guardar los platos'))
      return false
    }
  }

  const sendToKitchen = async () => {
    if (!(await saveDraft())) return
    let ticket: { ticket_id: string; number: string; items: number }
    try {
      ticket = await send.mutateAsync(orderId)
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo enviar a cocina'))
      return
    }
    toast.success(`Comanda ${ticket.number} enviada a cocina (${ticket.items} ${ticket.items === 1 ? 'línea' : 'líneas'})`)
    setPanelOpen(false)
    if (!printKitchen || !tenant) return
    // Imprimir nunca bloquea: la comanda ya está en la pantalla de cocina.
    try {
      const fresh = await fetchOrder(orderId)
      const sent = fresh.items.filter((i) => i.ticket_id === ticket.ticket_id)
      printKitchenTicket({
        tenant,
        order: fresh.order,
        tableName,
        ticketNumber: ticket.number,
        waiterName,
        items: sent.map((i) => ({ quantity: i.quantity, name: nameOf(priceCtx.productMap, i.product_id), notes: i.notes })),
      })
    } catch (err) {
      toast.error(`La comanda se envió, pero no se pudo imprimir: ${errorMessage(err)}`)
    }
  }

  const printBill = () => {
    if (!tenant) return
    if (!billable.length) {
      toast.info('No hay nada pendiente de cobro en esta cuenta')
      return
    }
    try {
      printPreBill({
        tenant,
        order,
        tableName,
        waiterName,
        lines: priced.lines.map((l) => ({
          quantity: l.input.quantity,
          name: nameOf(priceCtx.productMap, l.input.product_id),
          total: l.total,
        })),
        subtotal: priced.subtotal,
        tax: priced.tax_total,
        service: svc,
        total: previewTotal,
      })
    } catch (err) {
      toast.error(`No se pudo imprimir la pre-cuenta: ${errorMessage(err)}`)
    }
  }

  const openCheckout = () => {
    if (draftItems.length) {
      toast.info('Guarda o descarta los platos nuevos antes de cobrar')
      setPanelOpen(true)
      return
    }
    if (!billable.length) {
      toast.info('No hay nada pendiente de cobro en esta cuenta')
      return
    }
    setPanelOpen(false)
    setModal('checkout')
  }

  const menu: ActionItem[] = isOpen
    ? [
        { label: 'Imprimir pre-cuenta', icon: <Printer className="h-4 w-4" />, onClick: printBill },
        { label: 'Mover a otra mesa', icon: <MoveRight className="h-4 w-4" />, onClick: () => setModal('move') },
        {
          label: 'Unir con otra cuenta',
          icon: <Combine className="h-4 w-4" />,
          hint: 'Lo pendiente de esta cuenta pasa a la otra.',
          onClick: () =>
            draftItems.length
              ? toast.info('Guarda o descarta los platos nuevos antes de unir cuentas')
              : setModal('merge'),
        },
        {
          label: tableName ? 'Otra cuenta en esta mesa' : 'Otra cuenta para llevar',
          icon: <Plus className="h-4 w-4" />,
          onClick: () => onNewAccount(order.table_id, order.branch_id),
        },
        {
          label: printKitchen ? 'No imprimir comandas' : 'Imprimir comandas al enviar',
          icon: <ChefHat className="h-4 w-4" />,
          hint: 'Preferencia de este dispositivo.',
          onClick: () => setPrintKitchen(!printKitchen),
        },
        { label: 'Cancelar cuenta', icon: <Ban className="h-4 w-4" />, tone: 'danger', onClick: () => setModal('cancel') },
      ]
    : []

  const panel = (
    <AccountPanel
      order={order}
      items={items}
      ticketsCount={tickets.length}
      draft={draft}
      priceCtx={priceCtx}
      currency={currency}
      service={service}
      onServiceChange={onServiceChange}
      subtotal={priced.subtotal}
      tax={priced.tax_total}
      svc={svc}
      total={previewTotal}
      pendingCount={pendingCount}
      onPatchDraft={patchDraft}
      onRemoveDraft={removeDraft}
      onClearDraft={() => setDraft([])}
      onSaveDraft={() => void saveDraft()}
      onSend={() => void sendToKitchen()}
      onCharge={openCheckout}
      saving={add.isPending && !send.isPending}
      sending={send.isPending}
      canCharge={canCharge}
    />
  )

  return (
    <div className={cn(isOpen && 'pb-20 lg:pb-0')}>
      {/* Encabezado */}
      <div className="mb-4 flex items-start gap-2">
        <Button variant="ghost" size="icon" aria-label="Volver a mesas" onClick={onBack} className="shrink-0">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-bold text-slate-900 sm:text-2xl">{title}</h1>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-slate-500">
            <span>{order.number}</span>
            <span className="inline-flex items-center gap-1">
              <Users className="h-3.5 w-3.5" /> {order.guests}
            </span>
            {isOpen && <span>{fmtMinutes(minutesSince(order.opened_at, now))}</span>}
            {waiterName && <span className="truncate">{waiterName}</span>}
          </p>
        </div>
        {menu.length > 0 && <ActionMenu items={menu} title={`Cuenta ${order.number}`} label="Acciones de la cuenta" />}
      </div>

      {!isOpen ? (
        <ClosedAccount order={order} items={items} priceCtx={priceCtx} currency={currency} onBack={onBack} />
      ) : (
        <>
          <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start lg:gap-4">
            <Catalog priceCtx={priceCtx} currency={currency} draft={draft} onAdd={addToDraft} />
            <aside className="hidden lg:sticky lg:top-20 lg:block">
              <Card className="flex max-h-[calc(100dvh-6.5rem)] flex-col">{panel}</Card>
            </aside>
          </div>

          {/* Barra de la cuenta (móvil), fija sobre la navegación inferior */}
          <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 border-t border-slate-200 bg-white/95 px-3 py-2 backdrop-blur lg:hidden">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPanelOpen(true)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-slate-50"
              >
                <span className="relative">
                  <ReceiptText className="h-6 w-6 text-slate-600" />
                  {draftCount > 0 && (
                    <span className="absolute -right-2 -top-2 rounded-full bg-amber-500 px-1.5 text-[10px] font-bold text-white">
                      +{fmtQty(draftCount)}
                    </span>
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs text-slate-500">
                    {draftCount > 0 ? `${fmtQty(draftCount)} sin guardar · ${m(draftTotal)}` : 'Ver cuenta'}
                  </span>
                  <span className="block truncate text-lg font-bold tabular-nums text-slate-900">{m(previewTotal)}</span>
                </span>
              </button>
              {draftCount > 0 || pendingCount > 0 ? (
                <Button size="lg" onClick={() => void sendToKitchen()} loading={add.isPending || send.isPending}>
                  <ChefHat className="h-5 w-5" /> Enviar
                </Button>
              ) : (
                <Button size="lg" onClick={openCheckout} disabled={!billable.length || !canCharge}>
                  Cobrar
                </Button>
              )}
            </div>
          </div>

          <Modal open={panelOpen} onClose={() => setPanelOpen(false)} title={`Cuenta ${order.number}`} size="lg">
            <div className="-mx-5 -my-4">{panel}</div>
          </Modal>
        </>
      )}

      {modal === 'move' && (
        <MoveModal order={order} tables={tables} onClose={() => setModal(null)} />
      )}
      {modal === 'merge' && (
        <MergeModal
          order={order}
          tables={tables}
          priceCtx={priceCtx}
          currency={currency}
          onClose={() => setModal(null)}
          onMerged={(into) => {
            setModal(null)
            writeStorage(dKey, null)
            onOpenOrder(into)
          }}
        />
      )}
      {modal === 'cancel' && (
        <CancelOrderModal
          order={order}
          needsVoid={items.some((i) => i.kitchen_status !== 'pending' && i.kitchen_status !== 'canceled')}
          onClose={() => setModal(null)}
          onCanceled={() => {
            setModal(null)
            setDraft([])
            onBack()
          }}
        />
      )}
      {modal === 'checkout' && (
        <CheckoutModal
          order={order}
          items={billable}
          tableName={tableName}
          priceCtx={priceCtx}
          service={service}
          onServiceChange={onServiceChange}
          onClose={() => setModal(null)}
          onPaid={(closed) => {
            setModal(null)
            if (closed) onBack()
          }}
        />
      )}
    </div>
  )
}

const nameOf = (map: Map<string, Product>, id: string) => {
  const p = map.get(id)
  return p ? productLabel(p) : 'Producto'
}

// ── Catálogo ────────────────────────────────────────────────────────────────

function Catalog({
  priceCtx,
  currency,
  draft,
  onAdd,
}: {
  priceCtx: ReturnType<typeof usePriceContext>
  currency: string
  draft: DraftLine[]
  onAdd: (p: Product) => void
}) {
  const categories = useCategories()
  const [query, setQuery] = useState('')
  const [categoryId, setCategoryId] = useState('')

  const sellable = useMemo(() => {
    // Un producto con variantes no se pide directamente: se pide la variante.
    const parents = new Set(priceCtx.products.map((p) => p.parent_id).filter(Boolean) as string[])
    return priceCtx.products
      .filter((p) => p.is_active && !parents.has(p.id))
      .map((p) => ({ p, hay: fold([p.name, p.variant_label, p.sku, p.code].filter(Boolean).join(' ')) }))
  }, [priceCtx.products])
  const categoryChildren = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const c of categories.data ?? []) if (c.parent_id) map.set(c.parent_id, [...(map.get(c.parent_id) ?? []), c.id])
    return map
  }, [categories.data])
  const usedCategories = useMemo(() => {
    const used = new Set(sellable.map((x) => x.p.category_id).filter(Boolean) as string[])
    return (categories.data ?? []).filter(
      (c) => c.is_active && (used.has(c.id) || (categoryChildren.get(c.id) ?? []).some((id) => used.has(id))),
    )
  }, [categories.data, sellable, categoryChildren])
  const filtered = useMemo(() => {
    const q = fold(query.trim())
    const cats = categoryId ? new Set([categoryId, ...(categoryChildren.get(categoryId) ?? [])]) : null
    return sellable.filter(({ p, hay }) => (!cats || (p.category_id && cats.has(p.category_id))) && (!q || hay.includes(q)))
  }, [sellable, query, categoryId, categoryChildren])
  const inDraft = useMemo(() => {
    const map = new Map<string, number>()
    for (const l of draft) map.set(l.product_id, (map.get(l.product_id) ?? 0) + l.quantity)
    return map
  }, [draft])
  const LIMIT = 60

  return (
    <section className="min-w-0 space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar plato o bebida"
          aria-label="Buscar producto"
          className="h-12 pl-11 pr-11 text-base"
          autoFocus={finePointer()}
          autoComplete="off"
          enterKeyHint="search"
        />
        {query && (
          <button
            type="button"
            aria-label="Limpiar búsqueda"
            onClick={() => setQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      {usedCategories.length > 0 && (
        // Fila de chips con desplazamiento propio: no es un listado de datos, y
        // envolverla empujaría el menú fuera de la pantalla del teléfono.
        <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Categorías">
          <Chip active={!categoryId} onClick={() => setCategoryId('')}>
            Todo
          </Chip>
          {usedCategories.map((c) => (
            <Chip key={c.id} active={categoryId === c.id} onClick={() => setCategoryId(c.id)}>
              {c.name}
            </Chip>
          ))}
        </div>
      )}

      {priceCtx.isError ? (
        <EmptyState
          title="No se pudo cargar el menú"
          description={errorMessage(priceCtx.error)}
          action={
            <Button variant="outline" onClick={priceCtx.refetch}>
              Reintentar
            </Button>
          }
        />
      ) : sellable.length === 0 ? (
        <EmptyState
          icon={<UtensilsCrossed className="h-6 w-6" />}
          title="Aún no hay productos en el menú"
          description="Crea tus platos y bebidas en Productos para que aparezcan aquí."
          action={
            <Link to="/productos">
              <Button variant="outline">Ir a Productos</Button>
            </Link>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon={<Search className="h-6 w-6" />} title="Sin resultados" description="Prueba con otro nombre." />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {filtered.slice(0, LIMIT).map(({ p }) => {
              const q = inDraft.get(p.id) ?? 0
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onAdd(p)}
                  className={cn(
                    'relative flex min-h-[88px] flex-col justify-between rounded-xl border bg-white p-3 text-left shadow-sm transition',
                    'hover:border-brand-300 hover:shadow active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40',
                    q > 0 ? 'border-amber-400' : 'border-slate-200',
                  )}
                >
                  {q > 0 && (
                    <span className="absolute right-2 top-2 rounded-full bg-amber-500 px-2 py-0.5 text-xs font-bold text-white">
                      +{fmtQty(q)}
                    </span>
                  )}
                  <span className={cn('line-clamp-2 text-sm font-medium text-slate-800', q > 0 && 'pr-9')}>
                    {productLabel(p)}
                  </span>
                  <span className="mt-2 text-base font-bold tabular-nums text-slate-900">{money(p.price, currency)}</span>
                </button>
              )
            })}
          </div>
          {filtered.length > LIMIT && (
            <p className="text-center text-xs text-slate-500">
              Mostrando {LIMIT} de {num(filtered.length)}. Escribe para afinar la búsqueda.
            </p>
          )}
        </>
      )}
    </section>
  )
}

// ── Panel de la cuenta ──────────────────────────────────────────────────────

function AccountPanel({
  order,
  items,
  ticketsCount,
  draft,
  priceCtx,
  currency,
  service,
  onServiceChange,
  subtotal,
  tax,
  svc,
  total,
  pendingCount,
  onPatchDraft,
  onRemoveDraft,
  onClearDraft,
  onSaveDraft,
  onSend,
  onCharge,
  saving,
  sending,
  canCharge,
}: {
  order: RestaurantOrder
  items: RestaurantOrderItem[]
  ticketsCount: number
  draft: DraftLine[]
  priceCtx: PriceContext
  currency: string
  service: boolean
  onServiceChange: (v: boolean) => void
  subtotal: number
  tax: number
  svc: number
  total: number
  pendingCount: number
  onPatchDraft: (key: string, patch: Partial<DraftLine>) => void
  onRemoveDraft: (key: string) => void
  onClearDraft: () => void
  onSaveDraft: () => void
  onSend: () => void
  onCharge: () => void
  saving: boolean
  sending: boolean
  canCharge: boolean
}) {
  const m = (n: number) => money(n, currency)
  const [noteOpen, setNoteOpen] = useState<string | null>(null)
  const [editing, setEditing] = useState<RestaurantOrderItem | null>(null)
  const [voiding, setVoiding] = useState<RestaurantOrderItem | null>(null)
  const [showDone, setShowDone] = useState(false)

  const active = items.filter(isBillable)
  const billed = items.filter((i) => i.billed_sale_id && i.kitchen_status !== 'canceled')
  const canceled = items.filter((i) => i.kitchen_status === 'canceled')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-[8rem] flex-1 overflow-y-auto">
        {/* Borrador */}
        {draft.length > 0 && (
          <div className="border-b border-amber-200 bg-amber-50/60">
            <div className="flex items-center justify-between px-4 pt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">Nuevos · sin guardar</p>
              <button type="button" className="text-xs font-medium text-amber-800 underline" onClick={onClearDraft}>
                Descartar
              </button>
            </div>
            <ul className="divide-y divide-amber-100">
              {draft.map((l) => {
                const p = priceCtx.productMap.get(l.product_id)
                const lineTotal = pricePreview([l], priceCtx).total
                return (
                  <li key={l.key} className="px-4 py-2.5">
                    <div className="flex items-start gap-2">
                      <p className="min-w-0 flex-1 text-sm font-medium text-slate-800">{p ? productLabel(p) : 'Producto'}</p>
                      <p className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">{m(lineTotal)}</p>
                    </div>
                    {l.notes.trim() && noteOpen !== l.key && (
                      <p className="mt-0.5 text-xs font-medium text-amber-700">» {l.notes}</p>
                    )}
                    <div className="mt-2 flex items-center gap-2">
                      <div className="flex items-center rounded-xl border border-slate-200 bg-white">
                        <button
                          type="button"
                          aria-label="Restar uno"
                          onClick={() => (l.quantity <= 1 ? onRemoveDraft(l.key) : onPatchDraft(l.key, { quantity: r3(l.quantity - 1) }))}
                          className="flex h-10 w-10 items-center justify-center text-slate-600 hover:bg-slate-50"
                        >
                          <Minus className="h-4 w-4" />
                        </button>
                        <NumberInput
                          aria-label="Cantidad"
                          value={l.quantity}
                          decimals={3}
                          onCommit={(n) => (n > 0 ? onPatchDraft(l.key, { quantity: n }) : onRemoveDraft(l.key))}
                          className="h-10 w-14 rounded-none border-0 px-1 text-center shadow-none focus:ring-0"
                        />
                        <button
                          type="button"
                          aria-label="Sumar uno"
                          onClick={() => onPatchDraft(l.key, { quantity: r3(l.quantity + 1) })}
                          className="flex h-10 w-10 items-center justify-center text-slate-600 hover:bg-slate-50"
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="ml-auto flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Nota para cocina"
                          aria-pressed={noteOpen === l.key}
                          onClick={() => setNoteOpen(noteOpen === l.key ? null : l.key)}
                        >
                          <MessageSquareText className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" aria-label="Quitar" onClick={() => onRemoveDraft(l.key)}>
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    </div>
                    {noteOpen === l.key && (
                      <Input
                        className="mt-2"
                        placeholder="Nota para cocina: sin cebolla, término medio…"
                        value={l.notes}
                        maxLength={200}
                        autoFocus
                        onChange={(e) => onPatchDraft(l.key, { notes: e.target.value })}
                        onKeyDown={(e) => e.key === 'Enter' && setNoteOpen(null)}
                      />
                    )}
                  </li>
                )
              })}
            </ul>
            <div className="flex gap-2 px-4 pb-3 pt-1">
              <Button variant="outline" className="flex-1" onClick={onSaveDraft} loading={saving}>
                Guardar
              </Button>
              <Button className="flex-1" onClick={onSend} loading={sending}>
                <ChefHat className="h-4 w-4" /> Enviar a cocina
              </Button>
            </div>
          </div>
        )}

        {/* Líneas de la cuenta */}
        {active.length === 0 && draft.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-10 text-center text-slate-400">
            <UtensilsCrossed className="mb-2 h-8 w-8" />
            <p className="text-sm">Toca un plato del menú para empezar el pedido.</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {active.map((it) => (
              <OrderLine
                key={it.id}
                item={it}
                priceCtx={priceCtx}
                currency={currency}
                onEdit={() => setEditing(it)}
                onVoid={() => setVoiding(it)}
              />
            ))}
          </ul>
        )}

        {(billed.length > 0 || canceled.length > 0) && (
          <div className="border-t border-slate-100 px-4 py-2">
            <button
              type="button"
              className="text-xs font-medium text-slate-500 underline"
              onClick={() => setShowDone((v) => !v)}
              aria-expanded={showDone}
            >
              {showDone ? 'Ocultar' : 'Ver'} cobrado ({billed.length}) y anulado ({canceled.length})
            </button>
            {showDone && (
              <ul className="mt-2 space-y-1.5">
                {[...billed, ...canceled].map((it) => (
                  <li key={it.id} className="flex items-start gap-2 text-sm text-slate-500">
                    <span className={cn('min-w-0 flex-1', it.kitchen_status === 'canceled' && 'line-through')}>
                      {fmtQty(it.quantity)} × {nameOf(priceCtx.productMap, it.product_id)}
                      {it.cancel_reason && <span className="block text-xs no-underline">Motivo: {it.cancel_reason}</span>}
                    </span>
                    <Badge tone={it.kitchen_status === 'canceled' ? 'red' : 'green'}>
                      {it.kitchen_status === 'canceled' ? 'Anulado' : 'Cobrado'}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Totales y acciones */}
      <div className="space-y-3 border-t border-slate-100 px-4 py-3">
        <label className="flex items-center justify-between gap-3 text-sm text-slate-700">
          <span>10 % de ley</span>
          <input
            type="checkbox"
            className="h-5 w-5 accent-brand-600"
            checked={service}
            onChange={(e) => onServiceChange(e.target.checked)}
          />
        </label>
        <dl className="space-y-1 text-sm">
          <Row label="Subtotal" value={m(subtotal)} />
          <Row label="ITBIS" value={m(tax)} />
          {service && <Row label="Servicio (10 %)" value={m(svc)} />}
          <div className="flex items-baseline justify-between pt-1">
            <dt className="font-semibold text-slate-800">Total</dt>
            <dd className="text-2xl font-bold tabular-nums text-slate-900">{m(total)}</dd>
          </div>
          <p className="text-xs text-slate-400">
            Vista previa con precios del menú. {ticketsCount > 0 ? `${ticketsCount} comanda(s) enviadas.` : ''}
          </p>
        </dl>
        <div className="flex gap-2">
          {pendingCount > 0 && draft.length === 0 && (
            <Button variant="outline" size="lg" className="flex-1" onClick={onSend} loading={sending}>
              <ChefHat className="h-5 w-5" /> Enviar ({pendingCount})
            </Button>
          )}
          <Button
            size="lg"
            className="flex-1"
            onClick={onCharge}
            disabled={!active.length || !canCharge}
            title={canCharge ? undefined : 'Tu rol (o tu plan) no permite cobrar'}
          >
            Cobrar {m(total)}
          </Button>
        </div>
      </div>

      {editing && <EditLineModal item={editing} name={nameOf(priceCtx.productMap, editing.product_id)} onClose={() => setEditing(null)} />}
      {voiding && (
        <VoidLineModal
          item={voiding}
          name={nameOf(priceCtx.productMap, voiding.product_id)}
          orderNumber={order.number}
          onClose={() => setVoiding(null)}
        />
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-slate-600">
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}

function OrderLine({
  item,
  priceCtx,
  currency,
  onEdit,
  onVoid,
}: {
  item: RestaurantOrderItem
  priceCtx: PriceContext
  currency: string
  onEdit: () => void
  onVoid: () => void
}) {
  const { can } = useAuth()
  const toast = useToast()
  const remove = useCancelOrderItem()
  const setStatus = useSetKitchenStatus()
  const st = KITCHEN_STATUS[item.kitchen_status]
  const total = pricePreview([item], priceCtx).total
  const pending = item.kitchen_status === 'pending'
  const ready = item.kitchen_status === 'ready'

  const actions: ActionItem[] = pending
    ? [
        { label: 'Cambiar cantidad o nota', icon: <Pencil className="h-4 w-4" />, onClick: onEdit },
        {
          label: 'Quitar',
          icon: <Trash2 className="h-4 w-4" />,
          tone: 'danger',
          onClick: () =>
            remove.mutate({ itemId: item.id }, { onError: (err) => toast.error(errorMessage(err, 'No se pudo quitar')) }),
        },
      ]
    : [
        ...(item.kitchen_status !== 'served' && !ready
          ? [
              {
                label: 'Marcar servido',
                onClick: () =>
                  setStatus.mutate(
                    { itemId: item.id, status: 'served' },
                    { onError: (err) => toast.error(errorMessage(err)) },
                  ),
              },
            ]
          : []),
        {
          label: 'Anular plato',
          icon: <Ban className="h-4 w-4" />,
          tone: 'danger' as const,
          disabled: !can('restaurant.void'),
          hint: can('restaurant.void') ? 'Ya salió a cocina: pide un motivo.' : 'Requiere permiso para anular platos.',
          onClick: onVoid,
        },
      ]

  return (
    <li className="px-4 py-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-800">
            <span className="tabular-nums">{fmtQty(item.quantity)} ×</span> {nameOf(priceCtx.productMap, item.product_id)}
          </p>
          {item.notes && <p className="text-xs font-medium text-amber-700">» {item.notes}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={st.tone}>{st.label}</Badge>
          </div>
        </div>
        <p className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">{money(total, currency)}</p>
        <ActionMenu items={actions} title={nameOf(priceCtx.productMap, item.product_id)} />
      </div>
      {ready && (
        <Button
          size="sm"
          variant="secondary"
          className="mt-2 w-full"
          loading={setStatus.isPending}
          onClick={() =>
            setStatus.mutate({ itemId: item.id, status: 'served' }, { onError: (err) => toast.error(errorMessage(err)) })
          }
        >
          Listo en cocina · marcar servido
        </Button>
      )}
    </li>
  )
}

// ── Diálogos ────────────────────────────────────────────────────────────────

function EditLineModal({ item, name, onClose }: { item: RestaurantOrderItem; name: string; onClose: () => void }) {
  const toast = useToast()
  const update = useUpdateOrderItem()
  const [qty, setQty] = useState(item.quantity)
  const [notes, setNotes] = useState(item.notes ?? '')
  const save = () => {
    if (!(qty > 0)) {
      toast.error('Indica una cantidad mayor que cero')
      return
    }
    update.mutate(
      { itemId: item.id, quantity: qty, notes: notes.trim() || null },
      { onSuccess: onClose, onError: (err) => toast.error(errorMessage(err)) },
    )
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={name}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} loading={update.isPending}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Cantidad" htmlFor="edit-qty">
          <NumberInput id="edit-qty" value={qty} decimals={3} onCommit={setQty} />
        </Field>
        <Field label="Nota para cocina" htmlFor="edit-notes">
          <Input id="edit-notes" value={notes} maxLength={200} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

function VoidLineModal({
  item,
  name,
  orderNumber,
  onClose,
}: {
  item: RestaurantOrderItem
  name: string
  orderNumber: string
  onClose: () => void
}) {
  const toast = useToast()
  const cancel = useCancelOrderItem()
  const [reason, setReason] = useState('')
  const submit = () => {
    if (!reason.trim()) {
      toast.error('Indica el motivo de la anulación')
      return
    }
    cancel.mutate(
      { itemId: item.id, reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success('Plato anulado')
          onClose()
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    )
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Anular plato"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Volver
          </Button>
          <Button variant="danger" onClick={submit} loading={cancel.isPending}>
            Anular
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          {fmtQty(item.quantity)} × <strong>{name}</strong> de la cuenta {orderNumber}. Ya salió a cocina: la anulación
          queda registrada con su motivo.
        </p>
        <Field label="Motivo" required htmlFor="void-reason">
          <Textarea
            id="void-reason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="El cliente lo cambió, salió mal, se cayó…"
            autoFocus
          />
        </Field>
      </div>
    </Modal>
  )
}

function MoveModal({ order, tables, onClose }: { order: RestaurantOrder; tables: RestaurantTable[]; onClose: () => void }) {
  const toast = useToast()
  const move = useMoveOrder()
  const open = useOpenOrders(order.branch_id)
  const [target, setTarget] = useState<string>(order.table_id ?? '')
  const busy = useMemo(() => {
    const map = new Map<string, number>()
    for (const o of open.data ?? []) if (o.table_id && o.id !== order.id) map.set(o.table_id, (map.get(o.table_id) ?? 0) + 1)
    return map
  }, [open.data, order.id])
  const choices = tables.filter((t) => t.is_active && t.branch_id === order.branch_id)
  const submit = () =>
    move.mutate(
      { orderId: order.id, tableId: target || null },
      {
        onSuccess: () => {
          toast.success('Cuenta movida')
          onClose()
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    )
  return (
    <Modal
      open
      onClose={onClose}
      title={`Mover ${order.number}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={move.isPending} disabled={target === (order.table_id ?? '')}>
            Mover
          </Button>
        </>
      }
    >
      <Field label="Llevar la cuenta a" hint="Si la mesa ya tiene cuentas, esta se suma como una cuenta más.">
        <Select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Para llevar (sin mesa)</option>
          {choices.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {busy.get(t.id) ? ` · ${busy.get(t.id)} cuenta(s) abierta(s)` : ' · libre'}
            </option>
          ))}
        </Select>
      </Field>
    </Modal>
  )
}

function MergeModal({
  order,
  tables,
  priceCtx,
  currency,
  onClose,
  onMerged,
}: {
  order: RestaurantOrder
  tables: RestaurantTable[]
  priceCtx: PriceContext
  currency: string
  onClose: () => void
  onMerged: (intoId: string) => void
}) {
  const toast = useToast()
  const merge = useMergeOrders()
  const open = useOpenOrders(order.branch_id)
  const [target, setTarget] = useState<string | null>(null)
  const others = (open.data ?? []).filter((o) => o.id !== order.id)
  const tableName = (id: string | null) => (id ? (tables.find((t) => t.id === id)?.name ?? 'Mesa') : 'Para llevar')

  const submit = () => {
    if (!target) return
    merge.mutate(
      { fromId: order.id, intoId: target },
      {
        onSuccess: () => {
          toast.success('Cuentas unidas')
          onMerged(target)
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Unir ${order.number} con…`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={merge.isPending} disabled={!target}>
            Unir cuentas
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-600">
        Todo lo pendiente de cobro de esta cuenta pasa a la que elijas y esta se cierra.
      </p>
      {open.isLoading ? (
        <PageLoader />
      ) : others.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">No hay otras cuentas abiertas en esta sucursal.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {others.map((o) => {
            const total = pricePreview(o.items.filter(isBillable), priceCtx).total
            return (
              <li key={o.id}>
                <button
                  type="button"
                  aria-pressed={target === o.id}
                  onClick={() => setTarget(o.id)}
                  className={cn(
                    'flex w-full items-center gap-3 px-3 py-2.5 text-left',
                    target === o.id ? 'bg-brand-50' : 'hover:bg-slate-50',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-800">
                      {[tableName(o.table_id), o.label].filter(Boolean).join(' · ')}
                    </span>
                    <span className="block truncate text-xs text-slate-500">
                      {o.number} · {o.guests} pers.
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-800">{money(total, currency)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}

function CancelOrderModal({
  order,
  needsVoid,
  onClose,
  onCanceled,
}: {
  order: RestaurantOrder
  needsVoid: boolean
  onClose: () => void
  onCanceled: () => void
}) {
  const { can } = useAuth()
  const toast = useToast()
  const cancel = useCancelOrder()
  const [reason, setReason] = useState('')
  const blocked = needsVoid && !can('restaurant.void')
  const submit = () => {
    if (!reason.trim()) {
      toast.error('Indica el motivo')
      return
    }
    cancel.mutate(
      { orderId: order.id, reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success(`Cuenta ${order.number} cancelada`)
          onCanceled()
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    )
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Cancelar ${order.number}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Volver
          </Button>
          <Button variant="danger" onClick={submit} loading={cancel.isPending} disabled={blocked}>
            Cancelar cuenta
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          Se anulan todas sus líneas y la mesa queda libre. Una cuenta con cobros parciales no se puede cancelar.
        </p>
        {blocked && (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Esta cuenta tiene platos enviados a cocina: solo alguien con permiso para anular platos puede cancelarla.
          </p>
        )}
        <Field label="Motivo" required htmlFor="cancel-reason">
          <Textarea id="cancel-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </Field>
      </div>
    </Modal>
  )
}

function ClosedAccount({
  order,
  items,
  priceCtx,
  currency,
  onBack,
}: {
  order: RestaurantOrder
  items: RestaurantOrderItem[]
  priceCtx: PriceContext
  currency: string
  onBack: () => void
}) {
  const shown = items.filter((i) => i.kitchen_status !== 'canceled')
  return (
    <Card className="mx-auto max-w-lg">
      <div className="space-y-3 p-5">
        <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700">
          {ORDER_CLOSED_TEXT[order.status]}
          {order.cancel_reason ? ` ${order.cancel_reason}.` : ''}
        </p>
        {shown.length > 0 && (
          <ul className="divide-y divide-slate-100 text-sm">
            {shown.map((it) => (
              <li key={it.id} className="flex justify-between gap-2 py-1.5">
                <span className="min-w-0 truncate text-slate-700">
                  {fmtQty(it.quantity)} × {nameOf(priceCtx.productMap, it.product_id)}
                </span>
                <span className="shrink-0 tabular-nums text-slate-500">
                  {money(pricePreview([it], priceCtx).total, currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Button className="w-full" onClick={onBack}>
          Volver a mesas
        </Button>
      </div>
    </Card>
  )
}
