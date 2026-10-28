/**
 * Espejo de `price_lines()` (migración 0015) para la VISTA PREVIA del carrito.
 *
 * El importe que vale es el que devuelve la base al guardar: create_sale() y
 * save_quotation() recalculan todo y el ticket se imprime con su respuesta.
 * Esto existe para que el POS muestre el total al instante, sin una vuelta de
 * red por cada producto escaneado. Si algún día difieren, gana el servidor; la
 * prueba `pricing.test.ts` fija los casos para que no diverjan sin querer.
 *
 * Se trabaja en CENTAVOS enteros: con floats, 0.1 + 0.2 ya no cuadra y el
 * ITBIS de un ticket largo acabaría un centavo distinto del de la base.
 * Postgres redondea .5 alejándose del cero; con montos positivos Math.round
 * hace lo mismo.
 */

export interface PriceLineInput {
  quantity: number
  unit_price: number
  /** Descuento en dinero de la línea (no porcentaje). */
  discount?: number
  /** Fracción: 0.18 = 18 %. */
  tax_rate: number
}

export interface PricedLine<T> {
  input: T
  gross: number
  /** Descuento total: el propio + su parte del descuento general. */
  discount: number
  subtotal: number
  tax_amount: number
  total: number
}

export interface PricedTotals<T> {
  lines: PricedLine<T>[]
  subtotal: number
  discount_total: number
  tax_total: number
  total: number
}

const toCents = (n: number) => Math.round(n * 100)
const fromCents = (c: number) => c / 100

export function priceLines<T extends PriceLineInput>(
  items: T[],
  globalDiscount: number,
  pricesIncludeTax: boolean,
): PricedTotals<T> {
  const nets = items.map((it) => {
    const gross = Math.round(Math.round(it.quantity * 1000) * Math.round(it.unit_price * 100) / 1000)
    const disc = Math.min(toCents(it.discount ?? 0), gross)
    return { it, gross, disc, net: gross - disc }
  })
  const netSum = nets.reduce((s, l) => s + l.net, 0)
  const gd = Math.min(Math.max(toCents(globalDiscount || 0), 0), netSum)

  let left = gd
  const lines = nets.map((l, i) => {
    let alloc = 0
    if (gd > 0 && netSum > 0) alloc = i === nets.length - 1 ? left : Math.round((gd * l.net) / netSum)
    left -= alloc
    const net = l.net - alloc
    const rate = l.it.tax_rate || 0
    let base: number, tax: number, total: number
    if (pricesIncludeTax) {
      total = net
      base = Math.round(total / (1 + rate))
      tax = total - base
    } else {
      base = net
      tax = Math.round(base * rate)
      total = base + tax
    }
    return {
      input: l.it,
      gross: fromCents(l.gross),
      discount: fromCents(l.disc + alloc),
      subtotal: fromCents(base),
      tax_amount: fromCents(tax),
      total: fromCents(total),
    }
  })

  const sum = (k: 'subtotal' | 'tax_amount' | 'total' | 'discount') =>
    fromCents(lines.reduce((s, l) => s + toCents(l[k]), 0))
  return {
    lines,
    subtotal: sum('subtotal'),
    discount_total: sum('discount'),
    tax_total: sum('tax_amount'),
    total: sum('total'),
  }
}
