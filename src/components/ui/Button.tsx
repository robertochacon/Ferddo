import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg' | 'icon'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  /** Muestra el aro girando y deshabilita el botón (evita el doble envío). */
  loading?: boolean
}

/*
 * Variantes y tamaños van en objetos de lookup y NO en ternarios encadenados:
 * añadir una variante es una línea, y el lookup deja a la vista que ninguna se
 * solapa con otra. Además `cn` es clsx sin tailwind-merge (ver @/lib/cn), así
 * que cada variante debe traer su juego completo de clases.
 */
const variants: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 focus-visible:ring-brand-500/50 shadow-sm',
  secondary: 'bg-brand-50 text-brand-700 hover:bg-brand-100 focus-visible:ring-brand-500/40',
  outline:
    'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus-visible:ring-brand-500/40',
  ghost: 'text-slate-600 hover:bg-slate-100 focus-visible:ring-brand-500/30',
  danger: 'bg-red-500 text-white hover:bg-red-600 focus-visible:ring-red-500/40 shadow-sm',
}

/*
 * Alturas en múltiplos de 4 y nunca por debajo de 36px: el objetivo táctil
 * mínimo recomendado en un teléfono. `icon` es cuadrado para los botones que
 * solo llevan un icono y no deben deformarse.
 */
const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm gap-1.5',
  md: 'h-11 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-base gap-2',
  icon: 'h-10 w-10',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', size = 'md', loading, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      // `loading` deshabilita además de anunciar: si no, un segundo clic mientras
      // la petición vuela crea el registro dos veces.
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center justify-center rounded-xl font-medium transition-colors',
        'focus:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  )
})
