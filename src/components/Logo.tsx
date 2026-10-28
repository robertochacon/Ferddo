import { useId } from 'react'
import { cn } from '@/lib/cn'
import { APP_NAME } from '@/lib/constants'

/*
 * Isotipo de Ferddo (la "F" de dos hojas), dibujado EN LÍNEA (SVG) y no cargado
 * de public/logo.png.
 *
 * ¿Por qué vectorial? Porque el logo aparece en la pantalla de arranque, en el
 * <ErrorBoundary> y en el login: justo los tres momentos en los que puede no
 * haber red, y una imagen que no carga deja un hueco donde debería estar la
 * única señal de que la app es la app. Al ir dentro del bundle se pinta siempre,
 * escala a cualquier tamaño y no gasta una petición.
 *
 * public/logo.png (recorte del isotipo) sigue existiendo, pero solo como fuente
 * de los íconos que genera `npm run icons`. El logotipo completo en alta está en
 * public/brand/ferddo-wordmark.png.
 */

// Colores del isotipo original. Van en hex porque un `stop` de degradado no
// entiende clases de Tailwind; son gemelos de brand-*/mint-* en tailwind.config.js.
const TOP_FROM = '#1554e4'
const TOP_TO = '#06aefc'
const MID_FROM = '#08dccf'
const MID_TO = '#33e8c0'
const STEM_FROM = '#0d58d6'
const STEM_TO = '#0a3a9a'

/** Isotipo cuadrado. El tamaño lo pone quien lo usa (`h-* w-*`). */
export function Logo({
  className,
  /** `true` cuando al lado ya hay texto con el nombre: evita leerlo dos veces. */
  decorative = false,
}: {
  className?: string
  decorative?: boolean
}) {
  // Un id por instancia: con ids fijos, dos logos en la misma página
  // compartirían los degradados. Se quitan los ':' que mete React porque no son
  // válidos dentro de un `url(#…)`.
  const uid = `logo-${useId().replace(/:/g, '')}`

  return (
    <svg
      viewBox="0 0 64 64"
      className={cn('shrink-0', className)}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : APP_NAME}
    >
      <defs>
        <linearGradient id={`${uid}-t`} x1="8" y1="20" x2="56" y2="8" gradientUnits="userSpaceOnUse">
          <stop stopColor={TOP_FROM} />
          <stop offset="1" stopColor={TOP_TO} />
        </linearGradient>
        <linearGradient id={`${uid}-m`} x1="8" y1="36" x2="45" y2="26" gradientUnits="userSpaceOnUse">
          <stop stopColor={MID_FROM} />
          <stop offset="1" stopColor={MID_TO} />
        </linearGradient>
        <linearGradient id={`${uid}-s`} x1="20" y1="38" x2="10" y2="56" gradientUnits="userSpaceOnUse">
          <stop stopColor={STEM_FROM} />
          <stop offset="1" stopColor={STEM_TO} />
        </linearGradient>
      </defs>
      <g transform="translate(0.5 1)">
        <path
          d="M7.8 31V19.5C7.8 12 15 6.75 26 6.75H55.6C54 14.5 48 20.6 40 20.6H25.5C16 20.6 10.5 25 7.8 31Z"
          fill={`url(#${uid}-t)`}
        />
        <path
          d="M7.8 46V36C7.8 29.5 14 24.7 24.5 24.7H44.7C43.5 31.5 38 37.3 30.5 37.3H23.4C14 37.4 7.8 41 7.8 46Z"
          fill={`url(#${uid}-m)`}
        />
        <path
          d="M7.8 55.3V46C7.8 41 14 37.4 23.4 37.4V43C23.4 50 17 55.3 9 55.3Z"
          fill={`url(#${uid}-s)`}
        />
      </g>
    </svg>
  )
}

/** Isotipo + nombre, para cabeceras y barras de navegación. */
export function Wordmark({
  className,
  /** Sobre fondo oscuro (pie de la landing): el texto pasa a blanco. */
  dark = false,
}: {
  className?: string
  dark?: boolean
}) {
  return (
    // `min-w-0` para que el `truncate` del nombre funcione: un hijo flex se
    // niega a encogerse por debajo de su contenido si no se lo permites.
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      <Logo className="h-9 w-9" decorative />
      <span
        className={cn(
          'truncate text-lg font-extrabold tracking-tight',
          dark ? 'text-white' : 'text-brand-950',
        )}
      >
        {APP_NAME}
      </span>
    </div>
  )
}
