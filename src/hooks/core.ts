import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/auth/AuthProvider'
import type {
  Branch,
  BusinessType,
  CashRegister,
  Category,
  Customer,
  CustomerBalance,
  MyTenant,
  Permission,
  Product,
  StockLevel,
  Supplier,
  Tax,
} from '@/types/erp'

/*
 * Lecturas compartidas por varios módulos (POS, compras, cotizaciones,
 * inventario…). Cada módulo tiene además su propio archivo de hooks; aquí solo
 * va lo que más de uno necesita, para que no haya dos claves de cache para el
 * mismo dato. `tenant_id` nunca se filtra a mano en un SELECT: lo pone la RLS.
 */

/**
 * PostgREST corta en `max_rows` (1000, supabase/config.toml). Un catálogo de
 * ferretería pasa de eso, así que se pide por páginas hasta agotar. El tope de
 * 20 páginas es un freno de seguridad, no un límite de negocio.
 */
async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  for (let page = 0; page < 20; page++) {
    const { data, error } = await build(page * PAGE, page * PAGE + PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

export function useMyTenants() {
  const { user } = useAuth()
  return useQuery({
    queryKey: ['my-tenants'],
    enabled: Boolean(user),
    queryFn: async (): Promise<MyTenant[]> => {
      const { data, error } = await supabase.rpc('my_tenants')
      if (error) throw error
      return (data ?? []) as MyTenant[]
    },
  })
}

export function useBusinessTypes() {
  return useQuery({
    queryKey: ['business-types'],
    staleTime: 60 * 60_000,
    queryFn: async (): Promise<BusinessType[]> => {
      const { data, error } = await supabase.from('business_types').select('*').order('sort_order')
      if (error) throw error
      return (data ?? []) as BusinessType[]
    },
  })
}

export function usePermissionsCatalog() {
  return useQuery({
    queryKey: ['permissions-catalog'],
    staleTime: 60 * 60_000,
    queryFn: async (): Promise<Permission[]> => {
      const { data, error } = await supabase.from('permissions').select('*').order('sort_order')
      if (error) throw error
      return (data ?? []) as Permission[]
    },
  })
}

export function useBranches() {
  return useQuery({
    queryKey: ['branches'],
    queryFn: async (): Promise<Branch[]> => {
      const { data, error } = await supabase
        .from('branches')
        .select('*')
        .order('is_main', { ascending: false })
        .order('name')
      if (error) throw error
      return (data ?? []) as Branch[]
    },
  })
}

export function useRegisters() {
  return useQuery({
    queryKey: ['registers'],
    queryFn: async (): Promise<CashRegister[]> => {
      const { data, error } = await supabase.from('cash_registers').select('*').order('name')
      if (error) throw error
      return (data ?? []) as CashRegister[]
    },
  })
}

export function useTaxes() {
  return useQuery({
    queryKey: ['taxes'],
    queryFn: async (): Promise<Tax[]> => {
      const { data, error } = await supabase.from('taxes').select('*').order('rate', { ascending: false })
      if (error) throw error
      return ((data ?? []) as Tax[]).map((t) => ({ ...t, rate: Number(t.rate) }))
    },
  })
}

export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: async (): Promise<Category[]> => {
      const { data, error } = await supabase.from('categories').select('*').order('name')
      if (error) throw error
      return (data ?? []) as Category[]
    },
  })
}

/** Catálogo completo (productos y servicios, activos e inactivos). */
export function useProducts() {
  return useQuery({
    queryKey: ['products'],
    queryFn: () =>
      fetchAll<Product>((from, to) =>
        supabase.from('products').select('*').order('name').range(from, to),
      ),
  })
}

/** Existencias de una sucursal, como mapa product_id → cantidad. */
export function useStockMap(branchId: string | undefined) {
  return useQuery({
    queryKey: ['stock', branchId],
    enabled: Boolean(branchId),
    queryFn: async (): Promise<Record<string, number>> => {
      const rows = await fetchAll<StockLevel>((from, to) =>
        supabase
          .from('stock_levels')
          .select('product_id, quantity')
          .eq('branch_id', branchId!)
          .range(from, to),
      )
      return Object.fromEntries(rows.map((r) => [r.product_id, Number(r.quantity)]))
    },
  })
}

export function useCustomers() {
  return useQuery({
    queryKey: ['customers'],
    queryFn: () =>
      fetchAll<Customer>((from, to) =>
        supabase.from('customers').select('*').order('name').range(from, to),
      ),
  })
}

export function useCustomerBalances() {
  return useQuery({
    queryKey: ['customer-balances'],
    queryFn: async (): Promise<Record<string, CustomerBalance>> => {
      const { data, error } = await supabase.from('customer_balances').select('*')
      if (error) throw error
      return Object.fromEntries(
        ((data ?? []) as CustomerBalance[]).map((b) => [b.customer_id, { ...b, balance: Number(b.balance) }]),
      )
    },
  })
}

export function useSuppliers() {
  return useQuery({
    queryKey: ['suppliers'],
    queryFn: async (): Promise<Supplier[]> => {
      const { data, error } = await supabase.from('suppliers').select('*').order('name')
      if (error) throw error
      return (data ?? []) as Supplier[]
    },
  })
}

/** Alta de una empresa adicional (multiempresa). Queda como empresa activa. */
export function useCreateAdditionalBusiness() {
  const { refresh } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { name: string; business_type: string; rnc?: string | null }) => {
      const { data, error } = await supabase.rpc('setup_business', {
        p_name: input.name,
        p_business_type: input.business_type,
        p_rnc: input.rnc ?? null,
        p_additional: true,
      })
      if (error) throw error
      return data as string
    },
    onSuccess: async () => {
      qc.clear()
      await refresh()
    },
  })
}
