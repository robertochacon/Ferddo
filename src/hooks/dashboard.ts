import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { DashboardSummary } from '@/types/db'

/** Todo a cero: lo que se pinta si la RPC devuelve `{}` (cuenta sin empresa). */
const EMPTY: DashboardSummary = {
  sales_today: 0,
  count_today: 0,
  sales_month: 0,
  count_month: 0,
  tax_month: 0,
  gross_margin_month: 0,
  payment_methods_month: {},
  top_products_month: [],
  sales_by_day: [],
  low_stock: [],
  low_stock_count: 0,
  receivables_open: 0,
  receivables_overdue: 0,
  payables_open: 0,
  expenses_month: 0,
  ecf_month: {},
  open_sessions: 0,
  members: 0,
}

const n = (v: unknown): number => Number(v ?? 0) || 0

function numberMap(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, n(x)]))
}

function list(v: unknown): Record<string, unknown>[] {
  return (Array.isArray(v) ? v : []) as Record<string, unknown>[]
}

/**
 * Resumen del tablero (`dashboard_summary(p_branch)`, migración 0018).
 *
 * La RPC exige `reports.view`; por eso el hook se apaga con `enabled` para
 * quien no lo tiene, en vez de dejar que la base responda FORBIDDEN y la
 * pantalla de inicio enseñe un error a un cajero.
 *
 * Los numeric de un jsonb pueden llegar como string ("1250.00"): se convierten
 * aquí, en la frontera, para que ninguna tarjeta sume texto ni pinte "NaN".
 *
 * La clave empieza por `['dashboard']` (ARQUITECTURA §7.11): las mutaciones que
 * invalidan `['dashboard']` refrescan también la vista de cada sucursal.
 */
export function useDashboard(branchId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['dashboard', branchId ?? 'all'],
    enabled,
    queryFn: async (): Promise<DashboardSummary> => {
      const { data, error } = await supabase.rpc('dashboard_summary', { p_branch: branchId })
      if (error) throw error
      // Cast acotado: jsonb sin tipar que puede venir vacío.
      const r = (data ?? {}) as Record<string, unknown>
      return {
        ...EMPTY,
        sales_today: n(r.sales_today),
        count_today: n(r.count_today),
        sales_month: n(r.sales_month),
        count_month: n(r.count_month),
        tax_month: n(r.tax_month),
        gross_margin_month: n(r.gross_margin_month),
        payment_methods_month: numberMap(r.payment_methods_month),
        top_products_month: list(r.top_products_month).map((p) => ({
          product_id: String(p.product_id ?? ''),
          name: String(p.name ?? '—'),
          quantity: n(p.quantity),
          amount: n(p.amount),
        })),
        sales_by_day: list(r.sales_by_day).map((d) => ({
          day: String(d.day ?? ''),
          total: n(d.total),
          count: n(d.count),
        })),
        low_stock: list(r.low_stock).map((p) => ({
          id: String(p.id ?? ''),
          name: String(p.name ?? '—'),
          min_stock: n(p.min_stock),
          stock: n(p.stock),
        })),
        low_stock_count: n(r.low_stock_count),
        receivables_open: n(r.receivables_open),
        receivables_overdue: n(r.receivables_overdue),
        payables_open: n(r.payables_open),
        expenses_month: n(r.expenses_month),
        ecf_month: numberMap(r.ecf_month),
        open_sessions: n(r.open_sessions),
        members: n(r.members),
      }
    },
  })
}
