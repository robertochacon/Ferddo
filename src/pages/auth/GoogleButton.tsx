import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { supabase, hasSupabaseConfig } from '@/lib/supabase'
import { useToast } from '@/components/ui/toast'

/**
 * Botón «Continuar con Google».
 *
 * NO necesita ninguna variable `VITE_`: el intercambio con Google (client id,
 * client secret, code → tokens) lo hace el SERVIDOR de Supabase. Aquí solo se
 * manda el navegador a la pantalla de consentimiento. El proveedor se activa en
 * el panel de Supabase (Authentication → Providers → Google) y la URL de vuelta
 * debe estar en su lista de "Redirect URLs"; nada de eso viaja en el bundle,
 * que es justo lo que se quiere: un secreto inlineado en `dist` es público.
 *
 * Al volver, el fragmento con los tokens lo consume el cliente de Supabase y
 * `AuthProvider` reacciona por `onAuthStateChange`, así que no hay nada que
 * navegar a mano. Una cuenta nueva por Google no tiene perfil todavía, cae en
 * `needsOnboarding` y el guard la lleva a /bienvenida, donde el nombre ya viene
 * prellenado con el de Google (OnboardingPage lee `user_metadata.full_name`).
 */
/** Se apaga con VITE_GOOGLE_AUTH=false (ver vite-env.d.ts). */
export const GOOGLE_AUTH_ENABLED = import.meta.env.VITE_GOOGLE_AUTH !== 'false'

export function GoogleButton({ label }: { label: string }) {
  if (!GOOGLE_AUTH_ENABLED) return null
  return <GoogleButtonInner label={label} />
}

function GoogleButtonInner({ label }: { label: string }) {
  const toast = useToast()
  const [loading, setLoading] = useState(false)

  const start = async () => {
    if (!hasSupabaseConfig) {
      toast.error('Configura VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY en .env')
      return
    }
    setLoading(true)
    // La raíz del `base` cubre tanto el dominio propio (/) como el despliegue en
    // un subdirectorio (/mi-repo/), igual que en ForgotPasswordPage. SIN
    // fragmento: Supabase añade el resultado detrás y un «#» aquí lo dejaría
    // inservible.
    const redirectTo = new URL(import.meta.env.BASE_URL, window.location.origin).toString()

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo },
    })

    // En el camino feliz el navegador ya se fue a Google y esto no se ejecuta;
    // el `loading` se queda puesto a propósito hasta que la página cambie.
    if (error) {
      setLoading(false)
      toast.error(
        /provider is not enabled|unsupported provider/i.test(error.message)
          ? 'El acceso con Google todavía no está habilitado.'
          : 'No pudimos abrir Google. Inténtalo de nuevo.',
      )
    }
  }

  return (
    <button
      type="button"
      onClick={start}
      disabled={loading}
      className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {loading ? <Loader2 className="h-5 w-5 animate-spin text-slate-400" /> : <GoogleLogo />}
      {loading ? 'Abriendo Google…' : label}
    </button>
  )
}

/**
 * Logo oficial de Google. Va como SVG en línea a propósito: su guía de marca
 * pide el logo a color (no un icono genérico) y una imagen remota la bloquearía
 * el modo sin conexión —y de paso avisaría a Google de cada visita a la pantalla
 * de acceso, que es justo lo que la política de privacidad promete no hacer.
 */
function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden className="h-5 w-5">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  )
}

/** Separador «o» entre el acceso con Google y el formulario de correo. */
export function AuthDivider() {
  if (!GOOGLE_AUTH_ENABLED) return null
  return (
    <div className="flex items-center gap-3">
      <span className="h-px flex-1 bg-slate-200" />
      <span className="text-xs font-medium uppercase tracking-wide text-slate-400">o</span>
      <span className="h-px flex-1 bg-slate-200" />
    </div>
  )
}
