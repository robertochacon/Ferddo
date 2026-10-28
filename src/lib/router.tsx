import type { ReactNode } from 'react'
import { BrowserRouter, HashRouter } from 'react-router-dom'

/**
 * Modo de rutas, decidido en tiempo de build por VITE_ROUTER.
 *
 * HashRouter es el DEFECTO a propósito: `#/items` funciona en cualquier hosting
 * estático —GitHub Pages incluido— sin configurar nada, porque el servidor solo
 * ve la raíz y nunca recibe una ruta que no exista. Con BrowserRouter, entrar
 * directo a `/items` o recargar ahí devuelve un 404 salvo que el hosting
 * reescriba TODO a /index.html (eso hace `vercel.json`).
 *
 * Se lee una sola vez y se congela en una constante: si cambiara entre renders,
 * React desmontaría el router entero y se perdería el historial.
 */
export const IS_HASH_ROUTER = (import.meta.env.VITE_ROUTER ?? '').toLowerCase() !== 'browser'

/**
 * Prefijo del despliegue: '/' en un dominio propio y '/mi-repo/' en una
 * "project page" de GitHub Pages. Solo le importa a BrowserRouter, que sí ve la
 * ruta completa; con hash, todo lo que hay tras el '#' es independiente del
 * prefijo.
 */
const BROWSER_BASENAME = import.meta.env.BASE_URL

/**
 * Router de la aplicación. Envuelve al de react-router-dom que toque para que
 * ningún otro archivo tenga que saber en qué modo está: App.tsx pone
 * `<AppRouter>` y se olvida.
 */
export const AppRouter = ({ children }: { children: ReactNode }) =>
  IS_HASH_ROUTER ? (
    <HashRouter>{children}</HashRouter>
  ) : (
    <BrowserRouter basename={BROWSER_BASENAME}>{children}</BrowserRouter>
  )

/**
 * `href` de una ruta interna para un `<a>` de HTML.
 *
 * Hace falta donde NO se puede usar `<Link>`: enlaces fuera del árbol del
 * router, un `window.open` o un menú del sistema operativo. Escribir '#/items' a
 * mano rompería la app en cuanto alguien active VITE_ROUTER=browser, y escribir
 * '/items' la rompe hoy — esta función es el único sitio que decide cuál toca.
 */
export function routeHref(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  if (IS_HASH_ROUTER) return `#${p}`
  // Sin la barra final del base, o saldría '/mi-repo//items'.
  return `${BROWSER_BASENAME.replace(/\/$/, '')}${p}`
}
