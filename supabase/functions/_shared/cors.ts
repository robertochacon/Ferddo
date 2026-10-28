// Cabeceras CORS compartidas por las Edge Functions.
//
// El origen va en '*' a propósito: la misma app se sirve desde varios sitios
// (dominio propio, GitHub Pages, Vercel, localhost en desarrollo) y mantener
// una lista blanca de orígenes aquí solo produce fallos difíciles de leer en el
// navegador. La autorización NO la da el origen —que cualquiera puede falsear
// fuera del navegador— sino el JWT que la función vuelve a validar por su
// cuenta con auth.getUser().
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

/** Respuesta JSON con las cabeceras CORS ya puestas. */
export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
