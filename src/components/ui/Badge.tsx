import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

type Tone = 'brand' | 'green' | 'amber' | 'red' | 'slate'

/*
 * Fondo claro + texto oscuro de la misma familia: la etiqueta se lee sin robarle
 * peso al contenido de la fila. Los tonos son de significado, no de color —
 * `green` = todo en orden, `amber` = pendiente, `red` = problema—, así que si
 * cambia la paleta se cambia aquí y no en cada pantalla.
 */
const tones: Record<Tone, string> = {
  brand: 'bg-brand-50 text-brand-700',
  green: 'bg-emerald-50 text-emerald-700',
  amber: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-red-700',
  slate: 'bg-slate-100 text-slate-600',
}

export function Badge({
  children,
  tone = 'slate',
  className,
}: {
  children: ReactNode
  tone?: Tone
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}
