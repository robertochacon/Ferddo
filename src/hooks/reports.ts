import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { InventoryValuation, ReportRow, TaxReport } from '@/types/erp'

/*
 * Reportes. Todo el cálculo vive en las RPC de la migración 0018
 * (`report_sales`, `report_taxes`, `report_expenses`, `inventory_valuation`):
 * aquí solo se piden y se normalizan los números, que dentro de un jsonb
 * pueden llegar como string ("1250.00").
 *
 * Las fechas son DÍAS LOCALES de la empresa (`tenant.timezone`), no del
 * navegador: un dueño que revisa desde Miami las ventas de su colmado en Santo
 * Domingo debe ver el mismo "hoy" que la base usa para cortar los días.
 */

// ── Fechas en la zona horaria de la empresa ─────────────────────────────────

/** 'YYYY-MM-DD' de un instante en la zona dada. `en-CA` da justo ese formato. */
export function dayIn(tz: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at)
  } catch {
    // Zona inválida en la configuración: mejor el día del navegador que romper.
    return new Intl.DateTimeFormat('en-CA').format(at)
  }
}

/** Suma días a una fecha 'YYYY-MM-DD' sin pasar por la zona del navegador. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** Todos los días entre dos fechas, ambos incluidos (para rellenar huecos). */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  // Tope de seguridad: el reporte admite como mucho un año.
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d)
  return out
}

/**
 * Instante ISO en que EMPIEZA un día local de la empresa. Sirve para filtrar
 * columnas `timestamptz` (created_at) por días locales.
 */
export function dayStartIso(day: string, tz: string): string {
  try {
    // El desfase se mide al mediodía de ese día: así un cambio de horario en la
    // madrugada (en zonas que lo tengan) no corre el resultado.
    const probe = new Date(`${day}T12:00:00Z`)
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
      .formatToParts(probe)
      .find((p) => p.type === 'timeZoneName')?.value
    const m = name?.match(/GMT([+-]\d{2}):?(\d{2})?/)
    const offset = m ? `${m[1]}:${m[2] ?? '00'}` : '+00:00'
    return new Date(`${day}T00:00:00${offset}`).toISOString()
  } catch {
    return new Date(`${day}T00:00:00`).toISOString()
  }
}

export type PeriodPreset = 'today' | 'yesterday' | 'last7' | 'month' | 'prev_month' | 'custom'

export const PERIOD_LABEL: Record<PeriodPreset, string> = {
  today: 'Hoy',
  yesterday: 'Ayer',
  last7: 'Últimos 7 días',
  month: 'Este mes',
  prev_month: 'Mes anterior',
  custom: 'Rango',
}

export interface DateRange {
  from: string
  to: string
}

/** Rango de un preset en días locales de la empresa. `custom` lo pone la UI. */
export function presetRange(preset: Exclude<PeriodPreset, 'custom'>, tz: string): DateRange {
  const today = dayIn(tz)
  const monthStart = `${today.slice(0, 8)}01`
  const presets: Record<Exclude<PeriodPreset, 'custom'>, () => DateRange> = {
    today: () => ({ from: today, to: today }),
    yesterday: () => {
      const y = addDays(today, -1)
      return { from: y, to: y }
    },
    last7: () => ({ from: addDays(today, -6), to: today }),
    month: () => ({ from: monthStart, to: today }),
    prev_month: () => {
      const lastOfPrev = addDays(monthStart, -1)
      return { from: `${lastOfPrev.slice(0, 8)}01`, to: lastOfPrev }
    },
  }
  return presets[preset]()
}

// ── Normalización ───────────────────────────────────────────────────────────
const n = (v: unknown): number => Number(v ?? 0) || 0
const opt = (v: unknown): number | undefined => (v == null ? undefined : n(v))

function toRows(data: unknown): ReportRow[] {
  // Cast acotado: jsonb de las RPC de reportes, forma fijada en la 0018.
  const raw = (Array.isArray(data) ? data : []) as Record<string, unknown>[]
  return raw.map((r) => ({
    key: String(r.key ?? '—'),
    count: opt(r.count),
    quantity: opt(r.quantity),
    total: n(r.total),
    tax: opt(r.tax),
    discount: opt(r.discount),
    cost: opt(r.cost),
  }))
}

// ── Consultas ───────────────────────────────────────────────────────────────
export type SalesGroup = 'day' | 'product' | 'category' | 'seller' | 'branch' | 'method'

export function useSalesReport(range: DateRange, group: SalesGroup, branchId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['reports', 'sales', group, range.from, range.to, branchId],
    enabled: enabled && Boolean(range.from && range.to),
    queryFn: async (): Promise<ReportRow[]> => {
      const { data, error } = await supabase.rpc('report_sales', {
        p_from: range.from,
        p_to: range.to,
        p_group: group,
        p_branch: branchId,
      })
      if (error) throw error
      return toRows(data)
    },
  })
}

export function useTaxReport(range: DateRange, enabled = true) {
  return useQuery({
    queryKey: ['reports', 'taxes', range.from, range.to],
    enabled: enabled && Boolean(range.from && range.to),
    queryFn: async (): Promise<TaxReport> => {
      const { data, error } = await supabase.rpc('report_taxes', { p_from: range.from, p_to: range.to })
      if (error) throw error
      const r = (data ?? {}) as Record<string, unknown>
      const byRate = (Array.isArray(r.by_rate) ? r.by_rate : []) as Record<string, unknown>[]
      return {
        itbis_sales: n(r.itbis_sales),
        itbis_returns: n(r.itbis_returns),
        itbis_collected: n(r.itbis_collected),
        itbis_purchases: n(r.itbis_purchases),
        itbis_expenses: n(r.itbis_expenses),
        itbis_paid: n(r.itbis_paid),
        difference: n(r.difference),
        by_rate: byRate.map((x) => ({ tax_rate: n(x.tax_rate), base: n(x.base), tax: n(x.tax) })),
      }
    },
  })
}

export function useExpensesReport(range: DateRange, enabled = true) {
  return useQuery({
    queryKey: ['reports', 'expenses', range.from, range.to],
    enabled: enabled && Boolean(range.from && range.to),
    queryFn: async (): Promise<ReportRow[]> => {
      const { data, error } = await supabase.rpc('report_expenses', { p_from: range.from, p_to: range.to })
      if (error) throw error
      return toRows(data)
    },
  })
}

export function useInventoryValuation(branchId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['reports', 'inventory', branchId],
    enabled,
    queryFn: async (): Promise<InventoryValuation> => {
      const { data, error } = await supabase.rpc('inventory_valuation', { p_branch: branchId })
      if (error) throw error
      const r = (data ?? {}) as Record<string, unknown>
      const cats = (Array.isArray(r.by_category) ? r.by_category : []) as Record<string, unknown>[]
      return {
        total_cost: n(r.total_cost),
        total_retail: n(r.total_retail),
        products: n(r.products),
        by_category: cats.map((c) => ({
          category: String(c.category ?? 'Sin categoría'),
          cost_value: n(c.cost_value),
          retail_value: n(c.retail_value),
        })),
      }
    },
  })
}
