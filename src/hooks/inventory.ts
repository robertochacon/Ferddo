import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { InventoryDocument, InventoryMovement, InventoryValuation, StockLevel } from '@/types/erp'

/*
 * Inventario: existencias, kardex y los tres documentos manuales (ajuste,
 * transferencia y conteo físico).
 *
 * El cliente NUNCA escribe existencias ni movimientos: `stock_levels` e
 * `inventory_movements` no tienen permiso de escritura y el kardex es inmutable.
 * Todo cambio pasa por una RPC (0014) que crea el documento y sus movimientos
 * en una transacción; el trigger del movimiento mueve el saldo.
 *
 * PostgREST devuelve numeric como number en columnas, pero dentro de un jsonb
 * puede llegar como string: por eso los Number() al leer RPC.
 */

/** Un ajuste/transferencia/conteo deja desfasado todo lo que muestra existencias o costo. */
function invalidateInventory(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ['stock'] })
  void qc.invalidateQueries({ queryKey: ['inventory'] })
  // El ajuste con existencia inicial puede fijar el costo de un producto que no tenía.
  void qc.invalidateQueries({ queryKey: ['products'] })
  void qc.invalidateQueries({ queryKey: ['dashboard'] })
}

/** Igual que `fetchAll` de core.ts (no exportado): PostgREST corta en 1000 filas. */
async function fetchPaged<T>(
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

// ── Lecturas ────────────────────────────────────────────────────────────────

/**
 * Existencias de TODAS las sucursales (vista por sucursal y totales del
 * catálogo). Vive bajo ['stock', …] para que cualquier mutación que invalide
 * ['stock'] la refresque también; 'all' no choca con ['stock', branchId]
 * porque un id de sucursal es un uuid.
 */
export function useAllStock() {
  return useQuery({
    queryKey: ['stock', 'all'],
    queryFn: async (): Promise<StockLevel[]> => {
      const rows = await fetchPaged<StockLevel>((from, to) =>
        supabase.from('stock_levels').select('*').range(from, to),
      )
      return rows.map((r) => ({ ...r, quantity: Number(r.quantity) }))
    },
  })
}

/** Tope del kardex en pantalla: un producto de alta rotación acumula miles de movimientos. */
export const KARDEX_LIMIT = 500

/** Movimientos de un producto (opcionalmente de una sucursal), del más reciente al más antiguo. */
export function useKardex(productId: string | undefined, branchId?: string) {
  return useQuery({
    queryKey: ['inventory', 'kardex', productId, branchId ?? 'all'],
    enabled: Boolean(productId),
    queryFn: async (): Promise<InventoryMovement[]> => {
      let q = supabase.from('inventory_movements').select('*').eq('product_id', productId!)
      if (branchId) q = q.eq('branch_id', branchId)
      const { data, error } = await q.order('created_at', { ascending: false }).limit(KARDEX_LIMIT)
      if (error) throw error
      return ((data ?? []) as InventoryMovement[]).map(normalizeMovement)
    },
  })
}

/** Movimientos que generó un documento de inventario (AJ/TR/CF). */
export function useInventoryDocumentMovements(documentId: string | undefined) {
  return useQuery({
    queryKey: ['inventory', 'document', documentId],
    enabled: Boolean(documentId),
    queryFn: async (): Promise<InventoryMovement[]> => {
      const { data, error } = await supabase
        .from('inventory_movements')
        .select('*')
        .eq('reference_type', 'inventory_document')
        .eq('reference_id', documentId!)
        .order('created_at')
      if (error) throw error
      return ((data ?? []) as InventoryMovement[]).map(normalizeMovement)
    },
  })
}

function normalizeMovement(m: InventoryMovement): InventoryMovement {
  return {
    ...m,
    quantity: Number(m.quantity),
    unit_cost: Number(m.unit_cost),
    balance_after: Number(m.balance_after),
  }
}

export const DOCUMENTS_LIMIT = 300

export function useInventoryDocuments() {
  return useQuery({
    queryKey: ['inventory', 'documents'],
    queryFn: async (): Promise<InventoryDocument[]> => {
      const { data, error } = await supabase
        .from('inventory_documents')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(DOCUMENTS_LIMIT)
      if (error) throw error
      return (data ?? []) as InventoryDocument[]
    },
  })
}

/** Valoración a costo y a precio de venta (solo existencias positivas). */
export function useInventoryValuation(branchId?: string) {
  return useQuery({
    queryKey: ['inventory', 'valuation', branchId ?? 'all'],
    queryFn: async (): Promise<InventoryValuation> => {
      const { data, error } = await supabase.rpc('inventory_valuation', { p_branch: branchId ?? null })
      if (error) throw error
      const raw = (data ?? {}) as Partial<Record<keyof InventoryValuation, unknown>>
      const cats = (raw.by_category ?? []) as { category: string; cost_value: unknown; retail_value: unknown }[]
      return {
        total_cost: Number(raw.total_cost ?? 0),
        total_retail: Number(raw.total_retail ?? 0),
        products: Number(raw.products ?? 0),
        by_category: cats.map((c) => ({
          category: c.category,
          cost_value: Number(c.cost_value ?? 0),
          retail_value: Number(c.retail_value ?? 0),
        })),
      }
    },
  })
}

// ── Documentos ──────────────────────────────────────────────────────────────

export interface AdjustLine {
  product_id: string
  /** Con signo: positivo entra, negativo sale. */
  quantity: number
  unit_cost?: number
}

/** Devuelve el id del documento AJ creado. */
export function useInventoryAdjust() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      branchId: string
      lines: AdjustLine[]
      reason: string
      initial?: boolean
    }): Promise<string> => {
      const { data, error } = await supabase.rpc('inventory_adjust', {
        p_branch: input.branchId,
        p_lines: input.lines,
        p_reason: input.reason.trim(),
        p_initial: input.initial ?? false,
      })
      if (error) throw error
      return data as string
    },
    onSuccess: () => invalidateInventory(qc),
  })
}

/** Devuelve el id del documento TR creado. */
export function useInventoryTransfer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      fromBranchId: string
      toBranchId: string
      lines: { product_id: string; quantity: number }[]
      note?: string | null
    }): Promise<string> => {
      const { data, error } = await supabase.rpc('inventory_transfer', {
        p_from: input.fromBranchId,
        p_to: input.toBranchId,
        p_lines: input.lines,
        p_note: input.note?.trim() || null,
      })
      if (error) throw error
      return data as string
    },
    onSuccess: () => invalidateInventory(qc),
  })
}

export interface CountResult {
  document_id: string
  /** Líneas en las que lo contado difería del saldo y se generó movimiento. */
  differences: number
}

/**
 * Conteo físico: se manda lo CONTADO, no la diferencia. La base la calcula
 * contra el saldo bloqueado en ese instante, así que una venta hecha mientras
 * se contaba no se pisa con un número viejo de la pantalla.
 */
export function useInventoryCount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      branchId: string
      counts: { product_id: string; counted: number }[]
      note?: string | null
    }): Promise<CountResult> => {
      const { data, error } = await supabase.rpc('inventory_count', {
        p_branch: input.branchId,
        p_counts: input.counts,
        p_note: input.note?.trim() || null,
      })
      if (error) throw error
      const raw = (data ?? {}) as { document_id?: unknown; differences?: unknown }
      return { document_id: String(raw.document_id ?? ''), differences: Number(raw.differences ?? 0) }
    },
    onSuccess: () => invalidateInventory(qc),
  })
}
