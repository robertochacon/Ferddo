import { useMemo, useState, type KeyboardEvent } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/cn'
import type { Product } from '@/types/erp'
import { fmtQty, productHaystack, productLabel } from '@/features/products/catalog'

const MAX_RESULTS = 8

/**
 * Buscador de productos para las pantallas de inventario.
 *
 * La lista de resultados va EN LÍNEA bajo el campo y no flotando: casi siempre
 * vive dentro de un Modal cuyo cuerpo se desplaza, y un desplegable absoluto
 * quedaría recortado por ese contenedor en un teléfono.
 *
 * Enter con un código de barras/SKU exacto elige el producto directamente: así
 * funciona una pistola lectora, que "teclea" el código y manda Enter.
 */
export function ProductPicker({
  products,
  onPick,
  excludeIds,
  stock,
  placeholder = 'Buscar por nombre, SKU o código de barras…',
  autoFocus,
  className,
}: {
  products: Product[]
  onPick: (product: Product) => void
  /** Productos ya elegidos (líneas existentes): no se vuelven a ofrecer. */
  excludeIds?: ReadonlySet<string>
  /** Existencia por producto para mostrarla junto al resultado. */
  stock?: Record<string, number>
  placeholder?: string
  autoFocus?: boolean
  className?: string
}) {
  const [query, setQuery] = useState('')

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const terms = q.split(/\s+/)
    const out: Product[] = []
    for (const p of products) {
      if (excludeIds?.has(p.id)) continue
      const hay = productHaystack(p)
      if (terms.every((t) => hay.includes(t))) {
        out.push(p)
        if (out.length >= MAX_RESULTS) break
      }
    }
    return out
  }, [products, query, excludeIds])

  const pick = (p: Product) => {
    onPick(p)
    setQuery('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    // Enter dentro de un formulario lo enviaría: aquí solo elige.
    e.preventDefault()
    const q = query.trim().toLowerCase()
    if (!q) return
    const exact = products.find(
      (p) =>
        !excludeIds?.has(p.id) &&
        (p.barcode?.toLowerCase() === q || p.sku?.toLowerCase() === q || p.code?.toLowerCase() === q),
    )
    if (exact) pick(exact)
    else if (results.length === 1) pick(results[0])
  }

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className="pl-9"
          aria-label="Buscar producto"
        />
      </div>
      {query.trim() !== '' && (
        <ul className="max-h-64 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          {results.length === 0 ? (
            <li className="px-3.5 py-3 text-sm text-slate-500">Sin resultados para «{query.trim()}».</li>
          ) : (
            results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => pick(p)}
                  className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left hover:bg-slate-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-slate-800">{productLabel(p)}</span>
                    <span className="block truncate text-xs text-slate-400">
                      {[p.sku, p.barcode].filter(Boolean).join(' · ') || p.unit}
                    </span>
                  </span>
                  {stock && (
                    <span className="shrink-0 text-xs tabular-nums text-slate-500">
                      {fmtQty(stock[p.id] ?? 0)} {p.unit}
                    </span>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}
