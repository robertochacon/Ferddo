import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Boxes,
  Download,
  History,
  ImageOff,
  ListOrdered,
  Package,
  Pencil,
  Plus,
  Power,
  Search,
  Tags,
  Upload,
  Wrench,
} from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Badge } from '@/components/ui/Badge'
import { ActionMenu, type ActionItem } from '@/components/ui/ActionMenu'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Pagination, paginate } from '@/components/ui/Pagination'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/auth/AuthProvider'
import { useBranches, useCategories, useProducts, useTaxes } from '@/hooks/core'
import { useAllStock } from '@/hooks/inventory'
import { useUpdateProduct } from '@/hooks/products'
import { downloadCsv, toCsv } from '@/lib/csv'
import { errorMessage } from '@/lib/errors'
import { money } from '@/lib/format'
import { cn } from '@/lib/cn'
import type { Product } from '@/types/erp'
import { ProductFormModal } from './ProductFormModal'
import { CategoriesModal } from './CategoriesModal'
import { ImportProductsModal } from './ImportProductsModal'
import { PriceListsModal } from './PriceListsModal'
import {
  STOCK_STATUS,
  fmtQty,
  isLowStock,
  marginPct,
  productHaystack,
  productLabel,
  stockStatus,
  type StockStatus,
} from './catalog'

const PAGE_SIZE = 50

type KindFilter = 'all' | 'product' | 'service'
type StatusFilter = 'active' | 'inactive' | 'all'

const STOCK_TEXT: Record<StockStatus, string> = {
  ok: 'text-slate-700',
  low: 'font-semibold text-amber-600',
  out: 'font-semibold text-red-600',
  negative: 'font-semibold text-red-600',
}

/** Lo que se ve en la columna de existencia, según el tipo de artículo. */
function StockCell({ p, qty }: { p: Product; qty: number }) {
  if (p.kind === 'service') return <span className="text-slate-400">—</span>
  if (!p.track_stock) return <span className="text-xs text-slate-400">Sin control</span>
  return (
    <span className={cn('tabular-nums', STOCK_TEXT[stockStatus(qty, p.min_stock)])}>
      {fmtQty(qty)} <span className="text-xs font-normal text-slate-400">{p.unit}</span>
    </span>
  )
}

function Thumb({ url }: { url: string | null }) {
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
      {url ? <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" /> : <ImageOff className="h-4 w-4 text-slate-300" />}
    </div>
  )
}

/**
 * Catálogo único de productos y servicios (`/productos`).
 *
 * Todo se filtra en el cliente: el catálogo entero ya está en cache para el
 * POS (`['products']`), así que pedir páginas al servidor solo añadiría
 * viajes. Las existencias salen de `stock_levels` de todas las sucursales y se
 * suman, o se toma la de la sucursal elegida.
 */
export function ProductsPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const { tenant, can, hasModule } = useAuth()
  const currency = tenant?.currency ?? 'DOP'
  const canManage = can('products.manage')
  const canManagePrices = can('prices.manage')
  const canSeeInventory = hasModule('inventory') && can('inventory.view')

  const productsQ = useProducts()
  const { data: categories = [] } = useCategories()
  const { data: taxes = [] } = useTaxes()
  const { data: branches = [] } = useBranches()
  const { data: allStock = [] } = useAllStock()
  const update = useUpdateProduct()

  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<KindFilter>('all')
  const [category, setCategory] = useState('all')
  const [status, setStatus] = useState<StatusFilter>('active')
  const [lowOnly, setLowOnly] = useState(false)
  const [branch, setBranch] = useState('all')
  const [page, setPage] = useState(0)

  const [editing, setEditing] = useState<Product | null>(null)
  const [creating, setCreating] = useState(false)
  const [showCategories, setShowCategories] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showPriceLists, setShowPriceLists] = useState(false)

  const products = useMemo(() => productsQ.data ?? [], [productsQ.data])

  const stockOf = useMemo(() => {
    const m: Record<string, number> = {}
    for (const s of allStock) {
      if (branch !== 'all' && s.branch_id !== branch) continue
      m[s.product_id] = (m[s.product_id] ?? 0) + Number(s.quantity)
    }
    return m
  }, [allStock, branch])

  const categoryName = useMemo(() => Object.fromEntries(categories.map((c) => [c.id, c.name])), [categories])
  const taxById = useMemo(() => Object.fromEntries(taxes.map((t) => [t.id, t])), [taxes])
  const productName = useMemo(() => Object.fromEntries(products.map((p) => [p.id, p.name])), [products])

  const filtered = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return products.filter((p) => {
      if (kind !== 'all' && p.kind !== kind) return false
      if (status === 'active' && !p.is_active) return false
      if (status === 'inactive' && p.is_active) return false
      if (category === 'none' && p.category_id) return false
      if (category !== 'all' && category !== 'none' && p.category_id !== category) return false
      if (lowOnly && !isLowStock(p, stockOf[p.id] ?? 0)) return false
      if (terms.length) {
        const hay = productHaystack(p)
        if (!terms.every((t) => hay.includes(t))) return false
      }
      return true
    })
  }, [products, kind, status, category, lowOnly, search, stockOf])

  const { slice, safePage } = paginate(filtered, page, PAGE_SIZE)
  const lowCount = useMemo(
    () => products.filter((p) => p.is_active && isLowStock(p, stockOf[p.id] ?? 0)).length,
    [products, stockOf],
  )

  // Cualquier cambio de filtro vuelve a la primera página.
  const withReset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v)
    setPage(0)
  }

  const toggleActive = async (p: Product) => {
    try {
      await update.mutateAsync({ id: p.id, patch: { is_active: !p.is_active } })
      toast.success(p.is_active ? 'Desactivado: ya no aparece en ventas' : 'Activado')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo actualizar'))
    }
  }

  const exportCsv = () => {
    // Mismas columnas que la importación: el archivo exportado se puede editar
    // en Excel y volver a subir para actualizar precios en bloque.
    const rows = filtered.map((p) => ({
      name: p.name,
      sku: p.sku ?? '',
      barcode: p.barcode ?? '',
      code: p.code ?? '',
      description: p.description ?? '',
      category: p.category_id ? (categoryName[p.category_id] ?? '') : '',
      brand: p.brand ?? '',
      unit: p.unit,
      cost: Number(p.cost),
      price: Number(p.price),
      tax_code: p.tax_id ? (taxById[p.tax_id]?.code ?? '') : '',
      kind: p.kind === 'service' ? 'servicio' : 'producto',
      track_stock: p.track_stock ? 'si' : 'no',
      min_stock: Number(p.min_stock),
      stock: p.track_stock ? (stockOf[p.id] ?? 0) : '',
      variant_of: p.parent_id ? (productName[p.parent_id] ?? '') : '',
      variant_label: p.variant_label ?? '',
      active: p.is_active ? 'si' : 'no',
    }))
    downloadCsv(`catalogo-${new Date().toISOString().slice(0, 10)}`, toCsv(rows))
  }

  const actionsFor = (p: Product): ActionItem[] => {
    const items: ActionItem[] = []
    if (canManage) {
      items.push({ label: 'Editar', icon: <Pencil className="h-4 w-4" />, onClick: () => setEditing(p) })
      items.push({
        label: p.is_active ? 'Desactivar' : 'Activar',
        icon: <Power className="h-4 w-4" />,
        tone: p.is_active ? 'danger' : 'success',
        hint: p.is_active ? 'Deja de venderse; el historial se conserva' : undefined,
        onClick: () => void toggleActive(p),
      })
    }
    if (canSeeInventory && p.track_stock) {
      items.push({
        label: 'Ver kardex',
        icon: <History className="h-4 w-4" />,
        onClick: () => navigate(`/inventario?producto=${p.id}`),
      })
    }
    return items
  }

  const headerMenu: ActionItem[] = [
    { label: 'Exportar CSV', icon: <Download className="h-4 w-4" />, onClick: exportCsv, hint: `${filtered.length} según los filtros`, disabled: filtered.length === 0 },
  ]
  if (canManage) {
    headerMenu.unshift(
      { label: 'Categorías', icon: <Tags className="h-4 w-4" />, onClick: () => setShowCategories(true) },
      { label: 'Importar CSV', icon: <Upload className="h-4 w-4" />, onClick: () => setShowImport(true) },
    )
  }

  const branchName = branch === 'all' ? null : branches.find((b) => b.id === branch)?.name

  return (
    <div>
      <PageHeader
        title="Productos y servicios"
        description="Catálogo, precios y existencias."
        action={
          <>
            <ActionMenu items={headerMenu} title="Catálogo" label="Más acciones del catálogo" className="border border-slate-200 bg-white" />
            {canManagePrices && (
              <Button variant="outline" onClick={() => setShowPriceLists(true)} disabled={productsQ.isLoading}>
                {/* A 360 px no caben tres botones con el texto largo. */}
                <ListOrdered className="h-4 w-4" /> <span className="sm:hidden">Precios</span>
                <span className="hidden sm:inline">Listas de precios</span>
              </Button>
            )}
            {canManage && (
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> Nuevo
              </Button>
            )}
          </>
        }
      />

      <Card>
        {/* Filtros */}
        <div className="space-y-3 border-b border-slate-100 p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={search}
              onChange={(e) => withReset(setSearch)(e.target.value)}
              placeholder="Buscar por nombre, SKU, código de barras o marca…"
              className="pl-9"
              aria-label="Buscar"
            />
          </div>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
            <Select value={kind} onChange={(e) => withReset(setKind)(e.target.value as KindFilter)} aria-label="Tipo">
              <option value="all">Productos y servicios</option>
              <option value="product">Solo productos</option>
              <option value="service">Solo servicios</option>
            </Select>
            <Select value={category} onChange={(e) => withReset(setCategory)(e.target.value)} aria-label="Categoría">
              <option value="all">Todas las categorías</option>
              <option value="none">Sin categoría</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Select value={status} onChange={(e) => withReset(setStatus)(e.target.value as StatusFilter)} aria-label="Estado">
              <option value="active">Activos</option>
              <option value="inactive">Inactivos</option>
              <option value="all">Activos e inactivos</option>
            </Select>
            <Select value={branch} onChange={(e) => setBranch(e.target.value)} aria-label="Sucursal para la existencia">
              <option value="all">Existencia: todas</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  Existencia: {b.name}
                </option>
              ))}
            </Select>
            <label
              className={cn(
                'col-span-2 flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border px-3 text-sm font-medium lg:col-span-1',
                lowOnly ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-slate-300 bg-white text-slate-600',
              )}
            >
              <input type="checkbox" checked={lowOnly} onChange={(e) => withReset(setLowOnly)(e.target.checked)} className="h-4 w-4 rounded" />
              Bajo stock{lowCount > 0 && <Badge tone="amber">{lowCount}</Badge>}
            </label>
          </div>
        </div>

        {productsQ.isLoading ? (
          <PageLoader label="Cargando catálogo…" />
        ) : productsQ.isError ? (
          <div className="space-y-3 p-6 text-center">
            <p className="text-sm text-red-600">{errorMessage(productsQ.error, 'No se pudo cargar el catálogo.')}</p>
            <Button variant="outline" onClick={() => void productsQ.refetch()} loading={productsQ.isFetching}>
              Reintentar
            </Button>
          </div>
        ) : products.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<Package className="h-6 w-6" />}
              title="Tu catálogo está vacío"
              description="Crea tus productos y servicios uno a uno o impórtalos desde una hoja de cálculo."
              action={
                canManage ? (
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button onClick={() => setCreating(true)}>
                      <Plus className="h-4 w-4" /> Nuevo
                    </Button>
                    <Button variant="outline" onClick={() => setShowImport(true)}>
                      <Upload className="h-4 w-4" /> Importar CSV
                    </Button>
                  </div>
                ) : undefined
              }
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={<Search className="h-6 w-6" />} title="Sin resultados" description="Ningún artículo coincide con la búsqueda o los filtros." />
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3 font-medium">Artículo</th>
                    <th className="px-4 py-3 font-medium">Categoría</th>
                    <th className="px-4 py-3 text-right font-medium">Costo</th>
                    <th className="px-4 py-3 text-right font-medium">Precio</th>
                    <th className="px-4 py-3 text-right font-medium">Margen</th>
                    <th className="px-4 py-3 text-right font-medium">{branchName ? `Exist. ${branchName}` : 'Existencia'}</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    <th className="px-4 py-3 text-right font-medium">
                      <span className="sr-only">Acciones</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {slice.map((p) => {
                    const qty = stockOf[p.id] ?? 0
                    const items = actionsFor(p)
                    return (
                      <tr key={p.id} className={cn('hover:bg-slate-50/60', !p.is_active && 'opacity-60')}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <Thumb url={p.image_url} />
                            <div className="min-w-0">
                              {canManage ? (
                                <button onClick={() => setEditing(p)} className="block max-w-xs truncate text-left font-medium text-slate-800 hover:text-brand-600">
                                  {productLabel(p)}
                                </button>
                              ) : (
                                <p className="max-w-xs truncate font-medium text-slate-800">{productLabel(p)}</p>
                              )}
                              <p className="max-w-xs truncate text-xs text-slate-400">
                                {[p.sku && `SKU ${p.sku}`, p.barcode, p.parent_id && `Variante de ${productName[p.parent_id] ?? '—'}`].filter(Boolean).join(' · ') || p.unit}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-600">{p.category_id ? categoryName[p.category_id] : '—'}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-600">{money(p.cost, currency)}</td>
                        <td className="px-4 py-3 text-right font-medium tabular-nums text-slate-800">{money(p.price, currency)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                          <MarginText p={p} rate={p.tax_id ? (taxById[p.tax_id]?.rate ?? 0) : 0} includesTax={tenant?.prices_include_tax ?? true} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <StockCell p={p} qty={qty} />
                        </td>
                        <td className="px-4 py-3">
                          <Badges p={p} qty={qty} />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end">{items.length > 0 && <ActionMenu title={productLabel(p)} items={items} />}</div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <DataList>
              {slice.map((p) => {
                const qty = stockOf[p.id] ?? 0
                const items = actionsFor(p)
                return (
                  <DataRow
                    key={p.id}
                    leading={<Thumb url={p.image_url} />}
                    title={productLabel(p)}
                    titleExtra={[p.sku && `SKU ${p.sku}`, p.barcode].filter(Boolean).join(' · ') || undefined}
                    onClick={canManage ? () => setEditing(p) : undefined}
                    tone={p.is_active ? undefined : 'muted'}
                    badges={<Badges p={p} qty={qty} />}
                    actions={items.length > 0 ? <ActionMenu title={productLabel(p)} items={items} /> : undefined}
                  >
                    <DataFields cols={3}>
                      <DataField label="Precio">{money(p.price, currency)}</DataField>
                      <DataField label="Costo">{money(p.cost, currency)}</DataField>
                      <DataField label="Existencia">
                        <StockCell p={p} qty={qty} />
                      </DataField>
                    </DataFields>
                  </DataRow>
                )
              })}
            </DataList>
            <Pagination page={safePage} pageSize={PAGE_SIZE} total={filtered.length} onPage={setPage} label="artículos" />
          </>
        )}
      </Card>

      {(creating || editing) && (
        <ProductFormModal
          key={editing?.id ?? 'new'}
          product={editing}
          products={products}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
        />
      )}
      {showCategories && <CategoriesModal products={products} onClose={() => setShowCategories(false)} />}
      {showImport && <ImportProductsModal onClose={() => setShowImport(false)} />}
      {showPriceLists && <PriceListsModal products={products} onClose={() => setShowPriceLists(false)} />}
    </div>
  )
}

function Badges({ p, qty }: { p: Product; qty: number }) {
  const st = p.track_stock ? stockStatus(qty, p.min_stock) : null
  return (
    <div className="flex flex-wrap items-center gap-1">
      {p.kind === 'service' ? (
        <Badge tone="brand">
          <Wrench className="h-3 w-3" /> Servicio
        </Badge>
      ) : (
        <Badge tone="slate">
          <Boxes className="h-3 w-3" /> Producto
        </Badge>
      )}
      {!p.is_active && <Badge tone="slate">Inactivo</Badge>}
      {st && st !== 'ok' && <Badge tone={STOCK_STATUS[st].tone}>{STOCK_STATUS[st].label}</Badge>}
    </div>
  )
}

function MarginText({ p, rate, includesTax }: { p: Product; rate: number; includesTax: boolean }) {
  const m = marginPct(Number(p.price), Number(p.cost), rate, includesTax)
  if (m === null) return <span className="text-slate-400">—</span>
  return <span className={cn(m < 0 && 'font-semibold text-red-600')}>{m.toLocaleString('es-DO', { maximumFractionDigits: 1 })}%</span>
}
