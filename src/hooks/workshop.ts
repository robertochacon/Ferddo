import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/auth/AuthProvider'
import { isUniqueViolation } from '@/lib/errors'
import { invalidateAfterSaleChange } from '@/hooks/sales'
import { kickEcfQueue } from '@/hooks/invoicing'
import type { SalePaymentPayload } from '@/hooks/pos'
import type {
  Asset,
  CreateSaleResult,
  Customer,
  EcfStatus,
  Quotation,
  Sale,
  WorkOrder,
  WorkOrderAdvance,
  WorkOrderItem,
  WorkOrderStatus,
} from '@/types/erp'

/*
 * Taller: vehículos/equipos de los clientes y órdenes de trabajo (0022).
 *
 * Los vehículos se escriben directo en la tabla (la RLS exige workshop.assets);
 * todo lo de la orden pasa por las RPC wo_*, que son las que conocen el flujo
 * de estados, los anticipos y la facturación. Aquí no se calcula ningún
 * importe que valga: la venta sale de create_sale() con los precios vigentes
 * del catálogo al momento de facturar.
 *
 * Todo cuelga de ['workshop'] para que cualquier mutación refresque de un golpe
 * el tablero, el detalle y los vehículos sin conocer cada sub-clave.
 */

const toOrder = (o: WorkOrder): WorkOrder => ({
  ...o,
  seq: Number(o.seq),
  mileage_in: o.mileage_in == null ? null : Number(o.mileage_in),
})

// ── Vehículos y equipos ─────────────────────────────────────────────────────

export function useCustomerAssets(customerId: string | null | undefined) {
  return useQuery({
    queryKey: ['workshop', 'assets', customerId],
    enabled: Boolean(customerId),
    queryFn: async (): Promise<Asset[]> => {
      const { data, error } = await supabase
        .from('assets')
        .select('*')
        .eq('customer_id', customerId!)
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as Asset[]
    },
  })
}

export type AssetInput = Pick<
  Asset,
  'customer_id' | 'kind' | 'brand' | 'model' | 'year' | 'plate' | 'serial' | 'color' | 'notes'
> & { id?: string }

export function useSaveAsset() {
  const qc = useQueryClient()
  const { tenant } = useAuth()
  return useMutation({
    mutationFn: async ({ id, ...input }: AssetInput): Promise<Asset> => {
      if (!id && !tenant) throw new Error('Sin empresa activa')
      // assets.tenant_id no tiene default: el alta lo manda y la RLS comprueba
      // que sea la empresa activa. En la edición no se toca.
      const res = id
        ? await supabase.from('assets').update(input).eq('id', id).select('*').single()
        : await supabase
            .from('assets')
            .insert({ ...input, tenant_id: tenant!.id })
            .select('*')
            .single()
      if (res.error) {
        // La única clave única que puede chocar es la placa (por empresa, sin
        // distinguir mayúsculas): se traduce aquí para no enseñar el texto de
        // Postgres con el nombre del índice.
        if (isUniqueViolation(res.error)) throw new Error('Ya hay un vehículo registrado con esa placa en tu empresa.')
        throw res.error
      }
      return res.data as Asset
    },
    onSuccess: (a) => {
      qc.invalidateQueries({ queryKey: ['workshop', 'assets', a.customer_id] })
      // El listado y el detalle enseñan la placa: si se corrigió, que se vea.
      qc.invalidateQueries({ queryKey: ['workshop', 'orders'] })
      qc.invalidateQueries({ queryKey: ['workshop', 'order'] })
    },
  })
}

// ── Órdenes: listado ────────────────────────────────────────────────────────

export interface WorkOrderFilters {
  /** 'active' = en curso; 'history' = entregadas y canceladas. */
  scope: 'active' | 'history'
  /** '' = todos; 'none' = sin asignar; o el user_id del técnico. */
  technician: string
}

export interface WorkOrderRow extends WorkOrder {
  asset: Asset | null
}

/** Tope del historial: el taller consulta lo reciente; lo viejo vive en reportes. */
export const WORK_ORDER_HISTORY_LIMIT = 300

/** PostgREST arma el `in.(…)` en la URL: por tandas para no pasarse de largo. */
async function fetchAssetsByIds(ids: string[]): Promise<Map<string, Asset>> {
  const out = new Map<string, Asset>()
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from('assets').select('*').in('id', ids.slice(i, i + 100))
    if (error) throw error
    for (const a of (data ?? []) as Asset[]) out.set(a.id, a)
  }
  return out
}

export function useWorkOrders(filters: WorkOrderFilters) {
  return useQuery({
    queryKey: ['workshop', 'orders', filters],
    queryFn: async (): Promise<WorkOrderRow[]> => {
      const active = filters.scope === 'active'
      let q = supabase.from('work_orders').select('*')
      q = active ? q.not('status', 'in', '(delivered,canceled)') : q.in('status', ['delivered', 'canceled'])
      if (filters.technician === 'none') q = q.is('technician_id', null)
      else if (filters.technician) q = q.eq('technician_id', filters.technician)
      // En curso: las más antiguas primero (son las que más esperan). Historial: lo reciente.
      const { data, error } = await q
        .order('received_at', { ascending: active })
        .limit(active ? 1000 : WORK_ORDER_HISTORY_LIMIT)
      if (error) throw error
      const orders = ((data ?? []) as WorkOrder[]).map(toOrder)
      const assetIds = [...new Set(orders.map((o) => o.asset_id).filter((x): x is string => Boolean(x)))]
      const assets = assetIds.length ? await fetchAssetsByIds(assetIds) : new Map<string, Asset>()
      return orders.map((o) => ({ ...o, asset: o.asset_id ? (assets.get(o.asset_id) ?? null) : null }))
    },
  })
}

// ── Órdenes: detalle ────────────────────────────────────────────────────────

export type WorkOrderCustomer = Pick<
  Customer,
  'id' | 'name' | 'doc_type' | 'doc_number' | 'phone' | 'email' | 'address' | 'credit_limit'
>
export type WorkOrderQuotation = Pick<Quotation, 'id' | 'number' | 'status' | 'total' | 'valid_until'>
export type WorkOrderSale = Pick<Sale, 'id' | 'number' | 'status' | 'total' | 'register_id' | 'created_at'>

export interface WorkOrderDetail {
  order: WorkOrder
  items: WorkOrderItem[]
  advances: WorkOrderAdvance[]
  asset: Asset | null
  customer: WorkOrderCustomer | null
  quotation: WorkOrderQuotation | null
  sale: WorkOrderSale | null
}

export function useWorkOrder(id: string | undefined) {
  return useQuery({
    queryKey: ['workshop', 'order', id],
    enabled: Boolean(id),
    queryFn: async (): Promise<WorkOrderDetail | null> => {
      const { data, error } = await supabase.from('work_orders').select('*').eq('id', id!).maybeSingle()
      if (error) throw error
      if (!data) return null
      const order = toOrder(data as WorkOrder)

      const [itemsRes, advRes, assetRes, custRes, quoteRes, saleRes] = await Promise.all([
        supabase.from('work_order_items').select('*').eq('order_id', order.id).order('line_no'),
        supabase.from('work_order_advances').select('*').eq('order_id', order.id).order('created_at'),
        order.asset_id
          ? supabase.from('assets').select('*').eq('id', order.asset_id).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        supabase
          .from('customers')
          .select('id, name, doc_type, doc_number, phone, email, address, credit_limit')
          .eq('id', order.customer_id)
          .maybeSingle(),
        order.quotation_id
          ? supabase
              .from('quotations')
              .select('id, number, status, total, valid_until')
              .eq('id', order.quotation_id)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        // La RLS de ventas puede esconderla a quien no tiene sales.view_all: en
        // ese caso llega null y la pantalla enseña solo que está facturada.
        order.sale_id
          ? supabase
              .from('sales')
              .select('id, number, status, total, register_id, created_at')
              .eq('id', order.sale_id)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ])
      for (const r of [itemsRes, advRes, assetRes, custRes, quoteRes, saleRes]) if (r.error) throw r.error

      const cust = custRes.data as WorkOrderCustomer | null
      const quote = quoteRes.data as WorkOrderQuotation | null
      const sale = saleRes.data as WorkOrderSale | null
      return {
        order,
        items: ((itemsRes.data ?? []) as WorkOrderItem[]).map((it) => ({ ...it, quantity: Number(it.quantity) })),
        advances: ((advRes.data ?? []) as WorkOrderAdvance[]).map((a) => ({ ...a, amount: Number(a.amount) })),
        asset: (assetRes.data as Asset | null) ?? null,
        customer: cust ? { ...cust, credit_limit: Number(cust.credit_limit) } : null,
        quotation: quote ? { ...quote, total: Number(quote.total) } : null,
        sale: sale ? { ...sale, total: Number(sale.total) } : null,
      }
    },
  })
}

// ── Mutaciones (RPC wo_*) ───────────────────────────────────────────────────

function invalidateWorkshop(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ['workshop'] })
  qc.invalidateQueries({ queryKey: ['dashboard'] })
}

export interface SaveWorkOrderInput {
  id?: string
  branch_id: string
  customer_id: string
  asset_id: string | null
  problem: string
  diagnosis: string | null
  notes: string | null
  mileage_in: number | null
  technician_id: string | null
  promised_at: string | null
  items: { product_id: string; quantity: number; notes: string | null }[]
}

export function useSaveWorkOrder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: SaveWorkOrderInput): Promise<string> => {
      const { data, error } = await supabase.rpc('wo_save', { p_payload: input })
      if (error) throw error
      return data as string
    },
    onSuccess: () => invalidateWorkshop(qc),
  })
}

export function useSetWorkOrderStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: string; status: WorkOrderStatus; reason?: string | null }) => {
      const { error } = await supabase.rpc('wo_set_status', {
        p_id: input.id,
        p_status: input.status,
        p_reason: input.reason ?? null,
      })
      if (error) throw error
    },
    onSuccess: () => invalidateWorkshop(qc),
  })
}

/** Crea (o actualiza, si la orden ya tenía una) la cotización con las líneas de la orden. */
export function useCreateWorkOrderQuotation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (orderId: string): Promise<string> => {
      const { data, error } = await supabase.rpc('wo_create_quotation', { p_id: orderId })
      if (error) throw error
      return data as string
    },
    onSuccess: (quotationId) => {
      invalidateWorkshop(qc)
      qc.invalidateQueries({ queryKey: ['quotations'] })
      qc.invalidateQueries({ queryKey: ['quotation', quotationId] })
    },
  })
}

export interface AddAdvanceInput {
  /** Generado al abrir el formulario y reutilizado en los reintentos. */
  client_uid: string
  order_id: string
  amount: number
  method: 'cash' | 'card' | 'transfer' | 'other'
  register_id: string
  reference: string | null
}

export function useAddWorkOrderAdvance() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: AddAdvanceInput): Promise<string> => {
      const { data, error } = await supabase.rpc('wo_add_advance', { p_payload: input })
      if (error) throw error
      return data as string
    },
    onSuccess: () => {
      invalidateWorkshop(qc)
      // El anticipo entra a caja en el acto: el esperado del turno cambia.
      qc.invalidateQueries({ queryKey: ['cash'] })
    },
  })
}

/** Devuelve un anticipo no aplicado: sale de una caja abierta (wo_refund_advance). */
export function useRefundWorkOrderAdvance() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { advance_id: string; register_id: string; reason: string }) => {
      const { error } = await supabase.rpc('wo_refund_advance', { p_payload: input })
      if (error) throw error
    },
    onSuccess: () => {
      invalidateWorkshop(qc)
      qc.invalidateQueries({ queryKey: ['cash'] })
    },
  })
}

export interface WorkOrderCheckoutInput {
  order_id: string
  client_uid: string
  register_id: string
  ecf_type: string | null
  /** Lo que paga el cliente HOY. Los anticipos los suma wo_checkout solo. */
  payments: SalePaymentPayload[]
}

export interface WorkOrderCheckoutResult extends CreateSaleResult {
  advance_applied: number
}

export function useWorkOrderCheckout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: WorkOrderCheckoutInput): Promise<WorkOrderCheckoutResult> => {
      const { data, error } = await supabase.rpc('wo_checkout', { p_payload: input })
      if (error) throw error
      const r = (data ?? {}) as Partial<WorkOrderCheckoutResult>
      // Igual que en el POS: una respuesta "replayed" no trae `ecf`.
      const ecf = r.ecf as CreateSaleResult['ecf'] | undefined
      return {
        sale_id: String(r.sale_id),
        number: String(r.number ?? ''),
        total: Number(r.total ?? 0),
        change_due: Number(r.change_due ?? 0),
        replayed: Boolean(r.replayed),
        ecf: ecf ? { ...ecf, status: ecf.status as EcfStatus, simulated: Boolean(ecf.simulated) } : null,
        advance_applied: Number(r.advance_applied ?? 0),
      }
    },
    onSuccess: (r) => {
      invalidateAfterSaleChange(qc)
      invalidateWorkshop(qc)
      // La cotización de la orden (si estaba abierta) queda convertida.
      qc.invalidateQueries({ queryKey: ['quotations'] })
      qc.invalidateQueries({ queryKey: ['quotation'] })
      if (r.ecf && !r.replayed) kickEcfQueue(qc)
    },
  })
}
