import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { uploadFile } from '@/lib/storage'
import { useAuth } from '@/auth/AuthProvider'
import type { Category, Product } from '@/types/erp'

/*
 * Escrituras del catálogo (productos, servicios y categorías). Las lecturas
 * viven en core.ts (`useProducts`, `useCategories`, `useTaxes`) porque las
 * comparten el POS, compras y cotizaciones; aquí solo lo que cambia el catálogo.
 *
 * Reglas que pone la base y que la UI solo refleja:
 *   · insertar/editar exige `products.manage` (RLS de 0014);
 *   · cambiar `price` exige además `prices.manage` (trigger products_guard);
 *   · un servicio nunca lleva existencia (check de la tabla);
 *   · los productos no se borran (los referencian ventas y kardex): se desactivan.
 */

/** Campos que el cliente puede escribir. tenant_id, autor y fechas los pone la base o el hook. */
export type ProductInput = Omit<Product, 'id' | 'tenant_id' | 'created_by' | 'created_at' | 'updated_at'>

/**
 * Los índices únicos de 0014 (SKU, código de barras y código interno por
 * empresa) devuelven un 23505 con el nombre del índice; se traduce a una frase
 * que diga QUÉ campo choca.
 */
const UNIQUE_FIELD: Record<string, string> = {
  products_sku_idx: 'Ya existe otro producto con ese SKU.',
  products_barcode_idx: 'Ya existe otro producto con ese código de barras.',
  products_code_idx: 'Ya existe otro producto con ese código interno.',
}

function translateProductError(error: unknown): unknown {
  const e = error as { code?: string; message?: string; details?: string }
  if (e?.code !== '23505') return error
  const text = `${e.message ?? ''} ${e.details ?? ''}`
  const hit = Object.keys(UNIQUE_FIELD).find((idx) => text.includes(idx))
  return new Error(hit ? UNIQUE_FIELD[hit] : 'Ya existe otro producto con alguno de esos códigos.')
}

/** Todo lo que deja desfasado un cambio de catálogo: listados, existencias y el panel. */
function invalidateCatalog(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ['products'] })
  void qc.invalidateQueries({ queryKey: ['stock'] })
  void qc.invalidateQueries({ queryKey: ['dashboard'] })
}

export interface CreateProductResult {
  product: Product
  /**
   * El producto ya se creó, pero la existencia inicial falló (sin permiso de
   * inventario, sucursal sin acceso…). Se devuelve en vez de lanzar: lanzar
   * haría creer que no se guardó nada y un segundo intento lo duplicaría.
   */
  stockError: unknown | null
}

export function useCreateProduct() {
  const qc = useQueryClient()
  const { tenant } = useAuth()
  return useMutation({
    mutationFn: async (input: {
      product: ProductInput
      initialStock?: { branchId: string; quantity: number } | null
    }): Promise<CreateProductResult> => {
      if (!tenant) throw new Error('Sin empresa activa')
      const { data, error } = await supabase
        .from('products')
        .insert({ ...input.product, tenant_id: tenant.id })
        .select()
        .single()
      if (error) throw translateProductError(error)
      const product = data as Product

      let stockError: unknown | null = null
      const initial = input.initialStock
      if (initial && initial.quantity > 0 && product.track_stock) {
        // Va por inventory_adjust con p_initial: la existencia nunca se escribe
        // a mano, siempre nace de un movimiento del kardex.
        const { error: adjError } = await supabase.rpc('inventory_adjust', {
          p_branch: initial.branchId,
          p_lines: [{ product_id: product.id, quantity: initial.quantity }],
          p_reason: 'Existencia inicial',
          p_initial: true,
        })
        if (adjError) stockError = adjError
      }
      return { product, stockError }
    },
    onSuccess: (res) => {
      invalidateCatalog(qc)
      if (!res.stockError) void qc.invalidateQueries({ queryKey: ['inventory'] })
    },
  })
}

export function useUpdateProduct() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<ProductInput> }): Promise<Product> => {
      const { data, error } = await supabase.from('products').update(patch).eq('id', id).select()
      if (error) throw translateProductError(error)
      // Sin permiso, PostgREST no da error: la RLS esconde la fila y el UPDATE
      // afecta a cero. Se convierte en error para no anunciar un "guardado" falso.
      const row = (data ?? [])[0] as Product | undefined
      if (!row) throw new Error('No se pudo guardar: no tienes permiso o el producto ya no existe.')
      return row
    },
    onSuccess: () => invalidateCatalog(qc),
  })
}

// ── Categorías ──────────────────────────────────────────────────────────────

export function useCreateCategory() {
  const qc = useQueryClient()
  const { tenant } = useAuth()
  return useMutation({
    mutationFn: async (name: string): Promise<Category> => {
      if (!tenant) throw new Error('Sin empresa activa')
      const { data, error } = await supabase
        .from('categories')
        .insert({ tenant_id: tenant.id, name: name.trim() })
        .select()
        .single()
      if (error) {
        // Índice único (tenant_id, lower(name)): se traduce el choque a algo legible.
        if ((error as { code?: string }).code === '23505') throw new Error('Ya existe una categoría con ese nombre.')
        throw error
      }
      return data as Category
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['categories'] }),
  })
}

export function useUpdateCategory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, ...patch }: { id: string; name?: string; is_active?: boolean }) => {
      const { data, error } = await supabase.from('categories').update(patch).eq('id', id).select('id')
      if (error) {
        if ((error as { code?: string }).code === '23505') throw new Error('Ya existe una categoría con ese nombre.')
        throw error
      }
      if (!data?.length) throw new Error('No se pudo guardar: no tienes permiso o la categoría ya no existe.')
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['categories'] })
      void qc.invalidateQueries({ queryKey: ['inventory', 'valuation'] })
    },
  })
}

export function useDeleteCategory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.from('categories').delete().eq('id', id).select('id')
      if (error) throw error
      if (!data?.length) throw new Error('No se pudo eliminar: no tienes permiso o la categoría ya no existe.')
    },
    // La FK es `on delete set null (category_id)`: los productos quedan "sin
    // categoría", así que el catálogo y la valoración por categoría cambian.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['categories'] })
      void qc.invalidateQueries({ queryKey: ['products'] })
      void qc.invalidateQueries({ queryKey: ['inventory', 'valuation'] })
    },
  })
}

// ── Importación masiva ──────────────────────────────────────────────────────

/** Columnas que entiende `import_products()` (0014). El orden es el de la plantilla. */
export const IMPORT_COLUMNS = [
  'name',
  'sku',
  'barcode',
  'code',
  'description',
  'category',
  'brand',
  'unit',
  'cost',
  'price',
  'tax_code',
  'kind',
  'track_stock',
  'min_stock',
  'stock',
] as const
export type ImportColumn = (typeof IMPORT_COLUMNS)[number]
export type ImportRow = Partial<Record<ImportColumn, string>>

export interface ImportResult {
  inserted: number
  updated: number
  /** `row` es 1-based sobre las filas enviadas (sin contar el encabezado). */
  errors: { row: number; error: string }[]
}

export function useImportProducts() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (rows: ImportRow[]): Promise<ImportResult> => {
      const { data, error } = await supabase.rpc('import_products', { p_rows: rows })
      if (error) throw error
      // jsonb: los enteros pueden llegar como string; se normalizan aquí.
      const raw = (data ?? {}) as { inserted?: unknown; updated?: unknown; errors?: { row: unknown; error: unknown }[] }
      return {
        inserted: Number(raw.inserted ?? 0),
        updated: Number(raw.updated ?? 0),
        errors: (raw.errors ?? []).map((e) => ({ row: Number(e.row), error: String(e.error) })),
      }
    },
    // La importación crea categorías al vuelo y puede dar existencia inicial.
    onSuccess: () => {
      invalidateCatalog(qc)
      void qc.invalidateQueries({ queryKey: ['categories'] })
      void qc.invalidateQueries({ queryKey: ['inventory'] })
    },
  })
}

// ── Imagen del producto ─────────────────────────────────────────────────────

const MAX_IMAGE_BYTES = 2 * 1024 * 1024

/**
 * Sube la foto al bucket público `logos`, carpeta `<tenant>/products/`. Público
 * porque se pinta en el POS y en cotizaciones compartidas; la política de
 * Storage exige que la primera carpeta sea el id de la empresa.
 * Devuelve la URL pública, que es lo que se guarda en `products.image_url`.
 */
export function useUploadProductImage() {
  const { tenant } = useAuth()
  return useMutation({
    mutationFn: async (file: File): Promise<string> => {
      if (!tenant) throw new Error('Sin empresa activa')
      if (!file.type.startsWith('image/')) throw new Error('El archivo debe ser una imagen.')
      if (file.size > MAX_IMAGE_BYTES) throw new Error('La imagen no puede pasar de 2 MB.')
      const { publicUrl } = await uploadFile('logos', tenant.id, file, 'products/')
      if (!publicUrl) throw new Error('No se obtuvo la URL de la imagen.')
      return publicUrl
    },
  })
}
