import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/auth/AuthProvider'
import type { CashMovement, CashSession, CashSessionReport } from '@/types/erp'

/*
 * Caja: sesiones (apertura → cierre), sus movimientos y el arqueo.
 *
 * Todo cuelga de la clave raíz ['cash'] para que una venta, una devolución o
 * un gasto en efectivo invaliden de un golpe el "esperado" de la caja abierta,
 * sin tener que conocer cada sub-clave. El esperado NUNCA se calcula aquí:
 * sale de `cash_session_report()`, que suma el libro de movimientos en la base.
 */

/** Los numeric que llegan dentro de un jsonb pueden venir como string. */
function toNumberMap(obj: unknown): Record<string, number> {
  if (!obj || typeof obj !== 'object') return {}
  return Object.fromEntries(Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, Number(v ?? 0)]))
}

function normalizeSession(s: CashSession): CashSession {
  return {
    ...s,
    opening_amount: Number(s.opening_amount ?? 0),
    expected_cash: s.expected_cash == null ? null : Number(s.expected_cash),
    counted_cash: s.counted_cash == null ? null : Number(s.counted_cash),
    difference: s.difference == null ? null : Number(s.difference),
    totals: s.totals ? toNumberMap(s.totals) : null,
  }
}

/** Frontera con el jsonb crudo de `cash_session_report()` / `close_cash_session()`. */
export function normalizeReport(raw: unknown): CashSessionReport {
  const r = (raw ?? {}) as Partial<CashSessionReport>
  return {
    session: normalizeSession(r.session as CashSession),
    register_name: r.register_name ?? null,
    opened_by_name: r.opened_by_name ?? null,
    expected_cash: Number(r.expected_cash ?? 0),
    by_method: toNumberMap(r.by_method),
    by_kind: toNumberMap(r.by_kind),
    sales_count: Number(r.sales_count ?? 0),
    sales_total: Number(r.sales_total ?? 0),
    credit_total: Number(r.credit_total ?? 0),
  }
}

/** Todas las cajas abiertas de la empresa (la RLS ya acota al tenant). */
export function useOpenSessions() {
  return useQuery({
    queryKey: ['cash', 'sessions', 'open'],
    queryFn: async (): Promise<CashSession[]> => {
      const { data, error } = await supabase
        .from('cash_sessions')
        .select('*')
        .eq('status', 'open')
        .order('opened_at', { ascending: false })
      if (error) throw error
      return ((data ?? []) as CashSession[]).map(normalizeSession)
    },
  })
}

/**
 * Historial de cierres. Sin `cash.view_all` solo se piden las propias: la
 * tabla deja leer todas, pero el reporte de una ajena falla con FORBIDDEN y
 * enseñar filas que no se pueden abrir solo confunde.
 */
export function useClosedSessions(limit = 50) {
  const { user, can } = useAuth()
  const viewAll = can('cash.view_all')
  return useQuery({
    queryKey: ['cash', 'sessions', 'closed', { limit, viewAll }],
    enabled: Boolean(user),
    queryFn: async (): Promise<CashSession[]> => {
      let q = supabase
        .from('cash_sessions')
        .select('*')
        .eq('status', 'closed')
        .order('closed_at', { ascending: false })
        .limit(limit)
      if (!viewAll) q = q.eq('opened_by', user!.id)
      const { data, error } = await q
      if (error) throw error
      return ((data ?? []) as CashSession[]).map(normalizeSession)
    },
  })
}

export function useCashSessionReport(sessionId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['cash', 'report', sessionId],
    enabled: Boolean(sessionId) && enabled,
    queryFn: async (): Promise<CashSessionReport> => {
      const { data, error } = await supabase.rpc('cash_session_report', { p_session: sessionId })
      if (error) throw error
      return normalizeReport(data)
    },
  })
}

export function useCashMovements(sessionId: string | null | undefined) {
  return useQuery({
    queryKey: ['cash', 'movements', sessionId],
    enabled: Boolean(sessionId),
    queryFn: async (): Promise<CashMovement[]> => {
      const { data, error } = await supabase
        .from('cash_movements')
        .select('*')
        .eq('session_id', sessionId!)
        .order('created_at', { ascending: true })
      if (error) throw error
      return ((data ?? []) as CashMovement[]).map((m) => ({ ...m, amount: Number(m.amount) }))
    },
  })
}

export function useOpenCashSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { registerId: string; openingAmount: number; note?: string | null }) => {
      const { data, error } = await supabase.rpc('open_cash_session', {
        p_register: input.registerId,
        p_opening_amount: input.openingAmount,
        p_note: input.note ?? null,
      })
      if (error) throw error
      return data as string
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cash'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export function useCashMove() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { sessionId: string; kind: 'cash_in' | 'cash_out'; amount: number; note: string }) => {
      const { data, error } = await supabase.rpc('cash_move', {
        p_session: input.sessionId,
        p_kind: input.kind,
        p_amount: input.amount,
        p_note: input.note,
      })
      if (error) throw error
      return data as string
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cash'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export function useCloseCashSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { sessionId: string; countedCash: number; notes?: string | null }) => {
      const { data, error } = await supabase.rpc('close_cash_session', {
        p_session: input.sessionId,
        p_counted_cash: input.countedCash,
        p_notes: input.notes ?? null,
      })
      if (error) throw error
      return normalizeReport(data)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cash'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}
