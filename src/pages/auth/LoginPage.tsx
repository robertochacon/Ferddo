import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Mail, Lock, Eye, EyeOff } from 'lucide-react'
import { AuthLayout } from './AuthLayout'
import { AuthDivider, GoogleButton } from './GoogleButton'
import { Field, Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { supabase, hasSupabaseConfig } from '@/lib/supabase'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/auth/AuthProvider'
import { errorMessage } from '@/lib/errors'

const schema = z.object({
  email: z.string().trim().min(1, 'Escribe tu correo').email('Ese correo no parece válido'),
  // Sin mínimo de longitud: aquí no se está creando la contraseña, se está
  // comprobando. Exigir 6 caracteres solo delataría la regla a quien prueba.
  password: z.string().min(1, 'Escribe tu contraseña'),
})

type FormValues = z.infer<typeof schema>

export function LoginPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const { refresh } = useAuth()
  const [showPassword, setShowPassword] = useState(false)
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) })

  const submit = handleSubmit(async (values) => {
    if (!hasSupabaseConfig) {
      toast.error('Configura VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY en .env')
      return
    }
    const { error } = await supabase.auth.signInWithPassword({
      email: values.email.trim(),
      password: values.password,
    })
    if (error) {
      // Mensaje único para "no existe" y "contraseña mala": distinguirlos
      // convertiría la pantalla en un comprobador de correos registrados.
      toast.error(
        /invalid login/i.test(error.message)
          ? 'Correo o contraseña incorrectos'
          : errorMessage(error, 'No pudimos iniciar sesión'),
      )
      return
    }
    // Carga el perfil/negocio ANTES de navegar: si no, el guard ve la sesión sin
    // perfil y manda a los primeros pasos a quien ya tiene negocio.
    await refresh()
    navigate('/')
  })

  return (
    <AuthLayout
      title="Inicia sesión"
      subtitle="Entra a tu cuenta para seguir donde lo dejaste"
      footer={
        <>
          ¿No tienes cuenta?{' '}
          <Link to="/registro" className="font-semibold text-brand-600 hover:underline">
            Crear cuenta
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Correo" error={errors.email?.message}>
          <div className="relative">
            <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              type="email"
              autoComplete="email"
              placeholder="tucorreo@ejemplo.com"
              className="pl-9"
              {...register('email')}
            />
          </div>
        </Field>

        {/* Etiqueta + enlace en la misma fila. El <Link> va FUERA del <label>
            para no contaminar el nombre accesible del campo (que queda
            "Contraseña"). Por eso este campo no usa <Field>. */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="password" className="block text-sm font-medium text-slate-700">
              Contraseña
            </label>
            <Link to="/recuperar" className="text-xs font-medium text-brand-600 hover:underline">
              ¿Olvidaste tu contraseña?
            </Link>
          </div>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
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
          {errors.password && (
            <p className="text-xs font-medium text-red-600">{errors.password.message}</p>
          )}
        </div>

        <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>
          Entrar
        </Button>
      </form>

      {/* Google va DEBAJO del botón principal: entrar con correo es el camino
          habitual y el separador «o» presenta a Google como la alternativa. */}
      <div className="mt-4 space-y-4">
        <AuthDivider />
        <GoogleButton label="Continuar con Google" />
      </div>
    </AuthLayout>
  )
}
