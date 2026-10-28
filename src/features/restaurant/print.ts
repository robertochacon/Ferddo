import { esc, printHtml } from '@/lib/print'
import { fmtDateTime, money } from '@/lib/format'
import type { Tenant } from '@/types/db'
import type { RestaurantOrder } from '@/types/erp'
import { fmtQty } from './shared'

/*
 * Comanda de cocina y pre-cuenta, en 80 mm. Igual que el ticket de venta:
 * imprimir va DESPUÉS de guardar y nunca lo bloquea; todo texto libre (nombre
 * de plato, nota "sin cebolla", etiqueta de la cuenta) pasa por `esc()`.
 */

function row(label: string, value: string, bold = false): string {
  return `<tr${bold ? ' class="b"' : ''}><td>${esc(label)}</td><td class="r">${esc(value)}</td></tr>`
}

function orderTitle(order: Pick<RestaurantOrder, 'number' | 'label'>, tableName: string | null): string {
  return [tableName ?? 'Para llevar', order.label].filter(Boolean).join(' · ')
}

export interface KitchenTicketPrint {
  tenant: Tenant
  order: Pick<RestaurantOrder, 'number' | 'label' | 'guests'>
  tableName: string | null
  ticketNumber: string
  waiterName?: string | null
  items: { quantity: number; name: string; notes: string | null }[]
}

export function printKitchenTicket(input: KitchenTicketPrint): void {
  const { order, tableName, ticketNumber, waiterName, items } = input
  const html: string[] = []
  html.push(`<p class="c b" style="font-size:1.1em">COMANDA ${esc(ticketNumber)}</p>`)
  // La mesa en grande: es lo primero que busca quien saca el plato.
  html.push(`<p class="c b" style="font-size:1.6em;margin:4px 0">${esc(orderTitle(order, tableName))}</p>`)
  html.push('<table>')
  html.push(row('Cuenta', order.number))
  html.push(row('Personas', String(order.guests)))
  if (waiterName) html.push(row('Mesero', waiterName))
  html.push(row('Hora', fmtDateTime(new Date())))
  html.push('</table><div class="hr"></div>')
  html.push('<table style="font-size:1.25em">')
  for (const it of items) {
    html.push(`<tr class="b"><td style="width:3.2em">${esc(fmtQty(it.quantity))} x</td><td>${esc(it.name)}</td></tr>`)
    if (it.notes) html.push(`<tr><td></td><td>&gt;&gt; ${esc(it.notes)}</td></tr>`)
  }
  html.push('</table><div class="hr"></div>')
  html.push(`<p class="c">${esc(input.tenant.name)}</p>`)
  printHtml(html.join(''), 80, `Comanda ${ticketNumber}`)
}

export interface PreBillPrint {
  tenant: Tenant
  order: Pick<RestaurantOrder, 'number' | 'label' | 'guests' | 'opened_at'>
  tableName: string | null
  waiterName?: string | null
  lines: { quantity: number; name: string; total: number }[]
  subtotal: number
  tax: number
  service: number
  total: number
}

export function printPreBill(input: PreBillPrint): void {
  const { tenant, order, tableName, waiterName, lines } = input
  const m = (n: number) => money(n, tenant.currency)
  const html: string[] = []
  html.push(`<h2 class="c b" style="font-size:1.25em">${esc(tenant.name)}</h2>`)
  html.push('<div class="hr"></div><p class="c b">PRE-CUENTA</p>')
  html.push('<table>')
  html.push(row('Mesa', orderTitle(order, tableName), true))
  html.push(row('Cuenta', order.number))
  html.push(row('Personas', String(order.guests)))
  if (waiterName) html.push(row('Mesero', waiterName))
  html.push(row('Abierta', fmtDateTime(order.opened_at)))
  html.push(row('Impresa', fmtDateTime(new Date())))
  html.push('</table><div class="hr"></div><table>')
  for (const l of lines) {
    html.push(`<tr><td colspan="2">${esc(l.name)}</td></tr>`)
    html.push(`<tr><td class="muted">&nbsp;${esc(fmtQty(l.quantity))}</td><td class="r">${esc(m(l.total))}</td></tr>`)
  }
  html.push('</table><div class="hr"></div><table>')
  html.push(row('Subtotal', m(input.subtotal)))
  html.push(row('ITBIS', m(input.tax)))
  if (input.service > 0) html.push(row('Servicio (10 % de ley)', m(input.service)))
  html.push(row('TOTAL', m(input.total), true))
  if (order.guests > 1) {
    html.push(row(`Por persona (${order.guests})`, m(Math.round((input.total / order.guests) * 100) / 100)))
  }
  html.push('</table><div class="hr"></div>')
  html.push('<p class="c">Documento informativo — no válido como factura</p>')
  printHtml(html.join(''), 80, `Pre-cuenta ${order.number}`)
}
