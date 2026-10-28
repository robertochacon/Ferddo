import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { format, parseISO } from 'date-fns'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRightLeft,
  Ban,
  Banknote,
  Car,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  FileText,
  HandCoins,
  PackageCheck,
  Pencil,
  Plus,
  Printer,
  Receipt,
  RefreshCw,
  Save,
  Trash2,
  Wallet,
} from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { PageHeader } from '@/components/PageHeader'
import { RequireAccess } from '@/components/RequireAccess'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { EmptyState, PageLoader, Spinner } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import {
  useBranches,
  useCustomerBalances,
  useCustomers,
  useProducts,
  useRegisters,
  useStockMap,
  useTaxes,
} from '@/hooks/core'
import { useOpenSessions } from '@/hooks/cash'
import { usePosFiscalSettings, usePreviewTotals, type SalePaymentPayload } from '@/hooks/pos'
import { customerPriceListId, useListPrices } from '@/hooks/priceLists'
import { useSaleDetailFetcher } from '@/hooks/sales'
import { useTeamMembers } from '@/hooks/team'
import {
  useAddWorkOrderAdvance,
  useCreateWorkOrderQuotation,
  useCustomerAssets,
  useRefundWorkOrderAdvance,
  useSaveAsset,
  useSaveWorkOrder,
  useSetWorkOrderStatus,
  useWorkOrder,
  useWorkOrderCheckout,
  type AddAdvanceInput,
  type SaveWorkOrderInput,
  type WorkOrderCheckoutResult,
  type WorkOrderDetail,
} from '@/hooks/workshop'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import { fmtDate, fmtDateShort, fmtDateTime, money } from '@/lib/format'
import { newClientUid, PAYMENT_METHOD_LABEL, QUOTATION_STATUS, WORK_ORDER_STATUS } from '@/lib/labels'
import { priceLines, type PriceLineInput, type PricedTotals } from '@/lib/pricing'
import { esc, printHtml } from '@/lib/print'
import { ECF_TYPE_LABEL, printSaleReceipt } from '@/features/pos/receipt'
import { ProductPicker } from '@/features/purchases/ProductPicker'
import { parseAmount, round2 } from '@/features/receivables/paymentShared'
import type { Tenant } from '@/types/db'
import type { Asset, Branch, Customer, Product, ProductKind, WorkOrderStatus } from '@/types/erp'
import { allowedTargets, ASSET_KIND_LABEL, assetLabel, FLOW, isOverdue } from './shared'

/*
 * Orden de trabajo: alta, edición, flujo de estados, cotización, anticipos,
 * facturación y entrega.
 *
 * Decisiones que no se ven en el código:
 *   · Las líneas NO llevan precio: wo_save solo guarda producto, cantidad y
 *     nota, y la venta (wo_checkout → create_sale) cobra el precio vigente del
 *     catálogo. Lo que se pinta aquí es vista previa con priceLines().
 *   · El total que se cobra es el de preview_totals() (la base), pedido al
 *     abrir el cobro, igual que en el POS.
 *   · client_uid del anticipo y del cobro: se generan una vez y se conservan en
 *     cada reintento hasta que la base confirma; así un "falló la red" que en
 *     realidad sí entró no cobra dos veces. La orden, además, no se puede
 *     facturar dos veces (wo_checkout bloquea si ya tiene sale_id).
 *   · Facturada, entregada o cancelada ⇒ solo lectura (wo_save lo rechaza);
 *     lo único que sigue vivo es el paso a "entregada".
 */

export function WorkOrderDetailPage() {
  const { id } = useParams<{ id: string }>()
  return (
    <RequireAccess module="workshop" perm="workshop.manage">
      {/* key: al crear, la ruta pasa de /taller/nueva a /taller/:id con el
          mismo componente; se remonta para cargar la orden tal como quedó en
          la base (número, estado) en vez de arrastrar el estado del alta. */}
      <WorkOrderScreen key={id ?? 'new'} id={id} />
    </RequireAccess>
  )
}

// ── Tipos y utilidades locales ──────────────────────────────────────────────

interface Header {
  branch_id: string
  customer_id: string
  asset_id: string
  problem: string
  diagnosis: string
  notes: string
  mileage_in: string
  technician_id: string
  /** Valor de <input type="datetime-local"> (hora local). */
  promised_at: string
}

interface Line {
  key: string
  product_id: string
  quantity: string
  notes: string
}

const EMPTY_HEADER: Header = {
  branch_id: '',
  customer_id: '',
  asset_id: '',
  problem: '',
  diagnosis: '',
  notes: '',
  mileage_in: '',
  technician_id: '',
  promised_at: '',
}

const KIND_LABEL: Record<ProductKind, string> = { product: 'Repuesto', service: 'Servicio' }

type EcfChoice = '' | '31' | '32'
type PayMethod = 'cash' | 'card' | 'transfer' | 'credit'
type AdvanceMethod = AddAdvanceInput['method']

const PAY_ICON: Record<PayMethod, ReactNode> = {
  cash: <Banknote className="h-5 w-5" />,
  card: <CreditCard className="h-5 w-5" />,
  transfer: <ArrowRightLeft className="h-5 w-5" />,
  credit: <HandCoins className="h-5 w-5" />,
}

const serialize = (h: Header, ls: Line[]) =>
  JSON.stringify({ h, l: ls.map((l) => [l.product_id, l.quantity, l.notes]) })

const qtyOf = (s: string) => {
  const n = parseAmount(s)
  return Number.isFinite(n) ? n : 0
}

/** timestamptz → valor de datetime-local, en la hora del navegador. */
const toLocalInput = (iso: string | null) => (iso ? format(parseISO(iso), "yyyy-MM-dd'T'HH:mm") : '')
/** `new Date('2026-10-28T15:00')` (sin zona) se lee como hora LOCAL: es lo que se quiere. */
const fromLocalInput = (s: string) => (s ? new Date(s).toISOString() : null)

const productLabel = (p: Product | undefined) =>
  p ? (p.variant_label ? `${p.name} ${p.variant_label}` : p.name) : 'Producto no disponible'
const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toLocaleString('es-DO', { maximumFractionDigits: 3 }))

/** La caja que el cajero usa en el POS (solo se LEE, para proponerla por defecto). */
function readPosRegister(tenantId: string): string | null {
  try {
    return localStorage.getItem(`ferddo-pos-register:${tenantId}`)
  } catch {
    return null
  }
}

// ── Pantalla ────────────────────────────────────────────────────────────────

function WorkOrderScreen({ id }: { id: string | undefined }) {
  const navigate = useNavigate()
  const toast = useToast()
  const { tenant, user, memberRole, can, hasModule } = useAuth()
  const currency = tenant?.currency ?? 'DOP'
  const m = (n: number) => money(n, currency)

  const detail = useWorkOrder(id)
  const customers = useCustomers()
  const balances = useCustomerBalances()
  const branches = useBranches()
  const products = useProducts()
  const taxes = useTaxes()
  const members = useTeamMembers()
  const registers = useRegisters()
  const save = useSaveWorkOrder()
  const setStatus = useSetWorkOrderStatus()
  const createQuote = useCreateWorkOrderQuotation()
  const fetchSale = useSaleDetailFetcher()

  const [header, setHeader] = useState<Header>(EMPTY_HEADER)
  const [lines, setLines] = useState<Line[]>([])
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [customerSearch, setCustomerSearch] = useState('')
  const [assetEditing, setAssetEditing] = useState<{ asset: Asset | null } | null>(null)
  /** Cliente recién elegido: si tiene un solo vehículo, se propone solo. */
  const [autoPickFor, setAutoPickFor] = useState<string | null>(null)
  const [modal, setModal] = useState<'advance' | 'checkout' | 'cancel' | 'deliver' | null>(null)
  const [advanceUid, setAdvanceUid] = useState<string | null>(null)
  const [checkoutUid, setCheckoutUid] = useState<string | null>(null)
  const [result, setResult] = useState<{ r: WorkOrderCheckoutResult; registerId: string } | null>(null)
  const [printing, setPrinting] = useState(false)

  const order = detail.data?.order
  const editable = !order || (!order.sale_id && order.status !== 'delivered' && order.status !== 'canceled')
  const current = serialize(header, lines)
  const dirty = !id || current !== snapshot

  const assets = useCustomerAssets(header.customer_id || null)
  const stock = useStockMap(header.branch_id || undefined)

  // Carga del formulario desde la base. No pisa lo que se está editando, salvo
  // que la orden haya dejado de ser editable (la facturaron desde otra pestaña).
  useEffect(() => {
    if (!id || !detail.data) return
    const stamp = `${id}:${detail.dataUpdatedAt}`
    if (loadedFor === stamp) return
    const o = detail.data.order
    const stillEditable = !o.sale_id && o.status !== 'delivered' && o.status !== 'canceled'
    if (loadedFor && dirty && stillEditable) return
    const h: Header = {
      branch_id: o.branch_id,
      customer_id: o.customer_id,
      asset_id: o.asset_id ?? '',
      problem: o.problem,
      diagnosis: o.diagnosis ?? '',
      notes: o.notes ?? '',
      mileage_in: o.mileage_in == null ? '' : String(o.mileage_in),
      technician_id: o.technician_id ?? '',
      promised_at: toLocalInput(o.promised_at),
    }
    const ls: Line[] = detail.data.items.map((it) => ({
      key: it.id,
      product_id: it.product_id,
      quantity: String(it.quantity),
      notes: it.notes ?? '',
    }))
    setHeader(h)
    setLines(ls)
    setSnapshot(serialize(h, ls))
    setLoadedFor(stamp)
  }, [id, detail.data, detail.dataUpdatedAt, loadedFor, dirty])

  // Sucursales donde esta persona puede abrir órdenes (cortesía: wo_save
  // vuelve a comprobar can_access_branch()).
  const me = members.data?.find((mb) => mb.user_id === user?.id)
  const unrestricted = memberRole === 'owner' || memberRole === 'admin' || !me || me.branch_ids == null
  const branchOptions = (branches.data ?? []).filter(
    (b) => (b.is_active && (unrestricted || (me?.branch_ids ?? []).includes(b.id))) || b.id === header.branch_id,
  )

  useEffect(() => {
    if (id || header.branch_id || !branches.data?.length || members.isLoading) return
    const pick = branchOptions.find((b) => b.is_main) ?? branchOptions[0]
    if (pick) setHeader((h) => ({ ...h, branch_id: pick.id }))
  }, [id, header.branch_id, branches.data, members.isLoading, branchOptions])

  useEffect(() => {
    if (!autoPickFor || autoPickFor !== header.customer_id || !assets.data) return
    const active = assets.data.filter((a) => a.is_active)
    if (active.length === 1) setHeader((h) => ({ ...h, asset_id: active[0].id }))
    setAutoPickFor(null)
  }, [autoPickFor, header.customer_id, assets.data])

  // ── Catálogo y vista previa ──
  const productById = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p])), [products.data])
  const taxRate = useMemo(() => new Map((taxes.data ?? []).map((t) => [t.id, Number(t.rate)])), [taxes.data])
  const rateOf = (p: Product | undefined) => (p?.tax_id ? (taxRate.get(p.tax_id) ?? 0) : 0)
  const sellable = useMemo(() => {
    // Igual que el POS: un producto con variantes no se vende directamente, se vende la variante.
    const parents = new Set((products.data ?? []).map((p) => p.parent_id).filter(Boolean) as string[])
    return (products.data ?? []).filter((p) => p.is_active && !parents.has(p.id))
  }, [products.data])

  // ── Cliente, vehículo, técnico ──
  const customerList = useMemo(
    // Los clientes creados sin conexión aún no existen en la base: la FK de la orden fallaría.
    () => (customers.data ?? []).filter((c) => (c.is_active && !('_pendingSync' in c)) || c.id === header.customer_id),
    [customers.data, header.customer_id],
  )
  const customerOptions = useMemo(() => {
    const s = customerSearch.trim().toLowerCase()
    const digits = customerSearch.replace(/\D/g, '')
    const filtered = s
      ? customerList.filter(
          (c) =>
            c.id === header.customer_id ||
            c.name.toLowerCase().includes(s) ||
            (digits.length >= 3 &&
              ((c.doc_number ?? '').replace(/\D/g, '').includes(digits) ||
                (c.phone ?? '').replace(/\D/g, '').includes(digits))),
        )
      : customerList
    return filtered.slice(0, 200)
  }, [customerList, customerSearch, header.customer_id])
  const customer: Customer | null = (customers.data ?? []).find((c) => c.id === header.customer_id) ?? null

  // Mismo precio base que usará create_sale(): el de la lista del cliente si
  // tiene una activa, si no el del catálogo. Sigue siendo solo vista previa.
  const listPrices = useListPrices(customerPriceListId(customer))
  const priceOf = (p: Product | undefined) => (p ? (listPrices.prices?.get(p.id) ?? Number(p.price)) : 0)
  const listName = listPrices.prices ? (listPrices.list?.name ?? null) : null
  const preview = priceLines(
    lines.map((l) => {
      const p = productById.get(l.product_id)
      return { quantity: qtyOf(l.quantity), unit_price: priceOf(p), tax_rate: rateOf(p) }
    }),
    0,
    tenant?.prices_include_tax ?? true,
  )

  const technicianOptions = (members.data ?? []).filter((mb) => mb.is_active || mb.user_id === header.technician_id)
  const memberName = (uid: string | null | undefined) => {
    if (!uid) return null
    const mb = members.data?.find((x) => x.user_id === uid)
    return mb ? (mb.full_name ?? mb.email ?? 'Sin nombre') : null
  }
  const assetOptions = (assets.data ?? []).filter((a) => a.is_active || a.id === header.asset_id)
  const selectedAsset = (assets.data ?? []).find((a) => a.id === header.asset_id) ?? null

  // ── Permisos y módulos ──
  const canAssets = can('workshop.assets')
  const canBill = hasModule('pos') && can('sales.create')
  const canAdvance = can('sales.create')
  const quotesOn = hasModule('quotations')
  const canQuote = quotesOn && can('quotations.manage')

  // ── Anticipos ──
  const advances = detail.data?.advances ?? []
  const pendingAdvance = round2(
    advances.filter((a) => !a.applied_sale_id && !a.refunded_at).reduce((s, a) => s + a.amount, 0),
  )
  const [refunding, setRefunding] = useState<{ id: string; number: string; amount: number } | null>(null)

  // ── Acciones ──
  const patchLine = (key: string, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  const addProduct = (p: Product) =>
    setLines((ls) => {
      const existing = ls.find((l) => l.product_id === p.id)
      if (existing) return ls.map((l) => (l === existing ? { ...l, quantity: String(qtyOf(l.quantity) + 1) } : l))
      return [...ls, { key: crypto.randomUUID(), product_id: p.id, quantity: '1', notes: '' }]
    })

  const chooseCustomer = (cid: string) => {
    setHeader((h) => ({ ...h, customer_id: cid, asset_id: '' }))
    setAutoPickFor(cid || null)
  }

  const validate = (): string | null => {
    if (!header.branch_id) return 'Elige la sucursal'
    if (!header.customer_id) return 'Elige el cliente'
    if (!header.problem.trim()) return 'Describe el problema que reporta el cliente'
    if (header.mileage_in.trim()) {
      const n = Number(header.mileage_in.replace(/,/g, ''))
      if (!Number.isInteger(n) || n < 0) return 'El kilometraje debe ser un número entero'
    }
    if (header.promised_at && Number.isNaN(new Date(header.promised_at).getTime())) return 'Fecha prometida inválida'
    for (const l of lines) {
      const q = parseAmount(l.quantity)
      if (!Number.isFinite(q) || q <= 0) return `Cantidad inválida en "${productLabel(productById.get(l.product_id))}"`
    }
    return null
  }

  const submit = async () => {
    const err = validate()
    setFormError(err)
    if (err) return
    const payload: SaveWorkOrderInput = {
      id,
      branch_id: header.branch_id,
      customer_id: header.customer_id,
      asset_id: header.asset_id || null,
      problem: header.problem.trim(),
      diagnosis: header.diagnosis.trim() || null,
      notes: header.notes.trim() || null,
      mileage_in: header.mileage_in.trim() ? Number(header.mileage_in.replace(/,/g, '')) : null,
      technician_id: header.technician_id || null,
      promised_at: fromLocalInput(header.promised_at),
      items: lines.map((l) => ({ product_id: l.product_id, quantity: qtyOf(l.quantity), notes: l.notes.trim() || null })),
    }
    try {
      const savedId = await save.mutateAsync(payload)
      setSnapshot(current)
      toast.success(id ? 'Orden guardada' : 'Orden creada')
      if (!id) navigate(`/taller/${savedId}`, { replace: true })
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  const changeStatus = async (s: WorkOrderStatus, reason?: string): Promise<boolean> => {
    if (!order) return false
    try {
      await setStatus.mutateAsync({ id: order.id, status: s, reason: reason ?? null })
      toast.success(`Orden ${order.number}: ${WORK_ORDER_STATUS[s].label.toLowerCase()}`)
      return true
    } catch (err) {
      toast.error(errorMessage(err))
      return false
    }
  }

  const generateQuote = async () => {
    if (!order) return
    try {
      await createQuote.mutateAsync(order.id)
      toast.success(order.quotation_id ? 'Cotización actualizada con las líneas de la orden' : 'Cotización generada')
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  const openAdvance = () => {
    if (!advanceUid) setAdvanceUid(newClientUid())
    setModal('advance')
  }
  const openCheckout = () => {
    if (!checkoutUid) setCheckoutUid(newClientUid())
    setModal('checkout')
  }

  const printOrder = () => {
    if (!tenant || !detail.data) return
    printHtml(
      workOrderHtml({
        tenant,
        d: detail.data,
        branch: branches.data?.find((b) => b.id === detail.data!.order.branch_id) ?? null,
        technician: memberName(detail.data.order.technician_id),
        productById,
        preview,
        pendingAdvance,
        currency,
      }),
      'letter',
      `Orden de trabajo ${detail.data.order.number}`,
    )
  }

  const printReceipt = async () => {
    if (!result || !tenant) return
    setPrinting(true)
    try {
      const sd = await fetchSale(result.r.sale_id)
      printSaleReceipt({
        tenant,
        detail: sd,
        register: registers.data?.find((r) => r.id === result.registerId) ?? null,
        branch: branches.data?.find((b) => b.id === sd.sale.branch_id) ?? null,
        cashierName: memberName(sd.sale.created_by),
        sellerName: memberName(sd.sale.seller_id),
      })
    } catch (err) {
      toast.error(`La venta está guardada, pero no se pudo imprimir: ${errorMessage(err)}`)
    } finally {
      setPrinting(false)
    }
  }

  // ── Estados de carga ──
  if (id && detail.isLoading) return <PageLoader label="Cargando orden de trabajo…" />
  if (id && (detail.isError || !detail.data)) {
    return (
      <EmptyState
        icon={<AlertTriangle className="h-6 w-6" />}
        title={detail.isError ? 'No se pudo cargar la orden' : 'Orden no encontrada'}
        description={detail.isError ? errorMessage(detail.error) : undefined}
        action={<Button onClick={() => navigate('/taller')}>Volver a órdenes</Button>}
      />
    )
  }

  const d = detail.data ?? null
  const saved = Boolean(order) && !dirty
  const needSave = dirty ? 'Guarda los cambios primero' : undefined
  const late = order ? isOverdue(order) : false
  const billable = Boolean(order && !order.sale_id && order.status !== 'canceled')
  const deliverable = Boolean(order && order.status !== 'delivered' && order.status !== 'canceled')
  // Mismas condiciones que wo_add_advance(): una orden entregada ya no recibe anticipos.
  const advanceable = billable && order?.status !== 'delivered' && canAdvance

  return (
    <div className="pb-6">
      <Link to="/taller" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-4 w-4" /> Órdenes de trabajo
      </Link>
      <PageHeader
        title={order ? `Orden ${order.number}` : 'Nueva orden de trabajo'}
        description={
          order
            ? `Recibida el ${fmtDate(order.received_at)}${order.promised_at ? ` · prometida para ${fmtDateTime(order.promised_at)}` : ''}`
            : 'Registra lo que entra al taller. Los importes son estimados: se cobran los precios vigentes al facturar.'
        }
        action={
          order && (
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge tone={WORK_ORDER_STATUS[order.status].tone}>{WORK_ORDER_STATUS[order.status].label}</Badge>
              {late && <Badge tone="red">Atrasada</Badge>}
              {order.sale_id && <Badge tone="green">Facturada</Badge>}
            </span>
          )
        }
      />

      {order?.sale_id && (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Orden facturada{d?.sale ? ` en la venta ${d.sale.number} por ${m(d.sale.total)}` : ''}. Ya no se puede editar.{' '}
          <Link to={`/ventas/${order.sale_id}`} className="font-semibold underline">
            Ver la venta
          </Link>
        </div>
      )}
      {order?.status === 'canceled' && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          Orden cancelada{order.cancel_reason ? `: ${order.cancel_reason}` : '.'}
        </div>
      )}
      {order?.status === 'delivered' && (
        <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          Entregada al cliente el {fmtDateTime(order.delivered_at)}.
          {!order.sale_id && ' Aún está pendiente de facturar.'}
        </div>
      )}

      {order && (
        <div className="mb-4 flex flex-wrap gap-2">
          <Button variant="outline" onClick={printOrder} disabled={!saved} title={needSave}>
            <Printer className="h-4 w-4" /> Imprimir orden
          </Button>
          {d?.quotation ? (
            <>
              <Link to={`/cotizaciones/${d.quotation.id}`}>
                <Button variant="outline">
                  <FileText className="h-4 w-4" /> Cotización {d.quotation.number}
                  <span className="text-xs font-normal text-slate-500">· {QUOTATION_STATUS[d.quotation.status].label}</span>
                </Button>
              </Link>
              {editable && canQuote && (
                <Button variant="ghost" onClick={() => void generateQuote()} loading={createQuote.isPending} disabled={dirty} title={needSave}>
                  <RefreshCw className="h-4 w-4" /> Actualizar cotización
                </Button>
              )}
            </>
          ) : (
            editable && (
              <Button
                variant="outline"
                onClick={() => void generateQuote()}
                loading={createQuote.isPending}
                disabled={!canQuote || dirty || lines.length === 0}
                title={
                  !quotesOn
                    ? 'Activa el módulo de cotizaciones para usar esta opción'
                    : !canQuote
                      ? 'Tu rol no puede crear cotizaciones'
                      : (needSave ?? (lines.length === 0 ? 'Agrega servicios o repuestos primero' : undefined))
                }
              >
                <FileText className="h-4 w-4" /> Generar cotización
              </Button>
            )
          )}
          {advanceable && (
            <Button variant="outline" onClick={openAdvance}>
              <Wallet className="h-4 w-4" /> Registrar anticipo
            </Button>
          )}
          {billable && canBill && (
            <Button
              onClick={openCheckout}
              disabled={dirty || lines.length === 0}
              title={needSave ?? (lines.length === 0 ? 'La orden no tiene servicios ni repuestos' : undefined)}
            >
              <Receipt className="h-4 w-4" /> Facturar
            </Button>
          )}
          {deliverable && (order.status === 'done' || order.sale_id) && (
            <Button variant={order.sale_id ? 'primary' : 'secondary'} onClick={() => setModal('deliver')}>
              <PackageCheck className="h-4 w-4" /> Entregar
            </Button>
          )}
        </div>
      )}
      {order && !quotesOn && editable && (
        <p className="-mt-2 mb-4 text-xs text-slate-400">La cotización necesita el módulo de Cotizaciones activo.</p>
      )}

      <div className="space-y-4">
        {order && (
          <StatusCard
            status={order.status}
            busy={setStatus.isPending}
            cancelBlock={
              order.sale_id
                ? 'La orden ya se facturó: registra una devolución en su lugar.'
                : pendingAdvance > 0
                  ? 'Tiene anticipos sin aplicar: factúrala o devuélvelos antes de cancelar.'
                  : null
            }
            onChange={(s) => void changeStatus(s)}
            onDeliver={() => setModal('deliver')}
            onCancel={() => setModal('cancel')}
          />
        )}

        <Card>
          <CardHeader title="Cliente y vehículo" />
          <CardBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Cliente"
                required
                hint={
                  editable ? (
                    <span>
                      ¿No está?{' '}
                      <Link to="/clientes" target="_blank" rel="noopener" className="font-medium text-brand-700 underline">
                        Créalo en Clientes <ExternalLink className="inline h-3 w-3" />
                      </Link>{' '}
                      y{' '}
                      <button type="button" className="font-medium text-brand-700 underline" onClick={() => void customers.refetch()}>
                        actualiza la lista
                      </button>
                      .
                    </span>
                  ) : undefined
                }
              >
                {editable && customerList.length > 20 && (
                  <Input
                    value={customerSearch}
                    onChange={(e) => setCustomerSearch(e.target.value)}
                    placeholder="Filtrar por nombre, documento o teléfono…"
                    className="mb-2"
                    aria-label="Filtrar clientes"
                  />
                )}
                <Select value={header.customer_id} disabled={!editable} onChange={(e) => chooseCustomer(e.target.value)}>
                  <option value="">{customers.isLoading ? 'Cargando clientes…' : 'Selecciona…'}</option>
                  {customerOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.doc_number ? ` · ${c.doc_number}` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Sucursal" required>
                <Select
                  value={header.branch_id}
                  disabled={!editable}
                  onChange={(e) => setHeader((h) => ({ ...h, branch_id: e.target.value }))}
                >
                  <option value="">Selecciona…</option>
                  {branchOptions.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
              <Field
                label="Vehículo o equipo"
                hint={
                  !header.customer_id
                    ? 'Elige primero el cliente.'
                    : assets.isError
                      ? errorMessage(assets.error)
                      : !assets.isLoading && assetOptions.length === 0
                        ? 'Este cliente no tiene vehículos ni equipos registrados.'
                        : undefined
                }
              >
                <Select
                  value={header.asset_id}
                  disabled={!editable || !header.customer_id}
                  onChange={(e) => setHeader((h) => ({ ...h, asset_id: e.target.value }))}
                >
                  <option value="">{assets.isLoading ? 'Cargando…' : 'Sin vehículo/equipo'}</option>
                  {assetOptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {assetLabel(a)}
                    </option>
                  ))}
                </Select>
              </Field>
              {editable && canAssets && (
                <div className="flex flex-wrap gap-2">
                  {selectedAsset && (
                    <Button variant="outline" onClick={() => setAssetEditing({ asset: selectedAsset })}>
                      <Pencil className="h-4 w-4" /> Editar
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    onClick={() => setAssetEditing({ asset: null })}
                    disabled={!header.customer_id}
                    title={header.customer_id ? undefined : 'Elige primero el cliente'}
                  >
                    <Plus className="h-4 w-4" /> Nuevo vehículo/equipo
                  </Button>
                </div>
              )}
            </div>
            {editable && !canAssets && (
              <p className="text-xs text-slate-400">Tu rol no puede registrar vehículos ni equipos (permiso «Registrar vehículos y equipos»).</p>
            )}
            {selectedAsset && (selectedAsset.color || selectedAsset.serial || selectedAsset.notes) && (
              <p className="text-sm text-slate-500">
                {[
                  ASSET_KIND_LABEL[selectedAsset.kind],
                  selectedAsset.color && `Color ${selectedAsset.color}`,
                  selectedAsset.serial && `Serie ${selectedAsset.serial}`,
                  selectedAsset.notes,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
            {!selectedAsset && order && d?.asset && (
              <p className="text-sm text-slate-500">{assetLabel(d.asset)}</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Trabajo" />
          <CardBody className="space-y-4">
            <Field label="Problema reportado" required>
              <Textarea
                rows={3}
                value={header.problem}
                disabled={!editable}
                placeholder="Lo que dice el cliente: ruido al frenar, no enciende…"
                onChange={(e) => setHeader((h) => ({ ...h, problem: e.target.value }))}
              />
            </Field>
            <Field label="Diagnóstico">
              <Textarea
                rows={3}
                value={header.diagnosis}
                disabled={!editable}
                placeholder="Lo que encontró el técnico"
                onChange={(e) => setHeader((h) => ({ ...h, diagnosis: e.target.value }))}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Técnico">
                <Select
                  value={header.technician_id}
                  disabled={!editable}
                  onChange={(e) => setHeader((h) => ({ ...h, technician_id: e.target.value }))}
                >
                  <option value="">Sin asignar</option>
                  {technicianOptions.map((mb) => (
                    <option key={mb.user_id} value={mb.user_id}>
                      {mb.full_name ?? mb.email ?? 'Sin nombre'}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Prometida para" error={late ? 'Pasada la fecha prometida' : undefined}>
                <Input
                  type="datetime-local"
                  value={header.promised_at}
                  disabled={!editable}
                  onChange={(e) => setHeader((h) => ({ ...h, promised_at: e.target.value }))}
                />
              </Field>
              <Field label="Kilometraje de entrada">
                <Input
                  inputMode="numeric"
                  value={header.mileage_in}
                  disabled={!editable}
                  placeholder="Opcional"
                  onChange={(e) => setHeader((h) => ({ ...h, mileage_in: e.target.value }))}
                />
              </Field>
            </div>
            <Field label="Notas internas">
              <Textarea
                rows={2}
                value={header.notes}
                disabled={!editable}
                placeholder="Accesorios que deja, estado de la carrocería, llaves…"
                onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))}
              />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Servicios y repuestos"
            subtitle="Los repuestos salen del inventario al facturar, no antes."
            action={
              editable && (
                <Button size="sm" onClick={() => setPickerOpen(true)} disabled={products.isLoading}>
                  <Plus className="h-4 w-4" /> Agregar
                </Button>
              )
            }
          />
          {lines.length === 0 ? (
            <p className="p-5 text-sm text-slate-500">
              {editable ? 'Agrega la mano de obra y los repuestos que lleva el trabajo.' : 'La orden no tiene líneas.'}
            </p>
          ) : editable ? (
            <ul className="divide-y divide-slate-100">
              {lines.map((l, i) => {
                const p = productById.get(l.product_id)
                const priced = preview.lines[i]
                const available = p && p.kind === 'product' && p.track_stock ? (stock.data?.[p.id] ?? 0) : null
                const short = available != null && qtyOf(l.quantity) > available
                return (
                  <li key={l.key} className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-slate-800">{productLabel(p)}</p>
                        <p className="text-xs text-slate-500">
                          {p ? `${KIND_LABEL[p.kind]} · ${m(priceOf(p))} c/u` : 'Ya no está en el catálogo'}
                          {p && listPrices.prices?.has(p.id) && listName ? ` (lista ${listName})` : ''}
                          {available != null && (
                            <span className={cn(short && 'font-medium text-amber-700')}> · Existencia {fmtQty(available)}</span>
                          )}
                        </p>
                      </div>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Quitar línea"
                        onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <Field label="Cantidad">
                        <Input inputMode="decimal" value={l.quantity} onChange={(e) => patchLine(l.key, { quantity: e.target.value })} />
                      </Field>
                      <Field label="Nota" className="col-span-2">
                        <Input
                          value={l.notes}
                          placeholder="Opcional"
                          onChange={(e) => patchLine(l.key, { notes: e.target.value })}
                        />
                      </Field>
                    </div>
                    {priced && (
                      <p className="text-right text-sm text-slate-500">
                        ITBIS {m(priced.tax_amount)} · <b className="text-slate-800">{m(priced.total)}</b>
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          ) : (
            <ReadOnlyLines
              lines={lines}
              productById={productById}
              preview={preview}
              showAmounts={!order?.sale_id}
              currency={currency}
            />
          )}
        </Card>

        <RefundAdvanceModal advance={refunding} onClose={() => setRefunding(null)} />
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="Anticipos"
              subtitle={order ? 'Dinero recibido antes de terminar; se descuenta al facturar.' : 'Guarda la orden para recibir anticipos.'}
              action={
                advanceable && (
                  <Button size="sm" variant="outline" onClick={openAdvance}>
                    <Plus className="h-4 w-4" /> Registrar
                  </Button>
                )
              }
            />
            {advances.length === 0 ? (
              <p className="p-5 text-sm text-slate-500">Sin anticipos.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {advances.map((a) => (
                  <li key={a.id} className="flex items-start justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-800">
                        {a.number} · {PAYMENT_METHOD_LABEL[a.method]}
                      </p>
                      <p className="truncate text-xs text-slate-500">
                        {fmtDateTime(a.created_at)}
                        {a.reference ? ` · Ref. ${a.reference}` : ''}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold tabular-nums text-slate-800">{m(a.amount)}</p>
                      {a.applied_sale_id ? (
                        <Badge tone="green">Aplicado</Badge>
                      ) : a.refunded_at ? (
                        <Badge tone="slate">Devuelto</Badge>
                      ) : (
                        <Badge tone="amber">Por aplicar</Badge>
                      )}
                      {!a.applied_sale_id && !a.refunded_at && can('cash.move') && (
                        <button
                          type="button"
                          onClick={() => setRefunding({ id: a.id, number: a.number, amount: a.amount })}
                          className="mt-1 block text-xs font-medium text-red-600 hover:underline"
                        >
                          Devolver
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardBody className="space-y-3">
              {order?.sale_id ? (
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between text-base font-bold">
                    <dt>Total facturado</dt>
                    <dd className="tabular-nums">{d?.sale ? m(d.sale.total) : '—'}</dd>
                  </div>
                  <p className="pt-1 text-xs text-slate-400">
                    Importe definitivo de la venta.{' '}
                    <Link to={`/ventas/${order.sale_id}`} className="font-medium text-brand-700 underline">
                      Ver detalle
                    </Link>
                  </p>
                </dl>
              ) : (
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-slate-500">Subtotal</dt>
                    <dd className="tabular-nums">{m(preview.subtotal)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-500">ITBIS</dt>
                    <dd className="tabular-nums">{m(preview.tax_total)}</dd>
                  </div>
                  <div className="flex justify-between border-t border-slate-100 pt-2 text-base font-bold">
                    <dt>Total estimado</dt>
                    <dd className="tabular-nums">{m(preview.total)}</dd>
                  </div>
                  {pendingAdvance > 0 && (
                    <>
                      <div className="flex justify-between">
                        <dt className="text-slate-500">Anticipos</dt>
                        <dd className="tabular-nums">−{m(pendingAdvance)}</dd>
                      </div>
                      <div className="flex justify-between font-semibold">
                        <dt>Pendiente por cobrar</dt>
                        <dd className="tabular-nums">{m(Math.max(0, round2(preview.total - pendingAdvance)))}</dd>
                      </div>
                    </>
                  )}
                  <p className="pt-1 text-right text-xs text-slate-400">
                    Vista previa con precios vigentes del catálogo: el sistema calcula el importe final al facturar.
                  </p>
                </dl>
              )}
            </CardBody>
          </Card>
        </div>

        {formError && <p className="text-sm font-medium text-red-600">{formError}</p>}

        {editable && (
          <div className="flex justify-end">
            <Button onClick={() => void submit()} loading={save.isPending} disabled={!dirty} className="w-full sm:w-auto">
              <Save className="h-4 w-4" /> {order ? 'Guardar cambios' : 'Crear orden'}
            </Button>
          </div>
        )}
      </div>

      <ProductPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        products={sellable}
        onPick={addProduct}
        show="price"
        currency={currency}
      />

      {assetEditing && header.customer_id && (
        <AssetFormModal
          customerId={header.customer_id}
          asset={assetEditing.asset}
          onClose={() => setAssetEditing(null)}
          onSaved={(a) => {
            setHeader((h) => ({ ...h, asset_id: a.id }))
            setAssetEditing(null)
          }}
        />
      )}

      {modal === 'cancel' && order && (
        <CancelModal
          number={order.number}
          busy={setStatus.isPending}
          onClose={() => setModal(null)}
          onConfirm={async (reason) => {
            if (await changeStatus('canceled', reason)) setModal(null)
          }}
        />
      )}

      {modal === 'deliver' && order && (
        <Modal
          open
          onClose={() => setModal(null)}
          title={`Entregar ${order.number}`}
          size="sm"
          footer={
            <>
              <Button variant="outline" onClick={() => setModal(null)} disabled={setStatus.isPending}>
                Volver
              </Button>
              <Button
                loading={setStatus.isPending}
                onClick={async () => {
                  if (await changeStatus('delivered')) setModal(null)
                }}
              >
                <PackageCheck className="h-4 w-4" /> Confirmar entrega
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm text-slate-600">
            <p>La orden pasa a «Entregada» y se cierra: ya no se podrá editar ni cancelar.</p>
            {!order.sale_id && (
              <p className="rounded-xl bg-amber-50 px-3 py-2 font-medium text-amber-800">
                Aún no está facturada.{canBill ? ' Si el cliente paga hoy, factúrala antes de entregar.' : ''}
                {pendingAdvance > 0 ? ` Tiene ${m(pendingAdvance)} en anticipos por aplicar.` : ''}
              </p>
            )}
          </div>
        </Modal>
      )}

      {modal === 'advance' && order && advanceUid && (
        <AdvanceModal
          orderId={order.id}
          number={order.number}
          branchId={order.branch_id}
          clientUid={advanceUid}
          currency={currency}
          onClose={() => setModal(null)}
          onDone={() => {
            setAdvanceUid(null)
            setModal(null)
          }}
        />
      )}

      {modal === 'checkout' && d && checkoutUid && (
        <CheckoutModal
          detail={d}
          customer={customer}
          balance={customer ? (balances.data?.[customer.id]?.balance ?? 0) : 0}
          advance={pendingAdvance}
          clientUid={checkoutUid}
          currency={currency}
          onClose={() => setModal(null)}
          onDone={(r, registerId) => {
            setCheckoutUid(null)
            setModal(null)
            setResult({ r, registerId })
          }}
        />
      )}

      {result && (
        <Modal
          open
          onClose={() => setResult(null)}
          title="Orden facturada"
          footer={
            <>
              <Link to={`/ventas/${result.r.sale_id}`}>
                <Button variant="outline">Ver venta</Button>
              </Link>
              <Button variant="outline" onClick={() => void printReceipt()} loading={printing}>
                <Printer className="h-4 w-4" /> Imprimir ticket
              </Button>
              <Button onClick={() => setResult(null)}>Listo</Button>
            </>
          }
        >
          <CheckoutSuccess result={result.r} currency={currency} />
        </Modal>
      )}
    </div>
  )
}

// ── Estado ──────────────────────────────────────────────────────────────────

type StepState = 'past' | 'current' | 'next' | 'locked'

const STEP_CLS: Record<StepState, string> = {
  past: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  current: 'border-brand-600 bg-brand-600 text-white shadow-sm',
  next: 'border-slate-200 bg-white text-slate-700 hover:border-brand-300 hover:bg-brand-50',
  locked: 'cursor-not-allowed border-slate-100 bg-slate-50 text-slate-400',
}

/**
 * Pasos del flujo como botones. En rejilla y no en una fila: siete pasos en
 * línea obligarían a desplazar de lado en un teléfono.
 */
function StatusCard({
  status,
  busy,
  cancelBlock,
  onChange,
  onDeliver,
  onCancel,
}: {
  status: WorkOrderStatus
  busy: boolean
  /** Motivo por el que no se puede cancelar (null = se puede). */
  cancelBlock: string | null
  onChange: (s: WorkOrderStatus) => void
  onDeliver: () => void
  onCancel: () => void
}) {
  const closed = status === 'delivered' || status === 'canceled'
  const currentIdx = FLOW.indexOf(status)
  const targets = allowedTargets(status)
  return (
    <Card>
      <CardHeader
        title="Estado"
        subtitle={closed ? 'La orden está cerrada.' : 'Toca un paso para mover la orden. Se pueden saltar pasos hacia adelante.'}
        action={busy ? <Spinner size="sm" /> : undefined}
      />
      <CardBody className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {FLOW.map((s, i) => {
            const state: StepState =
              s === status ? 'current' : targets.includes(s) ? 'next' : i < currentIdx ? 'past' : 'locked'
            const clickable = state === 'next' && !busy
            return (
              <button
                key={s}
                type="button"
                disabled={!clickable}
                onClick={() => (s === 'delivered' ? onDeliver() : onChange(s))}
                className={cn('h-11 truncate rounded-xl border px-2 text-sm font-medium transition-colors', STEP_CLS[state])}
                aria-current={state === 'current' ? 'step' : undefined}
              >
                {i + 1}. {WORK_ORDER_STATUS[s].label}
              </button>
            )
          })}
        </div>
        {status === 'canceled' && <Badge tone="red">Cancelada</Badge>}
        {!closed && (
          <div className="flex flex-col gap-2 border-t border-slate-100 pt-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-slate-400">{cancelBlock ?? 'Cancelar exige indicar el motivo.'}</p>
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy || Boolean(cancelBlock)} className="text-red-600">
              <Ban className="h-4 w-4" /> Cancelar orden
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function CancelModal({
  number,
  busy,
  onClose,
  onConfirm,
}: {
  number: string
  busy: boolean
  onClose: () => void
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  return (
    <Modal
      open
      onClose={onClose}
      title={`Cancelar ${number}`}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Volver
          </Button>
          <Button variant="danger" loading={busy} disabled={!reason.trim()} onClick={() => onConfirm(reason.trim())}>
            Cancelar orden
          </Button>
        </>
      }
    >
      <Field label="Motivo" required hint="Queda en el historial de la orden.">
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="El cliente no aprobó la cotización…" />
      </Field>
    </Modal>
  )
}

// ── Líneas en solo lectura ──────────────────────────────────────────────────

function ReadOnlyLines({
  lines,
  productById,
  preview,
  showAmounts,
  currency,
}: {
  lines: Line[]
  productById: Map<string, Product>
  preview: PricedTotals<PriceLineInput>
  /** Facturada ⇒ el importe que vale es el de la venta, no el estimado. */
  showAmounts: boolean
  currency: string
}) {
  const m = (n: number) => money(n, currency)
  return (
    <>
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3 font-medium">Descripción</th>
              <th className="px-4 py-3 font-medium">Tipo</th>
              <th className="px-4 py-3 text-right font-medium">Cantidad</th>
              {showAmounts && <th className="px-4 py-3 text-right font-medium">Total estimado</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lines.map((l, i) => {
              const p = productById.get(l.product_id)
              return (
                <tr key={l.key}>
                  <td className="px-4 py-3">
                    <p className="text-slate-800">{productLabel(p)}</p>
                    {l.notes && <p className="text-xs text-slate-500">{l.notes}</p>}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{p ? KIND_LABEL[p.kind] : '—'}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtQty(qtyOf(l.quantity))}</td>
                  {showAmounts && (
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">{m(preview.lines[i]?.total ?? 0)}</td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <DataList>
        {lines.map((l, i) => {
          const p = productById.get(l.product_id)
          return (
            <DataRow key={l.key} title={productLabel(p)} titleExtra={l.notes || undefined}>
              <DataFields cols={showAmounts ? 3 : 2}>
                <DataField label="Tipo">{p ? KIND_LABEL[p.kind] : '—'}</DataField>
                <DataField label="Cantidad">{fmtQty(qtyOf(l.quantity))}</DataField>
                {showAmounts && <DataField label="Estimado">{m(preview.lines[i]?.total ?? 0)}</DataField>}
              </DataFields>
            </DataRow>
          )
        })}
      </DataList>
    </>
  )
}

// ── Vehículo / equipo ───────────────────────────────────────────────────────

function AssetFormModal({
  customerId,
  asset,
  onClose,
  onSaved,
}: {
  customerId: string
  asset: Asset | null
  onClose: () => void
  onSaved: (a: Asset) => void
}) {
  const toast = useToast()
  const saveAsset = useSaveAsset()
  const [kind, setKind] = useState<Asset['kind']>(asset?.kind ?? 'vehicle')
  const [f, setF] = useState({
    brand: asset?.brand ?? '',
    model: asset?.model ?? '',
    year: asset?.year == null ? '' : String(asset.year),
    plate: asset?.plate ?? '',
    serial: asset?.serial ?? '',
    color: asset?.color ?? '',
    notes: asset?.notes ?? '',
  })
  const [error, setError] = useState<string | null>(null)
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    const year = f.year.trim() ? Number(f.year) : null
    if (year != null && (!Number.isInteger(year) || year < 1900 || year > 2100)) {
      setError('El año debe estar entre 1900 y 2100')
      return
    }
    if (!f.brand.trim() && !f.model.trim() && !f.plate.trim() && !f.serial.trim()) {
      setError('Indica al menos la marca, el modelo, la placa o el número de serie')
      return
    }
    setError(null)
    try {
      const a = await saveAsset.mutateAsync({
        id: asset?.id,
        customer_id: customerId,
        kind,
        brand: f.brand.trim() || null,
        model: f.model.trim() || null,
        year,
        // Placa en mayúsculas: así se escribe y así se busca; la base la
        // compara sin distinguir mayúsculas de todas formas.
        plate: f.plate.trim().toUpperCase() || null,
        serial: f.serial.trim() || null,
        color: f.color.trim() || null,
        notes: f.notes.trim() || null,
      })
      toast.success(asset ? 'Datos actualizados' : `${ASSET_KIND_LABEL[kind]} registrado`)
      onSaved(a)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={asset ? 'Editar vehículo/equipo' : 'Nuevo vehículo/equipo'}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saveAsset.isPending}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} loading={saveAsset.isPending}>
            <Car className="h-4 w-4" /> Guardar
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Segmented<Asset['kind']>
          value={kind}
          onChange={setKind}
          label="Tipo"
          options={[
            { value: 'vehicle', label: 'Vehículo' },
            { value: 'equipment', label: 'Equipo' },
          ]}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Marca">
            <Input value={f.brand} onChange={(e) => set('brand', e.target.value)} placeholder={kind === 'vehicle' ? 'Toyota' : 'Samsung'} />
          </Field>
          <Field label="Modelo">
            <Input value={f.model} onChange={(e) => set('model', e.target.value)} placeholder={kind === 'vehicle' ? 'Corolla' : 'Split 12 000 BTU'} />
          </Field>
          <Field label="Año">
            <Input inputMode="numeric" value={f.year} onChange={(e) => set('year', e.target.value)} placeholder="2018" />
          </Field>
          <Field label="Color">
            <Input value={f.color} onChange={(e) => set('color', e.target.value)} />
          </Field>
          <Field label="Placa" hint={kind === 'vehicle' ? 'Única por empresa.' : undefined}>
            <Input value={f.plate} onChange={(e) => set('plate', e.target.value)} placeholder="A123456" className="uppercase" />
          </Field>
          <Field label={kind === 'vehicle' ? 'Chasis / VIN' : 'Número de serie'}>
            <Input value={f.serial} onChange={(e) => set('serial', e.target.value)} />
          </Field>
        </div>
        <Field label="Notas">
          <Textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>
        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</p>}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  )
}

// ── Caja abierta (anticipo y cobro) ─────────────────────────────────────────

/**
 * Selector de caja con turno abierto. Solo se ofrecen esas porque la base
 * (open_session_for) rechaza cualquier otra; y solo las de sucursales a las
 * que la persona tiene acceso. Las de la sucursal de la orden van primero.
 */
function OpenRegisterField({
  value,
  onChange,
  preferBranchId,
}: {
  value: string
  onChange: (id: string) => void
  preferBranchId: string
}) {
  const { tenant, user, memberRole } = useAuth()
  const sessions = useOpenSessions()
  const registers = useRegisters()
  const branches = useBranches()
  const members = useTeamMembers()

  const options = useMemo(() => {
    const me = members.data?.find((mb) => mb.user_id === user?.id)
    const unrestricted = memberRole === 'owner' || memberRole === 'admin' || !me || me.branch_ids == null
    const regById = new Map((registers.data ?? []).map((r) => [r.id, r]))
    const branchName = new Map((branches.data ?? []).map((b) => [b.id, b.name]))
    const multiBranch = (branches.data ?? []).length > 1
    return (sessions.data ?? [])
      .filter((s) => regById.get(s.register_id)?.is_active && (unrestricted || (me?.branch_ids ?? []).includes(s.branch_id)))
      .sort((a, b) => Number(b.branch_id === preferBranchId) - Number(a.branch_id === preferBranchId))
      .map((s) => ({
        id: s.register_id,
        branchId: s.branch_id,
        label: `${regById.get(s.register_id)?.name ?? 'Caja'}${multiBranch ? ` · ${branchName.get(s.branch_id) ?? ''}` : ''}`,
      }))
  }, [sessions.data, registers.data, branches.data, members.data, user?.id, memberRole, preferBranchId])

  // Se propone sola la caja del POS de esta persona, o la única abierta.
  useEffect(() => {
    if (value || !options.length) return
    const stored = tenant ? readPosRegister(tenant.id) : null
    const pick = options.find((o) => o.id === stored) ?? (options.length === 1 ? options[0] : null)
    if (pick) onChange(pick.id)
  }, [value, options, tenant, onChange])

  const chosen = options.find((o) => o.id === value)
  const loading = sessions.isLoading || registers.isLoading
  return (
    <Field
      label="Caja"
      required
      error={sessions.isError ? errorMessage(sessions.error) : undefined}
      hint={
        loading ? (
          'Buscando cajas abiertas…'
        ) : options.length === 0 ? (
          <span>
            No hay ninguna caja abierta.{' '}
            <Link to="/caja" className="font-medium text-brand-700 underline">
              Abre una en Caja
            </Link>{' '}
            para recibir dinero.
          </span>
        ) : chosen && chosen.branchId !== preferBranchId ? (
          'Esta caja es de otra sucursal: el movimiento (y la salida de repuestos al facturar) quedará en esa sucursal.'
        ) : undefined
      }
    >
      <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={loading || options.length === 0}>
        <option value="">Selecciona una caja…</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  )
}

// ── Anticipo ────────────────────────────────────────────────────────────────

const ADVANCE_METHODS: AdvanceMethod[] = ['cash', 'card', 'transfer', 'other']

function AdvanceModal({
  orderId,
  number,
  branchId,
  clientUid,
  currency,
  onClose,
  onDone,
}: {
  orderId: string
  number: string
  branchId: string
  clientUid: string
  currency: string
  onClose: () => void
  onDone: () => void
}) {
  const toast = useToast()
  const addAdvance = useAddWorkOrderAdvance()
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<AdvanceMethod>('cash')
  const [registerId, setRegisterId] = useState('')
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string | null>(null)

  const value = parseAmount(amount)
  const valid = Number.isFinite(value) && value > 0 && Boolean(registerId)

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (!Number.isFinite(value) || value <= 0) {
      setError('Indica un monto mayor que cero')
      return
    }
    if (!registerId) {
      setError('Elige la caja: todo anticipo entra a una caja abierta')
      return
    }
    setError(null)
    addAdvance.mutate(
      { client_uid: clientUid, order_id: orderId, amount: round2(value), method, register_id: registerId, reference: reference.trim() || null },
      {
        onSuccess: () => {
          toast.success(`Anticipo de ${money(round2(value), currency)} registrado en ${number}`)
          onDone()
        },
        onError: (err) => setError(errorMessage(err, 'No se pudo registrar el anticipo')),
      },
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Anticipo · ${number}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={addAdvance.isPending}>
            Cancelar
          </Button>
          <Button onClick={() => submit()} loading={addAdvance.isPending} disabled={!valid}>
            <Wallet className="h-4 w-4" /> Registrar anticipo
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Monto" required>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className="text-lg" autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Método" required>
            <Select value={method} onChange={(e) => setMethod(e.target.value as AdvanceMethod)}>
              {ADVANCE_METHODS.map((k) => (
                <option key={k} value={k}>
                  {PAYMENT_METHOD_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          <OpenRegisterField value={registerId} onChange={setRegisterId} preferBranchId={branchId} />
        </div>
        {method !== 'cash' && (
          <Field label="Referencia">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Aprobación, número de transferencia…" />
          </Field>
        )}
        <p className="text-xs text-slate-500">
          El anticipo entra hoy a la caja elegida y se descuenta automáticamente al facturar la orden.
        </p>
        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</p>}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  )
}

// ── Facturar ────────────────────────────────────────────────────────────────

function CheckoutModal({
  detail,
  customer,
  balance,
  advance,
  clientUid,
  currency,
  onClose,
  onDone,
}: {
  detail: WorkOrderDetail
  customer: Customer | null
  balance: number
  /** Anticipos sin aplicar: wo_checkout los suma solo como pago 'advance'. */
  advance: number
  clientUid: string
  currency: string
  onClose: () => void
  onDone: (r: WorkOrderCheckoutResult, registerId: string) => void
}) {
  const m = (n: number) => money(n, currency)
  const { can, hasModule } = useAuth()
  const fiscal = usePosFiscalSettings()
  const preview = usePreviewTotals()
  const checkout = useWorkOrderCheckout()
  const order = detail.order

  const [registerId, setRegisterId] = useState('')
  const [ecfChoice, setEcfChoice] = useState<EcfChoice | null>(null)
  const [amounts, setAmounts] = useState<Record<PayMethod, string>>({ cash: '', card: '', transfer: '', credit: '' })
  const [refs, setRefs] = useState<{ card: string; transfer: string }>({ card: '', transfer: '' })
  const [error, setError] = useState<string | null>(null)

  const loadTotal = () =>
    preview.mutate({
      items: detail.items.map((it) => ({ product_id: it.product_id, quantity: it.quantity })),
      globalDiscount: 0,
      // wo_checkout factura a nombre del cliente de la orden: su lista de
      // precios (si tiene) es la que manda en el total.
      customerId: order.customer_id,
    })
  useEffect(() => {
    loadTotal()
    // Solo al abrir: el total de la base se pide una vez (y con "Reintentar").
  }, [])

  const total = preview.data?.total ?? null
  const due = total == null ? null : round2(Math.max(0, total - advance))
  const advanceExceeds = total != null && advance > total + 0.001

  // ── Comprobante (mismas reglas que el POS) ──
  const ecfModule = hasModule('invoicing')
  const ecfEnabled = ecfModule && Boolean(fiscal.data?.ecf_enabled)
  const defaultEcf: EcfChoice = ecfEnabled ? (fiscal.data?.default_ecf_type === '31' ? '31' : '32') : ''
  const ecfType: EcfChoice = ecfEnabled ? (ecfChoice ?? defaultEcf) : ''
  const buyerIdentified = Boolean(customer && (customer.doc_type === 'rnc' || customer.doc_type === 'cedula'))
  const ecfError = ecfType === '31' && !buyerIdentified ? 'El crédito fiscal (31) exige un cliente con RNC o cédula.' : undefined

  // ── Pagos ──
  const allowCredit = hasModule('credit') && can('sales.credit')
  const creditAvailable = round2((customer?.credit_limit ?? 0) - balance)
  const val = (k: PayMethod) => {
    const n = parseAmount(amounts[k])
    return Number.isNaN(n) || n < 0 ? 0 : round2(n)
  }
  const cash = val('cash')
  const card = val('card')
  const transfer = val('transfer')
  const credit = allowCredit ? val('credit') : 0
  const nonCash = round2(card + transfer + credit)
  const paid = round2(cash + nonCash)
  const owed = due ?? 0
  const missing = round2(Math.max(0, owed - paid))
  const change = round2(Math.max(0, paid - owed))

  // Mismas reglas que create_sale(); aquí solo para avisar antes de enviar.
  let problem: string | null = null
  if (advanceExceeds)
    problem = `Los anticipos (${m(advance)}) superan el total de la orden (${m(total ?? 0)}). Agrega lo que falta a la orden antes de facturar.`
  else if (nonCash > owed + 0.001) problem = 'Tarjeta, transferencia y crédito no pueden superar lo pendiente.'
  else if (credit > 0 && change > 0) problem = 'Una venta a crédito no lleva devuelta: ajusta los montos.'
  else if (credit > 0 && credit > creditAvailable + 0.001)
    problem = `El crédito disponible de ${customer?.name ?? 'este cliente'} es ${m(Math.max(0, creditAvailable))}.`
  else if (ecfError) problem = ecfError

  const ready = total != null && !preview.isPending && !preview.isError
  const canConfirm = ready && !problem && missing === 0 && Boolean(registerId) && !checkout.isPending

  const set = (k: PayMethod, v: string) => setAmounts((a) => ({ ...a, [k]: v }))
  const fill = (k: PayMethod) => {
    const others = round2(paid - val(k))
    set(k, String(round2(Math.max(0, owed - others))))
  }

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (!canConfirm) return
    const payments: SalePaymentPayload[] = []
    if (cash > 0) payments.push({ method: 'cash', amount: cash })
    if (card > 0) payments.push({ method: 'card', amount: card, reference: refs.card.trim() || null })
    if (transfer > 0) payments.push({ method: 'transfer', amount: transfer, reference: refs.transfer.trim() || null })
    if (credit > 0) payments.push({ method: 'credit', amount: credit })
    setError(null)
    checkout.mutate(
      { order_id: order.id, client_uid: clientUid, register_id: registerId, ecf_type: ecfType || null, payments },
      {
        onSuccess: (r) => onDone(r, registerId),
        onError: (err) => setError(errorMessage(err, 'No se pudo facturar la orden')),
      },
    )
  }

  const methods: PayMethod[] = allowCredit ? ['cash', 'card', 'transfer', 'credit'] : ['cash', 'card', 'transfer']

  return (
    <Modal
      open
      onClose={onClose}
      title={`Facturar ${order.number}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={checkout.isPending}>
            Cancelar
          </Button>
          <Button onClick={() => submit()} disabled={!canConfirm} loading={checkout.isPending}>
            Confirmar cobro
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-2xl bg-slate-900 px-4 py-3 text-white">
          {preview.isPending || total == null ? (
            preview.isError ? (
              <div className="flex items-center justify-between gap-2 text-sm text-red-200">
                <span>{errorMessage(preview.error, 'No se pudo calcular el total')}</span>
                <button type="button" className="shrink-0 font-semibold underline" onClick={loadTotal}>
                  Reintentar
                </button>
              </div>
            ) : (
              <p className="flex items-center gap-2 py-1 text-lg">
                <Spinner size="sm" className="text-white" /> Calculando…
              </p>
            )
          ) : (
            <dl className="space-y-1">
              <div className="flex items-baseline justify-between gap-3 text-sm text-slate-300">
                <dt>Total de la orden</dt>
                <dd className="tabular-nums">{m(total)}</dd>
              </div>
              {advance > 0 && (
                <div className="flex items-baseline justify-between gap-3 text-sm text-slate-300">
                  <dt>Anticipos aplicados</dt>
                  <dd className="tabular-nums">−{m(Math.min(advance, total))}</dd>
                </div>
              )}
              <div className="flex items-baseline justify-between gap-3 pt-1">
                <dt className="text-xs uppercase tracking-wide text-slate-300">A cobrar</dt>
                <dd className="text-3xl font-bold tabular-nums">{m(due ?? 0)}</dd>
              </div>
            </dl>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <OpenRegisterField value={registerId} onChange={setRegisterId} preferBranchId={order.branch_id} />
          {ecfModule && (
            <Field
              label="Comprobante"
              error={ecfError}
              hint={!ecfEnabled ? 'La facturación electrónica no está activada en esta empresa.' : undefined}
            >
              <Select value={ecfType} onChange={(e) => setEcfChoice(e.target.value as EcfChoice)} disabled={!ecfEnabled}>
                <option value="">Sin comprobante fiscal</option>
                <option value="32">e-CF 32 · Consumo</option>
                <option value="31">e-CF 31 · Crédito fiscal</option>
              </Select>
            </Field>
          )}
        </div>

        {owed > 0 &&
          methods.map((k) => (
            <div key={k} className="space-y-2">
              <div className="flex items-end gap-2">
                <Field
                  className="min-w-0 flex-1"
                  label={
                    <span className="flex items-center gap-1.5">
                      {PAY_ICON[k]} {k === 'cash' ? 'Efectivo recibido' : PAYMENT_METHOD_LABEL[k]}
                    </span>
                  }
                  hint={k === 'credit' ? `Disponible: ${m(Math.max(0, creditAvailable))}` : undefined}
                >
                  <Input
                    inputMode="decimal"
                    placeholder="0.00"
                    value={amounts[k]}
                    onChange={(e) => set(k, e.target.value)}
                    className="text-lg"
                  />
                </Field>
                <Button type="button" variant="outline" onClick={() => fill(k)}>
                  {k === 'cash' ? 'Exacto' : 'Completar'}
                </Button>
              </div>
              {(k === 'card' || k === 'transfer') && val(k) > 0 && (
                <Input
                  placeholder={k === 'card' ? 'Referencia / aprobación (opcional)' : 'Referencia de la transferencia (opcional)'}
                  value={refs[k]}
                  onChange={(e) => setRefs((r) => ({ ...r, [k]: e.target.value }))}
                />
              )}
            </div>
          ))}
        {ready && owed === 0 && !advanceExceeds && (
          <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">
            Los anticipos cubren el total: no hay nada más que cobrar.
          </p>
        )}

        {owed > 0 && (
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-slate-50 px-3 py-2">
              <p className="text-xs text-slate-500">Pagado</p>
              <p className="text-lg font-semibold tabular-nums text-slate-800">{m(paid)}</p>
            </div>
            {missing > 0 ? (
              <div className="rounded-xl bg-amber-50 px-3 py-2">
                <p className="text-xs text-amber-700">Falta</p>
                <p className="text-lg font-semibold tabular-nums text-amber-800">{m(missing)}</p>
              </div>
            ) : (
              <div className="rounded-xl bg-emerald-50 px-3 py-2">
                <p className="text-xs text-emerald-700">Devuelta</p>
                <p className="text-2xl font-bold tabular-nums text-emerald-800">{m(change)}</p>
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-slate-500">
          Se cobran los precios vigentes del catálogo y los repuestos salen del inventario de la sucursal de la caja.
        </p>
        {(problem || error) && (
          <p className="rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{problem ?? error}</p>
        )}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  )
}

function CheckoutSuccess({ result, currency }: { result: WorkOrderCheckoutResult; currency: string }) {
  const m = (n: number) => money(n, currency)
  return (
    <div className="space-y-4 text-center">
      <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
      <div>
        <p className="text-sm text-slate-500">Venta {result.number}</p>
        <p className="text-2xl font-bold tabular-nums text-slate-900">{m(result.total)}</p>
        {result.advance_applied > 0 && (
          <p className="text-sm text-slate-500">Incluye {m(result.advance_applied)} de anticipos aplicados</p>
        )}
      </div>
      {result.change_due > 0 && (
        <div className="rounded-2xl bg-emerald-50 px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-emerald-700">Devuelta</p>
          <p className="text-4xl font-bold tabular-nums text-emerald-800">{m(result.change_due)}</p>
        </div>
      )}
      {result.replayed && (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Esta venta ya se había registrado en un intento anterior: no se cobró dos veces.
        </p>
      )}
      {result.ecf && (
        <div className="rounded-xl border border-slate-200 px-3 py-2 text-left text-sm">
          <p className="font-medium text-slate-700">{ECF_TYPE_LABEL[result.ecf.encf.slice(1, 3)] ?? 'Comprobante electrónico'}</p>
          <p className="font-mono text-base text-slate-900">{result.ecf.encf}</p>
          {result.ecf.simulated && (
            <Badge tone="amber" className="mt-1">
              Simulación — sin validez fiscal
            </Badge>
          )}
        </div>
      )}
    </div>
  )
}

// ── Impresión (carta) ───────────────────────────────────────────────────────

/**
 * Orden de trabajo en carta: lo que firma el cliente al dejar el vehículo y al
 * recogerlo. Se arma SOLO con lo guardado (la impresión se deshabilita con
 * cambios sin guardar); los importes van marcados como estimados porque la
 * orden no fija precios: los fija la venta.
 */
function workOrderHtml(input: {
  tenant: Tenant
  d: WorkOrderDetail
  branch: Branch | null
  technician: string | null
  productById: Map<string, Product>
  preview: PricedTotals<PriceLineInput>
  pendingAdvance: number
  currency: string
}): string {
  const { tenant, d, branch, technician, productById, preview, pendingAdvance, currency } = input
  const o = d.order
  const m = (n: number) => esc(money(n, currency))
  const billed = Boolean(o.sale_id)
  const logo = tenant.logo_url ? `<img src="${esc(tenant.logo_url)}" alt="" style="max-height:60px;max-width:180px;margin-bottom:6px">` : ''
  const docLabel: Record<Customer['doc_type'], string> = { rnc: 'RNC', cedula: 'Cédula', passport: 'Pasaporte', none: '' }
  const c = d.customer
  const a = d.asset
  const address = branch?.address || tenant.address

  const rows = d.items
    .map((it, i) => {
      const p = productById.get(it.product_id)
      return `<tr>
        <td>${esc(productLabel(p))}${it.notes ? `<br><span class="muted">${esc(it.notes)}</span>` : ''}</td>
        <td>${esc(p ? KIND_LABEL[p.kind] : '')}</td>
        <td class="r">${esc(fmtQty(it.quantity))}</td>
        ${billed ? '' : `<td class="r">${m(preview.lines[i]?.total ?? 0)}</td>`}
      </tr>`
    })
    .join('')

  const assetRows = a
    ? [
        ['Tipo', ASSET_KIND_LABEL[a.kind]],
        ['Marca / modelo', [a.brand, a.model].filter(Boolean).join(' ')],
        ['Año', a.year ? String(a.year) : ''],
        ['Placa', a.plate ?? ''],
        [a.kind === 'vehicle' ? 'Chasis / VIN' : 'Serie', a.serial ?? ''],
        ['Color', a.color ?? ''],
        ['Kilometraje', o.mileage_in != null ? o.mileage_in.toLocaleString('es-DO') : ''],
      ]
        .filter(([, v]) => v)
        .map(([k, v]) => `<p><span class="muted">${esc(k)}:</span> ${esc(v)}</p>`)
        .join('')
    : `<p class="muted">Sin vehículo/equipo registrado</p>${o.mileage_in != null ? `<p>Kilometraje: ${esc(o.mileage_in)}</p>` : ''}`

  const signature = (label: string) => `<td style="width:50%;padding:0 12px;vertical-align:bottom">
      <div style="border-top:1px solid #000;margin-top:56px;padding-top:4px">
        <p class="b">${esc(label)}</p>
        <p class="muted">Nombre, cédula y fecha</p>
      </div>
    </td>`

  return `<div class="doc">
    <table><tr>
      <td>
        ${logo}
        <h2>${esc(tenant.legal_name || tenant.name)}</h2>
        ${tenant.rnc ? `<p class="muted">RNC ${esc(tenant.rnc)}</p>` : ''}
        ${address ? `<p class="muted">${esc(address)}</p>` : ''}
        ${[tenant.phone, tenant.email].filter(Boolean).length ? `<p class="muted">${esc([tenant.phone, tenant.email].filter(Boolean).join(' · '))}</p>` : ''}
      </td>
      <td class="r">
        <h2>ORDEN DE TRABAJO</h2>
        <p class="b">${esc(o.number)}</p>
        <p class="muted">Recibida: ${esc(fmtDateTime(o.received_at))}</p>
        ${o.promised_at ? `<p class="muted">Prometida: ${esc(fmtDateTime(o.promised_at))}</p>` : ''}
        <p class="muted">Estado: ${esc(WORK_ORDER_STATUS[o.status].label)}</p>
        ${technician ? `<p class="muted">Técnico: ${esc(technician)}</p>` : ''}
      </td>
    </tr></table>
    <div class="hr"></div>
    <table><tr>
      <td style="width:50%;padding-right:12px">
        <p class="muted b">Cliente</p>
        ${
          c
            ? `<p class="b">${esc(c.name)}</p>
               ${c.doc_type !== 'none' && c.doc_number ? `<p>${esc(docLabel[c.doc_type])} ${esc(c.doc_number)}</p>` : ''}
               ${c.phone ? `<p>Tel. ${esc(c.phone)}</p>` : ''}
               ${c.address ? `<p>${esc(c.address)}</p>` : ''}`
            : '<p>—</p>'
        }
      </td>
      <td style="width:50%;padding-left:12px">
        <p class="muted b">Vehículo / equipo</p>
        ${assetRows}
      </td>
    </tr></table>
    <h3 style="margin-top:16px">Problema reportado</h3>
    <p style="white-space:pre-line">${esc(o.problem)}</p>
    ${o.diagnosis ? `<h3 style="margin-top:12px">Diagnóstico</h3><p style="white-space:pre-line">${esc(o.diagnosis)}</p>` : ''}
    ${
      d.items.length
        ? `<table style="margin-top:14px">
            <thead><tr><th>Servicio / repuesto</th><th>Tipo</th><th class="r">Cant.</th>${billed ? '' : '<th class="r">Estimado</th>'}</tr></thead>
            <tbody>${rows}</tbody>
          </table>`
        : ''
    }
    ${
      billed
        ? `<p style="margin-top:10px" class="b">Facturada${d.sale ? ` en la venta ${esc(d.sale.number)} por ${m(d.sale.total)}` : ''}.</p>`
        : d.items.length
          ? `<table style="margin-top:10px;width:auto;margin-left:auto">
              <tr><td class="muted">Total estimado</td><td class="r b" style="padding-left:24px">${m(preview.total)}</td></tr>
              ${pendingAdvance > 0 ? `<tr><td class="muted">Anticipos</td><td class="r">−${m(pendingAdvance)}</td></tr>
              <tr><td class="b">Pendiente estimado</td><td class="r b">${m(Math.max(0, preview.total - pendingAdvance))}</td></tr>` : ''}
            </table>
            <p class="muted" style="margin-top:6px">Importes estimados con los precios vigentes en ${esc(currency)}; el monto final se calcula al facturar.</p>`
          : ''
    }
    ${o.notes ? `<h3 style="margin-top:12px">Observaciones</h3><p style="white-space:pre-line">${esc(o.notes)}</p>` : ''}
    <table style="margin-top:24px"><tr>${signature('Recibido por')}${signature('Entregado a')}</tr></table>
    <p class="muted" style="margin-top:16px;font-size:10px">${esc(fmtDateShort(new Date()))} · ${esc(o.number)}</p>
  </div>`
}

/**
 * Devolución de un anticipo no aplicado (p. ej. el arreglo salió más barato o
 * el cliente desistió). El dinero sale de una caja ABIERTA; la base marca el
 * anticipo como devuelto y deja el movimiento negativo en el arqueo.
 */
function RefundAdvanceModal({
  advance,
  onClose,
}: {
  advance: { id: string; number: string; amount: number } | null
  onClose: () => void
}) {
  const { tenant } = useAuth()
  const sessions = useOpenSessions()
  const registers = useRegisters()
  const refund = useRefundWorkOrderAdvance()
  const toast = useToast()
  const [registerId, setRegisterId] = useState('')
  const [reason, setReason] = useState('')
  const open = (sessions.data ?? []).map((s) => ({
    id: s.register_id,
    name: registers.data?.find((r) => r.id === s.register_id)?.name ?? s.number,
  }))

  const submit = async () => {
    if (!advance) return
    try {
      await refund.mutateAsync({ advance_id: advance.id, register_id: registerId, reason: reason.trim() })
      toast.success(`Anticipo ${advance.number} devuelto`)
      setReason('')
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <Modal
      open={Boolean(advance)}
      onClose={onClose}
      title="Devolver anticipo"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="danger" onClick={submit} loading={refund.isPending} disabled={!registerId || !reason.trim()}>
            Devolver {advance ? money(advance.amount, tenant?.currency) : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          El dinero sale de la caja que elijas y queda registrado en su arqueo. El anticipo deja de descontarse al
          facturar.
        </p>
        <Field label="Caja abierta" required>
          <Select value={registerId} onChange={(e) => setRegisterId(e.target.value)}>
            <option value="">Elige una caja…</option>
            {open.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        {open.length === 0 && (
          <p className="text-sm text-amber-700">
            No hay cajas abiertas. <Link to="/caja" className="font-medium underline">Abre una caja</Link> primero.
          </p>
        )}
        <Field label="Motivo" required>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej. El cliente desistió" />
        </Field>
      </div>
    </Modal>
  )
}
