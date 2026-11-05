import { useEffect, useState, type FormEvent } from 'react'
import { AtSign, Check, Phone } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field, Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/toast'
import { errorMessage } from '@/lib/errors'
import { useUpdateAccountData } from '@/hooks/profile'
import { PasswordCard, SessionsCard } from '@/features/profile/ProfilePage'
import { AdminShell } from './AdminShell'

/**
 * Perfil del super-admin. No usa la página de perfil de la app porque esa
 * depende de `profiles` (el negocio), que un super-admin no suele tener: aquí
 * el nombre y el teléfono viven en la cuenta de acceso (`user_metadata`).
 *
 * Contraseña y sesiones son las MISMAS tarjetas de la app: la contraseña pide
 * la actual antes de cambiarla. En una cuenta que puede borrar negocios
 * enteros eso no es opcional.
 */
export function AdminProfilePage() {
  return (
    <AdminShell section="perfil" title="Mi perfil">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <AccountDataCard />
          <PasswordCard />
        </div>
        <div className="space-y-4">
          <SessionsCard />
        </div>
      </div>
    </AdminShell>
  )
}

function AccountDataCard() {
  const { user } = useAuth()
  const toast = useToast()
  const update = useUpdateAccountData()
  const meta = (user?.user_metadata ?? {}) as { full_name?: string; phone?: string }
  const [fullName, setFullName] = useState(meta.full_name ?? '')
  const [phone, setPhone] = useState(meta.phone ?? '')

  // Al guardar, la sesión vuelve con los metadatos nuevos: el formulario se alinea con ellos.
  useEffect(() => {
    setFullName(meta.full_name ?? '')
    setPhone(meta.phone ?? '')
  }, [meta.full_name, meta.phone])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await update.mutateAsync({ fullName, phone })
      toast.success('Datos actualizados.')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudieron guardar tus datos.'))
    }
  }

  return (
    <Card>
      <CardHeader title="Datos personales" subtitle="Cómo te ve el resto del equipo de Ferddo" />
      <CardBody>
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <Field label="Correo" hint="Es tu acceso al panel; no se cambia desde aquí.">
            <div className="relative">
              <AtSign className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input value={user?.email ?? ''} disabled readOnly className="pl-9" />
            </div>
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Nombre">
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={80}
                autoComplete="name" placeholder="Nombre y apellido" />
            </Field>
            <Field label="Teléfono" hint="Para que el equipo te localice. Solo se guardan los dígitos.">
              <div className="relative">
                <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
                  autoComplete="tel" placeholder="809 555 0000" className="pl-9" maxLength={20} />
              </div>
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" loading={update.isPending}>
              <Check className="h-4 w-4" /> Guardar
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}
