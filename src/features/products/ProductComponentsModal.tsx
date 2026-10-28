import { useMemo, useState } from 'react'
import { Layers, Plus, Search, Trash2 } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/auth/AuthProvider'
import { useTaxes } from '@/hooks/core'
import { useCompositeProductIds, useProductComponents, useSaveProductComponents } from '@/hooks/products'
import { errorMessage } from '@/lib/errors'
import { money } from '@/lib/format'
import { cn } from '@/lib/cn'
import type { Product } from '@/types/erp'
import { marginPct, parseDecimal, productHaystack, productLabel } from './catalog'

/** Resultados del buscador de componentes: más no caben a 360 px sin tapar la receta. */
const MAX_RESULTS = 8

interface Row {
  component_id: string
  /** Texto tal como se escribe (acepta coma decimal); se valida al guardar. */
  qty: string
}

/** Cantidad válida para numeric(14,4): mayor que cero y con hasta 4 decimales. */
function parseQty(v: string): number | null {
  const n = parseDecimal(v)
  if (n === null || Number.isNaN(n) || n <= 0) return null
  return Math.round(n * 10000) / 10000
}

const MARGIN_TONE = {
  bad: 'bg-red-50 text-red-700',
  low: 'bg-amber-50 text-amber-700',
  good: 'bg-emerald-50 text-emerald-700',
  none: 'bg-slate-50 text-slate-500',
} as const

/**
 * Receta o kit de un producto (`products.manage` + módulo de inventario). La
 * receta se edita aquí en borrador y se guarda entera de una vez: el RPC la
 * reemplaza completa, así que no hay altas ni bajas sueltas que sincronizar.
 * Las reglas (sin existencia propia, sin anidar, sin variantes…) las aplica la
 * base; aquí solo se filtran los candidatos para no ofrecer lo que rechazaría.
 */
export function ProductComponentsModal({
  product,
  products,
  onClose,
}: {
  product: Product
  /** Catálogo completo: de aquí salen nombre, unidad y costo de cada componente. */
  products: Product[]
  onClose: () => void
}) {
  const toast = useToast()
  const { tenant } = useAuth()
  const currency = tenant?.currency ?? 'DOP'
  const includesTax = tenant?.prices_include_tax ?? true

  const componentsQ = useProductComponents(product.id)
  const { data: composites } = useCompositeProductIds()
  const { data: taxes = [] } = useTaxes()
  const save = useSaveProductComponents()

  // null = sin tocar: se muestra lo que hay en la base. Así no hace falta un
  // efecto que copie la respuesta al estado cuando llega.
  const [draft, setDraft] = useState<Row[] | null>(null)
  const [search, setSearch] = useState('')

  const saved = useMemo<Row[]>(
    () => (componentsQ.data ?? []).map((c) => ({ component_id: c.component_id, qty: String(c.quantity) })),
    [componentsQ.data],
  )
  const rows = draft ?? saved
  const wasComposite = saved.length > 0
  const dirty = draft !== null

  const byId = useMemo(() => Object.fromEntries(products.map((p) => [p.id, p])), [products])

  // Candidatos: productos activos con existencia, que no sean este ni otro
  // compuesto, y que no estén ya en la receta.
  const candidates = useMemo(() => {
    const inRecipe = new Set(rows.map((r) => r.component_id))
    return products.filter(
      (p) =>
        p.is_active &&
        p.kind === 'product' &&
        p.track_stock &&
        p.id !== product.id &&
        !composites?.has(p.id) &&
        !inRecipe.has(p.id),
    )
  }, [products, product.id, composites, rows])

  const results = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return []
    return candidates.filter((p) => terms.every((t) => productHaystack(p).includes(t))).slice(0, MAX_RESULTS)
  }, [candidates, search])

  const setRows = (next: Row[]) => setDraft(next)
  const addRow = (p: Product) => {
    setRows([...rows, { component_id: p.id, qty: '1' }])
    setSearch('')
  }
  const setQty = (id: string, qty: string) => setRows(rows.map((r) => (r.component_id === id ? { ...r, qty } : r)))
  const removeRow = (id: string) => setRows(rows.filter((r) => r.component_id !== id))

  const invalidIds = new Set(rows.filter((r) => parseQty(r.qty) === null).map((r) => r.component_id))
  const cost = rows.reduce((sum, r) => sum + (parseQty(r.qty) ?? 0) * Number(byId[r.component_id]?.cost ?? 0), 0)
  const rate = taxes.find((t) => t.id === product.tax_id)?.rate ?? 0
  const margin = rows.length > 0 ? marginPct(Number(product.price), cost, rate, includesTax) : null

  const persist = async (lines: Row[]) => {
    try {
      await save.mutateAsync({
        productId: product.id,
        components: lines.map((r) => ({ component_id: r.component_id, quantity: parseQty(r.qty) ?? 0 })),
      })
      if (lines.length > 0) {
        toast.success('Receta guardada')
      } else {
        // Quitar la receta no vuelve a encender el control de existencia (lo
        // decide quien edita el producto): se avisa para que no se le pase.
        toast.success('Receta quitada. Si debe llevar existencia, actívala en Editar.')
      }
      onClose()
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo guardar la receta'))
    }
  }

  const onSave = () => {
    if (rows.length === 0) return void persist([])
    if (invalidIds.size > 0) {
      toast.error('Revisa las cantidades: deben ser mayores que cero.')
      return
    }
    void persist(rows)
  }

  const canSave = dirty && !(rows.length === 0 && !wasComposite)

  let tone: keyof typeof MARGIN_TONE = 'none'
  if (margin !== null) {
    if (margin < 0) tone = 'bad'
    else if (margin < 10) tone = 'low'
    else tone = 'good'
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Receta / kit · ${productLabel(product)}`}
      footer={
        <>
          {wasComposite && (
            <Button
              variant="ghost"
              className="mr-auto text-red-600 hover:bg-red-50"
              onClick={() => void persist([])}
              disabled={save.isPending}
            >
              <Trash2 className="h-4 w-4" /> <span className="hidden sm:inline">Quitar receta</span>
              <span className="sm:hidden">Quitar</span>
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Cancelar
          </Button>
          <Button onClick={onSave} loading={save.isPending} disabled={!canSave}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-500">
          Al venderse descuenta sus componentes del inventario; el producto no lleva existencia propia.
        </p>

        {componentsQ.isLoading ? (
          <PageLoader label="Cargando receta…" />
        ) : componentsQ.isError ? (
          <div className="space-y-3 text-center">
            <p className="text-sm text-red-600">{errorMessage(componentsQ.error, 'No se pudo cargar la receta.')}</p>
            <Button variant="outline" onClick={() => void componentsQ.refetch()} loading={componentsQ.isFetching}>
              Reintentar
            </Button>
          </div>
        ) : (
          <>
            {/* Componentes */}
            {rows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-200 px-4 py-6 text-center">
                <Layers className="h-6 w-6 text-slate-300" />
                <p className="text-sm text-slate-500">
                  {wasComposite ? 'Quitaste todos los componentes: al guardar deja de ser compuesto.' : 'Sin componentes. Busca abajo los productos que lleva.'}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200">
                {rows.map((r) => {
                  const c = byId[r.component_id]
                  const qty = parseQty(r.qty)
                  const bad = invalidIds.has(r.component_id)
                  return (
                    <li key={r.component_id} className="flex items-center gap-2 px-3 py-2.5 sm:gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-800">{c ? productLabel(c) : 'Producto no disponible'}</p>
                        <p className="truncate text-xs text-slate-400">
                          {c ? `${money(c.cost, currency)} / ${c.unit}` : '—'}
                          {c && qty !== null && ` · ${money(qty * Number(c.cost), currency)}`}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Input
                          value={r.qty}
                          onChange={(e) => setQty(r.component_id, e.target.value)}
                          inputMode="decimal"
                          aria-label={`Cantidad de ${c ? productLabel(c) : 'componente'}`}
                          aria-invalid={bad}
                          className={cn('w-20 text-right sm:w-24', bad && 'border-red-400 focus:border-red-400 focus:ring-red-500/30')}
                        />
                        <span className="hidden w-14 truncate text-xs text-slate-500 sm:inline">{c?.unit}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeRow(r.component_id)}
                          aria-label="Quitar componente"
                          title="Quitar componente"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}

            {/* Buscador para añadir */}
            <div className="space-y-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter añade el primer resultado: rápido con teclado o lector.
                    if (e.key === 'Enter' && results[0]) {
                      e.preventDefault()
                      addRow(results[0])
                    }
                  }}
                  placeholder="Agregar componente: nombre, SKU o código…"
                  className="pl-9"
                  aria-label="Buscar componente"
                />
              </div>
              {search.trim() !== '' && (
                <div className="overflow-hidden rounded-xl border border-slate-200">
                  {results.length === 0 ? (
                    <p className="px-3 py-3 text-sm text-slate-500">
                      Sin resultados. Solo sirven productos activos que controlan existencia y no son compuestos.
                    </p>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {results.map((p) => (
                        <li key={p.id}>
                          <button
                            type="button"
                            onClick={() => addRow(p)}
                            className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-slate-50"
                          >
                            <Plus className="h-4 w-4 shrink-0 text-brand-600" />
                            <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{productLabel(p)}</span>
                            <span className="shrink-0 text-xs text-slate-400">
                              {money(p.cost, currency)} / {p.unit}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            {/* Costo estimado y margen */}
            {rows.length > 0 && (
              <div className={cn('rounded-xl px-3 py-2 text-sm', MARGIN_TONE[tone])}>
                <p className="font-semibold">Costo estimado {money(cost, currency)} por unidad</p>
                <p className="text-xs opacity-80">
                  {margin === null
                    ? 'El producto no tiene precio: no se puede calcular el margen.'
                    : `Margen ${margin.toLocaleString('es-DO', { maximumFractionDigits: 1 })}% sobre el precio de ${money(product.price, currency)}. Al guardar, este pasa a ser el costo del producto.`}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
