import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/auth/AuthProvider'
import type { Branch, CashRegister, Tax } from '@/types/erp'

/*
 * Escrituras de Configuración: sucursales, cajas e impuestos. Las LECTURAS
 * viven en `core.ts` (useBranches/useRegisters/useTaxes) porque las usan el POS,
 * inventario y compras; aquí solo se escribe y se invalidan esas mismas claves.
 *
 * Ninguna de estas tablas tiene política de DELETE (0013/0014/0015, a propósito):
 * una sucursal, una caja o un impuesto tienen ventas e historia colgando. Se
 * DESACTIVAN, no se borran.
 *
 * Las escrituras pasan por la RLS con permiso (`branches.manage` para sucursales
 * y cajas, `settings.manage` para impuestos). Un UPDATE sin permiso no lanza: la
 * política filtra la fila y PostgREST responde éxito con cero filas. Por eso
 * todo UPDATE pide `select('id')` y comprueba que tocó algo.
 */

const NO_PERMISSION = 'No tienes permiso para hacer este cambio.'

function assertTouched(data: unknown[] | null) {
  if (!data || data.length === 0) throw new Error(NO_PERMISSION)
}

/** Sucursales, cajas e impuestos alimentan el tablero (stock bajo, cajas abiertas…). */
function invalidate(qc: QueryClient, key: 'branches' | 'registers' | 'taxes') {
  qc.invalidateQueries({ queryKey: [key] })
  qc.invalidateQueries({ queryKey: ['dashboard'] })
  // El consumo frente al plan cuenta sucursales y cajas.
  if (key !== 'taxes') qc.invalidateQueries({ queryKey: ['plan-usage'] })
}

// ── Sucursales ──────────────────────────────────────────────────────────────

export type BranchInput = Pick<Branch, 'name' | 'code' | 'address' | 'province' | 'municipality' | 'phone'>

/**
 * Crea o edita una sucursal. El tope del plan (`PLAN_LIMIT_BRANCHES`) lo aplica
 * un trigger en la base y llega como error: la UI no compone su propio mensaje.
 */
export function useSaveBranch() {
  const { tenant } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, ...input }: BranchInput & { id?: string }) => {
      if (id) {
        const { data, error } = await supabase.from('branches').update(input).eq('id', id).select('id')
        if (error) throw error
        assertTouched(data)
        return id
      }
      if (!tenant) throw new Error('Sin empresa activa')
      const { data, error } = await supabase
        .from('branches')
        .insert({ ...input, tenant_id: tenant.id })
        .select('id')
        .single()
      if (error) throw error
      return (data as { id: string }).id
    },
    onSuccess: () => invalidate(qc, 'branches'),
  })
}

export function useSetBranchActive() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { data, error } = await supabase.from('branches').update({ is_active: active }).eq('id', id).select('id')
      if (error) throw error
      assertTouched(data)
    },
    onSuccess: () => invalidate(qc, 'branches'),
  })
}

/**
 * Cambia la sucursal principal. Hay un índice único parcial (una sola
 * `is_main` por empresa), así que primero se apaga la actual y luego se enciende
 * la nueva; en una sola sentencia el índice rechazaría el estado intermedio. Si
 * el segundo paso fallara, la empresa queda sin principal (no con dos), que es
 * el fallo inofensivo: se repite la acción.
 */
export function useSetMainBranch() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const off = await supabase.from('branches').update({ is_main: false }).eq('is_main', true).neq('id', id)
      if (off.error) throw off.error
      const { data, error } = await supabase
        .from('branches')
        .update({ is_main: true, is_active: true })
        .eq('id', id)
        .select('id')
      if (error) throw error
      assertTouched(data)
    },
    onSuccess: () => invalidate(qc, 'branches'),
  })
}

// ── Cajas ───────────────────────────────────────────────────────────────────

export interface RegisterInput {
  name: string
  branch_id: string
  paper_width: 58 | 80
}

/**
 * Crea o edita una caja. `settings` es un jsonb con más preferencias del puesto
 * (impresora, cajón…): al editar se MEZCLA con lo que ya tenía para no borrar
 * claves que esta pantalla no conoce. Tope de plan: `PLAN_LIMIT_REGISTERS`.
 */
export function useSaveRegister() {
  const { tenant } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      current,
      ...input
    }: RegisterInput & { id?: string; current?: CashRegister['settings'] }) => {
      const settings = { ...(current ?? {}), paper_width: input.paper_width }
      const row = { name: input.name, branch_id: input.branch_id, settings }
      if (id) {
        const { data, error } = await supabase.from('cash_registers').update(row).eq('id', id).select('id')
        if (error) throw error
        assertTouched(data)
        return
      }
      if (!tenant) throw new Error('Sin empresa activa')
      const { error } = await supabase.from('cash_registers').insert({ ...row, tenant_id: tenant.id })
      if (error) throw error
    },
    onSuccess: () => invalidate(qc, 'registers'),
  })
}

export function useSetRegisterActive() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { data, error } = await supabase
        .from('cash_registers')
        .update({ is_active: active })
        .eq('id', id)
        .select('id')
      if (error) throw error
      assertTouched(data)
    },
    onSuccess: () => invalidate(qc, 'registers'),
  })
}

// ── Impuestos ───────────────────────────────────────────────────────────────

/** `rate` en FRACCIÓN (0.18), que es como lo guarda la base. La UI convierte del %. */
export type TaxInput = Pick<Tax, 'name' | 'code' | 'rate'>

export function useSaveTax() {
  const { tenant } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, ...input }: TaxInput & { id?: string }) => {
      if (id) {
        const { data, error } = await supabase.from('taxes').update(input).eq('id', id).select('id')
        if (error) throw error
        assertTouched(data)
        return
      }
      if (!tenant) throw new Error('Sin empresa activa')
      const { error } = await supabase.from('taxes').insert({ ...input, tenant_id: tenant.id })
      if (error) throw error
    },
    // Los precios de los productos se muestran con su impuesto: también caducan.
    onSuccess: () => {
      invalidate(qc, 'taxes')
      qc.invalidateQueries({ queryKey: ['products'] })
    },
  })
}

export function useSetTaxActive() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      // Un impuesto inactivo no puede seguir siendo el predeterminado: el POS lo
      // aplicaría a productos nuevos sin que aparezca en ningún selector.
      const patch = active ? { is_active: true } : { is_active: false, is_default: false }
      const { data, error } = await supabase.from('taxes').update(patch).eq('id', id).select('id')
      if (error) throw error
      assertTouched(data)
    },
    onSuccess: () => invalidate(qc, 'taxes'),
  })
}

/** Mismo baile que la sucursal principal: índice único parcial de `is_default`. */
export function useSetDefaultTax() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const off = await supabase.from('taxes').update({ is_default: false }).eq('is_default', true).neq('id', id)
      if (off.error) throw off.error
      const { data, error } = await supabase
        .from('taxes')
        .update({ is_default: true, is_active: true })
        .eq('id', id)
        .select('id')
      if (error) throw error
      assertTouched(data)
    },
    onSuccess: () => invalidate(qc, 'taxes'),
  })
}
