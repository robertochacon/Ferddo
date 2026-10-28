import { forwardRef, type SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

/**
 * Desplegable nativo con la flecha dibujada por nosotros.
 *
 * `appearance-none` + una flecha en `background-image` porque el control nativo
 * se pinta distinto en cada navegador y desentonaba junto a `Input`. La flecha
 * va como data-URI y no como icono de React: un `<svg>` hermano se llevaría los
 * clics del select y habría que taparlo con `pointer-events-none`.
 *
 * Se conserva el `<select>` real —y no un menú propio— porque en el teléfono
 * abre la rueda del sistema, que es más cómoda que cualquier lista nuestra.
 */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          'h-11 w-full appearance-none rounded-xl border border-slate-300 bg-white bg-no-repeat px-3.5 pr-9 text-sm text-slate-800 shadow-sm',
          'focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/30',
          'disabled:cursor-not-allowed disabled:bg-slate-50',
          className,
        )}
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E\")",
          backgroundPosition: 'right 0.75rem center',
        }}
        {...props}
      >
        {children}
      </select>
    )
  },
)
