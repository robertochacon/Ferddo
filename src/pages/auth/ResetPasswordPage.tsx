import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Lock, Eye, EyeOff, ShieldAlert, Loader2 } from 'lucide-react'
import { AuthLayout } from './AuthLayout'
import { Field, Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { supabase } from '@/lib/supabase'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/auth/AuthProvider'
import { errorMessage } from '@/lib/errors'
import {
  RECOVERY_KEY,
  RECOVERY_ERROR_KEY,
  capturedTokens,
  capturedError,
  clearCapturedRecovery,
  type RecoveryTokens,
} from '@/lib/recoveryBootstrap'

type Status = 'checking' | 'ready' | 'invalid'

const schema = z
  .object({
    password: z.string().min(6, 'Mínimo 6 caracteres'),
    confirm: z.string().min(1, 'Repite la contraseña'),
  })
  .refine((v) => v.password === v.confirm, {
    message: 'Las contraseñas no coinciden',
    // Sin `path` el error queda suelto en la raíz del formulario y no lo ve nadie.
    path: ['confirm'],
  })

type FormValues = z.infer<typeof schema>

/** Lee sessionStorage sin lanzar (puede estar bloqueado por política/privado). */
function safeGetItem(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function parseTokens(raw: string | null): RecoveryTokens | null {
  if (!raw) return null
  try {
    const t = JSON.parse(raw)
    return t?.access_token && t?.refresh_token ? t : null
  } catch {
    return null
  }
}

export function ResetPasswordPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const { refresh } = useAuth()
  const [status, setStatus] = useState<Status>('checking')
  const [showPassword, setShowPassword] = useState(false)
  const booted = useRef(false)
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) })

  useEffect(() => {
    // Guard contra el doble montaje de StrictMode: el ref persiste entre ambos y
    // los datos de recuperación se consumen UNA sola vez.
    if (booted.current) return
    booted.current = true
    ;(async () => {
      // 1) recoveryBootstrap detectó un enlace expirado o inválido (respaldo en
      //    memoria o en sessionStorage).
      if (capturedError || safeGetItem(RECOVERY_ERROR_KEY)) {
        clearCapturedRecovery()
        setStatus('invalid')
        return
      }
      // 2) Capturó los tokens del enlace → abre la sesión de recuperación, que
      //    es lo que permite llamar a updateUser(). El respaldo en memoria es el
      //    transporte primario; sessionStorage cubre una posible recarga.
      const tokens = capturedTokens ?? parseTokens(safeGetItem(RECOVERY_KEY))
      if (tokens) {
        clearCapturedRecovery()
        try {
          const { error } = await supabase.auth.setSession(tokens)
          if (error) throw error
          setStatus('ready')
        } catch {
          setStatus('invalid')
        }
        return
      }
      // 3) Sin datos nuevos: la persona pudo recargar tras abrir la sesión de
      //    recuperación. Si aún hay sesión válida, se deja cambiar la contraseña.
      const { data } = await supabase.auth.getSession()
      setStatus(data.session ? 'ready' : 'invalid')
    })()
  }, [])

  const submit = handleSubmit(async (values) => {
    const { error } = await supabase.auth.updateUser({ password: values.password })
    if (error) {
      toast.error(
        /different from the old|should be different/i.test(error.message)
          ? 'La nueva contraseña debe ser distinta a la anterior.'
          : errorMessage(error, 'No pudimos guardar la contraseña'),
      )
      return
    }
    // Carga el perfil/negocio ANTES de navegar (igual que en el login): con la
    // sesión recién abierta y sin perfil, el guard mandaría a los primeros pasos.
    await refresh()
    toast.success('¡Contraseña actualizada!')
    navigate('/')
  })

  if (status === 'checking') {
    return (
      <AuthLayout
        backToHome={false}
        title="Un momento…"
        subtitle="Verificando tu enlace de recuperación"
      >
        <div className="flex justify-center py-6">
          <Loader2 className="h-6 w-6 animate-spin text-brand-500" />
        </div>
      </AuthLayout>
    )
  }

  if (status === 'invalid') {
    return (
      <AuthLayout title="Enlace no válido o expirado" subtitle="Este enlace ya no se puede usar">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-red-50 text-red-500">
            <ShieldAlert className="h-7 w-7" />
          </div>
          <p className="text-sm text-slate-600">
            Por seguridad, los enlaces de correo caducan y solo sirven una vez. Vuelve a iniciar
            sesión o solicita un nuevo enlace de recuperación.
          </p>
          <Link to="/login" className="w-full">
            <Button className="w-full">Ir a iniciar sesión</Button>
          </Link>
          <Link to="/recuperar" className="text-sm font-medium text-brand-600 hover:underline">
            Solicitar enlace de recuperación
          </Link>
        </div>
      </AuthLayout>
    )
  }

  return (
    // Sin salida a la página pública: esta sesión es temporal y de un solo uso;
    // irse a medias deja la contraseña vieja y el enlace ya quemado.
    <AuthLayout
      backToHome={false}
      title="Crea una nueva contraseña"
      subtitle="Elige una contraseña segura para tu cuenta"
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Nueva contraseña" hint="Mínimo 6 caracteres" error={errors.password?.message}>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              placeholder="••••••••"
              className="pl-9 pr-10"
              {...register('password')}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Ocultar contraseña' : 'Ver contraseña'}
              title={showPassword ? 'Ocultar contraseña' : 'Ver contraseña'}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </Field>
        <Field label="Repite la contraseña" error={errors.confirm?.message}>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              placeholder="••••••••"
              className="pl-9"
              {...register('confirm')}
            />
          </div>
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>
          Guardar contraseña
        </Button>
      </form>
    </AuthLayout>
  )
}
