import type { ReactNode } from 'react'

/**
 * Encabezado de una pantalla de la app: título, explicación corta y la acción
 * principal.
 *
 * Se apila en vertical por debajo de `sm` a propósito: con el botón al lado del
 * título, en un teléfono de 360px el texto se parte en tres líneas y el botón
 * queda apretado contra el borde.
 */
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  /** Botón o grupo de botones de la derecha. */
  action?: ReactNode
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      {/* `min-w-0`: sin él un hijo flex no se encoge por debajo de su contenido
          y un título largo empujaría la acción fuera de la pantalla. */}
      <div className="min-w-0">
        <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  )
}
