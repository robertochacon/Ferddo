import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'

// El base va en una variable porque el destino cambia el prefijo de TODAS las
// URLs del bundle: en un dominio propio o en Vercel es '/', pero en una
// "project page" de GitHub Pages (https://usuario.github.io/mi-repo/) tiene que
// ser '/mi-repo/'. Hardcodearlo deja la app rota en el otro destino: los
// <script> apuntan a rutas que no existen y solo se ve una pantalla en blanco.
const base = process.env.VITE_BASE ?? '/'

// https://vite.dev/config/
export default defineConfig({
  base,
  resolve: {
    alias: {
      // Gemelo del "paths" de tsconfig.app.json: uno resuelve tipos, este resuelve el bundle.
      '@': path.resolve(__dirname, './src'),
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Registro MANUAL y diferido (src/lib/pwa.ts): con el registro automático
      // el service worker descargaba su precache (~2.5 MB) en el arranque y
      // competía con los chunks de la primera pantalla; en GitHub Pages la
      // navegación inicial tardaba hasta 5 s en "Cargando…".
      injectRegister: false,
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'icons/*.png'],
      manifest: {
        name: 'Ferddo',
        short_name: 'Ferddo',
        description: 'POS, inventario y facturación electrónica para tu negocio.',
        theme_color: '#1a5ce6',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'any',
        lang: 'es',
        categories: ['business', 'productivity'],
        icons: [
          { src: 'icons/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/pwa-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/pwa-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Precache MÍNIMO: lo justo para que la app monte sin red (entry,
        // `vendor`, CSS, HTML e íconos). Los chunks de cada pantalla se guardan
        // al visitarla (regla CacheFirst de abajo). Probado en la web publicada:
        // precachear los ~90 archivos (2.5 MB) competía con las descargas de la
        // primera visita y dejaba pantallas hasta 5 s en "Cargando…". El
        // registro del service worker además se difiere (src/lib/pwa.ts).
        // Imágenes grandes (logo fuente, og.png, logotipo) fuera: no hacen falta
        // para operar sin conexión.
        globPatterns: ['**/*.{css,html,ico,woff2}', 'icons/*.png', 'assets/index-*.js', 'assets/vendor-*.js'],
        // Los redirectores de las URL limpias no se precachean: solo sirven
        // cuando NO hay service worker (con él, toda navegación cae en
        // index.html y de /privacidad se encarga src/lib/cleanPaths.ts).
        // Precachearlos sería peso muerto.
        globIgnores: ['privacidad/index.html', 'terminos/index.html'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            // Chunks JS de las pantallas (rutas lazy), con hash = inmutables:
            // CacheFirst es seguro y deja disponible offline lo ya visitado.
            urlPattern: ({ url, request, sameOrigin }) =>
              request.destination === 'script' && sameOrigin && url.pathname.includes('/assets/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'app-assets',
              expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Lecturas GET de Supabase (REST y Storage): NetworkFirst da datos
            // frescos con red y el último valor conocido cuando no la hay.
            urlPattern: ({ url, request }) =>
              request.method === 'GET' &&
              /\.supabase\.co\/(rest|storage)\//.test(url.href),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-read',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('node_modules/react') ||
            id.includes('node_modules/react-dom') ||
            id.includes('react-router') ||
            id.includes('@tanstack') ||
            id.includes('@supabase') ||
            id.includes('lucide-react') ||
            id.includes('date-fns') ||
            // clsx = base de cn(), usado en cada pantalla. DEBE ir en 'vendor'
            // (precacheado). Si Rollup lo deja en un chunk que NO se precachea
            // y el entry pasa a importarlo estáticamente, offline o tras un
            // deploy la app no monta → pantalla en blanco antes de React.
            id.includes('/clsx')
          ) {
            return 'vendor'
          }
        },
      },
    },
  },
})
