import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  BarChart3, Building2, CreditCard, History, LifeBuoy, LogOut, ShieldCheck, type LucideIcon,
} from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { Wordmark, Logo } from '@/components/Logo'
import { Badge } from '@/components/ui/Badge'
import { Avatar } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'

export type AdminSection = 'resumen' | 'negocios' | 'planes' | 'bitacora' | 'equipo'

interface SectionDef {
  id: AdminSection
  label: string
  /** Etiqueta corta de la barra inferior del teléfono (cinco en 360 px). */
  short: string
  icon: LucideIcon
}

/**
 * UNA lista para la barra lateral y la inferior, como `NAV` en Layout: una
 * sección nueva no puede aparecer en escritorio y faltar en el teléfono.
 */
export const ADMIN_SECTIONS: SectionDef[] = [
  { id: 'resumen', label: 'Resumen', short: 'Resumen', icon: BarChart3 },
  { id: 'negocios', label: 'Negocios', short: 'Negocios', icon: Building2 },
  { id: 'planes', label: 'Planes', short: 'Planes', icon: CreditCard },
  { id: 'bitacora', label: 'Bitácora', short: 'Bitácora', icon: History },
  { id: 'equipo', label: 'Super-admins', short: 'Admins', icon: ShieldCheck },
]

/** La sección va en la URL (?s=negocios): el botón «atrás» funciona y se puede enlazar. */
export const sectionHref = (id: AdminSection) => (id === 'resumen' ? '/admin' : `/admin?s=${id}`)

/**
 * Cascarón del panel de plataforma: menú a la izquierda (desde `lg`), barra
 * inferior en el teléfono y cabecera con el título de la sección. Calcado de
 * `Layout` para que el super-admin se mueva igual que en la app del negocio.
 *
 * Va aparte de `Layout` a propósito: el super-admin no tiene negocio, así que
 * los destinos de la app (POS, Inventario…) no le llevan a ninguna parte.
 *
 * La sección activa la decide quien lo usa: las secciones viven en `?s=` y
 * `NavLink` no compara la búsqueda; además el detalle de un negocio debe
 * marcar «Negocios».
 */
export function AdminShell({
  section,
  title,
  actions,
  children,
}: {
  section: AdminSection
  title: ReactNode
  /** Botones a la derecha de la cabecera (Actualizar…). */
  actions?: ReactNode
  children: ReactNode
}) {
  const { user, signOut, tenant: supportTenant, exitSupport } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()

  const handleSignOut = async () => {
    await signOut()
    navigate('/login')
  }

  return (
    <div className="min-h-[100dvh] bg-slate-100">
      {/* ── Barra lateral (desde lg) ─────────────────────────────────────── */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-slate-200 bg-white lg:flex">
        <div className="flex h-16 items-center gap-2 px-5">
          <Wordmark />
          <Badge tone="brand" className="ml-auto shrink-0">
            <ShieldCheck className="h-3.5 w-3.5" /> Admin
          </Badge>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2" aria-label="Secciones del panel">
          <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Plataforma</p>
          {ADMIN_SECTIONS.map((s) => (
            <Link
              key={s.id}
              to={sectionHref(s.id)}
              aria-current={s.id === section ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
                s.id === section ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
              )}
            >
              <s.icon className="h-5 w-5 shrink-0" />
              {s.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-slate-100 p-3">
          <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2">
            <Avatar name={user?.email} size="sm" />
            <span className="min-w-0 flex-1 truncate text-xs text-slate-600">{user?.email}</span>
            <button type="button" onClick={() => void handleSignOut()} aria-label="Cerrar sesión" title="Cerrar sesión"
              className="shrink-0 rounded-lg p-1.5 text-red-600 hover:bg-red-50">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Contenido ────────────────────────────────────────────────────── */}
      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-slate-200 bg-white/90 px-3 backdrop-blur sm:px-4">
          <Logo className="h-8 w-8 lg:hidden" decorative />
          <h1 className="min-w-0 flex-1 truncate text-lg font-bold text-slate-900">{title}</h1>
          {actions}
          {/* En el teléfono no hay barra lateral: la salida va en la cabecera. */}
          <button type="button" onClick={() => void handleSignOut()} aria-label="Cerrar sesión"
            className="rounded-lg p-2 text-red-600 hover:bg-red-50 lg:hidden">
            <LogOut className="h-5 w-5" />
          </button>
        </header>

        {/* Si se vuelve al panel sin salir del modo soporte, el acceso sigue
            abierto: se recuerda aquí para que no quede olvidado hasta que caduque. */}
        {supportTenant && (
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-500 px-4 py-1.5 text-center text-xs font-semibold text-amber-950">
            <span className="inline-flex items-center gap-1.5">
              <LifeBuoy className="h-3.5 w-3.5" /> Sigues dentro de {supportTenant.name} en modo soporte
            </span>
            <button type="button" onClick={() => navigate('/')} className="rounded-md bg-amber-950/10 px-2 py-0.5 hover:bg-amber-950/20">
              Volver al negocio
            </button>
            <button type="button" onClick={() => void exitSupport().catch((err) => toast.error(errorMessage(err)))}
              className="rounded-md bg-amber-950/10 px-2 py-0.5 hover:bg-amber-950/20">
              Salir del modo soporte
            </button>
          </div>
        )}

        {/* `pb-24` en móvil: la barra inferior es fija y taparía lo último. */}
        <main className="mx-auto w-full max-w-6xl px-3 py-5 pb-24 sm:px-4 lg:pb-8">{children}</main>
      </div>

      {/* ── Barra inferior (solo móvil) ──────────────────────────────────── */}
      <nav aria-label="Secciones del panel"
        className="fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        {ADMIN_SECTIONS.map((s) => (
          <Link
            key={s.id}
            to={sectionHref(s.id)}
            aria-current={s.id === section ? 'page' : undefined}
            className={cn('flex flex-1 flex-col items-center gap-0.5 py-2', s.id === section ? 'text-brand-600' : 'text-slate-500')}
          >
            <s.icon className="h-5 w-5" />
            <span className="max-w-full truncate px-1 text-[10px] font-medium">{s.short}</span>
          </Link>
        ))}
      </nav>
    </div>
  )
}
