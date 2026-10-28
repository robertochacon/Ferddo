import { useEffect, useState } from 'react'
import {
  ArrowRightLeft,
  AtSign,
  Building2,
  Check,
  KeyRound,
  LogOut,
  MonitorSmartphone,
  ShieldCheck,
  Ticket,
  Upload,
  UserRound,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Field, Input } from '@/components/ui/Input'
import { Avatar, PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/auth/AuthProvider'
import {
  useChangeEmail,
  useChangePassword,
  useSignOutOthers,
  useUpdateProfile,
} from '@/hooks/profile'
import { useMyTenants } from '@/hooks/core'
import { useAcceptInvite } from '@/hooks/team'
import { uploadFile } from '@/lib/storage'
import { fmtDate } from '@/lib/format'
import { errorMessage } from '@/lib/errors'
import { ROLE_LABEL } from '@/lib/labels'
import type { MyTenant } from '@/types/erp'

/** Mínimo que impone Supabase por defecto. Validarlo aquí evita el viaje de ida
 *  y vuelta para leer el mismo error en inglés. */
const MIN_PASSWORD = 6

/**
 * Perfil de quien tiene la sesión abierta: sus datos y las llaves de su cuenta.
 *
 * Las tres operaciones sensibles —contraseña, correo y cerrar otras sesiones—
 * van en tarjetas separadas y cada una explica POR QUÉ pide lo que pide. Son las
 * que deciden quién puede entrar mañana, y una pantalla que las mezcla con el
 * nombre y la foto invita a tocarlas sin leer.
 */
export function ProfilePage() {
  const { user, profile, tenant } = useAuth()

  if (!profile) return null

  return (
    <div>
      <PageHeader title="Mi perfil" description="Tus datos y el acceso a tu cuenta" />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <PersonalDataCard />
          <PasswordCard />
          <EmailCard />
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Tu cuenta" />
            <CardBody className="space-y-3">
              <Row icon={<AtSign className="h-4 w-4" />} label="Correo" value={user?.email ?? '—'} />
              <Row
                icon={<Building2 className="h-4 w-4" />}
                label="Empresa activa"
                value={tenant?.name ?? '—'}
              />
              <Row
                icon={<ShieldCheck className="h-4 w-4" />}
                label="Tu rol en ella"
                value={
                  <Badge tone={profile.role === 'owner' ? 'brand' : 'slate'}>
                    {ROLE_LABEL[profile.role]}
                  </Badge>
                }
              />
              <Row
                icon={<UserRound className="h-4 w-4" />}
                label="Miembro desde"
                value={fmtDate(profile.created_at)}
              />
            </CardBody>
          </Card>

          <CompaniesCard />
          <SessionsCard />
        </div>
      </div>
    </div>
  )
}

function Row({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0 text-slate-400">{icon}</span>
      {/* `min-w-0` + `truncate`: un correo largo estiraría la tarjeta y sacaría
          la columna entera fuera de la pantalla en el teléfono. */}
      <div className="min-w-0 flex-1">
        <p className="text-xs text-slate-500">{label}</p>
        <div className="truncate text-sm font-medium text-slate-800">{value}</div>
      </div>
    </div>
  )
}

/* ── Datos personales ─────────────────────────────────────────────────────── */

function PersonalDataCard() {
  const { profile, tenant } = useAuth()
  const update = useUpdateProfile()
  const toast = useToast()
  const [name, setName] = useState('')
  const [uploading, setUploading] = useState(false)

  useEffect(() => setName(profile?.full_name ?? ''), [profile?.full_name])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const value = name.trim()
    if (!value) {
      toast.error('Escribe tu nombre.')
      return
    }
    try {
      await update.mutateAsync({ full_name: value })
      toast.success('Datos guardados')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudieron guardar tus datos'))
    }
  }

  const onPhoto = async (file: File) => {
    if (!tenant) return
    setUploading(true)
    try {
      // Se reutiliza el bucket `logos`: es público y su política ya deja
      // escribir bajo la carpeta del negocio. Un bucket aparte para avatares no
      // aportaría nada distinto y obligaría a otra migración.
      const { publicUrl } = await uploadFile('logos', tenant.id, file, 'avatar-')
      await update.mutateAsync({ avatar_url: publicUrl })
      toast.success('Foto actualizada')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo subir la foto'))
    } finally {
      setUploading(false)
    }
  }

  return (
    <Card>
      <CardHeader title="Datos personales" subtitle="Cómo te ve el resto del equipo" />
      <CardBody>
        <div className="mb-5 flex items-center gap-4">
          <Avatar name={profile?.full_name} src={profile?.avatar_url} size="lg" />
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
            <Upload className="h-4 w-4" />
            {uploading ? 'Subiendo…' : 'Cambiar foto'}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void onPhoto(f)
                // Se limpia para que elegir OTRA vez el mismo archivo vuelva a
                // disparar `change`.
                e.target.value = ''
              }}
            />
          </label>
        </div>

        <form onSubmit={save} className="space-y-4">
          <Field label="Nombre completo" required>
            <div className="relative">
              <UserRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                required
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="pl-9"
              />
            </div>
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={update.isPending}>
              Guardar cambios
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}

/* ── Contraseña ───────────────────────────────────────────────────────────── */

function PasswordCard() {
  const change = useChangePassword()
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (next.length < MIN_PASSWORD) {
      toast.error(`La nueva contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`)
      return
    }
    if (next !== repeat) {
      toast.error('Las contraseñas nuevas no coinciden.')
      return
    }
    if (next === current) {
      toast.error('La nueva contraseña es igual a la actual.')
      return
    }
    try {
      await change.mutateAsync({ current, next })
      setCurrent('')
      setNext('')
      setRepeat('')
      toast.success('Contraseña actualizada')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo cambiar la contraseña'))
    }
  }

  return (
    <Card>
      <CardHeader title="Contraseña" subtitle="Te pedimos la actual para confirmar que eres tú" />
      <CardBody>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Contraseña actual" required>
            <div className="relative">
              <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                required
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                className="pl-9"
              />
            </div>
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Nueva contraseña" hint={`Mínimo ${MIN_PASSWORD} caracteres`} required>
              <Input
                required
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </Field>
            <Field label="Repite la nueva" required>
              <Input
                required
                type="password"
                autoComplete="new-password"
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" loading={change.isPending}>
              <Check className="h-4 w-4" /> Cambiar contraseña
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}

/* ── Correo ───────────────────────────────────────────────────────────────── */

function EmailCard() {
  const { user } = useAuth()
  const change = useChangeEmail()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const close = () => {
    setOpen(false)
    setEmail('')
    setPassword('')
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await change.mutateAsync({ email, password })
      close()
      toast.success('Te enviamos un correo al nuevo buzón para confirmar el cambio.')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo cambiar el correo'))
    }
  }

  return (
    <Card>
      <CardHeader
        title="Correo de acceso"
        subtitle={user?.email ?? '—'}
        action={
          !open && (
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
              Cambiar
            </Button>
          )
        }
      />
      {open && (
        <CardBody>
          {/* No se promete doble confirmación: con la confirmación de correo
              apagada en el proyecto (ver supabase/config.toml), GoTrue se salta
              `double_confirm_changes` y basta con abrir el enlace del correo
              NUEVO. Prometer lo contrario dejaría a la persona creyendo que su
              correo viejo sigue sirviendo. Por eso pedimos la contraseña. */}
          <div className="mb-4 rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
            Te pedimos la contraseña porque el correo de acceso es{' '}
            <strong>la llave de tu cuenta</strong>. Enviaremos un enlace al correo{' '}
            <strong>nuevo</strong>: al abrirlo, pasará a ser con el que entras.
          </div>
          <form onSubmit={submit} className="space-y-4">
            <Field label="Nuevo correo" required>
              <div className="relative">
                <AtSign className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  required
                  type="email"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-9"
                />
              </div>
            </Field>
            <Field label="Tu contraseña" hint="Para confirmar que eres tú" required>
              <Input
                required
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={close}>
                Cancelar
              </Button>
              <Button type="submit" loading={change.isPending}>
                Enviar confirmación
              </Button>
            </div>
          </form>
        </CardBody>
      )}
    </Card>
  )
}

/* ── Mis empresas ─────────────────────────────────────────────────────────── */

/**
 * Empresas a las que pertenece la cuenta (`my_tenants`). Una persona puede
 * trabajar en varias —el contador que lleva tres negocios, la cajera que cubre
 * en dos—; el permiso y el rol son POR empresa, así que se cambia de una a otra
 * en vez de mezclar datos.
 */
function CompaniesCard() {
  const { switchTenant } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const tenants = useMyTenants()
  const accept = useAcceptInvite()
  const [switching, setSwitching] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [joining, setJoining] = useState(false)

  const change = async (t: MyTenant) => {
    setSwitching(t.id)
    try {
      await switchTenant(t.id)
      toast.success(`Ahora trabajas en ${t.name}.`)
      // Al panel: la pantalla actual puede no existir (o no estar permitida) en
      // la otra empresa.
      navigate('/')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo cambiar de empresa'))
    } finally {
      setSwitching(null)
    }
  }

  const join = async (e: React.FormEvent) => {
    e.preventDefault()
    if (code.trim().length < 6) return toast.error('El código no parece completo.')
    try {
      // Canjear deja la empresa invitada como activa (accept_invite, 0013).
      await accept.mutateAsync(code)
      setCode('')
      setJoining(false)
      toast.success('¡Te uniste! Esa empresa es ahora la activa.')
      navigate('/')
    } catch (err) {
      toast.error(errorMessage(err, 'Código inválido o vencido'))
    }
  }

  const rows = tenants.data ?? []

  return (
    <Card>
      <CardHeader
        title="Mis empresas"
        action={
          !joining && (
            <Button variant="outline" size="sm" onClick={() => setJoining(true)}>
              <Ticket className="h-4 w-4" /> Unirme
            </Button>
          )
        }
      />
      <CardBody className="space-y-3">
        {tenants.isLoading ? (
          <PageLoader label="Cargando empresas…" />
        ) : tenants.isError ? (
          <p className="text-sm text-red-600">{errorMessage(tenants.error, 'No se pudieron cargar tus empresas.')}</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((t) => (
              <li key={t.id} className="flex items-center gap-3 rounded-xl border border-slate-200 p-2.5">
                <Avatar name={t.name} src={t.logo_url} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{t.name}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1">
                    <Badge tone={t.role === 'owner' ? 'brand' : 'slate'}>{ROLE_LABEL[t.role]}</Badge>
                    {t.active && <Badge tone="green">Activa</Badge>}
                    {t.suspended && <Badge tone="red">Suspendida</Badge>}
                  </div>
                </div>
                {!t.active && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0"
                    loading={switching === t.id}
                    disabled={Boolean(switching)}
                    onClick={() => void change(t)}
                    aria-label={`Cambiar a ${t.name}`}
                    title="Cambiar a esta empresa"
                  >
                    <ArrowRightLeft className="h-4 w-4" />
                    <span className="hidden sm:inline">Cambiar</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {joining && (
          <form onSubmit={join} className="space-y-2 border-t border-slate-100 pt-3">
            <Field label="Código de invitación" hint="Te lo comparte quien administra la otra empresa">
              <Input
                autoFocus
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setJoining(false)}>
                Cancelar
              </Button>
              <Button type="submit" size="sm" loading={accept.isPending}>
                Unirme
              </Button>
            </div>
          </form>
        )}
      </CardBody>
    </Card>
  )
}

/* ── Sesiones ─────────────────────────────────────────────────────────────── */

function SessionsCard() {
  const signOutOthers = useSignOutOthers()
  const toast = useToast()

  const run = async () => {
    if (
      !window.confirm(
        '¿Cerrar la sesión en los demás dispositivos? Tendrán que volver a entrar con tu contraseña.',
      )
    )
      return
    try {
      await signOutOthers.mutateAsync()
      toast.success('Sesiones cerradas en los demás dispositivos.')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudieron cerrar las otras sesiones'))
    }
  }

  return (
    <Card>
      <CardHeader title="Seguridad" />
      <CardBody className="space-y-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 shrink-0 text-slate-400">
            <MonitorSmartphone className="h-4 w-4" />
          </span>
          <p className="text-sm text-slate-600">
            Si usaste la app en un teléfono prestado o crees que alguien más entró, cierra las
            demás sesiones. La de este dispositivo sigue abierta.
          </p>
        </div>
        <Button
          variant="outline"
          className="w-full"
          onClick={() => void run()}
          loading={signOutOthers.isPending}
        >
          <LogOut className="h-4 w-4" /> Cerrar las otras sesiones
        </Button>
      </CardBody>
    </Card>
  )
}
