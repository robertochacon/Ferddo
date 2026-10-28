import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  BarChart3,
  Boxes,
  Briefcase,
  CalendarClock,
  Check,
  ChevronDown,
  Coffee,
  FileCheck2,
  FileText,
  Hammer,
  HandCoins,
  Menu,
  MonitorSmartphone,
  ShieldCheck,
  Shirt,
  ShoppingCart,
  Stethoscope,
  Store,
  Truck,
  Users,
  UtensilsCrossed,
  Wallet,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'
import { usePlanSettings, toPlanMap } from '@/hooks/plans'
import { money } from '@/lib/format'
import {
  APP_NAME,
  APP_TAGLINE,
  LEGAL_CONTACT_EMAIL,
  LEGAL_PATHS,
  PLAN_PRICE_UNIT,
  planOrderFrom,
  type PlanInfo,
} from '@/lib/constants'
import { Wordmark } from '@/components/Logo'
import { cn } from '@/lib/cn'
import type { PlanCode } from '@/types/db'

/**
 * Página pública: es lo que ve en `/` quien NO tiene sesión (App.tsx la monta
 * desde el guard, sin redirigir).
 *
 * Reglas de contenido, no negociables:
 * - Nada de cifras inventadas ni testimonios de mentira. La franja de confianza
 *   dice hechos del producto, que son verificables.
 * - Facturación electrónica: Ferddo está «preparado para» e-CF. NUNCA decir que
 *   está certificado, homologado ni autorizado por la DGII: la autorización como
 *   emisor electrónico es un trámite de cada contribuyente, y afirmar lo
 *   contrario sería publicidad engañosa.
 * - Fechas de la DGII siempre con «según DGII, verifica tu calendario»: el
 *   calendario lo publica y lo mueve la DGII, no nosotros.
 */
export function LandingPage() {
  return (
    <div className="min-h-[100dvh] bg-slate-50 font-sans text-brand-950">
      <Navbar />
      <Hero />
      <TrustBar />
      <BusinessTypes />
      <Features />
      <EcfSection />
      <Pricing />
      <Faq />
      <FinalCta />
      <Footer />
    </div>
  )
}

/* ── Utilidades de la página ────────────────────────────────────────────── */

/** Desplaza suavemente a una sección por id (sin tocar el hash del router). */
function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/**
 * Enlace a una sección de esta misma página.
 *
 * Es un `<a href="#seccion">` DE VERDAD, no un botón: así el rastreador lo ve.
 * El `preventDefault` es obligatorio con HashRouter: dejar que el navegador
 * salte cambiaría el fragmento, que es donde vive la ruta, y la app entera se
 * remontaría en una ruta inexistente.
 */
function SectionLink({
  id,
  className,
  children,
  onNavigate,
}: {
  id: string
  className?: string
  children: ReactNode
  onNavigate?: () => void
}) {
  return (
    <a
      href={`#${id}`}
      className={className}
      onClick={(e) => {
        e.preventDefault()
        scrollToId(id)
        onNavigate?.()
      }}
    >
      {children}
    </a>
  )
}

/**
 * Planes tal como se anuncian. Salen de `plan_settings`, que la RLS deja leer
 * SIN sesión justo para esto: la landing publica los precios que el super-admin
 * tenga puestos. Mientras carga —o sin red— `toPlanMap` cae a las constantes de
 * respaldo, así que nunca hay una tabla de precios en blanco.
 */
function usePlans(): Record<PlanCode, PlanInfo> {
  const { data } = usePlanSettings()
  return useMemo(() => toPlanMap(data), [data])
}

function SectionHeading({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow?: string
  title: string
  subtitle?: string
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      {eyebrow && <p className="mb-2 text-sm font-bold uppercase tracking-widest text-mint-600">{eyebrow}</p>}
      <h2 className="text-3xl font-extrabold tracking-tight text-brand-950 sm:text-4xl">{title}</h2>
      {subtitle && <p className="mt-3 text-lg text-slate-600">{subtitle}</p>}
    </div>
  )
}

/* ── Barra de navegación ────────────────────────────────────────────────── */

const NAV_LINKS = [
  { id: 'negocios', label: 'Para quién' },
  { id: 'funciones', label: 'Funciones' },
  { id: 'ecf', label: 'e-CF' },
  { id: 'precios', label: 'Precios' },
  { id: 'faq', label: 'Preguntas' },
] as const

function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const closeMenu = () => setMenuOpen(false)

  useEffect(() => {
    if (!menuOpen) return
    // Escape cierra y devuelve el foco al botón que lo abrió.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setMenuOpen(false)
      toggleRef.current?.focus()
    }
    // Al pasar a escritorio se cierra: el panel es `md:hidden` y se quedaría
    // abierto pero invisible, con el botón mostrando la X.
    const desktop = window.matchMedia('(min-width: 768px)')
    const onBreakpoint = () => desktop.matches && setMenuOpen(false)
    document.addEventListener('keydown', onKey)
    desktop.addEventListener('change', onBreakpoint)
    return () => {
      document.removeEventListener('keydown', onKey)
      desktop.removeEventListener('change', onBreakpoint)
    }
  }, [menuOpen])

  return (
    <>
      {menuOpen && <div className="fixed inset-0 z-40 bg-brand-950/30 md:hidden" onClick={closeMenu} aria-hidden />}
      <nav className="sticky top-0 z-50 border-b border-slate-200/70 bg-white/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <Link to="/" aria-label={`${APP_NAME}, inicio`}>
            <Wordmark />
          </Link>
          <div className="hidden items-center gap-7 md:flex">
            {NAV_LINKS.map((l) => (
              <SectionLink
                key={l.id}
                id={l.id}
                className="whitespace-nowrap text-sm font-semibold text-slate-500 transition-colors hover:text-brand-600"
              >
                {l.label}
              </SectionLink>
            ))}
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <Link
              to="/login"
              className="hidden rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 transition-colors hover:text-brand-600 sm:inline-flex"
            >
              Iniciar sesión
            </Link>
            <Link
              to="/registro"
              className="whitespace-nowrap rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:bg-brand-700 active:scale-95"
            >
              Probar gratis
            </Link>
            <button
              ref={toggleRef}
              type="button"
              aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'}
              aria-expanded={menuOpen}
              aria-controls="menu-movil"
              className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 md:hidden"
              onClick={() => setMenuOpen((o) => !o)}
            >
              {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {/* `absolute` y opaco: un panel en flujo empujaría la página y el
            destino que calcula `scrollIntoView` quedaría desplazado. */}
        {menuOpen && (
          <div
            id="menu-movil"
            className="absolute inset-x-0 top-full max-h-[calc(100dvh-4rem)] overflow-y-auto border-b border-slate-200/70 bg-white px-4 pb-4 pt-2 shadow-card-hover animate-fade-in md:hidden"
          >
            {NAV_LINKS.map((l) => (
              <SectionLink
                key={l.id}
                id={l.id}
                onNavigate={closeMenu}
                className="block rounded-lg px-3 py-3 text-base font-semibold text-slate-700 transition-colors hover:bg-brand-50 hover:text-brand-600"
              >
                {l.label}
              </SectionLink>
            ))}
            <Link
              to="/login"
              onClick={closeMenu}
              className="mt-2 flex items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-3 text-base font-semibold text-slate-700 transition-colors hover:border-brand-200 hover:text-brand-600 sm:hidden"
            >
              Iniciar sesión
            </Link>
          </div>
        )}
      </nav>
    </>
  )
}

/* ── Hero ───────────────────────────────────────────────────────────────── */

function Hero() {
  return (
    <section className="relative overflow-hidden bg-white">
      {/* Trama de puntos: profundidad sin una imagen más en la primera pantalla. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage: 'radial-gradient(circle at 2px 2px, rgba(26,92,230,0.07) 1px, transparent 0)',
          backgroundSize: '24px 24px',
        }}
      />
      <div className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-mint-200/40 blur-3xl" />
      <div className="relative mx-auto grid max-w-7xl grid-cols-1 items-center gap-12 px-4 pb-16 pt-10 sm:px-6 lg:grid-cols-2 lg:px-8 lg:pb-24 lg:pt-16">
        <div className="text-center lg:text-left">
          <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-mint-200 bg-mint-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-mint-800">
            <FileCheck2 className="h-4 w-4" />
            Preparado para facturación electrónica e-CF
          </span>
          <h1 className="text-4xl font-extrabold leading-[1.1] tracking-tight text-brand-950 sm:text-5xl lg:text-[3.4rem]">
            POS, inventario y facturación electrónica{' '}
            <span className="bg-gradient-to-r from-brand-600 to-mint-500 bg-clip-text text-transparent">
              para tu negocio en RD
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-slate-600 lg:mx-0">
            Vende rápido, controla tu inventario por sucursal, cuadra la caja y lleva tus créditos,
            compras y gastos en un solo lugar. {APP_NAME} funciona en la computadora, la tableta o
            el teléfono.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row lg:justify-start">
            <Link
              to="/registro"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-8 py-4 text-base font-semibold text-white shadow-xl shadow-brand-600/25 transition-all hover:-translate-y-0.5 hover:bg-brand-700"
            >
              Empieza tu prueba gratis
              <ArrowRight className="h-5 w-5" />
            </Link>
            <SectionLink
              id="funciones"
              className="inline-flex items-center justify-center gap-2 rounded-xl border-2 border-brand-200 px-8 py-4 text-base font-semibold text-brand-700 transition-all hover:bg-brand-50"
            >
              Ver funciones
            </SectionLink>
          </div>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm text-slate-500 lg:justify-start">
            {['Sin tarjeta para empezar', 'ITBIS y RNC incluidos', 'Varias sucursales y cajas'].map((t) => (
              <span key={t} className="inline-flex items-center gap-1.5">
                <Check className="h-4 w-4 text-mint-500" /> {t}
              </span>
            ))}
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-sm">
          <div className="absolute -inset-6 rounded-[40px] bg-brand-500/10 blur-3xl" />
          <PosMockup />
        </div>
      </div>
    </section>
  )
}

/**
 * Vista previa del punto de venta dentro de un marco (puro CSS: una captura
 * real se queda vieja en el primer rediseño y pesa más que todo el hero).
 * Los productos y montos son ilustrativos.
 */
function PosMockup() {
  const lines = [
    { name: 'Arroz selecto 5 lb', qty: 2, price: 245 },
    { name: 'Aceite de soya 1 L', qty: 1, price: 210 },
    { name: 'Salami 1 lb', qty: 1, price: 185 },
    { name: 'Refresco 2 L', qty: 3, price: 95 },
  ]
  const total = lines.reduce((s, l) => s + l.qty * l.price, 0)
  // Precios con ITBIS incluido (lo habitual en RD): el impuesto se despeja.
  const itbis = total - total / 1.18
  return (
    <div className="relative rounded-[2rem] border-[6px] border-brand-950 bg-white p-3 shadow-2xl">
      <div className="absolute -right-3 top-8 z-10 flex items-center gap-1 rounded-lg bg-mint-400 px-2.5 py-1.5 text-xs font-bold text-brand-950 shadow-lg">
        <FileCheck2 className="h-4 w-4" /> e-CF listo
      </div>
      <div className="rounded-3xl bg-slate-50 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-slate-400">Caja 1 · Principal</p>
            <h3 className="text-lg font-bold text-brand-950">Nueva venta</h3>
          </div>
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">Caja abierta</span>
        </div>
        <div className="mt-3 space-y-1.5">
          {lines.map((l) => (
            <div key={l.name} className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 shadow-card">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand-50 text-[11px] font-bold text-brand-700">
                {l.qty}
              </span>
              <p className="min-w-0 flex-1 truncate text-xs font-semibold text-brand-950">{l.name}</p>
              <span className="text-xs font-medium tabular-nums text-slate-600">{money(l.qty * l.price)}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 rounded-2xl bg-white p-3 shadow-card">
          <div className="flex justify-between text-xs text-slate-500">
            <span>ITBIS incluido</span>
            <span className="tabular-nums">{money(Math.round(itbis * 100) / 100)}</span>
          </div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-sm font-semibold text-slate-700">Total</span>
            <span className="text-xl font-extrabold tabular-nums text-brand-950">{money(total)}</span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-1.5 text-[11px] font-semibold">
            <span className="rounded-lg bg-brand-600 py-2 text-center text-white">Efectivo</span>
            <span className="rounded-lg bg-slate-100 py-2 text-center text-slate-600">Tarjeta</span>
            <span className="rounded-lg bg-slate-100 py-2 text-center text-slate-600">Crédito</span>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Franja de confianza ────────────────────────────────────────────────── */

/** Hechos del producto, no métricas de vanidad. */
function TrustBar() {
  const items = [
    { icon: Store, big: 'Hecho para RD', small: 'ITBIS, RNC, cédula y provincias' },
    { icon: ShieldCheck, big: 'Tus datos, aislados', small: 'Ninguna empresa ve la de otra' },
    { icon: MonitorSmartphone, big: 'En cualquier pantalla', small: 'Se instala como app, sin tienda' },
  ]
  return (
    <section className="bg-brand-950">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-6 px-4 py-8 sm:px-6 md:grid-cols-3 lg:px-8">
        {items.map((it) => (
          <div key={it.big} className="flex items-center gap-4">
            <div className="rounded-xl bg-white/10 p-3">
              <it.icon className="h-6 w-6 text-mint-300" />
            </div>
            <div>
              <div className="text-lg font-bold text-white">{it.big}</div>
              <div className="text-sm text-white/60">{it.small}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/* ── Para quién ─────────────────────────────────────────────────────────── */

const BUSINESSES: { icon: LucideIcon; label: string; desc: string }[] = [
  { icon: Store, label: 'Colmados', desc: 'Venta rápida, fiado con límite y cuadre diario.' },
  { icon: Hammer, label: 'Ferreterías', desc: 'Miles de artículos, cotizaciones y compras a suplidores.' },
  { icon: Shirt, label: 'Tiendas', desc: 'Ropa, repuestos, minimarkets: inventario por sucursal.' },
  { icon: Coffee, label: 'Cafeterías', desc: 'Cobro ágil en mostrador y control de insumos.' },
  { icon: UtensilsCrossed, label: 'Restaurantes', desc: 'Ventas, caja y gastos del día en un solo cierre.' },
  { icon: Wrench, label: 'Talleres', desc: 'Servicios y repuestos en la misma factura.' },
  { icon: Stethoscope, label: 'Consultorios', desc: 'Servicios, cobros pendientes y comprobantes.' },
  { icon: Briefcase, label: 'Servicios', desc: 'Oficinas y profesionales que facturan a empresas.' },
]

function BusinessTypes() {
  return (
    <section id="negocios" className="scroll-mt-20 bg-slate-50 py-16 lg:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Para quién es"
          title="Pensado para el negocio dominicano"
          subtitle="Al crear tu cuenta eliges tu tipo de negocio y activamos solo los módulos que te sirven."
        />
        <div className="mt-12 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {BUSINESSES.map((b) => (
            <div key={b.label} className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-card sm:p-5">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                <b.icon className="h-5 w-5" />
              </div>
              <h3 className="font-bold text-brand-950">{b.label}</h3>
              <p className="mt-1 text-sm text-slate-600">{b.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ── Funciones ──────────────────────────────────────────────────────────── */

const FEATURE_TONE = {
  brand: 'bg-brand-50 text-brand-600',
  mint: 'bg-mint-50 text-mint-600',
  accent: 'bg-accent-100 text-accent-600',
} as const

const FEATURES: { icon: LucideIcon; title: string; desc: string; tone: keyof typeof FEATURE_TONE }[] = [
  {
    icon: ShoppingCart,
    title: 'POS táctil',
    desc: 'Busca por nombre o código de barras, cobra en efectivo, tarjeta, transferencia o crédito, y entrega el recibo en segundos.',
    tone: 'brand',
  },
  {
    icon: Boxes,
    title: 'Inventario por sucursal',
    desc: 'Existencias por sucursal, alertas de mínimo, transferencias y kardex con cada entrada y salida.',
    tone: 'mint',
  },
  {
    icon: Wallet,
    title: 'Caja y arqueo',
    desc: 'Apertura con fondo, entradas y salidas de efectivo y cierre con arqueo: sabes si la caja cuadra.',
    tone: 'accent',
  },
  {
    icon: HandCoins,
    title: 'Ventas a crédito',
    desc: 'Fía con límite por cliente, registra abonos y ve quién te debe y desde cuándo.',
    tone: 'brand',
  },
  {
    icon: Truck,
    title: 'Compras y gastos',
    desc: 'Compras a suplidores que suben el inventario, cuentas por pagar y gastos del negocio.',
    tone: 'mint',
  },
  {
    icon: FileText,
    title: 'Cotizaciones',
    desc: 'Envía una cotización y conviértela en venta con un toque cuando el cliente confirme.',
    tone: 'accent',
  },
  {
    icon: BarChart3,
    title: 'Reportes',
    desc: 'Ventas por día, productos más vendidos, ITBIS del mes y margen bruto, sin armar hojas de cálculo.',
    tone: 'brand',
  },
  {
    icon: Users,
    title: 'Equipo con permisos',
    desc: 'Cajeros, vendedores, supervisores: cada quien con su cuenta, su rol y sus sucursales.',
    tone: 'mint',
  },
  {
    icon: FileCheck2,
    title: 'e-CF preparado para DGII',
    desc: 'Comprobantes fiscales electrónicos generados desde la venta, con su estado a la vista.',
    tone: 'accent',
  },
]

function Features() {
  return (
    <section id="funciones" className="scroll-mt-20 bg-white py-16 lg:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Funciones"
          title="Todo lo que usas en el día a día"
          subtitle="Del primer cliente de la mañana al cuadre de la noche."
        />
        <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border border-slate-200/70 bg-white p-6 shadow-card transition-all duration-300 hover:-translate-y-1 hover:shadow-card-hover"
            >
              <div className={cn('mb-4 flex h-12 w-12 items-center justify-center rounded-xl', FEATURE_TONE[f.tone])}>
                <f.icon className="h-6 w-6" />
              </div>
              <h3 className="mb-1.5 text-lg font-bold text-brand-950">{f.title}</h3>
              <p className="text-slate-600">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ── Facturación electrónica ────────────────────────────────────────────── */

function EcfSection() {
  const points = [
    'Genera el e-CF desde la misma venta, sin volver a digitar nada.',
    'Consumidor final y crédito fiscal, con el RNC o la cédula del cliente.',
    'Ves el estado de cada comprobante y reintentas los que fallen.',
    'Notas de crédito ligadas a la devolución.',
  ]
  return (
    <section id="ecf" className="scroll-mt-20 bg-slate-50 py-16 lg:py-24">
      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-10 px-4 sm:px-6 lg:grid-cols-2 lg:px-8">
        <div>
          <p className="mb-2 text-sm font-bold uppercase tracking-widest text-mint-600">Facturación electrónica</p>
          <h2 className="text-3xl font-extrabold tracking-tight text-brand-950 sm:text-4xl">
            Llega a la factura electrónica sin cambiar tu forma de vender
          </h2>
          <p className="mt-4 text-lg text-slate-600">
            {APP_NAME} está preparado para emitir comprobantes fiscales electrónicos (e-CF) según el
            formato de la DGII. Tu negocio sigue vendiendo igual; el comprobante sale de la venta.
          </p>
          <ul className="mt-6 space-y-3">
            {points.map((p) => (
              <li key={p} className="flex items-start gap-3 text-slate-700">
                <Check className="mt-0.5 h-5 w-5 shrink-0 text-mint-500" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-3xl border border-accent-200 bg-white p-6 shadow-card sm:p-8">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-100 text-accent-700">
              <CalendarClock className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-500">Fecha límite para pequeños contribuyentes</p>
              <p className="text-2xl font-extrabold text-brand-950">15 de noviembre de 2026</p>
            </div>
          </div>
          <p className="mt-4 text-sm text-slate-600">
            Según el calendario de implementación de la DGII (Ley 32-23), los pequeños y micro
            contribuyentes deben emitir e-CF a partir de esa fecha. <strong>Verifica tu calendario</strong>{' '}
            con la DGII: la fecha que te toca depende de tu clasificación.
          </p>
          <p className="mt-3 rounded-xl bg-slate-50 p-3 text-xs text-slate-500">
            Para emitir e-CF cada empresa debe completar su propia autorización como emisor
            electrónico ante la DGII. {APP_NAME} te da la herramienta preparada; el trámite de
            autorización es de tu negocio.
          </p>
        </div>
      </div>
    </section>
  )
}

/* ── Precios ────────────────────────────────────────────────────────────── */

function Pricing() {
  const plans = usePlans()
  // Recorre los planes CONFIGURADOS: publicar o retirar uno desde /admin se
  // refleja aquí sin tocar código.
  const visibles = planOrderFrom(plans).map((c) => plans[c])

  return (
    <section id="precios" className="scroll-mt-20 bg-white py-16 lg:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Precios"
          title="Un plan para cada etapa de tu negocio"
          subtitle="Precios en pesos dominicanos, al mes. Empieza con una prueba gratis y cambia de plan cuando lo necesites."
        />
        <div className="mx-auto mt-12 grid max-w-6xl grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {visibles.map((p) => (
            <PlanCard key={p.code} plan={p} />
          ))}
        </div>
        <p className="mt-8 text-center text-sm text-slate-500">
          Los topes de cada plan se aplican en el servidor. Por ahora el pago se coordina
          directamente con nuestro equipo (transferencia o depósito).
        </p>
      </div>
    </section>
  )
}

function PlanCard({ plan }: { plan: PlanInfo }) {
  const featured = plan.isFeatured
  const free = plan.price === 0

  return (
    <div
      className={cn(
        'relative flex flex-col rounded-[28px] p-7 text-left',
        featured
          ? 'bg-brand-950 text-white shadow-2xl shadow-brand-950/30 lg:-my-3 lg:py-10'
          : 'border border-slate-200 bg-white',
      )}
    >
      {featured && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-mint-400 px-4 py-1 text-xs font-bold uppercase tracking-widest text-brand-950 shadow-md">
          Recomendado
        </span>
      )}
      <h3 className={cn('text-xl font-bold', !featured && 'text-brand-950')}>{plan.name}</h3>
      <p className={cn('mt-3 text-4xl font-black', !featured && 'text-brand-950')}>
        {free ? 'Gratis' : money(plan.price)}
        {!free && (
          <span className={cn('text-base font-medium', featured ? 'text-white/60' : 'text-slate-400')}>
            {` ${PLAN_PRICE_UNIT}`}
          </span>
        )}
      </p>
      <ul className="mt-6 flex-1 space-y-3">
        {plan.features.map((f) => (
          <li key={f} className={cn('flex items-start gap-3 text-sm', !featured && 'text-slate-600')}>
            <Check className={cn('mt-0.5 h-5 w-5 flex-shrink-0', featured ? 'text-mint-300' : 'text-brand-600')} />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      <Link
        to="/registro"
        className={cn(
          'mt-8 inline-flex w-full items-center justify-center rounded-xl py-3.5 font-bold transition-all',
          featured
            ? 'bg-mint-400 text-brand-950 shadow-xl hover:bg-mint-300'
            : 'border-2 border-brand-600 text-brand-700 hover:bg-brand-50',
        )}
      >
        Empezar prueba gratis
      </Link>
    </div>
  )
}

/* ── Preguntas frecuentes ───────────────────────────────────────────────── */

function Faq() {
  const plans = usePlans()
  const order = planOrderFrom(plans)
  const cheapest = order.length ? plans[order[0]] : plans.basic
  const items = [
    {
      q: `¿${APP_NAME} está certificado por la DGII?`,
      a: `No decimos eso, porque la autorización como emisor electrónico la obtiene cada contribuyente ante la DGII. ${APP_NAME} está preparado para el formato e-CF y te acompaña en el proceso; mientras tanto puedes usar el punto de venta, el inventario y la caja desde el primer día.`,
    },
    {
      q: '¿Cuándo tengo que facturar electrónicamente?',
      a: 'Según el calendario de la DGII, los pequeños y micro contribuyentes tienen como fecha límite el 15 de noviembre de 2026; otros grupos tienen fechas distintas. Verifica tu calendario en la DGII, porque depende de tu clasificación.',
    },
    {
      q: '¿Necesito instalar algo o comprar equipos especiales?',
      a: 'No. Se abre en el navegador de tu computadora, tableta o teléfono, y puedes añadirlo a la pantalla de inicio como una app. Funciona con lectores de código de barras e impresoras térmicas de 58 u 80 mm.',
    },
    {
      q: '¿Puedo manejar varias sucursales y cajas?',
      a: 'Sí. Cada sucursal lleva su propio inventario y sus cajas, y puedes limitar a cada empleado a las sucursales donde trabaja. La cantidad depende de tu plan.',
    },
    {
      q: '¿Mis empleados pueden ver todo?',
      a: 'Solo lo que su rol permite. Hay roles listos (cajero, vendedor, supervisor, inventario, contabilidad…) y puedes ajustar los permisos de cada uno: anular ventas, dar descuentos, ver todas las cajas, etc.',
    },
    {
      q: '¿Mis datos están separados de los de otros negocios?',
      a: 'Sí. Cada empresa es un espacio aparte y la separación la aplica la base de datos, no la pantalla: aunque alguien lo intentara, una empresa no puede leer los datos de otra.',
    },
    {
      q: '¿Cuánto cuesta y cómo pago?',
      a: `Los planes empiezan en ${cheapest.price === 0 ? 'gratis' : `${money(cheapest.price)} ${PLAN_PRICE_UNIT}`} y empiezas con una prueba gratuita, sin tarjeta. Por ahora el pago se coordina directamente con nuestro equipo por transferencia o depósito.`,
    },
  ]
  return (
    <section id="faq" className="scroll-mt-20 bg-slate-50 py-16 lg:py-24">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <SectionHeading eyebrow="Preguntas" title="Preguntas frecuentes" />
        <div className="mt-10 space-y-3">
          {/* <details> nativo: acordeón accesible sin JavaScript, y Ctrl+F
              encuentra el texto de dentro. */}
          {items.map((it, i) => (
            <details key={it.q} open={i === 0} className="group overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5 font-semibold text-brand-950">
                {it.q}
                <ChevronDown className="h-5 w-5 flex-shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
              </summary>
              <div className="border-t border-slate-100 p-5 pt-4 text-slate-600">{it.a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ── Llamada final ──────────────────────────────────────────────────────── */

function FinalCta() {
  return (
    <section className="bg-slate-50 px-4 pb-16 sm:px-6 lg:px-8 lg:pb-24">
      <div className="relative mx-auto max-w-7xl overflow-hidden rounded-[36px] bg-gradient-to-br from-brand-600 to-brand-900 p-10 text-center text-white shadow-2xl sm:p-16">
        <div className="absolute -left-20 -top-20 h-80 w-80 rounded-full bg-mint-400/20 blur-3xl" />
        <div className="relative">
          <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Pon tu negocio en orden hoy</h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-white/80">
            Crea tu cuenta, elige tu tipo de negocio y haz tu primera venta en minutos.
          </p>
          <Link
            to="/registro"
            className="mt-8 inline-flex items-center justify-center gap-2 rounded-2xl bg-mint-400 px-10 py-5 text-lg font-bold text-brand-950 shadow-2xl transition-all hover:scale-105 hover:bg-mint-300 active:scale-95"
          >
            Crear mi cuenta gratis
            <ArrowRight className="h-5 w-5" />
          </Link>
        </div>
      </div>
    </section>
  )
}

/* ── Pie ────────────────────────────────────────────────────────────────── */

function Footer() {
  // `id` = sección de esta página · `to` = otra ruta · `href` = enlace externo.
  const cols: { title: string; items: { label: string; id?: string; to?: string; href?: string }[] }[] = [
    {
      title: 'Producto',
      items: [
        { label: 'Para quién', id: 'negocios' },
        { label: 'Funciones', id: 'funciones' },
        { label: 'Facturación electrónica', id: 'ecf' },
        { label: 'Precios', id: 'precios' },
      ],
    },
    {
      title: 'Cuenta',
      items: [
        { label: 'Iniciar sesión', to: '/login' },
        { label: 'Crear cuenta', to: '/registro' },
        { label: 'Contacto', href: `mailto:${LEGAL_CONTACT_EMAIL}` },
      ],
    },
    {
      title: 'Legal',
      items: [
        { label: 'Privacidad', to: LEGAL_PATHS.privacy },
        { label: 'Términos', to: LEGAL_PATHS.terms },
      ],
    },
  ]
  const linkCls = 'text-white/55 transition-colors hover:text-mint-300'
  return (
    <footer className="bg-brand-950 py-14 text-white">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col justify-between gap-10 md:flex-row">
          <div className="max-w-xs">
            <Wordmark dark />
            <p className="mt-4 text-sm text-white/60">
              {APP_TAGLINE} para negocios de República Dominicana.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
            {cols.map((c) => (
              <div key={c.title}>
                <h2 className="mb-4 font-bold text-white">{c.title}</h2>
                <ul className="space-y-2.5 text-sm">
                  {c.items.map((it) => (
                    <li key={it.label}>
                      {it.id ? (
                        <SectionLink id={it.id} className={linkCls}>{it.label}</SectionLink>
                      ) : it.to ? (
                        <Link to={it.to} className={linkCls}>{it.label}</Link>
                      ) : (
                        <a href={it.href} className={cn(linkCls, 'break-words')}>{it.label}</a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        {/* El año se calcula: un «© 2026» escrito a mano envejece en enero. */}
        <div className="mt-12 border-t border-white/10 pt-6 text-center text-xs text-white/40">
          © {new Date().getFullYear()} {APP_NAME}. Todos los derechos reservados. {APP_NAME} no es
          una entidad de la DGII ni está afiliado a ella.
        </div>
      </div>
    </footer>
  )
}
