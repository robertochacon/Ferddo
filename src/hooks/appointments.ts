import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { invalidateAfterSaleChange } from '@/hooks/sales'
import { kickEcfQueue } from '@/hooks/invoicing'
import type { SalePaymentPayload } from '@/hooks/pos'
import type { Appointment, AppointmentStatus, CreateSaleResult, EcfStatus } from '@/types/erp'

/*
 * Citas y agenda (0026).
 *
 * La tabla solo se LEE por RLS; toda escritura pasa por las RPC appt_*, que
 * son las que conocen el flujo de estados y el solape por profesional (una
 * restricción de exclusión en la base, no una consulta previa aquí). El cobro
 * sale de create_sale() con los precios vigentes del catálogo.
 *
 * Todo cuelga de ['appointments'] para que cualquier mutación refresque de un
 * golpe la agenda de cualquier rango que esté en caché.
 */

export interface AppointmentFilters {
  /** Inicio del rango (ISO, incluido). */
  from: string
  /** Fin del rango (ISO, excluido). */
  to: string
  /** '' o ausente = todos; 'none' = sin asignar; o el user_id del profesional. */
  staffId?: string
}

/**
 * Citas que TOCAN el rango [from, to): ordenadas por hora de inicio. Se filtra
 * por solape (empieza antes del fin y termina después del inicio) y no solo por
 * la hora de inicio, para que una cita que cruza la medianoche salga en los dos días.
 */
export function useAppointments(filters: AppointmentFilters) {
  return useQuery({
    queryKey: ['appointments', 'list', filters],
    queryFn: async (): Promise<Appointment[]> => {
      let q = supabase
        .from('appointments')
        .select('*')
        .lt('starts_at', filters.to)
        .gt('ends_at', filters.from)
      if (filters.staffId === 'none') q = q.is('staff_id', null)
      else if (filters.staffId) q = q.eq('staff_id', filters.staffId)
      const { data, error } = await q.order('starts_at').limit(2000)
      if (error) throw error
      return (data ?? []) as Appointment[]
    },
  })
}

function invalidateAppointments(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ['appointments'] })
  qc.invalidateQueries({ queryKey: ['dashboard'] })
}

export interface SaveAppointmentInput {
  id?: string
  branch_id: string
  customer_id: string | null
  contact_name: string | null
  contact_phone: string | null
  staff_id: string | null
  service_id: string | null
  /** null = el nombre del servicio (lo pone appt_save). */
  title: string | null
  starts_at: string
  /** null = inicio + duración del servicio (o 30 min). */
  ends_at: string | null
  notes: string | null
}

export function useSaveAppointment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: SaveAppointmentInput): Promise<string> => {
      const { data, error } = await supabase.rpc('appt_save', { p_payload: input })
      if (error) throw error
      return data as string
    },
    onSuccess: () => invalidateAppointments(qc),
  })
}

export function useSetAppointmentStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: string; status: AppointmentStatus; reason?: string | null }) => {
      const { error } = await supabase.rpc('appt_set_status', {
        p_id: input.id,
        p_status: input.status,
        p_reason: input.reason ?? null,
      })
      if (error) throw error
    },
    onSuccess: () => invalidateAppointments(qc),
  })
}

export interface AppointmentCheckoutInput {
  appointment_id: string
  /** Generado al abrir el cobro y reutilizado en cada reintento. */
  client_uid: string
  register_id: string
  ecf_type: string | null
  payments: SalePaymentPayload[]
  /** Sin líneas, appt_checkout cobra el servicio de la cita ×1. */
  items?: { product_id: string; quantity: number }[]
}

export function useCheckoutAppointment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: AppointmentCheckoutInput): Promise<CreateSaleResult> => {
      const { data, error } = await supabase.rpc('appt_checkout', { p_payload: input })
      if (error) throw error
      const r = (data ?? {}) as Partial<CreateSaleResult>
      // Igual que en el POS: una respuesta "replayed" no trae `ecf`.
      const ecf = r.ecf as CreateSaleResult['ecf'] | undefined
      return {
        sale_id: String(r.sale_id),
        number: String(r.number ?? ''),
        total: Number(r.total ?? 0),
        change_due: Number(r.change_due ?? 0),
        replayed: Boolean(r.replayed),
        ecf: ecf ? { ...ecf, status: ecf.status as EcfStatus, simulated: Boolean(ecf.simulated) } : null,
      }
    },
    onSuccess: (r) => {
      invalidateAfterSaleChange(qc)
      invalidateAppointments(qc)
      if (r.ecf && !r.replayed) kickEcfQueue(qc)
    },
  })
}
