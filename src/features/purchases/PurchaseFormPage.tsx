import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Ban, PackageCheck, Plus, Save, Send, Trash2 } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { PageHeader } from '@/components/PageHeader'
import { RequireAccess } from '@/components/RequireAccess'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useBranches, useProducts, useSuppliers, useTaxes } from '@/hooks/core'
import { usePayableForSource } from '@/hooks/payables'
import {
  useCancelPurchase,
  usePurchase,
  useReceivePurchase,
  useSavePurchase,
  type PurchaseDetail,
  type SavePurchaseInput,
} from '@/hooks/purchases'
import { errorMessage } from '@/lib/errors'
import { fmtDate, fmtDateShort, fmtDateTime, money } from '@/lib/format'
import { DOCUMENT_STATUS, newClientUid, PURCHASE_STATUS } from '@/lib/labels'
import type { PaymentMethod, Product } from '@/types/erp'
import { parseAmount, PaymentFields, round2, todayIso } from '@/features/receivables/paymentShared'
import { AttachmentField } from './AttachmentField'
import { ProductPicker } from './ProductPicker'

interface Line {
  /** Clave local de React; las líneas no tienen id propio hasta guardarse. */
  key: string
  product_id: string
  description: string
  quantity: string
  unit_cost: string
  discount: string
  tax_rate: number
}

interface Header {
  supplier_id: string
  branch_id: string
  supplier_invoice: string
  supplier_ncf: string
  order_date: string
  due_date: string
  notes: string
  attachment_path: string | null
}

const emptyHeader = (): Header => ({
  supplier_id: '',
  branch_id: '',
  supplier_invoice: '',
  supplier_ncf: '',
  order_date: todayIso(),
  due_date: '',
  notes: '',
  attachment_path: null,
})

/**
 * Vista previa de una línea con la MISMA regla que save_purchase(): base =
 * cantidad × costo − descuento, ITBIS = base × tasa, redondeando como la base.
 * Solo es una vista previa: al guardar, la base recalcula y lo que se enseña
 * después es lo suyo.
 */
function lineCalc(l: Line) {
  const qty = parseAmount(l.quantity)
  const cost = parseAmount(l.unit_cost)
  const disc = l.discount.trim() === '' ? 0 : parseAmount(l.discount)
  const gross = Number.isFinite(qty) && Number.isFinite(cost) ? round2(qty * cost) : NaN
  const base = round2(gross - (Number.isFinite(disc) ? disc : 0))
  const tax = round2(base * l.tax_rate)
  return { qty, cost, disc, gross, base, tax, total: round2(base + tax) }
}

/** Huella del formulario para saber si hay cambios sin guardar (sin las claves locales de React). */
function serialize(h: Header, ls: Line[]): string {
  return JSON.stringify({ h, l: ls.map((l) => [l.product_id, l.quantity, l.unit_cost, l.discount, l.tax_rate]) })
}

function fromDetail(d: PurchaseDetail): { header: Header; lines: Line[] } {
  const p = d.purchase
  return {
    header: {
      supplier_id: p.supplier_id,
      branch_id: p.branch_id,
      supplier_invoice: p.supplier_invoice ?? '',
      supplier_ncf: p.supplier_ncf ?? '',
      order_date: p.order_date,
      due_date: p.due_date ?? '',
      notes: p.notes ?? '',
      attachment_path: p.attachment_path,
    },
    lines: d.items.map((it) => ({
      key: it.id,
      product_id: it.product_id,
      description: it.description,
      quantity: String(it.quantity),
      unit_cost: String(it.unit_cost),
      discount: it.discount ? String(it.discount) : '',
      tax_rate: it.tax_rate,
    })),
  }
}

export function PurchaseFormPage() {
  return (
    <RequireAccess module="purchases" perm="purchases.manage">
      <PurchaseForm />
    </RequireAccess>
  )
}

function PurchaseForm() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const toast = useToast()
  const { tenant, can } = useAuth()
  const currency = tenant?.currency ?? 'DOP'

  const detail = usePurchase(id)
  const suppliers = useSuppliers()
  const branches = useBranches()
  const products = useProducts()
  const taxes = useTaxes()
  const payable = usePayableForSource('purchase', detail.data?.purchase.status === 'received' ? id : undefined)
  const save = useSavePurchase()

  const [header, setHeader] = useState<Header>(emptyHeader)
  const [lines, setLines] = useState<Line[]>([])
  // Id del documento cuyo estado está cargado en el formulario. Al pasar de
  // "nueva" a "/compras/:id" tras guardar, la pantalla no se desmonta: se
  // vuelve a cargar con lo que devolvió la base (sus importes son los que valen).
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const purchase = detail.data?.purchase
  const status = purchase?.status ?? 'draft'
  const editable = !purchase || status === 'draft' || status === 'ordered'

  const current = serialize(header, lines)
  const dirty = !id || current !== snapshot

  useEffect(() => {
    if (!id || !detail.data) return
    const stamp = `${id}:${detail.dataUpdatedAt}`
    if (loadedFor === stamp) return
    // Una recarga en segundo plano no pisa lo que el usuario está editando;
    // tras guardar sí entra, porque guardar deja el formulario "limpio".
    if (loadedFor?.startsWith(`${id}:`) && dirty) return
    const { header: h, lines: ls } = fromDetail(detail.data)
    setHeader(h)
    setLines(ls)
    setSnapshot(serialize(h, ls))
    setLoadedFor(stamp)
  }, [id, detail.data, detail.dataUpdatedAt, loadedFor, dirty])

  // Sucursal por defecto en una compra nueva: la principal.
  useEffect(() => {
    if (!id && !header.branch_id && branches.data?.length) {
      const main = branches.data.find((b) => b.is_main && b.is_active) ?? branches.data.find((b) => b.is_active)
      if (main) setHeader((h) => ({ ...h, branch_id: main.id }))
    }
  }, [id, header.branch_id, branches.data])

  const taxRates = useMemo(() => {
    const rates = new Set<number>([0])
    for (const t of taxes.data ?? []) if (t.is_active) rates.add(Number(t.rate))
    return [...rates].sort((a, b) => b - a)
  }, [taxes.data])

  const purchasable = useMemo(
    () => (products.data ?? []).filter((p) => p.is_active && p.kind === 'product'),
    [products.data],
  )
  const supplierOptions = useMemo(
    () => (suppliers.data ?? []).filter((s) => s.is_active || s.id === header.supplier_id),
    [suppliers.data, header.supplier_id],
  )
  const selectedSupplier = (suppliers.data ?? []).find((s) => s.id === header.supplier_id)

  const preview = useMemo(() => {
    const calcs = lines.map(lineCalc)
    const sum = (k: 'base' | 'tax' | 'total') => round2(calcs.reduce((s, c) => s + (Number.isFinite(c[k]) ? c[k] : 0), 0))
    const disc = round2(calcs.reduce((s, c) => s + (Number.isFinite(c.disc) ? c.disc : 0), 0))
    return { subtotal: sum('base'), discount: disc, tax: sum('tax'), total: sum('total') }
  }, [lines])

  const addProduct = (p: Product) => {
    const rate = Number((taxes.data ?? []).find((t) => t.id === p.tax_id)?.rate ?? 0)
    setLines((ls) => {
      // Elegir dos veces el mismo producto suma cantidad en vez de duplicar la línea.
      const existing = ls.find((l) => l.product_id === p.id)
      if (existing) {
        return ls.map((l) =>
          l === existing ? { ...l, quantity: String((parseAmount(l.quantity) || 0) + 1) } : l,
        )
      }
      return [
        ...ls,
        {
          key: crypto.randomUUID(),
          product_id: p.id,
          description: p.name + (p.variant_label ? ` · ${p.variant_label}` : ''),
          quantity: '1',
          unit_cost: String(Number(p.cost)),
          discount: '',
          tax_rate: rate,
        },
      ]
    })
  }

  const patchLine = (key: string, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  const validate = (): string | null => {
    if (!header.supplier_id) return 'Elige el proveedor'
    if (!header.branch_id) return 'Elige la sucursal que recibe la mercancía'
    if (lines.length === 0) return 'Agrega al menos un producto'
    for (const l of lines) {
      const c = lineCalc(l)
      if (!Number.isFinite(c.qty) || c.qty <= 0) return `Cantidad inválida en "${l.description}"`
      if (!Number.isFinite(c.cost) || c.cost < 0) return `Costo inválido en "${l.description}"`
      if (!Number.isFinite(c.disc) || c.disc < 0 || c.disc > c.gross) return `Descuento inválido en "${l.description}"`
    }
    if (header.due_date && header.due_date < header.order_date) return 'El vencimiento no puede ser antes de la fecha de la orden'
    return null
  }

  const submit = async (target: 'draft' | 'ordered', e?: FormEvent) => {
    e?.preventDefault()
    const err = validate()
    setFormError(err)
    if (err) return
    const payload: SavePurchaseInput = {
      id,
      branch_id: header.branch_id,
      supplier_id: header.supplier_id,
      status: target,
      supplier_invoice: header.supplier_invoice.trim() || null,
      supplier_ncf: header.supplier_ncf.trim() || null,
      order_date: header.order_date || null,
      due_date: header.due_date || null,
      notes: header.notes.trim() || null,
      attachment_path: header.attachment_path,
      items: lines.map((l) => {
        const c = lineCalc(l)
        return { product_id: l.product_id, quantity: c.qty, unit_cost: c.cost, discount: c.disc, tax_rate: l.tax_rate }
      }),
    }
    try {
      const savedId = await save.mutateAsync(payload)
      setSnapshot(current)
      toast.success(target === 'ordered' ? 'Orden de compra guardada' : 'Borrador guardado')
      if (!id) navigate(`/compras/${savedId}`, { replace: true })
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  if (id && detail.isLoading) return <PageLoader label="Cargando compra…" />
  if (id && (detail.isError || !detail.data)) {
    return (
      <EmptyState
        icon={<AlertTriangle className="h-6 w-6" />}
        title={detail.isError ? 'No se pudo cargar la compra' : 'Compra no encontrada'}
        description={detail.isError ? errorMessage(detail.error) : undefined}
        action={<Button onClick={() => navigate('/compras')}>Volver a compras</Button>}
      />
    )
  }

  const shownTotals =
    purchase && !dirty
      ? { subtotal: purchase.subtotal, discount: purchase.discount_total, tax: purchase.tax_total, total: purchase.total }
      : preview

  return (
    <div>
      <Link to="/compras" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-4 w-4" /> Compras
      </Link>
      <PageHeader
        title={purchase ? `Compra ${purchase.number}` : 'Nueva compra'}
        description={
          purchase
            ? `Creada el ${fmtDate(purchase.created_at)}${purchase.received_at ? ` · recibida el ${fmtDateTime(purchase.received_at)}` : ''}`
            : 'Carga la factura del proveedor. Guárdala como borrador u orden y recíbela cuando llegue la mercancía.'
        }
        action={purchase && <Badge tone={PURCHASE_STATUS[status].tone}>{PURCHASE_STATUS[status].label}</Badge>}
      />

      {status === 'canceled' && purchase?.canceled_reason && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Cancelada: {purchase.canceled_reason}
        </div>
      )}

      {status === 'received' && (
        <Card className="mb-4">
          <CardBody className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            {payable.isLoading ? (
              <p className="text-sm text-slate-500">Buscando la cuenta por pagar…</p>
            ) : payable.data ? (
              <div className="text-sm">
                <p className="font-medium text-slate-800">
                  Cuenta por pagar: {money(round2(payable.data.amount - payable.data.paid_amount), currency)} pendiente
                  <Badge tone={DOCUMENT_STATUS[payable.data.status].tone} className="ml-2">
                    {DOCUMENT_STATUS[payable.data.status].label}
                  </Badge>
                </p>
                <p className="text-slate-500">
                  Total {money(payable.data.amount, currency)} · pagado {money(payable.data.paid_amount, currency)} · vence{' '}
                  {fmtDateShort(payable.data.due_date)}
                </p>
              </div>
            ) : (
              <p className="text-sm text-slate-500">Esta compra no generó deuda.</p>
            )}
            {payable.data && (
              <Link to="/cuentas-por-pagar" className="text-sm font-medium text-brand-600 hover:underline">
                Ver en cuentas por pagar →
              </Link>
            )}
          </CardBody>
        </Card>
      )}

      <form onSubmit={(e) => void submit(status === 'ordered' ? 'ordered' : 'draft', e)} className="space-y-4">
        <Card>
          <CardHeader title="Datos de la compra" />
          <CardBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Proveedor"
                required
                hint={
                  supplierOptions.length === 0 && !suppliers.isLoading ? (
                    <>
                      No hay proveedores. <Link to="/proveedores" className="text-brand-600 underline">Crea uno</Link>.
                    </>
                  ) : undefined
                }
              >
                <Select
                  value={header.supplier_id}
                  disabled={!editable}
                  onChange={(e) => setHeader((h) => ({ ...h, supplier_id: e.target.value }))}
                >
                  <option value="">Selecciona…</option>
                  {supplierOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Sucursal que recibe" required>
                <Select
                  value={header.branch_id}
                  disabled={!editable}
                  onChange={(e) => setHeader((h) => ({ ...h, branch_id: e.target.value }))}
                >
                  <option value="">Selecciona…</option>
                  {(branches.data ?? [])
                    .filter((b) => b.is_active || b.id === header.branch_id)
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Factura del proveedor">
                <Input
                  value={header.supplier_invoice}
                  disabled={!editable}
                  maxLength={60}
                  onChange={(e) => setHeader((h) => ({ ...h, supplier_invoice: e.target.value }))}
                />
              </Field>
              <Field label="NCF / e-NCF" hint="Para el reporte 606.">
                <Input
                  value={header.supplier_ncf}
                  disabled={!editable}
                  maxLength={19}
                  onChange={(e) => setHeader((h) => ({ ...h, supplier_ncf: e.target.value.toUpperCase() }))}
                  placeholder="B0100000001"
                />
              </Field>
              <Field label="Fecha">
                <Input
                  type="date"
                  value={header.order_date}
                  disabled={!editable}
                  onChange={(e) => setHeader((h) => ({ ...h, order_date: e.target.value }))}
                />
              </Field>
              <Field
                label="Vence"
                hint={
                  !header.due_date && editable
                    ? `Vacío = ${selectedSupplier?.payment_terms_days ?? 0} días de crédito del proveedor, al recibir.`
                    : undefined
                }
              >
                <Input
                  type="date"
                  value={header.due_date}
                  min={header.order_date}
                  disabled={!editable}
                  onChange={(e) => setHeader((h) => ({ ...h, due_date: e.target.value }))}
                />
              </Field>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Field label="Notas">
                <Textarea
                  rows={2}
                  value={header.notes}
                  disabled={!editable}
                  onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))}
                />
              </Field>
              <Field label="Adjunto" hint={editable ? 'Foto o PDF de la factura del proveedor.' : undefined}>
                <AttachmentField
                  folder="purchases"
                  path={header.attachment_path}
                  disabled={!editable}
                  onChange={(path) => setHeader((h) => ({ ...h, attachment_path: path }))}
                />
              </Field>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Productos"
            subtitle={editable ? 'Costo unitario sin ITBIS. El costo del producto se actualiza al recibir.' : undefined}
            action={
              editable && (
                <Button type="button" size="sm" onClick={() => setPickerOpen(true)} disabled={products.isLoading}>
                  <Plus className="h-4 w-4" /> Agregar
                </Button>
              )
            }
          />
          {lines.length === 0 ? (
            <p className="p-5 text-sm text-slate-500">Todavía no hay productos en esta compra.</p>
          ) : editable ? (
            <ul className="divide-y divide-slate-100">
              {lines.map((l) => {
                const c = lineCalc(l)
                return (
                  <li key={l.key} className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 font-medium text-slate-800">{l.description}</p>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label="Quitar línea"
                        onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Field label="Cantidad">
                        <Input inputMode="decimal" value={l.quantity} onChange={(e) => patchLine(l.key, { quantity: e.target.value })} />
                      </Field>
                      <Field label="Costo unitario">
                        <Input inputMode="decimal" value={l.unit_cost} onChange={(e) => patchLine(l.key, { unit_cost: e.target.value })} />
                      </Field>
                      <Field label="Descuento">
                        <Input
                          inputMode="decimal"
                          value={l.discount}
                          placeholder="0"
                          onChange={(e) => patchLine(l.key, { discount: e.target.value })}
                        />
                      </Field>
                      <Field label="ITBIS">
                        <Select value={String(l.tax_rate)} onChange={(e) => patchLine(l.key, { tax_rate: Number(e.target.value) })}>
                          {taxRates.map((r) => (
                            <option key={r} value={String(r)}>
                              {Math.round(r * 10000) / 100}%
                            </option>
                          ))}
                          {!taxRates.includes(l.tax_rate) && (
                            <option value={String(l.tax_rate)}>{Math.round(l.tax_rate * 10000) / 100}%</option>
                          )}
                        </Select>
                      </Field>
                    </div>
                    <p className="text-right text-sm text-slate-500">
                      Base {Number.isFinite(c.base) ? money(c.base, currency) : '—'} · ITBIS{' '}
                      {Number.isFinite(c.tax) ? money(c.tax, currency) : '—'} ·{' '}
                      <b className="text-slate-800">{Number.isFinite(c.total) ? money(c.total, currency) : '—'}</b>
                    </p>
                  </li>
                )
              })}
            </ul>
          ) : (
            <ReadOnlyLines detail={detail.data!} currency={currency} />
          )}
        </Card>

        <Card>
          <CardBody>
            <dl className="ml-auto max-w-xs space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">Subtotal</dt>
                <dd className="tabular-nums">{money(shownTotals.subtotal, currency)}</dd>
              </div>
              {shownTotals.discount > 0 && (
                <div className="flex justify-between">
                  <dt className="text-slate-500">Descuentos (incluidos)</dt>
                  <dd className="tabular-nums">−{money(shownTotals.discount, currency)}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-slate-500">ITBIS</dt>
                <dd className="tabular-nums">{money(shownTotals.tax, currency)}</dd>
              </div>
              <div className="flex justify-between border-t border-slate-100 pt-2 text-base font-bold">
                <dt>Total</dt>
                <dd className="tabular-nums">{money(shownTotals.total, currency)}</dd>
              </div>
              {editable && dirty && (
                <p className="pt-1 text-right text-xs text-slate-400">Vista previa: el total final lo calcula el sistema al guardar.</p>
              )}
            </dl>
          </CardBody>
        </Card>

        {formError && <p className="text-sm font-medium text-red-600">{formError}</p>}

        {editable && (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
            {purchase && (
              <Button type="button" variant="ghost" onClick={() => setCancelOpen(true)}>
                <Ban className="h-4 w-4" /> Cancelar compra
              </Button>
            )}
            {status === 'draft' && (
              <Button type="button" variant="outline" loading={save.isPending} onClick={() => void submit('draft')}>
                <Save className="h-4 w-4" /> Guardar borrador
              </Button>
            )}
            <Button
              type="button"
              variant={purchase ? 'outline' : 'primary'}
              loading={save.isPending}
              onClick={() => void submit('ordered')}
            >
              <Send className="h-4 w-4" /> {status === 'ordered' ? 'Guardar orden' : 'Guardar como orden'}
            </Button>
            {purchase && (
              <Button
                type="button"
                onClick={() => setReceiveOpen(true)}
                disabled={dirty}
                title={dirty ? 'Guarda los cambios antes de recibir' : undefined}
              >
                <PackageCheck className="h-4 w-4" /> Recibir mercancía
              </Button>
            )}
          </div>
        )}
        {editable && purchase && dirty && (
          <p className="text-right text-xs text-amber-600">Hay cambios sin guardar: guárdalos antes de recibir la mercancía.</p>
        )}
      </form>

      <ProductPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        products={purchasable}
        onPick={addProduct}
        show="cost"
        currency={currency}
      />
      {purchase && receiveOpen && (
        <ReceiveModal
          purchaseId={purchase.id}
          number={purchase.number}
          total={purchase.total}
          canPay={can('payables.manage')}
          currency={currency}
          onClose={() => setReceiveOpen(false)}
        />
      )}
      {purchase && cancelOpen && (
        <CancelModal purchaseId={purchase.id} number={purchase.number} onClose={() => setCancelOpen(false)} />
      )}
    </div>
  )
}

function ReadOnlyLines({ detail, currency }: { detail: PurchaseDetail; currency: string }) {
  const pct = (r: number) => `${Math.round(r * 10000) / 100}%`
  return (
    <>
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3 font-medium">Producto</th>
              <th className="px-4 py-3 text-right font-medium">Cantidad</th>
              <th className="px-4 py-3 text-right font-medium">Costo</th>
              <th className="px-4 py-3 text-right font-medium">Descuento</th>
              <th className="px-4 py-3 text-right font-medium">ITBIS</th>
              <th className="px-4 py-3 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {detail.items.map((it) => (
              <tr key={it.id}>
                <td className="px-4 py-3 text-slate-800">{it.description}</td>
                <td className="px-4 py-3 text-right tabular-nums">{it.quantity}</td>
                <td className="px-4 py-3 text-right tabular-nums">{money(it.unit_cost, currency)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{it.discount ? money(it.discount, currency) : '—'}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {money(it.tax_amount, currency)} <span className="text-xs text-slate-400">({pct(it.tax_rate)})</span>
                </td>
                <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(it.total, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <DataList>
        {detail.items.map((it) => (
          <DataRow key={it.id} title={it.description} titleExtra={`${it.quantity} × ${money(it.unit_cost, currency)}`}>
            <DataFields cols={3}>
              <DataField label="Descuento">{it.discount ? money(it.discount, currency) : '—'}</DataField>
              <DataField label="ITBIS">{money(it.tax_amount, currency)}</DataField>
              <DataField label="Total">{money(it.total, currency)}</DataField>
            </DataFields>
          </DataRow>
        ))}
      </DataList>
    </>
  )
}

/**
 * Confirmación de recepción, con pago opcional en el acto. Un client_uid por
 * apertura: si la red se cae después de que la base confirmó, reintentar no
 * paga dos veces (y la compra ya recibida rechaza una segunda recepción).
 */
function ReceiveModal({
  purchaseId,
  number,
  total,
  canPay,
  currency,
  onClose,
}: {
  purchaseId: string
  number: string
  total: number
  canPay: boolean
  currency: string
  onClose: () => void
}) {
  const toast = useToast()
  const receive = useReceivePurchase()
  const [uid] = useState(newClientUid)
  const [payNow, setPayNow] = useState(false)
  const [amount, setAmount] = useState(String(total))
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [registerId, setRegisterId] = useState('')
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string | null>(null)

  const confirm = async () => {
    setError(null)
    let payment = null
    if (payNow) {
      const value = round2(parseAmount(amount))
      if (!Number.isFinite(value) || value <= 0) return setError('Escribe un monto mayor que cero')
      if (value > total) return setError(`El pago no puede pasar de ${money(total, currency)}`)
      payment = {
        client_uid: uid,
        amount: value,
        method,
        register_id: method === 'cash' && registerId ? registerId : null,
        reference: reference.trim() || null,
      }
    }
    try {
      await receive.mutateAsync({ id: purchaseId, payment })
      toast.success(`Compra ${number} recibida: el inventario ya se actualizó`)
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Recibir compra ${number}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void confirm()} loading={receive.isPending}>
            <PackageCheck className="h-4 w-4" /> Confirmar recepción
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          Entrará la mercancía a inventario, se actualizará el costo de cada producto y se creará una cuenta por pagar
          de <b>{money(total, currency)}</b>. Después de recibirla ya no se puede editar.
        </p>
        {canPay && total > 0 && (
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300"
              checked={payNow}
              onChange={(e) => setPayNow(e.target.checked)}
            />
            Pagar ahora (total o parcial)
          </label>
        )}
        {payNow && (
          <div className="space-y-4 rounded-xl border border-slate-100 p-4">
            <Field label="Monto pagado" required>
              <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <PaymentFields
              method={method}
              onMethod={setMethod}
              registerId={registerId}
              onRegister={setRegisterId}
              cashRegister="optional"
            />
            <Field label="Referencia">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />
            </Field>
          </div>
        )}
        {error && <p className="text-sm font-medium text-red-600">{error}</p>}
      </div>
    </Modal>
  )
}

function CancelModal({ purchaseId, number, onClose }: { purchaseId: string; number: string; onClose: () => void }) {
  const toast = useToast()
  const cancel = useCancelPurchase()
  const [reason, setReason] = useState('')

  const confirm = async () => {
    try {
      await cancel.mutateAsync({ id: purchaseId, reason: reason.trim() })
      toast.success(`Compra ${number} cancelada`)
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Cancelar compra ${number}`}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Volver
          </Button>
          <Button variant="danger" onClick={() => void confirm()} loading={cancel.isPending} disabled={!reason.trim()}>
            Cancelar compra
          </Button>
        </>
      }
    >
      <Field label="Motivo" required hint="Queda en la bitácora. La compra no movió inventario ni deuda.">
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
    </Modal>
  )
}
