import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRightLeft, Banknote, CheckCircle2, CreditCard, HandCoins } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/misc'
import { useBranches, useProducts, useRegisters } from '@/hooks/core'
import { useOpenSessions } from '@/hooks/cash'
import { usePosFiscalSettings, usePreviewTotals, type SalePaymentPayload } from '@/hooks/pos'
import { useTeamMembers } from '@/hooks/team'
import { useCheckoutAppointment } from '@/hooks/appointments'
import { errorMessage } from '@/lib/errors'
import { money } from '@/lib/format'
import { PAYMENT_METHOD_LABEL } from '@/lib/labels'
import { ECF_TYPE_LABEL } from '@/features/pos/receipt'
import { parseAmount, round2 } from '@/features/receivables/paymentShared'
import type { Appointment, CreateSaleResult, Customer } from '@/types/erp'

/*
 * Cobro de una cita con appt_checkout (→ create_sale).
 *
 * Mismo molde que el cobro del taller: el total que vale es el de
 * preview_totals() (la base, con la lista de precios del cliente), pedido al
 * abrir; los pagos se validan aquí solo para avisar antes de enviar. El
 * client_uid lo genera quien abre el diálogo y se conserva en cada reintento,
 * así un "falló la red" que en realidad sí entró no cobra dos veces.
 */

type EcfChoice = '' | '31' | '32'
type PayMethod = 'cash' | 'card' | 'transfer' | 'credit'

const PAY_ICON: Record<PayMethod, ReactNode> = {
  cash: <Banknote className="h-5 w-5" />,
  card: <CreditCard className="h-5 w-5" />,
  transfer: <ArrowRightLeft className="h-5 w-5" />,
  credit: <HandCoins className="h-5 w-5" />,
}

/** La caja que el cajero usa en el POS (solo se LEE, para proponerla por defecto). */
function readPosRegister(tenantId: string): string | null {
  try {
    return localStorage.getItem(`ferddo-pos-register:${tenantId}`)
  } catch {
    return null
  }
}

export function AppointmentCheckoutModal({
  appointment,
  customer,
  balance,
  clientUid,
  currency,
  onClose,
  onDone,
}: {
  appointment: Appointment
  customer: Customer | null
  /** Deuda abierta del cliente (para el crédito disponible). */
  balance: number
  clientUid: string
  currency: string
  onClose: () => void
  onDone: (r: CreateSaleResult, registerId: string) => void
}) {
  const m = (n: number) => money(n, currency)
  const { can, hasModule } = useAuth()
  const fiscal = usePosFiscalSettings()
  const products = useProducts()
  const preview = usePreviewTotals()
  const checkout = useCheckoutAppointment()

  // Sin servicio en la cita, appt_checkout exige decir qué se cobra.
  const [chargeId, setChargeId] = useState(appointment.service_id ?? '')
  const [registerId, setRegisterId] = useState('')
  const [ecfChoice, setEcfChoice] = useState<EcfChoice | null>(null)
  const [amounts, setAmounts] = useState<Record<PayMethod, string>>({ cash: '', card: '', transfer: '', credit: '' })
  const [refs, setRefs] = useState<{ card: string; transfer: string }>({ card: '', transfer: '' })
  const [error, setError] = useState<string | null>(null)

  const sellable = useMemo(() => {
    const all = products.data ?? []
    const parents = new Set(all.map((p) => p.parent_id).filter(Boolean) as string[])
    return all
      .filter((p) => p.is_active && !parents.has(p.id))
      .sort((x, y) => Number(y.kind === 'service') - Number(x.kind === 'service'))
  }, [products.data])
  const chargeName = products.data?.find((p) => p.id === chargeId)?.name ?? appointment.title

  const loadTotal = () => {
    if (!chargeId) return
    preview.mutate({
      items: [{ product_id: chargeId, quantity: 1 }],
      globalDiscount: 0,
      // appt_checkout factura a nombre del cliente de la cita: su lista de
      // precios (si tiene) es la que manda en el total.
      customerId: appointment.customer_id,
    })
  }
  useEffect(() => {
    loadTotal()
    // Se pide al abrir y cada vez que cambia lo que se cobra (y con "Reintentar").
  }, [chargeId])

  const total = chargeId ? (preview.data?.total ?? null) : null

  // ── Comprobante (mismas reglas que el POS) ──
  const ecfModule = hasModule('invoicing')
  const ecfEnabled = ecfModule && Boolean(fiscal.data?.ecf_enabled)
  const defaultEcf: EcfChoice = ecfEnabled ? (fiscal.data?.default_ecf_type === '31' ? '31' : '32') : ''
  const ecfType: EcfChoice = ecfEnabled ? (ecfChoice ?? defaultEcf) : ''
  const buyerIdentified = Boolean(customer && (customer.doc_type === 'rnc' || customer.doc_type === 'cedula'))
  const ecfError = ecfType === '31' && !buyerIdentified ? 'El crédito fiscal (31) exige un cliente con RNC o cédula.' : undefined

  // ── Pagos ──
  const allowCredit = hasModule('credit') && can('sales.credit') && Boolean(customer)
  const creditAvailable = round2((customer?.credit_limit ?? 0) - balance)
  const val = (k: PayMethod) => {
    const n = parseAmount(amounts[k])
    return Number.isNaN(n) || n < 0 ? 0 : round2(n)
  }
  const cash = val('cash')
  const card = val('card')
  const transfer = val('transfer')
  const credit = allowCredit ? val('credit') : 0
  const nonCash = round2(card + transfer + credit)
  const paid = round2(cash + nonCash)
  const owed = total ?? 0
  const missing = round2(Math.max(0, owed - paid))
  const change = round2(Math.max(0, paid - owed))

  // Mismas reglas que create_sale(); aquí solo para avisar antes de enviar.
  let problem: string | null = null
  if (!chargeId) problem = 'Elige qué se cobra.'
  else if (nonCash > owed + 0.001) problem = 'Tarjeta, transferencia y crédito no pueden superar el total.'
  else if (credit > 0 && change > 0) problem = 'Una venta a crédito no lleva devuelta: ajusta los montos.'
  else if (credit > 0 && credit > creditAvailable + 0.001)
    problem = `El crédito disponible de ${customer?.name ?? 'este cliente'} es ${m(Math.max(0, creditAvailable))}.`
  else if (ecfError) problem = ecfError

  const ready = total != null && !preview.isPending && !preview.isError
  const canConfirm = ready && !problem && missing === 0 && Boolean(registerId) && !checkout.isPending

  const set = (k: PayMethod, v: string) => setAmounts((a) => ({ ...a, [k]: v }))
  const fill = (k: PayMethod) => {
    const others = round2(paid - val(k))
    set(k, String(round2(Math.max(0, owed - others))))
  }

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (!canConfirm) return
    const payments: SalePaymentPayload[] = []
    if (cash > 0) payments.push({ method: 'cash', amount: cash })
    if (card > 0) payments.push({ method: 'card', amount: card, reference: refs.card.trim() || null })
    if (transfer > 0) payments.push({ method: 'transfer', amount: transfer, reference: refs.transfer.trim() || null })
    if (credit > 0) payments.push({ method: 'credit', amount: credit })
    setError(null)
    checkout.mutate(
      {
        appointment_id: appointment.id,
        client_uid: clientUid,
        register_id: registerId,
        ecf_type: ecfType || null,
        payments,
        // Sin `items`, la base cobra el servicio de la cita: solo se mandan si
        // se eligió otra cosa (o la cita no tenía servicio).
        ...(chargeId !== appointment.service_id ? { items: [{ product_id: chargeId, quantity: 1 }] } : {}),
      },
      {
        onSuccess: (r) => onDone(r, registerId),
        onError: (err) => setError(errorMessage(err, 'No se pudo cobrar la cita')),
      },
    )
  }

  const methods: PayMethod[] = allowCredit ? ['cash', 'card', 'transfer', 'credit'] : ['cash', 'card', 'transfer']

  return (
    <Modal
      open
      onClose={() => !checkout.isPending && onClose()}
      title="Cobrar cita"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={checkout.isPending}>
            Cancelar
          </Button>
          <Button onClick={() => submit()} disabled={!canConfirm} loading={checkout.isPending}>
            Confirmar cobro
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-2xl bg-slate-900 px-4 py-3 text-white">
          <p className="truncate text-sm text-slate-300">
            {chargeName}
            {customer ? ` · ${customer.name}` : appointment.contact_name ? ` · ${appointment.contact_name}` : ''}
          </p>
          {!chargeId ? (
            <p className="py-1 text-lg text-slate-300">Elige qué se cobra</p>
          ) : preview.isError ? (
            <div className="flex items-center justify-between gap-2 py-1 text-sm text-red-200">
              <span>{errorMessage(preview.error, 'No se pudo calcular el total')}</span>
              <button type="button" className="shrink-0 font-semibold underline" onClick={loadTotal}>
                Reintentar
              </button>
            </div>
          ) : preview.isPending || total == null ? (
            <p className="flex items-center gap-2 py-1 text-lg">
              <Spinner size="sm" className="text-white" /> Calculando…
            </p>
          ) : (
            <p className="text-3xl font-bold tabular-nums">{m(total)}</p>
          )}
        </div>

        {!appointment.service_id && (
          <Field label="Qué se cobra" required hint="Se cobra una unidad al precio vigente del catálogo.">
            <Select value={chargeId} onChange={(e) => setChargeId(e.target.value)} disabled={products.isLoading}>
              <option value="">Selecciona un servicio o producto…</option>
              {sellable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.variant_label ? `${p.name} ${p.variant_label}` : p.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <OpenRegisterField value={registerId} onChange={setRegisterId} preferBranchId={appointment.branch_id} />
          {ecfModule && (
            <Field
              label="Comprobante"
              error={ecfError}
              hint={!ecfEnabled ? 'La facturación electrónica no está activada en esta empresa.' : undefined}
            >
              <Select value={ecfType} onChange={(e) => setEcfChoice(e.target.value as EcfChoice)} disabled={!ecfEnabled}>
                <option value="">Sin comprobante fiscal</option>
                <option value="32">e-CF 32 · Consumo</option>
                <option value="31">e-CF 31 · Crédito fiscal</option>
              </Select>
            </Field>
          )}
        </div>

        {owed > 0 &&
          methods.map((k) => (
            <div key={k} className="space-y-2">
              <div className="flex items-end gap-2">
                <Field
                  className="min-w-0 flex-1"
                  label={
                    <span className="flex items-center gap-1.5">
                      {PAY_ICON[k]} {k === 'cash' ? 'Efectivo recibido' : PAYMENT_METHOD_LABEL[k]}
                    </span>
                  }
                  hint={k === 'credit' ? `Disponible: ${m(Math.max(0, creditAvailable))}` : undefined}
                >
                  <Input
                    inputMode="decimal"
                    placeholder="0.00"
                    value={amounts[k]}
                    onChange={(e) => set(k, e.target.value)}
                    className="text-lg"
                  />
                </Field>
                <Button type="button" variant="outline" onClick={() => fill(k)}>
                  {k === 'cash' ? 'Exacto' : 'Completar'}
                </Button>
              </div>
              {(k === 'card' || k === 'transfer') && val(k) > 0 && (
                <Input
                  placeholder={k === 'card' ? 'Referencia / aprobación (opcional)' : 'Referencia de la transferencia (opcional)'}
                  value={refs[k]}
                  onChange={(e) => setRefs((r) => ({ ...r, [k]: e.target.value }))}
                />
              )}
            </div>
          ))}

        {owed > 0 && (
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
        )}

        <p className="text-xs text-slate-500">Al cobrar, la cita queda como atendida y enlazada a la venta.</p>
        {(problem || error) && (
          <p className="rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error ?? problem}</p>
        )}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  )
}

/**
 * Cajas con turno abierto (la base rechaza cualquier otra) de las sucursales a
 * las que la persona tiene acceso; las de la sucursal de la cita van primero.
 */
function OpenRegisterField({
  value,
  onChange,
  preferBranchId,
}: {
  value: string
  onChange: (id: string) => void
  preferBranchId: string
}) {
  const { tenant, user, memberRole } = useAuth()
  const sessions = useOpenSessions()
  const registers = useRegisters()
  const branches = useBranches()
  const members = useTeamMembers()

  const options = useMemo(() => {
    const me = members.data?.find((mb) => mb.user_id === user?.id)
    const unrestricted = memberRole === 'owner' || memberRole === 'admin' || !me || me.branch_ids == null
    const regById = new Map((registers.data ?? []).map((r) => [r.id, r]))
    const branchName = new Map((branches.data ?? []).map((b) => [b.id, b.name]))
    const multiBranch = (branches.data ?? []).length > 1
    return (sessions.data ?? [])
      .filter((s) => regById.get(s.register_id)?.is_active && (unrestricted || (me?.branch_ids ?? []).includes(s.branch_id)))
      .sort((a, b) => Number(b.branch_id === preferBranchId) - Number(a.branch_id === preferBranchId))
      .map((s) => ({
        id: s.register_id,
        branchId: s.branch_id,
        label: `${regById.get(s.register_id)?.name ?? 'Caja'}${multiBranch ? ` · ${branchName.get(s.branch_id) ?? ''}` : ''}`,
      }))
  }, [sessions.data, registers.data, branches.data, members.data, user?.id, memberRole, preferBranchId])

  // Se propone sola la caja del POS de esta persona, o la única abierta.
  useEffect(() => {
    if (value || !options.length) return
    const stored = tenant ? readPosRegister(tenant.id) : null
    const pick = options.find((o) => o.id === stored) ?? (options.length === 1 ? options[0] : null)
    if (pick) onChange(pick.id)
  }, [value, options, tenant, onChange])

  const chosen = options.find((o) => o.id === value)
  const loading = sessions.isLoading || registers.isLoading
  return (
    <Field
      label="Caja"
      required
      error={sessions.isError ? errorMessage(sessions.error) : undefined}
      hint={
        loading ? (
          'Buscando cajas abiertas…'
        ) : options.length === 0 ? (
          <span>
            No hay ninguna caja abierta.{' '}
            <Link to="/caja" className="font-medium text-brand-700 underline">
              Abre una en Caja
            </Link>{' '}
            para cobrar.
          </span>
        ) : chosen && chosen.branchId !== preferBranchId ? (
          'Esta caja es de otra sucursal: la venta quedará registrada en esa sucursal.'
        ) : undefined
      }
    >
      <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={loading || options.length === 0}>
        <option value="">Selecciona una caja…</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  )
}

/** Resumen tras cobrar: devuelta, e-CF y si fue un reintento. */
export function CheckoutSuccess({ result, currency }: { result: CreateSaleResult; currency: string }) {
  const m = (n: number) => money(n, currency)
  return (
    <div className="space-y-4 text-center">
      <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
      <div>
        <p className="text-sm text-slate-500">Venta {result.number}</p>
        <p className="text-2xl font-bold tabular-nums text-slate-900">{m(result.total)}</p>
      </div>
      {result.change_due > 0 && (
        <div className="rounded-2xl bg-emerald-50 px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-emerald-700">Devuelta</p>
          <p className="text-4xl font-bold tabular-nums text-emerald-800">{m(result.change_due)}</p>
        </div>
      )}
      {result.replayed && (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Esta venta ya se había registrado en un intento anterior: no se cobró dos veces.
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
    </div>
  )
}
