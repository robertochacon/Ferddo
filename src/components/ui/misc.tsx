import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { initials } from '@/lib/format'

const SPINNER_SIZES = {
  sm: 'h-4 w-4', // en línea con texto, dentro de un botón
  md: 'h-5 w-5',
  lg: 'h-8 w-8',
  xl: 'h-10 w-10', // pantallas de carga
} as const

/**
 * Aro de carga.
 *
 * El tamaño va por `size` y NO por `className`: `cn` es clsx a secas, sin
 * tailwind-merge, así que un `className="h-4 w-4"` no sustituye al tamaño base
 * —ambas clases acaban en el DOM y gana la que Tailwind emita más tarde, que es
 * su orden de escala y no el orden en que se pasan—. De ahí que varias llamadas
 * pidieran un tamaño y se dibujaran con otro.
 */
export function Spinner({
  size = 'md',
  className,
}: {
  size?: keyof typeof SPINNER_SIZES
  className?: string
}) {
  return <Loader2 className={cn('animate-spin text-brand-500', SPINNER_SIZES[size], className)} />
}

/**
 * Carga de una pantalla o de una tarjeta. Siempre con texto: un aro girando a
 * secas no dice si está cargando o si algo se atascó.
 */
export function PageLoader({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3.5 py-20 text-slate-500">
      <Spinner size="xl" />
      <p className="text-sm font-medium">{label}</p>
    </div>
  )
}

/**
 * Lista vacía. Lleva `action` porque un vacío sin salida es un callejón: casi
 * siempre lo que falta es el botón que crea el primer registro.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 px-6 py-12 text-center',
        className,
      )}
    >
      {icon && (
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-500">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

const AVATAR_SIZES = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-14 w-14 text-lg',
} as const

/** Foto de perfil, o las iniciales cuando no hay ninguna. */
export function Avatar({
  name,
  src,
  size = 'md',
  className,
}: {
  name?: string | null
  src?: string | null
  size?: keyof typeof AVATAR_SIZES
  className?: string
}) {
  const dim = AVATAR_SIZES[size]
  if (src) {
    return (
      // `object-cover`: las fotos de perfil llegan en cualquier proporción y sin
      // esto se deforman al meterlas en un círculo.
      <img src={src} alt={name ?? ''} className={cn('rounded-full object-cover', dim, className)} />
    )
  }
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700',
        dim,
        className,
      )}
    >
      {initials(name)}
    </span>
  )
}
