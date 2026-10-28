import { onlineManager, type QueryClient } from '@tanstack/react-query'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { supabase } from '@/lib/supabase'
import { isUniqueViolation } from '@/lib/errors'
import type { Customer, CustomerDocType } from '@/types/erp'

/**
 * Clave de la mutación que SÍ funciona sin conexión: registrar un cliente. Es
 * lo que más se hace con la señal cortada (el vendedor en la calle, el colmado
 * con el internet caído) y es seguro reintentarlo porque el id lo pone el
 * cliente. Las VENTAS no van por aquí a propósito: dependen de caja abierta,
 * existencias y, a veces, de un e-NCF, y su modo offline se estudia aparte
 * (docs/SAAS_IMPLEMENTATION_PLAN.md §POS offline).
 */
export const OFFLINE_CREATE_CUSTOMER_KEY = ['createCustomer'] as const

/**
 * Datos para crear un cliente. Se define aquí, y no en el hook, porque quien
 * manda sobre la forma es la cola: estos objetos se serializan a localStorage y
 * pueden ejecutarse días después, en otra versión de la app.
 */
export interface CreateCustomerInput {
  /**
   * Generado en el CLIENTE con crypto.randomUUID(). Hace la mutación
   * idempotente: si el reintento re-inserta la misma fila, la base responde
   * 23505 y eso significa "ya estaba subido", no "falló".
   */
  id: string
  tenant_id: string
  /** Dueño de la fila encolada. `resumeIfAuthed` lo usa para no ejecutarla como otro. */
  created_by: string | null
  name: string
  kind: 'person' | 'company'
  doc_type: CustomerDocType
  doc_number: string | null
  phone: string | null
  email: string | null
  address: string | null
  credit_limit: number
  credit_days: number
  notes: string | null
}

/** Fila optimista todavía sin subir. La UI la marca con un indicador de "pendiente". */
export type PendingCustomer = Customer & { _pendingSync: true }

/**
 * Persistencia del cache de react-query en localStorage: lecturas disponibles
 * sin red + una cola de mutaciones que sobrevive a recargas y a cerrar la app.
 */
export const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: 'ferddo-query-cache',
  // Escribir en localStorage es síncrono y bloquea el hilo de la interfaz; con
  // throttle, una ráfaga de invalidaciones se guarda una sola vez.
  throttleTime: 1000,
})

/** Cuántas mutaciones esperan en la cola (pausadas por falta de red). */
export function pendingSyncCount(qc: QueryClient): number {
  return qc.getMutationCache().getAll().filter((m) => m.state.isPaused).length
}

/**
 * La mutación en cola no es de quien está usando la app ahora (o no hay sesión).
 *
 * Es un CENTINELA, no un fallo: se lanza antes de tocar la base para que la fila
 * NO se queme. La política de reintentos lo trata aparte (reintento eterno, cada
 * minuto), así que la mutación se queda esperando a su dueño en vez de agotar
 * los reintentos y morir en estado de error.
 */
export class NotMyQueueError extends Error {
  constructor() {
    super('La operación en cola es de otra sesión; se reintentará cuando vuelva su dueño')
    this.name = 'NotMyQueueError'
  }
}

/**
 * Registra los defaults de las mutaciones que deben funcionar sin conexión.
 *
 * Se hace a nivel de queryClient y NO dentro del hook: una mutación que quedó en
 * cola ayer se rehidrata al arrancar la app sin que ningún componente se haya
 * montado todavía, y react-query solo sabe cómo ejecutarla si encuentra estos
 * defaults ligados a su `mutationKey`. Si se registraran en el hook, la cola
 * quedaría con mutaciones sin `mutationFn`, imposibles de reanudar.
 *
 * Y la comprobación de sesión/dueño vive DENTRO del `mutationFn`, no fuera: el
 * `QueryClient.mount()` que dispara `QueryClientProvider` al montar se suscribe
 * por su cuenta a `focusManager` y a `onlineManager` y llama a
 * `resumePausedMutations()`, que reanuda TODA la cola sin mirar quién hay
 * conectado. Cualquier guard externo (como `resumeIfAuthed`) se lo salta la
 * propia librería; el único punto que no se puede esquivar es el camino de
 * ejecución de la mutación.
 */
export function registerOfflineMutations(qc: QueryClient) {
  qc.setMutationDefaults(OFFLINE_CREATE_CUSTOMER_KEY, {
    networkMode: 'online',
    mutationFn: async (input: CreateCustomerInput): Promise<string> => {
      const { data } = await supabase.auth.getSession()
      const uid = data.session?.user?.id
      if (!uid) throw new NotMyQueueError()
      if (input.created_by && input.created_by !== uid) throw new NotMyQueueError()

      const { error } = await supabase.from('customers').insert({ ...input })
      // Solo el choque de la CLAVE PRIMARIA significa "ya estaba subido". Un
      // 23505 por documento repetido (customers_doc_idx) es un error real: si
      // se tragara, el cliente desaparecería de la cola sin existir en la base.
      if (error && !(isUniqueViolation(error) && /customers_pkey/.test(error.message ?? ''))) throw error
      return input.id
    },
    onMutate: async (input: CreateCustomerInput) => {
      await qc.cancelQueries({ queryKey: ['customers'] })
      const prev = qc.getQueriesData({ queryKey: ['customers'] })
      const now = new Date().toISOString()
      const optimistic: PendingCustomer = {
        ...input,
        is_active: true,
        created_at: now,
        updated_at: now,
        _pendingSync: true,
      }
      // setQueriesData (en plural): hay claves derivadas y hay que tocarlas todas.
      qc.setQueriesData({ queryKey: ['customers'] }, (old: unknown) => {
        if (!Array.isArray(old)) return old
        return [optimistic, ...old]
      })
      return { prev }
    },
    onError: (_err, _input, ctx) => {
      const c = ctx as { prev?: [readonly unknown[], unknown][] } | undefined
      c?.prev?.forEach(([key, data]) => qc.setQueryData(key as readonly unknown[], data))
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['customers'] })
    },
    retry: (n, err) => (err instanceof NotMyQueueError ? true : n < 3),
    retryDelay: (n, err) =>
      err instanceof NotMyQueueError ? 60_000 : Math.min(1000 * 2 ** n, 30_000),
  })

  // Al recuperar la red, intenta subir la cola — SOLO si hay sesión válida.
  onlineManager.subscribe((online) => {
    if (online) void resumeIfAuthed(qc)
  })
}

/**
 * Reanuda la cola SOLO si hay sesión autenticada, y solo lo del usuario actual.
 *
 * OJO: esto YA NO es la defensa que evita perder datos —esa vive dentro del
 * `mutationFn`, ver `NotMyQueueError`—, porque la librería reanuda la cola por
 * su cuenta desde `QueryClient.mount()` y nunca pasa por aquí. Lo de aquí es una
 * OPTIMIZACIÓN: despierta cuanto antes lo que sí se puede subir ahora mismo y
 * evita mover lo que se sabe que va a volver a quedarse esperando.
 *
 * Se miran las PAUSADAS (las que no salieron por falta de red) y también las
 * `pending`: una mutación que está esperando a que vuelva su dueño no está
 * pausada, está entre reintentos, y así es como se rehidrata tras una recarga.
 */
export async function resumeIfAuthed(qc: QueryClient): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession()
    const uid = data.session?.user?.id
    if (!uid) return // sin sesión: la cola queda PAUSADA, no se quema como anon
    const waiting = qc
      .getMutationCache()
      .getAll()
      .filter((m) => m.state.isPaused || m.state.status === 'pending')
    await Promise.all(
      waiting
        .filter((m) => {
          const vars = m.state.variables as { created_by?: string | null } | undefined
          // Sin `created_by` no se puede saber de quién es; se intenta, porque
          // dejarla pausada para siempre también sería perderla.
          return !vars?.created_by || vars.created_by === uid
        })
        // `.catch` por mutación: una que falle no debe abortar el resto.
        .map((m) => m.continue().catch(() => {})),
    )
  } catch {
    /* noop: sin sesión legible, la cola espera */
  }
}

/**
 * Sube la cola (si hay red y sesión) y espera a que drene. Úsalo ANTES de cerrar
 * sesión. Devuelve cuántas quedaron sin subir, para poder avisar.
 */
export async function flushOfflineQueue(qc: QueryClient): Promise<number> {
  if (onlineManager.isOnline()) {
    await resumeIfAuthed(qc)
  }
  return pendingSyncCount(qc)
}

/**
 * Limpia SOLO las lecturas (cache de consultas + cache de lecturas del service
 * worker) al cerrar sesión, por higiene en dispositivos compartidos.
 *
 * CONSERVA a propósito la cola de mutaciones: son datos que la persona ya dio
 * por guardados y que aún no llegaron al servidor. Se reintentarán cuando el
 * MISMO usuario vuelva a entrar con conexión. El persister vuelve a guardar el
 * estado (consultas vacías + cola intacta), así que la cola sobrevive.
 *
 * Si otra cuenta entra en el mismo dispositivo antes de que se sincronice, esas
 * mutaciones fallarán por RLS (otro tenant): falla segura, nunca una escritura
 * cruzada entre negocios.
 */
export async function clearOfflineCache(qc: QueryClient) {
  qc.getQueryCache().clear() // borra lecturas; NO toca la cola de mutaciones
  if (typeof caches !== 'undefined') {
    try {
      await caches.delete('supabase-read')
    } catch {
      /* noop: sin service worker no hay nada que limpiar */
    }
  }
}
