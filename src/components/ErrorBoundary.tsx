import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Logo } from '@/components/Logo'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

/**
 * Captura errores de render en TODO el árbol y muestra una pantalla de
 * recuperación en vez de dejar la app en blanco (white screen of death).
 *
 * Cubre el caso más común en producción: tras un deploy nuevo, el HTML servido
 * por el service worker apunta a chunks con hashes viejos que ya no existen en
 * el hosting; el import() dinámico de una ruta `lazy()` lanza y, como
 * <Suspense> NO atrapa errores, sin este límite React desmontaría toda la app.
 *
 * Los fallos de carga de chunk se auto-recuperan con una recarga (ver
 * `lazyWithRetry` en App.tsx); este límite es la red de seguridad para el resto
 * (y para cuando la recarga tampoco resolvió).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Deja rastro en consola para diagnóstico (no hay logging remoto).
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-slate-50 px-6 text-center">
        <Logo className="h-16 w-16 opacity-80" />
        <div>
          <h1 className="text-lg font-bold text-slate-900">Algo salió mal</h1>
          <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
            No pudimos cargar la app. Suele resolverse recargando; lo que ya habías
            guardado no se pierde.
          </p>
        </div>
        {/* Botón de HTML puro, sin la primitiva <Button>: esta pantalla existe
            justo para cuando algo del árbol falló al cargar, así que cuanto menos
            código dependa de ella, mejor. */}
        <button
          onClick={() => window.location.reload()}
          className="inline-flex h-11 items-center justify-center rounded-xl bg-brand-600 px-6 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
        >
          Recargar
        </button>
      </div>
    )
  }
}
