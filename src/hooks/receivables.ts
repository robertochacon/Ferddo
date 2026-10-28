import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { AgingRow, CashSession, PaymentMethod, Receivable } from '@/types/erp'

/*
 * Cuentas por cobrar. Los importes los mueve SOLO la base: el abono entra por
 * receive_customer_payment() (idempotente por client_uid) y un trigger mantiene
 * `paid_amount`. Aquí no se suma ni se resta nada que luego se guarde.
 */

/** Cuentas abiertas de toda la empresa, la más vencida primero. */
export function useOpenReceivables() {
  return useQuery({
    queryKey: ['receivables', 'open'],
    queryFn: async (): Promise<Receivable[]> => {
      const { data, error } = await supabase
        .from('receivables')
        .select('*')
        .eq('status', 'open')
        .order('due_date', { ascending: true })
        .limit(1000)
      if (error) throw error
      return ((data ?? []) as Receivable[]).map((r) => ({
        ...r,
        amount: Number(r.amount),
        paid_amount: Number(r.paid_amount),
      }))
    },
  })
}

/** Antigüedad de saldos por cliente. Dentro de un jsonb los numeric pueden llegar como texto. */
export function useReceivablesAging() {
  return useQuery({
    queryKey: ['receivables', 'aging'],
    queryFn: async (): Promise<AgingRow[]> => {
      const { data, error } = await supabase.rpc('receivables_aging')
      if (error) throw error
      const n = (v: unknown) => (v == null ? null : Number(v))
      return ((data ?? []) as AgingRow[]).map((r) => ({
        ...r,
        total: Number(r.total),
        current: n(r.current),
        d1_30: n(r.d1_30),
        d31_60: n(r.d31_60),
        d61_90: n(r.d61_90),
        d90_plus: n(r.d90_plus),
      }))
    },
  })
}

export interface ReceiveCustomerPaymentInput {
  /** Uno por operación; se reutiliza si el usuario reintenta la MISMA entrega. */
  client_uid: string
  customer_id: string
  amount: number
  method: PaymentMethod
  /** Obligatorio en efectivo: el dinero entra a esa caja. */
  register_id?: string | null
  /** Sin él, el abono se aplica a las cuentas más antiguas primero. */
  receivable_id?: string | null
  reference?: string | null
  note?: string | null
}

export function useReceiveCustomerPayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: ReceiveCustomerPaymentInput) => {
      const { data, error } = await supabase.rpc('receive_customer_payment', { p_payload: input })
      if (error) throw error
      return data as { payment_id: string; number?: string; replayed: boolean }
    },
    onSuccess: (_res, input) => {
      for (const key of [
        ['receivables'],
        ['customer-balances'],
        ['customers'],
        ['customer', input.customer_id],
        ['customer-payments'],
        ['cash'],
        ['dashboard'],
      ]) {
        qc.invalidateQueries({ queryKey: key })
      }
    },
  })
}

export type OpenCashSession = Pick<CashSession, 'id' | 'register_id' | 'branch_id' | 'number' | 'opened_at'>

/**
 * Cajas con turno abierto: son las únicas a las que puede entrar (o de las que
 * puede salir) efectivo de un cobro, un pago o un gasto. Va bajo ['cash'] para
 * que abrir o cerrar caja —y cualquier cobro— la refresque.
 */
export function useOpenCashSessions() {
  return useQuery({
    queryKey: ['cash', 'open-sessions'],
    queryFn: async (): Promise<OpenCashSession[]> => {
      const { data, error } = await supabase
        .from('cash_sessions')
        .select('id, register_id, branch_id, number, opened_at')
        .eq('status', 'open')
      if (error) throw error
      return (data ?? []) as OpenCashSession[]
    },
  })
}
