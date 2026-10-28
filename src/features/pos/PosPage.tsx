import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  ArrowRightLeft,
  Banknote,
  CheckCircle2,
  CreditCard,
  FileText,
  HandCoins,
  Lock,
  Minus,
  Pencil,
  Plus,
  Printer,
  ScanLine,
  Search,
  ShoppingCart,
  Store,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { RequireAccess } from '@/components/RequireAccess'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { EmptyState, PageLoader, Spinner } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import {
  useBranches,
  useCategories,
  useCustomerBalances,
  useCustomers,
  useProducts,
  useRegisters,
  useStockMap,
  useTaxes,
} from '@/hooks/core'
import { useTeamMembers } from '@/hooks/team'
import { useOpenCashSession, useOpenSessions } from '@/hooks/cash'
import {
  useCreateSale,
  usePosFiscalSettings,
  usePreviewTotals,
  useQuotationForPos,
  type PreviewTotals,
  type SaleLinePayload,
  type SalePaymentPayload,
} from '@/hooks/pos'
import { useSaleDetailFetcher } from '@/hooks/sales'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import { money, num } from '@/lib/format'
import { newClientUid, PAYMENT_METHOD_LABEL } from '@/lib/labels'
import { priceLines } from '@/lib/pricing'
import { ECF_TYPE_LABEL, printSaleReceipt } from '@/features/pos/receipt'
import type { CashRegister, CreateSaleResult, Customer, CustomerBalance, Product } from '@/types/erp'

/*
 * Punto de venta.
 *
 * Decisiones que no se ven en el código:
 *   · El carrito (y el client_uid de la venta en curso) se guarda en
 *     localStorage por empresa: si se recarga la página o se va la luz a mitad
 *     de un cobro, al volver sigue ahí, y un reintento usa el MISMO client_uid,
 *     así que la base devuelve la venta que ya hubiera entrado en vez de cobrar
 *     dos veces.
 *   · El total que se cobra es el de `preview_totals()` (la base), pedido al
 *     abrir el cobro; el de `priceLines()` es solo la vista previa instantánea.
 *   · Imprimir va DESPUÉS de guardar y por separado: un fallo de la impresora
 *     no deshace ni bloquea la venta.
 */

export function PosPage() {
  return (
    <RequireAccess module="pos" perm="sales.create">
      <PosScreen />
    </RequireAccess>
  )
}

// ── Tipos y utilidades locales ──────────────────────────────────────────────

type EcfChoice = '' | '31' | '32'
type PayMethod = 'cash' | 'card' | 'transfer' | 'credit'

interface CartLine {
  key: string
  product_id: string
  /** Copia para pintar la línea aunque el catálogo aún no haya cargado. */
  name: string
  unit: string
  quantity: number
  /** Precio que se cobra. Si no se cambió a mano, se sigue el del catálogo. */
  unit_price: number
  price_overridden: boolean
  /** Descuento en dinero de la línea. */
  discount: number
}

interface CartState {
  lines: CartLine[]
  globalDiscount: number
  customerId: string | null
  sellerId: string | null
  notes: string
  /** null = el tipo por defecto de la configuración fiscal. */
  ecfType: EcfChoice | null
  quotationId: string | null
  quotationNumber: string | null
  /** Idempotencia: se fija al abrir el primer cobro y se reutiliza hasta que la venta entra. */
  clientUid: string | null
}

const EMPTY_CART: CartState = {
  lines: [],
  globalDiscount: 0,
  customerId: null,
  sellerId: null,
  notes: '',
  ecfType: null,
  quotationId: null,
  quotationNumber: null,
  clientUid: null,
}

const registerStorageKey = (tenantId: string) => `ferddo-pos-register:${tenantId}`
// El carrito es por empresa Y por persona: en un terminal compartido, el
// cajero del turno siguiente no hereda la venta a medias (ni su vendedor).
const cartStorageKey = (scope: string) => `ferddo-pos-cart:${scope}`

// localStorage puede no existir (modo privado, cuota llena): nunca debe tumbar
// el POS, solo dejar de recordar.
function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeStorage(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* sin almacenamiento: se sigue sin recordar */
  }
}

function loadCart(scope: string): CartState {
  const raw = readStorage(cartStorageKey(scope))
  if (!raw) return EMPTY_CART
  try {
    const parsed = JSON.parse(raw) as Partial<CartState>
    if (!Array.isArray(parsed.lines)) return EMPTY_CART
    return { ...EMPTY_CART, ...parsed, lines: parsed.lines }
  } catch {
    return EMPTY_CART
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100
/** Las cantidades admiten 3 decimales (libras, metros…), igual que sale_items.quantity. */
const r3 = (n: number) => Math.round(n * 1000) / 1000
function parseNum(s: string): number {
  const n = Number(s.replace(/,/g, '.').trim())
  return Number.isFinite(n) ? n : NaN
}
/** Para buscar sin que importen tildes ni mayúsculas ("cafe" encuentra "Café"). */
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
/** Con ratón/teclado se devuelve el foco al buscador; en táctil no, para no abrir el teclado. */
const finePointer = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches
/** En `lg` el carrito ya está a la vista en la columna derecha: no hace falta abrir su hoja. */
const isDesktop = () => typeof window !== 'undefined' && window.matchMedia?.('(min-width: 1024px)').matches
const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toLocaleString('es-DO', { maximumFractionDigits: 3 }))
const productLabel = (p: Product) => (p.variant_label ? `${p.name} ${p.variant_label}` : p.name)

let lineSeq = 0
const newLineKey = (productId: string) => `${productId}:${Date.now().toString(36)}:${++lineSeq}`

// ── Pantalla ────────────────────────────────────────────────────────────────

function PosScreen() {
  const { tenant, user, memberRole } = useAuth()
  const registers = useRegisters()
  const sessions = useOpenSessions()
  const members = useTeamMembers()
  const branches = useBranches()

  // Cajas a las que esta persona puede vender: activas y de sus sucursales.
  // Es cortesía; la base vuelve a comprobar can_access_branch() en la venta.
  const myRegisters = useMemo(() => {
    const me = members.data?.find((m) => m.user_id === user?.id)
    const unrestricted = memberRole === 'owner' || memberRole === 'admin' || !me || me.branch_ids == null
    return (registers.data ?? []).filter(
      (r) => r.is_active && (unrestricted || (me?.branch_ids ?? []).includes(r.branch_id)),
    )
  }, [registers.data, members.data, user?.id, memberRole])

  const tenantId = tenant?.id ?? ''
  const [registerId, setRegisterId] = useState<string>(() => readStorage(registerStorageKey(tenantId)) ?? '')
  const register = myRegisters.find((r) => r.id === registerId) ?? myRegisters[0] ?? null

  const chooseRegister = (id: string) => {
    setRegisterId(id)
    writeStorage(registerStorageKey(tenantId), id)
  }

  if (registers.isLoading || sessions.isLoading) return <PageLoader label="Preparando el punto de venta…" />
  if (registers.isError || sessions.isError) {
    return (
      <EmptyState
        icon={<Store className="h-6 w-6" />}
        title="No se pudo cargar el punto de venta"
        description={errorMessage(registers.error ?? sessions.error)}
        action={
          <Button
            variant="outline"
            onClick={() => {
              void registers.refetch()
              void sessions.refetch()
            }}
          >
            Reintentar
          </Button>
        }
      />
    )
  }
  if (!register) {
    return (
      <EmptyState
        icon={<Store className="h-6 w-6" />}
        title="No hay cajas disponibles"
        description="Crea una caja en Configuración (o pide acceso a una sucursal) para empezar a vender."
        action={
          <Link to="/configuracion">
            <Button variant="outline">Ir a Configuración</Button>
          </Link>
        }
      />
    )
  }

  const session = sessions.data?.find((s) => s.register_id === register.id) ?? null
  const branch = branches.data?.find((b) => b.id === register.branch_id) ?? null

  return (
    <div className="pb-20 lg:pb-0">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">Punto de venta</h1>
          <p className="truncate text-sm text-slate-500">
            {branch ? `${branch.name} · ` : ''}
            {session ? `Caja abierta ${session.number}` : 'Caja cerrada'}
          </p>
        </div>
        {myRegisters.length > 1 && (
          <div className="w-full sm:w-64">
            <Select aria-label="Caja" value={register.id} onChange={(e) => chooseRegister(e.target.value)}>
              {myRegisters.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      {session ? (
        <PosWorkspace key={tenantId} cartScope={`${tenantId}:${user?.id ?? ''}`} register={register} />
      ) : (
        <OpenRegisterPanel register={register} />
      )}
    </div>
  )
}

// ── Apertura de caja ────────────────────────────────────────────────────────

function OpenRegisterPanel({ register }: { register: CashRegister }) {
  const { can, tenant } = useAuth()
  const toast = useToast()
  const open = useOpenCashSession()
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const value = amount.trim() === '' ? 0 : parseNum(amount)
    if (Number.isNaN(value) || value < 0) {
      toast.error('Indica un monto inicial válido')
      return
    }
    open.mutate(
      { registerId: register.id, openingAmount: r2(value), note: note.trim() || null },
      {
        onSuccess: () => toast.success(`Caja ${register.name} abierta`),
        onError: (err) => toast.error(errorMessage(err)),
      },
    )
  }

  if (!can('cash.open')) {
    return (
      <EmptyState
        icon={<Lock className="h-6 w-6" />}
        title={`La caja ${register.name} está cerrada`}
        description="Tu rol no puede abrir cajas. Pide a un supervisor que la abra para empezar a vender."
      />
    )
  }

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader title={`Abrir caja · ${register.name}`} subtitle="Cuenta el efectivo con que empiezas el turno." />
      <CardBody>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Fondo inicial (efectivo)" htmlFor="opening">
            <Input
              id="opening"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus={finePointer()}
            />
          </Field>
          <Field label="Nota (opcional)" htmlFor="opening-note">
            <Input id="opening-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button type="submit" size="lg" className="w-full" loading={open.isPending}>
            Abrir caja {amount.trim() ? `con ${money(parseNum(amount) || 0, tenant?.currency)}` : ''}
          </Button>
        </form>
      </CardBody>
    </Card>
  )
}

// ── Área de venta ───────────────────────────────────────────────────────────

function PosWorkspace({ cartScope, register }: { cartScope: string; register: CashRegister }) {
  const { tenant, user, can, hasModule } = useAuth()
  const toast = useToast()
  const location = useLocation()
  const navigate = useNavigate()

  const products = useProducts()
  const categories = useCategories()
  const taxes = useTaxes()
  const stock = useStockMap(register.branch_id)
  const customers = useCustomers()
  const balances = useCustomerBalances()
  const members = useTeamMembers()
  const fiscal = usePosFiscalSettings()
  const branches = useBranches()
  const createSale = useCreateSale()
  const preview = usePreviewTotals()
  const fetchDetail = useSaleDetailFetcher()

  const currency = tenant?.currency ?? 'DOP'
  const m = useCallback((n: number) => money(n, currency), [currency])
  const canDiscount = can('sales.discount')
  const canOverride = can('sales.price_override')
  const showStock = hasModule('inventory')

  // ── Carrito persistente ──
  const [cart, setCart] = useState<CartState>(() => loadCart(cartScope))
  useEffect(() => {
    writeStorage(cartStorageKey(cartScope), cart.lines.length || cart.clientUid ? JSON.stringify(cart) : null)
  }, [cart, cartScope])
  const patchCart = useCallback((patch: Partial<CartState>) => setCart((c) => ({ ...c, ...patch })), [])

  // ── Índices del catálogo ──
  const productMap = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p])), [products.data])
  const taxRate = useMemo(() => new Map((taxes.data ?? []).map((t) => [t.id, Number(t.rate)])), [taxes.data])
  const sellable = useMemo(() => {
    // Un producto con variantes no se vende directamente: se vende la variante.
    const parents = new Set((products.data ?? []).map((p) => p.parent_id).filter(Boolean) as string[])
    return (products.data ?? [])
      .filter((p) => p.is_active && !parents.has(p.id))
      .map((p) => ({
        p,
        hay: fold([p.name, p.variant_label, p.sku, p.barcode, p.code, p.brand].filter(Boolean).join(' ')),
      }))
  }, [products.data])

  const categoryChildren = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const c of categories.data ?? []) {
      if (c.parent_id) map.set(c.parent_id, [...(map.get(c.parent_id) ?? []), c.id])
    }
    return map
  }, [categories.data])
  const usedCategories = useMemo(() => {
    const used = new Set(sellable.map((x) => x.p.category_id).filter(Boolean) as string[])
    return (categories.data ?? []).filter(
      (c) => c.is_active && (used.has(c.id) || (categoryChildren.get(c.id) ?? []).some((id) => used.has(id))),
    )
  }, [categories.data, sellable, categoryChildren])

  // ── Búsqueda ──
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [categoryId, setCategoryId] = useState<string>('')
  const filtered = useMemo(() => {
    const q = fold(query.replace(/^\d+(?:[.,]\d+)?\*/, '').trim())
    const cats = categoryId ? new Set([categoryId, ...(categoryChildren.get(categoryId) ?? [])]) : null
    return sellable.filter(({ p, hay }) => (!cats || (p.category_id && cats.has(p.category_id))) && (!q || hay.includes(q)))
  }, [sellable, query, categoryId, categoryChildren])
  const GRID_LIMIT = 60
  const refocusSearch = () => {
    if (finePointer()) searchRef.current?.focus()
  }

  // ── Operaciones del carrito ──
  const addProduct = useCallback(
    (p: Product, qty = 1) => {
      setCart((c) => {
        const existing = c.lines.find((l) => l.product_id === p.id)
        if (existing) {
          return {
            ...c,
            lines: c.lines.map((l) => (l.key === existing.key ? { ...l, quantity: r3(l.quantity + qty) } : l)),
          }
        }
        const line: CartLine = {
          key: newLineKey(p.id),
          product_id: p.id,
          name: productLabel(p),
          unit: p.unit,
          quantity: qty,
          unit_price: Number(p.price),
          price_overridden: false,
          discount: 0,
        }
        return { ...c, lines: [...c.lines, line] }
      })
    },
    [],
  )
  const updateLine = (key: string, patch: Partial<CartLine>) =>
    setCart((c) => ({ ...c, lines: c.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }))
  const removeLine = (key: string) => setCart((c) => ({ ...c, lines: c.lines.filter((l) => l.key !== key) }))
  const clearCart = () => setCart(EMPTY_CART)

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const raw = query.trim()
    if (!raw) return
    // "3*7501234567890" → 3 unidades de ese código (atajo habitual de caja).
    const mult = raw.match(/^(\d+(?:[.,]\d+)?)\*(.+)$/)
    const qty = mult ? parseNum(mult[1]) : 1
    const code = fold((mult ? mult[2] : raw).trim())
    const exact = sellable.find(({ p }) => [p.barcode, p.sku, p.code].some((c) => c && fold(c) === code))
    const hit = exact?.p ?? (filtered.length === 1 ? filtered[0].p : null)
    if (hit && qty > 0) {
      addProduct(hit, qty)
      setQuery('')
    } else if (!hit) {
      toast.info(`No hay un producto con el código "${mult ? mult[2] : raw}"`)
    }
  }

  // ── Cotización precargada (Cotizaciones → "Convertir en venta") ──
  const [quotationToLoad, setQuotationToLoad] = useState<string | null>(
    () => (location.state as { quotationId?: string } | null)?.quotationId ?? null,
  )
  useEffect(() => {
    // Se limpia el state de la URL para que recargar la página no vuelva a
    // pisar el carrito con la cotización.
    if ((location.state as { quotationId?: string } | null)?.quotationId) {
      navigate(location.pathname, { replace: true, state: null })
    }
  }, [location.state, location.pathname, navigate])
  const quotation = useQuotationForPos(quotationToLoad)
  useEffect(() => {
    if (!quotationToLoad) return
    if (quotation.isError) {
      toast.error(errorMessage(quotation.error, 'No se pudo cargar la cotización'))
      setQuotationToLoad(null)
      return
    }
    if (!quotation.data || !products.data) return
    const { quotation: q, items } = quotation.data
    setQuotationToLoad(null)
    if (!['draft', 'sent', 'accepted'].includes(q.status)) {
      toast.error(`La cotización ${q.number} ya no se puede convertir (${q.status === 'converted' ? 'ya fue convertida' : 'no está vigente'}).`)
      return
    }
    let priceChanged = false
    let skipped = 0
    const lines: CartLine[] = []
    for (const it of items) {
      const p = productMap.get(it.product_id)
      if (!p || !p.is_active) {
        skipped++
        continue
      }
      const current = Number(p.price)
      // Sin permiso para cambiar precios, se cobra el precio vigente: mandar el
      // cotizado haría que la base rechace la venta con FORBIDDEN.
      const useQuoted = canOverride && it.unit_price !== current
      if (!canOverride && it.unit_price !== current) priceChanged = true
      lines.push({
        key: newLineKey(p.id),
        product_id: p.id,
        name: it.description || productLabel(p),
        unit: p.unit,
        quantity: it.quantity,
        unit_price: useQuoted ? it.unit_price : current,
        price_overridden: useQuoted,
        discount: canDiscount ? it.line_discount : 0,
      })
    }
    setCart({
      ...EMPTY_CART,
      lines,
      globalDiscount: canDiscount ? q.global_discount : 0,
      customerId: q.customer_id,
      quotationId: q.id,
      quotationNumber: q.number,
    })
    toast.success(`Cotización ${q.number} cargada en el carrito`)
    if (priceChanged) toast.info('Algunos precios cambiaron desde la cotización: se usan los precios vigentes.')
    if (skipped) toast.info(`${skipped} línea(s) no se cargaron porque el producto ya no está activo.`)
    if (!canDiscount && (q.global_discount > 0 || items.some((i) => i.line_discount > 0))) {
      toast.info('La cotización tenía descuentos y tu rol no puede aplicarlos: se quitaron.')
    }
  }, [quotationToLoad, quotation.data, quotation.isError, quotation.error, products.data, productMap, canOverride, canDiscount, toast])

  // ── Cálculo de la vista previa ──
  const pricedInputs = cart.lines.map((l) => {
    const p = productMap.get(l.product_id)
    return {
      line: l,
      product: p,
      quantity: l.quantity,
      // Sin cambio manual se sigue el precio del catálogo (por si cambió).
      unit_price: l.price_overridden || !p ? l.unit_price : Number(p.price),
      discount: l.discount,
      tax_rate: p?.tax_id ? (taxRate.get(p.tax_id) ?? 0) : 0,
    }
  })
  const priced = priceLines(pricedInputs, cart.globalDiscount, Boolean(tenant?.prices_include_tax))
  const itemCount = cart.lines.reduce((s, l) => s + l.quantity, 0)

  // ── Cliente, vendedor, comprobante ──
  const customer = cart.customerId ? (customers.data?.find((c) => c.id === cart.customerId) ?? null) : null
  const customerBalance = customer ? (balances.data?.[customer.id]?.balance ?? 0) : 0
  const sellers = (members.data ?? []).filter((mbr) => mbr.is_active)
  const sellerId = cart.sellerId ?? user?.id ?? null

  const ecfModule = hasModule('invoicing')
  const ecfEnabled = ecfModule && Boolean(fiscal.data?.ecf_enabled)
  const defaultEcf: EcfChoice = ecfEnabled ? (fiscal.data?.default_ecf_type === '31' ? '31' : '32') : ''
  const ecfType: EcfChoice = ecfEnabled ? (cart.ecfType ?? defaultEcf) : ''
  const buyerIdentified = Boolean(customer && (customer.doc_type === 'rnc' || customer.doc_type === 'cedula'))
  const ecfError =
    ecfType === '31' && !buyerIdentified
      ? 'El crédito fiscal (31) exige un cliente con RNC o cédula.'
      : undefined

  // ── Cobro ──
  const [chargeOpen, setChargeOpen] = useState(false)
  const [serverTotals, setServerTotals] = useState<PreviewTotals | null>(null)
  const [chargeError, setChargeError] = useState<string | null>(null)
  const [cartOpen, setCartOpen] = useState(false)
  const [result, setResult] = useState<(CreateSaleResult & { customerName: string | null }) | null>(null)

  const itemsPayload: SaleLinePayload[] = cart.lines.map((l) => ({
    product_id: l.product_id,
    quantity: l.quantity,
    ...(l.price_overridden ? { unit_price: l.unit_price } : {}),
    ...(l.discount > 0 ? { discount: l.discount } : {}),
  }))

  const loadServerTotals = () => {
    setServerTotals(null)
    preview.mutate(
      { items: itemsPayload, globalDiscount: cart.globalDiscount },
      { onSuccess: (t) => setServerTotals(t) },
    )
  }

  const openCharge = () => {
    if (chargeOpen || result) return
    if (!cart.lines.length) {
      toast.info('El carrito está vacío')
      return
    }
    const bad = priced.lines.find((l) => !(l.input.quantity > 0) || l.input.discount > l.gross + 0.001)
    if (bad) {
      toast.error(`Revisa la cantidad o el descuento de "${bad.input.line.name}"`)
      if (!isDesktop()) setCartOpen(true)
      return
    }
    const netSum = priced.lines.reduce((s, l) => s + l.gross - (l.input.discount ?? 0), 0)
    if (cart.globalDiscount > netSum + 0.001) {
      toast.error('El descuento general no puede superar el total')
      return
    }
    if (ecfError) {
      toast.error(ecfError)
      if (!isDesktop()) setCartOpen(true)
      return
    }
    setCartOpen(false)
    setChargeError(null)
    // Un client_uid por venta: se genera la primera vez y se conserva en cada
    // reintento (y tras recargar), hasta que la base confirma la venta.
    if (!cart.clientUid) patchCart({ clientUid: newClientUid() })
    setChargeOpen(true)
    loadServerTotals()
  }

  const confirmCharge = (payments: SalePaymentPayload[]) => {
    const uid = cart.clientUid ?? newClientUid()
    if (!cart.clientUid) patchCart({ clientUid: uid })
    setChargeError(null)
    createSale.mutate(
      {
        client_uid: uid,
        register_id: register.id,
        customer_id: cart.customerId,
        seller_id: sellerId,
        quotation_id: cart.quotationId,
        notes: cart.notes.trim() || null,
        items: itemsPayload,
        global_discount: cart.globalDiscount,
        ecf_type: ecfType || null,
        payments,
      },
      {
        onSuccess: (r) => {
          setResult({ ...r, customerName: customer?.name ?? null })
          setChargeOpen(false)
          setCart(EMPTY_CART)
          setQuery('')
        },
        onError: (err) => setChargeError(errorMessage(err, 'No se pudo registrar la venta')),
      },
    )
  }

  const [printing, setPrinting] = useState(false)
  const printLast = async () => {
    if (!result || !tenant) return
    setPrinting(true)
    try {
      const detail = await fetchDetail(result.sale_id)
      const names = Object.fromEntries((members.data ?? []).map((mb) => [mb.user_id, mb.full_name ?? mb.email ?? '']))
      printSaleReceipt({
        tenant,
        detail,
        register,
        branch: branches.data?.find((b) => b.id === detail.sale.branch_id) ?? null,
        cashierName: detail.sale.created_by ? names[detail.sale.created_by] : null,
        sellerName: detail.sale.seller_id ? names[detail.sale.seller_id] : null,
      })
    } catch (err) {
      toast.error(`La venta está guardada, pero no se pudo imprimir: ${errorMessage(err)}`)
    } finally {
      setPrinting(false)
    }
  }
  const newSale = () => {
    setResult(null)
    setTimeout(() => searchRef.current?.focus(), 0)
  }

  // ── Atajos de teclado: F2 buscar, F9 cobrar ──
  const openChargeRef = useRef(openCharge)
  openChargeRef.current = openCharge
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (e.key === 'F9') {
        e.preventDefault()
        // Si hay una cantidad o un precio a medio escribir, se confirma al
        // perder el foco; se espera a ese render para cobrar con el dato bueno.
        const active = document.activeElement
        if (active instanceof HTMLElement && active !== searchRef.current) active.blur()
        setTimeout(() => openChargeRef.current(), 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const stockMap = stock.data ?? {}
  const qtyInCart = useMemo(() => {
    const map = new Map<string, number>()
    for (const l of cart.lines) map.set(l.product_id, (map.get(l.product_id) ?? 0) + l.quantity)
    return map
  }, [cart.lines])

  const cartPanel = (
    <CartPanel
      cart={cart}
      priced={priced}
      currency={currency}
      itemCount={itemCount}
      customer={customer}
      customerBalance={customerBalance}
      customers={customers.data ?? []}
      balances={balances.data ?? {}}
      sellers={sellers.map((s) => ({ id: s.user_id, name: s.full_name ?? s.email ?? 'Sin nombre' }))}
      sellerId={sellerId}
      ecfModule={ecfModule}
      ecfEnabled={ecfEnabled}
      ecfType={ecfType}
      ecfError={ecfError}
      canDiscount={canDiscount}
      canOverride={canOverride}
      stockMap={showStock ? stockMap : null}
      onPatch={patchCart}
      onUpdateLine={updateLine}
      onRemoveLine={removeLine}
      onClear={clearCart}
      onCharge={openCharge}
      charging={preview.isPending && chargeOpen}
    />
  )

  if (products.isLoading) return <PageLoader label="Cargando productos…" />

  return (
    <>
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start lg:gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
        {/* ── Catálogo ── */}
        <section className="min-w-0 space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              placeholder="Buscar o escanear código (F2)"
              aria-label="Buscar producto por nombre, SKU o código de barras"
              className="h-12 pl-11 pr-11 text-base"
              autoFocus={finePointer()}
              autoComplete="off"
              enterKeyHint="search"
            />
            {query ? (
              <button
                type="button"
                aria-label="Limpiar búsqueda"
                onClick={() => {
                  setQuery('')
                  searchRef.current?.focus()
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-5 w-5" />
              </button>
            ) : (
              <ScanLine className="pointer-events-none absolute right-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-300" />
            )}
          </div>

          {usedCategories.length > 0 && (
            // Fila de chips con desplazamiento propio: no es un listado de
            // datos, y en móvil envolverla en varias filas empujaría la rejilla
            // de productos fuera de la pantalla.
            <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Categorías">
              <Chip active={!categoryId} onClick={() => setCategoryId('')}>
                Todas
              </Chip>
              {usedCategories.map((c) => (
                <Chip key={c.id} active={categoryId === c.id} onClick={() => setCategoryId(c.id)}>
                  {c.name}
                </Chip>
              ))}
            </div>
          )}

          {quotationToLoad && (
            <p className="flex items-center gap-2 text-sm text-slate-500">
              <Spinner size="sm" /> Cargando cotización…
            </p>
          )}
          {cart.quotationNumber && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-800">
              <span className="flex min-w-0 items-center gap-2">
                <FileText className="h-4 w-4 shrink-0" />
                <span className="truncate">Convirtiendo la cotización {cart.quotationNumber}</span>
              </span>
              <button
                type="button"
                className="shrink-0 text-xs font-semibold underline"
                onClick={() => patchCart({ quotationId: null, quotationNumber: null })}
              >
                Desvincular
              </button>
            </div>
          )}

          {products.isError ? (
            <EmptyState
              title="No se pudo cargar el catálogo"
              description={errorMessage(products.error)}
              action={
                <Button variant="outline" onClick={() => products.refetch()}>
                  Reintentar
                </Button>
              }
            />
          ) : sellable.length === 0 ? (
            <EmptyState
              icon={<ShoppingCart className="h-6 w-6" />}
              title="Aún no hay productos para vender"
              description="Crea tus productos y servicios para que aparezcan aquí."
              action={
                <Link to="/productos">
                  <Button variant="outline">Ir a Productos</Button>
                </Link>
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<Search className="h-6 w-6" />}
              title="Sin resultados"
              description="Prueba con otro nombre, SKU o código de barras."
            />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                {filtered.slice(0, GRID_LIMIT).map(({ p }) => (
                  <ProductTile
                    key={p.id}
                    product={p}
                    currency={currency}
                    stock={showStock && p.track_stock ? (stockMap[p.id] ?? 0) : null}
                    inCart={qtyInCart.get(p.id) ?? 0}
                    onAdd={() => {
                      addProduct(p)
                      refocusSearch()
                    }}
                  />
                ))}
              </div>
              {filtered.length > GRID_LIMIT && (
                <p className="text-center text-xs text-slate-500">
                  Mostrando {GRID_LIMIT} de {num(filtered.length)}. Escribe para afinar la búsqueda.
                </p>
              )}
            </>
          )}
        </section>

        {/* ── Carrito (escritorio) ── */}
        <aside className="hidden lg:sticky lg:top-20 lg:block">
          <Card className="flex max-h-[calc(100dvh-6.5rem)] flex-col">{cartPanel}</Card>
        </aside>
      </div>

      {/* ── Barra del carrito (móvil): fija sobre la navegación inferior ── */}
      <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 border-t border-slate-200 bg-white/95 px-3 py-2 backdrop-blur lg:hidden">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCartOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-slate-50"
          >
            <span className="relative">
              <ShoppingCart className="h-6 w-6 text-slate-600" />
              {cart.lines.length > 0 && (
                <span className="absolute -right-2 -top-2 rounded-full bg-brand-600 px-1.5 text-[10px] font-bold text-white">
                  {cart.lines.length}
                </span>
              )}
            </span>
            <span className="min-w-0">
              <span className="block text-xs text-slate-500">Ver carrito</span>
              <span className="block truncate text-lg font-bold tabular-nums text-slate-900">{m(priced.total)}</span>
            </span>
          </button>
          <Button size="lg" onClick={openCharge} disabled={!cart.lines.length}>
            Cobrar
          </Button>
        </div>
      </div>

      <Modal open={cartOpen} onClose={() => setCartOpen(false)} title={`Carrito (${cart.lines.length})`} size="lg">
        <div className="-mx-5 -my-4">{cartPanel}</div>
      </Modal>

      {chargeOpen && (
        <ChargeModal
          currency={currency}
          total={serverTotals?.total ?? null}
          localTotal={priced.total}
          totalLoading={preview.isPending}
          totalError={preview.isError ? errorMessage(preview.error) : null}
          onRetryTotal={loadServerTotals}
          customer={customer}
          creditAvailable={customer ? Number(customer.credit_limit) - customerBalance : 0}
          allowCredit={can('sales.credit') && hasModule('credit')}
          submitting={createSale.isPending}
          error={chargeError}
          onClose={() => {
            if (!createSale.isPending) setChargeOpen(false)
          }}
          onConfirm={confirmCharge}
        />
      )}

      <Modal
        open={Boolean(result)}
        onClose={newSale}
        title="Venta registrada"
        footer={
          <>
            <Button variant="outline" onClick={printLast} loading={printing}>
              <Printer className="h-4 w-4" /> Imprimir ticket
            </Button>
            <Button onClick={newSale} autoFocus>
              Nueva venta
            </Button>
          </>
        }
      >
        {result && <SaleSuccess result={result} currency={currency} />}
      </Modal>
    </>
  )
}

// ── Piezas del catálogo ─────────────────────────────────────────────────────

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'h-9 shrink-0 whitespace-nowrap rounded-full px-4 text-sm font-medium transition-colors',
        active ? 'bg-brand-600 text-white' : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
      )}
    >
      {children}
    </button>
  )
}

const STOCK_TONE = {
  out: 'text-red-600',
  low: 'text-amber-600',
  ok: 'text-slate-500',
} as const

function ProductTile({
  product,
  currency,
  stock,
  inCart,
  onAdd,
}: {
  product: Product
  currency: string
  /** null = no se controla existencia. */
  stock: number | null
  inCart: number
  onAdd: () => void
}) {
  const level: keyof typeof STOCK_TONE =
    stock == null || stock > Number(product.min_stock) ? 'ok' : stock <= 0 ? 'out' : 'low'
  return (
    <button
      type="button"
      onClick={onAdd}
      className={cn(
        'relative flex min-h-[96px] flex-col justify-between rounded-xl border bg-white p-3 text-left shadow-sm transition',
        'hover:border-brand-300 hover:shadow active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40',
        inCart > 0 ? 'border-brand-400' : 'border-slate-200',
      )}
    >
      {inCart > 0 && (
        <span className="absolute right-2 top-2 rounded-full bg-brand-600 px-2 py-0.5 text-xs font-bold text-white">
          {fmtQty(inCart)}
        </span>
      )}
      <span className={cn('line-clamp-2 text-sm font-medium text-slate-800', inCart > 0 && 'pr-8')}>
        {productLabel(product)}
      </span>
      <span className="mt-2 flex items-end justify-between gap-1">
        <span className="text-base font-bold tabular-nums text-slate-900">{money(product.price, currency)}</span>
        {stock != null && (
          <span className={cn('text-xs tabular-nums', STOCK_TONE[level])}>
            {level === 'out' ? 'Agotado' : `${fmtQty(stock)} ${product.unit}`}
          </span>
        )}
      </span>
    </button>
  )
}

// ── Carrito ─────────────────────────────────────────────────────────────────

type PricedCart = ReturnType<typeof priceLines<{
  line: CartLine
  product: Product | undefined
  quantity: number
  unit_price: number
  discount: number
  tax_rate: number
}>>

function CartPanel({
  cart,
  priced,
  currency,
  itemCount,
  customer,
  customerBalance,
  customers,
  balances,
  sellers,
  sellerId,
  ecfModule,
  ecfEnabled,
  ecfType,
  ecfError,
  canDiscount,
  canOverride,
  stockMap,
  onPatch,
  onUpdateLine,
  onRemoveLine,
  onClear,
  onCharge,
  charging,
}: {
  cart: CartState
  priced: PricedCart
  currency: string
  itemCount: number
  customer: Customer | null
  customerBalance: number
  customers: Customer[]
  balances: Record<string, CustomerBalance>
  sellers: { id: string; name: string }[]
  sellerId: string | null
  ecfModule: boolean
  ecfEnabled: boolean
  ecfType: EcfChoice
  ecfError?: string
  canDiscount: boolean
  canOverride: boolean
  stockMap: Record<string, number> | null
  onPatch: (patch: Partial<CartState>) => void
  onUpdateLine: (key: string, patch: Partial<CartLine>) => void
  onRemoveLine: (key: string) => void
  onClear: () => void
  onCharge: () => void
  charging: boolean
}) {
  const m = (n: number) => money(n, currency)
  const [editing, setEditing] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Cliente */}
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left hover:bg-slate-50"
        >
          <UserRound className="h-5 w-5 shrink-0 text-slate-400" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-slate-800">
              {customer ? customer.name : 'Consumidor final'}
            </span>
            <span className="block truncate text-xs text-slate-500">
              {customer
                ? [customer.doc_number, customerBalance > 0 ? `Debe ${m(customerBalance)}` : null]
                    .filter(Boolean)
                    .join(' · ') || 'Cambiar cliente'
                : 'Toca para elegir un cliente'}
            </span>
          </span>
        </button>
        {customer && (
          <button
            type="button"
            aria-label="Quitar cliente"
            onClick={() => onPatch({ customerId: null })}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Líneas */}
      <div className="min-h-[8rem] flex-1 overflow-y-auto">
        {cart.lines.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-10 text-center text-slate-400">
            <ShoppingCart className="mb-2 h-8 w-8" />
            <p className="text-sm">Toca un producto o escanea su código para agregarlo.</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {priced.lines.map((pl) => {
              const l = pl.input.line
              const p = pl.input.product
              const stock = stockMap && p?.track_stock ? (stockMap[l.product_id] ?? 0) : null
              const isEditing = editing === l.key
              return (
                <li key={l.key} className="px-4 py-3">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-sm font-medium text-slate-800">{l.name}</p>
                      <p className="text-xs text-slate-500">
                        {m(pl.input.unit_price)} / {l.unit}
                        {l.price_overridden && <span className="ml-1 text-amber-600">(precio cambiado)</span>}
                        {pl.discount > 0 && <span className="ml-1 text-emerald-600">−{m(pl.discount)}</span>}
                      </p>
                      {stock != null && l.quantity > stock && (
                        <p className="text-xs text-amber-600">Existencia en esta sucursal: {fmtQty(stock)}</p>
                      )}
                    </div>
                    <p className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">{m(pl.total)}</p>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <div className="flex items-center rounded-xl border border-slate-200">
                      <button
                        type="button"
                        aria-label="Restar uno"
                        onClick={() =>
                          l.quantity <= 1 ? onRemoveLine(l.key) : onUpdateLine(l.key, { quantity: r3(l.quantity - 1) })
                        }
                        className="flex h-10 w-10 items-center justify-center text-slate-600 hover:bg-slate-50"
                      >
                        <Minus className="h-4 w-4" />
                      </button>
                      <NumberInput
                        aria-label={`Cantidad de ${l.name}`}
                        value={l.quantity}
                        decimals={3}
                        onCommit={(n) => (n > 0 ? onUpdateLine(l.key, { quantity: n }) : onRemoveLine(l.key))}
                        className="h-10 w-16 rounded-none border-0 px-1 text-center shadow-none focus:ring-0"
                      />
                      <button
                        type="button"
                        aria-label="Sumar uno"
                        onClick={() => onUpdateLine(l.key, { quantity: r3(l.quantity + 1) })}
                        className="flex h-10 w-10 items-center justify-center text-slate-600 hover:bg-slate-50"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="ml-auto flex items-center gap-1">
                      {(canDiscount || canOverride) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Precio y descuento"
                          aria-pressed={isEditing}
                          onClick={() => setEditing(isEditing ? null : l.key)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" aria-label="Quitar línea" onClick={() => onRemoveLine(l.key)}>
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                  </div>
                  {isEditing && (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {canOverride && (
                        <Field label="Precio unitario">
                          <NumberInput
                            value={pl.input.unit_price}
                            decimals={2}
                            onCommit={(n) => {
                              const catalog = p ? Number(p.price) : l.unit_price
                              if (n < 0) return
                              onUpdateLine(l.key, { unit_price: n, price_overridden: n !== catalog })
                            }}
                          />
                        </Field>
                      )}
                      {canDiscount && (
                        <Field label="Descuento (monto)">
                          <NumberInput
                            value={l.discount}
                            decimals={2}
                            onCommit={(n) => onUpdateLine(l.key, { discount: Math.max(0, Math.min(n, pl.gross)) })}
                          />
                        </Field>
                      )}
                      {l.price_overridden && p && (
                        <button
                          type="button"
                          className="col-span-2 text-left text-xs font-medium text-brand-700 underline"
                          onClick={() => onUpdateLine(l.key, { unit_price: Number(p.price), price_overridden: false })}
                        >
                          Volver al precio de catálogo ({m(Number(p.price))})
                        </button>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Opciones y totales */}
      <div className="space-y-3 border-t border-slate-100 px-4 py-3">
        {ecfModule && (
          <Field
            label="Comprobante"
            error={ecfError}
            hint={!ecfEnabled ? 'La facturación electrónica no está activada en esta empresa.' : undefined}
          >
            <Select
              value={ecfType}
              onChange={(e) => onPatch({ ecfType: e.target.value as EcfChoice })}
              disabled={!ecfEnabled}
            >
              <option value="">Sin comprobante fiscal</option>
              <option value="32">e-CF 32 · Consumo</option>
              <option value="31">e-CF 31 · Crédito fiscal</option>
            </Select>
          </Field>
        )}

        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          className="text-sm font-medium text-brand-700"
          aria-expanded={moreOpen}
        >
          {moreOpen ? 'Ocultar opciones' : 'Vendedor, nota y descuento general'}
        </button>
        {moreOpen && (
          <div className="space-y-3">
            {sellers.length > 1 && (
              <Field label="Vendedor">
                <Select value={sellerId ?? ''} onChange={(e) => onPatch({ sellerId: e.target.value || null })}>
                  {sellers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {canDiscount && (
              <Field label="Descuento general (monto)">
                <NumberInput
                  value={cart.globalDiscount}
                  decimals={2}
                  onCommit={(n) => onPatch({ globalDiscount: Math.max(0, n) })}
                />
              </Field>
            )}
            <Field label="Nota de la venta">
              <Textarea rows={2} value={cart.notes} onChange={(e) => onPatch({ notes: e.target.value })} />
            </Field>
          </div>
        )}

        <dl className="space-y-1 text-sm">
          <TotalRow label={`Subtotal (${fmtQty(itemCount)} art.)`} value={m(priced.subtotal)} />
          {priced.discount_total > 0 && <TotalRow label="Descuento" value={`−${m(priced.discount_total)}`} />}
          <TotalRow label="ITBIS" value={m(priced.tax_total)} />
          <div className="flex items-baseline justify-between pt-1">
            <dt className="text-base font-semibold text-slate-800">Total</dt>
            <dd className="text-2xl font-bold tabular-nums text-slate-900">{m(priced.total)}</dd>
          </div>
        </dl>

        <div className="flex gap-2">
          {cart.lines.length > 0 && (
            <Button variant="outline" size="lg" onClick={onClear} aria-label="Vaciar carrito">
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Button size="lg" className="flex-1" onClick={onCharge} disabled={!cart.lines.length} loading={charging}>
            Cobrar {m(priced.total)} <span className="hidden text-xs opacity-75 lg:inline">(F9)</span>
          </Button>
        </div>
      </div>

      <CustomerPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        customers={customers}
        balances={balances}
        currency={currency}
        onPick={(c) => {
          onPatch({ customerId: c?.id ?? null })
          setPickerOpen(false)
        }}
      />
    </div>
  )
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-slate-600">
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}

/**
 * Campo numérico que confirma al salir o con Enter. Mientras se escribe guarda
 * el texto tal cual: con un `value={number}` directo, teclear "1." o borrar
 * para escribir otra cifra saltaría a 0 a mitad de camino.
 */
function NumberInput({
  value,
  onCommit,
  decimals,
  className,
  ...rest
}: {
  value: number
  onCommit: (n: number) => void
  decimals: number
  className?: string
  'aria-label'?: string
}) {
  const [text, setText] = useState(String(value))
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setText(String(value))
  }, [value, focused])
  const commit = () => {
    const n = parseNum(text)
    if (Number.isNaN(n)) {
      setText(String(value))
      return
    }
    const f = 10 ** decimals
    onCommit(Math.round(n * f) / f)
  }
  return (
    <Input
      {...rest}
      inputMode="decimal"
      value={text}
      onFocus={(e) => {
        setFocused(true)
        e.currentTarget.select()
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setFocused(false)
        commit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
          e.currentTarget.blur()
        }
      }}
      className={className}
    />
  )
}

// ── Selector de cliente ─────────────────────────────────────────────────────

function CustomerPickerModal({
  open,
  onClose,
  customers,
  balances,
  currency,
  onPick,
}: {
  open: boolean
  onClose: () => void
  customers: Customer[]
  balances: Record<string, CustomerBalance>
  currency: string
  onPick: (c: Customer | null) => void
}) {
  const [q, setQ] = useState('')
  const list = useMemo(() => {
    const needle = fold(q.trim())
    const digits = q.replace(/\D/g, '')
    return customers
      .filter((c) => c.is_active)
      .filter(
        (c) =>
          !needle ||
          fold(c.name).includes(needle) ||
          (digits.length >= 3 &&
            ((c.doc_number ?? '').replace(/\D/g, '').includes(digits) || (c.phone ?? '').replace(/\D/g, '').includes(digits))),
      )
      .slice(0, 50)
  }, [customers, q])

  return (
    <Modal open={open} onClose={onClose} title="Elegir cliente">
      <div className="space-y-3">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Nombre, RNC, cédula o teléfono"
          autoFocus={finePointer()}
          aria-label="Buscar cliente"
        />
        <button
          type="button"
          onClick={() => onPick(null)}
          className="w-full rounded-xl border border-dashed border-slate-300 px-3 py-2.5 text-left text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          Consumidor final (sin cliente)
        </button>
        {list.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">No hay clientes que coincidan.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {list.map((c) => {
              const bal = balances[c.id]?.balance ?? 0
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onPick(c)}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-800">{c.name}</span>
                      <span className="block truncate text-xs text-slate-500">
                        {[c.doc_number, c.phone].filter(Boolean).join(' · ') || 'Sin documento'}
                      </span>
                    </span>
                    {bal > 0 && <Badge tone="amber">Debe {money(bal, currency)}</Badge>}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <p className="text-xs text-slate-500">
          ¿No está? Créalo en{' '}
          <Link to="/clientes" className="font-medium text-brand-700 underline">
            Clientes
          </Link>{' '}
          y vuelve aquí: el carrito se conserva.
        </p>
      </div>
    </Modal>
  )
}

// ── Cobro ───────────────────────────────────────────────────────────────────

const PAY_ICON: Record<PayMethod, ReactNode> = {
  cash: <Banknote className="h-5 w-5" />,
  card: <CreditCard className="h-5 w-5" />,
  transfer: <ArrowRightLeft className="h-5 w-5" />,
  credit: <HandCoins className="h-5 w-5" />,
}

function ChargeModal({
  currency,
  total,
  localTotal,
  totalLoading,
  totalError,
  onRetryTotal,
  customer,
  creditAvailable,
  allowCredit,
  submitting,
  error,
  onClose,
  onConfirm,
}: {
  currency: string
  /** Total de la base (null mientras llega). */
  total: number | null
  localTotal: number
  totalLoading: boolean
  totalError: string | null
  onRetryTotal: () => void
  customer: Customer | null
  creditAvailable: number
  allowCredit: boolean
  submitting: boolean
  error: string | null
  onClose: () => void
  onConfirm: (payments: SalePaymentPayload[]) => void
}) {
  const m = (n: number) => money(n, currency)
  const [amounts, setAmounts] = useState<Record<PayMethod, string>>({ cash: '', card: '', transfer: '', credit: '' })
  const [refs, setRefs] = useState<{ card: string; transfer: string }>({ card: '', transfer: '' })
  const cashRef = useRef<HTMLInputElement>(null)

  const due = total ?? localTotal
  const val = (k: PayMethod) => {
    const n = parseNum(amounts[k])
    return Number.isNaN(n) || n < 0 ? 0 : r2(n)
  }
  const cash = val('cash')
  const card = val('card')
  const transfer = val('transfer')
  const credit = allowCredit ? val('credit') : 0
  const nonCash = r2(card + transfer + credit)
  const paid = r2(cash + nonCash)
  const missing = r2(Math.max(0, due - paid))
  const change = r2(Math.max(0, paid - due))
  const cashNeeded = r2(Math.max(0, due - nonCash))

  // Mismas reglas que create_sale(); aquí solo para avisar antes de enviar.
  let problem: string | null = null
  if (nonCash > due + 0.001) problem = 'Tarjeta, transferencia y crédito no pueden superar el total.'
  else if (credit > 0 && !customer) problem = 'Para vender a crédito selecciona un cliente.'
  else if (credit > 0 && change > 0) problem = 'Una venta a crédito no lleva devuelta: ajusta los montos.'
  else if (credit > 0 && credit > creditAvailable + 0.001)
    problem = `El crédito disponible de ${customer?.name ?? 'este cliente'} es ${m(Math.max(0, creditAvailable))}.`

  const ready = total != null && !totalLoading && !totalError
  const canConfirm = ready && !problem && missing === 0 && !submitting

  const set = (k: PayMethod, v: string) => setAmounts((a) => ({ ...a, [k]: v }))
  /** Rellena un método con lo que falta, sin contar lo que ese método ya tenía. */
  const fill = (k: PayMethod) => {
    const others = r2(paid - val(k))
    set(k, String(r2(Math.max(0, due - others))))
  }

  const quick = useMemo(() => {
    if (cashNeeded <= 0) return []
    const opts = [cashNeeded]
    for (const step of [100, 500, 1000, 2000]) {
      const v = Math.ceil(cashNeeded / step) * step
      if (v > cashNeeded && !opts.includes(v)) opts.push(v)
    }
    return opts.slice(0, 5)
  }, [cashNeeded])

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (!canConfirm) return
    const payments: SalePaymentPayload[] = []
    if (cash > 0) payments.push({ method: 'cash', amount: cash })
    if (card > 0) payments.push({ method: 'card', amount: card, reference: refs.card.trim() || null })
    if (transfer > 0) payments.push({ method: 'transfer', amount: transfer, reference: refs.transfer.trim() || null })
    if (credit > 0) payments.push({ method: 'credit', amount: credit })
    onConfirm(payments)
  }

  const methods: PayMethod[] = allowCredit ? ['cash', 'card', 'transfer', 'credit'] : ['cash', 'card', 'transfer']

  return (
    <Modal
      open
      onClose={onClose}
      title="Cobrar"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button onClick={() => submit()} disabled={!canConfirm} loading={submitting}>
            Confirmar cobro
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-2xl bg-slate-900 px-4 py-3 text-white">
          <p className="text-xs uppercase tracking-wide text-slate-300">Total a cobrar</p>
          {totalLoading ? (
            <p className="flex items-center gap-2 py-1 text-lg">
              <Spinner size="sm" className="text-white" /> Calculando…
            </p>
          ) : (
            <p className="text-3xl font-bold tabular-nums">{m(due)}</p>
          )}
          {totalError && (
            <div className="mt-2 flex items-center justify-between gap-2 text-sm text-red-200">
              <span>{totalError}</span>
              <button type="button" className="shrink-0 font-semibold underline" onClick={onRetryTotal}>
                Reintentar
              </button>
            </div>
          )}
        </div>

        {methods.map((k) => {
          const disabled = k === 'credit' && !customer
          return (
            <div key={k} className="space-y-2">
              <div className="flex items-end gap-2">
                <Field
                  className="flex-1"
                  label={
                    <span className="flex items-center gap-1.5">
                      {PAY_ICON[k]} {k === 'cash' ? 'Efectivo recibido' : PAYMENT_METHOD_LABEL[k]}
                    </span>
                  }
                  hint={
                    k === 'credit'
                      ? customer
                        ? `Disponible: ${m(Math.max(0, creditAvailable))}`
                        : 'Selecciona un cliente para vender a crédito.'
                      : undefined
                  }
                >
                  <Input
                    ref={k === 'cash' ? cashRef : undefined}
                    inputMode="decimal"
                    placeholder="0.00"
                    value={amounts[k]}
                    disabled={disabled}
                    onChange={(e) => set(k, e.target.value)}
                    autoFocus={k === 'cash' && finePointer()}
                    className="text-lg"
                  />
                </Field>
                {k !== 'cash' && (
                  <Button type="button" variant="outline" disabled={disabled} onClick={() => fill(k)}>
                    Completar
                  </Button>
                )}
              </div>
              {k === 'cash' && quick.length > 0 && (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {quick.map((v, i) => (
                    <Button
                      key={v}
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        set('cash', String(v))
                        cashRef.current?.focus()
                      }}
                    >
                      {i === 0 ? 'Exacto' : m(v)}
                    </Button>
                  ))}
                </div>
              )}
              {(k === 'card' || k === 'transfer') && val(k) > 0 && (
                <Input
                  placeholder={k === 'card' ? 'Referencia / aprobación (opcional)' : 'Referencia de la transferencia (opcional)'}
                  value={refs[k]}
                  onChange={(e) => setRefs((r) => ({ ...r, [k]: e.target.value }))}
                />
              )}
            </div>
          )
        })}

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

        {(problem || error) && (
          <p className="rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{problem ?? error}</p>
        )}
        {/* Botón oculto: Enter en cualquier campo confirma el cobro. */}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  )
}

// ── Venta registrada ────────────────────────────────────────────────────────

function SaleSuccess({
  result,
  currency,
}: {
  result: CreateSaleResult & { customerName: string | null }
  currency: string
}) {
  const m = (n: number) => money(n, currency)
  return (
    <div className="space-y-4 text-center">
      <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
      <div>
        <p className="text-sm text-slate-500">Venta {result.number}</p>
        <p className="text-2xl font-bold tabular-nums text-slate-900">{m(result.total)}</p>
        {result.customerName && <p className="text-sm text-slate-500">{result.customerName}</p>}
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
