import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { OFFLINE_CREATE_CUSTOMER_KEY, type CreateCustomerInput } from '@/lib/offline'
import type { Customer, CustomerPayment, Receivable, Sale } from '@/types/erp'

/*
 * Clientes: alta (que funciona sin conexión), edición y estado de cuenta.
 * El listado y los saldos viven en core.ts (['customers'], ['customer-balances'])
 * porque los usa también el POS; aquí solo lo propio de la ficha del cliente.
 */

export function useCustomer(id: string | undefined) {
  return useQuery({
    queryKey: ['customer', id],
    enabled: Boolean(id),
    queryFn: async (): Promise<Customer | null> => {
      const { data, error } = await supabase.from('customers').select('*').eq('id', id!).maybeSingle()
      if (error) throw error
      return (data as Customer | null) ?? null
    },
  })
}

/**
 * Alta de cliente por la cola offline. El `mutationFn`, el optimista y los
 * reintentos están registrados en `registerOfflineMutations` (lib/offline.ts):
 * aquí NO se repiten, porque una mutación rehidratada mañana desde localStorage
 * solo conoce los defaults de su clave, no los de este hook.
 *
 * Ojo con el 23505: la cola lo trata como "ya estaba subido". Un número de
 * documento repetido también es 23505, así que el formulario comprueba los
 * duplicados ANTES de encolar para que no se pierda la fila en silencio.
 */
export function useCreateCustomer() {
  const qc = useQueryClient()
  return useMutation<string, Error, CreateCustomerInput>({
    mutationKey: OFFLINE_CREATE_CUSTOMER_KEY,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export type UpdateCustomerInput = Partial<
  Pick<
    Customer,
    | 'name'
    | 'kind'
    | 'doc_type'
    | 'doc_number'
    | 'phone'
    | 'email'
    | 'address'
    | 'credit_limit'
    | 'credit_days'
    | 'notes'
    | 'is_active'
  >
> & { id: string }

export function useUpdateCustomer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, ...patch }: UpdateCustomerInput) => {
      const { error } = await supabase.from('customers').update(patch).eq('id', id)
      if (error) throw error
      return id
    },
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: ['customers'] })
      qc.invalidateQueries({ queryKey: ['customer', id] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

// ── Estado de cuenta ────────────────────────────────────────────────────────
// Tres consultas y no una: cada pieza la invalida una mutación distinta (un
// abono toca cuentas y abonos; una venta del POS toca ['sales']), y así cada
// pantalla refresca solo lo que cambió.

/** Todas las cuentas por cobrar del cliente (abiertas, saldadas y canceladas). */
export function useCustomerReceivables(customerId: string | undefined) {
  return useQuery({
    queryKey: ['receivables', 'customer', customerId],
    enabled: Boolean(customerId),
    queryFn: async (): Promise<Receivable[]> => {
      const { data, error } = await supabase
        .from('receivables')
        .select('*')
        .eq('customer_id', customerId!)
        .order('due_date', { ascending: true })
        .limit(500)
      if (error) throw error
      return ((data ?? []) as Receivable[]).map((r) => ({
        ...r,
        amount: Number(r.amount),
        paid_amount: Number(r.paid_amount),
      }))
    },
  })
}

export function useCustomerPayments(customerId: string | undefined) {
  return useQuery({
    queryKey: ['customer-payments', customerId],
    enabled: Boolean(customerId),
    queryFn: async (): Promise<CustomerPayment[]> => {
      const { data, error } = await supabase
        .from('customer_payments')
        .select('*')
        .eq('customer_id', customerId!)
        .order('created_at', { ascending: false })
        .limit(200)
      if (error) throw error
      return ((data ?? []) as CustomerPayment[]).map((p) => ({ ...p, amount: Number(p.amount) }))
    },
  })
}

export type CustomerSaleRow = Pick<
  Sale,
  'id' | 'number' | 'status' | 'total' | 'paid_total' | 'credit_amount' | 'created_at'
>

/**
 * Compras del cliente (sus ventas). La RLS de `sales` solo deja ver las ajenas
 * a quien tiene sales.view_all: un vendedor verá aquí solo las que hizo él.
 */
export function useCustomerSales(customerId: string | undefined) {
  return useQuery({
    queryKey: ['sales', 'customer', customerId],
    enabled: Boolean(customerId),
    queryFn: async (): Promise<CustomerSaleRow[]> => {
      const { data, error } = await supabase
        .from('sales')
        .select('id, number, status, total, paid_total, credit_amount, created_at')
        .eq('customer_id', customerId!)
        .order('created_at', { ascending: false })
        .limit(200)
      if (error) throw error
      return ((data ?? []) as CustomerSaleRow[]).map((s) => ({
        ...s,
        total: Number(s.total),
        paid_total: Number(s.paid_total),
        credit_amount: Number(s.credit_amount),
      }))
    },
  })
}
