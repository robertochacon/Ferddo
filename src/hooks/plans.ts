import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { PLANS, type PlanInfo } from '@/lib/constants'
import type { ModuleCode, PlanCode } from '@/types/db'

/** Fila cruda de `plan_settings` (la fuente de verdad de precios y topes). */
export interface PlanSettingRow {
  plan: PlanCode
  name: string
  price_monthly: number
  price_usd: number
  /** `null` = ilimitado, NO cero. */
  max_products: number | null
  max_members: number | null
  max_branches: number | null
  max_registers: number | null
  max_ecf_monthly: number | null
  modules: ModuleCode[] | null
  features: string[]
  is_offered: boolean
  is_featured: boolean
  sort_order: number
  updated_at: string
}

// Columnas explícitas y no `*`: `updated_by` (quién tocó los precios) no le
// importa a la UI y la fila la lee cualquier visitante sin sesión.
const COLS =
  'plan, name, price_monthly, price_usd, max_products, max_members, max_branches, max_registers, max_ecf_monthly, modules, features, is_offered, is_featured, sort_order, updated_at'

/**
 * Lee `plan_settings`. Es PÚBLICO —la landing enseña los precios sin sesión— y
 * la RLS de la migración 0009 permite el SELECT a `anon`.
 *
 * Se expone como función suelta, además del hook, porque el AuthProvider la
 * llama fuera de react-query para tener los planes listos antes de que monte
 * ninguna pantalla.
 */
export async function fetchPlanSettings(): Promise<PlanSettingRow[]> {
  const { data, error } = await supabase.from('plan_settings').select(COLS).order('sort_order')
  if (error) throw error
  return (data ?? []) as PlanSettingRow[]
}

/**
 * Convierte las filas al `PlanInfo` que usa toda la app, con las constantes de
 * `@/lib/constants` como respaldo. Así, si la consulta falla o la app abre sin
 * conexión, ningún plan se queda sin nombre ni sin precio.
 */
export function toPlanMap(rows: PlanSettingRow[] | undefined): Record<PlanCode, PlanInfo> {
  const map = { ...PLANS }
  for (const r of rows ?? []) {
    // Un plan que está en la tabla pero no en el enum de la app (base más nueva
    // que el build) se ignora: la UI no sabría qué hacer con él.
    if (!map[r.plan]) continue
    map[r.plan] = {
      code: r.plan,
      name: r.name,
      price: Number(r.price_monthly),
      priceUsd: Number(r.price_usd),
      maxProducts: r.max_products,
      maxMembers: r.max_members,
      maxBranches: r.max_branches,
      maxRegisters: r.max_registers,
      maxEcfMonthly: r.max_ecf_monthly,
      modules: r.modules,
      features: r.features ?? [],
      isOffered: r.is_offered,
      isFeatured: r.is_featured,
      sortOrder: r.sort_order,
    }
  }
  return map
}

/** Planes vigentes. Sirve tanto con sesión como en la landing pública. */
export function usePlanSettings() {
  return useQuery({
    queryKey: ['plan-settings'],
    // Cambian muy de vez en cuando; no tiene sentido repreguntarlo en cada
    // pantalla que enseñe un precio.
    staleTime: 10 * 60_000,
    queryFn: fetchPlanSettings,
  })
}

/**
 * Cambio parcial de un plan. Una clave presente con `null` significa
 * "ilimitado / sin restricción"; una clave ausente, "no tocar". Por eso viaja
 * como jsonb (admin_update_plan, migración 0018) y no como parámetros sueltos.
 */
export interface PlanUpdate {
  plan: PlanCode
  name?: string
  price_monthly?: number
  price_usd?: number
  max_products?: number | null
  max_members?: number | null
  max_branches?: number | null
  max_registers?: number | null
  max_ecf_monthly?: number | null
  modules?: ModuleCode[] | null
  features?: string[]
  is_offered?: boolean
  is_featured?: boolean
  sort_order?: number
}

export function useAdminUpdatePlan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ plan, ...patch }: PlanUpdate) => {
      const { error } = await supabase.rpc('admin_update_plan', { p_plan: plan, p_patch: patch })
      if (error) throw error
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['plan-settings'] })
      await qc.invalidateQueries({ queryKey: ['admin'] })
    },
  })
}
