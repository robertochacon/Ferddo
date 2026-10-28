import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/auth/AuthProvider'
import { invalidateAfterSaleChange } from '@/hooks/sales'
import { kickEcfQueue } from '@/hooks/invoicing'
import type {
  CreateSaleResult,
  EcfStatus,
  FiscalSettings,
  PaymentMethod,
  Quotation,
  QuotationItem,
} from '@/types/erp'

/*
 * Punto de venta. La venta entera es UNA llamada a `create_sale()`: el cliente
 * manda productos, cantidades y pagos, y la base recalcula importes, descuenta
 * inventario, mueve la caja y (si se pidió) reserva el e-CF en la misma
 * transacción. Aquí no se calcula nada que valga: `priceLines()` en el carrito
 * es solo vista previa.
 */

export interface SaleLinePayload {
  product_id: string
  quantity: number
  /** Solo si se cambió el precio (exige sales.price_override en la base). */
  unit_price?: number
  /** Descuento en dinero de la línea. */
  discount?: number
}

export interface SalePaymentPayload {
  method: Exclude<PaymentMethod, 'credit_note'>
  /** En efectivo, lo ENTREGADO por el cliente: la base calcula la devuelta. */
  amount: number
  reference?: string | null
}

export interface CreateSalePayload {
  client_uid: string
  register_id: string
  customer_id?: string | null
  seller_id?: string | null
  quotation_id?: string | null
  notes?: string | null
  items: SaleLinePayload[]
  global_discount?: number
  ecf_type?: string | null
  payments: SalePaymentPayload[]
}

export function useCreateSale() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: CreateSalePayload): Promise<CreateSaleResult> => {
      const { data, error } = await supabase.rpc('create_sale', { p_payload: payload })
      if (error) throw error
      const r = (data ?? {}) as Partial<CreateSaleResult>
      // `ecf` no viene en una respuesta "replayed" (reintento de una venta que
      // ya había entrado): se normaliza a null y el detalle lo trae de la tabla.
      const ecf = r.ecf as CreateSaleResult['ecf'] | undefined
      return {
        sale_id: String(r.sale_id),
        number: String(r.number ?? ''),
        total: Number(r.total ?? 0),
        change_due: Number(r.change_due ?? 0),
        replayed: Boolean(r.replayed),
        ecf: ecf ? { ...ecf, status: ecf.status as EcfStatus, simulated: Boolean(ecf.simulated) } : null,
      }
    },
    onSuccess: (r, payload) => {
      invalidateAfterSaleChange(qc)
      if (r.ecf && !r.replayed) kickEcfQueue(qc)
      if (payload.quotation_id) qc.invalidateQueries({ queryKey: ['quotations'] })
    },
  })
}

export interface PreviewTotals {
  subtotal: number
  discount_total: number
  tax_total: number
  total: number
}

/**
 * Total AUTORITATIVO antes de cobrar (`preview_totals()`, la misma función
 * que usará la venta). Se pide al abrir el cobro: si la vista previa local y
 * la base difieren en un centavo, un pago exacto con tarjeta "superaría el
 * total" y la venta se rechazaría.
 */
export function usePreviewTotals() {
  return useMutation({
    mutationFn: async (input: {
      items: SaleLinePayload[]
      globalDiscount: number
      /**
       * Cliente de la venta: la base toma de su lista de precios el precio de
       * las líneas sin `unit_price`, igual que hará create_sale(). Sin él, la
       * vista previa saldría a precio de catálogo y no cuadraría con el cobro.
       */
      customerId?: string | null
    }): Promise<PreviewTotals> => {
      const { data, error } = await supabase.rpc('preview_totals', {
        p_items: input.items,
        p_global_discount: input.globalDiscount,
        p_customer: input.customerId ?? null,
      })
      if (error) throw error
      const r = (data ?? {}) as Record<string, unknown>
      return {
        subtotal: Number(r.subtotal ?? 0),
        discount_total: Number(r.discount_total ?? 0),
        tax_total: Number(r.tax_total ?? 0),
        total: Number(r.total ?? 0),
      }
    },
  })
}

/**
 * Configuración fiscal mínima que necesita el POS (¿e-CF activo? ¿tipo por
 * defecto?). Clave propia bajo ['pos'] para no chocar con la de la pantalla de
 * Facturación, que lee la fila completa con otra forma.
 */
export function usePosFiscalSettings() {
  const { tenant, hasModule } = useAuth()
  const enabled = Boolean(tenant) && hasModule('invoicing')
  return useQuery({
    queryKey: ['pos', 'fiscal', tenant?.id],
    enabled,
    queryFn: async (): Promise<Pick<FiscalSettings, 'ecf_enabled' | 'default_ecf_type' | 'environment' | 'provider'> | null> => {
      const { data, error } = await supabase
        .from('fiscal_settings')
        .select('ecf_enabled, default_ecf_type, environment, provider')
        .maybeSingle()
      if (error) throw error
      return (data as Pick<FiscalSettings, 'ecf_enabled' | 'default_ecf_type' | 'environment' | 'provider'> | null) ?? null
    },
  })
}

export interface QuotationForPos {
  quotation: Quotation
  items: QuotationItem[]
}

/** Cotización + líneas para precargar el carrito ("Convertir en venta"). */
export function useQuotationForPos(id: string | null | undefined) {
  return useQuery({
    queryKey: ['quotations', 'for-pos', id],
    enabled: Boolean(id),
    // Siempre fresca: si otra caja ya la convirtió, hay que saberlo ahora.
    staleTime: 0,
    queryFn: async (): Promise<QuotationForPos> => {
      const [qRes, itRes] = await Promise.all([
        supabase.from('quotations').select('*').eq('id', id!).maybeSingle(),
        supabase.from('quotation_items').select('*').eq('quotation_id', id!).order('line_no'),
      ])
      if (qRes.error) throw qRes.error
      if (itRes.error) throw itRes.error
      if (!qRes.data) throw new Error('Cotización no encontrada')
      const q = qRes.data as Quotation
      return {
        quotation: { ...q, global_discount: Number(q.global_discount ?? 0), total: Number(q.total) },
        items: ((itRes.data ?? []) as QuotationItem[]).map((it) => ({
          ...it,
          quantity: Number(it.quantity),
          unit_price: Number(it.unit_price),
          discount: Number(it.discount),
          line_discount: Number(it.line_discount ?? 0),
          tax_rate: Number(it.tax_rate),
        })),
      }
    },
  })
}
