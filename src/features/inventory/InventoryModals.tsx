import { useMemo, useState } from 'react'
import { ArrowRight, Search, Trash2 } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Segmented } from '@/components/ui/Segmented'
import { Badge } from '@/components/ui/Badge'
import { Pagination, paginate } from '@/components/ui/Pagination'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/auth/AuthProvider'
import { useStockMap } from '@/hooks/core'
import { useInventoryAdjust, useInventoryCount, useInventoryTransfer } from '@/hooks/inventory'
import { errorMessage } from '@/lib/errors'
import { num } from '@/lib/format'
import { cn } from '@/lib/cn'
import type { Branch, Product } from '@/types/erp'
import { fmtQty, parseDecimal, productHaystack, productLabel } from '@/features/products/catalog'
import { ProductPicker } from './ProductPicker'

/*
 * Los tres documentos manuales de inventario. Los editores de líneas son filas
 * flexibles y no tablas: viven en un Modal que en el teléfono ocupa 360 px, y
 * una tabla de cuatro columnas obligaría a arrastrar de lado.
 */

interface Line {
  product: Product
  qty: string
}

/** Cantidad > 0 válida, o null. */
function positiveQty(s: string): number | null {
  const n = parseDecimal(s)
  return n !== null && !Number.isNaN(n) && n > 0 ? n : null
}

function LineEditor({
  lines,
  setLines,
  stock,
  resultSign,
  allowNegative,
}: {
  lines: Line[]
  setLines: (lines: Line[]) => void
  stock: Record<string, number>
  /** +1 entra, -1 sale: para enseñar en qué queda la existencia. */
  resultSign: 1 | -1
  allowNegative: boolean
}) {
  if (lines.length === 0) {
    return <p className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500">Busca y agrega los productos.</p>
  }
  return (
    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
      {lines.map((l, i) => {
        const current = stock[l.product.id] ?? 0
        const q = positiveQty(l.qty)
        const after = q === null ? null : current + resultSign * q
        const invalid = l.qty.trim() !== '' && q === null
        const goesNegative = after !== null && after < 0
        return (
          <li key={l.product.id} className="flex items-start gap-2 p-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-slate-800">{productLabel(l.product)}</p>
              <p className="text-xs text-slate-500">
                Existencia: {fmtQty(current)} {l.product.unit}
                {after !== null && (
                  <span className={cn(goesNegative ? 'font-semibold text-red-600' : 'text-slate-500')}>
                    {' '}
                    → {fmtQty(after)}
                  </span>
                )}
              </p>
              {invalid && <p className="text-xs font-medium text-red-600">Cantidad inválida</p>}
              {goesNegative && !allowNegative && (
                <p className="text-xs font-medium text-red-600">No hay existencia suficiente; tu empresa no permite negativos.</p>
              )}
            </div>
            <Input
              value={l.qty}
              onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
              inputMode="decimal"
              placeholder="Cant."
              aria-label={`Cantidad de ${l.product.name}`}
              className={cn('w-24 text-right', invalid && 'border-red-300')}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setLines(lines.filter((_, j) => j !== i))}
              aria-label={`Quitar ${l.product.name}`}
            >
              <Trash2 className="h-4 w-4 text-slate-400" />
            </Button>
          </li>
        )
      })}
    </ul>
  )
}

const REASONS = ['Mercancía dañada', 'Producto vencido', 'Consumo interno', 'Pérdida o robo', 'Corrección de error', 'Donación', 'Muestra', 'Mercancía encontrada']

type Direction = 'in' | 'out'

// ── Ajuste ──────────────────────────────────────────────────────────────────

export function AdjustModal({
  branches,
  products,
  defaultBranchId,
  initialProduct,
  onClose,
}: {
  branches: Branch[]
  /** Solo productos con control de existencia. */
  products: Product[]
  defaultBranchId: string
  initialProduct?: Product | null
  onClose: () => void
}) {
  const toast = useToast()
  const { tenant } = useAuth()
  const adjust = useInventoryAdjust()
  const [branchId, setBranchId] = useState(defaultBranchId)
  const [direction, setDirection] = useState<Direction>('in')
  const [lines, setLines] = useState<Line[]>(initialProduct ? [{ product: initialProduct, qty: '' }] : [])
  const [reason, setReason] = useState('')
  const { data: stock = {}, isLoading: stockLoading } = useStockMap(branchId)
  const allowNegative = tenant?.allow_negative_stock ?? false

  const chosen = useMemo(() => new Set(lines.map((l) => l.product.id)), [lines])
  const parsed = lines.map((l) => positiveQty(l.qty))
  const ready = lines.length > 0 && parsed.every((q) => q !== null) && reason.trim() !== '' && Boolean(branchId)

  const submit = async () => {
    if (!ready) return
    try {
      await adjust.mutateAsync({
        branchId,
        reason,
        lines: lines.map((l, i) => ({ product_id: l.product.id, quantity: (direction === 'in' ? 1 : -1) * parsed[i]! })),
      })
      toast.success(`Ajuste registrado (${lines.length} producto${lines.length === 1 ? '' : 's'})`)
      onClose()
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo registrar el ajuste'))
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Ajuste de inventario"
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={adjust.isPending}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={!ready} loading={adjust.isPending}>
            Registrar {direction === 'in' ? 'entrada' : 'salida'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented
          value={direction}
          onChange={setDirection}
          label="Tipo de ajuste"
          options={[
            { value: 'in', label: 'Entrada (+)' },
            { value: 'out', label: 'Salida (−)' },
          ]}
        />
        <Field label="Sucursal" required>
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <ProductPicker products={products} excludeIds={chosen} stock={stock} onPick={(p) => setLines([...lines, { product: p, qty: '' }])} />
        {stockLoading ? <PageLoader label="Cargando existencias…" /> : <LineEditor lines={lines} setLines={setLines} stock={stock} resultSign={direction === 'in' ? 1 : -1} allowNegative={allowNegative} />}
        <Field label="Motivo" required hint="Queda en el kardex y en la bitácora.">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} list="adjust-reasons" placeholder="Ej.: Mercancía dañada" />
          <datalist id="adjust-reasons">
            {REASONS.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </Field>
      </div>
    </Modal>
  )
}

// ── Transferencia ───────────────────────────────────────────────────────────

export function TransferModal({
  branches,
  products,
  defaultBranchId,
  onClose,
}: {
  branches: Branch[]
  products: Product[]
  defaultBranchId: string
  onClose: () => void
}) {
  const toast = useToast()
  const { tenant } = useAuth()
  const transfer = useInventoryTransfer()
  const [fromId, setFromId] = useState(defaultBranchId)
  const [toId, setToId] = useState(() => branches.find((b) => b.id !== defaultBranchId)?.id ?? '')
  const [lines, setLines] = useState<Line[]>([])
  const [note, setNote] = useState('')
  const { data: stock = {}, isLoading: stockLoading } = useStockMap(fromId)

  const chosen = useMemo(() => new Set(lines.map((l) => l.product.id)), [lines])
  const parsed = lines.map((l) => positiveQty(l.qty))
  const sameBranch = fromId === toId
  const ready = lines.length > 0 && parsed.every((q) => q !== null) && Boolean(fromId) && Boolean(toId) && !sameBranch

  const changeFrom = (id: string) => {
    setFromId(id)
    if (id === toId) setToId(branches.find((b) => b.id !== id)?.id ?? '')
  }

  const submit = async () => {
    if (!ready) return
    try {
      await transfer.mutateAsync({
        fromBranchId: fromId,
        toBranchId: toId,
        note,
        lines: lines.map((l, i) => ({ product_id: l.product.id, quantity: parsed[i]! })),
      })
      toast.success('Transferencia registrada')
      onClose()
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo registrar la transferencia'))
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Transferencia entre sucursales"
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={transfer.isPending}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={!ready} loading={transfer.isPending}>
            Transferir
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
          <Field label="Desde" required>
            <Select value={fromId} onChange={(e) => changeFrom(e.target.value)}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <ArrowRight className="mx-auto mb-3 hidden h-5 w-5 text-slate-400 sm:block" />
          <Field label="Hacia" required error={sameBranch ? 'Elige otra sucursal' : undefined}>
            <Select value={toId} onChange={(e) => setToId(e.target.value)}>
              {branches
                .filter((b) => b.id !== fromId)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <ProductPicker products={products} excludeIds={chosen} stock={stock} onPick={(p) => setLines([...lines, { product: p, qty: '' }])} />
        {stockLoading ? (
          <PageLoader label="Cargando existencias…" />
        ) : (
          <LineEditor lines={lines} setLines={setLines} stock={stock} resultSign={-1} allowNegative={tenant?.allow_negative_stock ?? false} />
        )}
        <Field label="Nota">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Opcional" />
        </Field>
      </div>
    </Modal>
  )
}

// ── Conteo físico ───────────────────────────────────────────────────────────

const COUNT_PAGE = 40

type CountView = 'all' | 'counted' | 'diff'

/**
 * Conteo físico de una sucursal. Lo que se deja en blanco NO se cuenta (no se
 * toca); lo que se escribe se manda tal cual y la base calcula la diferencia
 * contra la existencia bloqueada en ese momento, así que la diferencia que se
 * ve aquí es una vista previa.
 */
export function CountModal({
  branches,
  products,
  defaultBranchId,
  onClose,
}: {
  branches: Branch[]
  products: Product[]
  defaultBranchId: string
  onClose: () => void
}) {
  const toast = useToast()
  const count = useInventoryCount()
  const [branchId, setBranchId] = useState(defaultBranchId)
  const [counted, setCounted] = useState<Record<string, string>>({})
  const [search, setSearch] = useState('')
  const [view, setView] = useState<CountView>('all')
  const [page, setPage] = useState(0)
  const [note, setNote] = useState('')
  const [confirming, setConfirming] = useState(false)
  const { data: stock = {}, isLoading: stockLoading } = useStockMap(branchId)

  const entries = useMemo(() => {
    const out: { product: Product; value: number }[] = []
    for (const p of products) {
      const raw = counted[p.id]
      if (raw === undefined || raw.trim() === '') continue
      const n = parseDecimal(raw)
      if (n !== null && !Number.isNaN(n) && n >= 0) out.push({ product: p, value: n })
    }
    return out
  }, [products, counted])
  const invalidCount = Object.values(counted).filter((v) => {
    if (v.trim() === '') return false
    const n = parseDecimal(v)
    return n === null || Number.isNaN(n) || n < 0
  }).length
  const diffCount = entries.filter((e) => e.value !== (stock[e.product.id] ?? 0)).length

  const visible = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return products.filter((p) => {
      if (terms.length && !terms.every((t) => productHaystack(p).includes(t))) return false
      const raw = counted[p.id]
      const has = raw !== undefined && raw.trim() !== ''
      if (view === 'counted' && !has) return false
      if (view === 'diff') {
        const n = has ? parseDecimal(raw) : null
        if (n === null || Number.isNaN(n) || n === (stock[p.id] ?? 0)) return false
      }
      return true
    })
  }, [products, search, view, counted, stock])
  const { slice, safePage } = paginate(visible, page, COUNT_PAGE)

  const changeBranch = (id: string) => {
    // Lo contado es de UNA sucursal: al cambiar se descarta para no aplicarlo en otra.
    if (entries.length > 0 && !window.confirm('Se descartarán las cantidades ya escritas. ¿Cambiar de sucursal?')) return
    setBranchId(id)
    setCounted({})
    setConfirming(false)
  }

  const submit = async () => {
    try {
      const res = await count.mutateAsync({
        branchId,
        note,
        counts: entries.map((e) => ({ product_id: e.product.id, counted: e.value })),
      })
      toast.success(
        res.differences === 0
          ? 'Conteo aplicado: todo cuadraba con el sistema.'
          : `Conteo aplicado: ${num(res.differences)} producto(s) ajustado(s).`,
      )
      onClose()
    } catch (err) {
      setConfirming(false)
      toast.error(errorMessage(err, 'No se pudo aplicar el conteo'))
    }
  }

  const branchName = branches.find((b) => b.id === branchId)?.name ?? ''

  return (
    <Modal
      open
      onClose={onClose}
      title="Conteo físico"
      size="lg"
      footer={
        confirming ? (
          <>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={count.isPending}>
              Volver
            </Button>
            <Button onClick={() => void submit()} loading={count.isPending}>
              Confirmar y aplicar
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button onClick={() => setConfirming(true)} disabled={entries.length === 0 || invalidCount > 0}>
              Aplicar conteo ({num(entries.length)})
            </Button>
          </>
        )
      }
    >
      {confirming ? (
        <div className="space-y-3 text-sm text-slate-700">
          <p>
            Se aplicará el conteo de <strong>{num(entries.length)}</strong> producto(s) en <strong>{branchName}</strong>.
          </p>
          <p>
            Según la existencia que ves ahora, <strong>{num(diffCount)}</strong> tienen diferencia y generarán un movimiento de
            ajuste. Si hubo ventas mientras contabas, el sistema calcula la diferencia contra la existencia del momento de
            aplicar.
          </p>
          <p className="text-slate-500">Los productos que dejaste en blanco no se modifican.</p>
          <Field label="Nota">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ej.: Conteo mensual, pasillo 3" />
          </Field>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Sucursal">
              <Select value={branchId} onChange={(e) => changeBranch(e.target.value)}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Mostrar">
              <Select
                value={view}
                onChange={(e) => {
                  setView(e.target.value as CountView)
                  setPage(0)
                }}
              >
                <option value="all">Todos los productos</option>
                <option value="counted">Solo contados</option>
                <option value="diff">Solo con diferencia</option>
              </Select>
            </Field>
          </div>
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
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge tone="brand">{num(entries.length)} contados</Badge>
            <Badge tone={diffCount > 0 ? 'amber' : 'green'}>{num(diffCount)} con diferencia</Badge>
            {invalidCount > 0 && <Badge tone="red">{num(invalidCount)} inválidos</Badge>}
          </div>

          {stockLoading ? (
            <PageLoader label="Cargando existencias…" />
          ) : products.length === 0 ? (
            <EmptyState title="Sin productos con control de existencia" description="Activa «Controlar existencia» en los productos que quieras contar." />
          ) : visible.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">Nada que mostrar con este filtro.</p>
          ) : (
            <div className="rounded-xl border border-slate-200">
              <ul className="divide-y divide-slate-100">
                {slice.map((p) => {
                  const current = stock[p.id] ?? 0
                  const raw = counted[p.id] ?? ''
                  const n = raw.trim() === '' ? null : parseDecimal(raw)
                  const invalid = n !== null && (Number.isNaN(n) || n < 0)
                  const diff = n === null || invalid ? null : n - current
                  return (
                    <li key={p.id} className="flex items-center gap-3 p-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-800">{productLabel(p)}</p>
                        <p className="text-xs text-slate-500">
                          Sistema: <span className="tabular-nums">{fmtQty(current)}</span> {p.unit}
                          {diff !== null && diff !== 0 && (
                            <span className={cn('ml-2 font-semibold tabular-nums', diff > 0 ? 'text-emerald-600' : 'text-red-600')}>
                              {diff > 0 ? '+' : ''}
                              {fmtQty(diff)}
                            </span>
                          )}
                          {diff === 0 && <span className="ml-2 text-emerald-600">Cuadra</span>}
                          {invalid && <span className="ml-2 font-medium text-red-600">Inválido</span>}
                        </p>
                      </div>
                      <Input
                        value={raw}
                        onChange={(e) => setCounted({ ...counted, [p.id]: e.target.value })}
                        inputMode="decimal"
                        placeholder="Contado"
                        aria-label={`Cantidad contada de ${p.name}`}
                        className={cn('w-28 text-right', invalid && 'border-red-300')}
                      />
                    </li>
                  )
                })}
              </ul>
              <Pagination page={safePage} pageSize={COUNT_PAGE} total={visible.length} onPage={setPage} label="productos" />
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
