import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Payable, PaymentMethod, SupplierPayment } from '@/types/erp'

/*
 * Cuentas por pagar: mismo patrón que las por cobrar. La deuda nace al recibir
 * una compra o al registrar un gasto "por pagar"; se salda con pay_payables()
 * (idempotente por client_uid) y un trigger mantiene `paid_amount`.
 */

const toPayable = (p: Payable): Payable => ({
  ...p,
  amount: Number(p.amount),
  paid_amount: Number(p.paid_amount),
})

export function useOpenPayables() {
  return useQuery({
    queryKey: ['payables', 'open'],
    queryFn: async (): Promise<Payable[]> => {
      const { data, error } = await supabase
        .from('payables')
        .select('*')
        .eq('status', 'open')
        .order('due_date', { ascending: true })
        .limit(1000)
      if (error) throw error
      return ((data ?? []) as Payable[]).map(toPayable)
    },
  })
}

/** Todas las cuentas de un proveedor, abiertas y cerradas (su historial). */
export function useSupplierPayables(supplierId: string | undefined) {
  return useQuery({
    queryKey: ['payables', 'supplier', supplierId],
    enabled: Boolean(supplierId),
    queryFn: async (): Promise<Payable[]> => {
      const { data, error } = await supabase
        .from('payables')
        .select('*')
        .eq('supplier_id', supplierId!)
        .order('created_at', { ascending: false })
        .limit(200)
      if (error) throw error
      return ((data ?? []) as Payable[]).map(toPayable)
    },
  })
}

/** La cuenta por pagar que generó un documento (una compra recibida, un gasto). */
export function usePayableForSource(sourceType: Payable['source_type'], sourceId: string | undefined) {
  return useQuery({
    queryKey: ['payables', 'source', sourceType, sourceId],
    enabled: Boolean(sourceId),
    queryFn: async (): Promise<Payable | null> => {
      const { data, error } = await supabase
        .from('payables')
        .select('*')
        .eq('source_type', sourceType)
        .eq('source_id', sourceId!)
        .maybeSingle()
      if (error) throw error
      return data ? toPayable(data as Payable) : null
    },
  })
}

/** Pagos a proveedores, el más reciente primero. Sin proveedor = todos. */
export function useSupplierPayments(supplierId?: string) {
  return useQuery({
    queryKey: ['supplier-payments', supplierId ?? 'all'],
    queryFn: async (): Promise<SupplierPayment[]> => {
      let q = supabase.from('supplier_payments').select('*')
      if (supplierId) q = q.eq('supplier_id', supplierId)
      const { data, error } = await q.order('created_at', { ascending: false }).limit(200)
      if (error) throw error
      return ((data ?? []) as SupplierPayment[]).map((p) => ({ ...p, amount: Number(p.amount) }))
    },
  })
}

export interface PayPayablesInput {
  /** Uno por operación; se reutiliza si el usuario reintenta la MISMA entrega. */
  client_uid: string
  /** Con proveedor y sin cuenta: se salda de la más antigua a la más nueva. */
  supplier_id?: string | null
  payable_id?: string | null
  amount: number
  method: PaymentMethod
  /** Solo si el efectivo sale de una caja abierta. */
  register_id?: string | null
  reference?: string | null
  note?: string | null
}

export function usePayPayables() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: PayPayablesInput) => {
      const { data, error } = await supabase.rpc('pay_payables', { p_payload: input })
      if (error) throw error
      return data as { payment_id: string; replayed: boolean }
    },
    onSuccess: () => {
      for (const key of [['payables'], ['supplier-balances'], ['supplier-payments'], ['expenses'], ['cash'], ['dashboard']]) {
        qc.invalidateQueries({ queryKey: key })
      }
    },
  })
}
