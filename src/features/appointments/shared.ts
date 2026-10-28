import { addDays, format, parseISO } from 'date-fns'
import { es } from 'date-fns/locale'
import { digits } from '@/lib/format'
import type { Appointment, AppointmentStatus } from '@/types/erp'

/*
 * Fechas de la agenda.
 *
 * El día se maneja como 'yyyy-MM-dd' en hora LOCAL del navegador (la empresa y
 * su gente están en RD, UTC−4 sin horario de verano). A la base se manda un
 * instante ISO construido desde esa hora local: `new Date('2026-10-28T09:00')`
 * — fecha y hora SIN zona — se interpreta como local, a diferencia de una fecha
 * sola, que JavaScript lee como UTC y en América resta un día.
 */

/** Estados que ya no cambian (appt_set_status y appt_save los rechazan). */
export const CLOSED: AppointmentStatus[] = ['done', 'canceled', 'no_show']

export const isClosed = (a: Pick<Appointment, 'status'>) => CLOSED.includes(a.status)

/** Hoy como 'yyyy-MM-dd' local. */
export const todayKey = () => format(new Date(), 'yyyy-MM-dd')

/** Medianoche local del día. */
export const dayStart = (day: string) => parseISO(day)

export const shiftDay = (day: string, n: number) => format(addDays(parseISO(day), n), 'yyyy-MM-dd')

/** Día 'yyyy-MM-dd' + hora 'HH:mm' locales → instante ISO (UTC) para la base. */
export function localToIso(day: string, time: string): string {
  return new Date(`${day}T${time}`).toISOString()
}

/** Instante ISO → día 'yyyy-MM-dd' local. */
export const isoToDay = (iso: string) => format(parseISO(iso), 'yyyy-MM-dd')

/** Instante ISO → hora 'HH:mm' local (para <input type="time">). */
export const isoToTime = (iso: string) => format(parseISO(iso), 'HH:mm')

/** Hora legible: 9:30 a. m. */
export const fmtTime = (iso: string) => format(parseISO(iso), 'h:mm a', { locale: es })

/**
 * Suma minutos a una hora 'HH:mm', con tope en 23:59: el formulario agenda
 * dentro de un mismo día y un fin "al día siguiente" no cabe en un campo de hora.
 */
export function addMinutesToTime(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number)
  const total = Math.min(h * 60 + m + minutes, 23 * 60 + 59)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export function minutesBetween(start: string, end: string): number {
  const [h1, m1] = start.split(':').map(Number)
  const [h2, m2] = end.split(':').map(Number)
  return h2 * 60 + m2 - (h1 * 60 + m1)
}

/** Próxima media hora en punto (para proponer la hora de una cita de hoy). */
export function nextHalfHour(now = new Date()): string {
  const mins = now.getHours() * 60 + now.getMinutes()
  const next = Math.min(Math.ceil((mins + 1) / 30) * 30, 23 * 60 + 30)
  return `${String(Math.floor(next / 60)).padStart(2, '0')}:${String(next % 60).padStart(2, '0')}`
}

/**
 * Número para wa.me. Los de RD se escriben con 10 dígitos (809/829/849…) y
 * WhatsApp necesita el código de país delante: se antepone el 1. Con menos de
 * 10 dígitos no hay forma segura de adivinar el área, así que no se ofrece el
 * enlace (abriría el chat de otra persona o ninguno).
 */
export function whatsappNumber(phone: string | null | undefined): string | null {
  const d = digits(phone)
  if (d.length === 10) return `1${d}`
  if (d.length >= 11) return d
  return null
}

export function whatsappReminderUrl(input: {
  phone: string | null | undefined
  name: string | null
  title: string
  startsAt: string
  business: string | null
}): string | null {
  const number = whatsappNumber(input.phone)
  if (!number) return null
  const when = format(parseISO(input.startsAt), "EEEE d 'de' MMMM 'a las' h:mm a", { locale: es })
  const text = [
    `Hola${input.name ? ` ${input.name}` : ''}, le recordamos su cita de ${input.title} el ${when}`,
    input.business ? ` en ${input.business}.` : '.',
    ' Por favor, confírmenos su asistencia respondiendo este mensaje.',
  ].join('')
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`
}
