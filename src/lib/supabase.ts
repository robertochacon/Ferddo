import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  // Sin las variables el cliente se crea igual (con cadenas vacías) para que la
  // app monte y se vea la pantalla en vez de un blanco: cada llamada fallará,
  // pero con este mensaje en consola se sabe exactamente por qué.
  console.error(
    '[Ferddo] Faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. ' +
      'Copia .env.example a .env y complétalas.',
  )
}

export const supabase = createClient(url ?? '', anonKey ?? '', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // El enlace del correo vuelve con la sesión en el fragmento de la URL y
    // supabase-js la canjea solo. Ver src/lib/recoveryBootstrap.ts, que se
    // adelanta a este cliente para que el router no borre el token antes.
    detectSessionInUrl: true,
    // Clave propia en localStorage: dos apps servidas desde el mismo origen
    // (o la app y su preview) no se pisan la sesión.
    storageKey: 'ferddo-auth',
  },
})

/** ¿Están las variables? La UI lo usa para avisar en vez de fallar en cada consulta. */
export const hasSupabaseConfig = Boolean(url && anonKey)

/**
 * Base de las Edge Functions. Cadena vacía si falta la URL, para que quien la
 * concatene produzca una ruta rota y visible en vez de llamar a `undefined/...`.
 */
export const functionsUrl = url ? `${url}/functions/v1` : ''
