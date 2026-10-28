import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * Paginador común de la app.
 *
 * Sirve igual para listas ya cargadas (se corta el arreglo con `paginate`) que
 * para consultas paginadas en el servidor: solo necesita saber en qué página va
 * y cuántos elementos hay en total.
 *
 * No se dibuja si todo cabe en una página: un paginador de «1 / 1» es ruido.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  label = 'elementos',
  className,
}: {
  /** Página actual, empezando en 0. */
  page: number
  pageSize: number
  total: number
  onPage: (page: number) => void
  /** Cómo se llaman las cosas que se listan: «negocios», «registros»… */
  label?: string
  className?: string
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (pages <= 1) return null

  const from = page * pageSize + 1
  const to = Math.min(total, (page + 1) * pageSize)

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3',
        className,
      )}
    >
      {/* `tabular-nums` en todo lo que sea cifra: sin ella el ancho baila al
          cambiar de página y los botones se mueven bajo el dedo. */}
      <p className="text-xs text-slate-500">
        <span className="tabular-nums">
          {from}–{to}
        </span>{' '}
        de <span className="tabular-nums">{total}</span> {label}
      </p>
      <div className="flex items-center gap-1">
        <PagerButton
          label="Página anterior"
          disabled={page === 0}
          onClick={() => onPage(Math.max(0, page - 1))}
        >
          <ChevronLeft className="h-4 w-4" />
        </PagerButton>
        <span className="min-w-[3.5rem] text-center text-xs tabular-nums text-slate-500">
          {page + 1} / {pages}
        </span>
        <PagerButton
          label="Página siguiente"
          disabled={page >= pages - 1}
          onClick={() => onPage(Math.min(pages - 1, page + 1))}
        >
          <ChevronRight className="h-4 w-4" />
        </PagerButton>
      </div>
    </div>
  )
}

function PagerButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}

/**
 * Recorta una lista ya cargada a la página pedida, y corrige la página si se
 * quedó fuera de rango (p. ej. al filtrar y reducirse el total): sin ese ajuste
 * la pantalla se queda en blanco en la página 3 de una lista que ahora tiene 1.
 */
export function paginate<T>(
  rows: T[],
  page: number,
  pageSize: number,
): { slice: T[]; safePage: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const safePage = Math.min(Math.max(0, page), pages - 1)
  const from = safePage * pageSize
  return { slice: rows.slice(from, from + pageSize), safePage, pages }
}
