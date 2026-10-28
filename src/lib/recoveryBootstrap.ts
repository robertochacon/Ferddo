// Bootstrap de los enlaces de recuperación de contraseña de Supabase.
//
// DEBE importarse EL PRIMERO en main.tsx, antes que cualquier módulo que cree el
// cliente de Supabase o monte el router, para ejecutarse mientras el fragmento
// de la URL sigue intacto. Como este archivo NO importa nada, su cuerpo corre
// antes que el resto de imports de main.tsx: esa ausencia de imports es
// deliberada, no un descuido. (Por eso el modo de rutas se relee aquí en vez de
// traerlo de @/lib/router: importarlo arrastraría react-router y rompería la
// garantía de ir primero.)
//
// ¿Por qué existe? En el flujo implícito —el que usan los enlaces del correo—
// Supabase devuelve al usuario a la raíz de la app con el resultado en el
// FRAGMENTO:
//   https://ferddo.com/#access_token=…&refresh_token=…&type=recovery
// o, si el enlace expiró o ya se usó:
//   https://ferddo.com/#error=access_denied&error_code=otp_expired&…
//
// Con HashRouter el fragmento es TAMBIÉN donde viven las rutas (#/login). Sin
// intervenir, el router lee "access_token=…" como una ruta desconocida y su
// catch-all navega a "#/", BORRANDO el token antes de que nadie pueda usarlo:
// el enlace del correo llevaría siempre a la pantalla de inicio. Aquí se saca el
// token del fragmento y se reescribe la URL a la pantalla de restablecer.
//
// Con BrowserRouter el fragmento no es una ruta, pero el problema de fondo es el
// mismo (hay que llevar a la persona a /restablecer con el token en la mano),
// así que la captura corre en los dos modos y solo cambia la URL de destino.

export const RECOVERY_KEY = 'ferddo-recovery'
export const RECOVERY_ERROR_KEY = 'ferddo-recovery-error'

export interface RecoveryTokens {
  access_token: string
  refresh_token: string
}

// Transporte PRIMARIO: variables en memoria. Como la URL se reescribe con
// replaceState (sin recargar), el módulo sigue vivo y ResetPasswordPage puede
// leer esto directamente. Así un fallo de sessionStorage (modo privado, storage
// bloqueado por política) NO destruye un token válido: sessionStorage es solo un
// respaldo por si hubiera una recarga por el medio.
export let capturedTokens: RecoveryTokens | null = null
export let capturedError: string | null = null

/** ResetPasswordPage lo llama tras consumir los datos, para no reutilizarlos. */
export function clearCapturedRecovery() {
  capturedTokens = null
  capturedError = null
  try {
    window.sessionStorage.removeItem(RECOVERY_KEY)
    window.sessionStorage.removeItem(RECOVERY_ERROR_KEY)
  } catch {
    // sessionStorage puede no estar disponible; el respaldo en memoria basta.
  }
}

;(function captureRecoveryFromHash() {
  if (typeof window === 'undefined') return

  // Quita el '#' (y la '/' del HashRouter, si la hubiera) para poder parsear los
  // parámetros que Supabase deja en el fragmento.
  const raw = window.location.hash.replace(/^#\/?/, '')
  if (!raw) return

  const params = new URLSearchParams(raw)
  const accessToken = params.get('access_token')
  const refreshToken = params.get('refresh_token')
  const type = params.get('type')
  const errorCode = params.get('error_code') ?? params.get('error')

  const hasRecoveryTokens = Boolean(accessToken && refreshToken && type === 'recovery')
  const hasAuthError = Boolean(errorCode)

  // Solo se interviene ante el resultado de un enlace (tokens o error). Cualquier
  // otro fragmento —las rutas normales del HashRouter— se deja intacto.
  if (!hasRecoveryTokens && !hasAuthError) return

  if (hasRecoveryTokens) {
    capturedTokens = { access_token: accessToken!, refresh_token: refreshToken! }
    try {
      window.sessionStorage.setItem(RECOVERY_KEY, JSON.stringify(capturedTokens))
      window.sessionStorage.removeItem(RECOVERY_ERROR_KEY)
    } catch {
      // Se ignora: el respaldo en memoria (capturedTokens) es suficiente.
    }
  } else {
    // No se puede distinguir el error de una recuperación del de una
    // confirmación o un enlace mágico: Supabase no manda `type` en los errores.
    // Por eso la pantalla de restablecer enseña un mensaje NEUTRAL.
    capturedError = errorCode || '1'
    try {
      window.sessionStorage.setItem(RECOVERY_ERROR_KEY, capturedError)
      window.sessionStorage.removeItem(RECOVERY_KEY)
    } catch {
      // Se ignora: el respaldo en memoria (capturedError) es suficiente.
    }
  }

  // Reescribe la URL a la pantalla de restablecer SIN recargar y sin dejar el
  // token en el historial. El router lee la URL al montarse (después de este
  // módulo), así que no hace falta emitir ningún evento.
  //
  // El modo de rutas se relee de la variable de entorno: ver la nota de arriba
  // sobre por qué este archivo no importa nada.
  const isHashRouter = (import.meta.env.VITE_ROUTER ?? '').toLowerCase() !== 'browser'
  const base = import.meta.env.BASE_URL
  const target = isHashRouter
    ? `${window.location.pathname}${window.location.search}#/restablecer`
    : `${base}restablecer${window.location.search}`

  window.history.replaceState(null, '', target)
})()
