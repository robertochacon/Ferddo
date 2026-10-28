#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// AppName · Renombrar el starter
//
// Sustituye los marcadores de posición por el nombre real del producto:
//   AppName  → nombre visible  ("Mi Producto")
//   appname  → slug de máquina ("miproducto")
// y sus variantes de casing (APPNAME, Appname).
//
// Uso:
//   node scripts/rename.mjs "Mi Producto" miproducto          ← simulacro
//   node scripts/rename.mjs "Mi Producto" miproducto --yes     ← escribe
//
// Sin --yes NO toca nada: imprime qué archivos cambiarían y cuántas veces.
// Es a propósito — esto reescribe medio repo de una pasada y conviene mirar la
// lista antes, sobre todo si ya empezaste a modificarlo.
//
// Sin dependencias: se ejecuta con Node pelado, antes incluso de `npm install`.
// ═══════════════════════════════════════════════════════════════════════════
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

// Carpetas que no se recorren: o son generadas, o son de la herramienta.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-ssr',
  '.vercel',
  '.next',
  'coverage',
  '.turbo',
  'supabase/.temp',
])

// Este mismo archivo se excluye: si se renombrara a sí mismo perdería los
// marcadores del mapa de abajo y una segunda ejecución no encontraría nada.
const SKIP_FILES = new Set([path.join('scripts', 'rename.mjs')])

// Binarios: no tiene sentido buscar texto y reescribirlos los corrompe.
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.icns',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.gz', '.tgz', '.mp4', '.mov', '.webm', '.mp3', '.wav',
  '.tsbuildinfo',
])

// Archivos enormes (lockfiles gigantes, volcados): no contienen marcadores y
// leerlos en memoria por nada ralentiza el recorrido.
const MAX_BYTES = 5 * 1024 * 1024

function fail(msg) {
  console.error(`\n✖ ${msg}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const yes = argv.includes('--yes')
  const rest = argv.filter((a) => a !== '--yes')
  const [displayName, slug] = rest

  if (!displayName || !slug) {
    fail(
      'Faltan argumentos.\n\n' +
        '  node scripts/rename.mjs "Mi Producto" miproducto [--yes]\n\n' +
        '  1) nombre visible: como se lee en la interfaz y los correos\n' +
        '  2) slug: minúsculas, sin espacios ni acentos (claves de storage,\n' +
        '     project_id de Supabase, nombre del paquete npm)',
    )
  }
  // El slug acaba en identificadores que no admiten cualquier cosa: la clave de
  // localStorage, el project_id de Supabase y una GUC de Postgres
  // (<slug>.purging_tenant). Se valida aquí y no cuando ya está escrito.
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
    fail(`Slug inválido: "${slug}". Debe empezar por letra y llevar solo a-z, 0-9 y guiones.`)
  }
  if (/["'<>&]/.test(displayName)) {
    fail(`El nombre visible no puede llevar " ' < > &: acaba dentro de HTML y JSON sin escapar.`)
  }
  return { displayName, slug, yes }
}

const { displayName, slug, yes } = parseArgs(process.argv.slice(2))

// Un solo regex con todas las variantes y un mapa: haciéndolo en pasadas
// sucesivas, un nombre como "Appname" volvería a casar con la pasada siguiente
// y se sustituiría dos veces.
const MARKERS = {
  AppName: displayName,
  APPNAME: slug.toUpperCase(),
  Appname: slug.charAt(0).toUpperCase() + slug.slice(1),
  appname: slug,
}
const PATTERN = /AppName|APPNAME|Appname|appname/g

/** Recorre el árbol devolviendo rutas relativas a la raíz del repo. */
async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    const rel = path.relative(root, full)
    // Los enlaces simbólicos se ignoran: pueden salirse del repo o hacer ciclos.
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || SKIP_DIRS.has(rel)) continue
      yield* walk(full)
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(rel)) continue
      if (BINARY_EXT.has(path.extname(entry.name).toLowerCase())) continue
      yield rel
    }
  }
}

const changes = []
let scanned = 0

for await (const rel of walk(root)) {
  let raw
  try {
    raw = await readFile(path.join(root, rel))
  } catch {
    continue
  }
  if (raw.byteLength > MAX_BYTES) continue
  // Un byte nulo delata un binario sin extensión conocida.
  if (raw.includes(0)) continue

  scanned++
  const text = raw.toString('utf8')
  const hits = text.match(PATTERN)
  if (!hits) continue

  changes.push({ rel, count: hits.length, next: text.replace(PATTERN, (m) => MARKERS[m]) })
}

if (changes.length === 0) {
  console.log(`\nNo queda ningún marcador AppName/appname en ${scanned} archivos. Nada que hacer.\n`)
  process.exit(0)
}

changes.sort((a, b) => b.count - a.count || a.rel.localeCompare(b.rel))
const total = changes.reduce((sum, c) => sum + c.count, 0)

console.log(`\n  AppName  →  ${displayName}`)
console.log(`  appname  →  ${slug}\n`)
for (const { rel, count } of changes) {
  console.log(`  ${String(count).padStart(4)}×  ${rel}`)
}
console.log(`\n  ${total} sustituciones en ${changes.length} archivos (${scanned} revisados).`)

if (!yes) {
  console.log('\n  Simulacro: no se ha escrito nada.')
  console.log(`  Repite con --yes para aplicarlo:\n`)
  console.log(`    node scripts/rename.mjs "${displayName}" ${slug} --yes\n`)
  process.exit(0)
}

for (const { rel, next } of changes) {
  await writeFile(path.join(root, rel), next, 'utf8')
}

console.log('\n✅ Listo.\n')
console.log('  Queda por hacer a mano:')
console.log('   1. Sustituir public/logo.png por tu logo y ejecutar `npm run icons`.')
console.log(`   2. Cambiar el dominio de ejemplo por el tuyo (ahora dice ${slug}.com)`)
console.log('      en index.html, supabase/config.toml y src/lib/constants.ts.')
console.log('   3. Ajustar la paleta de marca en tailwind.config.js.')
console.log('   4. Revisar supabase/config.toml y hacer `supabase config push`.')
console.log('   5. Definir los secrets VITE_* del repositorio para el deploy.\n')
