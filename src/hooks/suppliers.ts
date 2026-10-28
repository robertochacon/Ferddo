import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/auth/AuthProvider'
import type { Supplier, SupplierBalance } from '@/types/erp'

/*
 * Proveedores. El listado (['suppliers']) vive en core.ts porque lo usan
 * compras, gastos y cuentas por pagar; aquí van saldos y escrituras. La RLS
 * exige suppliers.manage para escribir: el botón se esconde sin el permiso,
 * pero quien decide es la base.
 */

export function useSupplierBalances() {
  return useQuery({
    queryKey: ['supplier-balances'],
    queryFn: async (): Promise<Record<string, SupplierBalance>> => {
      const { data, error } = await supabase.from('supplier_balances').select('*')
      if (error) throw error
      // Las deudas sin proveedor (un gasto suelto) llegan con supplier_id null;
      // se guardan bajo '' para que el total general las cuente igual.
      return Object.fromEntries(
        ((data ?? []) as SupplierBalance[]).map((b) => [
          b.supplier_id ?? '',
          { ...b, balance: Number(b.balance), open_documents: Number(b.open_documents) },
        ]),
      )
    },
  })
}

export type SupplierInput = Pick<
  Supplier,
  | 'name'
  | 'rnc'
  | 'contact_name'
  | 'phone'
  | 'email'
  | 'address'
  | 'payment_terms_days'
  | 'notes'
  | 'is_active'
>

export function useCreateSupplier() {
  const qc = useQueryClient()
  const { tenant } = useAuth()
  return useMutation({
    mutationFn: async (input: SupplierInput): Promise<string> => {
      if (!tenant) throw new Error('No hay una empresa activa')
      // tenant_id va explícito: la tabla no lo rellena sola y la política lo
      // compara con auth_tenant_id() para impedir escribir en otra empresa.
      const { data, error } = await supabase
        .from('suppliers')
        .insert({ ...input, tenant_id: tenant.id })
        .select('id')
        .single()
      if (error) throw error
      return (data as { id: string }).id
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['suppliers'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export function useUpdateSupplier() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, ...patch }: Partial<SupplierInput> & { id: string }) => {
      const { error } = await supabase.from('suppliers').update(patch).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['suppliers'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}
