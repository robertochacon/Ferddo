import qrcode from 'qrcode-generator'
import { esc, printHtml } from '@/lib/print'
import { fmtDateTime, money } from '@/lib/format'
import { CASH_KIND_LABEL, ECF_STATUS, PAYMENT_METHOD_LABEL } from '@/lib/labels'
import type { SaleDetail } from '@/hooks/sales'
import type { Tenant } from '@/types/db'
import type {
  Branch,
  CashMovementKind,
  CashRegister,
  CashSessionReport,
  ElectronicInvoice,
  PaymentMethod,
} from '@/types/erp'

/*
 * Plantillas de impresión del POS: ticket de venta (58/80 mm) y cierre de caja.
 *
 * Se arma HTML plano y se imprime con `printHtml()` (iframe propio). Todo lo
 * que viene de la base pasa por `esc()`: el nombre de un producto o de un
 * cliente es texto libre y no debe poder inyectar marcado en el ticket.
 *
 * Imprimir NUNCA forma parte de guardar: estas funciones se llaman con la venta
 * ya confirmada por la base y sirven igual para la primera impresión que para
 * una reimpresión.
 */

/** Nombres de los tipos de e-CF que Ferddo emite (catálogo `ecf_types`, 0016). */
export const ECF_TYPE_LABEL: Record<string, string> = {
  '31': 'Factura de Crédito Fiscal Electrónica',
  '32': 'Factura de Consumo Electrónica',
  '34': 'Nota de Crédito Electrónica',
}

const DOC_TYPE_LABEL: Record<string, string> = {
  rnc: 'RNC',
  cedula: 'Cédula',
  passport: 'Pasaporte',
  none: 'Documento',
}

type Paper = 58 | 80

function paperOf(register: CashRegister | null | undefined): Paper {
  return register?.settings?.paper_width === 58 ? 58 : 80
}

/** Fila de dos columnas: etiqueta a la izquierda, importe a la derecha. */
function row(label: string, value: string, bold = false): string {
  const cls = bold ? ' class="b"' : ''
  return `<tr${cls}><td>${esc(label)}</td><td class="r">${esc(value)}</td></tr>`
}

function qty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toLocaleString('es-DO', { maximumFractionDigits: 3 })
}

/**
 * QR del e-CF como data-URL. Si la URL no cabe en un QR (o la librería falla)
 * se omite: el ticket sigue siendo válido con el e-NCF y el código de seguridad.
 */
function qrImg(url: string): string {
  try {
    const qr = qrcode(0, 'M')
    qr.addData(url)
    qr.make()
    return `<p class="c" style="margin-top:6px"><img class="qr" src="${qr.createDataURL(4, 0)}" alt="QR e-CF"></p>`
  } catch {
    return ''
  }
}

function businessHeader(tenant: Tenant, branch?: Branch | null): string {
  const parts: string[] = [`<h2 class="c b" style="font-size:1.25em">${esc(tenant.name)}</h2>`]
  if (tenant.legal_name && tenant.legal_name.trim() !== tenant.name.trim()) {
    parts.push(`<p class="c">${esc(tenant.legal_name)}</p>`)
  }
  if (tenant.rnc) parts.push(`<p class="c">RNC: ${esc(tenant.rnc)}</p>`)
  const address = branch?.address || tenant.address
  if (address) parts.push(`<p class="c">${esc(address)}</p>`)
  const phone = branch?.phone || tenant.phone
  if (phone) parts.push(`<p class="c">Tel.: ${esc(phone)}</p>`)
  if (branch && !branch.is_main) parts.push(`<p class="c">Sucursal: ${esc(branch.name)}</p>`)
  return parts.join('')
}

function ecfBlock(inv: ElectronicInvoice): string {
  const status = ECF_STATUS[inv.status]?.label ?? inv.status
  const out: string[] = ['<div class="hr"></div>']
  if (inv.simulated) {
    // En mayúsculas y arriba del bloque: quien recibe el papel debe verlo
    // antes que el e-NCF, que de otro modo parece auténtico.
    out.push('<p class="c b">*** SIMULACIÓN — SIN VALIDEZ FISCAL ***</p>')
  }
  out.push(`<p class="c b">${esc(ECF_TYPE_LABEL[inv.ecf_type] ?? `e-CF tipo ${inv.ecf_type}`)}</p>`)
  out.push('<table>')
  out.push(row('e-NCF', inv.encf, true))
  if (inv.reference_encf) out.push(row('Modifica', inv.reference_encf))
  if (inv.security_code) out.push(row('Cód. seguridad', inv.security_code))
  out.push(row('Fecha emisión', fmtDateTime(inv.issue_date)))
  out.push(row('Estado', status))
  out.push('</table>')
  if (inv.buyer_id) {
    out.push(
      `<p>${esc(DOC_TYPE_LABEL[inv.buyer_id_type ?? 'none'] ?? 'Doc.')} comprador: ${esc(inv.buyer_id)}</p>`,
    )
    if (inv.buyer_name) out.push(`<p>Razón social: ${esc(inv.buyer_name)}</p>`)
  }
  if (inv.qr_url) out.push(qrImg(inv.qr_url))
  return out.join('')
}

export interface SaleReceiptInput {
  tenant: Tenant
  detail: SaleDetail
  register?: CashRegister | null
  branch?: Branch | null
  /** Nombre de quien cobró (sales.created_by). */
  cashierName?: string | null
  /** Nombre del vendedor (sales.seller_id), si es otro. */
  sellerName?: string | null
  /** Marca "REIMPRESIÓN" en el ticket. */
  reprint?: boolean
}

/** Construye el HTML del ticket (separado de imprimir para poder probarlo). */
export function buildSaleReceiptHtml(input: SaleReceiptInput): string {
  const { tenant, detail, branch, cashierName, sellerName, reprint } = input
  const { sale, items, payments, customer, returns, invoices } = detail
  const cur = tenant.currency
  const m = (n: number) => money(n, cur)
  const html: string[] = []

  html.push(businessHeader(tenant, branch))
  html.push('<div class="hr"></div>')
  html.push('<table>')
  html.push(row('Venta', sale.number, true))
  html.push(row('Fecha', fmtDateTime(sale.created_at)))
  if (cashierName) html.push(row('Cajero', cashierName))
  if (sellerName && sellerName !== cashierName) html.push(row('Vendedor', sellerName))
  html.push('</table>')
  if (reprint) html.push('<p class="c b">REIMPRESIÓN</p>')
  if (sale.status === 'voided') html.push('<p class="c b">*** VENTA ANULADA ***</p>')

  if (customer) {
    html.push('<div class="hr"></div>')
    html.push(`<p>Cliente: ${esc(customer.name)}</p>`)
    if (customer.doc_number && customer.doc_type !== 'none') {
      html.push(`<p>${esc(DOC_TYPE_LABEL[customer.doc_type] ?? 'Doc.')}: ${esc(customer.doc_number)}</p>`)
    }
  }

  // Líneas: descripción completa arriba y "cant x precio … total" debajo. En
  // 58 mm no caben cuatro columnas sin partir el nombre del producto.
  html.push('<div class="hr"></div><table>')
  for (const it of items) {
    html.push(`<tr><td colspan="2">${esc(it.description)}</td></tr>`)
    html.push(
      `<tr><td class="muted">&nbsp;${esc(qty(it.quantity))} x ${esc(m(it.unit_price))}</td>` +
        `<td class="r">${esc(m(it.total))}</td></tr>`,
    )
    if (it.discount > 0) {
      html.push(`<tr><td class="muted">&nbsp;Desc.</td><td class="r muted">-${esc(m(it.discount))}</td></tr>`)
    }
  }
  html.push('</table><div class="hr"></div><table>')
  html.push(row('Subtotal', m(sale.subtotal)))
  if (sale.discount_total > 0) html.push(row('Descuento', `-${m(sale.discount_total)}`))
  html.push(row('ITBIS', m(sale.tax_total)))
  html.push(row('TOTAL', m(sale.total), true))
  html.push('</table>')

  if (payments.length) {
    html.push('<div class="hr"></div><table>')
    for (const p of payments) {
      const label = PAYMENT_METHOD_LABEL[p.method as PaymentMethod] ?? p.method
      // En efectivo se imprime lo entregado: la devuelta sale de ahí.
      const shown = p.method === 'cash' && p.tendered != null ? p.tendered : p.amount
      html.push(row(p.reference ? `${label} (${p.reference})` : label, m(shown)))
    }
    if (sale.change_due > 0) html.push(row('Devuelta', m(sale.change_due), true))
    html.push('</table>')
  }

  if (returns.length) {
    html.push('<div class="hr"></div><table>')
    for (const r of returns) html.push(row(`Devolución ${r.number}`, `-${m(r.total)}`))
    html.push('</table>')
  }

  const saleInvoice = invoices.find((i) => i.source_type === 'sale' && i.status !== 'voided')
  if (saleInvoice) {
    html.push(ecfBlock(saleInvoice))
  } else if (sale.ecf_type) {
    html.push('<div class="hr"></div><p class="c">Comprobante fiscal en proceso</p>')
  } else {
    html.push('<div class="hr"></div><p class="c">Comprobante interno — no válido como factura fiscal</p>')
  }

  if (sale.notes) html.push(`<div class="hr"></div><p>${esc(sale.notes)}</p>`)
  if (tenant.receipt_footer) {
    html.push(`<div class="hr"></div><p class="c" style="white-space:pre-line">${esc(tenant.receipt_footer)}</p>`)
  }
  html.push('<p class="c" style="margin-top:8px">¡Gracias por su compra!</p>')
  return html.join('')
}

export function printSaleReceipt(input: SaleReceiptInput): void {
  printHtml(buildSaleReceiptHtml(input), paperOf(input.register), `Ticket ${input.detail.sale.number}`)
}

// ── Cierre de caja ───────────────────────────────────────────────────────────

export interface CashReportPrintInput {
  tenant: Tenant
  report: CashSessionReport
  closedByName?: string | null
  register?: CashRegister | null
}

export function printCashReport(input: CashReportPrintInput): void {
  const { tenant, report, closedByName } = input
  const s = report.session
  const m = (n: number | null | undefined) => money(n ?? 0, tenant.currency)
  const closed = s.status === 'closed'
  const html: string[] = []

  html.push(businessHeader(tenant))
  html.push('<div class="hr"></div>')
  html.push(`<p class="c b">${closed ? 'CIERRE DE CAJA' : 'CORTE PARCIAL — CAJA ABIERTA'}</p>`)
  html.push('<table>')
  html.push(row('Sesión', s.number, true))
  if (report.register_name) html.push(row('Caja', report.register_name))
  html.push(row('Abrió', report.opened_by_name ?? '—'))
  html.push(row('Apertura', fmtDateTime(s.opened_at)))
  if (closed) {
    html.push(row('Cerró', closedByName ?? '—'))
    html.push(row('Cierre', fmtDateTime(s.closed_at)))
  }
  html.push('</table><div class="hr"></div><table>')
  html.push(row('Ventas', String(report.sales_count)))
  html.push(row('Total vendido', m(report.sales_total)))
  if (report.credit_total > 0) html.push(row('A crédito', m(report.credit_total)))
  html.push('</table>')

  const methods = Object.entries(report.by_method)
  if (methods.length) {
    html.push('<div class="hr"></div><p class="b">Por método</p><table>')
    for (const [k, v] of methods) html.push(row(PAYMENT_METHOD_LABEL[k as PaymentMethod] ?? k, m(v)))
    html.push('</table>')
  }
  const kinds = Object.entries(report.by_kind)
  if (kinds.length) {
    html.push('<div class="hr"></div><p class="b">Por concepto</p><table>')
    for (const [k, v] of kinds) html.push(row(CASH_KIND_LABEL[k as CashMovementKind] ?? k, m(v)))
    html.push('</table>')
  }

  html.push('<div class="hr"></div><table>')
  html.push(row('Fondo inicial', m(s.opening_amount)))
  html.push(row('Efectivo esperado', m(closed ? s.expected_cash : report.expected_cash), true))
  if (closed) {
    html.push(row('Efectivo contado', m(s.counted_cash), true))
    const diff = s.difference ?? 0
    const label = diff === 0 ? 'Cuadre' : diff > 0 ? 'Sobrante' : 'Faltante'
    html.push(row(label, m(diff), true))
  }
  html.push('</table>')
  if (s.notes) html.push(`<div class="hr"></div><p>${esc(s.notes)}</p>`)
  html.push(
    '<div style="margin-top:28px"><div class="hr"></div><p class="c">Firma cajero</p></div>' +
      '<div style="margin-top:28px"><div class="hr"></div><p class="c">Firma supervisor</p></div>',
  )
  html.push(`<p class="c muted" style="margin-top:8px">Impreso ${esc(fmtDateTime(new Date()))}</p>`)

  printHtml(html.join(''), paperOf(input.register), `Cierre ${s.number}`)
}
