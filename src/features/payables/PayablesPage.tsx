import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Banknote, CalendarClock, Receipt, Truck, Wallet } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { PageHeader } from '@/components/PageHeader'
import { RequireAccess } from '@/components/RequireAccess'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Field, Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Segmented } from '@/components/ui/Segmented'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState, PageLoader, Spinner } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useSuppliers } from '@/hooks/core'
import { useOpenPayables, usePayPayables, useSupplierPayments } from '@/hooks/payables'
import { errorMessage } from '@/lib/errors'
import { fmtDate, fmtDateShort, fmtDateTime, money } from '@/lib/format'
import { newClientUid, PAYMENT_METHOD_LABEL } from '@/lib/labels'
import type { Payable, PaymentMethod } from '@/types/erp'
import { daysOverdue, parseAmount, PaymentFields, round2 } from '@/features/receivables/paymentShared'

type Tab = 'open' | 'history'

/** Origen de la deuda, para que se entienda de dónde salió cada fila. */
const SOURCE_LABEL: Record<Payable['source_type'], string> = {
  purchase: 'Compra',
  expense: 'Gasto',
  manual: 'Manual',
}

const balanceOf = (p: Payable) => round2(p.amount - p.paid_amount)

interface Group {
  /** '' = deudas sin proveedor (gastos sueltos). */
  supplierId: string
  name: string
  payables: Payable[]
  balance: number
  overdue: number
}

/** Objetivo del pago: todo lo de un proveedor (de lo más viejo a lo más nuevo) o una cuenta concreta. */
type PayTarget = { supplierId: string | null; name: string; payable?: Payable; max: number }

export function PayablesPage() {
  return (
    <RequireAccess module="payables" perm="payables.manage">
      <PayablesContent />
    </RequireAccess>
  )
}

function PayablesContent() {
  const { tenant } = useAuth()
  const currency = tenant?.currency ?? 'DOP'
  const payables = useOpenPayables()
  const suppliers = useSuppliers()
  const [tab, setTab] = useState<Tab>('open')
  const [pay, setPay] = useState<PayTarget | null>(null)

  const supplierName = useMemo(() => new Map((suppliers.data ?? []).map((s) => [s.id, s.name])), [suppliers.data])

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>()
    for (const p of payables.data ?? []) {
      const key = p.supplier_id ?? ''
      let g = map.get(key)
      if (!g) {
        g = {
          supplierId: key,
          name: key ? (supplierName.get(key) ?? 'Proveedor') : 'Sin proveedor',
          payables: [],
          balance: 0,
          overdue: 0,
        }
        map.set(key, g)
      }
      g.payables.push(p)
      g.balance = round2(g.balance + balanceOf(p))
      if (daysOverdue(p.due_date) > 0) g.overdue = round2(g.overdue + balanceOf(p))
    }
    // Primero quien tiene deuda vencida, después por monto.
    return [...map.values()].sort((a, b) => b.overdue - a.overdue || b.balance - a.balance)
  }, [payables.data, supplierName])

  const total = round2(groups.reduce((s, g) => s + g.balance, 0))
  const overdue = round2(groups.reduce((s, g) => s + g.overdue, 0))
  const all = payables.data ?? []
  const dueSoon = round2(
    all.filter((p) => {
      const d = daysOverdue(p.due_date)
      return d <= 0 && d > -7
    }).reduce((s, p) => s + balanceOf(p), 0),
  )

  if (payables.isLoading) return <PageLoader label="Cargando cuentas por pagar…" />
  if (payables.isError) {
    return (
      <EmptyState
        icon={<AlertTriangle className="h-6 w-6" />}
        title="No se pudieron cargar las cuentas por pagar"
        description={errorMessage(payables.error)}
        action={<Button onClick={() => payables.refetch()}>Reintentar</Button>}
      />
    )
  }

  return (
    <div>
      <PageHeader title="Cuentas por pagar" description="Lo que debes a tus proveedores y cuándo vence." />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Por pagar" value={money(total, currency)} icon={<Wallet className="h-5 w-5" />} />
        <StatCard
          label="Vencido"
          value={money(overdue, currency)}
          icon={<AlertTriangle className="h-5 w-5" />}
          tone={overdue > 0 ? 'red' : 'slate'}
        />
        <StatCard label="Vence en 7 días" value={money(dueSoon, currency)} icon={<CalendarClock className="h-5 w-5" />} tone="amber" />
        <StatCard label="Proveedores" value={groups.length} icon={<Truck className="h-5 w-5" />} tone="slate" />
      </div>

      <Segmented
        value={tab}
        onChange={setTab}
        className="mb-4"
        options={[
          { value: 'open', label: 'Pendientes' },
          { value: 'history', label: 'Pagos realizados' },
        ]}
      />

      {tab === 'open' &&
        (groups.length === 0 ? (
          <EmptyState
            icon={<Receipt className="h-6 w-6" />}
            title="No debes nada"
            description="Las compras recibidas y los gastos a crédito aparecerán aquí hasta que los pagues."
          />
        ) : (
          <div className="space-y-4">
            {groups.map((g) => (
              <Card key={g.supplierId || 'none'}>
                <CardHeader
                  title={g.name}
                  subtitle={
                    <>
                      Debes <b className="text-slate-700">{money(g.balance, currency)}</b>
                      {g.overdue > 0 && <span className="text-red-600"> · {money(g.overdue, currency)} vencido</span>}
                    </>
                  }
                  action={
                    // Sin proveedor no hay a quién "pagarle todo": cada gasto se paga por separado.
                    g.supplierId ? (
                      <Button size="sm" onClick={() => setPay({ supplierId: g.supplierId, name: g.name, max: g.balance })}>
                        <Banknote className="h-4 w-4" /> Pagar
                      </Button>
                    ) : undefined
                  }
                />
                <div className="hidden overflow-x-auto lg:block">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                        <th className="px-4 py-3 font-medium">Concepto</th>
                        <th className="px-4 py-3 font-medium">Origen</th>
                        <th className="px-4 py-3 font-medium">Vence</th>
                        <th className="px-4 py-3 text-right font-medium">Monto</th>
                        <th className="px-4 py-3 text-right font-medium">Pagado</th>
                        <th className="px-4 py-3 text-right font-medium">Saldo</th>
                        <th className="px-4 py-3" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {g.payables.map((p) => {
                        const late = daysOverdue(p.due_date)
                        return (
                          <tr key={p.id} className={late > 0 ? 'bg-red-50/40' : undefined}>
                            <td className="px-4 py-3 text-slate-800">
                              {p.source_type === 'purchase' && p.source_id ? (
                                <Link to={`/compras/${p.source_id}`} className="hover:text-brand-600">
                                  {p.description}
                                </Link>
                              ) : (
                                p.description
                              )}
                            </td>
                            <td className="px-4 py-3 text-slate-600">{SOURCE_LABEL[p.source_type]}</td>
                            <td className="px-4 py-3">
                              <span className="text-slate-600">{fmtDateShort(p.due_date)}</span>
                              {late > 0 && <Badge tone="red" className="ml-2">{late} d vencida</Badge>}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">{money(p.amount, currency)}</td>
                            <td className="px-4 py-3 text-right tabular-nums text-slate-600">{money(p.paid_amount, currency)}</td>
                            <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(balanceOf(p), currency)}</td>
                            <td className="px-4 py-3 text-right">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setPay({ supplierId: p.supplier_id, name: g.name, payable: p, max: balanceOf(p) })}
                              >
                                Pagar
                              </Button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <DataList>
                  {g.payables.map((p) => {
                    const late = daysOverdue(p.due_date)
                    return (
                      <DataRow
                        key={p.id}
                        title={p.description}
                        titleExtra={`${SOURCE_LABEL[p.source_type]} · vence ${fmtDate(p.due_date)}`}
                        tone={late > 0 ? 'danger' : undefined}
                        badges={late > 0 ? <Badge tone="red">{late} d vencida</Badge> : undefined}
                        actions={
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setPay({ supplierId: p.supplier_id, name: g.name, payable: p, max: balanceOf(p) })}
                          >
                            Pagar
                          </Button>
                        }
                      >
                        <DataFields>
                          <DataField label="Monto">{money(p.amount, currency)}</DataField>
                          <DataField label="Saldo">{money(balanceOf(p), currency)}</DataField>
                        </DataFields>
                      </DataRow>
                    )
                  })}
                </DataList>
              </Card>
            ))}
          </div>
        ))}

      {tab === 'history' && <PaymentsHistory supplierName={supplierName} currency={currency} />}

      {pay && <PayModal target={pay} currency={currency} onClose={() => setPay(null)} />}
    </div>
  )
}

function PaymentsHistory({ supplierName, currency }: { supplierName: Map<string, string>; currency: string }) {
  const payments = useSupplierPayments()
  if (payments.isLoading) return <div className="flex justify-center p-8"><Spinner /></div>
  if (payments.isError) return <p className="text-sm text-red-600">{errorMessage(payments.error)}</p>
  const rows = payments.data ?? []
  if (rows.length === 0) {
    return <EmptyState icon={<Banknote className="h-6 w-6" />} title="Todavía no hay pagos a proveedores" />
  }
  const nameOf = (id: string | null) => (id ? (supplierName.get(id) ?? 'Proveedor') : 'Sin proveedor')
  return (
    <Card>
      <CardHeader title="Pagos realizados" subtitle="Los 200 más recientes." />
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3 font-medium">Pago</th>
              <th className="px-4 py-3 font-medium">Fecha</th>
              <th className="px-4 py-3 font-medium">Proveedor</th>
              <th className="px-4 py-3 font-medium">Método</th>
              <th className="px-4 py-3 font-medium">Referencia</th>
              <th className="px-4 py-3 text-right font-medium">Monto</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((p) => (
              <tr key={p.id}>
                <td className="px-4 py-3 font-medium text-slate-800">{p.number}</td>
                <td className="px-4 py-3 text-slate-600">{fmtDateTime(p.created_at)}</td>
                <td className="px-4 py-3 text-slate-700">{nameOf(p.supplier_id)}</td>
                <td className="px-4 py-3 text-slate-600">{PAYMENT_METHOD_LABEL[p.method]}</td>
                <td className="px-4 py-3 text-slate-600">{p.reference ?? p.note ?? '—'}</td>
                <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(p.amount, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <DataList>
        {rows.map((p) => (
          <DataRow key={p.id} title={`${p.number} · ${nameOf(p.supplier_id)}`} titleExtra={fmtDateTime(p.created_at)}>
            <DataFields>
              <DataField label="Monto">{money(p.amount, currency)}</DataField>
              <DataField label="Método">{PAYMENT_METHOD_LABEL[p.method]}</DataField>
            </DataFields>
          </DataRow>
        ))}
      </DataList>
    </Card>
  )
}

/**
 * Pago a proveedor. Un client_uid por apertura del diálogo: reintentar tras un
 * corte de red devuelve el pago ya hecho en vez de pagar dos veces.
 */
function PayModal({ target, currency, onClose }: { target: PayTarget; currency: string; onClose: () => void }) {
  const toast = useToast()
  const payMut = usePayPayables()
  const [uid] = useState(newClientUid)
  const [amount, setAmount] = useState(String(target.max))
  const [method, setMethod] = useState<PaymentMethod>('transfer')
  const [registerId, setRegisterId] = useState('')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    const value = round2(parseAmount(amount))
    if (!Number.isFinite(value) || value <= 0) return setError('Escribe un monto mayor que cero')
    if (value > target.max) return setError(`El pago no puede pasar de ${money(target.max, currency)}`)
    try {
      await payMut.mutateAsync({
        client_uid: uid,
        supplier_id: target.supplierId,
        payable_id: target.payable?.id ?? null,
        amount: value,
        method,
        register_id: method === 'cash' && registerId ? registerId : null,
        reference: reference.trim() || null,
        note: note.trim() || null,
      })
      toast.success('Pago registrado')
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Pagar · ${target.name}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} loading={payMut.isPending}>
            Registrar pago
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm">
          {target.payable ? (
            <>
              <p className="font-medium text-slate-800">{target.payable.description}</p>
              <p className="text-slate-500">
                Saldo {money(target.max, currency)} · vence {fmtDate(target.payable.due_date)}
              </p>
            </>
          ) : (
            <p>
              <span className="text-slate-500">Saldo total: </span>
              <b className="text-slate-800">{money(target.max, currency)}</b>
              <span className="block text-xs text-slate-500">Se salda primero lo que vence antes.</span>
            </p>
          )}
        </div>
        <Field label="Monto" required>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </Field>
        <PaymentFields
          method={method}
          onMethod={setMethod}
          registerId={registerId}
          onRegister={setRegisterId}
          cashRegister="optional"
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Referencia" hint="Nº de transferencia o cheque.">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />
          </Field>
          <Field label="Nota">
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
          </Field>
        </div>
        {error && <p className="text-sm font-medium text-red-600">{error}</p>}
      </div>
    </Modal>
  )
}
