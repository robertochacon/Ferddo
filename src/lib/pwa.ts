import { registerSW } from 'virtual:pwa-register'

/**
 * Registra el service worker cuando la app YA cargó y el navegador está
 * ocioso, no en el arranque.
 *
 * Por qué: al registrarse, el service worker descarga el precache completo
 * (todos los chunks, ~2.5 MB) y esas descargas comparten las pocas conexiones
 * por dominio con los chunks que la primera pantalla necesita ya. En la web
 * publicada eso dejaba la primera navegación hasta 5 s en "Cargando…". Diferido,
 * la primera visita va directa a la red y el modo offline queda listo segundos
 * después; en las visitas siguientes el service worker ya está instalado.
 *
 * `immediate: true` dentro del diferido: una vez decidido el momento, que se
 * registre sin esperar a otro evento `load` (que ya pasó).
 */
export function registerServiceWorkerWhenIdle(delayMs = 8000): void {
  if (!('serviceWorker' in navigator)) return
  const go = () => {
    registerSW({ immediate: true })
  }
  const idle = (cb: () => void) =>
    'requestIdleCallback' in window
      ? (window as Window & { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback(cb)
      : setTimeout(cb, 0)
  // Si ya hay uno instalado (visitas siguientes) no compite con nada: se
  // registra en seguida para que las actualizaciones lleguen rápido.
  if (navigator.serviceWorker.controller) {
    go()
    return
  }
  window.addEventListener('load', () => setTimeout(() => idle(go), delayMs), { once: true })
}
