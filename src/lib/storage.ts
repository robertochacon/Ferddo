import { supabase } from '@/lib/supabase'

/**
 * Buckets del proyecto. La convención de rutas es SIEMPRE `<tenant_id>/…`
 * porque las políticas de Storage comparan
 * `(storage.foldername(name))[1] = auth_tenant_id()::text`: el aislamiento entre
 * negocios depende de que el primer segmento sea el id del negocio. Si un día se
 * sube algo fuera de esa carpeta, queda visible para cualquiera con sesión.
 */
export type StorageBucket = 'logos' | 'files'

const TENANT_BUCKETS: readonly StorageBucket[] = ['logos', 'files']

/**
 * Sube un archivo a la carpeta del negocio.
 *
 * Devuelve el `path` (lo que se guarda en la base para los buckets privados) y
 * la URL pública, que solo existe en `logos`: para `files` hay que pedir una URL
 * firmada en el momento de usarla, porque el bucket es privado a propósito.
 */
export async function uploadFile(
  bucket: StorageBucket,
  tenantId: string,
  file: File,
  prefix = '',
): Promise<{ path: string; publicUrl: string | null }> {
  const ext = file.name.split('.').pop() ?? 'bin'
  // Nombre nuevo en cada subida: timestamp para que ordene solo y un sufijo
  // aleatorio para que dos subidas del mismo segundo no choquen. Además evita
  // reutilizar el nombre original, que puede traer acentos, espacios o el
  // nombre real de un cliente.
  const rand = crypto.randomUUID().slice(0, 8)
  const name = `${tenantId}/${prefix}${Date.now()}-${rand}.${ext}`

  const { error } = await supabase.storage.from(bucket).upload(name, file, {
    cacheControl: '3600',
    // `upsert: false`: con nombres únicos, un choque significa que algo va mal;
    // mejor enterarse que pisar en silencio el archivo de otro.
    upsert: false,
  })
  if (error) throw error

  const publicUrl =
    bucket === 'logos' ? supabase.storage.from(bucket).getPublicUrl(name).data.publicUrl : null

  return { path: name, publicUrl }
}

/** Archivo a borrar: bucket + ruta completa, tal como los devuelve el servidor. */
export interface StoredFile {
  bucket: string
  path: string
}

/**
 * Vacía TODOS los archivos de un negocio con la API de Storage — la única forma
 * de eliminarlos de verdad: quitar la fila de `storage.objects` por SQL deja el
 * blob huérfano en el bucket, ocupando espacio que se paga y sin manera de
 * volver a encontrarlo.
 *
 * Se usa al eliminar un negocio, DESPUÉS de que la RPC hizo commit: solo
 * entonces la política de Storage abre esa carpeta al super-admin (porque el
 * negocio ya aparece en `tenant_purges`). Las rutas que devolvió la RPC entran
 * como pista, pero no se confía solo en ellas: la carpeta se lista aquí también,
 * así que se limpia lo que el servidor no llegó a ver o dejó fuera del tope.
 *
 * NO lanza: el borrado de la base ya se hizo y no se puede deshacer, así que un
 * fallo aquí se informa, no se convierte en excepción. `pending` es lo que
 * quedaba en el bucket contado DESPUÉS de borrar, y `null` cuando no se pudo
 * listar — que no es lo mismo que "cero".
 */
export async function removeTenantFiles(
  tenantId: string,
  hinted: StoredFile[] = [],
): Promise<{ removed: number; pending: number | null }> {
  const targets = new Map<string, Set<string>>(TENANT_BUCKETS.map((b) => [b, new Set<string>()]))
  for (const f of hinted) {
    const set = targets.get(f.bucket)
    // Se ignora una pista de un bucket que no es del negocio: nada que venga del
    // servidor debe poder apuntar el borrado a otro sitio.
    if (set) set.add(f.path)
  }

  let listedAll = true
  for (const bucket of TENANT_BUCKETS) {
    const found = await listFolder(bucket, tenantId)
    if (found === null) listedAll = false
    else for (const path of found) targets.get(bucket)!.add(path)
  }

  let removed = 0
  for (const [bucket, set] of targets) {
    const paths = [...set]
    // Por lotes: una sola llamada con miles de rutas se pasa del límite de la API.
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = paths.slice(i, i + 100)
      try {
        // `remove()` NO devuelve error por las rutas que ignora (las que la RLS
        // le esconde, o las que ya no están): responde 200 con la lista de lo
        // que sí borró. Contar el lote entero por no haber error diría "listo"
        // mientras los archivos siguen ahí.
        const { data, error } = await supabase.storage.from(bucket).remove(chunk)
        if (!error) removed += data?.length ?? 0
      } catch {
        // Se ignora: lo que quedó lo dirá el recuento final.
      }
    }
  }

  // Recuento final contra el bucket, no contra lo que creíamos haber borrado.
  let pending: number | null = 0
  for (const bucket of TENANT_BUCKETS) {
    const left = await listFolder(bucket, tenantId)
    if (left === null) pending = null
    else if (pending !== null) pending += left.length
  }
  return { removed, pending: listedAll ? pending : null }
}

/**
 * Lista recursivamente una carpeta. `null` = no se pudo listar (sin permiso, sin
 * red), que NO es lo mismo que "está vacía": confundirlos haría que la UI
 * cantara victoria dejando archivos dentro.
 */
async function listFolder(bucket: string, prefix: string): Promise<string[] | null> {
  const out: string[] = []
  const PAGE = 1000
  let offset = 0
  for (;;) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: PAGE, offset })
    if (error) return null
    if (!data || data.length === 0) break
    for (const entry of data) {
      const path = `${prefix}/${entry.name}`
      // Storage no tiene carpetas de verdad: las entradas que las representan
      // vienen SIN `id`, y hay que bajar un nivel para ver qué cuelga de ahí.
      if (!entry.id) {
        const nested = await listFolder(bucket, path)
        if (nested === null) return null
        out.push(...nested)
      } else {
        out.push(path)
      }
    }
    if (data.length < PAGE) break
    offset += data.length
  }
  return out
}
