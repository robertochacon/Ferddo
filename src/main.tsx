// EL ORDEN DE ESTOS DOS IMPORTS ES PARTE DEL CONTRATO, no es estético.
//
// PRIMERO: captura el token de los enlaces de recuperación de contraseña, antes
// de que el cliente de Supabase o el router toquen el fragmento de la URL.
import '@/lib/recoveryBootstrap'
// DESPUÉS: convierte /privacidad y /terminos (las URL sin fragmento, las que se
// pegan fuera de la app) en la ruta que el router entiende. Va detrás porque el
// fragmento de recuperación tiene prioridad sobre cualquier ruta limpia.
import '@/lib/cleanPaths'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import App from './App'
import './index.css'
import { queryClient } from '@/lib/queryClient'
import { persister, registerOfflineMutations, resumeIfAuthed } from '@/lib/offline'
import { AuthProvider } from '@/auth/AuthProvider'
import { ToastProvider } from '@/components/ui/toast'
import { ErrorBoundary } from '@/components/ErrorBoundary'

// Los defaults de las mutaciones offline se registran ANTES de montar la app:
// las que quedaron en cola se rehidratan durante el arranque y solo se pueden
// reanudar si su `mutationFn` ya está ligada a la clave.
registerOfflineMutations(queryClient)

// Si Vite no logra precargar un módulo —el caso típico es un deploy: el índice
// en cache apunta a un chunk cuyo hash ya cambió— se recarga UNA vez para traer
// los assets frescos. El guard en sessionStorage usa la MISMA clave que
// lazyWithRetry en App.tsx, para que entre los dos solo haya una recarga.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  const KEY = 'ferddo-chunk-reloaded'
  if (!sessionStorage.getItem(KEY)) {
    sessionStorage.setItem(KEY, '1')
    window.location.reload()
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* El ErrorBoundary envuelve a TODO, providers incluidos: si el cache
        persistido llegara corrupto y reventara al hidratar, se ve una pantalla
        de error en vez de un blanco sin explicación. */}
    <ErrorBoundary>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          maxAge: 1000 * 60 * 60 * 24 * 14, // 14 días
          // OJO: cambiar el buster DESCARTA todo el cache persistido, incluida
          // la cola de mutaciones que aún no ha subido. No lo toques en un
          // deploy si puede haber trabajo sin sincronizar en algún teléfono.
          buster: 'ferddo-v1',
          dehydrateOptions: {
            // Se persiste todo lo que sigue en cola: las PAUSADAS (sin red) y
            // también las `pending`. Las dos, porque una mutación que espera a
            // que vuelva su dueño NO está 'paused' sino 'pending' —está entre
            // reintentos, ver NotMyQueueError— y con el filtro anterior se caía
            // de localStorage en la primera recarga: el trabajo desaparecía en
            // silencio, justo lo que la cola existe para evitar. Las ya
            // completadas siguen fuera: engordarían localStorage sin aportar nada.
            shouldDehydrateMutation: (m) => m.state.isPaused || m.state.status === 'pending',
          },
        }}
        onSuccess={() => {
          // Cache restaurado → intenta subir la cola cuanto antes si ya hay
          // sesión. Es solo un adelanto: quien impide que una mutación de otro
          // (o de nadie) se ejecute es el guard del propio `mutationFn`.
          void resumeIfAuthed(queryClient)
        }}
      >
        <AuthProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </AuthProvider>
      </PersistQueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
