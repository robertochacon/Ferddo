import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

type Tone = 'brand' | 'accent' | 'green' | 'amber' | 'red' | 'slate'

/*
 * Solo se colorea la pastilla del icono, nunca el número: cuatro tarjetas con
 * cifras de cuatro colores distintos se leen como una alarma. `accent` es el
 * ámbar de marca (lo destacado) y `amber` el aviso; se parecen a propósito,
 * pero cambian por separado si se re-tematiza la app.
 */
const tones: Record<Tone, string> = {
  brand: 'bg-brand-50 text-brand-600',
  accent: 'bg-accent-100 text-accent-700',
  green: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  red: 'bg-red-50 text-red-600',
  slate: 'bg-slate-100 text-slate-600',
}

export function StatCard({
  label,
  value,
  icon,
  tone = 'brand',
  hint,
  className,
}: {
  label: string
  value: ReactNode
  icon?: ReactNode
  tone?: Tone
  /** Contexto bajo la cifra: «este mes», «de 10 disponibles»… */
  hint?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-slate-200 bg-white p-4 shadow-card transition-shadow hover:shadow-card-hover',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        {icon && (
          <span
            className={cn('flex h-9 w-9 items-center justify-center rounded-xl', tones[tone])}
          >
            {icon}
          </span>
        )}
      </div>
      {/* `text-xl` en móvil y `break-words`: en una rejilla de dos columnas a
          360px la tarjeta mide ~160px, y un importe largo a 24px se salía por el
          borde derecho. Así cabe en una línea, y una cifra de millones parte en
          dos en vez de desbordar la tarjeta. */}
      <p className="mt-2 break-words text-xl font-bold text-slate-900 sm:text-2xl">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  )
}
