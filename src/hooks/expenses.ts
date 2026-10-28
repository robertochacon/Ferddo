import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/auth/AuthProvider'
import type { Expense, ExpenseCategory, PaymentMethod } from '@/types/erp'

/*
 * Gastos. El alta entra por create_expense() (idempotente por client_uid):
 * en la misma transacción saca el efectivo de la caja o crea la cuenta por
 * pagar. Las categorías son una tabla simple que la RLS deja escribir a quien
 * tiene expenses.manage.
 */

export function useExpenseCategories() {
  return useQuery({
    queryKey: ['expense-categories'],
    queryFn: async (): Promise<ExpenseCategory[]> => {
      const { data, error } = await supabase.from('expense_categories').select('*').order('name')
      if (error) throw error
      return (data ?? []) as ExpenseCategory[]
    },
  })
}

export function useSaveExpenseCategory() {
  const qc = useQueryClient()
  const { tenant } = useAuth()
  return useMutation({
    mutationFn: async (input: { id?: string; name?: string; is_active?: boolean }) => {
      if (input.id) {
        const { id, ...patch } = input
        const { error } = await supabase.from('expense_categories').update(patch).eq('id', id)
        if (error) throw error
        return
      }
      if (!tenant) throw new Error('No hay una empresa activa')
      const { error } = await supabase
        .from('expense_categories')
        .insert({ tenant_id: tenant.id, name: (input.name ?? '').trim() })
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expense-categories'] })
    },
  })
}

/** Gastos con fecha en el rango (inclusive), el más reciente primero. */
export function useExpenses(from: string, to: string) {
  return useQuery({
    queryKey: ['expenses', from, to],
    queryFn: async (): Promise<Expense[]> => {
      const { data, error } = await supabase
        .from('expenses')
        .select('*')
        .gte('expense_date', from)
        .lte('expense_date', to)
        .order('expense_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(1000)
      if (error) throw error
      return ((data ?? []) as Expense[]).map((e) => ({
        ...e,
        amount: Number(e.amount),
        tax_amount: Number(e.tax_amount),
      }))
    },
  })
}

export interface CreateExpenseInput {
  /** Uno por operación; se reutiliza si el usuario reintenta la MISMA entrega. */
  client_uid: string
  branch_id: string
  category_id: string
  supplier_id?: string | null
  description: string
  amount: number
  /** ITBIS incluido en `amount`. */
  tax_amount?: number
  expense_date?: string
  /** false = queda en cuentas por pagar con `due_date`. */
  paid: boolean
  method?: PaymentMethod | null
  register_id?: string | null
  ncf?: string | null
  attachment_path?: string | null
  due_date?: string | null
}

export function useCreateExpense() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: CreateExpenseInput): Promise<string> => {
      const { data, error } = await supabase.rpc('create_expense', { p_payload: input })
      if (error) throw error
      return data as string
    },
    onSuccess: () => {
      for (const key of [['expenses'], ['payables'], ['supplier-balances'], ['cash'], ['dashboard']]) {
        qc.invalidateQueries({ queryKey: key })
      }
    },
  })
}

export function useVoidExpense() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase.rpc('void_expense', { p_id: id, p_reason: reason })
      if (error) throw error
    },
    onSuccess: () => {
      for (const key of [['expenses'], ['payables'], ['supplier-balances'], ['cash'], ['dashboard']]) {
        qc.invalidateQueries({ queryKey: key })
      }
    },
  })
}
