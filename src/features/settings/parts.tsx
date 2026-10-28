import type { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { errorMessage } from '@/lib/errors'
import { cn } from '@/lib/cn'

/*
 * Piezas pequeñas que comparten las secciones de Configuración. No son
 * primitivas de `components/ui` porque solo tienen sentido aquí.
 */

/**
 * Casilla con título y explicación. Para opciones de negocio (precios con
 * ITBIS, stock negativo, módulos) la explicación es la mitad del control: un
 * interruptor pelado no dice qué cambia al tocarlo.
 */
export function CheckRow({
  checked,
  onChange,
  label,
  hint,
  disabled,
  extra,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  hint?: ReactNode
  disabled?: boolean
  /** Etiqueta a la derecha (p. ej. «Requiere otro plan»). */
  extra?: ReactNode
}) {
  return (
    <label
      className={cn(
        'flex gap-3 rounded-xl border border-slate-200 p-3',
        disabled ? 'cursor-not-allowed bg-slate-50 opacity-70' : 'cursor-pointer hover:bg-slate-50',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-800">
          {label}
          {extra}
        </span>
        {hint && <span className="mt-0.5 block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  )
}

/** Error de carga con reintento: un listado vacío por un fallo de red no es "no hay nada". */
export function LoadError({ error, onRetry, what }: { error: unknown; onRetry: () => void; what: string }) {
  return (
    <div className="flex flex-col items-center gap-3 p-6 text-center">
      <p className="flex items-center gap-2 text-sm text-red-600">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {errorMessage(error, `No se pudieron cargar ${what}.`)}
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Volver a intentar
      </Button>
    </div>
  )
}

/** Solo dígitos: RNC, cédula y teléfonos se guardan sin guiones ni espacios. */
export function onlyDigits(value: string): string {
  return value.replace(/\D/g, '')
}
