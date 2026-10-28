// Etiquetas en español de los enums del ERP. Siempre `Record` completos: si
// un enum crece en la base y aquí no se traduce, falla la compilación en vez
// de pintar "undefined" en producción.
import type { MemberRole, ModuleCode } from '@/types/db'
import type {
  CashMovementKind,
  DocumentStatus,
  EcfStatus,
  ExpenseStatus,
  InventoryMovementKind,
  PaymentMethod,
  PurchaseStatus,
  QuotationStatus,
  SaleStatus,
} from '@/types/erp'

export type Tone = 'brand' | 'green' | 'amber' | 'red' | 'slate'

export const ROLE_LABEL: Record<MemberRole, string> = {
  owner: 'Propietario',
  admin: 'Administrador',
  supervisor: 'Supervisor',
  cashier: 'Cajero',
  seller: 'Vendedor',
  inventory: 'Encargado de inventario',
  purchasing: 'Encargado de compras',
  accounting: 'Contabilidad',
  kitchen: 'Cocina',
  service: 'Operador de servicios',
}

/** Roles que se pueden asignar desde Equipo, en el orden en que se ofrecen. */
export const ASSIGNABLE_ROLES: MemberRole[] = [
  'admin',
  'supervisor',
  'cashier',
  'seller',
  'inventory',
  'purchasing',
  'accounting',
  'kitchen',
  'service',
  'owner',
]

export const MODULE_LABEL: Record<ModuleCode, string> = {
  pos: 'Punto de venta',
  inventory: 'Inventario',
  cash: 'Caja',
  credit: 'Ventas a crédito y cobros',
  invoicing: 'Facturación electrónica',
  purchases: 'Compras',
  expenses: 'Gastos',
  payables: 'Cuentas por pagar',
  quotations: 'Cotizaciones',
  reports: 'Reportes',
  restaurant: 'Restaurante (mesas y comandas)',
  workshop: 'Taller (órdenes de trabajo)',
}

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'Efectivo',
  card: 'Tarjeta',
  transfer: 'Transferencia',
  credit: 'Crédito',
  credit_note: 'Nota de crédito',
  other: 'Otro',
}

export const SALE_STATUS: Record<SaleStatus, { label: string; tone: Tone }> = {
  completed: { label: 'Completada', tone: 'green' },
  voided: { label: 'Anulada', tone: 'red' },
  partially_returned: { label: 'Devolución parcial', tone: 'amber' },
  returned: { label: 'Devuelta', tone: 'slate' },
}

export const ECF_STATUS: Record<EcfStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Pendiente de envío', tone: 'slate' },
  sending: { label: 'Enviando', tone: 'brand' },
  sent: { label: 'En proceso (DGII)', tone: 'brand' },
  accepted: { label: 'Aceptado', tone: 'green' },
  accepted_conditional: { label: 'Aceptado condicional', tone: 'amber' },
  rejected: { label: 'Rechazado', tone: 'red' },
  error: { label: 'Error de envío', tone: 'red' },
  voided: { label: 'Anulado', tone: 'slate' },
}

export const DOCUMENT_STATUS: Record<DocumentStatus, { label: string; tone: Tone }> = {
  open: { label: 'Pendiente', tone: 'amber' },
  paid: { label: 'Saldado', tone: 'green' },
  canceled: { label: 'Cancelado', tone: 'slate' },
}

export const PURCHASE_STATUS: Record<PurchaseStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Borrador', tone: 'slate' },
  ordered: { label: 'Ordenada', tone: 'brand' },
  received: { label: 'Recibida', tone: 'green' },
  canceled: { label: 'Cancelada', tone: 'red' },
}

export const EXPENSE_STATUS: Record<ExpenseStatus, { label: string; tone: Tone }> = {
  paid: { label: 'Pagado', tone: 'green' },
  pending: { label: 'Por pagar', tone: 'amber' },
  voided: { label: 'Anulado', tone: 'slate' },
}

export const QUOTATION_STATUS: Record<QuotationStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Borrador', tone: 'slate' },
  sent: { label: 'Enviada', tone: 'brand' },
  accepted: { label: 'Aceptada', tone: 'green' },
  rejected: { label: 'Rechazada', tone: 'red' },
  expired: { label: 'Vencida', tone: 'amber' },
  converted: { label: 'Convertida', tone: 'green' },
}

export const INVENTORY_KIND_LABEL: Record<InventoryMovementKind, string> = {
  initial: 'Existencia inicial',
  purchase: 'Compra',
  sale: 'Venta',
  sale_void: 'Anulación de venta',
  sale_return: 'Devolución',
  adjustment_in: 'Entrada (ajuste)',
  adjustment_out: 'Salida (ajuste)',
  transfer_in: 'Transferencia recibida',
  transfer_out: 'Transferencia enviada',
  count: 'Conteo físico',
}

export const CASH_KIND_LABEL: Record<CashMovementKind, string> = {
  sale: 'Venta',
  sale_void: 'Anulación',
  refund: 'Reembolso',
  cash_in: 'Entrada de efectivo',
  cash_out: 'Salida de efectivo',
  receivable_payment: 'Cobro a cliente',
  payable_payment: 'Pago a proveedor',
  expense: 'Gasto',
}

/** Provincias de República Dominicana (para los selects de dirección). */
export const DR_PROVINCES = [
  'Distrito Nacional', 'Azua', 'Bahoruco', 'Barahona', 'Dajabón', 'Duarte', 'El Seibo', 'Elías Piña',
  'Espaillat', 'Hato Mayor', 'Hermanas Mirabal', 'Independencia', 'La Altagracia', 'La Romana', 'La Vega',
  'María Trinidad Sánchez', 'Monseñor Nouel', 'Monte Cristi', 'Monte Plata', 'Pedernales', 'Peravia',
  'Puerto Plata', 'Samaná', 'San Cristóbal', 'San José de Ocoa', 'San Juan', 'San Pedro de Macorís',
  'Sánchez Ramírez', 'Santiago', 'Santiago Rodríguez', 'Santo Domingo', 'Valverde',
] as const

/**
 * Dígito verificador de RNC (9) y cédula (11). Es un AVISO en la UI, no una
 * barrera: la base solo valida el formato, y la existencia real del RNC la
 * confirma la DGII.
 */
export function checkDocNumber(value: string): 'ok' | 'bad_format' | 'bad_check' {
  const d = value.replace(/\D/g, '')
  if (d.length === 9) {
    const w = [7, 9, 8, 6, 5, 4, 3, 2]
    const sum = w.reduce((s, x, i) => s + x * Number(d[i]), 0)
    const r = sum % 11
    const check = r === 0 ? 2 : r === 1 ? 1 : 11 - r
    return check === Number(d[8]) ? 'ok' : 'bad_check'
  }
  if (d.length === 11) {
    let sum = 0
    for (let i = 0; i < 10; i++) {
      let p = Number(d[i]) * (i % 2 === 0 ? 1 : 2)
      if (p > 9) p -= 9
      sum += p
    }
    const check = (10 - (sum % 10)) % 10
    return check === Number(d[10]) ? 'ok' : 'bad_check'
  }
  return 'bad_format'
}

/** Identificador idempotente para operaciones financieras (ver create_sale). */
export function newClientUid(): string {
  return crypto.randomUUID()
}
