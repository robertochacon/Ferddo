import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { uploadFile } from '@/lib/storage'
import { useAuth } from '@/auth/AuthProvider'
import { PURCHASE_STATUS, type Tone } from '@/lib/labels'
import type { Payable, PaymentMethod, Purchase, PurchaseItem, PurchaseStatus } from '@/types/erp'

/*
 * Compras en dos pasos: save_purchase() guarda borrador u orden (la base
 * recalcula importes línea a línea) y receive_purchase() mete la mercancía,
 * recalcula el costo promedio y crea la cuenta por pagar, bajo candado. El
 * cliente nunca manda totales: solo productos, cantidades y costos.
 *
 * Recepción parcial (0023): cada llamada a receive_purchase() es una
 * RECEPCIÓN (purchase_receipts, número RE-…) con su propia entrada de
 * inventario y su propia cuenta por pagar por el valor recibido. La compra
 * sigue 'ordered' hasta que llega todo; con algo recibido ya no se edita ni se
 * cancela (lo impide la base).
 */

/** `purchase_items.received_qty` llegó en 0023; `PurchaseItem` (types/erp.ts) aún no lo declara. */
export type PurchaseLine = PurchaseItem & { received_qty: number }

/** "Recepción parcial" no es un estado de la base: es 'ordered' con algo ya recibido. */
export const PARTIAL_RECEIPT_STATUS: { label: string; tone: Tone } = { label: 'Recepción parcial', tone: 'amber' }

export function purchaseStatusInfo(status: PurchaseStatus, partiallyReceived: boolean): { label: string; tone: Tone } {
  return status === 'ordered' && partiallyReceived ? PARTIAL_RECEIPT_STATUS : PURCHASE_STATUS[status]
}

const toPurchase = (p: Purchase): Purchase => ({
  ...p,
  subtotal: Number(p.subtotal),
  discount_total: Number(p.discount_total),
  tax_total: Number(p.tax_total),
  total: Number(p.total),
})

export type PurchaseListRow = Purchase & {
  /** 'ordered' con al menos una recepción: ya entró parte de la mercancía. */
  partially_received: boolean
}

/** Compras cuya fecha de orden cae en el rango (inclusive), la más reciente primero. */
export function usePurchases(from: string, to: string) {
  return useQuery({
    queryKey: ['purchases', 'list', from, to],
    queryFn: async (): Promise<PurchaseListRow[]> => {
      const { data, error } = await supabase
        .from('purchases')
        .select('*')
        .gte('order_date', from)
        .lte('order_date', to)
        .order('order_date', { ascending: false })
        .order('seq', { ascending: false })
        .limit(1000)
      if (error) throw error
      const rows = ((data ?? []) as Purchase[]).map(toPurchase)
      // Solo las 'ordered' pueden estar a medias. Tener una recepción equivale
      // a tener algo recibido: receive_purchase() revierte la recepción entera
      // si no entra ninguna línea. En tandas para no pasar del largo de URL.
      const ordered = rows.filter((p) => p.status === 'ordered').map((p) => p.id)
      const partial = new Set<string>()
      for (let i = 0; i < ordered.length; i += 100) {
        const { data: rc, error: rcError } = await supabase
          .from('purchase_receipts')
          .select('purchase_id')
          .in('purchase_id', ordered.slice(i, i + 100))
        if (rcError) throw rcError
        for (const r of (rc ?? []) as { purchase_id: string }[]) partial.add(r.purchase_id)
      }
      return rows.map((p) => ({ ...p, partially_received: partial.has(p.id) }))
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
  items: PurchaseLine[]
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
        items: ((items ?? []) as PurchaseLine[]).map((it) => ({
          ...it,
          quantity: Number(it.quantity),
          received_qty: Number(it.received_qty ?? 0),
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
  /**
   * Pago en el acto (opcional), aplicado a la cuenta por pagar de ESTA
   * recepción: no puede pasar del valor recibido. Sin él, todo queda a deber.
   */
  payment?: {
    client_uid: string
    amount: number
    method: PaymentMethod
    register_id?: string | null
    reference?: string | null
  } | null
  /** Cantidades a recibir por línea. null = todo lo pendiente. */
  lines?: { purchase_item_id: string; quantity: number }[] | null
}

export interface ReceivePurchaseResult {
  purchase_id: string
  receipt_id: string
  receipt_number: string
  /** Valor recibido con ITBIS, calculado por la base: el que vale. */
  value: number
  payable_id: string | null
  payment_id: string | null
  /** true = ya llegó todo y la compra pasó a 'received'. */
  completed: boolean
}

export function useReceivePurchase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, payment, lines }: ReceivePurchaseInput): Promise<ReceivePurchaseResult> => {
      const { data, error } = await supabase.rpc('receive_purchase', {
        p_id: id,
        p_payment: payment ?? null,
        p_lines: lines ?? null,
      })
      if (error) throw error
      const r = (data ?? {}) as Record<string, unknown>
      return {
        purchase_id: String(r.purchase_id),
        receipt_id: String(r.receipt_id),
        receipt_number: String(r.receipt_number ?? ''),
        value: Number(r.value ?? 0),
        payable_id: (r.payable_id as string | null) ?? null,
        payment_id: (r.payment_id as string | null) ?? null,
        completed: Boolean(r.completed),
      }
    },
    onSuccess: (_res, { id }) => {
      // Recibir mueve existencias, costos (productos), la deuda y, si se pagó
      // en efectivo, la caja.
      for (const key of [
        ['purchases'],
        // Incluye ['purchase', id, 'receipts'].
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

export interface PurchaseReceipt {
  id: string
  purchase_id: string
  number: string
  total: number
  payable_id: string | null
  created_by: string | null
  created_at: string
  /** Su cuenta por pagar; null si la recepción valió 0 o no se pudo leer. */
  payable: Payable | null
}

export interface PurchaseReceiptsData {
  receipts: PurchaseReceipt[]
  /**
   * Cuentas por pagar de la compra que no cuelgan de ninguna recepción: las de
   * compras recibidas antes de 0023, cuando se recibía todo de una vez y no
   * existía purchase_receipts. Sin esto su deuda desaparecería de la ficha.
   */
  legacyPayables: Payable[]
}

const toPayable = (p: Payable): Payable => ({ ...p, amount: Number(p.amount), paid_amount: Number(p.paid_amount) })

/** Recepciones de una compra (la más antigua primero) con sus cuentas por pagar. */
export function usePurchaseReceipts(purchaseId: string | undefined) {
  return useQuery({
    queryKey: ['purchase', purchaseId, 'receipts'],
    enabled: Boolean(purchaseId),
    queryFn: async (): Promise<PurchaseReceiptsData> => {
      const [rcRes, pyRes] = await Promise.all([
        supabase.from('purchase_receipts').select('*').eq('purchase_id', purchaseId!).order('created_at'),
        supabase
          .from('payables')
          .select('*')
          .eq('source_type', 'purchase')
          .eq('source_id', purchaseId!)
          .order('created_at'),
      ])
      if (rcRes.error) throw rcRes.error
      if (pyRes.error) throw pyRes.error
      const payables = ((pyRes.data ?? []) as Payable[]).map(toPayable)
      const byId = new Map(payables.map((p) => [p.id, p]))
      const receipts = ((rcRes.data ?? []) as Omit<PurchaseReceipt, 'payable'>[]).map((r) => ({
        ...r,
        total: Number(r.total),
        payable: r.payable_id ? (byId.get(r.payable_id) ?? null) : null,
      }))
      const linked = new Set(receipts.map((r) => r.payable_id).filter(Boolean))
      return { receipts, legacyPayables: payables.filter((p) => !linked.has(p.id)) }
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
