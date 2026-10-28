import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Mail, MailCheck, ArrowLeft } from 'lucide-react'
import { AuthLayout } from './AuthLayout'
import { Field, Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { supabase, hasSupabaseConfig } from '@/lib/supabase'
import { useToast } from '@/components/ui/toast'
import { errorMessage } from '@/lib/errors'

const schema = z.object({
  email: z.string().trim().min(1, 'Escribe tu correo').email('Ese correo no parece válido'),
})

type FormValues = z.infer<typeof schema>

export function ForgotPasswordPage() {
  const toast = useToast()
  // Correo al que se mandó el enlace. `null` = todavía no se ha enviado nada.
  const [sentTo, setSentTo] = useState<string | null>(null)
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
    const email = values.email.trim()
    // Supabase devuelve al usuario a la RAÍZ de la app con el token en el
    // fragmento; recoveryBootstrap lo rescata y lo lleva a /restablecer. Se usa
    // BASE_URL para cubrir tanto el dominio propio (/) como un despliegue en
    // subdirectorio (/mi-repo/).
    const redirectTo = new URL(import.meta.env.BASE_URL, window.location.origin).toString()
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
    if (error) {
      toast.error(
        /rate|security purposes|too many/i.test(error.message)
          ? 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.'
          : errorMessage(error, 'No pudimos enviar el enlace'),
      )
      return
    }
    // Mensaje neutral: no se revela si el correo existe (evita enumeración).
    setSentTo(email)
  })

  if (sentTo) {
    return (
      <AuthLayout title="Revisa tu correo" subtitle="Te enviamos las instrucciones">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-500">
            <MailCheck className="h-7 w-7" />
          </div>
          <p className="text-sm text-slate-600">
            Si <span className="font-medium text-slate-800">{sentTo}</span> tiene una cuenta,
            recibirás un enlace para crear una nueva contraseña. Revisa también tu carpeta de spam.
          </p>
          <button
            type="button"
            onClick={() => setSentTo(null)}
            className="text-sm font-medium text-brand-600 hover:underline"
          >
            Usar otro correo
          </button>
          <Link to="/login" className="w-full">
            <Button variant="outline" className="w-full">
              Volver a iniciar sesión
            </Button>
          </Link>
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      title="¿Olvidaste tu contraseña?"
      subtitle="Escribe tu correo y te enviaremos un enlace para restablecerla"
      footer={
        <Link
          to="/login"
          className="inline-flex items-center gap-1 font-semibold text-brand-600 hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> Volver a iniciar sesión
        </Link>
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
        <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>
          Enviar enlace
        </Button>
      </form>
    </AuthLayout>
  )
}
