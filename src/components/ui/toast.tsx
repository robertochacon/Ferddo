import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react'
import { cn } from '@/lib/cn'

type ToastKind = 'success' | 'error' | 'info'

interface Toast {
  id: number
  kind: ToastKind
  message: string
}

interface ToastCtx {
  show: (message: string, kind?: ToastKind) => void
  success: (message: string) => void
  error: (message: string) => void
  info: (message: string) => void
}

const Ctx = createContext<ToastCtx | null>(null)

/*
 * Contador fuera del componente: los identificadores deben ser únicos entre
 * avisos, y un `useRef` volvería a empezar si el proveedor se remontara,
 * repitiendo claves de React con avisos aún en pantalla.
 */
let counter = 0

/** Duración fija: lo bastante para leer una frase, no tanto como para estorbar. */
const TIMEOUT_MS = 4500

/**
 * Avisos flotantes de toda la app. Va montado UNA vez, encima del árbol
 * (ver `main.tsx`), para que un aviso sobreviva al cambio de pantalla que suele
 * dispararlo: guardar y volver al listado.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const remove = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id))
  }, [])

  const show = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = ++counter
      setToasts((t) => [...t, { id, kind, message }])
      window.setTimeout(() => remove(id), TIMEOUT_MS)
    },
    [remove],
  )

  // `useMemo` para que el objeto del contexto no cambie en cada render: si
  // cambiara, cualquier efecto que dependa de `useToast()` se relanzaría.
  const value = useMemo<ToastCtx>(
    () => ({
      show,
      success: (m) => show(m, 'success'),
      error: (m) => show(m, 'error'),
      info: (m) => show(m, 'info'),
    }),
    [show],
  )

  return (
    <Ctx.Provider value={value}>
      {children}
      {/* Arriba y centrado: abajo lo tapan el teclado en pantalla y la barra de
          navegación del móvil. `pointer-events-none` en la pila y `auto` en cada
          aviso, para no bloquear los clics de la pantalla que hay debajo. */}
      <div className="pointer-events-none fixed inset-x-0 top-3 z-[100] flex flex-col items-center gap-2 px-3 sm:top-4">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onClose={() => remove(t.id)} />
        ))}
      </div>
    </Ctx.Provider>
  )
}

const ICONS: Record<ToastKind, ReactNode> = {
  success: <CheckCircle2 className="h-5 w-5 text-emerald-500" />,
  error: <AlertTriangle className="h-5 w-5 text-red-500" />,
  info: <Info className="h-5 w-5 text-brand-500" />,
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border bg-white px-4 py-3 shadow-card-hover animate-slide-up',
        toast.kind === 'error' ? 'border-red-200' : 'border-slate-200',
      )}
    >
      <span className="mt-0.5 shrink-0">{ICONS[toast.kind]}</span>
      {/* `whitespace-pre-line`: los errores del servidor llegan con saltos de
          línea y sin esto se leen como un párrafo apelmazado. */}
      <p className="flex-1 whitespace-pre-line text-sm text-slate-700">{toast.message}</p>
      <button
        type="button"
        onClick={onClose}
        aria-label="Cerrar"
        className="shrink-0 rounded-md p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useToast debe usarse dentro de <ToastProvider>')
  return ctx
}
