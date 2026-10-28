import { useMemo, useState, type KeyboardEvent } from 'react'
import { Check, Package, Search, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { money, norm } from '@/lib/format'
import type { Product } from '@/types/erp'

const MAX_RESULTS = 60

/**
 * Buscador de productos para documentos (compras y cotizaciones). Se queda
 * abierto tras elegir: una compra o una cotización suelen llevar varias líneas
 * seguidas y reabrir el buscador por cada una es un toque de más. Enter con un
 * código de barras exacto lo agrega directo (lector de códigos).
 */
export function ProductPicker({
  open,
  onClose,
  products,
  onPick,
  show,
  currency,
}: {
  open: boolean
  onClose: () => void
  /** Ya filtrados por quien llama (activos, solo productos, etc.). */
  products: Product[]
  onPick: (p: Product) => void
  /** Qué importe enseñar junto a cada producto. */
  show: 'cost' | 'price'
  currency: string
}) {
  const [q, setQ] = useState('')
  const [added, setAdded] = useState<string[]>([])

  const results = useMemo(() => {
    const s = norm(q)
    const list = s
      ? products.filter(
          (p) =>
            norm(p.name).includes(s) ||
            norm(p.variant_label).includes(s) ||
            norm(p.code).includes(s) ||
            norm(p.sku).includes(s) ||
            (p.barcode ?? '') === q.trim(),
        )
      : products
    return list.slice(0, MAX_RESULTS)
  }, [products, q])

  const pick = (p: Product) => {
    onPick(p)
    setAdded((a) => [...a, p.id])
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const code = q.trim()
    const exact = products.find((p) => p.barcode === code || p.code === code || p.sku === code)
    const target = exact ?? (results.length === 1 ? results[0] : undefined)
    if (target) {
      pick(target)
      setQ('')
    }
  }

  const close = () => {
    setQ('')
    setAdded([])
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Agregar productos"
      size="lg"
      footer={
        <Button onClick={close}>
          {added.length ? `Listo (${added.length} agregado${added.length === 1 ? '' : 's'})` : 'Cerrar'}
        </Button>
      }
    >
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder="Nombre, código o código de barras"
          className="pl-9"
        />
      </div>
      {results.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">
          {products.length === 0 ? 'No hay productos activos en el catálogo.' : 'Ningún producto coincide.'}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-100">
          {results.map((p) => {
            const count = added.filter((id) => id === p.id).length
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => pick(p)}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50 active:bg-slate-100"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                    {p.kind === 'service' ? <Wrench className="h-4 w-4" /> : <Package className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-800">
                      {p.name}
                      {p.variant_label ? ` · ${p.variant_label}` : ''}
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      {[p.code, p.barcode].filter(Boolean).join(' · ') || p.unit}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-sm tabular-nums text-slate-600">
                    {money(show === 'cost' ? p.cost : p.price, currency)}
                    {count > 0 && (
                      <span className="mt-0.5 flex items-center justify-end gap-0.5 text-xs font-medium text-emerald-600">
                        <Check className="h-3 w-3" /> {count}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {results.length === MAX_RESULTS && (
        <p className="mt-2 text-center text-xs text-slate-400">Mostrando los primeros {MAX_RESULTS}. Afina la búsqueda.</p>
      )}
    </Modal>
  )
}
