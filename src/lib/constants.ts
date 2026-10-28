import type { ModuleCode, PlanCode } from '@/types/db'
import { money } from '@/lib/format'
import { IS_HASH_ROUTER } from '@/lib/router'

// `||` y no `??`: en CI la variable existe pero puede llegar vacía.
export const APP_NAME = import.meta.env.VITE_APP_NAME || 'Ferddo'
export const APP_TAGLINE = 'POS, inventario y facturación electrónica'

/**
 * URL pública del sitio desplegado, SIN barra final.
 *
 * `||` y no `??` a propósito: en CI la variable existe pero puede llegar vacía
 * (''), y `??` solo cubre `undefined`/`null` — la app acabaría generando enlaces
 * a "/#/algo" sin dominio. Con `||`, una cadena vacía también cae al respaldo.
 */
export const PUBLIC_URL =
  (import.meta.env.VITE_PUBLIC_URL || '').replace(/\/$/, '') ||
  `${window.location.origin}${import.meta.env.BASE_URL}`.replace(/\/$/, '')

/**
 * Correo de contacto que publican las páginas legales. Es el canal por el que se
 * ejercen los derechos sobre los datos (acceso, corrección, borrado), así que
 * tiene que ser una dirección que alguien lea de verdad.
 */
export const LEGAL_CONTACT_EMAIL = 'hola@ferddo.com'

// ── Planes ──────────────────────────────────────────────────────────────────

export interface PlanInfo {
  code: PlanCode
  name: string
  /** Precio mensual anunciado, en la moneda local. */
  price: number
  /** El mismo precio en dólares, para el cobro internacional. */
  priceUsd: number
  /** Topes del plan. `null` = ilimitado. */
  maxProducts: number | null
  maxMembers: number | null
  maxBranches: number | null
  maxRegisters: number | null
  /** e-CF al mes; 0 = el plan no incluye facturación electrónica. */
  maxEcfMonthly: number | null
  /** Módulos que el plan permite; `null` = todos. */
  modules: ModuleCode[] | null
  features: string[]
  /** Si se ofrece hoy. Un plan retirado queda en `false` y deja de aparecer. */
  isOffered: boolean
  /** El que la landing resalta como "Recomendado". */
  isFeatured: boolean
  /** Orden en que se muestran. */
  sortOrder: number
}

/** Unidad del precio. Un solo sitio donde cambiar "al mes" por lo que toque. */
export const PLAN_PRICE_UNIT = 'al mes'

/**
 * VALORES DE RESPALDO, no la fuente de verdad.
 *
 * Los precios, los topes y las viñetas viven en la tabla `plan_settings`, que el
 * super-admin edita desde /admin y de la que beben los triggers de la base y la
 * UI (ver `src/hooks/plans.ts`). Esto es lo que se pinta mientras esa consulta
 * carga, o si la app abre sin conexión: sirve para que ningún plan aparezca sin
 * nombre ni precio. Manténlo alineado con la siembra de la migración 0009.
 */
export const PLANS: Record<PlanCode, PlanInfo> = {
  basic: {
    code: 'basic',
    name: 'Básico',
    price: 990,
    priceUsd: 17,
    maxProducts: 500,
    maxMembers: 2,
    maxBranches: 1,
    maxRegisters: 1,
    maxEcfMonthly: 0,
    modules: ['pos', 'inventory', 'cash', 'credit', 'reports'],
    isOffered: true,
    isFeatured: false,
    sortOrder: 1,
    features: [
      'Punto de venta y caja',
      'Productos e inventario',
      'Clientes y ventas a crédito',
      'Reportes básicos',
      '1 sucursal · 2 usuarios',
    ],
  },
  pro: {
    code: 'pro',
    name: 'Negocio',
    price: 2490,
    priceUsd: 42,
    maxProducts: null,
    maxMembers: 5,
    maxBranches: 2,
    maxRegisters: 3,
    maxEcfMonthly: 1000,
    modules: [
      'pos', 'inventory', 'cash', 'credit', 'invoicing', 'purchases',
      'expenses', 'payables', 'quotations', 'reports',
    ],
    isOffered: true,
    isFeatured: true,
    sortOrder: 2,
    features: [
      'Todo lo del Básico',
      'Facturación electrónica e-CF (hasta 1,000/mes)',
      'Compras, gastos y cuentas por pagar',
      'Cotizaciones',
      'Reportes avanzados',
      '2 sucursales · 5 usuarios',
    ],
  },
  enterprise: {
    code: 'enterprise',
    name: 'Empresa',
    price: 4990,
    priceUsd: 85,
    maxProducts: null,
    maxMembers: null,
    maxBranches: null,
    maxRegisters: null,
    maxEcfMonthly: null,
    modules: null,
    isOffered: true,
    isFeatured: false,
    sortOrder: 3,
    features: [
      'Todo lo del plan Negocio',
      'Sucursales y usuarios ilimitados',
      'e-CF sin tope mensual',
      'Módulos de restaurante y taller',
      'Soporte prioritario',
    ],
  },
}

/** Orden de respaldo. Con la tabla cargada manda `planOrderFrom()`. */
export const PLAN_ORDER: PlanCode[] = ['basic', 'pro', 'enterprise']

/**
 * Planes que se ofrecen hoy, en orden.
 *
 * Recorre TODOS los planes recibidos y no una lista fija: si partiera de
 * PLAN_ORDER, marcar un plan como visible en /admin no serviría de nada, porque
 * nunca estaría en esa lista. Si el filtro deja el resultado vacío (tabla mal
 * configurada) se cae a PLAN_ORDER: mejor enseñar los de siempre que una
 * pantalla de precios en blanco.
 */
export function planOrderFrom(plans: Record<PlanCode, PlanInfo>): PlanCode[] {
  const offered = (Object.keys(plans) as PlanCode[])
    .filter((c) => plans[c]?.isOffered !== false)
    .sort((a, b) => (plans[a]?.sortOrder ?? 99) - (plans[b]?.sortOrder ?? 99))
  return offered.length ? offered : PLAN_ORDER
}

/** Etiqueta de precio: "Gratis" o "RD$1,500 al mes". */
export function planPriceLabel(plan: PlanInfo): string {
  return plan.price === 0 ? 'Gratis' : `${money(plan.price)} ${PLAN_PRICE_UNIT}`
}

// ── Rutas públicas ──────────────────────────────────────────────────────────

/** Rutas de las páginas legales. Un solo sitio donde cambiarlas. */
export const LEGAL_PATHS = {
  privacy: '/privacidad',
  terms: '/terminos',
} as const

/**
 * Lista CERRADA de rutas que se aceptan como URL "limpia" (sin fragmento).
 * La consume `src/lib/cleanPaths.ts`; allí está el porqué. Que sea cerrada es
 * la parte de seguridad: nada que venga de la URL decide a dónde se navega.
 */
export const CLEAN_PATHS: readonly string[] = [...Object.values(LEGAL_PATHS)]

/**
 * URL ABSOLUTA de una ruta de la app: para enlaces que abren en otra pestaña,
 * para pegarla en el formulario de un tercero y para compartirla por mensaje.
 *
 * No usa `routeHref()` porque aquí el prefijo del despliegue ya viene dentro de
 * PUBLIC_URL; añadirlo otra vez duplicaría el segmento.
 */
export function appUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  return IS_HASH_ROUTER ? `${PUBLIC_URL}/#${p}` : `${PUBLIC_URL}${p}`
}

/** URL absoluta de una página legal. */
export function legalUrl(page: keyof typeof LEGAL_PATHS): string {
  return appUrl(LEGAL_PATHS[page])
}
