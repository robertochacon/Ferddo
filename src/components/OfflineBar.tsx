import { useEffect, useState } from 'react'
import { onlineManager, useQueryClient } from '@tanstack/react-query'
import { CloudOff, RefreshCw } from 'lucide-react'
import { pendingSyncCount } from '@/lib/offline'

/**
 * Franja fina bajo la cabecera que avisa de dos cosas que, si no se dicen, se
 * viven como un fallo: que la app está mostrando datos guardados porque no hay
 * red, y que hay cambios hechos en el teléfono que todavía no llegaron al
 * servidor.
 *
 * Lo segundo es lo importante: quien registra algo sin conexión da por hecho que
 * ya está guardado. El contador es la única prueba visible de que sigue pendiente
 * y de que no debe borrar los datos del navegador todavía.
 */
export function OfflineBar() {
  const qc = useQueryClient()
  const [online, setOnline] = useState(() => onlineManager.isOnline())
  const [queued, setQueued] = useState(() => pendingSyncCount(qc))
  const [syncing, setSyncing] = useState(0)

  // `subscribe` devuelve su propia función de baja: se retorna tal cual.
  useEffect(() => onlineManager.subscribe(setOnline), [])

  // La cola vive en el cliente de consultas, no en un estado de React, así que
  // hay que escucharla: sin esta suscripción el contador se quedaría congelado
  // en el valor del primer render y no bajaría al subirse los cambios.
  useEffect(() => {
    const cache = qc.getMutationCache()
    const read = () => {
      setQueued(pendingSyncCount(qc))
      // Pausadas (en cola por falta de red) vs. subiéndose ahora mismo: son dos
      // mensajes distintos y el segundo tiene que verse aunque dure poco.
      setSyncing(
        cache.getAll().filter((m) => m.state.status === 'pending' && !m.state.isPaused).length,
      )
    }
    read()
    return cache.subscribe(read)
  }, [qc])

  if (online && queued === 0 && syncing === 0) return null

  const total = queued + syncing

  return (
    <div
      className={
        online
          ? 'flex items-center justify-center gap-2 bg-amber-50 px-4 py-1.5 text-center text-xs font-medium text-amber-700'
          : 'flex items-center justify-center gap-2 bg-slate-800 px-4 py-1.5 text-center text-xs font-medium text-white'
      }
    >
      {!online ? (
        <>
          <CloudOff className="h-3.5 w-3.5 shrink-0" />
          {queued > 0
            ? `Sin conexión — ${queued} cambio${queued === 1 ? '' : 's'} por subir`
            : 'Sin conexión — mostrando datos guardados'}
        </>
      ) : (
        <>
          <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" />
          {`Sincronizando ${total} cambio${total === 1 ? '' : 's'}…`}
        </>
      )}
    </div>
  )
}
