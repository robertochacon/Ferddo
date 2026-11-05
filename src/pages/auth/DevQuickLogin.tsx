import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ShieldCheck, User, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { supabase, hasSupabaseConfig } from '@/lib/supabase'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/auth/AuthProvider'
import { errorMessage } from '@/lib/errors'

/**
 * Entrada de un clic con cuentas de prueba, mientras la app está en desarrollo.
 *
 * Por defecto solo existe con `npm run dev`: LoginPage lo importa con `import()`
 * detrás de una condición que en `vite build` es el literal `false`, y Rollup
 * elimina la rama entera, así que las credenciales no llegan a `dist/`.
 *
 * AVISO: con VITE_QUICK_LOGIN='true' (lo pone deploy.yml) el módulo SÍ se
 * publica, y con él las contraseñas, legibles por cualquiera que abra el sitio.
 * Decisión consciente mientras no hay clientes: la cuenta admin es super-admin
 * del proyecto real. ANTES DE ABRIR A CLIENTES: quitar la variable del deploy
 * y cambiar las contraseñas de las dos cuentas (ya se habrán filtrado).
 *
 * En local las credenciales van en `.env.local` (ignorado por git); en el
 * despliegue, en los secrets del repo. Nunca en el código.
 */
type Account = {
  key: 'admin' | 'user'
  label: string
  hint: string
  icon: typeof User
  email?: string
  password?: string
}

const ACCOUNTS: Account[] = [
  {
    key: 'admin',
    label: 'Entrar como admin',
    hint: 'Super-admin de plataforma (/admin)',
    icon: ShieldCheck,
    email: import.meta.env.VITE_DEV_ADMIN_EMAIL,
    password: import.meta.env.VITE_DEV_ADMIN_PASSWORD,
  },
  {
    key: 'user',
    label: 'Entrar como usuario',
    hint: 'Usuario de un negocio',
    icon: User,
    email: import.meta.env.VITE_DEV_USER_EMAIL,
    password: import.meta.env.VITE_DEV_USER_PASSWORD,
  },
]

export default function DevQuickLogin() {
  const navigate = useNavigate()
  const toast = useToast()
  const { refresh } = useAuth()
  const [pending, setPending] = useState<Account['key'] | null>(null)

  const enter = async (account: Account) => {
    if (!hasSupabaseConfig) {
      toast.error('Configura VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY en .env')
      return
    }
    if (!account.email || !account.password) {
      const prefix = account.key === 'admin' ? 'VITE_DEV_ADMIN' : 'VITE_DEV_USER'
      toast.error(`Define ${prefix}_EMAIL y ${prefix}_PASSWORD en .env.local`)
      return
    }
    setPending(account.key)
    const { error } = await supabase.auth.signInWithPassword({
      email: account.email,
      password: account.password,
    })
    if (error) {
      setPending(null)
      // Aquí sí se dice qué cuenta falló: es una herramienta de desarrollo, no
      // la pantalla pública, y lo útil es saber qué línea de .env.local revisar.
      toast.error(`${account.email}: ${errorMessage(error, 'No pudimos iniciar sesión')}`)
      return
    }
    // Igual que el login normal: perfil cargado antes de navegar, para que el
    // guard no mande a /bienvenida a quien ya tiene negocio. El guard de «/»
    // redirige solo al super-admin a /admin.
    await refresh()
    navigate('/')
  }

  return (
    <div className="mt-6 rounded-xl border border-dashed border-amber-300 bg-amber-50 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700">
        <Wrench className="h-3.5 w-3.5" />
        Acceso rápido · versión en desarrollo
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {ACCOUNTS.map((account) => {
          const Icon = account.icon
          return (
            <Button
              key={account.key}
              type="button"
              variant="outline"
              className="w-full"
              title={account.email ? `${account.hint} · ${account.email}` : account.hint}
              loading={pending === account.key}
              disabled={pending !== null && pending !== account.key}
              onClick={() => enter(account)}
            >
              {pending !== account.key && <Icon className="h-4 w-4" />}
              {account.label}
            </Button>
          )
        })}
      </div>
    </div>
  )
}
