import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/auth/AuthProvider'
import type { Customer, Product } from '@/types/erp'

/*
 * Listas de precios (0023). Una lista se asigna al CLIENTE y `price_lines()`
 * toma de ella el precio base de cada producto que esté en la lista; el resto
 * sigue al precio del catálogo. Aquí solo se gestionan las listas y se leen
 * para la VISTA PREVIA (POS, cotizaciones): el precio que vale lo pone la base
 * al guardar, con la lista del cliente, sin que el cliente la mande.
 *
 * Reglas que pone la base y que la UI solo refleja:
 *   · crear/editar listas y sus precios exige `prices.manage` (RLS);
 *   · las listas no se borran (las referencian clientes): se desactivan, y una
 *     lista inactiva deja de aplicarse — el cliente vuelve al catálogo;
 *   · asignar una lista a un cliente también exige `prices.manage` (trigger).
 */

export interface PriceList {
  id: string
  tenant_id: string
  name: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface PriceListItem {
  tenant_id: string
  price_list_id: string
  product_id: string
  price: number
  updated_at: string
}

/**
 * `customers.price_list_id` llegó en 0023 y `Customer` (types/erp.ts) aún no
 * lo declara. El SELECT de clientes es `*`, así que el dato viene igual; esto
 * lo lee sin tocar el tipo compartido.
 */
export type CustomerWithPriceList = Customer & { price_list_id?: string | null }

export function customerPriceListId(c: Customer | null | undefined): string | null {
  return (c as CustomerWithPriceList | null | undefined)?.price_list_id ?? null
}

/** Un 23505 aquí solo puede ser el índice (tenant_id, lower(name)). */
function translateListError(error: unknown): unknown {
  if ((error as { code?: string })?.code === '23505') return new Error('Ya existe una lista con ese nombre.')
  return error
}

/** Precio redondeado al centavo, como numeric(14,2) en la base. */
const toCents = (n: number) => Math.round(n * 100) / 100

export function usePriceLists() {
  return useQuery({
    queryKey: ['price-lists'],
    queryFn: async (): Promise<PriceList[]> => {
      const { data, error } = await supabase.from('price_lists').select('*').order('name')
      if (error) throw error
      return (data ?? []) as PriceList[]
    },
  })
}

/**
 * Precios de una lista. Paginado igual que el catálogo (`fetchAll` en core.ts):
 * una lista "mayorista" puede cubrir el catálogo entero y PostgREST corta en 1000.
 */
export function usePriceListItems(listId: string | null | undefined) {
  return useQuery({
    queryKey: ['price-lists', listId, 'items'],
    enabled: Boolean(listId),
    queryFn: async (): Promise<PriceListItem[]> => {
      const PAGE = 1000
      const out: PriceListItem[] = []
      for (let page = 0; page < 20; page++) {
        const { data, error } = await supabase
          .from('price_list_items')
          .select('*')
          .eq('price_list_id', listId!)
          .order('product_id')
          .range(page * PAGE, page * PAGE + PAGE - 1)
        if (error) throw error
        const rows = (data ?? []) as PriceListItem[]
        out.push(...rows.map((r) => ({ ...r, price: Number(r.price) })))
        if (rows.length < PAGE) break
      }
      return out
    },
  })
}

export interface ListPrices {
  /** product_id → precio de lista. null = el cliente no tiene lista aplicable. */
  prices: Map<string, number> | null
  list: PriceList | null
  /** true mientras falta algún dato para saber el precio: la vista previa espera. */
  isLoading: boolean
}

/**
 * Precios que la base aplicará a este cliente. Replica la condición de
 * `price_lines()`: la lista solo cuenta si está ACTIVA; inactiva, el cliente
 * compra a precio de catálogo aunque la tenga asignada.
 */
export function useListPrices(priceListId: string | null | undefined): ListPrices {
  const lists = usePriceLists()
  const list = priceListId ? ((lists.data ?? []).find((l) => l.id === priceListId) ?? null) : null
  const activeId = list?.is_active ? list.id : null
  const items = usePriceListItems(activeId)
  const prices = useMemo(
    () => (activeId && items.data ? new Map(items.data.map((it) => [it.product_id, it.price])) : null),
    [activeId, items.data],
  )
  return {
    prices,
    list,
    isLoading: Boolean(priceListId) && (lists.isLoading || (Boolean(activeId) && items.isLoading)),
  }
}

/** Lo que deja desfasado tocar una lista: sus precios y la ficha de los clientes que la usan. */
function invalidateLists(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ['price-lists'] })
  void qc.invalidateQueries({ queryKey: ['customers'] })
}

export function useCreatePriceList() {
  const qc = useQueryClient()
  const { tenant } = useAuth()
  return useMutation({
    mutationFn: async (name: string): Promise<PriceList> => {
      if (!tenant) throw new Error('Sin empresa activa')
      const { data, error } = await supabase
        .from('price_lists')
        .insert({ tenant_id: tenant.id, name: name.trim() })
        .select()
        .single()
      if (error) throw translateListError(error)
      return data as PriceList
    },
    onSuccess: () => invalidateLists(qc),
  })
}

export function useUpdatePriceList() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, ...patch }: { id: string; name?: string; is_active?: boolean }) => {
      const clean = patch.name !== undefined ? { ...patch, name: patch.name.trim() } : patch
      const { data, error } = await supabase.from('price_lists').update(clean).eq('id', id).select('id')
      if (error) throw translateListError(error)
      // Sin permiso la RLS esconde la fila y el UPDATE afecta a cero sin error.
      if (!data?.length) throw new Error('No se pudo guardar: no tienes permiso o la lista ya no existe.')
    },
    onSuccess: () => invalidateLists(qc),
  })
}

export interface PriceRow {
  product_id: string
  price: number
}

/** UPSERT por la clave (price_list_id, product_id), en tandas para no topar con el tamaño del cuerpo. */
async function upsertRows(tenantId: string, listId: string, rows: PriceRow[]): Promise<number> {
  const CHUNK = 500
  let done = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK).map((r) => ({
      tenant_id: tenantId,
      price_list_id: listId,
      product_id: r.product_id,
      price: toCents(r.price),
    }))
    const { data, error } = await supabase
      .from('price_list_items')
      .upsert(slice, { onConflict: 'price_list_id,product_id' })
      .select('product_id')
    if (error) throw error
    if ((data ?? []).length < slice.length) {
      throw new Error('No se pudieron guardar los precios: no tienes permiso para gestionar listas de precios.')
    }
    done += slice.length
  }
  return done
}

export function useUpsertPriceListItems() {
  const qc = useQueryClient()
  const { tenant } = useAuth()
  return useMutation({
    mutationFn: async ({ listId, rows }: { listId: string; rows: PriceRow[] }): Promise<number> => {
      if (!tenant) throw new Error('Sin empresa activa')
      if (rows.some((r) => !Number.isFinite(r.price) || r.price < 0)) throw new Error('Precio inválido')
      return upsertRows(tenant.id, listId, rows)
    },
    onSuccess: () => invalidateLists(qc),
  })
}

export function useRemovePriceListItems() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ listId, productIds }: { listId: string; productIds: string[] }) => {
      const CHUNK = 200
      for (let i = 0; i < productIds.length; i += CHUNK) {
        const { error } = await supabase
          .from('price_list_items')
          .delete()
          .eq('price_list_id', listId)
          .in('product_id', productIds.slice(i, i + CHUNK))
        if (error) throw error
      }
    },
    onSuccess: () => invalidateLists(qc),
  })
}

export interface BulkPriceInput {
  listId: string
  /**
   * Ajuste sobre el precio de catálogo, en %: −10 = catálogo menos 10 %,
   * 5 = catálogo más 5 %. Se calcula en el cliente y se sube como precios
   * fijos: la lista guarda importes, no reglas, así que un cambio posterior del
   * catálogo NO arrastra la lista (hay que volver a aplicar el ajuste).
   */
  percent: number
  /** null = todo el catálogo activo. */
  categoryId: string | null
  products: Product[]
}

/**
 * Productos a los que se aplica un ajuste masivo: activos, de la categoría
 * pedida y que se venden directamente (un producto con variantes no se vende:
 * se vende la variante, así que ponerle precio de lista no serviría de nada).
 */
export function bulkTargets(products: Product[], categoryId: string | null): Product[] {
  const parents = new Set(products.map((p) => p.parent_id).filter(Boolean) as string[])
  return products.filter(
    (p) => p.is_active && !parents.has(p.id) && (categoryId === null || p.category_id === categoryId),
  )
}

export function bulkPrice(catalogPrice: number, percent: number): number {
  return Math.max(0, toCents(Number(catalogPrice) * (1 + percent / 100)))
}

export function useBulkSetPriceList() {
  const qc = useQueryClient()
  const { tenant } = useAuth()
  return useMutation({
    mutationFn: async ({ listId, percent, categoryId, products }: BulkPriceInput): Promise<number> => {
      if (!tenant) throw new Error('Sin empresa activa')
      if (!Number.isFinite(percent) || percent <= -100 || percent > 1000) throw new Error('Porcentaje inválido')
      const rows = bulkTargets(products, categoryId).map((p) => ({
        product_id: p.id,
        price: bulkPrice(p.price, percent),
      }))
      if (rows.length === 0) throw new Error('No hay productos activos en ese grupo.')
      return upsertRows(tenant.id, listId, rows)
    },
    onSuccess: () => invalidateLists(qc),
  })
}
