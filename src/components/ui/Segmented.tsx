import { cn } from '@/lib/cn'

/**
 * Selector de una sola opción, con los botones a la vista (un estado, un rango
 * de fechas…). Se usa donde un `<select>` escondería justo lo que hay que
 * comparar: con tres o cuatro opciones cortas, verlas todas ahorra un toque.
 *
 * MÓVIL: el número de columnas depende de cuántas opciones haya. En un teléfono
 * de 360px, cuatro botones en línea dejan 78px cada uno y una palabra media ya
 * se corta; por eso se parten en dos filas y solo se estiran a partir de `sm`.
 */
const COLS: Record<number, string> = {
  2: 'grid-cols-2',
  // Tres opciones apiladas en móvil: a 360px, tres botones en línea dejan 106px
  // cada uno, que no alcanzan para una etiqueta de dos palabras.
  3: 'grid-cols-1 sm:grid-cols-3',
  4: 'grid-cols-2 sm:grid-cols-4',
  5: 'grid-cols-2 sm:grid-cols-5',
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string }[]
  /** Nombre del grupo, para lectores de pantalla. */
  label?: string
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('grid gap-2', COLS[options.length] ?? 'grid-cols-2 sm:grid-cols-3', className)}
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            /* `aria-pressed` y NO `role="radio"`: un grupo de radios le promete al
               lector de pantalla que las flechas cambian la opción, y eso exige
               mover el foco a mano (tabIndex móvil + onKeyDown). Estos son
               botones que se pulsan uno a uno con el tabulador, así que se
               anuncian por lo que son. */
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'h-11 truncate rounded-xl px-3 text-sm font-semibold transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40',
              active
                ? 'bg-brand-600 text-white shadow-sm'
                : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
