import { useMemo, useState } from 'react'
import { Crown, RotateCcw, Save } from 'lucide-react'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Field } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { usePermissionsCatalog } from '@/hooks/core'
import { useRolePermissions, useSetRolePermissions } from '@/hooks/team'
import { errorMessage } from '@/lib/errors'
import { ASSIGNABLE_ROLES, ROLE_LABEL } from '@/lib/labels'
import type { MemberRole } from '@/types/db'
import type { Permission } from '@/types/erp'
import { LoadError } from './parts'

/** Nombre de cada grupo (`permissions.module`, 0013), en el orden en que se listan. */
const GROUP_LABEL: Record<string, string> = {
  config: 'Configuración',
  catalog: 'Catálogo',
  inventory: 'Inventario',
  sales: 'Ventas',
  cash: 'Caja',
  credit: 'Crédito y cobros',
  purchases: 'Compras',
  expenses: 'Gastos',
  invoicing: 'Facturación electrónica',
  reports: 'Reportes',
}
const GROUP_ORDER = Object.keys(GROUP_LABEL)

/** El dueño siempre lo tiene todo (la base lo impone): no se edita, así que no sale. */
const EDITABLE_ROLES: MemberRole[] = ASSIGNABLE_ROLES.filter((r) => r !== 'owner')

type Draft = Partial<Record<MemberRole, string[]>>

/**
 * Matriz de permisos × roles de ESTA empresa (`role_permissions`). Cada rol se
 * guarda por separado con `set_role_permissions`, que además impide conceder
 * permisos que quien edita no tiene (escalada por la tabla de roles).
 *
 * Escritorio: la matriz completa, para comparar roles de un vistazo.
 * Teléfono: nueve columnas no caben (regla móvil), así que se elige el rol y se
 * ve su lista de permisos.
 */
export function RolesSettings() {
  const toast = useToast()
  const catalog = usePermissionsCatalog()
  const saved = useRolePermissions()
  const setPerms = useSetRolePermissions()
  const [draft, setDraft] = useState<Draft>({})
  const [mobileRole, setMobileRole] = useState<MemberRole>('admin')
  const [savingRole, setSavingRole] = useState<MemberRole | null>(null)

  const groups = useMemo(() => {
    const by = new Map<string, Permission[]>()
    for (const p of catalog.data ?? []) {
      const list = by.get(p.module) ?? []
      list.push(p)
      by.set(p.module, list)
    }
    return [...by.entries()].sort(
      (a, b) => (GROUP_ORDER.indexOf(a[0]) + 1 || 99) - (GROUP_ORDER.indexOf(b[0]) + 1 || 99),
    )
  }, [catalog.data])

  if (catalog.isLoading || saved.isLoading) return <PageLoader label="Cargando permisos…" />
  if (catalog.isError || saved.isError) {
    return (
      <Card>
        <LoadError
          error={catalog.error ?? saved.error}
          onRetry={() => {
            catalog.refetch()
            saved.refetch()
          }}
          what="los permisos"
        />
      </Card>
    )
  }

  const current = (r: MemberRole): string[] => draft[r] ?? saved.data?.[r] ?? []
  const has = (r: MemberRole, perm: string) => current(r).includes(perm)
  const isDirty = (r: MemberRole) => {
    if (!draft[r]) return false
    const a = new Set(draft[r])
    const b = new Set(saved.data?.[r] ?? [])
    return a.size !== b.size || [...a].some((x) => !b.has(x))
  }

  const toggle = (r: MemberRole, perm: string, on: boolean) =>
    setDraft((prev) => {
      const base = prev[r] ?? saved.data?.[r] ?? []
      return { ...prev, [r]: on ? [...base.filter((x) => x !== perm), perm] : base.filter((x) => x !== perm) }
    })

  const discard = (r: MemberRole) =>
    setDraft((prev) => {
      const next = { ...prev }
      delete next[r]
      return next
    })

  const save = async (r: MemberRole) => {
    setSavingRole(r)
    try {
      await setPerms.mutateAsync({ role: r, permissions: current(r) })
      discard(r)
      toast.success(`Permisos de ${ROLE_LABEL[r]} guardados.`)
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudieron guardar los permisos'))
    } finally {
      setSavingRole(null)
    }
  }

  const dirtyRoles = EDITABLE_ROLES.filter(isDirty)

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-600">
        <Crown className="mt-0.5 h-4 w-4 shrink-0 text-accent-500" />
        <span>
          El <strong>Propietario</strong> siempre tiene todos los permisos. Los cambios valen para
          todas las personas con ese rol desde su siguiente acción.
        </span>
      </div>

      {/* ── Escritorio: matriz ── */}
      <Card className="hidden lg:block">
        <CardHeader
          title="Permisos por rol"
          subtitle={dirtyRoles.length ? `Cambios sin guardar en: ${dirtyRoles.map((r) => ROLE_LABEL[r]).join(', ')}` : 'Marca lo que puede hacer cada rol'}
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-slate-100 text-xs text-slate-500">
                <th className="px-4 py-3 text-left font-medium">Permiso</th>
                {EDITABLE_ROLES.map((r) => (
                  <th key={r} className="w-20 px-1 py-3 text-center font-medium leading-tight">
                    {ROLE_LABEL[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map(([mod, perms]) => (
                <GroupRows key={mod} label={GROUP_LABEL[mod] ?? mod} perms={perms} has={has} toggle={toggle} />
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50/60">
                <td className="px-4 py-3 text-xs text-slate-500">Guardar cada rol</td>
                {EDITABLE_ROLES.map((r) => (
                  <td key={r} className="px-1 py-3 text-center">
                    <Button
                      size="icon"
                      variant={isDirty(r) ? 'primary' : 'ghost'}
                      disabled={!isDirty(r)}
                      loading={savingRole === r}
                      onClick={() => void save(r)}
                      aria-label={`Guardar permisos de ${ROLE_LABEL[r]}`}
                      title={`Guardar ${ROLE_LABEL[r]}`}
                    >
                      <Save className="h-4 w-4" />
                    </Button>
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      {/* ── Teléfono: un rol a la vez ── */}
      <Card className="lg:hidden">
        <CardHeader title="Permisos por rol" />
        <CardBody className="space-y-4">
          <Field label="Rol">
            <Select value={mobileRole} onChange={(e) => setMobileRole(e.target.value as MemberRole)}>
              {EDITABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}{isDirty(r) ? ' • sin guardar' : ''}
                </option>
              ))}
            </Select>
          </Field>
          {groups.map(([mod, perms]) => (
            <div key={mod}>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">{GROUP_LABEL[mod] ?? mod}</p>
              <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                {perms.map((p) => (
                  <label key={p.code} className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={has(mobileRole, p.code)}
                      onChange={(e) => toggle(mobileRole, p.code, e.target.checked)}
                      className="h-4 w-4 shrink-0 rounded border-slate-300 text-brand-600"
                    />
                    <span className="min-w-0 flex-1 text-sm text-slate-700">{p.label}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
          {/* Barra fija abajo mientras haya cambios: en una lista larga el botón
              de guardar quedaría a varias pantallas de distancia. */}
          <div className="sticky bottom-3 flex justify-end gap-2 rounded-xl bg-white/90 p-2 shadow-card backdrop-blur">
            {isDirty(mobileRole) && <Badge tone="amber" className="mr-auto self-center">Sin guardar</Badge>}
            <Button variant="outline" size="sm" disabled={!isDirty(mobileRole)} onClick={() => discard(mobileRole)}>
              <RotateCcw className="h-4 w-4" /> Descartar
            </Button>
            <Button size="sm" disabled={!isDirty(mobileRole)} loading={savingRole === mobileRole} onClick={() => void save(mobileRole)}>
              <Save className="h-4 w-4" /> Guardar
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

function GroupRows({
  label,
  perms,
  has,
  toggle,
}: {
  label: string
  perms: Permission[]
  has: (r: MemberRole, perm: string) => boolean
  toggle: (r: MemberRole, perm: string, on: boolean) => void
}) {
  return (
    <>
      <tr className="bg-slate-50">
        <td colSpan={EDITABLE_ROLES.length + 1} className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {label}
        </td>
      </tr>
      {perms.map((p) => (
        <tr key={p.code} className="border-b border-slate-50 hover:bg-brand-50/30">
          <td className="px-4 py-2 text-slate-700">{p.label}</td>
          {EDITABLE_ROLES.map((r) => (
            <td key={r} className="px-1 py-2 text-center">
              <input
                type="checkbox"
                checked={has(r, p.code)}
                onChange={(e) => toggle(r, p.code, e.target.checked)}
                aria-label={`${ROLE_LABEL[r]}: ${p.label}`}
                className="h-4 w-4 rounded border-slate-300 text-brand-600"
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}
