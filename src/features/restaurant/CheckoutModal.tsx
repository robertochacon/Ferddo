import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRightLeft,
  Banknote,
  CheckCircle2,
  CreditCard,
  HandCoins,
  Printer,
  UserRound,
  X,
} from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useBranches, useCustomerBalances, useCustomers, useRegisters } from '@/hooks/core'
import { useOpenSessions } from '@/hooks/cash'
import { usePosFiscalSettings, usePreviewTotals, type SalePaymentPayload } from '@/hooks/pos'
import { useRestaurantCheckout, type RestCheckoutResult } from '@/hooks/restaurant'
import { useSaleDetailFetcher } from '@/hooks/sales'
import { useMemberNames } from '@/hooks/team'
import { errorMessage } from '@/lib/errors'
import { money } from '@/lib/format'
import { newClientUid, PAYMENT_METHOD_LABEL } from '@/lib/labels'
import { ECF_TYPE_LABEL, printSaleReceipt } from '@/features/pos/receipt'
import type { Customer, CustomerBalance, RestaurantOrder, RestaurantOrderItem } from '@/types/erp'
import {
  NumberInput,
  finePointer,
  fmtQty,
  fold,
  parseNum,
  pricePreview,
  r2,
  readStorage,
  serviceChargeOf,
  writeStorage,
  type PriceContext,
} from './shared'

/*
 * Cobro de una cuenta (completa o dividida) con `rest_checkout`.
 *
 * Tres pasos en el mismo diálogo: qué se cobra → cómo se paga → resultado.
 * El total que se cobra es el de `preview_totals()` (la base) + el 10 % sobre
 * su subtotal, igual que lo calculará create_sale; `priceLines` es solo la
 * vista previa del primer paso.
 *
 * Idempotencia: el client_uid se guarda en localStorage POR CUENTA desde el
 * primer intento y se reutiliza en cada reintento (incluso tras cerrar el
 * diálogo o recargar) hasta que la base confirma el cobro. Si una respuesta se
 * perdió por la red, el reintento devuelve la venta ya registrada en vez de
 * cobrar dos veces.
 */

type Mode = 'all' | 'split'
type Step = 'select' | 'pay' | 'done'
type EcfChoice = '' | '31' | '32'
type PayMethod = 'cash' | 'card' | 'transfer' | 'credit'

const PAY_ICON: Record<PayMethod, ReactNode> = {
  cash: <Banknote className="h-5 w-5" />,
  card: <CreditCard className="h-5 w-5" />,
  transfer: <ArrowRightLeft className="h-5 w-5" />,
  credit: <HandCoins className="h-5 w-5" />,
}

const uidKey = (tenantId: string, orderId: string) => `ferddo-rest-uid:${tenantId}:${orderId}`
const registerKey = (tenantId: string) => `ferddo-rest-register:${tenantId}`

export interface CheckoutModalProps {
  order: RestaurantOrder
  /** Líneas pendientes de cobro (ni cobradas ni anuladas). */
  items: RestaurantOrderItem[]
  tableName: string | null
  priceCtx: PriceContext
  service: boolean
  onServiceChange: (v: boolean) => void
  onClose: () => void
  /** Tras un cobro: `closed` = la cuenta quedó saldada. */
  onPaid: (closed: boolean) => void
}

export function CheckoutModal({
  order,
  items,
  tableName,
  priceCtx,
  service,
  onServiceChange,
  onClose,
  onPaid,
}: CheckoutModalProps) {
  const { tenant, can, hasModule } = useAuth()
  const toast = useToast()
  const registers = useRegisters()
  const sessions = useOpenSessions()
  const customers = useCustomers()
  const balances = useCustomerBalances()
  const fiscal = usePosFiscalSettings()
  const branches = useBranches()
  const names = useMemberNames()
  const preview = usePreviewTotals()
  const checkout = useRestaurantCheckout()
  const fetchDetail = useSaleDetailFetcher()

  const tenantId = tenant?.id ?? ''
  const currency = tenant?.currency ?? 'DOP'
  const m = (n: number) => money(n, currency)

  const [step, setStep] = useState<Step>('select')
  const [mode, setMode] = useState<Mode>('all')
  /** itemId → cantidad a cobrar (solo en modo dividir). */
  const [picked, setPicked] = useState<Record<string, number>>({})
  const [customerId, setCustomerId] = useState<string | null>(order.customer_id)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [ecfChoice, setEcfChoice] = useState<EcfChoice | null>(null)
  const [discount, setDiscount] = useState(0)
  const [payError, setPayError] = useState<string | null>(null)
  const [result, setResult] = useState<(RestCheckoutResult & { expected: number }) | null>(null)
  const [printing, setPrinting] = useState(false)

  // ── Caja: de esta sucursal y con turno abierto ──
  const branchRegisters = (registers.data ?? []).filter((r) => r.is_active && r.branch_id === order.branch_id)
  const openRegisterIds = new Set((sessions.data ?? []).map((s) => s.register_id))
  const usableRegisters = branchRegisters.filter((r) => openRegisterIds.has(r.id))
  const [registerId, setRegisterId] = useState<string>(() => readStorage(registerKey(tenantId)) ?? '')
  const register = usableRegisters.find((r) => r.id === registerId) ?? usableRegisters[0] ?? null
  const chooseRegister = (id: string) => {
    setRegisterId(id)
    writeStorage(registerKey(tenantId), id)
  }

  // ── Qué se cobra ──
  const selection = useMemo(
    () =>
      mode === 'all'
        ? items.map((it) => ({ item: it, quantity: it.quantity }))
        : items.filter((it) => (picked[it.id] ?? 0) > 0).map((it) => ({ item: it, quantity: picked[it.id] })),
    [mode, items, picked],
  )
  const lineInputs = selection.map((s) => ({ product_id: s.item.product_id, quantity: s.quantity }))
  const local = pricePreview(lineInputs, priceCtx, discount)
  const localService = service ? serviceChargeOf(local.subtotal) : 0
  const localTotal = r2(local.total + localService)

  // ── Cliente y comprobante (mismas reglas que el POS) ──
  const customer = customerId ? (customers.data?.find((c) => c.id === customerId) ?? null) : null
  const customerBalance = customer ? (balances.data?.[customer.id]?.balance ?? 0) : 0
  const ecfModule = hasModule('invoicing')
  const ecfEnabled = ecfModule && Boolean(fiscal.data?.ecf_enabled)
  const defaultEcf: EcfChoice = ecfEnabled ? (fiscal.data?.default_ecf_type === '31' ? '31' : '32') : ''
  const ecfType: EcfChoice = ecfEnabled ? (ecfChoice ?? defaultEcf) : ''
  const buyerIdentified = Boolean(customer && (customer.doc_type === 'rnc' || customer.doc_type === 'cedula'))
  const ecfError = ecfType === '31' && !buyerIdentified ? 'El crédito fiscal (31) exige un cliente con RNC o cédula.' : undefined
  const canDiscount = can('sales.discount')
  const allowCredit = can('sales.credit') && hasModule('credit')

  // ── Total de la base ──
  const serverTotal =
    preview.data && step !== 'select'
      ? r2(preview.data.total + (service ? serviceChargeOf(preview.data.subtotal) : 0))
      : null
  const loadServerTotal = () =>
    preview.mutate({ items: lineInputs, globalDiscount: discount, customerId })

  const goPay = () => {
    if (!selection.length) {
      toast.info('Elige qué líneas se cobran')
      return
    }
    if (!register) {
      toast.error('Abre una caja de esta sucursal para cobrar')
      return
    }
    if (ecfError) {
      toast.error(ecfError)
      return
    }
    if (discount > pricePreview(lineInputs, priceCtx).total + 0.001) {
      toast.error('El descuento no puede superar el total')
      return
    }
    setPayError(null)
    setStep('pay')
    loadServerTotal()
  }

  const confirm = (payments: SalePaymentPayload[]) => {
    if (!register || serverTotal == null) return
    // Mismo client_uid para todos los reintentos de esta cuenta hasta que entre.
    const key = uidKey(tenantId, order.id)
    const uid = readStorage(key) ?? newClientUid()
    writeStorage(key, uid)
    setPayError(null)
    const expected = serverTotal
    checkout.mutate(
      {
        order_id: order.id,
        client_uid: uid,
        register_id: register.id,
        ...(customerId ? { customer_id: customerId } : {}),
        ...(ecfType ? { ecf_type: ecfType } : {}),
        ...(discount > 0 ? { global_discount: discount } : {}),
        service_charge: service,
        payments,
        ...(mode === 'split' ? { lines: selection.map((s) => ({ order_item_id: s.item.id, quantity: s.quantity })) } : {}),
      },
      {
        onSuccess: (r) => {
          writeStorage(key, null)
          setResult({ ...r, expected })
          setStep('done')
          setPicked({})
          void printReceipt(r.sale_id)
        },
        onError: (err) => setPayError(errorMessage(err, 'No se pudo registrar el cobro')),
      },
    )
  }

  const printReceipt = async (saleId: string) => {
    if (!tenant) return
    setPrinting(true)
    try {
      const detail = await fetchDetail(saleId)
      printSaleReceipt({
        tenant,
        detail,
        register,
        branch: branches.data?.find((b) => b.id === detail.sale.branch_id) ?? null,
        cashierName: detail.sale.created_by ? names[detail.sale.created_by] : null,
        sellerName: detail.sale.seller_id ? names[detail.sale.seller_id] : null,
      })
    } catch (err) {
      toast.error(`El cobro está guardado, pero no se pudo imprimir: ${errorMessage(err)}`)
    } finally {
      setPrinting(false)
    }
  }

  // El cierre se bloquea mientras el cobro vuela: cerrar no lo cancela y la
  // persona creería que no se cobró.
  const close = () => {
    if (checkout.isPending) return
    // Un reintento (`replayed`) no dice si la cuenta cerró: se queda en ella y
    // el detalle refrescado lo muestra.
    if (step === 'done' && result) onPaid(result.order_closed === true)
    else onClose()
  }

  const remaining = items.length > 0 && result?.order_closed === false

  const title = { select: `Cobrar · ${tableName ?? 'Para llevar'} · ${order.number}`, pay: 'Cobrar', done: 'Cobro registrado' }[step]

  const footer: Record<Step, ReactNode> = {
    select: (
      <>
        <Button variant="outline" onClick={close}>
          Cancelar
        </Button>
        <Button onClick={goPay} disabled={!selection.length || !register}>
          Continuar · {m(localTotal)}
        </Button>
      </>
    ),
    pay: null,
    done: (
      <>
        <Button variant="outline" onClick={() => result && printReceipt(result.sale_id)} loading={printing}>
          <Printer className="h-4 w-4" /> Reimprimir
        </Button>
        {remaining ? (
          <Button
            onClick={() => {
              setResult(null)
              setMode('split')
              setStep('select')
            }}
          >
            Cobrar el resto
          </Button>
        ) : (
          <Button onClick={close} autoFocus>
            Listo
          </Button>
        )}
      </>
    ),
  }

  return (
    <Modal open onClose={close} title={title} size="lg" footer={footer[step]}>
      {step === 'select' && (
        <div className="space-y-4">
          <Segmented
            label="Qué se cobra"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'all', label: 'Toda la cuenta' },
              { value: 'split', label: 'Dividir cuenta' },
            ]}
          />

          {mode === 'split' && (
            <SplitPicker items={items} priceCtx={priceCtx} picked={picked} onChange={setPicked} currency={currency} />
          )}

          <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2.5">
            <span className="min-w-0">
              <span className="block text-sm font-medium text-slate-800">10 % de ley (servicio)</span>
              <span className="block text-xs text-slate-500">Sobre el subtotal sin ITBIS.</span>
            </span>
            <input
              type="checkbox"
              className="h-5 w-5 shrink-0 accent-brand-600"
              checked={service}
              onChange={(e) => onServiceChange(e.target.checked)}
            />
          </label>

          <div className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2">
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 text-left hover:bg-slate-50"
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
                    : 'Toca para elegir un cliente (opcional)'}
                </span>
              </span>
            </button>
            {customer && (
              <button
                type="button"
                aria-label="Quitar cliente"
                onClick={() => setCustomerId(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {ecfModule && (
              <Field
                label="Comprobante"
                error={ecfError}
                hint={!ecfEnabled ? 'La facturación electrónica no está activada en esta empresa.' : undefined}
              >
                <Select
                  value={ecfType}
                  onChange={(e) => setEcfChoice(e.target.value as EcfChoice)}
                  disabled={!ecfEnabled}
                >
                  <option value="">Sin comprobante fiscal</option>
                  <option value="32">e-CF 32 · Consumo</option>
                  <option value="31">e-CF 31 · Crédito fiscal</option>
                </Select>
              </Field>
            )}
            {canDiscount && (
              <Field label="Descuento general (monto)">
                <NumberInput value={discount} decimals={2} onCommit={(n) => setDiscount(Math.max(0, n))} />
              </Field>
            )}
          </div>

          <RegisterPicker
            loading={registers.isLoading || sessions.isLoading}
            branchRegisters={branchRegisters.length}
            usable={usableRegisters}
            value={register?.id ?? ''}
            onChange={chooseRegister}
          />

          <dl className="space-y-1 rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
            <TotalRow label="Subtotal" value={m(local.subtotal)} />
            {local.discount_total > 0 && <TotalRow label="Descuento" value={`−${m(local.discount_total)}`} />}
            <TotalRow label="ITBIS" value={m(local.tax_total)} />
            {service && <TotalRow label="Servicio (10 % de ley)" value={m(localService)} />}
            <div className="flex items-baseline justify-between pt-1">
              <dt className="font-semibold text-slate-800">Total (vista previa)</dt>
              <dd className="text-xl font-bold tabular-nums text-slate-900">{m(localTotal)}</dd>
            </div>
            <p className="text-xs text-slate-500">El sistema confirma el importe exacto en el siguiente paso.</p>
          </dl>

          <CustomerPickerModal
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            customers={customers.data ?? []}
            balances={balances.data ?? {}}
            currency={currency}
            onPick={(c) => {
              setCustomerId(c?.id ?? null)
              setPickerOpen(false)
            }}
          />
        </div>
      )}

      {step === 'pay' && (
        <PaymentStep
          currency={currency}
          total={serverTotal}
          localTotal={localTotal}
          totalLoading={preview.isPending}
          totalError={preview.isError ? errorMessage(preview.error) : null}
          onRetryTotal={loadServerTotal}
          customer={customer}
          creditAvailable={customer ? Number(customer.credit_limit) - customerBalance : 0}
          allowCredit={allowCredit}
          submitting={checkout.isPending}
          error={payError}
          onBack={() => setStep('select')}
          onConfirm={confirm}
        />
      )}

      {step === 'done' && result && (
        <PaidSummary result={result} currency={currency} printing={printing} remainingLines={result.order_closed === false} />
      )}
    </Modal>
  )
}

// ── Dividir ─────────────────────────────────────────────────────────────────

function SplitPicker({
  items,
  priceCtx,
  picked,
  onChange,
  currency,
}: {
  items: RestaurantOrderItem[]
  priceCtx: PriceContext
  picked: Record<string, number>
  onChange: (next: Record<string, number>) => void
  currency: string
}) {
  const set = (id: string, qty: number) => onChange({ ...picked, [id]: qty })
  const allPicked = items.every((it) => (picked[it.id] ?? 0) === it.quantity)
  return (
    <div className="rounded-xl border border-slate-200">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
        <p className="text-sm font-medium text-slate-700">Elige qué se cobra ahora</p>
        <button
          type="button"
          className="shrink-0 text-xs font-semibold text-brand-700"
          onClick={() => onChange(allPicked ? {} : Object.fromEntries(items.map((it) => [it.id, it.quantity])))}
        >
          {allPicked ? 'Ninguna' : 'Todas'}
        </button>
      </div>
      <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto">
        {items.map((it) => {
          const p = priceCtx.productMap.get(it.product_id)
          const qty = picked[it.id] ?? 0
          const on = qty > 0
          const unit = pricePreview([{ product_id: it.product_id, quantity: 1 }], priceCtx).total
          return (
            <li key={it.id} className="flex items-center gap-2 px-3 py-2">
              <input
                type="checkbox"
                aria-label={`Cobrar ${p?.name ?? 'producto'}`}
                className="h-5 w-5 shrink-0 accent-brand-600"
                checked={on}
                onChange={(e) => set(it.id, e.target.checked ? it.quantity : 0)}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-800">{p?.name ?? 'Producto'}</p>
                <p className="truncate text-xs text-slate-500">
                  {fmtQty(it.quantity)} × {money(unit, currency)}
                  {it.notes ? ` · ${it.notes}` : ''}
                </p>
              </div>
              {/* Cantidad parcial: "media orden de tostones para cada uno". */}
              {it.quantity > 1 || !Number.isInteger(it.quantity) ? (
                <NumberInput
                  aria-label="Cantidad a cobrar"
                  value={qty}
                  decimals={3}
                  onCommit={(n) => set(it.id, Math.min(Math.max(0, n), it.quantity))}
                  className="h-10 w-20 shrink-0 text-center"
                />
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function RegisterPicker({
  loading,
  branchRegisters,
  usable,
  value,
  onChange,
}: {
  loading: boolean
  branchRegisters: number
  usable: { id: string; name: string }[]
  value: string
  onChange: (id: string) => void
}) {
  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner size="sm" /> Buscando cajas abiertas…
      </p>
    )
  }
  if (!usable.length) {
    return (
      <div className="rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
        {branchRegisters
          ? 'No hay ninguna caja abierta en esta sucursal. '
          : 'Esta sucursal no tiene cajas. Créala en Configuración y '}
        <Link to="/caja" className="font-semibold underline">
          Abre una caja
        </Link>{' '}
        para poder cobrar.
      </div>
    )
  }
  return (
    <Field label="Caja">
      <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={usable.length === 1}>
        {usable.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </Select>
    </Field>
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

// ── Pago ────────────────────────────────────────────────────────────────────

function PaymentStep({
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
  onBack,
  onConfirm,
}: {
  currency: string
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
  onBack: () => void
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
  else if (credit > 0 && !customer) problem = 'Para cobrar a crédito selecciona un cliente.'
  else if (credit > 0 && change > 0) problem = 'Un cobro a crédito no lleva devuelta: ajusta los montos.'
  else if (credit > 0 && credit > creditAvailable + 0.001)
    problem = `El crédito disponible de ${customer?.name ?? 'este cliente'} es ${m(Math.max(0, creditAvailable))}.`

  const ready = total != null && !totalLoading && !totalError
  const canConfirm = ready && !problem && missing === 0 && !submitting
  const differs = total != null && Math.abs(total - localTotal) >= 0.01

  const set = (k: PayMethod, v: string) => setAmounts((a) => ({ ...a, [k]: v }))
  const fill = (k: PayMethod) => set(k, String(r2(Math.max(0, due - r2(paid - val(k))))))

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
        {differs && !totalLoading && (
          <p className="mt-1 text-xs text-amber-200">
            La vista previa era {m(localTotal)}; vale el importe que calcula el sistema.
          </p>
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
                className="min-w-0 flex-1"
                label={
                  <span className="flex items-center gap-1.5">
                    {PAY_ICON[k]} {k === 'cash' ? 'Efectivo recibido' : PAYMENT_METHOD_LABEL[k]}
                  </span>
                }
                hint={
                  k === 'credit'
                    ? customer
                      ? `Disponible: ${m(Math.max(0, creditAvailable))}`
                      : 'Selecciona un cliente para cobrar a crédito.'
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

      {/* La botonera va dentro del formulario (y no en el pie del Modal) para
          que Enter en cualquier campo confirme el cobro. */}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onBack} disabled={submitting}>
          Volver
        </Button>
        <Button type="submit" disabled={!canConfirm} loading={submitting}>
          Confirmar cobro
        </Button>
      </div>
    </form>
  )
}

// ── Resultado ───────────────────────────────────────────────────────────────

function PaidSummary({
  result,
  currency,
  printing,
  remainingLines,
}: {
  result: RestCheckoutResult & { expected: number }
  currency: string
  printing: boolean
  remainingLines: boolean
}) {
  const m = (n: number) => money(n, currency)
  const differs = !result.replayed && Math.abs(result.total - result.expected) >= 0.01
  return (
    <div className="space-y-4 text-center">
      <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
      <div>
        <p className="text-sm text-slate-500">Venta {result.number}</p>
        <p className="text-2xl font-bold tabular-nums text-slate-900">{m(result.total)}</p>
        {differs && (
          <p className="mt-1 text-xs text-amber-700">
            Total registrado por el sistema (se mostró {m(result.expected)}).
          </p>
        )}
      </div>
      {result.change_due > 0 && (
        <div className="rounded-2xl bg-emerald-50 px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-emerald-700">Devuelta</p>
          <p className="text-4xl font-bold tabular-nums text-emerald-800">{m(result.change_due)}</p>
        </div>
      )}
      {result.replayed && (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Este cobro ya se había registrado en un intento anterior: no se cobró dos veces. Revisa qué quedó pendiente
          en la cuenta.
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
      {remainingLines ? (
        <p className="rounded-xl bg-brand-50 px-3 py-2 text-sm font-medium text-brand-800">
          La cuenta sigue abierta con lo que falta por cobrar.
        </p>
      ) : (
        result.order_closed && (
          <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700">Cuenta saldada y cerrada.</p>
        )
      )}
      {printing && (
        <p className="flex items-center justify-center gap-2 text-sm text-slate-500">
          <Spinner size="sm" /> Preparando el ticket…
        </p>
      )}
    </div>
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
  useEffect(() => {
    if (open) setQ('')
  }, [open])
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
      </div>
    </Modal>
  )
}
