import { useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import { pageItems, type PageItem } from '@/lib/pageItems'

/**
 * Registros por página de TODOS los listados. Un solo número para toda la app:
 * cambiarlo aquí cambia cada pantalla, en vez de perseguir constantes sueltas.
 */
export const DEFAULT_PAGE_SIZE = 10

/**
 * Paginador común de la app: «‹ Anterior 1 2 3 … 25 Siguiente ›».
 *
 * Sirve igual para listas ya cargadas (se corta el arreglo con `paginate`) que
 * para consultas paginadas en el servidor: solo necesita saber en qué página va
 * y cuántos elementos hay en total.
 *
 * No se dibuja si todo cabe en una página: un paginador de «1» solo es ruido.
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
  const go = (p: number) => onPage(Math.min(pages - 1, Math.max(0, p)))

  return (
    <div
      className={cn(
        'flex flex-col items-center gap-2 border-t border-slate-100 px-4 py-3 sm:flex-row sm:justify-between',
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
      <nav aria-label="Paginación" className="flex overflow-hidden rounded-lg border border-slate-200 bg-white">
        <PagerButton label="Página anterior" disabled={page === 0} onClick={() => go(page - 1)}>
          <ChevronLeft className="h-4 w-4" />
          {/* El texto solo cabe desde `sm`; en el teléfono basta la flecha. */}
          <span className="hidden sm:inline">Anterior</span>
        </PagerButton>
        {/* Dos tiras de números: 7 casillas en escritorio y 5 en el teléfono, donde
            siete más «Anterior/Siguiente» no caben en 360 px. */}
        <PageNumbers items={pageItems(page, pages, 7)} page={page} onPage={go} className="hidden sm:flex" />
        <PageNumbers items={pageItems(page, pages, 5)} page={page} onPage={go} className="flex sm:hidden" />
        <PagerButton label="Página siguiente" disabled={page >= pages - 1} onClick={() => go(page + 1)}>
          <span className="hidden sm:inline">Siguiente</span>
          <ChevronRight className="h-4 w-4" />
        </PagerButton>
      </nav>
    </div>
  )
}

/** Estilo de cada casilla por estado (lookup, no ternarios). */
const ITEM_TONE = {
  current: 'bg-brand-600 font-semibold text-white',
  other: 'text-brand-700 hover:bg-slate-50',
} as const

function PageNumbers({
  items,
  page,
  onPage,
  className,
}: {
  items: PageItem[]
  page: number
  onPage: (page: number) => void
  className?: string
}) {
  return (
    <ul className={cn('divide-x divide-slate-200 border-x border-slate-200', className)}>
      {items.map((it) =>
        typeof it === 'number' ? (
          <li key={it}>
            <button
              type="button"
              onClick={() => onPage(it)}
              aria-label={`Página ${it + 1}`}
              aria-current={it === page ? 'page' : undefined}
              className={cn(
                'h-9 min-w-9 px-2.5 text-sm tabular-nums transition-colors',
                ITEM_TONE[it === page ? 'current' : 'other'],
              )}
            >
              {it + 1}
            </button>
          </li>
        ) : (
          <li key={it} aria-hidden className="flex h-9 min-w-9 items-center justify-center px-1 text-sm text-slate-400">
            …
          </li>
        ),
      )}
    </ul>
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
      className="flex h-9 min-w-9 items-center justify-center gap-1 px-2.5 text-sm text-brand-700 transition-colors hover:bg-slate-50 disabled:text-slate-300 disabled:hover:bg-transparent"
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
  pageSize: number = DEFAULT_PAGE_SIZE,
): { slice: T[]; safePage: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const safePage = Math.min(Math.max(0, page), pages - 1)
  const from = safePage * pageSize
  return { slice: rows.slice(from, from + pageSize), safePage, pages }
}

/**
 * `paginate` con su estado incluido, para listas ya cargadas. Devuelve la
 * página recortada y `pager`, que se pasa tal cual a <Pagination {...pager} />.
 *
 * Es un hook: va al principio del componente, antes de cualquier `return`
 * temprano, con `rows` ya filtradas (o `[]` mientras cargan). Quien tenga
 * filtros llama `reset()` al cambiarlos, para volver a la primera página en vez
 * de quedarse en la 3 de un resultado distinto.
 */
export function usePaged<T>(rows: T[], pageSize = DEFAULT_PAGE_SIZE) {
  const [page, setPage] = useState(0)
  const { slice, safePage } = paginate(rows, page, pageSize)
  return {
    slice,
    reset: () => setPage(0),
    pager: { page: safePage, pageSize, total: rows.length, onPage: setPage },
  }
}
