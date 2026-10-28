import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ArrowLeftRight,
  Boxes,
  ClipboardCheck,
  ClipboardList,
  DollarSign,
  FileText,
  History,
  PackageX,
  Search,
  SlidersHorizontal,
  Tag,
  X,
} from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { RequireAccess } from '@/components/RequireAccess'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Badge } from '@/components/ui/Badge'
import { Segmented } from '@/components/ui/Segmented'
import { StatCard } from '@/components/ui/StatCard'
import { Modal } from '@/components/ui/Modal'
import { ActionMenu, type ActionItem } from '@/components/ui/ActionMenu'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Pagination, paginate } from '@/components/ui/Pagination'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useAuth } from '@/auth/AuthProvider'
import { useBranches, useCategories, useProducts, useStockMap } from '@/hooks/core'
import {
  DOCUMENTS_LIMIT,
  KARDEX_LIMIT,
  useAllStock,
  useInventoryDocumentMovements,
  useInventoryDocuments,
  useInventoryValuation,
  useKardex,
} from '@/hooks/inventory'
import { useMemberNames } from '@/hooks/team'
import { INVENTORY_KIND_LABEL } from '@/lib/labels'
import { errorMessage } from '@/lib/errors'
import { fmtDateTime, money, num } from '@/lib/format'
import { cn } from '@/lib/cn'
import type { Branch, InventoryDocument, InventoryMovement, Product } from '@/types/erp'
import { STOCK_STATUS, fmtQty, productHaystack, productLabel, stockStatus, type StockStatus } from '@/features/products/catalog'
import { ProductPicker } from './ProductPicker'
import { AdjustModal, CountModal, TransferModal } from './InventoryModals'

type Tab = 'stock' | 'kardex' | 'docs'
type StockFilter = 'all' | 'alert' | 'out' | 'negative' | 'positive'

const DOC_KIND: Record<InventoryDocument['kind'], { label: string; tone: 'brand' | 'amber' | 'green' }> = {
  adjustment: { label: 'Ajuste', tone: 'brand' },
  transfer: { label: 'Transferencia', tone: 'amber' },
  count: { label: 'Conteo físico', tone: 'green' },
}

const STOCK_PAGE = 50
const KARDEX_PAGE = 50
const DOCS_PAGE = 30

/** Cantidad con signo y color: verde entra, rojo sale. */
function SignedQty({ qty }: { qty: number }) {
  return (
    <span className={cn('font-semibold tabular-nums', qty > 0 ? 'text-emerald-600' : 'text-red-600')}>
      {qty > 0 ? '+' : ''}
      {fmtQty(qty)}
    </span>
  )
}

export function InventoryPage() {
  return (
    <RequireAccess module="inventory" perm="inventory.view">
      <InventoryContent />
    </RequireAccess>
  )
}

type Dialog =
  | { kind: 'adjust'; product?: Product | null }
  | { kind: 'transfer' }
  | { kind: 'count' }
  | null

function InventoryContent() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const productsQ = useProducts()
  const branchesQ = useBranches()

  const branches = useMemo(() => (branchesQ.data ?? []).filter((b) => b.is_active), [branchesQ.data])
  const mainBranch = branches.find((b) => b.is_main) ?? branches[0]
  const [branchId, setBranchId] = useState('')
  const effectiveBranch = branchId || mainBranch?.id || ''

  // Desde Productos se llega con ?producto=<id> para abrir directamente su kardex.
  const paramProduct = params.get('producto')
  const [tab, setTab] = useState<Tab>(paramProduct ? 'kardex' : 'stock')
  const [kardexProduct, setKardexProduct] = useState<string | null>(paramProduct)
  useEffect(() => {
    if (paramProduct) {
      setTab('kardex')
      setKardexProduct(paramProduct)
    }
  }, [paramProduct])

  const [dialog, setDialog] = useState<Dialog>(null)

  const tracked = useMemo(() => (productsQ.data ?? []).filter((p) => p.track_stock), [productsQ.data])
  const trackedActive = useMemo(() => tracked.filter((p) => p.is_active), [tracked])

  const canAdjust = can('inventory.adjust')
  const canTransfer = can('inventory.transfer') && branches.length >= 2

  const openKardex = (productId: string) => {
    setKardexProduct(productId)
    setTab('kardex')
  }

  const pickKardexProduct = (id: string | null) => {
    setKardexProduct(id)
    // El parámetro solo sirve para entrar; si se queda, al elegir otro producto
    // y recargar volvería el primero.
    if (params.has('producto')) {
      params.delete('producto')
      setParams(params, { replace: true })
    }
  }

  const actions: ActionItem[] = []
  if (canAdjust) {
    actions.push({ label: 'Ajuste', icon: <SlidersHorizontal className="h-4 w-4" />, onClick: () => setDialog({ kind: 'adjust' }), hint: 'Entrada o salida manual' })
  }
  if (canTransfer) {
    actions.push({ label: 'Transferencia', icon: <ArrowLeftRight className="h-4 w-4" />, onClick: () => setDialog({ kind: 'transfer' }), hint: 'Mover mercancía entre sucursales' })
  }
  if (canAdjust) {
    actions.push({ label: 'Conteo físico', icon: <ClipboardCheck className="h-4 w-4" />, onClick: () => setDialog({ kind: 'count' }), hint: 'Cuadrar la existencia con lo contado' })
  }

  if (productsQ.isLoading || branchesQ.isLoading) return <PageLoader label="Cargando inventario…" />
  if (productsQ.isError || branchesQ.isError) {
    return (
      <div>
        <PageHeader title="Inventario" />
        <Card>
          <CardBody className="space-y-3 text-center">
            <p className="text-sm text-red-600">{errorMessage(productsQ.error ?? branchesQ.error, 'No se pudo cargar el inventario.')}</p>
            <Button
              variant="outline"
              onClick={() => {
                void productsQ.refetch()
                void branchesQ.refetch()
              }}
            >
              Reintentar
            </Button>
          </CardBody>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Inventario"
        description="Existencias por sucursal, kardex y documentos."
        action={
          actions.length > 0 && effectiveBranch ? (
            <>
              {/* En el teléfono no caben tres botones junto al título: ahí van
                  detrás del menú, y desde `sm` se ven todos. */}
              <div className="hidden gap-2 sm:flex">
                {actions.map((a) => (
                  <Button key={a.label} variant={a.label === 'Ajuste' ? 'primary' : 'outline'} onClick={a.onClick}>
                    {a.icon} {a.label}
                  </Button>
                ))}
              </div>
              <div className="flex gap-2 sm:hidden">
                <Button onClick={actions[0].onClick}>
                  {actions[0].icon} {actions[0].label}
                </Button>
                {actions.length > 1 && (
                  <ActionMenu items={actions.slice(1)} title="Movimientos de inventario" label="Más movimientos" className="border border-slate-200 bg-white" />
                )}
              </div>
            </>
          ) : undefined
        }
      />

      {/* `grid-cols-3` también en móvil: las tres etiquetas son cortas y caben a
          360 px; apiladas (lo que hace Segmented con tres opciones) empujarían el
          contenido una pantalla hacia abajo. Gana a `grid-cols-1` porque Tailwind
          emite la escala en orden. */}
      <Segmented
        className="grid-cols-3"
        value={tab}
        onChange={setTab}
        label="Sección"
        options={[
          { value: 'stock', label: 'Existencias' },
          { value: 'kardex', label: 'Kardex' },
          { value: 'docs', label: 'Movimientos' },
        ]}
      />

      {branches.length === 0 ? (
        <EmptyState icon={<Boxes className="h-6 w-6" />} title="Sin sucursales activas" description="Crea o activa una sucursal en Configuración para llevar inventario." />
      ) : (
        <>
          {tab === 'stock' && (
            <StockTab
              branches={branches}
              branchId={effectiveBranch}
              setBranchId={setBranchId}
              products={tracked}
              canAdjust={canAdjust}
              onKardex={openKardex}
              onAdjust={(p) => setDialog({ kind: 'adjust', product: p })}
            />
          )}
          {tab === 'kardex' && (
            <KardexTab branches={branches} products={tracked} productId={kardexProduct} setProductId={pickKardexProduct} />
          )}
          {tab === 'docs' && <DocumentsTab branches={branchesQ.data ?? []} products={productsQ.data ?? []} />}
        </>
      )}

      {dialog?.kind === 'adjust' && (
        <AdjustModal branches={branches} products={trackedActive} defaultBranchId={effectiveBranch} initialProduct={dialog.product} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'transfer' && (
        <TransferModal branches={branches} products={trackedActive} defaultBranchId={effectiveBranch} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'count' && (
        <CountModal branches={branches} products={trackedActive} defaultBranchId={effectiveBranch} onClose={() => setDialog(null)} />
      )}
    </div>
  )
}

// ── Existencias ─────────────────────────────────────────────────────────────

const STOCK_TEXT: Record<StockStatus, string> = {
  ok: 'text-slate-800',
  low: 'text-amber-600',
  out: 'text-red-600',
  negative: 'text-red-600',
}

function StockTab({
  branches,
  branchId,
  setBranchId,
  products,
  canAdjust,
  onKardex,
  onAdjust,
}: {
  branches: Branch[]
  branchId: string
  setBranchId: (id: string) => void
  /** Productos con control de existencia (activos e inactivos). */
  products: Product[]
  canAdjust: boolean
  onKardex: (productId: string) => void
  onAdjust: (p: Product) => void
}) {
  const { tenant } = useAuth()
  const currency = tenant?.currency ?? 'DOP'
  const stockQ = useStockMap(branchId)
  const valuationQ = useInventoryValuation(branchId)
  const { data: categories = [] } = useCategories()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<StockFilter>('all')
  const [page, setPage] = useState(0)

  const stock = useMemo(() => stockQ.data ?? {}, [stockQ.data])
  const categoryName = useMemo(() => Object.fromEntries(categories.map((c) => [c.id, c.name])), [categories])

  // Un inactivo solo se lista si aún tiene existencia: hay que poder sacarla.
  const rows = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return products
      .map((p) => {
        const qty = stock[p.id] ?? 0
        return { p, qty, status: stockStatus(qty, Number(p.min_stock)) }
      })
      .filter(({ p, qty, status }) => {
        if (!p.is_active && qty === 0) return false
        if (filter === 'alert' && !(status === 'negative' || status === 'low' || (status === 'out' && p.min_stock > 0))) return false
        if (filter === 'out' && status !== 'out') return false
        if (filter === 'negative' && status !== 'negative') return false
        if (filter === 'positive' && qty <= 0) return false
        if (terms.length && !terms.every((t) => productHaystack(p).includes(t))) return false
        return true
      })
  }, [products, stock, search, filter])

  const counts = useMemo(() => {
    let alert = 0
    let negative = 0
    for (const p of products) {
      if (!p.is_active) continue
      const st = stockStatus(stock[p.id] ?? 0, Number(p.min_stock))
      if (st === 'negative') negative++
      if (st === 'negative' || st === 'low' || (st === 'out' && p.min_stock > 0)) alert++
    }
    return { alert, negative }
  }, [products, stock])

  const { slice, safePage } = paginate(rows, page, STOCK_PAGE)
  const valuation = valuationQ.data

  const rowActions = (p: Product): ActionItem[] => {
    const items: ActionItem[] = [{ label: 'Ver kardex', icon: <History className="h-4 w-4" />, onClick: () => onKardex(p.id) }]
    if (canAdjust) items.push({ label: 'Ajustar existencia', icon: <SlidersHorizontal className="h-4 w-4" />, onClick: () => onAdjust(p) })
    return items
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Valor a costo"
          icon={<DollarSign className="h-5 w-5" />}
          value={valuationQ.isLoading ? '…' : money(valuation?.total_cost ?? 0, currency)}
          hint="Existencias positivas × costo"
        />
        <StatCard
          label="Valor de venta"
          icon={<Tag className="h-5 w-5" />}
          tone="green"
          value={valuationQ.isLoading ? '…' : money(valuation?.total_retail ?? 0, currency)}
          hint="Existencias positivas × precio"
        />
        <StatCard label="Con existencia" icon={<Boxes className="h-5 w-5" />} tone="slate" value={valuationQ.isLoading ? '…' : num(valuation?.products ?? 0)} hint="productos" />
        <StatCard
          label="Requieren atención"
          icon={<PackageX className="h-5 w-5" />}
          tone={counts.alert > 0 ? 'amber' : 'slate'}
          value={num(counts.alert)}
          hint={counts.negative > 0 ? `${num(counts.negative)} en negativo` : 'bajo mínimo o agotados'}
        />
      </div>
      {valuationQ.isError && <p className="text-sm text-red-600">{errorMessage(valuationQ.error, 'No se pudo calcular la valoración.')}</p>}

      <Card>
        <div className="grid gap-2 border-b border-slate-100 p-4 sm:grid-cols-[1fr_2fr_1fr]">
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} aria-label="Sucursal">
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(0)
              }}
              placeholder="Buscar producto, SKU o código…"
              className="pl-9"
              aria-label="Buscar"
            />
          </div>
          <Select
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as StockFilter)
              setPage(0)
            }}
            aria-label="Filtro"
          >
            <option value="all">Todos</option>
            <option value="alert">Requieren atención</option>
            <option value="out">Agotados</option>
            <option value="negative">En negativo</option>
            <option value="positive">Con existencia</option>
          </Select>
        </div>

        {stockQ.isLoading ? (
          <PageLoader label="Cargando existencias…" />
        ) : stockQ.isError ? (
          <p className="p-6 text-center text-sm text-red-600">{errorMessage(stockQ.error, 'No se pudieron cargar las existencias.')}</p>
        ) : products.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={<Boxes className="h-6 w-6" />} title="Ningún producto controla existencia" description="Activa «Controlar existencia» al crear o editar productos en Productos y servicios." />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={<Search className="h-6 w-6" />} title="Sin resultados" description="Ningún producto coincide con la búsqueda o el filtro." />
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3 font-medium">Producto</th>
                    <th className="px-4 py-3 font-medium">Categoría</th>
                    <th className="px-4 py-3 text-right font-medium">Existencia</th>
                    <th className="px-4 py-3 text-right font-medium">Mínimo</th>
                    <th className="px-4 py-3 text-right font-medium">Costo</th>
                    <th className="px-4 py-3 text-right font-medium">Valor</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    <th className="px-4 py-3">
                      <span className="sr-only">Acciones</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {slice.map(({ p, qty, status }) => (
                    <tr key={p.id} className="hover:bg-slate-50/60">
                      <td className="px-4 py-3">
                        <button onClick={() => onKardex(p.id)} className="block max-w-xs truncate text-left font-medium text-slate-800 hover:text-brand-600">
                          {productLabel(p)}
                        </button>
                        <p className="max-w-xs truncate text-xs text-slate-400">{[p.sku, p.barcode].filter(Boolean).join(' · ') || p.unit}</p>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{p.category_id ? categoryName[p.category_id] : '—'}</td>
                      <td className={cn('px-4 py-3 text-right font-semibold tabular-nums', STOCK_TEXT[status])}>
                        {fmtQty(qty)} <span className="text-xs font-normal text-slate-400">{p.unit}</span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-500">{p.min_stock > 0 ? fmtQty(p.min_stock) : '—'}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-600">{money(p.cost, currency)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-800">{money(Math.max(qty, 0) * Number(p.cost), currency)}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          <Badge tone={STOCK_STATUS[status].tone}>{STOCK_STATUS[status].label}</Badge>
                          {!p.is_active && <Badge tone="slate">Inactivo</Badge>}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end">
                          <ActionMenu title={productLabel(p)} items={rowActions(p)} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <DataList>
              {slice.map(({ p, qty, status }) => (
                <DataRow
                  key={p.id}
                  title={productLabel(p)}
                  titleExtra={[p.sku, p.barcode].filter(Boolean).join(' · ') || undefined}
                  onClick={() => onKardex(p.id)}
                  badges={
                    <>
                      <Badge tone={STOCK_STATUS[status].tone}>{STOCK_STATUS[status].label}</Badge>
                      {!p.is_active && <Badge tone="slate">Inactivo</Badge>}
                    </>
                  }
                  actions={<ActionMenu title={productLabel(p)} items={rowActions(p)} />}
                >
                  <DataFields cols={3}>
                    <DataField label="Existencia">
                      <span className={cn('tabular-nums', STOCK_TEXT[status])}>
                        {fmtQty(qty)} {p.unit}
                      </span>
                    </DataField>
                    <DataField label="Mínimo">{p.min_stock > 0 ? fmtQty(p.min_stock) : '—'}</DataField>
                    <DataField label="Valor">{money(Math.max(qty, 0) * Number(p.cost), currency)}</DataField>
                  </DataFields>
                </DataRow>
              ))}
            </DataList>
            <Pagination page={safePage} pageSize={STOCK_PAGE} total={rows.length} onPage={setPage} label="productos" />
          </>
        )}
      </Card>

      {valuation && valuation.by_category.length > 0 && (
        <Card>
          <CardHeader title="Valoración por categoría" subtitle="Solo existencias positivas de la sucursal." />
          <ul className="divide-y divide-slate-50">
            {valuation.by_category.map((c) => (
              <li key={c.category} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                <span className="min-w-0 truncate font-medium text-slate-700">{c.category}</span>
                <span className="shrink-0 text-right tabular-nums">
                  <span className="block text-slate-800">{money(c.cost_value, currency)}</span>
                  <span className="block text-xs text-slate-400">venta {money(c.retail_value, currency)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

// ── Kardex ──────────────────────────────────────────────────────────────────

function KardexTab({
  branches,
  products,
  productId,
  setProductId,
}: {
  branches: Branch[]
  products: Product[]
  productId: string | null
  setProductId: (id: string | null) => void
}) {
  const { tenant } = useAuth()
  const currency = tenant?.currency ?? 'DOP'
  const [branchId, setBranchId] = useState('')
  const [page, setPage] = useState(0)
  const product = products.find((p) => p.id === productId) ?? null
  const kardexQ = useKardex(product?.id, branchId || undefined)
  const { data: allStock = [] } = useAllStock()
  const names = useMemberNames()
  const branchName = useMemo(() => Object.fromEntries(branches.map((b) => [b.id, b.name])), [branches])

  const currentStock = useMemo(() => {
    if (!product) return 0
    return allStock
      .filter((s) => s.product_id === product.id && (!branchId || s.branch_id === branchId))
      .reduce((sum, s) => sum + Number(s.quantity), 0)
  }, [allStock, product, branchId])

  const movements = kardexQ.data ?? []
  const { slice, safePage } = paginate(movements, page, KARDEX_PAGE)
  const showBranch = !branchId && branches.length > 1

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-3">
          {product ? (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-slate-800">{productLabel(product)}</p>
                <p className="text-sm text-slate-500">
                  Existencia {branchId ? `en ${branchName[branchId] ?? ''}` : 'total'}:{' '}
                  <span className="font-semibold tabular-nums text-slate-800">
                    {fmtQty(currentStock)} {product.unit}
                  </span>
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setProductId(null)}>
                <X className="h-4 w-4" /> Cambiar
              </Button>
            </div>
          ) : (
            <Field label="Producto">
              <ProductPicker products={products} onPick={(p) => setProductId(p.id)} autoFocus />
            </Field>
          )}
          {branches.length > 1 && (
            <Field label="Sucursal">
              <Select
                value={branchId}
                onChange={(e) => {
                  setBranchId(e.target.value)
                  setPage(0)
                }}
              >
                <option value="">Todas las sucursales</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </CardBody>
      </Card>

      {!product ? (
        <EmptyState icon={<History className="h-6 w-6" />} title="Elige un producto" description="El kardex muestra cada entrada y salida con el saldo que dejó." />
      ) : (
        <Card>
          {kardexQ.isLoading ? (
            <PageLoader label="Cargando movimientos…" />
          ) : kardexQ.isError ? (
            <p className="p-6 text-center text-sm text-red-600">{errorMessage(kardexQ.error, 'No se pudo cargar el kardex.')}</p>
          ) : movements.length === 0 ? (
            <div className="p-4">
              <EmptyState icon={<History className="h-6 w-6" />} title="Sin movimientos" description="Este producto aún no ha tenido entradas ni salidas." />
            </div>
          ) : (
            <>
              {movements.length >= KARDEX_LIMIT && (
                <p className="border-b border-slate-100 px-4 py-2 text-xs text-slate-500">Se muestran los {num(KARDEX_LIMIT)} movimientos más recientes.</p>
              )}
              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-4 py-3 font-medium">Fecha</th>
                      {showBranch && <th className="px-4 py-3 font-medium">Sucursal</th>}
                      <th className="px-4 py-3 font-medium">Movimiento</th>
                      <th className="px-4 py-3 text-right font-medium">Cantidad</th>
                      <th className="px-4 py-3 text-right font-medium">Saldo</th>
                      <th className="px-4 py-3 text-right font-medium">Costo unit.</th>
                      <th className="px-4 py-3 font-medium">Motivo</th>
                      <th className="px-4 py-3 font-medium">Usuario</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {slice.map((m) => (
                      <tr key={m.id}>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-500">{fmtDateTime(m.created_at)}</td>
                        {showBranch && <td className="px-4 py-3 text-slate-600">{branchName[m.branch_id] ?? '—'}</td>}
                        <td className="px-4 py-3 text-slate-700">{INVENTORY_KIND_LABEL[m.kind]}</td>
                        <td className="px-4 py-3 text-right">
                          <SignedQty qty={m.quantity} />
                        </td>
                        <td className="px-4 py-3 text-right font-medium tabular-nums text-slate-800">{fmtQty(m.balance_after)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-600">{money(m.unit_cost, currency)}</td>
                        <td className="max-w-[16rem] truncate px-4 py-3 text-slate-600" title={m.reason ?? undefined}>
                          {m.reason ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-slate-600">{m.created_by ? (names[m.created_by] ?? '—') : 'Sistema'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <DataList>
                {slice.map((m) => (
                  <DataRow
                    key={m.id}
                    title={INVENTORY_KIND_LABEL[m.kind]}
                    titleExtra={fmtDateTime(m.created_at)}
                    subtitle={m.reason ?? undefined}
                    actions={<SignedQty qty={m.quantity} />}
                  >
                    <DataFields cols={3}>
                      <DataField label="Saldo">{fmtQty(m.balance_after)}</DataField>
                      <DataField label="Costo">{money(m.unit_cost, currency)}</DataField>
                      <DataField label={showBranch ? 'Sucursal' : 'Usuario'}>
                        {showBranch ? (branchName[m.branch_id] ?? '—') : m.created_by ? (names[m.created_by] ?? '—') : 'Sistema'}
                      </DataField>
                    </DataFields>
                  </DataRow>
                ))}
              </DataList>
              <Pagination page={safePage} pageSize={KARDEX_PAGE} total={movements.length} onPage={setPage} label="movimientos" />
              {showBranch && <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">El saldo es el de la sucursal de cada movimiento.</p>}
            </>
          )}
        </Card>
      )}
    </div>
  )
}

// ── Documentos ──────────────────────────────────────────────────────────────

function DocumentsTab({ branches, products }: { branches: Branch[]; products: Product[] }) {
  const docsQ = useInventoryDocuments()
  const names = useMemberNames()
  const [kind, setKind] = useState<'all' | InventoryDocument['kind']>('all')
  const [page, setPage] = useState(0)
  const [open, setOpen] = useState<InventoryDocument | null>(null)
  const branchName = useMemo(() => Object.fromEntries(branches.map((b) => [b.id, b.name])), [branches])

  const docs = useMemo(() => (docsQ.data ?? []).filter((d) => kind === 'all' || d.kind === kind), [docsQ.data, kind])
  const { slice, safePage } = paginate(docs, page, DOCS_PAGE)

  const where = (d: InventoryDocument) =>
    d.to_branch_id ? `${branchName[d.branch_id] ?? '—'} → ${branchName[d.to_branch_id] ?? '—'}` : (branchName[d.branch_id] ?? '—')

  return (
    <Card>
      <div className="border-b border-slate-100 p-4">
        <Select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as typeof kind)
            setPage(0)
          }}
          aria-label="Tipo de documento"
          className="sm:max-w-xs"
        >
          <option value="all">Todos los documentos</option>
          <option value="adjustment">Ajustes (AJ)</option>
          <option value="transfer">Transferencias (TR)</option>
          <option value="count">Conteos físicos (CF)</option>
        </Select>
      </div>
      {docsQ.isLoading ? (
        <PageLoader label="Cargando documentos…" />
      ) : docsQ.isError ? (
        <p className="p-6 text-center text-sm text-red-600">{errorMessage(docsQ.error, 'No se pudieron cargar los documentos.')}</p>
      ) : docs.length === 0 ? (
        <div className="p-4">
          <EmptyState icon={<ClipboardList className="h-6 w-6" />} title="Sin documentos" description="Aquí aparecerán los ajustes, transferencias y conteos físicos." />
        </div>
      ) : (
        <>
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3 font-medium">Número</th>
                  <th className="px-4 py-3 font-medium">Tipo</th>
                  <th className="px-4 py-3 font-medium">Sucursal</th>
                  <th className="px-4 py-3 text-right font-medium">Líneas</th>
                  <th className="px-4 py-3 font-medium">Nota</th>
                  <th className="px-4 py-3 font-medium">Usuario</th>
                  <th className="px-4 py-3 font-medium">Fecha</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {slice.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <button onClick={() => setOpen(d)} className="font-mono font-medium text-brand-700 hover:underline">
                        {d.number}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={DOC_KIND[d.kind].tone}>{DOC_KIND[d.kind].label}</Badge>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{where(d)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{num(d.lines)}</td>
                    <td className="max-w-[16rem] truncate px-4 py-3 text-slate-600" title={d.note ?? undefined}>
                      {d.note ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{d.created_by ? (names[d.created_by] ?? '—') : '—'}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-500">{fmtDateTime(d.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DataList>
            {slice.map((d) => (
              <DataRow
                key={d.id}
                title={d.number}
                titleExtra={fmtDateTime(d.created_at)}
                subtitle={d.note ?? undefined}
                onClick={() => setOpen(d)}
                badges={<Badge tone={DOC_KIND[d.kind].tone}>{DOC_KIND[d.kind].label}</Badge>}
                actions={
                  <Button variant="ghost" size="icon" onClick={() => setOpen(d)} aria-label={`Ver ${d.number}`}>
                    <FileText className="h-4 w-4" />
                  </Button>
                }
              >
                <DataFields>
                  <DataField label="Sucursal">{where(d)}</DataField>
                  <DataField label="Líneas">{num(d.lines)}</DataField>
                </DataFields>
              </DataRow>
            ))}
          </DataList>
          <Pagination page={safePage} pageSize={DOCS_PAGE} total={docs.length} onPage={setPage} label="documentos" />
          {(docsQ.data?.length ?? 0) >= DOCUMENTS_LIMIT && (
            <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">Se muestran los {num(DOCUMENTS_LIMIT)} documentos más recientes.</p>
          )}
        </>
      )}
      {open && <DocumentModal doc={open} branchName={branchName} products={products} onClose={() => setOpen(null)} where={where(open)} />}
    </Card>
  )
}

function DocumentModal({
  doc,
  branchName,
  products,
  where,
  onClose,
}: {
  doc: InventoryDocument
  branchName: Record<string, string>
  products: Product[]
  where: string
  onClose: () => void
}) {
  const { data: movements = [], isLoading, isError, error } = useInventoryDocumentMovements(doc.id)
  const names = useMemberNames()
  const productById = useMemo(() => Object.fromEntries(products.map((p) => [p.id, p])), [products])

  return (
    <Modal open onClose={onClose} title={`${DOC_KIND[doc.kind].label} ${doc.number}`} size="lg" footer={<Button variant="outline" onClick={onClose}>Cerrar</Button>}>
      <div className="space-y-4">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-400">Sucursal</dt>
            <dd className="font-medium text-slate-700">{where}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-400">Fecha</dt>
            <dd className="font-medium text-slate-700">{fmtDateTime(doc.created_at)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-400">Usuario</dt>
            <dd className="font-medium text-slate-700">{doc.created_by ? (names[doc.created_by] ?? '—') : '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-400">Nota</dt>
            <dd className="font-medium text-slate-700">{doc.note ?? '—'}</dd>
          </div>
        </dl>
        {isLoading ? (
          <PageLoader />
        ) : isError ? (
          <p className="text-sm text-red-600">{errorMessage(error, 'No se pudieron cargar las líneas.')}</p>
        ) : movements.length === 0 ? (
          <p className="rounded-xl bg-slate-50 px-3 py-4 text-center text-sm text-slate-500">
            {doc.kind === 'count' ? 'Todo lo contado cuadraba: no hubo diferencias que ajustar.' : 'Este documento no tiene movimientos.'}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {movements.map((m: InventoryMovement) => {
              const p = productById[m.product_id]
              return (
                <li key={m.id} className="flex items-start justify-between gap-3 p-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-800">{p ? productLabel(p) : 'Producto'}</p>
                    <p className="text-xs text-slate-500">
                      {INVENTORY_KIND_LABEL[m.kind]}
                      {doc.kind === 'transfer' && ` · ${branchName[m.branch_id] ?? ''}`} · saldo {fmtQty(m.balance_after)}
                    </p>
                  </div>
                  <SignedQty qty={m.quantity} />
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}
