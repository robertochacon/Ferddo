import { useMemo, useState, type KeyboardEvent } from 'react'
import { Check, ListOrdered, Pencil, Percent, Plus, Search, Trash2, X } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Badge } from '@/components/ui/Badge'
import { Pagination, paginate } from '@/components/ui/Pagination'
import { EmptyState, PageLoader, Spinner } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/auth/AuthProvider'
import { useCategories, useCustomers } from '@/hooks/core'
import {
  bulkTargets,
  customerPriceListId,
  useBulkSetPriceList,
  useCreatePriceList,
  usePriceListItems,
  usePriceLists,
  useRemovePriceListItems,
  useUpdatePriceList,
  useUpsertPriceListItems,
  type PriceList,
} from '@/hooks/priceLists'
import { errorMessage } from '@/lib/errors'
import { money, num } from '@/lib/format'
import { cn } from '@/lib/cn'
import type { Product } from '@/types/erp'
import { parseDecimal, productHaystack, productLabel } from './catalog'

const PAGE_SIZE = 30

type Scope = 'all' | 'listed'

/** Color de la diferencia contra el catálogo: por debajo es descuento (verde), por encima recargo (ámbar). */
const DIFF_TONE = {
  down: 'text-emerald-600',
  up: 'text-amber-600',
  same: 'text-slate-400',
} as const

function diffOf(listPrice: number, catalog: number): { pct: number; tone: keyof typeof DIFF_TONE } | null {
  if (!(catalog > 0)) return null
  const pct = ((listPrice - catalog) / catalog) * 100
  const rounded = Math.round(pct * 10) / 10
  const tone: keyof typeof DIFF_TONE = rounded < 0 ? 'down' : rounded > 0 ? 'up' : 'same'
  return { pct: rounded, tone }
}

/**
 * Gestión de listas de precios (`prices.manage`). Arriba se elige la lista;
 * abajo, el catálogo con su precio en esa lista. Un producto sin precio en la
 * lista se vende al precio del catálogo: dejar el campo vacío lo quita.
 */
export function PriceListsModal({ products, onClose }: { products: Product[]; onClose: () => void }) {
  const toast = useToast()
  const { tenant } = useAuth()
  const currency = tenant?.currency ?? 'DOP'
  const lists = usePriceLists()
  const customers = useCustomers()
  const create = useCreatePriceList()
  const update = useUpdatePriceList()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)

  const allLists = lists.data ?? []
  const selected = allLists.find((l) => l.id === selectedId) ?? allLists[0] ?? null

  const customersPerList = useMemo(() => {
    const m: Record<string, number> = {}
    for (const c of customers.data ?? []) {
      const id = customerPriceListId(c)
      if (id) m[id] = (m[id] ?? 0) + 1
    }
    return m
  }, [customers.data])

  const onCreate = async () => {
    if (!newName.trim()) return
    try {
      const list = await create.mutateAsync(newName)
      setNewName('')
      setSelectedId(list.id)
      toast.success('Lista creada')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo crear la lista'))
    }
  }

  const onRename = async () => {
    if (!selected || renaming === null || !renaming.trim()) return
    try {
      await update.mutateAsync({ id: selected.id, name: renaming })
      setRenaming(null)
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo renombrar'))
    }
  }

  const onToggle = async (l: PriceList) => {
    try {
      await update.mutateAsync({ id: l.id, is_active: !l.is_active })
      toast.success(l.is_active ? 'Lista desactivada: sus clientes vuelven al precio de catálogo' : 'Lista activada')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo actualizar'))
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Listas de precios"
      footer={
        <Button variant="outline" onClick={onClose}>
          Cerrar
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-500">
          Asigna una lista a un cliente (en su ficha) y el POS y las cotizaciones le cobran estos precios. Lo que no esté
          en la lista se vende al precio del catálogo.
        </p>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void onCreate()
          }}
        >
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Nueva lista (ej. Mayorista)"
            aria-label="Nombre de la nueva lista"
            maxLength={60}
          />
          <Button type="submit" className="shrink-0" loading={create.isPending} disabled={!newName.trim()}>
            <Plus className="h-4 w-4" /> Crear
          </Button>
        </form>

        {lists.isLoading ? (
          <PageLoader label="Cargando listas…" />
        ) : lists.isError ? (
          <div className="space-y-2 text-center">
            <p className="text-sm text-red-600">{errorMessage(lists.error, 'No se pudieron cargar las listas.')}</p>
            <Button variant="outline" size="sm" onClick={() => void lists.refetch()}>
              Reintentar
            </Button>
          </div>
        ) : allLists.length === 0 ? (
          <EmptyState
            icon={<ListOrdered className="h-6 w-6" />}
            title="Aún no hay listas"
            description="Crea una lista para el mayorista, el cliente fijo o la empresa con acuerdo."
          />
        ) : (
          <>
            {/* Selector de lista: chips que envuelven, sin scroll horizontal. */}
            <div className="flex flex-wrap gap-2" role="group" aria-label="Listas de precios">
              {allLists.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  aria-pressed={selected?.id === l.id}
                  onClick={() => {
                    setSelectedId(l.id)
                    setRenaming(null)
                  }}
                  className={cn(
                    'inline-flex h-9 max-w-full items-center gap-1.5 rounded-full px-4 text-sm font-medium transition-colors',
                    selected?.id === l.id
                      ? 'bg-brand-600 text-white'
                      : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                    !l.is_active && selected?.id !== l.id && 'text-slate-400 line-through',
                  )}
                >
                  <span className="truncate">{l.name}</span>
                </button>
              ))}
            </div>

            {selected && (
              <div className="rounded-xl border border-slate-200">
                <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
                  {renaming !== null ? (
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <Input
                        autoFocus
                        value={renaming}
                        maxLength={60}
                        onChange={(e) => setRenaming(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void onRename()
                          if (e.key === 'Escape') {
                            // Que el Escape cierre solo la edición, no el diálogo entero.
                            e.stopPropagation()
                            setRenaming(null)
                          }
                        }}
                        aria-label="Nombre de la lista"
                      />
                      <Button size="icon" variant="ghost" onClick={() => void onRename()} loading={update.isPending} aria-label="Guardar nombre">
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => setRenaming(null)} aria-label="Cancelar">
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <>
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 truncate font-semibold text-slate-800">
                          {selected.name}
                          {!selected.is_active && <Badge tone="slate">Inactiva</Badge>}
                        </p>
                        <p className="text-xs text-slate-400">
                          {num(customersPerList[selected.id] ?? 0)} cliente(s) con esta lista
                        </p>
                      </div>
                      <Button size="icon" variant="ghost" onClick={() => setRenaming(selected.name)} aria-label={`Renombrar ${selected.name}`}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void onToggle(selected)} disabled={update.isPending}>
                        {selected.is_active ? 'Desactivar' : 'Activar'}
                      </Button>
                    </>
                  )}
                </div>
                {!selected.is_active && (
                  <p className="border-b border-slate-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    Lista inactiva: no se aplica. Sus clientes compran a precio de catálogo hasta que la actives.
                  </p>
                )}
                <ListPrices key={selected.id} list={selected} products={products} currency={currency} />
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

/** Precios de una lista sobre el catálogo: búsqueda, edición en línea y ajuste masivo. */
function ListPrices({ list, products, currency }: { list: PriceList; products: Product[]; currency: string }) {
  const toast = useToast()
  const { data: categories = [] } = useCategories()
  const itemsQ = usePriceListItems(list.id)
  const upsert = useUpsertPriceListItems()
  const remove = useRemovePriceListItems()
  const bulk = useBulkSetPriceList()

  const [search, setSearch] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [category, setCategory] = useState('all')
  const [page, setPage] = useState(0)
  const [savingId, setSavingId] = useState<string | null>(null)

  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkSign, setBulkSign] = useState<'-' | '+'>('-')
  const [bulkPct, setBulkPct] = useState('')
  const [bulkCategory, setBulkCategory] = useState('all')

  const priceOf = useMemo(() => new Map((itemsQ.data ?? []).map((it) => [it.product_id, it.price])), [itemsQ.data])

  // Mismos productos que admite el ajuste masivo: los que se venden directamente.
  const sellable = useMemo(() => bulkTargets(products, null), [products])
  const filtered = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return sellable.filter((p) => {
      if (scope === 'listed' && !priceOf.has(p.id)) return false
      if (category === 'none' && p.category_id) return false
      if (category !== 'all' && category !== 'none' && p.category_id !== category) return false
      if (terms.length) {
        const hay = productHaystack(p)
        if (!terms.every((t) => hay.includes(t))) return false
      }
      return true
    })
  }, [sellable, scope, category, search, priceOf])
  const { slice, safePage } = paginate(filtered, page, PAGE_SIZE)

  const bulkCategoryId = bulkCategory === 'all' ? null : bulkCategory
  const bulkCount = useMemo(() => bulkTargets(products, bulkCategoryId).length, [products, bulkCategoryId])
  const bulkValue = parseDecimal(bulkPct)
  const bulkPercent = bulkValue == null || Number.isNaN(bulkValue) ? NaN : bulkSign === '-' ? -bulkValue : bulkValue

  const commitPrice = async (p: Product, raw: string) => {
    const value = parseDecimal(raw)
    const current = priceOf.get(p.id)
    if (value === null) {
      if (current === undefined) return
      setSavingId(p.id)
      try {
        await remove.mutateAsync({ listId: list.id, productIds: [p.id] })
      } catch (err) {
        toast.error(errorMessage(err, 'No se pudo quitar el precio'))
      } finally {
        setSavingId(null)
      }
      return
    }
    if (Number.isNaN(value) || value < 0) {
      toast.error(`Precio inválido para "${productLabel(p)}"`)
      return
    }
    if (current !== undefined && Math.round(current * 100) === Math.round(value * 100)) return
    setSavingId(p.id)
    try {
      await upsert.mutateAsync({ listId: list.id, rows: [{ product_id: p.id, price: value }] })
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo guardar el precio'))
    } finally {
      setSavingId(null)
    }
  }

  const applyBulk = async () => {
    if (!Number.isFinite(bulkPercent) || bulkPercent <= -100) {
      toast.error('Escribe un porcentaje válido')
      return
    }
    try {
      const n = await bulk.mutateAsync({ listId: list.id, percent: bulkPercent, categoryId: bulkCategoryId, products })
      toast.success(`${num(n)} precio(s) actualizados en ${list.name}`)
      setBulkOpen(false)
      setBulkPct('')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo aplicar el ajuste'))
    }
  }

  return (
    <div className="space-y-3 p-3">
      {/* Ajuste masivo */}
      {bulkOpen ? (
        <div className="space-y-3 rounded-xl border border-brand-200 bg-brand-50/40 p-3">
          <p className="text-sm font-medium text-slate-700">Ajuste masivo sobre el precio de catálogo</p>
          <div className="grid grid-cols-[auto_1fr] gap-2 sm:grid-cols-[auto_8rem_1fr]">
            <Select value={bulkSign} onChange={(e) => setBulkSign(e.target.value as '-' | '+')} aria-label="Descuento o recargo">
              <option value="-">Catálogo −</option>
              <option value="+">Catálogo +</option>
            </Select>
            <div className="relative">
              <Input
                inputMode="decimal"
                value={bulkPct}
                onChange={(e) => setBulkPct(e.target.value)}
                placeholder="10"
                aria-label="Porcentaje"
                className="pr-8"
              />
              <Percent className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            </div>
            <Select
              value={bulkCategory}
              onChange={(e) => setBulkCategory(e.target.value)}
              aria-label="Productos a los que se aplica"
              className="col-span-2 sm:col-span-1"
            >
              <option value="all">Todo el catálogo</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  Categoría: {c.name}
                </option>
              ))}
            </Select>
          </div>
          <p className="text-xs text-slate-500">
            Fija el precio de {num(bulkCount)} producto(s) activos en esta lista y reemplaza el que tuvieran. Si después
            cambias el catálogo, la lista no se mueve sola: vuelve a aplicar el ajuste.
          </p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setBulkOpen(false)}>
              Cancelar
            </Button>
            <Button
              size="sm"
              onClick={() => void applyBulk()}
              loading={bulk.isPending}
              disabled={!Number.isFinite(bulkPercent) || bulkCount === 0}
            >
              Aplicar a {num(bulkCount)}
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setBulkOpen(true)}>
          <Percent className="h-4 w-4" /> Ajuste masivo (catálogo − X %)
        </Button>
      )}

      {/* Filtros */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(0)
          }}
          placeholder="Buscar producto…"
          className="pl-9"
          aria-label="Buscar producto"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Select
          value={scope}
          onChange={(e) => {
            setScope(e.target.value as Scope)
            setPage(0)
          }}
          aria-label="Qué productos ver"
        >
          <option value="all">Todo el catálogo</option>
          <option value="listed">Solo con precio en la lista ({num(priceOf.size)})</option>
        </Select>
        <Select
          value={category}
          onChange={(e) => {
            setCategory(e.target.value)
            setPage(0)
          }}
          aria-label="Categoría"
        >
          <option value="all">Todas las categorías</option>
          <option value="none">Sin categoría</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>

      {itemsQ.isLoading ? (
        <PageLoader label="Cargando precios…" />
      ) : itemsQ.isError ? (
        <div className="space-y-2 text-center">
          <p className="text-sm text-red-600">{errorMessage(itemsQ.error, 'No se pudieron cargar los precios.')}</p>
          <Button variant="outline" size="sm" onClick={() => void itemsQ.refetch()}>
            Reintentar
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Search className="h-6 w-6" />}
          title={scope === 'listed' && priceOf.size === 0 ? 'La lista está vacía' : 'Sin resultados'}
          description={
            scope === 'listed' && priceOf.size === 0
              ? 'Escribe precios producto a producto o usa el ajuste masivo.'
              : 'Ningún producto coincide con la búsqueda o los filtros.'
          }
        />
      ) : (
        <>
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {slice.map((p) => {
              const listPrice = priceOf.get(p.id)
              const catalog = Number(p.price)
              const diff = listPrice !== undefined ? diffOf(listPrice, catalog) : null
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
                  <div className="min-w-0 flex-1 basis-40">
                    <p className="truncate text-sm font-medium text-slate-800">{productLabel(p)}</p>
                    <p className="text-xs text-slate-500">
                      Catálogo {money(catalog, currency)}
                      {diff && (
                        <span className={cn('ml-1.5 font-medium', DIFF_TONE[diff.tone])}>
                          {diff.pct > 0 ? '+' : ''}
                          {diff.pct.toLocaleString('es-DO', { maximumFractionDigits: 1 })} %
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    {/* La clave incluye el precio guardado: al confirmarse el
                        cambio (o al llegar el de otro usuario) el campo se
                        rehace con el valor de la base en vez de quedar con el
                        borrador local. */}
                    <PriceField
                      key={`${p.id}:${listPrice ?? ''}`}
                      initial={listPrice}
                      placeholder={String(catalog)}
                      label={`Precio de ${productLabel(p)} en ${list.name}`}
                      disabled={savingId === p.id}
                      onCommit={(raw) => void commitPrice(p, raw)}
                    />
                    <div className="flex h-10 w-10 items-center justify-center">
                      {savingId === p.id ? (
                        <Spinner size="sm" />
                      ) : (
                        listPrice !== undefined && (
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Quitar ${productLabel(p)} de la lista`}
                            onClick={() => void commitPrice(p, '')}
                          >
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </Button>
                        )
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
          <Pagination page={safePage} pageSize={PAGE_SIZE} total={filtered.length} onPage={setPage} label="productos" />
        </>
      )}
    </div>
  )
}

/** Campo de precio que guarda al salir o con Enter; Escape descarta. Vacío = quitar de la lista. */
function PriceField({
  initial,
  placeholder,
  label,
  disabled,
  onCommit,
}: {
  initial: number | undefined
  placeholder: string
  label: string
  disabled: boolean
  onCommit: (raw: string) => void
}) {
  const start = initial !== undefined ? String(initial) : ''
  const [draft, setDraft] = useState(start)
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.blur()
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setDraft(start)
    }
  }
  return (
    <div className="w-32">
      <Input
        inputMode="decimal"
        value={draft}
        placeholder={placeholder}
        aria-label={label}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => {
          if (draft.trim() !== start) onCommit(draft)
        }}
        className="text-right tabular-nums"
      />
    </div>
  )
}
