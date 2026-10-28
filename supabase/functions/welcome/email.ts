// Plantilla del correo de bienvenida.
//
// HTML con estilos EN LÍNEA y maquetado con <table>, igual que las plantillas
// de supabase/templates: los clientes de correo no cargan hojas de estilo y
// varios (Outlook el primero) siguen sin soportar flex ni grid.
//
// No lleva enlaces con token ni pide confirmar nada: la cuenta ya está activa.

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function welcomeEmail({ name, siteUrl }: { name: string; siteUrl: string }): {
  subject: string
  html: string
} {
  // El nombre viene de `user_metadata.full_name`, que lo escribe la persona:
  // se escapa antes de meterlo en el HTML aunque sea su propio correo.
  const firstName = escapeHtml(name.split(' ')[0] ?? '')
  // Fórmula neutra en género: no sabemos quién está al otro lado.
  const hello = firstName ? `¡Te damos la bienvenida, ${firstName}!` : '¡Te damos la bienvenida!'
  const site = escapeHtml(siteUrl)

  return {
    subject: '¡Te damos la bienvenida a Ferddo!',
    html: `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(23,37,84,0.08);">
            <tr>
              <td style="background:#0b2559;padding:26px;text-align:center;">
                <span style="color:#ffffff;font-size:24px;font-weight:800;letter-spacing:-0.5px;">Ferddo</span>
                <div style="color:#93c5fd;font-size:12px;margin-top:4px;">POS, inventario y facturación electrónica</div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 28px;">
                <h1 style="margin:0 0 12px;font-size:20px;color:#0b2559;">${hello}</h1>
                <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#334155;">
                  Tu cuenta ya está lista: no tienes que confirmar nada. Entra y
                  empieza a llevar tu negocio sin cuadernos ni hojas de cálculo.
                </p>
                <ul style="margin:0 0 22px;padding-left:20px;font-size:15px;line-height:1.8;color:#334155;">
                  <li>Crea tu espacio de trabajo en menos de un minuto.</li>
                  <li>Lleva tus registros al día desde el teléfono, con o sin conexión.</li>
                  <li>Invita a tu equipo cuando lo necesites.</li>
                </ul>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 22px;">
                  <tr>
                    <td style="border-radius:12px;background:#1a5ce6;">
                      <a href="${site}" style="display:inline-block;padding:14px 30px;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;border-radius:12px;">Entrar a Ferddo</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.5;">
                  ¿Alguna duda? Responde a este correo y te echamos una mano.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px;background:#f8fafc;text-align:center;border-top:1px solid #e2e8f0;">
                <span style="font-size:12px;color:#94a3b8;">Ferddo · POS, inventario y facturación electrónica</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
  }
}
