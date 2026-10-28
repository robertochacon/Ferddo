import { useMemo, useState, type FormEvent } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { useToast } from '@/components/ui/toast'
import { useReceiveCustomerPayment } from '@/hooks/receivables'
import { errorMessage } from '@/lib/errors'
import { fmtDateShort, money } from '@/lib/format'
import { newClientUid } from '@/lib/labels'
import type { PaymentMethod, Receivable } from '@/types/erp'
import { parseAmount, PaymentFields, round2 } from './paymentShared'

/**
 * "Registrar abono" de un cliente. Se monta solo mientras está abierto, así
 * que cada apertura es una operación nueva con su propio client_uid; dentro de
 * la misma apertura el uid se conserva, y reintentar tras un fallo de red no
 * cobra dos veces (la base devuelve el abono ya registrado).
 */
export function ReceivePaymentModal({
  open,
  ...props
}: {
  open: boolean
  onClose: () => void
  customerId: string
  customerName: string
  /** Cuentas ABIERTAS del cliente. */
  receivables: Receivable[]
  /** Preselecciona una cuenta concreta en vez de "las más antiguas primero". */
  receivableId?: string
}) {
  if (!open) return null
  return <ReceivePaymentForm {...props} />
}

function ReceivePaymentForm({
  onClose,
  customerId,
  customerName,
  receivables,
  receivableId,
}: {
  onClose: () => void
  customerId: string
  customerName: string
  receivables: Receivable[]
  receivableId?: string
}) {
  const { tenant } = useAuth()
  const toast = useToast()
  const receive = useReceiveCustomerPayment()
  const currency = tenant?.currency ?? 'DOP'
  const [uid] = useState(newClientUid)

  const open = useMemo(() => receivables.filter((r) => r.status === 'open'), [receivables])
  const totalOpen = round2(open.reduce((s, r) => s + (r.amount - r.paid_amount), 0))

  const [target, setTarget] = useState(receivableId ?? '')
  const targetRow = open.find((r) => r.id === target)
  const targetBalance = targetRow ? round2(targetRow.amount - targetRow.paid_amount) : totalOpen
  const [amount, setAmount] = useState(String(targetBalance))
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [registerId, setRegisterId] = useState('')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const onTarget = (id: string) => {
    setTarget(id)
    const r = open.find((x) => x.id === id)
    setAmount(String(r ? round2(r.amount - r.paid_amount) : totalOpen))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    const value = round2(parseAmount(amount))
    if (!Number.isFinite(value) || value <= 0) return setError('Escribe un monto mayor que cero')
    if (value > targetBalance) return setError(`El abono no puede pasar de ${money(targetBalance, currency)}`)
    if (method === 'cash' && !registerId) return setError('Selecciona la caja donde entra el efectivo')
    try {
      const res = await receive.mutateAsync({
        client_uid: uid,
        customer_id: customerId,
        amount: value,
        method,
        register_id: method === 'cash' ? registerId : null,
        receivable_id: target || null,
        reference: reference.trim() || null,
        note: note.trim() || null,
      })
      toast.success(res.number ? `Abono ${res.number} registrado` : 'Abono registrado')
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Registrar abono · ${customerName}`}
      footer={
        <>
          <Button variant="outline" type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="receive-payment-form" loading={receive.isPending} disabled={totalOpen <= 0}>
            Registrar abono
          </Button>
        </>
      }
    >
      <form id="receive-payment-form" onSubmit={submit} className="space-y-4">
        <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm">
          <span className="text-slate-500">Saldo pendiente: </span>
          <span className="font-semibold text-slate-800">{money(totalOpen, currency)}</span>
        </div>

        <Field label="Aplicar a" hint="Sin una cuenta concreta, el abono salda primero las más antiguas.">
          <Select value={target} onChange={(e) => onTarget(e.target.value)}>
            <option value="">Las más antiguas primero</option>
            {open.map((r) => (
              <option key={r.id} value={r.id}>
                {(r.description ?? 'Cuenta') + ` · vence ${fmtDateShort(r.due_date)} · ${money(r.amount - r.paid_amount, currency)}`}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Monto" required>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </Field>

        <PaymentFields
          method={method}
          onMethod={setMethod}
          registerId={registerId}
          onRegister={setRegisterId}
          cashRegister="required"
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Referencia" hint="Nº de transferencia, voucher…">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />
          </Field>
          <Field label="Nota">
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
          </Field>
        </div>

        {error && <p className="text-sm font-medium text-red-600">{error}</p>}
      </form>
    </Modal>
  )
}
