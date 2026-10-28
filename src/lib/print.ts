/**
 * Impresión de documentos (tickets 58/80 mm, cotizaciones, comprobantes).
 *
 * Se imprime desde un iframe oculto con su propio HTML y CSS, no desde la
 * página: así el ticket no hereda el layout de la app y el diálogo de
 * impresión ve solo el documento. Imprimir NUNCA forma parte de guardar: la
 * venta ya existe cuando se llama a esto, y se puede reimprimir siempre.
 *
 * Para impresoras térmicas que el navegador no alcanza (USB/serie sin driver),
 * el camino previsto es un agente local; ver docs/SAAS_IMPLEMENTATION_PLAN.md.
 */
export type PaperWidth = 58 | 80 | 'letter'

const PAGE_CSS: Record<PaperWidth, string> = {
  58: '@page { size: 58mm auto; margin: 2mm } body { width: 54mm; font-size: 11px }',
  80: '@page { size: 80mm auto; margin: 3mm } body { width: 74mm; font-size: 12px }',
  letter: '@page { size: letter; margin: 14mm } body { font-size: 12px }',
}

const BASE_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace; color: #000; }
  h1, h2, h3, p { margin: 0; }
  .c { text-align: center } .r { text-align: right } .b { font-weight: 700 }
  .hr { border-top: 1px dashed #000; margin: 6px 0 }
  table { width: 100%; border-collapse: collapse }
  td, th { padding: 2px 0; vertical-align: top }
  .doc { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  .doc th { text-align: left; border-bottom: 1px solid #333; padding: 6px 4px }
  .doc td { border-bottom: 1px solid #ddd; padding: 6px 4px }
  .muted { color: #555 }
  img.qr { width: 30mm; height: 30mm; image-rendering: pixelated }
`

/** Escapa texto para incrustarlo en el HTML del documento. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function printHtml(bodyHtml: string, paper: PaperWidth = 80, title = 'Documento'): void {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;'
  document.body.appendChild(iframe)
  const doc = iframe.contentDocument
  if (!doc) return
  doc.open()
  doc.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>` +
      `<style>${BASE_CSS}${PAGE_CSS[paper]}</style></head><body>${bodyHtml}</body></html>`,
  )
  doc.close()
  const win = iframe.contentWindow
  // Se espera a que carguen las imágenes (logo, QR) antes de abrir el diálogo.
  const go = () => {
    win?.focus()
    win?.print()
    setTimeout(() => iframe.remove(), 1000)
  }
  if (doc.readyState === 'complete') setTimeout(go, 50)
  else iframe.onload = go
}
