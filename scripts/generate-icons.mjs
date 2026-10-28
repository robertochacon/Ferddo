// ═══════════════════════════════════════════════════════════════════════════
// Ferddo · Íconos (favicon, PWA, Apple, Open Graph)
// Uso: npm run icons
//
// Fuente única: public/logo.png. Cambiar la marca = cambiar ESE archivo.
// Por eso public/icons/ no se versiona: se regenera en cada build (ver
// .github/workflows/deploy.yml y el buildCommand de vercel.json).
// ═══════════════════════════════════════════════════════════════════════════
import { access, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const SRC = path.join(root, 'public', 'logo.png')
const OUT = path.join(root, 'public', 'icons')

// Fondo de los íconos. Un ícono de app con transparencia se ve mal instalado
// (iOS pinta negro por detrás y el lanzador de Android no garantiza nada), así
// que el blanco se añade a propósito con `.flatten()`.
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 }

// Colores de marca (gemelos de tailwind.config.js) para la imagen social.
const BRAND = '#1a5ce6'
const INK = '#0b2559'
const MUTED = '#64748b'

/**
 * Escribe un .ico con varias imágenes PNG dentro.
 * Estructura: ICONDIR (6 bytes) + una ICONDIRENTRY de 16 bytes por imagen +
 * los PNG en bruto, uno detrás de otro.
 *
 * Existe porque sharp no sabe escribir .ico. Guardar un PNG con extensión .ico
 * "funciona" (los navegadores lo adivinan por los bytes), pero es un archivo
 * mal formado; el formato ICO admite payloads PNG desde Vista, así que basta
 * con montar la cabecera a mano.
 */
async function writeIco(dest, pngs, sizes) {
  const HEADER = 6
  const ENTRY = 16
  const header = Buffer.alloc(HEADER)
  header.writeUInt16LE(0, 0) // reservado
  header.writeUInt16LE(1, 2) // 1 = icono
  header.writeUInt16LE(pngs.length, 4)

  const entries = []
  let offset = HEADER + ENTRY * pngs.length
  pngs.forEach((png, i) => {
    const e = Buffer.alloc(ENTRY)
    // 0 significa 256 en este campo; aquí nunca llegamos a ese tamaño.
    e.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], 0)
    e.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], 1)
    e.writeUInt8(0, 2) // colores de la paleta (0 = sin paleta)
    e.writeUInt8(0, 3) // reservado
    e.writeUInt16LE(1, 4) // planos
    e.writeUInt16LE(32, 6) // bits por píxel
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += png.length
  })

  await writeFile(dest, Buffer.concat([header, ...entries, ...pngs]))
}

async function main() {
  // Sin logo no hay nada que hacer, pero SALIMOS CON ÉXITO: este script corre
  // dentro del build del CI y un repo recién clonado (o un fork al que aún no
  // le han puesto su marca) no debe fallar el despliegue por esto.
  try {
    await access(SRC)
  } catch {
    console.warn('⚠️  No encuentro public/logo.png: no genero íconos.')
    console.warn('   Pon ahí tu logo (PNG cuadrado, 512px o más) y vuelve a')
    console.warn('   ejecutar `npm run icons`. El build sigue sin íconos propios.')
    return
  }

  // sharp se importa DESPUÉS de comprobar el logo y de forma dinámica: así el
  // aviso de arriba también funciona en una instalación sin devDependencies.
  const { default: sharp } = await import('sharp')

  await mkdir(OUT, { recursive: true })

  const square = [
    { size: 192, name: 'pwa-192.png' },
    { size: 512, name: 'pwa-512.png' },
    { size: 180, name: 'apple-touch-icon.png' },
    // Google pide que el favicon que sale en los resultados de búsqueda sea un
    // múltiplo de 48px. Los de 32 y 16 se quedan para la pestaña del navegador,
    // pero el que index.html declara primero es el de 48.
    { size: 96, name: 'favicon-96.png' },
    { size: 48, name: 'favicon-48.png' },
    { size: 32, name: 'favicon-32.png' },
    { size: 16, name: 'favicon-16.png' },
  ]

  for (const { size, name } of square) {
    await sharp(SRC)
      .resize(size, size, { fit: 'contain', background: WHITE })
      .flatten({ background: WHITE })
      .png()
      .toFile(path.join(OUT, name))
    console.log('✓', name)
  }

  // Ícono "maskable": el mismo logo con margen para que la zona segura del
  // recorte circular de Android no se coma el dibujo.
  const padded = Math.round(512 * 0.72)
  const pad = Math.round((512 - padded) / 2)
  await sharp(SRC)
    .resize(padded, padded, { fit: 'contain', background: WHITE })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: WHITE })
    .flatten({ background: WHITE })
    .png()
    .toFile(path.join(OUT, 'pwa-maskable-512.png'))
  console.log('✓ pwa-maskable-512.png')

  // favicon.ico REAL, con 16/32/48 dentro. Va en la raíz de public porque hay
  // clientes viejos que lo piden por /favicon.ico sin mirar el HTML.
  await writeIco(
    path.join(root, 'public', 'favicon.ico'),
    await Promise.all(
      [16, 32, 48].map((size) =>
        sharp(SRC)
          .resize(size, size, { fit: 'contain', background: WHITE })
          .flatten({ background: WHITE })
          .png()
          .toBuffer(),
      ),
    ),
    [16, 32, 48],
  )
  console.log('✓ favicon.ico (16/32/48, ICO válido)')

  // Imagen social (Open Graph / Twitter) 1200x630 para las vistas previas al
  // compartir el enlace por WhatsApp, Facebook o LinkedIn.
  const OG_W = 1200
  const OG_H = 630
  const ogLogoSize = 300
  const ogLogo = await sharp(SRC)
    .resize(ogLogoSize, ogLogoSize, { fit: 'contain', background: WHITE })
    .flatten({ background: WHITE })
    .png()
    .toBuffer()

  const ogSvg = `<svg width="${OG_W}" height="${OG_H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <rect x="0" y="0" width="14" height="${OG_H}" fill="${BRAND}"/>
    <g font-family="DejaVu Sans, Arial, Helvetica, sans-serif">
      <text x="470" y="262" font-size="94" font-weight="800" fill="${BRAND}">Ferddo</text>
      <text x="472" y="332" font-size="42" font-weight="700" fill="${INK}">POS, inventario y facturación</text>
      <text x="472" y="396" font-size="27" font-weight="500" fill="${MUTED}">Ventas · caja · compras · e-CF DGII · reportes</text>
    </g>
  </svg>`

  // El texto del SVG lo rasteriza librsvg con las fuentes del sistema. En una
  // máquina sin fuentes instaladas eso revienta, y una vista previa social no
  // vale un build roto: se avisa y se sigue.
  try {
    await sharp(Buffer.from(ogSvg))
      .composite([{ input: ogLogo, left: 100, top: Math.round((OG_H - ogLogoSize) / 2) }])
      .png()
      .toFile(path.join(root, 'public', 'og.png'))
    console.log('✓ og.png')
  } catch (err) {
    console.warn('⚠️  No pude generar og.png (¿faltan fuentes del sistema?):', err.message)
  }

  console.log('\nÍconos generados en public/icons ✅')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
