/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Variables del frontend. TODO lo que empieza por VITE_ se inlinea en `dist` y
 * queda a la vista de cualquiera: aquí solo van datos públicos.
 */
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  readonly VITE_APP_NAME?: string
  readonly VITE_PUBLIC_URL?: string
  /** Prefijo del build. Lo lee vite.config.ts vía process.env, no el navegador. */
  readonly VITE_BASE?: string
  /** 'hash' (por defecto) o 'browser'. Ver src/lib/router.tsx. */
  readonly VITE_ROUTER?: string
  /**
   * 'false' oculta «Continuar con Google» mientras el proveedor no esté activo
   * en Supabase (un botón que siempre falla no es una opción).
   */
  readonly VITE_GOOGLE_AUTH?: string
  /**
   * Cuentas del acceso rápido del login (src/pages/auth/DevQuickLogin.tsx).
   * Solo se leen con `npm run dev`; en `vite build` el módulo no se emite.
   * Van en `.env.local`, nunca en `.env.example`.
   */
  readonly VITE_DEV_ADMIN_EMAIL?: string
  readonly VITE_DEV_ADMIN_PASSWORD?: string
  readonly VITE_DEV_USER_EMAIL?: string
  readonly VITE_DEV_USER_PASSWORD?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
