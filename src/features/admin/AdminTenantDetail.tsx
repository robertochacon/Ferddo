import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, Ban, Building2, Contact, CreditCard, FileCheck2, Monitor, Package, Play, Receipt,
  ShieldCheck, Store, Trash2, UserRound, Users,
} from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { ActionMenu, type ActionItem } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { StatCard } from '@/components/ui/StatCard'
import { Avatar, EmptyState, PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { APP_NAME } from '@/lib/constants'
import { errorMessage } from '@/lib/errors'
import { fmtDate, fmtDateTime, num } from '@/lib/format'
import { ECF_STATUS, ROLE_LABEL } from '@/lib/labels'
import {
  useAdminMembers, useAdminRemoveMember, useAdminSetMemberRole, useAdminSetUserBanned,
  useAdminTenantSummary, useAdminTenants,
} from '@/hooks/admin'
import { useBusinessTypes } from '@/hooks/core'
import type { AdminMember, MemberRole } from '@/types/db'
import type { EcfStatus } from '@/types/erp'
import { DeleteTenantModal } from './DeleteTenantModal'
import { SUB_STATUS_LABEL, SUB_STATUS_TONE, SubscriptionEditor } from './SubscriptionEditor'

/**
 * Ficha de un negocio vista por el super-admin: cuánto usa, su suscripción,
 * quién entra y el único botón que lo borra.
 *
 * PRIVACIDAD POR DISEÑO: solo agregados. Ni ventas, ni clientes, ni productos
 * concretos — `admin_tenant_summary` (0018) devuelve conteos y estados, nada
 * más. Para dar soporte basta con eso, y lo que el panel no puede ver no se
 * puede filtrar.
 *
 * El nombre y el plan salen de `useAdminTenants()` —la lista que el panel ya
 * tiene en cache—: la RPC `admin_list_tenants` es la que trae el correo del
 * dueño (vive en `auth.users`, fuera del alcance de la RLS).
 */

/** `fiscal_settings.environment` (0016). */
const ENV_LABEL: Record<string, string> = {
  test: 'Ambiente de pruebas',
  certification: 'Certificación',
  production: 'Producción',
}

export function AdminTenantDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, plans } = useAuth()
  const [params] = useSearchParams()
  const summary = useAdminTenantSummary(id)
  const tenants = useAdminTenants()
  const businessTypes = useBusinessTypes()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editingSub, setEditingSub] = useState(false)
  const membersRef = useRef<HTMLDivElement>(null)

  const t = (tenants.data ?? []).find((row) => row.id === id) ?? null
  const s = summary.data
  const typeLabel = useMemo(
    () => (t ? (businessTypes.data ?? []).find((b) => b.code === t.business_type)?.label ?? t.business_type : ''),
    [t, businessTypes.data],
  )

  // El panel enlaza aquí con `?ir=miembros` desde la acción «Usuarios» de la
  // lista. Sin este salto la pantalla abre por el resumen y hay que buscar la
  // tarjeta a mano, que es justo lo que esa acción prometía evitar.
  useEffect(() => {
    if (params.get('ir') !== 'miembros') return
    membersRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [params])

  const ecfEntries = Object.entries(s?.ecf_by_status ?? {}).filter(([, n]) => Number(n) > 0)

  return (
    <div className="min-h-[100dvh] bg-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4">
          <span className="truncate text-lg font-extrabold tracking-tight text-brand-950">{APP_NAME}</span>
          <Badge tone="brand" className="shrink-0">
            <ShieldCheck className="h-3.5 w-3.5" /> Super-admin
          </Badge>
          <span className="ml-auto hidden min-w-0 truncate text-sm text-slate-500 sm:block">{user?.email}</span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-6">
        <button
          onClick={() => navigate('/admin?s=negocios')}
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
        >
          <ArrowLeft className="h-4 w-4" /> Volver al panel
        </button>

        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 truncate text-xl font-bold text-slate-900">{t?.name ?? 'Negocio'}</h1>
          {t?.plan && <Badge tone="brand">{plans[t.plan].name}</Badge>}
          {t?.sub_status && <Badge tone={SUB_STATUS_TONE[t.sub_status]}>{SUB_STATUS_LABEL[t.sub_status]}</Badge>}
          {t?.suspended && <Badge tone="red">Suspendido</Badge>}
        </div>
        <p className="mb-6 break-all text-sm text-slate-500">
          {t
            ? [
                typeLabel,
                t.rnc ? `RNC ${t.rnc}` : null,
                `${t.owner_name ?? 'Sin dueño'} · ${t.owner_email ?? 'sin correo'}`,
                `alta ${fmtDate(t.created_at)}`,
              ]
                .filter(Boolean)
                .join(' · ')
            : ''}
        </p>

        {summary.isLoading ? (
          <PageLoader label="Cargando resumen…" />
        ) : summary.isError ? (
          <p className="rounded-xl bg-white p-6 text-center text-sm text-red-600">
            {errorMessage(summary.error, 'No se pudo cargar el resumen del negocio.')}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Usuarios" value={s ? num(s.members) : '—'} icon={<UserRound className="h-5 w-5" />} tone="slate"
              hint={s ? `${num(s.pending_invites)} invitaciones sin usar` : undefined} />
            <StatCard label="Sucursales" value={s ? num(s.branches) : '—'} icon={<Store className="h-5 w-5" />} tone="slate" />
            <StatCard label="Cajas" value={s ? num(s.registers) : '—'} icon={<Monitor className="h-5 w-5" />} tone="slate" />
            <StatCard label="Productos" value={s ? num(s.products) : '—'} icon={<Package className="h-5 w-5" />} tone="brand" />
            <StatCard label="Clientes" value={s ? num(s.customers) : '—'} icon={<Contact className="h-5 w-5" />} tone="brand" />
            <StatCard label="Ventas 30 días" value={s ? num(s.sales_30d) : '—'} icon={<Receipt className="h-5 w-5" />} tone="accent"
              hint={s ? `${num(s.sales_total)} en total` : undefined} />
            <StatCard label="Última venta" value={s?.last_sale_at ? fmtDate(s.last_sale_at) : 'Nunca'}
              icon={<Building2 className="h-5 w-5" />} tone="green" />
            <StatCard label="e-CF" value={s ? (s.ecf_enabled ? 'Activo' : 'Inactivo') : '—'} icon={<FileCheck2 className="h-5 w-5" />}
              tone={s?.ecf_enabled ? 'green' : 'slate'}
              hint={s?.ecf_environment ? ENV_LABEL[s.ecf_environment] ?? s.ecf_environment : 'Sin configurar'} />
          </div>
        )}

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* ── Suscripción ── */}
          <Card>
            <CardHeader
              title="Suscripción"
              subtitle="Plan, estado y fechas. El cobro se coordina por fuera de la app."
              action={
                t && (
                  <Button size="sm" variant="outline" onClick={() => setEditingSub(true)}>
                    <CreditCard className="h-4 w-4" /> Editar
                  </Button>
                )
              }
            />
            <CardBody className="space-y-3">
              {t ? (
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-xs text-slate-500">Plan</dt>
                    <dd className="font-medium text-slate-800">{t.plan ? plans[t.plan].name : '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Estado</dt>
                    <dd className="font-medium text-slate-800">{t.sub_status ? SUB_STATUS_LABEL[t.sub_status] : '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Periodo pagado hasta</dt>
                    <dd className="font-medium text-slate-800">{fmtDate(t.current_period_end)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Fin de la prueba</dt>
                    <dd className="font-medium text-slate-800">{fmtDate(t.trial_ends_at)}</dd>
                  </div>
                </dl>
              ) : (
                <p className="text-sm text-slate-400">{tenants.isLoading ? 'Cargando…' : 'Negocio no encontrado.'}</p>
              )}

              <div className="border-t border-slate-100 pt-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Historial</p>
                {(s?.subscription_history ?? []).length === 0 ? (
                  <p className="text-sm text-slate-400">Sin cambios registrados.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {(s?.subscription_history ?? []).map((h, i) => (
                      <li key={`${h.created_at}-${i}`} className="flex flex-wrap items-center gap-1.5 text-sm">
                        <span className="w-full text-xs text-slate-400 sm:w-40">{fmtDateTime(h.created_at)}</span>
                        <Badge tone="brand">{plans[h.plan]?.name ?? h.plan}</Badge>
                        <Badge tone={SUB_STATUS_TONE[h.status]}>{SUB_STATUS_LABEL[h.status]}</Badge>
                        {h.current_period_end && (
                          <span className="text-xs text-slate-500">hasta {fmtDate(h.current_period_end)}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardBody>
          </Card>

          {/* ── e-CF por estado ── */}
          <Card>
            <CardHeader title="Comprobantes electrónicos" subtitle="Conteo por estado, sin contenido" />
            <CardBody>
              {ecfEntries.length === 0 ? (
                <p className="text-sm text-slate-400">Este negocio aún no ha emitido e-CF.</p>
              ) : (
                <ul className="space-y-2">
                  {ecfEntries.map(([st, n]) => {
                    const meta = ECF_STATUS[st as EcfStatus]
                    return (
                      <li key={st} className="flex items-center justify-between gap-2 text-sm">
                        <Badge tone={meta?.tone ?? 'slate'}>{meta?.label ?? st}</Badge>
                        <span className="font-semibold tabular-nums text-slate-800">{num(Number(n))}</span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>

        <div ref={membersRef} className="scroll-mt-20">
          <MembersCard tenantId={id} tenantName={t?.name ?? 'este negocio'} />
        </div>

        {/* ── Zona de peligro ───────────────────────────────────────────────
            Va al final y con marco propio: es la única acción de esta pantalla
            que no tiene vuelta atrás. */}
        <Card className="mt-4 border-red-200">
          <CardHeader title="Zona de peligro" subtitle="Acciones irreversibles" />
          <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-800">Eliminar este negocio</p>
              <p className="text-xs text-slate-500">
                Borra en cascada sus sucursales, productos, inventario, ventas, caja, comprobantes,
                compras, gastos, bitácora y archivos. Si solo quieres cortarle el acceso, suspéndelo
                desde el panel.
              </p>
            </div>
            <Button variant="danger" className="shrink-0" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-4 w-4" /> Eliminar…
            </Button>
          </CardBody>
        </Card>

        <p className="mt-6 text-center text-xs text-slate-400">
          Vista de soporte: solo cifras agregadas, nunca datos del negocio.
        </p>
      </main>

      <Modal open={editingSub && Boolean(t)} onClose={() => setEditingSub(false)}
        title={t ? `Suscripción · ${t.name}` : 'Suscripción'}>
        {t && (
          <SubscriptionEditor
            sub={{
              tenantId: t.id, tenantName: t.name, plan: t.plan, status: t.sub_status,
              currentPeriodEnd: t.current_period_end, trialEndsAt: t.trial_ends_at,
            }}
            onSaved={() => setEditingSub(false)}
            onCancel={() => setEditingSub(false)}
          />
        )}
      </Modal>

      <DeleteTenantModal
        tenantId={confirmDelete && id ? id : null}
        tenantName={t?.name}
        onClose={() => setConfirmDelete(false)}
        // El negocio ya no existe: quedarse aquí dejaría una pantalla de huecos.
        onDeleted={() => navigate('/admin?s=negocios')}
      />
    </div>
  )
}

/** Roles que el super-admin puede asignar. El dueño va primero: es el caso de soporte típico. */
const ADMIN_ROLES: MemberRole[] = [
  'owner', 'admin', 'supervisor', 'cashier', 'seller', 'inventory', 'purchasing', 'accounting', 'kitchen', 'service',
]

/**
 * Usuarios del negocio: rol, bloqueo de acceso y baja.
 *
 * Sin tabla ni siquiera en escritorio. Son cuatro datos por persona y caben en
 * una fila a 360px, así que una tabla solo añadiría scroll lateral en el
 * teléfono para no ganar nada arriba.
 */
function MembersCard({ tenantId, tenantName }: { tenantId?: string; tenantName: string }) {
  const toast = useToast()
  const members = useAdminMembers(tenantId)
  const setRole = useAdminSetMemberRole()
  const setBanned = useAdminSetUserBanned()
  const removeMember = useAdminRemoveMember()
  const [roleFor, setRoleFor] = useState<AdminMember | null>(null)
  const [role, setRoleValue] = useState<MemberRole>('admin')
  const rows = members.data ?? []

  // Todas las mutaciones fallan igual (la RPC lanza «No autorizado», «Debe
  // quedar un dueño»…), así que el aviso se escribe una vez y no cinco.
  const run = async (p: Promise<unknown>, ok: string) => {
    try {
      await p
      toast.success(ok)
      return true
    } catch (err) {
      toast.error(errorMessage(err))
      return false
    }
  }

  const actionsFor = (m: AdminMember): ActionItem[] => {
    if (!tenantId) return []
    const tenant = tenantId
    return [
      {
        label: 'Cambiar rol',
        icon: <Users className="h-4 w-4" />,
        onClick: () => {
          setRoleValue(m.role)
          setRoleFor(m)
        },
      },
      m.banned
        ? {
            label: 'Reactivar acceso',
            icon: <Play className="h-4 w-4" />,
            tone: 'success',
            onClick: () => void run(setBanned.mutateAsync({ user: m.id, banned: false }), 'Acceso reactivado.'),
          }
        : {
            label: 'Bloquear acceso',
            icon: <Ban className="h-4 w-4" />,
            tone: 'danger',
            hint: 'No podrá iniciar sesión en ninguna parte',
            onClick: () => void run(setBanned.mutateAsync({ user: m.id, banned: true }), 'Acceso bloqueado.'),
          },
      {
        label: 'Quitar del negocio',
        icon: <Trash2 className="h-4 w-4" />,
        tone: 'danger',
        hint: 'Conserva su cuenta: podrá crear otro negocio o unirse a uno',
        onClick: () => {
          if (!window.confirm(`¿Quitar a ${m.full_name ?? m.email} de ${tenantName}?`)) return
          void run(removeMember.mutateAsync({ tenant, user: m.id }), 'Usuario quitado del negocio.')
        },
      },
    ]
  }

  const saveRole = async () => {
    if (!tenantId || !roleFor) return
    const ok = await run(setRole.mutateAsync({ tenant: tenantId, user: roleFor.id, role }), 'Rol actualizado.')
    if (ok) setRoleFor(null)
  }

  return (
    <Card className="mt-4">
      <CardHeader title="Usuarios" subtitle={`${rows.length} con acceso a este negocio`} />
      {members.isLoading ? (
        <PageLoader label="Cargando usuarios…" />
      ) : members.isError ? (
        <p className="p-6 text-center text-sm text-red-600">{errorMessage(members.error, 'No se pudieron cargar los usuarios.')}</p>
      ) : rows.length === 0 ? (
        <EmptyState className="m-5" icon={<Users className="h-5 w-5" />} title="Sin usuarios"
          description="Este negocio no tiene ninguna cuenta asociada." />
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-4 py-3">
              <Avatar name={m.full_name ?? m.email} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-800">{m.full_name ?? 'Sin nombre'}</p>
                <p className="truncate text-xs text-slate-400">{m.email ?? '—'}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Badge tone={m.role === 'owner' ? 'brand' : 'slate'}>{ROLE_LABEL[m.role]}</Badge>
                  {!m.is_active && <Badge tone="amber">Inactivo</Badge>}
                  {m.banned && <Badge tone="red">Acceso bloqueado</Badge>}
                </div>
              </div>
              <ActionMenu title={m.full_name ?? m.email ?? 'Usuario'} label="Opciones del usuario" items={actionsFor(m)} />
            </li>
          ))}
        </ul>
      )}
      <CardBody className="border-t border-slate-100 py-3">
        <p className="text-xs text-slate-500">
          «Bloquear acceso» apaga el login de esa persona en toda la plataforma; «quitar» solo la
          desvincula de este negocio. La base no deja al negocio sin dueño ni a la plataforma sin
          super-admins: esos casos los rechaza la RPC, no este formulario.
        </p>
      </CardBody>

      <Modal
        open={Boolean(roleFor)}
        onClose={() => setRoleFor(null)}
        title={roleFor ? `Rol de ${roleFor.full_name ?? roleFor.email ?? 'usuario'}` : 'Rol'}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setRoleFor(null)}>Cancelar</Button>
            <Button onClick={() => void saveRole()} loading={setRole.isPending}>Guardar</Button>
          </>
        }
      >
        <Select value={role} onChange={(e) => setRoleValue(e.target.value as MemberRole)} aria-label="Rol">
          {ADMIN_ROLES.map((r) => (
            <option key={r} value={r}>{ROLE_LABEL[r]}</option>
          ))}
        </Select>
      </Modal>
    </Card>
  )
}
