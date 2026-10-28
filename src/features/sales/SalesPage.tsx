import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { addDays, format, parseISO, startOfDay, startOfMonth, subDays, subMonths } from 'date-fns'
import { Eye, Receipt, Search, ShoppingCart } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { RequireAccess } from '@/components/RequireAccess'
import { PageHeader } from '@/components/PageHeader'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Field, Input } from '@/components/ui/Input'
import { Pagination, paginate } from '@/components/ui/Pagination'
import { Select } from '@/components/ui/Select'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useBranches, useCustomers } from '@/hooks/core'
import { useMemberNames } from '@/hooks/team'
import { useSales, type SaleListRow, type SalesFilters } from '@/hooks/sales'
import { errorMessage } from '@/lib/errors'
import { fmtDateTime, money, num } from '@/lib/format'
import { SALE_STATUS } from '@/lib/labels'
import type { SaleStatus } from '@/types/erp'

/*
 * Listado de ventas. El filtro de fechas va al servidor (es lo que acota el
 * volumen); la búsqueda por número o cliente se hace aquí sobre lo ya traído,
 * para responder al teclear sin una vuelta de red por letra.
 */

export function SalesPage() {
  return (
    <RequireAccess module="pos">
      <SalesScreen />
    </RequireAccess>
  )
}

type Preset = 'today' | 'yesterday' | '7d' | 'month' | 'prev_month' | 'range'

const PRESET_LABEL: Record<Preset, string> = {
  today: 'Hoy',
  yesterday: 'Ayer',
  '7d': 'Últimos 7 días',
  month: 'Este mes',
  prev_month: 'Mes anterior',
  range: 'Rango de fechas',
}

const ymd = (d: Date) => format(d, 'yyyy-MM-dd')

/**
 * Rango [desde, hasta) en hora LOCAL convertido a ISO. El "hasta" es el
 * inicio del día siguiente: con `<= 23:59:59` se perderían las ventas del
 * último segundo, y con fechas sin hora Postgres compara contra medianoche UTC.
 */
function rangeFor(preset: Preset, from: string, to: string): { from: Date; to: Date } {
  const today = startOfDay(new Date())
  switch (preset) {
    case 'today':
      return { from: today, to: addDays(today, 1) }
    case 'yesterday':
      return { from: subDays(today, 1), to: today }
    case '7d':
      return { from: subDays(today, 6), to: addDays(today, 1) }
    case 'month':
      return { from: startOfMonth(today), to: addDays(today, 1) }
    case 'prev_month': {
      const start = startOfMonth(subMonths(today, 1))
      return { from: start, to: startOfMonth(today) }
    }
    case 'range': {
      const f = from ? startOfDay(parseISO(from)) : today
      const t = to ? startOfDay(parseISO(to)) : f
      return t < f ? { from: t, to: addDays(f, 1) } : { from: f, to: addDays(t, 1) }
    }
  }
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

const PAGE_SIZE = 25

function SalesScreen() {
  const { tenant, can } = useAuth()
  const navigate = useNavigate()
  const branches = useBranches()
  const customers = useCustomers()
  const names = useMemberNames()
  const currency = tenant?.currency ?? 'DOP'
  const m = (n: number) => money(n, currency)

  const [preset, setPreset] = useState<Preset>('today')
  const [fromDate, setFromDate] = useState(() => ymd(new Date()))
  const [toDate, setToDate] = useState(() => ymd(new Date()))
  const [status, setStatus] = useState<SaleStatus | ''>('')
  const [branchId, setBranchId] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)

  const range = rangeFor(preset, fromDate, toDate)
  const filters: SalesFilters = {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    status,
    branchId,
  }
  const sales = useSales(filters)

  const customerName = useMemo(
    () => new Map((customers.data ?? []).map((c) => [c.id, c.name])),
    [customers.data],
  )
  const branchName = useMemo(() => new Map((branches.data ?? []).map((b) => [b.id, b.name])), [branches.data])

  const rows = useMemo(() => {
    const q = fold(search.trim())
    const list = sales.data ?? []
    if (!q) return list
    return list.filter(
      (s) =>
        fold(s.number).includes(q) || (s.customer_id ? fold(customerName.get(s.customer_id) ?? '').includes(q) : false),
    )
  }, [sales.data, search, customerName])

  const summary = useMemo(() => {
    const valid = rows.filter((s) => s.status !== 'voided')
    const total = valid.reduce((acc, s) => acc + s.total, 0)
    const returned = valid.reduce((acc, s) => acc + s.returned_total, 0)
    return {
      count: valid.length,
      voided: rows.length - valid.length,
      total,
      returned,
      net: total - returned,
    }
  }, [rows])

  const { slice, safePage } = paginate(rows, page, PAGE_SIZE)
  const open = (s: SaleListRow) => navigate(`/ventas/${s.id}`)
  const resetPage = () => setPage(0)

  const sellerOf = (s: SaleListRow) => {
    const id = s.seller_id ?? s.created_by
    return id ? (names[id] ?? '—') : '—'
  }

  return (
    <div>
      <PageHeader
        title="Ventas"
        description={can('sales.view_all') ? 'Todas las ventas de la empresa' : 'Tus ventas'}
        action={
          can('sales.create') ? (
            <Link to="/pos">
              <Button>
                <ShoppingCart className="h-4 w-4" /> Vender
              </Button>
            </Link>
          ) : undefined
        }
      />

      <Card className="mb-4">
        <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Período">
            <Select
              value={preset}
              onChange={(e) => {
                setPreset(e.target.value as Preset)
                resetPage()
              }}
            >
              {(Object.keys(PRESET_LABEL) as Preset[]).map((p) => (
                <option key={p} value={p}>
                  {PRESET_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
          {preset === 'range' && (
            <div className="grid grid-cols-2 gap-2 sm:col-span-2 lg:col-span-1">
              <Field label="Desde">
                <Input
                  type="date"
                  value={fromDate}
                  max={toDate || undefined}
                  onChange={(e) => {
                    setFromDate(e.target.value)
                    resetPage()
                  }}
                />
              </Field>
              <Field label="Hasta">
                <Input
                  type="date"
                  value={toDate}
                  min={fromDate || undefined}
                  onChange={(e) => {
                    setToDate(e.target.value)
                    resetPage()
                  }}
                />
              </Field>
            </div>
          )}
          <Field label="Estado">
            <Select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as SaleStatus | '')
                resetPage()
              }}
            >
              <option value="">Todos</option>
              {(Object.keys(SALE_STATUS) as SaleStatus[]).map((s) => (
                <option key={s} value={s}>
                  {SALE_STATUS[s].label}
                </option>
              ))}
            </Select>
          </Field>
          {(branches.data?.length ?? 0) > 1 && (
            <Field label="Sucursal">
              <Select
                value={branchId}
                onChange={(e) => {
                  setBranchId(e.target.value)
                  resetPage()
                }}
              >
                <option value="">Todas</option>
                {branches.data!.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Buscar" className={preset === 'range' ? 'sm:col-span-2 lg:col-span-1' : undefined}>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                className="pl-9"
                placeholder="Número o cliente"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  resetPage()
                }}
              />
            </div>
          </Field>
        </CardBody>
      </Card>

      {sales.isLoading ? (
        <PageLoader label="Cargando ventas…" />
      ) : sales.isError ? (
        <EmptyState
          icon={<Receipt className="h-6 w-6" />}
          title="No se pudieron cargar las ventas"
          description={errorMessage(sales.error)}
          action={
            <Button variant="outline" onClick={() => sales.refetch()}>
              Reintentar
            </Button>
          }
        />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Ventas"
              value={num(summary.count)}
              hint={summary.voided ? `${summary.voided} anulada(s) no cuentan` : PRESET_LABEL[preset]}
            />
            <StatCard label="Total vendido" value={m(summary.total)} tone="green" />
            <StatCard label="Devoluciones" value={m(summary.returned)} tone="amber" />
            <StatCard label="Neto" value={m(summary.net)} tone="brand" />
          </div>

          {rows.length === 0 ? (
            <EmptyState
              icon={<Receipt className="h-6 w-6" />}
              title="No hay ventas en este período"
              description="Cambia el período o los filtros para ver otras ventas."
            />
          ) : (
            <Card>
              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Número</th>
                      <th className="px-4 py-3">Fecha</th>
                      <th className="px-4 py-3">Cliente</th>
                      <th className="px-4 py-3">Vendedor</th>
                      {(branches.data?.length ?? 0) > 1 && <th className="px-4 py-3">Sucursal</th>}
                      <th className="px-4 py-3">Estado</th>
                      <th className="px-4 py-3 text-right">Total</th>
                      <th className="px-4 py-3 text-right">Devuelto</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {slice.map((s) => (
                      <tr
                        key={s.id}
                        onClick={() => open(s)}
                        className="cursor-pointer hover:bg-slate-50"
                      >
                        <td className="px-4 py-3 font-medium text-brand-700">
                          <Link to={`/ventas/${s.id}`} onClick={(e) => e.stopPropagation()}>
                            {s.number}
                          </Link>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-600">{fmtDateTime(s.created_at)}</td>
                        <td className="max-w-[14rem] truncate px-4 py-3 text-slate-700">
                          {s.customer_id ? (customerName.get(s.customer_id) ?? 'Cliente') : 'Consumidor final'}
                        </td>
                        <td className="max-w-[10rem] truncate px-4 py-3 text-slate-600">{sellerOf(s)}</td>
                        {(branches.data?.length ?? 0) > 1 && (
                          <td className="px-4 py-3 text-slate-600">{branchName.get(s.branch_id) ?? '—'}</td>
                        )}
                        <td className="px-4 py-3">
                          <SaleBadges row={s} />
                        </td>
                        <td className="px-4 py-3 text-right font-semibold tabular-nums">{m(s.total)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-500">
                          {s.returned_total > 0 ? m(s.returned_total) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <DataList>
                {slice.map((s) => (
                  <DataRow
                    key={s.id}
                    title={s.number}
                    subtitle={s.customer_id ? (customerName.get(s.customer_id) ?? 'Cliente') : 'Consumidor final'}
                    onClick={() => open(s)}
                    tone={s.status === 'voided' ? 'muted' : undefined}
                    badges={<SaleBadges row={s} />}
                    actions={
                      <ActionMenu
                        title={`Venta ${s.number}`}
                        items={[{ label: 'Ver detalle', icon: <Eye className="h-4 w-4" />, onClick: () => open(s) }]}
                      />
                    }
                  >
                    <DataFields>
                      <DataField label="Total">{m(s.total)}</DataField>
                      <DataField label="Fecha">{fmtDateTime(s.created_at)}</DataField>
                      <DataField label="Vendedor">{sellerOf(s)}</DataField>
                      <DataField label="Devuelto">{s.returned_total > 0 ? m(s.returned_total) : '—'}</DataField>
                    </DataFields>
                  </DataRow>
                ))}
              </DataList>

              <Pagination page={safePage} pageSize={PAGE_SIZE} total={rows.length} onPage={setPage} label="ventas" />
            </Card>
          )}
        </>
      )}
    </div>
  )
}

function SaleBadges({ row }: { row: SaleListRow }) {
  const st = SALE_STATUS[row.status]
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={st.tone}>{st.label}</Badge>
      {row.ecf_type && <Badge tone="brand">e-CF {row.ecf_type}</Badge>}
      {row.credit_amount > 0 && <Badge tone="amber">Crédito</Badge>}
    </span>
  )
}
