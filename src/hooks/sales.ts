import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { newClientUid } from '@/lib/labels'
import type {
  Customer,
  ElectronicInvoice,
  EcfStatus,
  PaymentMethod,
  Receivable,
  Sale,
  SaleItem,
  SalePayment,
  SaleReturn,
  SaleStatus,
} from '@/types/erp'

/*
 * Ventas ya registradas: listado, detalle, anulación y devolución.
 *
 * Todas las claves cuelgan de ['sales'] (listado = ['sales', filtros],
 * detalle = ['sales', 'detail', id]) para que `create_sale`, `void_sale` y
 * `return_sale` refresquen ambas cosas con una sola invalidación.
 */

export interface SalesFilters {
  /** ISO, inclusivo. */
  from: string
  /** ISO, EXCLUSIVO (inicio del día siguiente). */
  to: string
  status?: SaleStatus | ''
  branchId?: string | ''
}

/** Lo que pinta el listado: solo las columnas que hacen falta. */
export type SaleListRow = Pick<
  Sale,
  | 'id'
  | 'number'
  | 'status'
  | 'created_at'
  | 'customer_id'
  | 'seller_id'
  | 'created_by'
  | 'branch_id'
  | 'register_id'
  | 'total'
  | 'returned_total'
  | 'credit_amount'
  | 'ecf_type'
>

const LIST_COLUMNS =
  'id, number, status, created_at, customer_id, seller_id, created_by, branch_id, register_id, total, returned_total, credit_amount, ecf_type'

/** Mismo motivo que en core.ts: PostgREST corta en 1000 filas por respuesta. */
const PAGE = 1000
const MAX_PAGES = 10

export function useSales(filters: SalesFilters) {
  return useQuery({
    queryKey: ['sales', filters],
    queryFn: async (): Promise<SaleListRow[]> => {
      const out: SaleListRow[] = []
      for (let page = 0; page < MAX_PAGES; page++) {
        let q = supabase
          .from('sales')
          .select(LIST_COLUMNS)
          .gte('created_at', filters.from)
          .lt('created_at', filters.to)
          .order('created_at', { ascending: false })
          .range(page * PAGE, page * PAGE + PAGE - 1)
        if (filters.status) q = q.eq('status', filters.status)
        if (filters.branchId) q = q.eq('branch_id', filters.branchId)
        const { data, error } = await q
        if (error) throw error
        const rows = ((data ?? []) as SaleListRow[]).map((r) => ({
          ...r,
          total: Number(r.total),
          returned_total: Number(r.returned_total),
          credit_amount: Number(r.credit_amount),
        }))
        out.push(...rows)
        if (rows.length < PAGE) break
      }
      return out
    },
  })
}

export interface SaleReturnItemRow {
  id: string
  return_id: string
  sale_item_id: string
  quantity: number
  subtotal: number
  tax_amount: number
  total: number
}

export interface SaleReturnWithItems extends SaleReturn {
  items: SaleReturnItemRow[]
}

/** Lo justo del cliente para el ticket y el detalle. */
export type SaleCustomer = Pick<Customer, 'id' | 'name' | 'doc_type' | 'doc_number' | 'phone' | 'address'>

export interface SaleDetail {
  sale: Sale
  items: SaleItem[]
  payments: SalePayment[]
  returns: SaleReturnWithItems[]
  /** e-CF de la venta y notas de crédito de sus devoluciones. */
  invoices: ElectronicInvoice[]
  customer: SaleCustomer | null
  /** Cuenta por cobrar del crédito de esta venta (si se vendió a crédito). */
  receivable: Receivable | null
  /** ¿Sigue abierta la caja de la venta? (condición para anular). */
  sessionOpen: boolean
}

const num = (v: unknown) => Number(v ?? 0)

/**
 * Carga el detalle completo. Exportada (y no solo dentro del hook) porque el
 * POS la usa para imprimir el ticket con los importes DEFINITIVOS de la base
 * justo después de cobrar, sin montar la pantalla de detalle.
 */
export async function fetchSaleDetail(id: string): Promise<SaleDetail> {
  const { data: sale, error } = await supabase.from('sales').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  if (!sale) throw new Error('Venta no encontrada o sin permiso para verla')
  const s = sale as Sale

  const [itemsRes, paysRes, retsRes, rcvRes, sessRes, custRes] = await Promise.all([
    supabase.from('sale_items').select('*').eq('sale_id', id).order('line_no'),
    supabase.from('sale_payments').select('*').eq('sale_id', id).order('created_at'),
    supabase.from('sale_returns').select('*').eq('sale_id', id).order('created_at'),
    supabase.from('receivables').select('*').eq('sale_id', id).maybeSingle(),
    supabase.from('cash_sessions').select('status').eq('id', s.session_id).maybeSingle(),
    s.customer_id
      ? supabase
          .from('customers')
          .select('id, name, doc_type, doc_number, phone, address')
          .eq('id', s.customer_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])
  for (const r of [itemsRes, paysRes, retsRes, rcvRes, sessRes, custRes]) if (r.error) throw r.error

  const returns = ((retsRes.data ?? []) as SaleReturn[]).map((r) => ({
    ...r,
    subtotal: num(r.subtotal),
    tax_total: num(r.tax_total),
    total: num(r.total),
  }))
  const returnIds = returns.map((r) => r.id)

  // Las notas de crédito cuelgan de la devolución, no de la venta: dos
  // consultas en vez de un `or` con lista para no armar filtros a mano.
  const [retItemsRes, saleEcfRes, retEcfRes] = await Promise.all([
    returnIds.length
      ? supabase.from('sale_return_items').select('*').in('return_id', returnIds)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from('electronic_invoices')
      .select('*')
      .eq('source_type', 'sale')
      .eq('source_id', id)
      .order('created_at'),
    returnIds.length
      ? supabase
          .from('electronic_invoices')
          .select('*')
          .eq('source_type', 'sale_return')
          .in('source_id', returnIds)
          .order('created_at')
      : Promise.resolve({ data: [], error: null }),
  ])
  for (const r of [retItemsRes, saleEcfRes, retEcfRes]) if (r.error) throw r.error

  const retItems = ((retItemsRes.data ?? []) as SaleReturnItemRow[]).map((x) => ({
    ...x,
    quantity: num(x.quantity),
    subtotal: num(x.subtotal),
    tax_amount: num(x.tax_amount),
    total: num(x.total),
  }))

  const invoices = [...((saleEcfRes.data ?? []) as ElectronicInvoice[]), ...((retEcfRes.data ?? []) as ElectronicInvoice[])].map(
    (e) => ({
      ...e,
      subtotal: num(e.subtotal),
      tax_total: num(e.tax_total),
      total: num(e.total),
      messages: Array.isArray(e.messages) ? e.messages : [],
    }),
  )

  const rcv = rcvRes.data as Receivable | null

  return {
    sale: {
      ...s,
      subtotal: num(s.subtotal),
      discount_total: num(s.discount_total),
      tax_total: num(s.tax_total),
      total: num(s.total),
      paid_total: num(s.paid_total),
      change_due: num(s.change_due),
      credit_amount: num(s.credit_amount),
      returned_total: num(s.returned_total),
    },
    items: ((itemsRes.data ?? []) as SaleItem[]).map((it) => ({
      ...it,
      quantity: num(it.quantity),
      unit_price: num(it.unit_price),
      discount: num(it.discount),
      tax_rate: num(it.tax_rate),
      subtotal: num(it.subtotal),
      tax_amount: num(it.tax_amount),
      total: num(it.total),
      unit_cost: num(it.unit_cost),
      returned_qty: num(it.returned_qty),
    })),
    payments: ((paysRes.data ?? []) as SalePayment[]).map((p) => ({
      ...p,
      amount: num(p.amount),
      tendered: p.tendered == null ? null : num(p.tendered),
    })),
    returns: returns.map((r) => ({ ...r, items: retItems.filter((x) => x.return_id === r.id) })),
    invoices,
    customer: (custRes.data as SaleCustomer | null) ?? null,
    receivable: rcv ? { ...rcv, amount: num(rcv.amount), paid_amount: num(rcv.paid_amount) } : null,
    sessionOpen: (sessRes.data as { status: string } | null)?.status === 'open',
  }
}

export const saleDetailKey = (id: string) => ['sales', 'detail', id] as const

export function useSale(id: string | undefined) {
  return useQuery({
    queryKey: saleDetailKey(id ?? ''),
    enabled: Boolean(id),
    queryFn: () => fetchSaleDetail(id!),
  })
}

/**
 * Pide (o reutiliza de la caché) el detalle de una venta fuera de render: el
 * POS lo usa al pulsar "Imprimir ticket" tras cobrar.
 */
export function useSaleDetailFetcher() {
  const qc = useQueryClient()
  return useCallback(
    (id: string) => qc.fetchQuery({ queryKey: saleDetailKey(id), queryFn: () => fetchSaleDetail(id) }),
    [qc],
  )
}

/** Lo que una venta, anulación o devolución deja desfasado en otras pantallas. */
export function invalidateAfterSaleChange(qc: QueryClient) {
  for (const key of ['sales', 'stock', 'dashboard', 'cash', 'customer-balances', 'receivables', 'ecf', 'inventory']) {
    qc.invalidateQueries({ queryKey: [key] })
  }
}

export function useVoidSale() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { saleId: string; reason: string }) => {
      const { error } = await supabase.rpc('void_sale', { p_sale: input.saleId, p_reason: input.reason })
      if (error) throw error
    },
    onSuccess: () => invalidateAfterSaleChange(qc),
  })
}

export interface ReturnSaleInput {
  /** Generado al abrir el formulario y reutilizado en los reintentos. */
  clientUid: string
  saleId: string
  registerId?: string | null
  refundMethod: Extract<PaymentMethod, 'cash' | 'card' | 'transfer' | 'credit_note'>
  reason: string
  restock: boolean
  items: { sale_item_id: string; quantity: number }[]
}

export interface ReturnSaleResult {
  return_id: string
  number?: string
  total?: number
  replayed: boolean
  ecf?: { invoice_id: string; encf: string; status: EcfStatus } | null
}

export function useReturnSale() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: ReturnSaleInput): Promise<ReturnSaleResult> => {
      const { data, error } = await supabase.rpc('return_sale', {
        p_payload: {
          client_uid: input.clientUid,
          sale_id: input.saleId,
          register_id: input.registerId ?? null,
          refund_method: input.refundMethod,
          reason: input.reason,
          restock: input.restock,
          items: input.items,
        },
      })
      if (error) throw error
      const r = (data ?? {}) as ReturnSaleResult
      return { ...r, total: r.total == null ? undefined : Number(r.total) }
    },
    onSuccess: () => invalidateAfterSaleChange(qc),
  })
}

/** Re-exportado para que las pantallas no tengan que conocer dónde vive. */
export { newClientUid }
