import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { History, Search } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { Badge } from '@/components/ui/Badge'
import { Card, CardHeader } from '@/components/ui/Card'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Input } from '@/components/ui/Input'
import { Pagination, usePaged } from '@/components/ui/Pagination'
import { Select } from '@/components/ui/Select'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { errorMessage } from '@/lib/errors'
import { fmtDateTime } from '@/lib/format'
import { AUDIT_LIMIT, useAdminAuditLog } from '@/hooks/admin'
import { AUDIT_CATEGORY_LABEL, auditAction, auditDetail, type AuditCategory } from './audit'

const CATEGORIES = Object.entries(AUDIT_CATEGORY_LABEL) as [AuditCategory, string][]

/**
 * Bitácora de lo que hicieron los super-admins (`platform_audit_logs`, 0028).
 *
 * Con `tenantId` es la «actividad del panel» de un negocio: sin columna de
 * negocio ni buscador, porque todo es del mismo. Sin él es la bitácora general,
 * con filtro por categoría y búsqueda por negocio, autor o detalle.
 */
export function AuditLogCard({ tenantId, className }: { tenantId?: string; className?: string }) {
  const { plans } = useAuth()
  const log = useAdminAuditLog(tenantId)
  const [category, setCategory] = useState<AuditCategory | ''>('')
  const [query, setQuery] = useState('')
  const scoped = Boolean(tenantId)

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (log.data ?? []).filter((r) => {
      if (category && auditAction(r).category !== category) return false
      if (!q) return true
      return [r.tenant_name, r.actor_email, auditAction(r).label, auditDetail(r, plans)]
        .some((v) => (v ?? '').toLowerCase().includes(q))
    })
  }, [log.data, category, query, plans])
  const paged = usePaged(rows)

  const filtered = Boolean(category || query.trim())
  // Un negocio borrado ya no tiene ficha: se enseña su nombre sin enlace.
  const deleted = useMemo(
    () => new Set((log.data ?? []).filter((r) => r.action === 'tenant.delete').map((r) => r.tenant_id)),
    [log.data],
  )
  const tenantCell = (id: string | null, name: string | null) =>
    id && !deleted.has(id) ? (
      <Link to={`/admin/negocio/${id}`} className="font-medium text-slate-700 hover:text-brand-600">
        {name ?? 'Negocio'}
      </Link>
    ) : (
      <span className="text-slate-500">{name ?? '—'}</span>
    )

  return (
    <Card className={className}>
      <CardHeader
        title={scoped ? 'Actividad del panel' : 'Bitácora del panel'}
        subtitle={
          scoped
            ? 'Lo que hicieron los super-admins con este negocio, accesos de soporte incluidos.'
            : `Quién hizo qué desde el panel. Las ${AUDIT_LIMIT} acciones más recientes.`
        }
      />
      {!scoped && (
        <div className="flex flex-col gap-2 border-b border-slate-100 px-4 pb-4 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                paged.reset()
              }}
              className="pl-9"
              placeholder="Buscar por negocio, autor o detalle…"
            />
          </div>
          <Select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value as AuditCategory | '')
              paged.reset()
            }}
            aria-label="Tipo de acción"
            className="sm:w-56"
          >
            <option value="">Todas las acciones</option>
            {CATEGORIES.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </Select>
        </div>
      )}

      {log.isLoading ? (
        <PageLoader label="Cargando bitácora…" />
      ) : log.isError ? (
        <p className="p-6 text-center text-sm text-red-600">{errorMessage(log.error, 'No se pudo cargar la bitácora.')}</p>
      ) : rows.length === 0 ? (
        <EmptyState
          className="m-5"
          icon={<History className="h-5 w-5" />}
          title={filtered ? 'Sin resultados' : 'Sin actividad registrada'}
          description={filtered ? 'Prueba con otro filtro.' : 'Las acciones del panel aparecerán aquí a partir de ahora.'}
        />
      ) : (
        <>
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3 font-medium">Fecha</th>
                  <th className="px-4 py-3 font-medium">Acción</th>
                  {!scoped && <th className="px-4 py-3 font-medium">Negocio</th>}
                  <th className="px-4 py-3 font-medium">Detalle</th>
                  <th className="px-4 py-3 font-medium">Autor</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {paged.slice.map((r) => {
                  const a = auditAction(r)
                  return (
                    <tr key={r.id} className="align-top">
                      <td className="whitespace-nowrap px-4 py-3 text-slate-500">{fmtDateTime(r.created_at)}</td>
                      <td className="whitespace-nowrap px-4 py-3"><Badge tone={a.tone}>{a.label}</Badge></td>
                      {!scoped && <td className="px-4 py-3">{tenantCell(r.tenant_id, r.tenant_name)}</td>}
                      <td className="max-w-md px-4 py-3 text-slate-600">{auditDetail(r, plans) || '—'}</td>
                      <td className="px-4 py-3 text-slate-500">{r.actor_email ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <DataList>
            {paged.slice.map((r) => {
              const a = auditAction(r)
              return (
                <DataRow
                  key={r.id}
                  title={a.label}
                  titleExtra={fmtDateTime(r.created_at)}
                  badges={!scoped && r.tenant_name ? <Badge>{r.tenant_name}</Badge> : undefined}
                >
                  <DataFields>
                    {auditDetail(r, plans) && (
                      <DataField label="Detalle" wrap className="col-span-2">{auditDetail(r, plans)}</DataField>
                    )}
                    <DataField label="Autor" wrap className="col-span-2">{r.actor_email ?? '—'}</DataField>
                  </DataFields>
                </DataRow>
              )
            })}
          </DataList>
          <Pagination {...paged.pager} label="acciones" />
        </>
      )}
    </Card>
  )
}
