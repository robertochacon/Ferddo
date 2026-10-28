import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, FileText, Plus, Search, ShoppingBag } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { PageHeader } from '@/components/PageHeader'
import { RequireAccess } from '@/components/RequireAccess'
import { ActionMenu, type ActionItem } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Field, Input } from '@/components/ui/Input'
import { Pagination, paginate } from '@/components/ui/Pagination'
import { Select } from '@/components/ui/Select'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useCustomers } from '@/hooks/core'
import { useQuotations } from '@/hooks/quotations'
import { errorMessage } from '@/lib/errors'
import { fmtDateShort, money, norm } from '@/lib/format'
import { QUOTATION_STATUS } from '@/lib/labels'
import type { Quotation, QuotationStatus } from '@/types/erp'
import { effectiveStatus, isConvertible } from './quotationStatus'

const PAGE_SIZE = 25

export function QuotationsPage() {
  return (
    <RequireAccess module="quotations" perm="quotations.manage">
      <QuotationsContent />
    </RequireAccess>
  )
}

function QuotationsContent() {
  const navigate = useNavigate()
  const { tenant, can, hasModule } = useAuth()
  const currency = tenant?.currency ?? 'DOP'
  const quotations = useQuotations()
  const customers = useCustomers()
  const canSell = hasModule('pos') && can('sales.create')

  const [status, setStatus] = useState<QuotationStatus | 'all'>('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)

  const customerName = useMemo(() => new Map((customers.data ?? []).map((c) => [c.id, c.name])), [customers.data])
  const nameOf = (q: Quotation) => (q.customer_id ? (customerName.get(q.customer_id) ?? 'Cliente') : 'Sin cliente')

  const rows = useMemo(() => {
    const s = norm(search)
    return (quotations.data ?? []).filter((q) => {
      if (status !== 'all' && effectiveStatus(q) !== status) return false
      if (!s) return true
      return norm(q.number).includes(s) || norm(q.customer_id ? customerName.get(q.customer_id) : '').includes(s)
    })
  }, [quotations.data, status, search, customerName])
  const { slice, safePage } = paginate(rows, page, PAGE_SIZE)

  const all = quotations.data ?? []
  const open = all.filter((q) => ['draft', 'sent', 'accepted'].includes(effectiveStatus(q)))
  const converted = all.filter((q) => q.status === 'converted')

  const convert = (q: Quotation) => navigate('/pos', { state: { quotationId: q.id } })

  const actionsFor = (q: Quotation): ActionItem[] => {
    const items: ActionItem[] = [{ label: 'Abrir', icon: <FileText className="h-4 w-4" />, onClick: () => navigate(`/cotizaciones/${q.id}`) }]
    if (canSell) {
      items.push({
        label: 'Convertir en venta',
        icon: <ShoppingBag className="h-4 w-4" />,
        onClick: () => convert(q),
        disabled: !isConvertible(q),
        hint: isConvertible(q) ? 'Abre el punto de venta con estos productos' : 'Convertida, rechazada o vencida',
      })
    }
    return items
  }

  return (
    <div>
      <PageHeader
        title="Cotizaciones"
        description="Presupuestos para tus clientes que luego se cobran en el punto de venta."
        action={
          <Button onClick={() => navigate('/cotizaciones/nueva')}>
            <Plus className="h-4 w-4" /> Nueva cotización
          </Button>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard
          label="Abiertas"
          value={open.length}
          icon={<FileText className="h-5 w-5" />}
          hint={money(open.reduce((s, q) => s + q.total, 0), currency)}
        />
        <StatCard
          label="Aceptadas"
          value={all.filter((q) => effectiveStatus(q) === 'accepted').length}
          icon={<CheckCircle2 className="h-5 w-5" />}
          tone="green"
        />
        <StatCard
          label="Convertidas en venta"
          value={converted.length}
          icon={<ShoppingBag className="h-5 w-5" />}
          tone="slate"
          hint={money(converted.reduce((s, q) => s + q.total, 0), currency)}
          className="col-span-2 lg:col-span-1"
        />
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <Field label="Buscar">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(0)
              }}
              placeholder="Número o cliente"
              className="pl-9"
            />
          </div>
        </Field>
        <Field label="Estado">
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as QuotationStatus | 'all')
              setPage(0)
            }}
          >
            <option value="all">Todos</option>
            {(Object.keys(QUOTATION_STATUS) as QuotationStatus[]).map((s) => (
              <option key={s} value={s}>
                {QUOTATION_STATUS[s].label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {quotations.isLoading ? (
        <PageLoader label="Cargando cotizaciones…" />
      ) : quotations.isError ? (
        <EmptyState
          icon={<FileText className="h-6 w-6" />}
          title="No se pudieron cargar las cotizaciones"
          description={errorMessage(quotations.error)}
          action={<Button onClick={() => quotations.refetch()}>Reintentar</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-6 w-6" />}
          title={all.length ? 'Ninguna cotización coincide' : 'Aún no hay cotizaciones'}
          description={all.length ? 'Cambia la búsqueda o el filtro.' : 'Prepara un presupuesto, imprímelo o mándalo en PDF y conviértelo en venta cuando el cliente acepte.'}
          action={
            !all.length ? (
              <Button onClick={() => navigate('/cotizaciones/nueva')}>
                <Plus className="h-4 w-4" /> Nueva cotización
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3 font-medium">Cotización</th>
                  <th className="px-4 py-3 font-medium">Cliente</th>
                  <th className="px-4 py-3 font-medium">Fecha</th>
                  <th className="px-4 py-3 font-medium">Válida hasta</th>
                  <th className="px-4 py-3 font-medium">Estado</th>
                  <th className="px-4 py-3 text-right font-medium">Total</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {slice.map((q) => (
                  <tr key={q.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => navigate(`/cotizaciones/${q.id}`)}
                        className="font-medium text-slate-800 hover:text-brand-600"
                      >
                        {q.number}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{nameOf(q)}</td>
                    <td className="px-4 py-3 text-slate-600">{fmtDateShort(q.created_at)}</td>
                    <td className="px-4 py-3 text-slate-600">{fmtDateShort(q.valid_until)}</td>
                    <td className="px-4 py-3">
                      <StatusBadge q={q} />
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(q.total, currency)}</td>
                    <td className="px-4 py-3 text-right">
                      <ActionMenu items={actionsFor(q)} title={q.number} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DataList>
            {slice.map((q) => (
              <DataRow
                key={q.id}
                title={`${q.number} · ${nameOf(q)}`}
                titleExtra={`Válida hasta ${fmtDateShort(q.valid_until)}`}
                onClick={() => navigate(`/cotizaciones/${q.id}`)}
                badges={<StatusBadge q={q} />}
                actions={<ActionMenu items={actionsFor(q)} title={q.number} />}
              >
                <DataFields>
                  <DataField label="Total">{money(q.total, currency)}</DataField>
                  <DataField label="Fecha">{fmtDateShort(q.created_at)}</DataField>
                </DataFields>
              </DataRow>
            ))}
          </DataList>
          <Pagination page={safePage} pageSize={PAGE_SIZE} total={rows.length} onPage={setPage} label="cotizaciones" />
        </Card>
      )}
    </div>
  )
}

function StatusBadge({ q }: { q: Quotation }) {
  const s = QUOTATION_STATUS[effectiveStatus(q)]
  return <Badge tone={s.tone}>{s.label}</Badge>
}
