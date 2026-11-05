import {
  forwardRef,
  useId,
  useMemo,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { cn } from '@/lib/cn'
import { FieldContext, useFieldControl } from './fieldContext'

/*
 * Los campos miden 44px (h-11) y usan `text-sm`. En móvil, `index.css` fuerza
 * 16px con !important sobre input/select/textarea: por debajo de ese tamaño
 * iOS hace zoom automático al enfocar y la pantalla queda descuadrada.
 */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    const props = useFieldControl(rest)
    return (
      <input
        ref={ref}
        className={cn(
          'h-11 w-full rounded-xl border border-slate-300 bg-white px-3.5 text-sm text-slate-800 shadow-sm',
          'placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/30',
          'disabled:cursor-not-allowed disabled:bg-slate-50',
          className,
        )}
        {...props}
      />
    )
  },
)

/** Mismo estilo que Input, para textos de varias líneas. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, rows = 4, ...rest }, ref) {
    const props = useFieldControl(rest)
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={cn(
          'w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-800 shadow-sm',
          'placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/30',
          'disabled:cursor-not-allowed disabled:bg-slate-50',
          className,
        )}
        {...props}
      />
    )
  },
)

/**
 * Etiqueta + campo + pista/error.
 *
 * La pista se oculta cuando hay error a propósito: dos líneas de texto bajo el
 * campo compiten entre sí y la que importa es la que dice qué corregir.
 */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
  className,
}: {
  label?: ReactNode
  htmlFor?: string
  error?: string
  hint?: ReactNode
  required?: boolean
  children: ReactNode
  className?: string
}) {
  // La etiqueta nombra al control y la pista/el error lo describen: sin esta
  // asociación un lector de pantalla anuncia «campo de edición» a secas. El id
  // llega al control por contexto (ver fieldContext.ts); `htmlFor` explícito
  // sigue mandando para quien ya lo pasaba.
  const autoId = useId()
  const id = htmlFor ?? autoId
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  const control = useMemo(
    () => ({ id, describedBy, invalid: Boolean(error), required: Boolean(required) }),
    [id, describedBy, error, required],
  )
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <label htmlFor={id} className="block text-sm font-medium text-slate-700">
          {label}
          {/* El asterisco es visual: la obligatoriedad la anuncia aria-required. */}
          {required && <span aria-hidden="true" className="ml-0.5 text-red-500">*</span>}
        </label>
      )}
      <FieldContext.Provider value={control}>{children}</FieldContext.Provider>
      {hint && !error && <p id={`${id}-hint`} className="text-xs text-slate-500">{hint}</p>}
      {error && <p id={`${id}-error`} className="text-xs font-medium text-red-600">{error}</p>}
    </div>
  )
}
