import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/auth/AuthProvider'
import { invalidateAfterSaleChange } from '@/hooks/sales'
import { kickEcfQueue } from '@/hooks/invoicing'
import type { SalePaymentPayload } from '@/hooks/pos'
import type {
  CreateSaleResult,
  EcfStatus,
  KitchenStatus,
  KitchenTicket,
  RestaurantArea,
  RestaurantOrder,
  RestaurantOrderItem,
  RestaurantTable,
} from '@/types/erp'

/*
 * Restaurante (migración 0022): áreas, mesas, cuentas, comandas y cobro.
 *
 * Áreas y mesas se escriben por la RLS (permiso `restaurant.manage`; sin
 * DELETE: se desactivan). Todo lo demás —abrir cuenta, añadir platos, enviar a
 * cocina, cobrar— son RPC: la cuenta tiene reglas de estado (qué se puede
 * editar, quién anula lo ya enviado) que viven en la base.
 *
 * Todas las claves cuelgan de ['restaurant'] para que cualquier mutación
 * refresque salón, detalle y cocina con una sola invalidación. Salón y cocina
 * se refrescan solos (10 s / 5 s): varios meseros y la cocina trabajan sobre
 * las mismas cuentas a la vez y no hay canal en tiempo real.
 */

const NO_PERMISSION = 'No tienes permiso para hacer este cambio.'

/** Un UPDATE filtrado por la RLS no lanza: responde éxito con cero filas. */
function assertTouched(data: unknown[] | null) {
  if (!data || data.length === 0) throw new Error(NO_PERMISSION)
}

/** PostgREST mete el `in.(…)` en la URL: se parte para no rozar su límite. */
async function selectIn<T>(
  ids: string[],
  build: (chunk: string[]) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await build(ids.slice(i, i + 150))
    if (error) throw error
    out.push(...((data ?? []) as T[]))
  }
  return out
}

const normItem = (it: RestaurantOrderItem): RestaurantOrderItem => ({ ...it, quantity: Number(it.quantity) })

function invalidateRestaurant(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ['restaurant'] })
}

// ── Áreas y mesas ───────────────────────────────────────────────────────────

/** Todas las áreas de la empresa (activas e inactivas); se filtra por sucursal en pantalla. */
export function useRestaurantAreas() {
  return useQuery({
    queryKey: ['restaurant', 'areas'],
    queryFn: async (): Promise<RestaurantArea[]> => {
      const { data, error } = await supabase
        .from('restaurant_areas')
        .select('*')
        .order('sort_order')
        .order('name')
      if (error) throw error
      return (data ?? []) as RestaurantArea[]
    },
  })
}

export function useRestaurantTables() {
  return useQuery({
    queryKey: ['restaurant', 'tables'],
    queryFn: async (): Promise<RestaurantTable[]> => {
      const { data, error } = await supabase
        .from('restaurant_tables')
        .select('*')
        .order('sort_order')
        .order('name')
      if (error) throw error
      return ((data ?? []) as RestaurantTable[]).map((t) => ({ ...t, seats: Number(t.seats) }))
    },
  })
}

export interface AreaInput {
  id?: string
  branch_id: string
  name: string
  sort_order: number
}

export function useSaveArea() {
  const { tenant } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, ...input }: AreaInput) => {
      if (id) {
        const { data, error } = await supabase.from('restaurant_areas').update(input).eq('id', id).select('id')
        if (error) throw error
        assertTouched(data)
        return
      }
      if (!tenant) throw new Error('Sin empresa activa')
      const { error } = await supabase.from('restaurant_areas').insert({ ...input, tenant_id: tenant.id })
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['restaurant', 'areas'] }),
  })
}

export function useSetAreaActive() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { data, error } = await supabase
        .from('restaurant_areas')
        .update({ is_active: active })
        .eq('id', id)
        .select('id')
      if (error) throw error
      assertTouched(data)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['restaurant', 'areas'] }),
  })
}

export interface TableInput {
  id?: string
  branch_id: string
  area_id: string | null
  name: string
  seats: number
  sort_order: number
}

export function useSaveTable() {
  const { tenant } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, ...input }: TableInput) => {
      if (id) {
        const { data, error } = await supabase.from('restaurant_tables').update(input).eq('id', id).select('id')
        if (error) throw error
        assertTouched(data)
        return
      }
      if (!tenant) throw new Error('Sin empresa activa')
      const { error } = await supabase.from('restaurant_tables').insert({ ...input, tenant_id: tenant.id })
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['restaurant', 'tables'] }),
  })
}

export function useSetTableActive() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { data, error } = await supabase
        .from('restaurant_tables')
        .update({ is_active: active })
        .eq('id', id)
        .select('id')
      if (error) throw error
      assertTouched(data)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['restaurant', 'tables'] }),
  })
}

// ── Cuentas ─────────────────────────────────────────────────────────────────

export interface OpenOrder extends RestaurantOrder {
  /** Todas sus líneas (también cobradas y anuladas): la pantalla decide qué mostrar. */
  items: RestaurantOrderItem[]
}

/** Cuentas abiertas de una sucursal con sus líneas (el salón). */
export function useOpenOrders(branchId: string | undefined) {
  return useQuery({
    queryKey: ['restaurant', 'orders', branchId],
    enabled: Boolean(branchId),
    refetchInterval: 10_000,
    queryFn: async (): Promise<OpenOrder[]> => {
      const { data, error } = await supabase
        .from('restaurant_orders')
        .select('*')
        .eq('branch_id', branchId!)
        .eq('status', 'open')
        .order('opened_at')
      if (error) throw error
      const orders = (data ?? []) as RestaurantOrder[]
      if (!orders.length) return []
      const items = await selectIn<RestaurantOrderItem>(
        orders.map((o) => o.id),
        (chunk) => supabase.from('restaurant_order_items').select('*').in('order_id', chunk).order('created_at'),
      )
      const byOrder = new Map<string, RestaurantOrderItem[]>()
      for (const it of items.map(normItem)) byOrder.set(it.order_id, [...(byOrder.get(it.order_id) ?? []), it])
      return orders.map((o) => ({ ...o, guests: Number(o.guests), items: byOrder.get(o.id) ?? [] }))
    },
  })
}

export interface RestaurantOrderDetail {
  order: RestaurantOrder
  items: RestaurantOrderItem[]
  tickets: KitchenTicket[]
}

export async function fetchRestaurantOrder(id: string): Promise<RestaurantOrderDetail> {
  const [oRes, itRes, tkRes] = await Promise.all([
    supabase.from('restaurant_orders').select('*').eq('id', id).maybeSingle(),
    supabase.from('restaurant_order_items').select('*').eq('order_id', id).order('created_at'),
    supabase.from('kitchen_tickets').select('*').eq('order_id', id).order('created_at'),
  ])
  if (oRes.error) throw oRes.error
  if (itRes.error) throw itRes.error
  if (tkRes.error) throw tkRes.error
  if (!oRes.data) throw new Error('Cuenta no encontrada')
  const order = oRes.data as RestaurantOrder
  return {
    order: { ...order, guests: Number(order.guests) },
    items: ((itRes.data ?? []) as RestaurantOrderItem[]).map(normItem),
    tickets: (tkRes.data ?? []) as KitchenTicket[],
  }
}

const orderKey = (id: string) => ['restaurant', 'order', id] as const

/** Detalle de una cuenta (abierta o ya cerrada: tras cobrar se sigue viendo). */
export function useRestaurantOrder(id: string | null | undefined) {
  return useQuery({
    queryKey: orderKey(id ?? ''),
    enabled: Boolean(id),
    refetchInterval: 10_000,
    queryFn: () => fetchRestaurantOrder(id!),
  })
}

/**
 * Pide el detalle FRESCO fuera de render: tras enviar a cocina hace falta saber
 * qué líneas quedaron en el ticket nuevo para imprimir la comanda.
 */
export function useRestaurantOrderFetcher() {
  const qc = useQueryClient()
  return useCallback(
    (id: string) => qc.fetchQuery({ queryKey: orderKey(id), queryFn: () => fetchRestaurantOrder(id), staleTime: 0 }),
    [qc],
  )
}

// ── Cocina ──────────────────────────────────────────────────────────────────

export type KitchenOrderInfo = Pick<RestaurantOrder, 'id' | 'number' | 'label' | 'table_id' | 'branch_id' | 'status' | 'guests'>

export interface KitchenQueueItem extends RestaurantOrderItem {
  order: KitchenOrderInfo
  ticket: KitchenTicket | null
}

const KITCHEN_ACTIVE: KitchenStatus[] = ['sent', 'preparing', 'ready']

/**
 * Lo que la cocina tiene entre manos: líneas enviadas, en preparación o listas.
 * Se parte de las LÍNEAS y no de las cuentas abiertas a propósito: una cuenta
 * para llevar que se cobró por adelantado ya está cerrada y sus platos aún hay
 * que cocinarlos. `branchId` vacío = todas las sucursales.
 */
export function useKitchenQueue(branchId: string) {
  return useQuery({
    queryKey: ['restaurant', 'kitchen', branchId],
    refetchInterval: 5_000,
    queryFn: async (): Promise<KitchenQueueItem[]> => {
      const { data, error } = await supabase
        .from('restaurant_order_items')
        .select('*')
        .in('kitchen_status', KITCHEN_ACTIVE)
        .order('sent_at', { ascending: true })
        .limit(1000)
      if (error) throw error
      const items = ((data ?? []) as RestaurantOrderItem[]).map(normItem)
      if (!items.length) return []
      const orderIds = [...new Set(items.map((i) => i.order_id))]
      const ticketIds = [...new Set(items.map((i) => i.ticket_id).filter(Boolean) as string[])]
      const [orders, tickets] = await Promise.all([
        selectIn<KitchenOrderInfo>(orderIds, (chunk) => {
          let q = supabase
            .from('restaurant_orders')
            .select('id, number, label, table_id, branch_id, status, guests')
            .in('id', chunk)
          if (branchId) q = q.eq('branch_id', branchId)
          return q
        }),
        selectIn<KitchenTicket>(ticketIds, (chunk) => supabase.from('kitchen_tickets').select('*').in('id', chunk)),
      ])
      const orderMap = new Map(orders.map((o) => [o.id, o]))
      const ticketMap = new Map(tickets.map((t) => [t.id, t]))
      const out: KitchenQueueItem[] = []
      for (const it of items) {
        const order = orderMap.get(it.order_id)
        // Sin cuenta = de otra sucursal (filtrada arriba): no es de esta cocina.
        if (!order || order.status === 'canceled') continue
        out.push({ ...it, order, ticket: it.ticket_id ? (ticketMap.get(it.ticket_id) ?? null) : null })
      }
      return out
    },
  })
}

export function useSetKitchenStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ itemId, status }: { itemId: string; status: KitchenStatus }) => {
      const { error } = await supabase.rpc('rest_set_kitchen_status', { p_item: itemId, p_status: status })
      if (error) throw error
    },
    // Optimista en la pantalla de cocina: con las manos ocupadas, el toque debe
    // verse al instante y no 5 s después. Si la base lo rechaza, se refresca.
    onMutate: async ({ itemId, status }) => {
      await qc.cancelQueries({ queryKey: ['restaurant', 'kitchen'] })
      qc.setQueriesData<KitchenQueueItem[]>({ queryKey: ['restaurant', 'kitchen'] }, (old) =>
        old
          ?.map((it) => (it.id === itemId ? { ...it, kitchen_status: status } : it))
          .filter((it) => KITCHEN_ACTIVE.includes(it.kitchen_status)),
      )
    },
    onSettled: () => invalidateRestaurant(qc),
  })
}

// ── RPC de la cuenta ────────────────────────────────────────────────────────

export interface OpenOrderInput {
  branchId: string
  tableId: string | null
  guests: number
  label?: string | null
  notes?: string | null
}

export function useOpenOrder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: OpenOrderInput): Promise<string> => {
      const { data, error } = await supabase.rpc('rest_open_order', {
        p_branch: input.branchId,
        p_table: input.tableId,
        p_guests: input.guests,
        p_label: input.label ?? null,
        p_notes: input.notes ?? null,
      })
      if (error) throw error
      return String(data)
    },
    onSuccess: () => invalidateRestaurant(qc),
  })
}

export interface AddItemPayload {
  product_id: string
  quantity: number
  notes?: string | null
}

export function useAddOrderItems() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ orderId, items }: { orderId: string; items: AddItemPayload[] }) => {
      const { error } = await supabase.rpc('rest_add_items', { p_order: orderId, p_items: items })
      if (error) throw error
    },
    onSuccess: () => invalidateRestaurant(qc),
  })
}

export function useUpdateOrderItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ itemId, quantity, notes }: { itemId: string; quantity: number; notes: string | null }) => {
      const { error } = await supabase.rpc('rest_update_item', { p_item: itemId, p_quantity: quantity, p_notes: notes })
      if (error) throw error
    },
    onSuccess: () => invalidateRestaurant(qc),
  })
}

export function useCancelOrderItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ itemId, reason }: { itemId: string; reason?: string | null }) => {
      const { error } = await supabase.rpc('rest_cancel_item', { p_item: itemId, p_reason: reason ?? null })
      if (error) throw error
    },
    onSuccess: () => invalidateRestaurant(qc),
  })
}

export interface SendToKitchenResult {
  ticket_id: string
  number: string
  items: number
}

export function useSendToKitchen() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (orderId: string): Promise<SendToKitchenResult> => {
      const { data, error } = await supabase.rpc('rest_send_to_kitchen', { p_order: orderId })
      if (error) throw error
      const r = (data ?? {}) as Record<string, unknown>
      return { ticket_id: String(r.ticket_id), number: String(r.number ?? ''), items: Number(r.items ?? 0) }
    },
    onSuccess: () => invalidateRestaurant(qc),
  })
}

export function useMoveOrder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ orderId, tableId }: { orderId: string; tableId: string | null }) => {
      const { error } = await supabase.rpc('rest_move_order', { p_order: orderId, p_table: tableId })
      if (error) throw error
    },
    onSuccess: () => invalidateRestaurant(qc),
  })
}

export function useMergeOrders() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ fromId, intoId }: { fromId: string; intoId: string }) => {
      const { error } = await supabase.rpc('rest_merge_orders', { p_from: fromId, p_into: intoId })
      if (error) throw error
    },
    onSuccess: () => invalidateRestaurant(qc),
  })
}

export function useCancelOrder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ orderId, reason }: { orderId: string; reason: string }) => {
      const { error } = await supabase.rpc('rest_cancel_order', { p_order: orderId, p_reason: reason })
      if (error) throw error
    },
    onSuccess: () => invalidateRestaurant(qc),
  })
}

// ── Cobro ───────────────────────────────────────────────────────────────────

export interface RestCheckoutPayload {
  order_id: string
  /** Uno por intento de cobro y el MISMO en cada reintento: la base no cobra dos veces. */
  client_uid: string
  register_id: string
  customer_id?: string
  ecf_type?: string
  global_discount?: number
  /** 10 % de ley: la base lo calcula sobre el subtotal sin ITBIS. */
  service_charge: boolean
  payments: SalePaymentPayload[]
  /** Sin `lines` se cobra todo lo pendiente; con `lines`, se divide la cuenta. */
  lines?: { order_item_id: string; quantity: number }[]
}

export interface RestCheckoutResult extends CreateSaleResult {
  /** null cuando es un reintento (`replayed`): la base no lo devuelve en ese camino. */
  order_closed: boolean | null
}

export function useRestaurantCheckout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: RestCheckoutPayload): Promise<RestCheckoutResult> => {
      const { data, error } = await supabase.rpc('rest_checkout', { p_payload: payload })
      if (error) throw error
      const r = (data ?? {}) as Partial<CreateSaleResult> & { order_closed?: boolean | null }
      const ecf = r.ecf as CreateSaleResult['ecf'] | undefined
      return {
        sale_id: String(r.sale_id),
        number: String(r.number ?? ''),
        total: Number(r.total ?? 0),
        change_due: Number(r.change_due ?? 0),
        replayed: Boolean(r.replayed),
        ecf: ecf ? { ...ecf, status: ecf.status as EcfStatus, simulated: Boolean(ecf.simulated) } : null,
        order_closed: typeof r.order_closed === 'boolean' ? r.order_closed : null,
      }
    },
    onSuccess: (r) => {
      invalidateRestaurant(qc)
      invalidateAfterSaleChange(qc)
      if (r.ecf && !r.replayed) kickEcfQueue(qc)
    },
  })
}
