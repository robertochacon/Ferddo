import { useState, type ReactNode } from 'react'
import { Ban, Check, Copy, Crown, Lock, Play, Share2, ShieldCheck, Trash2, UserCog, UserPlus, Users } from 'lucide-react'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ActionMenu, type ActionItem } from '@/components/ui/ActionMenu'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Field, Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Modal } from '@/components/ui/Modal'
import { Avatar, EmptyState, PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/auth/AuthProvider'
import { useBranches } from '@/hooks/core'
import {
  useCreateInvite,
  usePendingInvites,
  useRevokeInvite,
  useSetMemberActive,
  useSetMemberRole,
  useTeamMembers,
  type Invite,
} from '@/hooks/team'
import { APP_NAME, appUrl } from '@/lib/constants'
import { errorMessage } from '@/lib/errors'
import { fmtDate } from '@/lib/format'
import { ASSIGNABLE_ROLES, ROLE_LABEL } from '@/lib/labels'
import { cn } from '@/lib/cn'
import type { MemberRole } from '@/types/db'
import type { Branch, TeamMemberRow } from '@/types/erp'
import { LoadError } from './parts'

/**
 * Equipo: quién trabaja en la empresa, con qué rol y en qué sucursales.
 *
 * Reglas que pone la base y aquí solo se reflejan para no ofrecer botones que
 * fallarían: solo un dueño crea/quita dueños; la empresa no puede quedarse sin
 * dueño activo; el tope de usuarios del plan (`PLAN_LIMIT_MEMBERS`) se aplica
 * al crear la invitación. La LISTA de invitaciones solo la ve el dueño (RLS):
 * los códigos son credenciales al portador.
 */
export function TeamSettings() {
  return (
    <div className="space-y-4">
      <MembersCard />
      <InvitesCard />
    </div>
  )
}

/** Roles que puede asignar quien está usando la pantalla (solo un dueño da "dueño"). */
function assignableFor(isOwner: boolean): MemberRole[] {
  return ASSIGNABLE_ROLES.filter((r) => r !== 'owner' || isOwner)
}

function branchesLabel(ids: string[] | null, branches: Branch[]): string {
  if (!ids || ids.length === 0) return 'Todas'
  const names = ids.map((id) => branches.find((b) => b.id === id)?.name).filter(Boolean)
  return names.length ? names.join(', ') : `${ids.length} sucursal(es)`
}

function MembersCard() {
  const { user, isOwner, plan } = useAuth()
  const toast = useToast()
  const members = useTeamMembers()
  const branches = useBranches()
  const setActive = useSetMemberActive()
  const [editing, setEditing] = useState<TeamMemberRow | null>(null)

  const rows = members.data ?? []
  const branchList = branches.data ?? []
  const activeCount = rows.filter((m) => m.is_active).length

  const toggleActive = async (m: TeamMemberRow) => {
    const next = !m.is_active
    const who = m.full_name ?? m.email ?? 'esta persona'
    if (!next && !window.confirm(`¿Desactivar a ${who}? Pierde el acceso a esta empresa al instante.`)) return
    try {
      await setActive.mutateAsync({ userId: m.user_id, active: next })
      toast.success(next ? 'Acceso reactivado.' : 'Acceso desactivado.')
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  const actionsFor = (m: TeamMemberRow): ActionItem[] => {
    // A un dueño solo lo toca otro dueño (set_member_role / set_member_active).
    const locked = m.role === 'owner' && !isOwner
    const self = m.user_id === user?.id
    const items: ActionItem[] = [
      {
        label: 'Rol y sucursales',
        icon: <UserCog className="h-4 w-4" />,
        disabled: locked,
        hint: locked ? 'Solo el dueño puede cambiar a otro dueño' : undefined,
        onClick: () => setEditing(m),
      },
    ]
    if (!self) {
      items.push(
        m.is_active
          ? {
              label: 'Desactivar acceso',
              icon: <Ban className="h-4 w-4" />,
              tone: 'danger',
              disabled: locked,
              hint: 'Conserva su historial de ventas y movimientos',
              onClick: () => void toggleActive(m),
            }
          : {
              label: 'Reactivar acceso',
              icon: <Play className="h-4 w-4" />,
              tone: 'success',
              disabled: locked,
              onClick: () => void toggleActive(m),
            },
      )
    }
    return items
  }

  const roleBadge = (m: TeamMemberRow) => (
    <Badge tone={m.role === 'owner' ? 'brand' : 'slate'}>
      {m.role === 'owner' && <Crown className="h-3 w-3" />}
      {ROLE_LABEL[m.role]}
    </Badge>
  )
  const statusBadge = (m: TeamMemberRow) =>
    m.is_active ? <Badge tone="green">Activo</Badge> : <Badge tone="slate">Inactivo</Badge>

  return (
    <Card>
      <CardHeader
        title="Miembros"
        subtitle={
          plan.maxMembers == null
            ? `${activeCount} activos · usuarios ilimitados en tu plan`
            : `${activeCount} de ${plan.maxMembers} usuarios de tu plan`
        }
      />
      {members.isLoading ? (
        <PageLoader label="Cargando equipo…" />
      ) : members.isError ? (
        <LoadError error={members.error} onRetry={() => members.refetch()} what="los miembros" />
      ) : rows.length === 0 ? (
        <EmptyState className="m-5" icon={<Users className="h-5 w-5" />} title="Sin miembros" />
      ) : (
        <>
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3 font-medium">Persona</th>
                  <th className="px-4 py-3 font-medium">Rol</th>
                  <th className="px-4 py-3 font-medium">Sucursales</th>
                  <th className="px-4 py-3 font-medium">Estado</th>
                  <th className="px-4 py-3 font-medium">Desde</th>
                  <th className="px-4 py-3 text-right font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map((m) => (
                  <tr key={m.user_id} className={cn(!m.is_active && 'bg-slate-50/60')}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar name={m.full_name ?? m.email} size="sm" />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-slate-800">
                            {m.full_name ?? 'Sin nombre'}
                            {m.user_id === user?.id && <span className="ml-1.5 text-xs text-slate-400">(tú)</span>}
                          </p>
                          {m.email && <p className="truncate text-xs text-slate-400">{m.email}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">{roleBadge(m)}</td>
                    <td className="max-w-[220px] truncate px-4 py-3 text-slate-600">{branchesLabel(m.branch_ids, branchList)}</td>
                    <td className="px-4 py-3">{statusBadge(m)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-500">{fmtDate(m.created_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <ActionMenu title={m.full_name ?? 'Miembro'} label="Opciones del miembro" items={actionsFor(m)} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DataList>
            {rows.map((m) => (
              <DataRow
                key={m.user_id}
                leading={<Avatar name={m.full_name ?? m.email} size="sm" />}
                title={`${m.full_name ?? 'Sin nombre'}${m.user_id === user?.id ? ' (tú)' : ''}`}
                titleExtra={m.email}
                tone={m.is_active ? undefined : 'muted'}
                badges={<>{roleBadge(m)}{statusBadge(m)}</>}
                actions={<ActionMenu title={m.full_name ?? 'Miembro'} label="Opciones del miembro" items={actionsFor(m)} />}
              >
                <DataFields>
                  <DataField label="Sucursales" wrap>{branchesLabel(m.branch_ids, branchList)}</DataField>
                  <DataField label="Desde">{fmtDate(m.created_at)}</DataField>
                </DataFields>
              </DataRow>
            ))}
          </DataList>
        </>
      )}

      <MemberModal member={editing} branches={branchList} onClose={() => setEditing(null)} />
    </Card>
  )
}

function MemberModal({
  member,
  branches,
  onClose,
}: {
  member: TeamMemberRow | null
  branches: Branch[]
  onClose: () => void
}) {
  const { isOwner } = useAuth()
  const toast = useToast()
  const setRole = useSetMemberRole()
  const [role, setRoleValue] = useState<MemberRole>('cashier')
  const [restricted, setRestricted] = useState(false)
  const [selected, setSelected] = useState<string[]>([])

  const key = member?.user_id ?? ''
  const [synced, setSynced] = useState('')
  if (key !== synced) {
    setSynced(key)
    if (member) {
      setRoleValue(member.role)
      setRestricted(Boolean(member.branch_ids && member.branch_ids.length))
      setSelected(member.branch_ids ?? [])
    }
  }

  const roles = assignableFor(isOwner)
  // Si ya es dueño y quien edita también, el rol actual debe estar en la lista.
  const options = member && !roles.includes(member.role) ? [member.role, ...roles] : roles

  const toggleBranch = (id: string, on: boolean) =>
    setSelected((prev) => (on ? [...prev.filter((x) => x !== id), id] : prev.filter((x) => x !== id)))

  const save = async () => {
    if (!member) return
    if (restricted && selected.length === 0) return toast.error('Elige al menos una sucursal o deja «Todas».')
    try {
      // `null` = todas las sucursales (también las que se creen después).
      await setRole.mutateAsync({ userId: member.user_id, role, branchIds: restricted ? selected : null })
      toast.success('Miembro actualizado.')
      onClose()
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo actualizar el miembro'))
    }
  }

  return (
    <Modal
      open={Boolean(member)}
      onClose={onClose}
      title={member ? (member.full_name ?? member.email ?? 'Miembro') : 'Miembro'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => void save()} loading={setRole.isPending}>Guardar</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Rol" hint="Los permisos de cada rol se ajustan en «Roles y permisos»">
          <Select value={role} onChange={(e) => setRoleValue(e.target.value as MemberRole)}>
            {options.map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
            ))}
          </Select>
        </Field>

        <div>
          <p className="mb-2 text-sm font-medium text-slate-700">Sucursales donde puede trabajar</p>
          <div className="space-y-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
              <input type="radio" name="branch-scope" checked={!restricted} onChange={() => setRestricted(false)}
                className="h-4 w-4 border-slate-300 text-brand-600" />
              Todas las sucursales
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
              <input type="radio" name="branch-scope" checked={restricted} onChange={() => setRestricted(true)}
                className="h-4 w-4 border-slate-300 text-brand-600" />
              Solo las que elija
            </label>
          </div>
          {restricted && (
            <div className="mt-3 space-y-1.5 rounded-xl border border-slate-200 p-3">
              {branches.length === 0 ? (
                <p className="text-sm text-slate-500">No hay sucursales.</p>
              ) : (
                branches.map((b) => (
                  <label key={b.id} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={selected.includes(b.id)}
                      onChange={(e) => toggleBranch(b.id, e.target.checked)}
                      className="h-4 w-4 rounded border-slate-300 text-brand-600" />
                    {b.name}
                    {!b.is_active && <Badge tone="slate">Inactiva</Badge>}
                  </label>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

/* ── Invitaciones ─────────────────────────────────────────────────────────── */

function InvitesCard() {
  const { tenant, isOwner, plan } = useAuth()
  const toast = useToast()
  const invites = usePendingInvites()
  const createInvite = useCreateInvite()
  const revokeInvite = useRevokeInvite()
  const [role, setRole] = useState<MemberRole>('cashier')
  const [email, setEmail] = useState('')
  // El código recién creado se enseña aquí: un administrador (no dueño) puede
  // crear invitaciones pero la RLS no le deja LISTARLAS, así que es su única
  // oportunidad de copiarlo.
  const [created, setCreated] = useState<{ code: string; role: MemberRole } | null>(null)

  const multiUser = plan.maxMembers == null || plan.maxMembers > 1
  const registerUrl = appUrl('/registro')

  const inviteText = (code: string, r: MemberRole) =>
    `Te invito a trabajar en ${tenant?.name ?? 'mi negocio'} (${ROLE_LABEL[r]}) con ${APP_NAME}.\n` +
    `1) Crea tu cuenta aquí: ${registerUrl}\n` +
    `2) Elige "Unirme con código" y escribe: ${code}\n` +
    `Si ya tienes cuenta, entra a Mi perfil → "Unirme a otra empresa" y escribe el código.`

  const create = async () => {
    try {
      const code = await createInvite.mutateAsync({ role, email: email.trim() || null })
      setCreated({ code, role })
      setEmail('')
      toast.success('Invitación creada. Compártela con esa persona.')
    } catch (err) {
      // `errorMessage` limpia el prefijo PLAN_LIMIT_MEMBERS y deja la frase útil.
      toast.error(errorMessage(err, 'No se pudo crear la invitación'))
    }
  }

  const copy = async (text: string, ok: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(ok)
    } catch {
      // El portapapeles falla sin HTTPS y en algunos navegadores embebidos.
      toast.error('No se pudo copiar. Selecciónalo y cópialo a mano.')
    }
  }

  const share = async (code: string, r: MemberRole) => {
    const text = inviteText(code, r)
    // La hoja nativa de compartir es lo que la gente usa en el teléfono (manda
    // por WhatsApp o el chat que quiera). En escritorio casi nunca existe.
    if (navigator.share) {
      try {
        await navigator.share({ title: APP_NAME, text })
      } catch {
        // Cancelar la hoja también lanza: no es un error que haya que contar.
      }
      return
    }
    await copy(text, 'Invitación copiada. Pégala donde quieras enviarla.')
  }

  const revoke = async (inv: Invite) => {
    if (!window.confirm('¿Revocar esta invitación? El código dejará de servir al instante.')) return
    try {
      await revokeInvite.mutateAsync(inv.id)
      toast.success('Invitación revocada')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo revocar'))
    }
  }

  if (!multiUser) {
    return (
      <Card>
        <CardHeader title="Invitar al equipo" />
        <CardBody>
          <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-500">
            <Lock className="h-5 w-5 shrink-0 text-slate-400" />
            Tu plan es de un solo usuario. Cambia de plan en la sección «Plan» para invitar a tu equipo.
          </div>
        </CardBody>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader title="Invitar al equipo" subtitle="La persona entra con su propia cuenta y el rol que elijas" />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1.4fr_auto] sm:items-end">
          <Field label="Rol">
            <Select value={role} onChange={(e) => setRole(e.target.value as MemberRole)}>
              {assignableFor(isOwner).map((r) => (
                <option key={r} value={r}>{ROLE_LABEL[r]}</option>
              ))}
            </Select>
          </Field>
          <Field label="Correo (opcional)" hint="Solo como referencia">
            <Input type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="persona@correo.com" />
          </Field>
          <Button onClick={() => void create()} loading={createInvite.isPending} className="sm:mb-[22px]">
            <UserPlus className="h-4 w-4" /> Crear invitación
          </Button>
        </div>

        {created && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
            <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-800">
              <Check className="h-4 w-4" /> Invitación para {ROLE_LABEL[created.role].toLowerCase()}
            </p>
            <code className="mt-2 block break-all rounded-lg bg-white px-2 py-1.5 font-mono text-sm text-slate-800">
              {created.code}
            </code>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void copy(created.code, 'Código copiado')}>
                <Copy className="h-4 w-4" /> Copiar código
              </Button>
              <Button size="sm" variant="outline" onClick={() => void share(created.code, created.role)}>
                <Share2 className="h-4 w-4" /> Compartir invitación
              </Button>
            </div>
          </div>
        )}

        {isOwner ? (
          <PendingInvites
            invites={invites.data ?? []}
            loading={invites.isLoading}
            error={invites.isError ? invites.error : null}
            onRetry={() => invites.refetch()}
            onCopy={(inv) => void copy(inv.code, 'Código copiado')}
            onShare={(inv) => void share(inv.code, inv.role)}
            onRevoke={(inv) => void revoke(inv)}
          />
        ) : (
          // Los códigos son secretos "quien lo tenga, entra": la RLS solo se los
          // devuelve al dueño.
          <p className="flex items-start gap-2 text-xs text-slate-500">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            Por seguridad, solo el dueño ve y revoca las invitaciones pendientes. Copia el código
            ahora: no podrás volver a verlo.
          </p>
        )}
      </CardBody>
    </Card>
  )
}

function PendingInvites({
  invites,
  loading,
  error,
  onRetry,
  onCopy,
  onShare,
  onRevoke,
}: {
  invites: Invite[]
  loading: boolean
  error: unknown
  onRetry: () => void
  onCopy: (inv: Invite) => void
  onShare: (inv: Invite) => void
  onRevoke: (inv: Invite) => void
}) {
  if (loading) return <PageLoader label="Cargando invitaciones…" />
  if (error) return <LoadError error={error} onRetry={onRetry} what="las invitaciones" />
  if (invites.length === 0) {
    return <p className="text-sm text-slate-400">No hay invitaciones pendientes.</p>
  }
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Invitaciones pendientes</p>
      <ul className="space-y-2">
        {invites.map((inv) => {
          const expired = new Date(inv.expires_at).getTime() < Date.now()
          return (
            <li key={inv.id} className="rounded-xl border border-slate-200 p-2.5">
              {/* Dos filas a propósito: a 360px, el código y tres botones en
                  línea dejan el código en cuatro letras. */}
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg bg-slate-100 px-2 py-1 font-mono text-sm text-slate-700">
                  {inv.code}
                </code>
                <Badge tone="slate">{ROLE_LABEL[inv.role]}</Badge>
                {expired && <Badge tone="red">Vencida</Badge>}
              </div>
              <div className="mt-2 flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-xs text-slate-400">
                  {inv.email ? `${inv.email} · ` : ''}
                  {expired ? 'Venció' : 'Vence'} el {fmtDate(inv.expires_at)}
                </span>
                <IconAction title="Copiar código" onClick={() => onCopy(inv)}>
                  <Copy className="h-4 w-4" />
                </IconAction>
                <IconAction title="Compartir invitación" onClick={() => onShare(inv)}>
                  <Share2 className="h-4 w-4" />
                </IconAction>
                <IconAction title="Revocar invitación" tone="danger" onClick={() => onRevoke(inv)}>
                  <Trash2 className="h-4 w-4" />
                </IconAction>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const ICON_TONE = {
  default: 'text-slate-400 hover:bg-slate-100 hover:text-slate-600',
  danger: 'text-slate-300 hover:bg-red-50 hover:text-red-500',
} as const

function IconAction({
  title,
  onClick,
  tone = 'default',
  children,
}: {
  title: string
  onClick: () => void
  tone?: keyof typeof ICON_TONE
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn('shrink-0 rounded-lg p-2', ICON_TONE[tone])}
    >
      {children}
    </button>
  )
}
