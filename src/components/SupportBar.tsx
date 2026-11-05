import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LifeBuoy, LogOut } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { useToast } from '@/components/ui/toast'
import { errorMessage } from '@/lib/errors'

/** «1 h 52 min», «8 min», «menos de 1 min». */
function remaining(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'menos de 1 min'
  const h = Math.floor(min / 60)
  return h > 0 ? `${h} h ${min % 60} min` : `${min} min`
}

/**
 * Franja del modo soporte (0028): un super-admin dentro de un negocio.
 *
 * Tiene que verse siempre y no confundirse con nada del negocio: quien está
 * dentro opera datos reales de un cliente. Al llegar a cero sale sola; la base
 * ya le habría quitado el acceso, pero sin esto la pantalla seguiría pintando
 * el negocio y cada acción fallaría con «No autorizado».
 */
export function SupportBar() {
  const { isPlatformAdmin, tenant, supportUntil, exitSupport } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  // Una sola salida automática aunque el intervalo vuelva a disparar mientras
  // la primera sigue en vuelo.
  const leaving = useRef(false)

  const active = isPlatformAdmin && Boolean(tenant) && Boolean(supportUntil)
  const left = supportUntil ? Date.parse(supportUntil) - now : 0

  useEffect(() => {
    if (!active) return
    // Cada 30 s basta para una cuenta atrás en minutos.
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [active])

  const leave = async (auto: boolean) => {
    if (leaving.current) return
    leaving.current = true
    setBusy(true)
    try {
      await exitSupport()
      if (auto) toast.info('El acceso de soporte caducó. Volviste al panel.')
      navigate('/admin')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo salir del modo soporte.'))
      leaving.current = false
      setBusy(false)
    }
  }

  useEffect(() => {
    if (active && left <= 0) void leave(true)
    // Sin `leave` en las dependencias: cambia en cada render y lo que decide es
    // el reloj. El ref `leaving` evita la doble salida.
  }, [active, left])

  if (!active) return null

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-500 px-4 py-1.5 text-center text-xs font-semibold text-amber-950">
      <span className="inline-flex items-center gap-1.5">
        <LifeBuoy className="h-3.5 w-3.5 shrink-0" />
        Modo soporte en {tenant?.name} · quedan {remaining(left)}
      </span>
      <button
        type="button"
        onClick={() => void leave(false)}
        disabled={busy}
        className="inline-flex items-center gap-1 rounded-md bg-amber-950/10 px-2 py-0.5 underline-offset-2 hover:bg-amber-950/20 disabled:opacity-60"
      >
        <LogOut className="h-3.5 w-3.5" /> Salir al panel
      </button>
    </div>
  )
}
