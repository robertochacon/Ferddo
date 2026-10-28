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
        // TODOS los chunks JS se precachean (≈2–3 MB). Antes solo iban el entry y
        // `vendor`, y las rutas lazy se servían con una regla CacheFirst en
        // tiempo de ejecución; en la PRIMERA visita, cuando el service worker
        // toma el control a mitad de sesión (clientsClaim), esas peticiones se
        // quedaban colgadas y la app se atascaba en "Cargando…" (reproducido
        // 2 de 4 veces en la web publicada; 0 de 5 sin service worker).
        // Precacheadas, las sirve el precache versionado: también offline y
        // también tras un deploy (el index viejo apunta a chunks de SU precache).
        globPatterns: ['**/*.{css,html,ico,png,svg,woff2}', 'assets/*.js'],
        // Los redirectores de las URL limpias no se precachean: solo sirven
        // cuando NO hay service worker (con él, toda navegación cae en
        // index.html y de /privacidad se encarga src/lib/cleanPaths.ts).
        // Precachearlos sería peso muerto.
        globIgnores: ['privacidad/index.html', 'terminos/index.html'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
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
