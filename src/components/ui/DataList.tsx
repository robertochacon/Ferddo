import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Lista de registros para móvil: la cara estrecha de una tabla.
 *
 * ¿Por qué existe? Una tabla de ocho columnas en un teléfono obliga a arrastrar
 * de lado, y arrastrando se pierde de vista la primera columna —justo la que
 * dice de quién es la fila—. Así que por debajo de `lg` las tablas se esconden
 * (`hidden lg:block` en su contenedor) y los mismos datos se pintan aquí: un
 * registro por tarjeta, con sus valores etiquetados y las acciones detrás de un
 * botón «más opciones» (ver `ActionMenu`).
 *
 * Se usa en pareja con la tabla, no en su lugar: en escritorio la tabla sigue
 * siendo mejor para comparar filas de un vistazo.
 *
 * Uso:
 *   <div className="hidden overflow-x-auto lg:block"><table>…</table></div>
 *   <DataList>
 *     {rows.map((r) => (
 *       <DataRow key={r.id} title={r.name} actions={<ActionMenu items={…} />}>
 *         <DataFields>
 *           <DataField label="Monto">…</DataField>
 *         </DataFields>
 *       </DataRow>
 *     ))}
 *   </DataList>
 */
export function DataList({ children, className }: { children: ReactNode; className?: string }) {
  return <ul className={cn('divide-y divide-slate-100 lg:hidden', className)}>{children}</ul>
}

const TONES = {
  danger: 'bg-red-50/40',
  muted: 'bg-slate-50/60',
} as const

/**
 * Un registro. `title` es lo que identifica la fila (el nombre del elemento, la
 * persona…) y se queda arriba junto a sus etiquetas y al botón de acciones.
 */
export function DataRow({
  title,
  titleExtra,
  subtitle,
  badges,
  actions,
  leading,
  children,
  tone,
  onClick,
}: {
  title: ReactNode
  /** Dato secundario bajo el título: código, correo, teléfono… */
  titleExtra?: ReactNode
  subtitle?: ReactNode
  badges?: ReactNode
  actions?: ReactNode
  /** Adorno a la izquierda del título, normalmente un <Avatar>. */
  leading?: ReactNode
  children?: ReactNode
  /** Fondo de aviso, para filas suspendidas o en rojo. */
  tone?: keyof typeof TONES
  /** Si se pasa, el título se vuelve el enlace que abre el detalle. */
  onClick?: () => void
}) {
  return (
    <li className={cn('p-4', tone && TONES[tone])}>
      <div className="flex items-start gap-3">
        {leading && <div className="flex-shrink-0">{leading}</div>}
        {/* `min-w-0` en el bloque central: sin él, un correo largo estira la
            fila y empuja el botón de acciones fuera de la pantalla. */}
        <div className="min-w-0 flex-1">
          {onClick ? (
            <button
              type="button"
              onClick={onClick}
              className="block max-w-full text-left font-semibold text-slate-800 hover:text-brand-600"
            >
              <span className="block truncate">{title}</span>
            </button>
          ) : (
            <p className="truncate font-semibold text-slate-800">{title}</p>
          )}
          {titleExtra && <p className="truncate text-xs text-slate-400">{titleExtra}</p>}
          {subtitle && <p className="mt-1 truncate text-sm text-slate-600">{subtitle}</p>}
          {badges && <div className="mt-2 flex flex-wrap items-center gap-1.5">{badges}</div>}
        </div>
        {actions && <div className="-mr-1 flex-shrink-0">{actions}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </li>
  )
}

const COLS = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
} as const

/**
 * Rejilla de valores etiquetados. Dos columnas: en un teléfono de 360px cada
 * una queda sobre 150px, suficiente para un monto o una fecha sin cortarlos.
 */
export function DataFields({
  children,
  cols = 2,
  className,
}: {
  children: ReactNode
  cols?: keyof typeof COLS
  className?: string
}) {
  return (
    <dl className={cn('grid gap-x-3 gap-y-2 border-t border-slate-100 pt-3', COLS[cols], className)}>
      {children}
    </dl>
  )
}

export function DataField({
  label,
  children,
  wrap = false,
  className,
}: {
  label: string
  children: ReactNode
  /**
   * Deja que el valor use varias líneas. Por defecto se recorta con puntos
   * suspensivos: es lo que impide que un correo largo reviente la rejilla.
   */
  wrap?: boolean
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className={cn('text-sm font-medium text-slate-700', wrap ? 'break-words' : 'truncate')}>
        {children}
      </dd>
    </div>
  )
}
