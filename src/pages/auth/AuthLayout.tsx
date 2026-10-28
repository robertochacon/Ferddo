import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, LogOut } from 'lucide-react'
import { Logo } from '@/components/Logo'
import { useAuth } from '@/auth/AuthProvider'
import { APP_TAGLINE, LEGAL_PATHS } from '@/lib/constants'

/**
 * Marco común de todas las pantallas de acceso: logo, tarjeta centrada y las
 * salidas (volver al sitio público, cerrar sesión, enlaces legales).
 *
 * Está aquí y no en cada página para que las salidas se decidan UNA vez: en
 * varias de estas pantallas irse a medias deja a la persona en un estado raro.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
  backToHome = true,
  showSignOut = false,
  // Por omisión sigue a `backToHome`: un enlace legal también saca de la
  // pantalla, así que donde irse a medias es un problema (restablecer
  // contraseña, primeros pasos) tampoco debe aparecer.
  showLegal = backToHome,
}: {
  title: string
  subtitle?: string
  children: ReactNode
  footer?: ReactNode
  /**
   * Muestra la salida a la página pública. Se apaga en las pantallas donde
   * irse a medias deja al usuario en un estado raro (primeros pasos sin
   * negocio, o la sesión temporal de recuperar contraseña).
   */
  backToHome?: boolean
  /**
   * Salida para quien YA inició sesión pero sigue en una pantalla de acceso
   * (los primeros pasos): sin esto queda encerrado, porque ahí no hay menú.
   */
  showSignOut?: boolean
  /**
   * Enlaces legales al pie. Por omisión aparecen donde aparece «Inicio». Se
   * apagan además en el registro, que ya lleva la frase de aceptación junto al
   * botón con esos mismos dos enlaces.
   */
  showLegal?: boolean
}) {
  return (
    <div className="relative flex min-h-[100dvh] flex-col items-center justify-center bg-gradient-to-b from-brand-50 via-white to-white px-4 pb-10 pt-16">
      {backToHome && (
        <Link
          to="/"
          className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:bg-white hover:text-brand-600 sm:left-5 sm:top-5"
        >
          <ArrowLeft className="h-4 w-4" />
          Inicio
        </Link>
      )}

      {showSignOut && <SignOutButton />}

      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo className="h-24 w-24" />
          <p className="mt-1 text-sm font-medium text-brand-500">{APP_TAGLINE}</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card">
          <h1 className="text-xl font-bold text-slate-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>

        {footer && <div className="mt-4 text-center text-sm text-slate-500">{footer}</div>}

        {/* Quien entra directo a /login (un marcador, una sesión caducada) no
            pasa por la landing, así que este es su único acceso a los legales. */}
        {showLegal && (
          <div className="mt-6 flex items-center justify-center gap-3 text-xs text-slate-400">
            <Link to={LEGAL_PATHS.privacy} className="hover:text-brand-500 hover:underline">
              Privacidad
            </Link>
            <span aria-hidden className="h-1 w-1 rounded-full bg-slate-300" />
            <Link to={LEGAL_PATHS.terms} className="hover:text-brand-500 hover:underline">
              Términos
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}

/** Con quién estás dentro y cómo salir. Arriba a la derecha, frente a "Inicio". */
function SignOutButton() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()

  const leave = async () => {
    await signOut()
    navigate('/login')
  }

  return (
    <div className="absolute right-3 top-3 flex items-center gap-2 sm:right-5 sm:top-5">
      {/* El correo solo en pantallas anchas: en el teléfono se comería la fila. */}
      <span className="hidden max-w-[40vw] truncate text-xs text-slate-500 sm:block">
        {user?.email}
      </span>
      <button
        onClick={leave}
        className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:bg-white hover:text-red-600"
      >
        <LogOut className="h-4 w-4" />
        Cerrar sesión
      </button>
    </div>
  )
}
