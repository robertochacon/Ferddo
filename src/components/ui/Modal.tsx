import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
} as const

/**
 * Diálogo modal.
 *
 * En móvil sube desde abajo y se pega al borde inferior (`items-end`), que es
 * donde llega el pulgar; a partir de `sm` se centra como un diálogo de
 * escritorio. Es el mismo gesto que usa `ActionMenu`, para que abrir algo
 * encima del contenido se sienta siempre igual.
 *
 * Accesibilidad: cierra con Escape y con clic en el fondo, se anuncia como
 * `role="dialog" aria-modal`, y bloquea el desplazamiento del fondo mientras
 * está abierto (si no, en el teléfono se arrastra la página de detrás y el
 * diálogo parece flotar sobre otra pantalla).
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  /** Botonera inferior; queda fija mientras el cuerpo se desplaza. */
  footer?: ReactNode
  size?: keyof typeof SIZES
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  // El return va DESPUÉS del efecto: los hooks no pueden quedar detrás de una
  // salida temprana.
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div
        className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative z-10 flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-card-hover animate-slide-up sm:rounded-2xl',
          SIZES[size],
        )}
      >
        {title && (
          <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
            <h3 className="min-w-0 truncate text-base font-semibold text-slate-800">{title}</h3>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="shrink-0 rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        )}
        {/* Solo el cuerpo se desplaza: encabezado y botonera siguen a la vista
            en un formulario largo dentro de un teléfono. */}
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
