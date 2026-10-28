import type { Quotation, QuotationStatus } from '@/types/erp'
import { todayIso } from '@/features/receivables/paymentShared'

/**
 * Estado que se ENSEÑA. Nadie pasa las cotizaciones a "vencida" en la base (no
 * hay un job que lo haga), así que una en borrador o enviada con la validez ya
 * cumplida se pinta como vencida aquí. Se compara como texto 'yyyy-MM-dd'
 * contra hoy en hora local.
 */
export function effectiveStatus(q: Pick<Quotation, 'status' | 'valid_until'>): QuotationStatus {
  if ((q.status === 'draft' || q.status === 'sent') && q.valid_until < todayIso()) return 'expired'
  return q.status
}

/** ¿Se puede llevar al punto de venta? Convertida, rechazada o vencida, no. */
export function isConvertible(q: Pick<Quotation, 'status' | 'valid_until'>): boolean {
  const s = effectiveStatus(q)
  return s === 'draft' || s === 'sent' || s === 'accepted'
}
