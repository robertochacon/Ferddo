import { format, parseISO, isValid } from 'date-fns'
import { es } from 'date-fns/locale'

/**
 * Símbolo por moneda.
 *
 * ¿Por qué una tabla y no `Intl.NumberFormat({ style: 'currency' })`? Porque
 * para varias monedas de la región Intl imprime el CÓDIGO y no el símbolo
 * ("DOP 1,500"), que no es como lo escribe nadie. Mezclar dos formatos en la
 * misma pantalla se lee como un error de la app. Una moneda que no esté en la
 * tabla cae a su código como prefijo: feo, pero nunca engaña sobre qué se cobra.
 */
const CURRENCY_SYMBOL: Record<string, string> = {
  DOP: 'RD$',
  USD: 'US$',
  EUR: '€',
  MXN: 'MX$',
  COP: 'COL$',
  PEN: 'S/',
  ARS: 'AR$',
  CLP: 'CLP$',
}

/** Formatea un monto con el símbolo de la moneda del negocio. */
export function money(amount: number | null | undefined, currency = 'DOP'): string {
  const n = Number(amount ?? 0)
  const symbol = CURRENCY_SYMBOL[currency] ?? `${currency} `
  return `${symbol}${n.toLocaleString('es-DO', {
    // Sin decimales cuando el monto es redondo ("RD$1,500", no "RD$1,500.00"):
    // la mayoría de los precios lo son y los ".00" ensucian los listados.
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
}

/**
 * Formatea un monto en dólares, SIEMPRE con dos decimales.
 *
 * Va aparte de `money()` porque el precio en USD no es la moneda del negocio:
 * es la referencia internacional del plan (`plan_settings.price_usd`), la que
 * se enseña cuando el cobro no puede hacerse en moneda local.
 */
export function usd(amount: number | null | undefined): string {
  return `US$${Number(amount ?? 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/** Número con separadores de miles. */
export function num(n: number | null | undefined): string {
  return Number(n ?? 0).toLocaleString('es-DO')
}

/**
 * Normaliza a `Date` o devuelve null. Centraliza el parseo para que ningún
 * `new Date('2026-03-01')` se cuele: ese constructor lee las fechas sin hora
 * como UTC y en América restan un día. `parseISO` las lee como locales.
 */
function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  const d = typeof value === 'string' ? parseISO(value) : value
  return isValid(d) ? d : null
}

/** Fecha larga: 19 de mar 2026. */
export function fmtDate(value: string | Date | null | undefined): string {
  const d = toDate(value)
  return d ? format(d, "d 'de' MMM yyyy", { locale: es }) : '—'
}

/** Fecha compacta para tablas: 19/03/2026. */
export function fmtDateShort(value: string | Date | null | undefined): string {
  const d = toDate(value)
  return d ? format(d, 'dd/MM/yyyy', { locale: es }) : '—'
}

/** Fecha + hora: 19 mar 2026, 3:20 p. m. */
export function fmtDateTime(value: string | Date | null | undefined): string {
  const d = toDate(value)
  return d ? format(d, 'd MMM yyyy, h:mm a', { locale: es }) : '—'
}

/** Día de la semana capitalizado (date-fns lo devuelve en minúscula en español). */
export function fmtWeekday(value: string | Date | null | undefined): string {
  const d = toDate(value)
  if (!d) return '—'
  const s = format(d, 'EEEE', { locale: es })
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Iniciales para el avatar cuando no hay foto. */
export function initials(name: string | null | undefined): string {
  if (!name) return '?'
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}

/** Solo los dígitos de un teléfono (para `tel:` y enlaces de mensajería). */
export function digits(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '')
}

/**
 * Normaliza un texto para COMPARARLO, no para mostrarlo: sin espacios de sobra,
 * colapsando los repetidos y en minúsculas.
 *
 * Tiene un gemelo EXACTO en SQL (`norm_name()`, migración 0011): la
 * confirmación por nombre al eliminar un negocio se valida en los dos lados, y
 * si no dijeran lo mismo la UI habilitaría un botón que el servidor rechaza.
 * Ojo al portarla: en JavaScript `trim()` y `\s` YA incluyen el espacio duro
 * (U+00A0) — justo el que pega un navegador o un chat al copiar un nombre —,
 * pero en Postgres `[[:space:]]` no lo cubre y allí hay que quitarlo aparte.
 */
export function norm(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}
