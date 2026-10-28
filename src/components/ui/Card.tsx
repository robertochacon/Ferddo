import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Tarjeta: el contenedor de casi todo en la app.
 *
 * Lleva `overflow-hidden` para que una tabla ancha o una imagen no se salgan de
 * las esquinas redondeadas. Ese recorte es justo el motivo de que `ActionMenu`
 * pinte su hoja con `fixed` en vez de un desplegable `absolute`: dentro de una
 * Card, un desplegable posicionado quedaría cortado.
 */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card',
        className,
      )}
      {...props}
    />
  )
}

export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: ReactNode
  subtitle?: ReactNode
  /** Botón o control a la derecha del título («Nuevo», un filtro…). */
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4',
        className,
      )}
    >
      {/* `min-w-0` es imprescindible para que el `truncate` del título funcione:
          un hijo flex se niega a encogerse por debajo de su contenido si no. */}
      <div className="min-w-0">
        <h3 className="truncate text-base font-semibold text-slate-800">{title}</h3>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5', className)} {...props} />
}
