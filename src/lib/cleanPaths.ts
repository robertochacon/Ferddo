// URL "limpias" de las páginas públicas: ferddo.com/privacidad y /terminos.
//
// DEBE importarse en main.tsx DESPUÉS de recoveryBootstrap y antes de montar el
// router: reescribe la URL para que el router arranque en la ruta correcta.
//
// ¿Por qué hace falta? Con HashRouter la ruta de verdad es `/#/privacidad`, pero
// hay sitios donde solo cabe pegar una dirección normal —el formulario de un
// tercero que pide el aviso de privacidad, un buscador, un enlace por mensaje— y
// hay gente que la escribe a mano. Dos caminos llegan a esa URL sin fragmento:
//
//  1. Visita normal: el hosting sirve `public/privacidad/index.html`, un archivo
//     diminuto que redirige al fragmento. Este módulo no interviene.
//  2. Con la PWA instalada: el service worker responde CUALQUIER navegación con
//     el index.html precacheado (navigateFallback), así que el redirect estático
//     nunca llega a ejecutarse y la app arranca en `/privacidad` sin fragmento,
//     donde el catch-all del router la mandaría a la portada. Es este módulo el
//     que la rescata.
//
// SEGURIDAD DEL PARSEO: se actúa solo ante una lista CERRADA (CLEAN_PATHS) y
// solo si NO hay fragmento. Un `#/ruta` o los tokens de Supabase
// (`#access_token=…`) se dejan intactos: nada que venga de la URL decide a dónde
// se navega.

import { CLEAN_PATHS } from '@/lib/constants'
import { IS_HASH_ROUTER } from '@/lib/router'

;(function redirectCleanPath() {
  if (typeof window === 'undefined') return

  // NO-OP EXPLÍCITO con BrowserRouter: ahí `/privacidad` YA es la ruta real —el
  // hosting reescribe todo a index.html y el router la resuelve solo—, así que
  // no hay nada que rescatar. Reescribirla a un fragmento sería justo el error
  // contrario: convertiría una URL limpia y compartible en una con '#'.
  if (!IS_HASH_ROUTER) return

  if (window.location.hash) return

  // BASE_URL es '/' en un dominio propio y '/mi-repo/' en una project page.
  const base = import.meta.env.BASE_URL
  const path = window.location.pathname
  const rest = path.startsWith(base) ? path.slice(base.length) : path.replace(/^\//, '')
  const slug = `/${rest.replace(/\/$/, '').toLowerCase()}`

  const target = CLEAN_PATHS.find((p) => p === slug)
  if (!target) return

  // La ruta vuelve a la raíz de la app y el destino pasa al fragmento, que es lo
  // único que el HashRouter lee.
  window.history.replaceState(null, '', `${base}${window.location.search}#${target}`)
})()
