import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/cn'

export type ActionItem = {
  label: string
  icon?: ReactNode
  onClick: () => void
  tone?: 'default' | 'danger' | 'success'
  disabled?: boolean
  /** Aclaración bajo el nombre, para acciones que conviene explicar. */
  hint?: string
}

const toneCls: Record<NonNullable<ActionItem['tone']>, string> = {
  default: 'text-slate-700',
  danger: 'text-red-600',
  success: 'text-emerald-700',
}

/**
 * Botón «más opciones» (⋯) con hoja de acciones que sube desde abajo.
 *
 * En móvil, la fila de iconos que usan las tablas en escritorio no cabe —y aun
 * cabiendo, un icono suelto no dice qué hace—. Aquí las acciones se agrupan
 * detrás de un solo botón: la hoja aparece al alcance del pulgar y cada acción
 * lleva su nombre escrito.
 *
 * La hoja es `fixed` a propósito, no un desplegable `absolute`: las filas viven
 * dentro de `Card`s con `overflow-hidden`, que recortarían un desplegable
 * posicionado en su interior. `fixed` se escapa de ese recorte porque su bloque
 * contenedor es la ventana.
 */
export function ActionMenu({
  items,
  label = 'Más opciones',
  title,
  className,
}: {
  items: ActionItem[]
  /** Texto para lectores de pantalla del botón que abre la hoja. */
  label?: string
  /** Encabezado de la hoja: normalmente de qué fila son estas acciones. */
  title?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      // El foco vuelve al disparador: si se queda en un botón que acaba de
      // desaparecer, el tabulador reinicia desde el principio de la página.
      triggerRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    // Mismo bloqueo que Modal: la hoja tapa la pantalla, así que el fondo no
    // debe seguir desplazándose por debajo.
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open])

  // Cerrar ANTES de ejecutar: varias acciones abren un diálogo, y si la hoja se
  // cerrara después quedaría un instante con las dos capas encima.
  const run = (item: ActionItem) => {
    if (item.disabled) return
    setOpen(false)
    item.onClick()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={cn(
          'rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700',
          className,
        )}
      >
        <MoreHorizontal className="h-5 w-5" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center">
          <div
            className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm animate-fade-in"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            role="menu"
            aria-label={title ?? label}
            // `pb-[env(safe-area-inset-bottom)]`: en un iPhone sin botón, la
            // barra de gestos se comía la última acción de la lista.
            className="relative z-10 max-h-[85dvh] w-full overflow-y-auto rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)] shadow-card-hover animate-slide-up sm:mb-4 sm:max-w-sm sm:rounded-2xl"
          >
            {title && (
              <p className="truncate border-b border-slate-100 px-5 py-3.5 text-sm font-semibold text-slate-800">
                {title}
              </p>
            )}
            <div className="p-2">
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => run(item)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-[15px] font-medium transition-colors',
                    item.disabled
                      ? 'cursor-not-allowed text-slate-300'
                      : cn(toneCls[item.tone ?? 'default'], 'hover:bg-slate-50 active:bg-slate-100'),
                  )}
                >
                  {item.icon && <span className="flex-shrink-0">{item.icon}</span>}
                  <span className="min-w-0 flex-1">
                    {item.label}
                    {item.hint && (
                      <span className="mt-0.5 block text-xs font-normal text-slate-400">
                        {item.hint}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
            {/* «Cancelar» explícito: cerrar tocando el fondo es un gesto que no
                todo el mundo conoce, y sin salida visible la hoja atrapa. */}
            <div className="border-t border-slate-100 p-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="w-full rounded-xl px-3 py-3 text-[15px] font-semibold text-slate-500 transition-colors hover:bg-slate-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
