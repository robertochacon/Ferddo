import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Quotation, QuotationItem, QuotationStatus } from '@/types/erp'

/*
 * Cotizaciones. save_quotation() calcula con price_lines(), la misma función
 * que la venta: la vista previa del formulario es un espejo y el importe que
 * vale es el que devuelve la base. La conversión en venta la hace el POS
 * pasando quotation_id a create_sale(), que la marca convertida en la misma
 * transacción (imposible convertirla dos veces).
 */

const toQuotation = (q: Quotation): Quotation => ({
  ...q,
  subtotal: Number(q.subtotal),
  discount_total: Number(q.discount_total),
  tax_total: Number(q.tax_total),
  total: Number(q.total),
  global_discount: Number(q.global_discount),
})

export function useQuotations() {
  return useQuery({
    queryKey: ['quotations'],
    queryFn: async (): Promise<Quotation[]> => {
      const { data, error } = await supabase
        .from('quotations')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1000)
      if (error) throw error
      return ((data ?? []) as Quotation[]).map(toQuotation)
    },
  })
}

export interface QuotationDetail {
  quotation: Quotation
  items: QuotationItem[]
}

export function useQuotation(id: string | undefined) {
  return useQuery({
    queryKey: ['quotation', id],
    enabled: Boolean(id),
    queryFn: async (): Promise<QuotationDetail | null> => {
      const { data, error } = await supabase.from('quotations').select('*').eq('id', id!).maybeSingle()
      if (error) throw error
      if (!data) return null
      const { data: items, error: itemsError } = await supabase
        .from('quotation_items')
        .select('*')
        .eq('quotation_id', id!)
        .order('line_no')
      if (itemsError) throw itemsError
      return {
        quotation: toQuotation(data as Quotation),
        items: ((items ?? []) as QuotationItem[]).map((it) => ({
          ...it,
          quantity: Number(it.quantity),
          unit_price: Number(it.unit_price),
          discount: Number(it.discount),
          line_discount: Number(it.line_discount),
          tax_rate: Number(it.tax_rate),
          subtotal: Number(it.subtotal),
          tax_amount: Number(it.tax_amount),
          total: Number(it.total),
        })),
      }
    },
  })
}

export interface SaveQuotationInput {
  id?: string
  branch_id: string
  customer_id?: string | null
  valid_until?: string | null
  notes?: string | null
  terms?: string | null
  global_discount?: number
  /** Sin unit_price se cotiza al precio vigente del catálogo. */
  items: { product_id: string; quantity: number; unit_price?: number; discount?: number }[]
}

export function useSaveQuotation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: SaveQuotationInput): Promise<string> => {
      const { data, error } = await supabase.rpc('save_quotation', { p_payload: input })
      if (error) throw error
      return data as string
    },
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: ['quotations'] })
      qc.invalidateQueries({ queryKey: ['quotation', id] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export function useSetQuotationStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: Exclude<QuotationStatus, 'converted'> }) => {
      const { error } = await supabase.rpc('set_quotation_status', { p_id: id, p_status: status })
      if (error) throw error
      return id
    },
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: ['quotations'] })
      qc.invalidateQueries({ queryKey: ['quotation', id] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}
