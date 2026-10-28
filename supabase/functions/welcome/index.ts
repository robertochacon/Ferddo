// ═══════════════════════════════════════════════════════════════════════════
// Ferddo · Edge Function `welcome`
// Manda el correo de BIENVENIDA justo después del registro.
//
// ¿Por qué una función y no el cliente? Porque el correo sale por la API de
// Resend y su clave no puede pisar el navegador jamás.
//
// ¿Por qué no una plantilla de Supabase? Porque Supabase Auth solo manda
// correos de confirmación / recuperación / cambio de correo, y aquí la
// confirmación está APAGADA a propósito (ver supabase/config.toml: el registro
// entra directo). La bienvenida no es un correo de autenticación: no lleva
// token ni pide nada.
//
// SEGURIDAD
//   • Requiere JWT (`verify_jwt = true` en config.toml). Pero el gateway de
//     Supabase acepta también la anon key —que es pública— como JWT válido, así
//     que eso por sí solo no identifica a nadie: aquí se vuelve a validar con
//     auth.getUser() y la dirección se saca de ESE usuario, nunca del cuerpo de
//     la petición. Quien llama solo puede mandarse el correo a sí mismo.
//   • Si falta RESEND_API_KEY responde 200 con { sent: false }: un registro no
//     debe romperse porque no se pueda mandar una bienvenida.
//
// Despliegue:
//   supabase functions deploy welcome
//   supabase secrets set RESEND_API_KEY="re_..." PUBLIC_SITE_URL="https://ferddo.com"
// ═══════════════════════════════════════════════════════════════════════════
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/cors.ts'
import { welcomeEmail } from './email.ts'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? ''
// Debe ser un remitente verificado en Resend (sirve el mismo del SMTP de auth).
const FROM = Deno.env.get('WELCOME_FROM') ?? 'Ferddo <onboarding@resend.dev>'
// Sin barra final: los enlaces de la plantilla la añaden ellos.
const SITE_URL = (Deno.env.get('PUBLIC_SITE_URL') ?? 'https://ferddo.com').replace(/\/$/, '')

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405)

  const authHeader = req.headers.get('Authorization') ?? ''
  // Cliente con la ANON key + el JWT de quien llama: así `getUser()` resuelve a
  // esa persona y la función nunca actúa con más permisos de los que ya tiene.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } },
  )

  const { data, error } = await supabase.auth.getUser()
  const user = data?.user
  if (error || !user?.email) return json({ error: 'No autorizado' }, 401)

  if (!RESEND_API_KEY) {
    console.warn('[welcome] RESEND_API_KEY sin configurar: no se envía nada.')
    return json({ sent: false, reason: 'sin_proveedor' })
  }

  const name = (user.user_metadata?.full_name as string | undefined)?.trim() || ''
  const { subject, html } = welcomeEmail({ name, siteUrl: SITE_URL })

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to: [user.email], subject, html }),
  })

  if (!res.ok) {
    // Se registra en el log y se responde 200: quien acaba de crear su cuenta
    // no tiene por qué enterarse de que el proveedor de correo falló.
    console.error('[welcome] Resend respondió', res.status, await res.text())
    return json({ sent: false, reason: 'proveedor' })
  }

  return json({ sent: true })
})
