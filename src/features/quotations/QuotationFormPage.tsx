import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { addDays, format } from 'date-fns'
import { AlertTriangle, ArrowLeft, Check, Plus, Printer, Save, Send, ShoppingBag, Trash2, X } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { PageHeader } from '@/components/PageHeader'
import { RequireAccess } from '@/components/RequireAccess'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useBranches, useCustomers, useProducts, useTaxes } from '@/hooks/core'
import { customerPriceListId, useListPrices } from '@/hooks/priceLists'
import {
  useQuotation,
  useSaveQuotation,
  useSetQuotationStatus,
  type QuotationDetail,
  type SaveQuotationInput,
} from '@/hooks/quotations'
import { errorMessage } from '@/lib/errors'
import { fmtDate, fmtDateShort, money, norm } from '@/lib/format'
import { QUOTATION_STATUS } from '@/lib/labels'
import { priceLines } from '@/lib/pricing'
import { esc, printHtml } from '@/lib/print'
import type { Customer, Product, Quotation, QuotationStatus } from '@/types/erp'
import type { Tenant } from '@/types/db'
import { parseAmount, round2 } from '@/features/receivables/paymentShared'
import { ProductPicker } from '@/features/purchases/ProductPicker'
import { effectiveStatus, isConvertible } from './quotationStatus'

interface Line {
  key: string
  product_id: string
  description: string
  quantity: string
  /** Solo cuenta si `overridden`: si no, el precio es el base vigente (lista del cliente o catálogo). */
  unit_price: string
  /** Precio escrito a mano. Solo estas líneas mandan `unit_price` a la base. */
  overridden: boolean
  discount: string
  tax_rate: number
}

interface Header {
  customer_id: string
  branch_id: string
  valid_until: string
  global_discount: string
  notes: string
  terms: string
}

const emptyHeader = (): Header => ({
  customer_id: '',
  branch_id: '',
  valid_until: format(addDays(new Date(), 15), 'yyyy-MM-dd'),
  global_discount: '',
  notes: '',
  terms: '',
})

const num = (s: string) => {
  const n = parseAmount(s)
  return Number.isFinite(n) ? n : 0
}

function serialize(h: Header, ls: Line[]): string {
  // Una línea sin precio manual sigue al precio base: su `unit_price` guardado
  // no significa nada y no debe marcar el formulario como cambiado.
  return JSON.stringify({
    h,
    l: ls.map((l) => [l.product_id, l.quantity, l.overridden ? l.unit_price : '', l.discount]),
  })
}

export function QuotationFormPage() {
  return (
    <RequireAccess module="quotations" perm="quotations.manage">
      <QuotationForm />
    </RequireAccess>
  )
}

function QuotationForm() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const toast = useToast()
  const { tenant, can, hasModule } = useAuth()
  const currency = tenant?.currency ?? 'DOP'
  const canOverride = can('sales.price_override')
  const canDiscount = can('sales.discount')
  const canSell = hasModule('pos') && can('sales.create')

  const detail = useQuotation(id)
  const customers = useCustomers()
  const branches = useBranches()
  const products = useProducts()
  const taxes = useTaxes()
  const save = useSaveQuotation()
  const setStatus = useSetQuotationStatus()

  const [header, setHeader] = useState<Header>(emptyHeader)
  const [lines, setLines] = useState<Line[]>([])
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [customerSearch, setCustomerSearch] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [repriced, setRepriced] = useState(false)

  const quotation = detail.data?.quotation
  const shownStatus = quotation ? effectiveStatus(quotation) : 'draft'
  // Mismo criterio que save_quotation(): solo se editan borradores y enviadas.
  const editable = !quotation || quotation.status === 'draft' || quotation.status === 'sent'

  const productById = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p])), [products.data])
  const rateOf = (p: Product | undefined) => Number((taxes.data ?? []).find((t) => t.id === p?.tax_id)?.rate ?? 0)

  // Precio base = el que pondrá save_quotation(): lista del cliente si el
  // producto está en ella, si no el del catálogo. Antes de cargar una
  // cotización existente manda SU cliente, para comparar sus líneas con él.
  const pricingCustomerId = !id || loadedFor ? header.customer_id : (detail.data?.quotation.customer_id ?? '')
  const pricingCustomer = (customers.data ?? []).find((c) => c.id === pricingCustomerId)
  const listPrices = useListPrices(customerPriceListId(pricingCustomer))
  const basePriceOf = useCallback(
    (productId: string): number | undefined => {
      const listed = listPrices.prices?.get(productId)
      if (listed !== undefined) return listed
      const p = productById.get(productId)
      return p ? Number(p.price) : undefined
    },
    [listPrices.prices, productById],
  )
  const effPrice = useCallback(
    (l: Line): string => {
      if (l.overridden) return l.unit_price
      const base = basePriceOf(l.product_id)
      return base === undefined ? l.unit_price : String(base)
    },
    [basePriceOf],
  )
  const listName = listPrices.prices ? (listPrices.list?.name ?? null) : null

  const current = serialize(header, lines)
  const dirty = !id || current !== snapshot

  useEffect(() => {
    if (!id || !detail.data || !products.data || !taxes.data) return
    // Sin la lista del cliente, una línea cotizada a precio de lista parecería
    // un precio cambiado a mano.
    if (detail.data.quotation.customer_id && (customers.isLoading || listPrices.isLoading)) return
    const stamp = `${id}:${detail.dataUpdatedAt}`
    if (loadedFor === stamp) return
    if (loadedFor?.startsWith(`${id}:`) && dirty) return
    const q = detail.data.quotation
    const h: Header = {
      customer_id: q.customer_id ?? '',
      branch_id: q.branch_id,
      valid_until: q.valid_until,
      global_discount: q.global_discount ? String(q.global_discount) : '',
      notes: q.notes ?? '',
      terms: q.terms ?? '',
    }
    let changed = false
    const ls: Line[] = detail.data.items.map((it) => {
      const p = productById.get(it.product_id)
      const base = basePriceOf(it.product_id)
      // Igual al base: la línea sigue al precio vigente (y se repreciará si
      // cambia el cliente). Distinto: quien puede cambiar precios conserva el
      // cotizado; quien no, ve el vigente, que es el que pondrá la base.
      const differs = base !== undefined && it.unit_price !== base
      if (differs && !canOverride) changed = true
      return {
        key: it.id,
        product_id: it.product_id,
        description: it.description,
        quantity: String(it.quantity),
        unit_price: String(it.unit_price),
        overridden: differs && canOverride,
        discount: it.line_discount ? String(it.line_discount) : '',
        tax_rate: p ? rateOf(p) : it.tax_rate,
      }
    })
    setHeader(h)
    setLines(ls)
    // Si se repreció, el formulario arranca "con cambios" para que se vea y se guarde.
    setSnapshot(changed && editable ? '' : serialize(h, ls))
    setRepriced(changed && editable)
    setLoadedFor(stamp)
    // rateOf/productById derivan de products/taxes, que ya están en las dependencias.
  }, [
    id,
    detail.data,
    detail.dataUpdatedAt,
    products.data,
    taxes.data,
    loadedFor,
    dirty,
    canOverride,
    editable,
    customers.isLoading,
    listPrices.isLoading,
    basePriceOf,
  ])

  useEffect(() => {
    if (!id && !header.branch_id && branches.data?.length) {
      const main = branches.data.find((b) => b.is_main && b.is_active) ?? branches.data.find((b) => b.is_active)
      if (main) setHeader((h) => ({ ...h, branch_id: main.id }))
    }
  }, [id, header.branch_id, branches.data])

  const preview = useMemo(
    () =>
      priceLines(
        lines.map((l) => ({
          quantity: num(l.quantity),
          unit_price: num(effPrice(l)),
          discount: canDiscount ? num(l.discount) : 0,
          tax_rate: l.tax_rate,
        })),
        canDiscount ? num(header.global_discount) : 0,
        tenant?.prices_include_tax ?? true,
      ),
    [lines, header.global_discount, canDiscount, tenant?.prices_include_tax, effPrice],
  )

  const sellable = useMemo(() => (products.data ?? []).filter((p) => p.is_active), [products.data])
  const customerOptions = useMemo(() => {
    const s = norm(customerSearch)
    const list = (customers.data ?? []).filter(
      (c) => (c.is_active && !('_pendingSync' in c)) || c.id === header.customer_id,
    )
    const filtered = s ? list.filter((c) => norm(c.name).includes(s) || (c.doc_number ?? '').includes(customerSearch.trim())) : list
    return filtered.slice(0, 200)
  }, [customers.data, customerSearch, header.customer_id])
  const customer = (customers.data ?? []).find((c) => c.id === header.customer_id)

  const addProduct = (p: Product) => {
    setLines((ls) => {
      const existing = ls.find((l) => l.product_id === p.id)
      if (existing) return ls.map((l) => (l === existing ? { ...l, quantity: String(num(l.quantity) + 1) } : l))
      return [
        ...ls,
        {
          key: crypto.randomUUID(),
          product_id: p.id,
          description: p.name + (p.variant_label ? ` ${p.variant_label}` : ''),
          quantity: '1',
          unit_price: String(Number(p.price)),
          overridden: false,
          discount: '',
          tax_rate: rateOf(p),
        },
      ]
    })
  }
  const patchLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  const validate = (): string | null => {
    if (!header.branch_id) return 'Elige la sucursal'
    if (lines.length === 0) return 'Agrega al menos un producto o servicio'
    if (!header.valid_until) return 'Indica hasta cuándo es válida'
    for (const l of lines) {
      const q = parseAmount(l.quantity)
      if (!Number.isFinite(q) || q <= 0) return `Cantidad inválida en "${l.description}"`
      const pr = parseAmount(effPrice(l))
      if (!Number.isFinite(pr) || pr < 0) return `Precio inválido en "${l.description}"`
      const d = l.discount.trim() ? parseAmount(l.discount) : 0
      if (!Number.isFinite(d) || d < 0 || d > round2(q * pr)) return `Descuento inválido en "${l.description}"`
    }
    const gd = header.global_discount.trim() ? parseAmount(header.global_discount) : 0
    if (!Number.isFinite(gd) || gd < 0) return 'Descuento general inválido'
    return null
  }

  const submit = async () => {
    const err = validate()
    setFormError(err)
    if (err) return
    const payload: SaveQuotationInput = {
      id,
      branch_id: header.branch_id,
      customer_id: header.customer_id || null,
      valid_until: header.valid_until,
      notes: header.notes.trim() || null,
      terms: header.terms.trim() || null,
      global_discount: canDiscount ? num(header.global_discount) : 0,
      items: lines.map((l) => ({
        product_id: l.product_id,
        quantity: num(l.quantity),
        // Solo el precio escrito a mano: sin él la base pone el de la lista del
        // cliente (o el del catálogo), y quien no puede cambiar precios nunca
        // manda uno que la base rechazaría.
        ...(canOverride && l.overridden ? { unit_price: num(l.unit_price) } : {}),
        ...(canDiscount && num(l.discount) > 0 ? { discount: num(l.discount) } : {}),
      })),
    }
    try {
      const savedId = await save.mutateAsync(payload)
      setSnapshot(current)
      setRepriced(false)
      toast.success('Cotización guardada')
      if (!id) navigate(`/cotizaciones/${savedId}`, { replace: true })
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  const changeStatus = async (status: Exclude<QuotationStatus, 'converted'>, label: string) => {
    if (!quotation) return
    try {
      await setStatus.mutateAsync({ id: quotation.id, status })
      toast.success(`Cotización marcada como ${label}`)
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  // Las líneas se arman con el catálogo (precio vigente, tasa de ITBIS): hasta
  // que llega, se espera en vez de enseñar un formulario vacío.
  if (
    id &&
    (detail.isLoading ||
      (detail.data && !loadedFor && (products.isLoading || taxes.isLoading || customers.isLoading || listPrices.isLoading)))
  ) {
    return <PageLoader label="Cargando cotización…" />
  }
  if (id && (detail.isError || !detail.data)) {
    return (
      <EmptyState
        icon={<AlertTriangle className="h-6 w-6" />}
        title={detail.isError ? 'No se pudo cargar la cotización' : 'Cotización no encontrada'}
        description={detail.isError ? errorMessage(detail.error) : undefined}
        action={<Button onClick={() => navigate('/cotizaciones')}>Volver a cotizaciones</Button>}
      />
    )
  }

  const saved = Boolean(quotation) && !dirty
  const totals =
    quotation && !dirty
      ? { subtotal: quotation.subtotal, discount: quotation.discount_total, tax: quotation.tax_total, total: quotation.total }
      : { subtotal: preview.subtotal, discount: preview.discount_total, tax: preview.tax_total, total: preview.total }
  const convertible = quotation ? isConvertible(quotation) : false

  const print = () => {
    if (!tenant || !detail.data) return
    printHtml(quotationHtml(tenant, detail.data, customer, currency), 'letter', `Cotización ${detail.data.quotation.number}`)
  }

  return (
    <div>
      <Link to="/cotizaciones" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-4 w-4" /> Cotizaciones
      </Link>
      <PageHeader
        title={quotation ? `Cotización ${quotation.number}` : 'Nueva cotización'}
        description={quotation ? `Creada el ${fmtDate(quotation.created_at)}` : 'Los importes finales los calcula el sistema al guardar.'}
        action={
          quotation && <Badge tone={QUOTATION_STATUS[shownStatus].tone}>{QUOTATION_STATUS[shownStatus].label}</Badge>
        }
      />

      {quotation?.status === 'converted' && quotation.converted_sale_id && (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Convertida en venta.{' '}
          <Link to={`/ventas/${quotation.converted_sale_id}`} className="font-semibold underline">
            Ver la venta
          </Link>
        </div>
      )}
      {repriced && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Algunos precios cambiaron (en el catálogo o en la lista de precios del cliente) desde que se hizo esta
          cotización. Al guardarla se usarán los vigentes.
        </div>
      )}

      {quotation && (
        <div className="mb-4 flex flex-wrap gap-2">
          <Button variant="outline" onClick={print} disabled={!saved} title={saved ? undefined : 'Guarda los cambios antes de imprimir'}>
            <Printer className="h-4 w-4" /> Imprimir / PDF
          </Button>
          {quotation.status === 'draft' && (
            <Button variant="outline" loading={setStatus.isPending} onClick={() => void changeStatus('sent', 'enviada')}>
              <Send className="h-4 w-4" /> Marcar enviada
            </Button>
          )}
          {(quotation.status === 'draft' || quotation.status === 'sent') && (
            <>
              <Button variant="outline" loading={setStatus.isPending} onClick={() => void changeStatus('accepted', 'aceptada')}>
                <Check className="h-4 w-4" /> Aceptada
              </Button>
              <Button variant="outline" loading={setStatus.isPending} onClick={() => void changeStatus('rejected', 'rechazada')}>
                <X className="h-4 w-4" /> Rechazada
              </Button>
            </>
          )}
          {(quotation.status === 'accepted' || quotation.status === 'rejected' || quotation.status === 'expired') && (
            <Button variant="ghost" loading={setStatus.isPending} onClick={() => void changeStatus('draft', 'borrador')}>
              Reabrir como borrador
            </Button>
          )}
          {canSell && (
            <Button
              onClick={() => navigate('/pos', { state: { quotationId: quotation.id } })}
              disabled={!convertible || dirty}
              title={!convertible ? 'Convertida, rechazada o vencida' : dirty ? 'Guarda los cambios primero' : undefined}
            >
              <ShoppingBag className="h-4 w-4" /> Convertir en venta
            </Button>
          )}
        </div>
      )}

      <div className="space-y-4">
        <Card>
          <CardHeader title="Datos" />
          <CardBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Cliente"
                hint={listName ? `Lista de precios: ${listName}` : 'Opcional: se puede cotizar a un cliente de paso.'}
              >
                {editable && (customers.data ?? []).length > 20 && (
                  <Input
                    value={customerSearch}
                    onChange={(e) => setCustomerSearch(e.target.value)}
                    placeholder="Filtrar clientes…"
                    className="mb-2"
                  />
                )}
                <Select
                  value={header.customer_id}
                  disabled={!editable}
                  onChange={(e) => setHeader((h) => ({ ...h, customer_id: e.target.value }))}
                >
                  <option value="">Sin cliente</option>
                  {customerOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.doc_number ? ` · ${c.doc_number}` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Sucursal" required>
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
                <Field label="Válida hasta" required>
                  <Input
                    type="date"
                    value={header.valid_until}
                    disabled={!editable}
                    onChange={(e) => setHeader((h) => ({ ...h, valid_until: e.target.value }))}
                  />
                </Field>
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Productos y servicios"
            action={
              editable && (
                <Button size="sm" onClick={() => setPickerOpen(true)} disabled={products.isLoading}>
                  <Plus className="h-4 w-4" /> Agregar
                </Button>
              )
            }
          />
          {lines.length === 0 ? (
            <p className="p-5 text-sm text-slate-500">Agrega lo que vas a cotizar.</p>
          ) : editable ? (
            <ul className="divide-y divide-slate-100">
              {lines.map((l, i) => {
                const priced = preview.lines[i]
                const fromList = listPrices.prices?.has(l.product_id) ?? false
                const baseLabel = fromList ? 'Precio de lista' : 'Precio del catálogo'
                const base = basePriceOf(l.product_id)
                return (
                  <li key={l.key} className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 font-medium text-slate-800">{l.description}</p>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Quitar línea"
                        onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      <Field label="Cantidad">
                        <Input inputMode="decimal" value={l.quantity} onChange={(e) => patchLine(l.key, { quantity: e.target.value })} />
                      </Field>
                      <Field
                        label="Precio"
                        hint={
                          l.overridden && base !== undefined ? (
                            <button
                              type="button"
                              className="font-medium text-brand-700 underline"
                              onClick={() => patchLine(l.key, { overridden: false })}
                            >
                              Volver a {baseLabel.toLowerCase()} ({money(base, currency)})
                            </button>
                          ) : canOverride && !fromList ? undefined : (
                            baseLabel
                          )
                        }
                      >
                        <Input
                          inputMode="decimal"
                          value={effPrice(l)}
                          readOnly={!canOverride}
                          className={canOverride ? undefined : 'bg-slate-50'}
                          onChange={(e) => patchLine(l.key, { unit_price: e.target.value, overridden: true })}
                        />
                      </Field>
                      {canDiscount && (
                        <Field label="Descuento" className="col-span-2 sm:col-span-1">
                          <Input
                            inputMode="decimal"
                            value={l.discount}
                            placeholder="0"
                            onChange={(e) => patchLine(l.key, { discount: e.target.value })}
                          />
                        </Field>
                      )}
                    </div>
                    {priced && (
                      <p className="text-right text-sm text-slate-500">
                        ITBIS {money(priced.tax_amount, currency)} · <b className="text-slate-800">{money(priced.total, currency)}</b>
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          ) : (
            <ReadOnlyLines detail={detail.data!} currency={currency} />
          )}
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardBody className="space-y-4">
              <Field label="Notas">
                <Textarea
                  rows={3}
                  value={header.notes}
                  disabled={!editable}
                  onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))}
                />
              </Field>
              <Field label="Términos y condiciones" hint="Forma de pago, tiempo de entrega, garantía…">
                <Textarea
                  rows={3}
                  value={header.terms}
                  disabled={!editable}
                  onChange={(e) => setHeader((h) => ({ ...h, terms: e.target.value }))}
                />
              </Field>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="space-y-3">
              {editable && canDiscount && (
                <Field label="Descuento general (monto)">
                  <Input
                    inputMode="decimal"
                    value={header.global_discount}
                    placeholder="0"
                    onChange={(e) => setHeader((h) => ({ ...h, global_discount: e.target.value }))}
                  />
                </Field>
              )}
              <dl className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <dt className="text-slate-500">Subtotal</dt>
                  <dd className="tabular-nums">{money(totals.subtotal, currency)}</dd>
                </div>
                {totals.discount > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-slate-500">Descuentos</dt>
                    <dd className="tabular-nums">−{money(totals.discount, currency)}</dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt className="text-slate-500">ITBIS</dt>
                  <dd className="tabular-nums">{money(totals.tax, currency)}</dd>
                </div>
                <div className="flex justify-between border-t border-slate-100 pt-2 text-base font-bold">
                  <dt>Total</dt>
                  <dd className="tabular-nums">{money(totals.total, currency)}</dd>
                </div>
                {editable && dirty && (
                  <p className="pt-1 text-right text-xs text-slate-400">Vista previa: el sistema recalcula al guardar.</p>
                )}
              </dl>
            </CardBody>
          </Card>
        </div>

        {formError && <p className="text-sm font-medium text-red-600">{formError}</p>}

        {editable && (
          <div className="flex justify-end">
            <Button onClick={() => void submit()} loading={save.isPending} disabled={!dirty} className="w-full sm:w-auto">
              <Save className="h-4 w-4" /> {quotation ? 'Guardar cambios' : 'Guardar cotización'}
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
    </div>
  )
}

function ReadOnlyLines({ detail, currency }: { detail: QuotationDetail; currency: string }) {
  return (
    <>
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3 font-medium">Descripción</th>
              <th className="px-4 py-3 text-right font-medium">Cantidad</th>
              <th className="px-4 py-3 text-right font-medium">Precio</th>
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
                <td className="px-4 py-3 text-right tabular-nums">{money(it.unit_price, currency)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{it.discount ? money(it.discount, currency) : '—'}</td>
                <td className="px-4 py-3 text-right tabular-nums">{money(it.tax_amount, currency)}</td>
                <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(it.total, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <DataList>
        {detail.items.map((it) => (
          <DataRow key={it.id} title={it.description} titleExtra={`${it.quantity} × ${money(it.unit_price, currency)}`}>
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
 * Cotización en carta para imprimir o "Guardar como PDF" desde el diálogo del
 * navegador. Se arma SOLO con lo guardado en la base (importes incluidos).
 */
function quotationHtml(tenant: Tenant, d: QuotationDetail, customer: Customer | undefined, currency: string): string {
  const q: Quotation = d.quotation
  const m = (n: number) => esc(money(n, currency))
  const logo = tenant.logo_url ? `<img src="${esc(tenant.logo_url)}" alt="" style="max-height:60px;max-width:180px;margin-bottom:6px">` : ''
  const rows = d.items
    .map(
      (it) => `<tr>
        <td>${esc(it.description)}</td>
        <td class="r">${esc(it.quantity)}</td>
        <td class="r">${m(it.unit_price)}</td>
        <td class="r">${it.discount ? m(it.discount) : '—'}</td>
        <td class="r">${m(it.total)}</td>
      </tr>`,
    )
    .join('')
  const docLabel: Record<Customer['doc_type'], string> = { rnc: 'RNC', cedula: 'Cédula', passport: 'Pasaporte', none: '' }
  return `<div class="doc">
    <table><tr>
      <td>
        ${logo}
        <h2>${esc(tenant.legal_name || tenant.name)}</h2>
        ${tenant.rnc ? `<p class="muted">RNC ${esc(tenant.rnc)}</p>` : ''}
        ${tenant.address ? `<p class="muted">${esc(tenant.address)}</p>` : ''}
        ${[tenant.phone, tenant.email].filter(Boolean).length ? `<p class="muted">${esc([tenant.phone, tenant.email].filter(Boolean).join(' · '))}</p>` : ''}
      </td>
      <td class="r">
        <h2>COTIZACIÓN</h2>
        <p class="b">${esc(q.number)}</p>
        <p class="muted">Fecha: ${esc(fmtDateShort(q.created_at))}</p>
        <p class="muted">Válida hasta: ${esc(fmtDateShort(q.valid_until))}</p>
      </td>
    </tr></table>
    <div class="hr"></div>
    <p class="muted">Cliente</p>
    ${
      customer
        ? `<p class="b">${esc(customer.name)}</p>
           ${customer.doc_type !== 'none' ? `<p>${esc(docLabel[customer.doc_type])} ${esc(customer.doc_number)}</p>` : ''}
           ${customer.phone ? `<p>Tel. ${esc(customer.phone)}</p>` : ''}
           ${customer.address ? `<p>${esc(customer.address)}</p>` : ''}`
        : '<p>Cliente de contado</p>'
    }
    <table style="margin-top:14px">
      <thead><tr><th>Descripción</th><th class="r">Cant.</th><th class="r">Precio</th><th class="r">Desc.</th><th class="r">Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <table style="margin-top:10px;width:auto;margin-left:auto">
      <tr><td class="muted">Subtotal</td><td class="r" style="padding-left:24px">${m(q.subtotal)}</td></tr>
      ${q.discount_total > 0 ? `<tr><td class="muted">Descuentos</td><td class="r">−${m(q.discount_total)}</td></tr>` : ''}
      <tr><td class="muted">ITBIS</td><td class="r">${m(q.tax_total)}</td></tr>
      <tr><td class="b" style="font-size:15px">Total</td><td class="r b" style="font-size:15px">${m(q.total)}</td></tr>
    </table>
    ${q.notes ? `<h3 style="margin-top:16px">Notas</h3><p style="white-space:pre-line">${esc(q.notes)}</p>` : ''}
    ${q.terms ? `<h3 style="margin-top:16px">Términos y condiciones</h3><p style="white-space:pre-line">${esc(q.terms)}</p>` : ''}
    <p class="muted" style="margin-top:24px">Precios en ${esc(currency)}. Cotización sujeta a disponibilidad hasta la fecha de validez.</p>
  </div>`
}
