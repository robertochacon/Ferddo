import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { uploadFile } from '@/lib/storage'
import { useAuth } from '@/auth/AuthProvider'
import type { PaymentMethod, Purchase, PurchaseItem, PurchaseStatus } from '@/types/erp'

/*
 * Compras en dos pasos: save_purchase() guarda borrador u orden (la base
 * recalcula importes línea a línea) y receive_purchase() mete la mercancía,
 * recalcula el costo promedio y crea la cuenta por pagar, una sola vez y bajo
 * candado. El cliente nunca manda totales: solo productos, cantidades y costos.
 */

const toPurchase = (p: Purchase): Purchase => ({
  ...p,
  subtotal: Number(p.subtotal),
  discount_total: Number(p.discount_total),
  tax_total: Number(p.tax_total),
  total: Number(p.total),
})

/** Compras cuya fecha de orden cae en el rango (inclusive), la más reciente primero. */
export function usePurchases(from: string, to: string) {
  return useQuery({
    queryKey: ['purchases', 'list', from, to],
    queryFn: async (): Promise<Purchase[]> => {
      const { data, error } = await supabase
        .from('purchases')
        .select('*')
        .gte('order_date', from)
        .lte('order_date', to)
        .order('order_date', { ascending: false })
        .order('seq', { ascending: false })
        .limit(1000)
      if (error) throw error
      return ((data ?? []) as Purchase[]).map(toPurchase)
    },
  })
}

/** Historial de compras de un proveedor (para su ficha). */
export function useSupplierPurchases(supplierId: string | undefined) {
  return useQuery({
    queryKey: ['purchases', 'supplier', supplierId],
    enabled: Boolean(supplierId),
    queryFn: async (): Promise<Purchase[]> => {
      const { data, error } = await supabase
        .from('purchases')
        .select('*')
        .eq('supplier_id', supplierId!)
        .order('order_date', { ascending: false })
        .limit(200)
      if (error) throw error
      return ((data ?? []) as Purchase[]).map(toPurchase)
    },
  })
}

export interface PurchaseDetail {
  purchase: Purchase
  items: PurchaseItem[]
}

export function usePurchase(id: string | undefined) {
  return useQuery({
    queryKey: ['purchase', id],
    enabled: Boolean(id),
    queryFn: async (): Promise<PurchaseDetail | null> => {
      const { data, error } = await supabase.from('purchases').select('*').eq('id', id!).maybeSingle()
      if (error) throw error
      if (!data) return null
      const { data: items, error: itemsError } = await supabase
        .from('purchase_items')
        .select('*')
        .eq('purchase_id', id!)
        .order('line_no')
      if (itemsError) throw itemsError
      return {
        purchase: toPurchase(data as Purchase),
        items: ((items ?? []) as PurchaseItem[]).map((it) => ({
          ...it,
          quantity: Number(it.quantity),
          unit_cost: Number(it.unit_cost),
          discount: Number(it.discount),
          tax_rate: Number(it.tax_rate),
          subtotal: Number(it.subtotal),
          tax_amount: Number(it.tax_amount),
          total: Number(it.total),
        })),
      }
    },
  })
}

export interface SavePurchaseInput {
  id?: string
  branch_id: string
  supplier_id: string
  status: Extract<PurchaseStatus, 'draft' | 'ordered'>
  supplier_invoice?: string | null
  supplier_ncf?: string | null
  order_date?: string | null
  due_date?: string | null
  notes?: string | null
  attachment_path?: string | null
  items: { product_id: string; quantity: number; unit_cost: number; discount?: number; tax_rate?: number }[]
}

export function useSavePurchase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: SavePurchaseInput): Promise<string> => {
      const { data, error } = await supabase.rpc('save_purchase', { p_payload: input })
      if (error) throw error
      return data as string
    },
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: ['purchases'] })
      qc.invalidateQueries({ queryKey: ['purchase', id] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export interface ReceivePurchaseInput {
  id: string
  /** Pago en el acto (opcional). Sin él, la compra queda entera en cuentas por pagar. */
  payment?: {
    client_uid: string
    amount: number
    method: PaymentMethod
    register_id?: string | null
    reference?: string | null
  } | null
}

export function useReceivePurchase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, payment }: ReceivePurchaseInput) => {
      const { data, error } = await supabase.rpc('receive_purchase', {
        p_id: id,
        p_payment: payment ?? null,
      })
      if (error) throw error
      return data as { purchase_id: string; payable_id: string | null; payment_id: string | null }
    },
    onSuccess: (_res, { id }) => {
      // Recibir mueve existencias, costos (productos), la deuda y, si se pagó
      // en efectivo, la caja.
      for (const key of [
        ['purchases'],
        ['purchase', id],
        ['payables'],
        ['supplier-balances'],
        ['supplier-payments'],
        ['stock'],
        ['products'],
        ['inventory'],
        ['cash'],
        ['dashboard'],
      ]) {
        qc.invalidateQueries({ queryKey: key })
      }
    },
  })
}

export function useCancelPurchase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase.rpc('cancel_purchase', { p_id: id, p_reason: reason })
      if (error) throw error
      return id
    },
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: ['purchases'] })
      qc.invalidateQueries({ queryKey: ['purchase', id] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

// ── Adjuntos (factura del proveedor, recibo del gasto) ──────────────────────

export type AttachmentFolder = 'purchases' | 'expenses'

/**
 * Sube el adjunto al bucket PRIVADO `files`, bajo `<tenant_id>/<carpeta>/`:
 * el primer segmento de la ruta es lo que aísla un negocio de otro en las
 * políticas de Storage. Devuelve la ruta, que es lo que se guarda en la fila.
 */
export function useUploadAttachment(folder: AttachmentFolder) {
  const { tenant } = useAuth()
  return useMutation({
    mutationFn: async (file: File): Promise<string> => {
      if (!tenant) throw new Error('No hay una empresa activa')
      if (file.size > 10 * 1024 * 1024) throw new Error('El archivo pesa más de 10 MB')
      const { path } = await uploadFile('files', tenant.id, file, `${folder}/`)
      return path
    },
  })
}

/**
 * Abre un adjunto con una URL firmada de corta vida: el bucket es privado y
 * una URL pública permanente dejaría la factura al alcance de cualquiera que
 * tuviera el enlace.
 *
 * La pestaña se abre ANTES de pedir la URL (en el mismo clic): Safari y otros
 * bloquean un window.open que llega después de un await.
 */
export function useOpenAttachment() {
  return useMutation({
    mutationFn: async (path: string) => {
      const win = window.open('', '_blank')
      try {
        const { data, error } = await supabase.storage.from('files').createSignedUrl(path, 300)
        if (error) throw error
        if (win) win.location.href = data.signedUrl
        else window.location.href = data.signedUrl
      } catch (err) {
        win?.close()
        throw err
      }
    },
  })
}
