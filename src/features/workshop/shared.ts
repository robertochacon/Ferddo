import { parseISO } from 'date-fns'
import type { Asset, WorkOrder, WorkOrderStatus } from '@/types/erp'

/*
 * Piezas comunes del tablero y del detalle de órdenes de trabajo.
 */

/** Estados "en curso", en el orden del flujo (wo_set_status). */
export const ACTIVE_STATUSES: WorkOrderStatus[] = ['received', 'diagnosing', 'quoted', 'approved', 'in_progress', 'done']

/** Orden del flujo hacia adelante; espejo del `v_rank` de wo_set_status(). */
export const FLOW: WorkOrderStatus[] = [...ACTIVE_STATUSES, 'delivered']

export const ASSET_KIND_LABEL: Record<Asset['kind'], string> = {
  vehicle: 'Vehículo',
  equipment: 'Equipo',
}

/** "Toyota Corolla 2015 · A123456" — lo que el mecánico reconoce de un vistazo. */
export function assetLabel(a: Asset | null | undefined): string {
  if (!a) return 'Sin vehículo/equipo'
  const name = [a.brand, a.model, a.year].filter(Boolean).join(' ') || ASSET_KIND_LABEL[a.kind]
  const id = a.kind === 'vehicle' ? (a.plate ?? a.serial) : (a.serial ?? a.plate)
  return id ? `${name} · ${id}` : name
}

/**
 * Atrasada = prometida para antes de ahora y aún sin terminar. Una orden ya
 * terminada no está "atrasada" aunque el cliente no la haya recogido.
 */
export function isOverdue(o: Pick<WorkOrder, 'promised_at' | 'status'>): boolean {
  if (!o.promised_at) return false
  if (o.status === 'done' || o.status === 'delivered' || o.status === 'canceled') return false
  return parseISO(o.promised_at).getTime() < Date.now()
}

/**
 * Cambios de estado que la base acepta desde `from` (sin contar cancelar):
 * cualquiera hacia adelante (saltar pasos vale) y, de vuelta, solo
 * cotizada/aprobada → en revisión. Es cortesía para no ofrecer botones que
 * fallarían; la regla de verdad es wo_set_status().
 */
export function allowedTargets(from: WorkOrderStatus): WorkOrderStatus[] {
  if (from === 'delivered' || from === 'canceled') return []
  const i = FLOW.indexOf(from)
  const forward = FLOW.slice(i + 1)
  return from === 'quoted' || from === 'approved' ? ['diagnosing', ...forward] : forward
}
