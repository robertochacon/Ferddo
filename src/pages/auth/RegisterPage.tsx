import { Link, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { AuthLayout } from './AuthLayout'
import { AuthDivider, GoogleButton } from './GoogleButton'
import { Field, Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { supabase, hasSupabaseConfig } from '@/lib/supabase'
import { useToast } from '@/components/ui/toast'
import { errorMessage } from '@/lib/errors'
import { LEGAL_PATHS } from '@/lib/constants'

const schema = z.object({
  fullName: z.string().trim().min(2, 'Escribe tu nombre'),
  email: z.string().trim().min(1, 'Escribe tu correo').email('Ese correo no parece válido'),
  // 6 es el mínimo que impone Supabase por defecto; validarlo aquí evita el
  // viaje de ida y vuelta para leer el mismo error en inglés.
  password: z.string().min(6, 'Mínimo 6 caracteres'),
})

type FormValues = z.infer<typeof schema>

const YA_TIENE_CUENTA = 'Ese correo ya tiene una cuenta. Inicia sesión o recupera tu contraseña.'

export function RegisterPage() {
  const navigate = useNavigate()
  const toast = useToast()
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
    const { data, error } = await supabase.auth.signUp({
      email: values.email.trim(),
      password: values.password,
      // Viaja a `user_metadata`: es lo único que se sabe de la persona antes de
      // que exista su `profile`, y los primeros pasos lo usan para prellenar.
      options: { data: { full_name: values.fullName.trim() } },
    })
    if (error) {
      toast.error(
        /already registered|already exists/i.test(error.message)
          ? YA_TIENE_CUENTA
          : errorMessage(error, 'No pudimos crear la cuenta'),
      )
      return
    }
    // Correo ya registrado, camino B: si el proyecto TODAVÍA tiene encendida la
    // confirmación nativa, Supabase no lo dice de frente (para no revelar quién
    // tiene cuenta) y devuelve un usuario "vacío", sin identidades y sin sesión.
    // Con la confirmación apagada —lo normal aquí— responde el error de arriba.
    if (data.user && (data.user.identities?.length ?? 0) === 0) {
      toast.error(YA_TIENE_CUENTA)
      return
    }

    if (data.session) {
      // ACUERDO DEL PROYECTO: la confirmación de correo va APAGADA
      // (`enable_confirmations = false` en supabase/config.toml), así que
      // `signUp` devuelve sesión y se entra directo. Quien cierra la app para
      // buscar un correo de confirmación, muchas veces no vuelve.
      //
      // En su lugar se manda un correo de BIENVENIDA con la Edge Function
      // 'welcome'. Va sin esperar (`void`) y sin avisar si falla: en cuanto hay
      // sesión, el guard PublicOnly ya está sacando esta pantalla de en medio, y
      // un correo de cortesía no debe estorbar —ni retrasar— el registro.
      void supabase.functions.invoke('welcome').catch(() => {})
      toast.success('¡Cuenta creada!')
      // `replace`: la pantalla de registro no debe quedar en el historial.
      navigate('/bienvenida', { replace: true })
      return
    }

    // Respaldo: alguien volvió a encender la confirmación nativa. No hay sesión
    // que seguir, así que se avisa y se deja en el acceso.
    toast.info('Te enviamos un correo para confirmar tu cuenta. Revisa tu bandeja.')
    navigate('/login', { replace: true })
  })

  return (
    // `showLegal={false}`: el formulario ya lleva la frase de aceptación con
    // esos mismos dos enlaces, junto al botón de crear cuenta.
    <AuthLayout
      title="Crea tu cuenta"
      subtitle="Empieza gratis. 30 días de prueba, sin tarjeta."
      showLegal={false}
      footer={
        <>
          ¿Ya tienes cuenta?{' '}
          <Link to="/login" className="font-semibold text-brand-600 hover:underline">
            Inicia sesión
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Tu nombre" required error={errors.fullName?.message}>
          <Input placeholder="Ej. María Pérez" autoComplete="name" {...register('fullName')} />
        </Field>
        <Field label="Correo" required error={errors.email?.message}>
          <Input
            type="email"
            autoComplete="email"
            placeholder="tucorreo@ejemplo.com"
            {...register('email')}
          />
        </Field>
        <Field
          label="Contraseña"
          required
          hint="Mínimo 6 caracteres"
          error={errors.password?.message}
        >
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="••••••••"
            {...register('password')}
          />
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>
          Crear cuenta
        </Button>
      </form>

      {/* Google va DEBAJO del botón principal: registrarse con correo es el
          camino habitual y el separador «o» presenta la alternativa. */}
      <div className="mt-4 space-y-4">
        <AuthDivider />
        <GoogleButton label="Registrarme con Google" />
      </div>

      {/* Aviso de aceptación. Va FUERA del formulario y al final, porque hay dos
          maneras de crear la cuenta —Google y correo— y tiene que cubrir las
          dos. Sigue dentro de la tarjeta, a la vista al pulsar cualquiera. */}
      <p className="mt-4 text-center text-xs leading-relaxed text-slate-500">
        Al crear tu cuenta aceptas las{' '}
        <Link to={LEGAL_PATHS.terms} className="font-medium text-brand-600 hover:underline">
          Condiciones del Servicio
        </Link>{' '}
        y la{' '}
        <Link to={LEGAL_PATHS.privacy} className="font-medium text-brand-600 hover:underline">
          Política de Privacidad
        </Link>
        .
      </p>
    </AuthLayout>
  )
}
