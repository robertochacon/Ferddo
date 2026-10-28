import { useEffect, useMemo } from 'react'
import { differenceInCalendarDays, format, parseISO } from 'date-fns'
import { Field } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { useBranches, useRegisters } from '@/hooks/core'
import { useOpenCashSessions } from '@/hooks/receivables'
import { PAYMENT_METHOD_LABEL } from '@/lib/labels'
import type { PaymentMethod } from '@/types/erp'

/*
 * Piezas comunes de cobros, pagos y gastos (cuentas por cobrar, por pagar,
 * compras y gastos). Viven aquí y no en components/ porque son de negocio y
 * solo las usan estos módulos.
 */

/** Métodos con los que entra o sale dinero de verdad: "crédito" y "nota de crédito" no saldan una deuda. */
export const SETTLEMENT_METHODS: PaymentMethod[] = ['cash', 'card', 'transfer', 'other']

/** Hoy como 'yyyy-MM-dd' en hora LOCAL (toISOString daría la fecha de UTC y en RD, de noche, ya es mañana). */
export function todayIso(): string {
  return format(new Date(), 'yyyy-MM-dd')
}

/** Días de atraso de un vencimiento (0 o negativo = al día). */
export function daysOverdue(due: string): number {
  return differenceInCalendarDays(new Date(), parseISO(due))
}

/** Lee un monto escrito a mano ("1,500.50" o "1500.5"). NaN si no es un número. */
export function parseAmount(value: string): number {
  const clean = value.replace(/,/g, '').trim()
  if (clean === '') return NaN
  return Number(clean)
}

/** Redondeo al centavo, para comparar con lo que guardará la base. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function registerHint(loading: boolean, open: number, mode: 'required' | 'optional'): string | undefined {
  if (loading) return 'Buscando cajas abiertas…'
  if (open === 0) {
    return mode === 'required'
      ? 'No hay ninguna caja abierta. Abre una en Caja para cobrar en efectivo.'
      : 'No hay cajas abiertas: el efectivo se registrará fuera de caja.'
  }
  return mode === 'optional' ? 'Elige la caja si el efectivo sale de ella.' : undefined
}

/**
 * Método de pago + caja. La caja solo se pide en efectivo: es de donde sale
 * (o a donde entra) el billete, y solo se ofrecen las que tienen turno
 * abierto, porque la base rechaza cualquier otra.
 *
 * `cashRegister`:
 *  - 'required': cobro a cliente; la base exige caja para el efectivo.
 *  - 'optional': pago a proveedor o gasto; el efectivo puede salir de fuera
 *    de la caja (la cartera del dueño, la caja chica) y entonces no la toca.
 */
export function PaymentFields({
  method,
  onMethod,
  registerId,
  onRegister,
  cashRegister,
}: {
  method: PaymentMethod
  onMethod: (m: PaymentMethod) => void
  registerId: string
  onRegister: (id: string) => void
  cashRegister: 'required' | 'optional'
}) {
  const sessions = useOpenCashSessions()
  const registers = useRegisters()
  const branches = useBranches()

  const options = useMemo(() => {
    const regName = new Map((registers.data ?? []).map((r) => [r.id, r.name]))
    const branchName = new Map((branches.data ?? []).map((b) => [b.id, b.name]))
    const multiBranch = (branches.data ?? []).length > 1
    return (sessions.data ?? []).map((s) => ({
      id: s.register_id,
      label: `${regName.get(s.register_id) ?? 'Caja'}${multiBranch ? ` · ${branchName.get(s.branch_id) ?? ''}` : ''}`,
    }))
  }, [sessions.data, registers.data, branches.data])

  const isCash = method === 'cash'

  // Con una sola caja abierta y caja obligatoria, se elige sola: es el caso
  // del colmado con una caja, y obligar a tocar un select es un paso de más.
  useEffect(() => {
    if (isCash && cashRegister === 'required' && !registerId && options.length === 1) {
      onRegister(options[0].id)
    }
  }, [isCash, cashRegister, registerId, options, onRegister])

  // Si la caja elegida se cerró (o se cambió a un método sin caja), se suelta.
  useEffect(() => {
    if (registerId && (!isCash || (sessions.data && !options.some((o) => o.id === registerId)))) {
      onRegister('')
    }
  }, [isCash, registerId, options, sessions.data, onRegister])

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Método" required>
        <Select value={method} onChange={(e) => onMethod(e.target.value as PaymentMethod)}>
          {SETTLEMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {PAYMENT_METHOD_LABEL[m]}
            </option>
          ))}
        </Select>
      </Field>
      {isCash && (
        <Field
          label="Caja"
          required={cashRegister === 'required'}
          hint={registerHint(sessions.isLoading, options.length, cashRegister)}
        >
          <Select value={registerId} onChange={(e) => onRegister(e.target.value)}>
            <option value="">{cashRegister === 'required' ? 'Selecciona una caja…' : 'Fuera de caja'}</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </div>
  )
}
