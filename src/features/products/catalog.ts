import type { Tone } from '@/lib/labels'
import type { Product } from '@/types/erp'

/*
 * Utilidades del catálogo que comparten Productos e Inventario. Van aparte de
 * `lib/` porque solo las usan estas dos pantallas.
 */

/** Unidades de medida ofrecidas. `unit` es texto libre en la base: esto es solo la lista sugerida. */
export const UNITS = [
  'unidad',
  'libra',
  'onza',
  'kg',
  'gramo',
  'litro',
  'galón',
  'botella',
  'caja',
  'paquete',
  'docena',
  'fardo',
  'saco',
  'par',
  'juego',
  'rollo',
  'metro',
  'pie',
  'yarda',
  'servicio',
  'hora',
  'día',
] as const

/**
 * Lee un número escrito a mano. Acepta coma decimal ("1,5"), que es como lo
 * teclea medio país y como lo exporta Excel en español; con coma Y punto se
 * asume el formato con separador de miles ("1,250.50").
 * '' → null (campo vacío); texto inválido → NaN.
 */
export function parseDecimal(value: string | null | undefined): number | null {
  const s = (value ?? '').trim()
  if (s === '') return null
  const normalized = s.includes(',') && s.includes('.') ? s.replace(/,/g, '') : s.replace(',', '.')
  if (!/^-?\d*\.?\d+$/.test(normalized)) return Number.NaN
  return Number(normalized)
}

/** Cantidad con hasta 3 decimales (numeric(14,3) en la base). */
export function fmtQty(n: number | null | undefined): string {
  return Number(n ?? 0).toLocaleString('es-DO', { maximumFractionDigits: 3 })
}

export type StockStatus = 'negative' | 'out' | 'low' | 'ok'

export const STOCK_STATUS: Record<StockStatus, { label: string; tone: Tone }> = {
  negative: { label: 'Negativo', tone: 'red' },
  out: { label: 'Agotado', tone: 'red' },
  low: { label: 'Bajo mínimo', tone: 'amber' },
  ok: { label: 'Disponible', tone: 'green' },
}

export function stockStatus(qty: number, minStock: number): StockStatus {
  if (qty < 0) return 'negative'
  if (qty === 0) return 'out'
  if (minStock > 0 && qty <= minStock) return 'low'
  return 'ok'
}

/** ¿Merece aviso? Agotado solo cuenta si el producto tiene mínimo: un 0 sin mínimo puede ser normal. */
export function isLowStock(p: Pick<Product, 'track_stock' | 'min_stock'>, qty: number): boolean {
  if (!p.track_stock) return false
  return qty < 0 || (p.min_stock > 0 && qty <= p.min_stock)
}

/**
 * Precio sin impuesto: si la empresa vende con el ITBIS incluido (lo normal en
 * RD), el margen se mide contra el precio NETO; si no, el impuesto ni siquiera
 * es ingreso del negocio y medirlo inflaría el margen.
 */
export function netPrice(price: number, taxRate: number, pricesIncludeTax: boolean): number {
  return pricesIncludeTax ? price / (1 + taxRate) : price
}

/** Margen sobre la venta en %, o null si no hay precio contra el que medirlo. */
export function marginPct(price: number, cost: number, taxRate: number, pricesIncludeTax: boolean): number | null {
  const net = netPrice(price, taxRate, pricesIncludeTax)
  if (!(net > 0)) return null
  return ((net - cost) / net) * 100
}

/** Texto de búsqueda de un producto: nombre, variante y todos sus códigos. */
export function productHaystack(p: Product): string {
  return [p.name, p.variant_label, p.sku, p.barcode, p.code, p.brand].filter(Boolean).join(' ').toLowerCase()
}

/** Nombre a mostrar, con la variante pegada ("Camiseta · Talla M"). */
export function productLabel(p: Pick<Product, 'name' | 'variant_label'>): string {
  return p.variant_label ? `${p.name} · ${p.variant_label}` : p.name
}
