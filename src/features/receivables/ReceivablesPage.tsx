import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AlertTriangle, Banknote, CalendarClock, HandCoins, Search, Users } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { PageHeader } from '@/components/PageHeader'
import { RequireAccess } from '@/components/RequireAccess'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Input } from '@/components/ui/Input'
import { Pagination, paginate } from '@/components/ui/Pagination'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState, PageLoader, Spinner } from '@/components/ui/misc'
import { useCustomers } from '@/hooks/core'
import { useOpenReceivables, useReceivablesAging } from '@/hooks/receivables'
import { errorMessage } from '@/lib/errors'
import { fmtDate, fmtDateShort, money, norm } from '@/lib/format'
import type { AgingRow, Receivable } from '@/types/erp'
import { ReceivePaymentModal } from './ReceivePaymentModal'
import { daysOverdue, round2 } from './paymentShared'

const PAGE_SIZE = 30

const AGING_COLS: { key: keyof Pick<AgingRow, 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus'>; label: string }[] = [
  { key: 'current', label: 'Al día' },
  { key: 'd1_30', label: '1–30' },
  { key: 'd31_60', label: '31–60' },
  { key: 'd61_90', label: '61–90' },
  { key: 'd90_plus', label: '+90' },
]

const balanceOf = (r: Receivable) => round2(r.amount - r.paid_amount)

export function ReceivablesPage() {
  return (
    <RequireAccess module="credit" perm="receivables.manage">
      <ReceivablesContent />
    </RequireAccess>
  )
}

function ReceivablesContent() {
  const { tenant } = useAuth()
  const navigate = useNavigate()
  const currency = tenant?.currency ?? 'DOP'
  const receivables = useOpenReceivables()
  const aging = useReceivablesAging()
  const customers = useCustomers()

  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [pay, setPay] = useState<{ customerId: string; receivableId?: string } | null>(null)

  const customerName = useMemo(
    () => new Map((customers.data ?? []).map((c) => [c.id, c.name])),
    [customers.data],
  )
  const nameOf = (id: string) => customerName.get(id) ?? 'Cliente'

  const all = receivables.data ?? []
  const rows = useMemo(() => {
    const q = norm(search)
    if (!q) return all
    return all.filter((r) => norm(customerName.get(r.customer_id)).includes(q) || norm(r.description).includes(q))
  }, [all, search, customerName])
  const { slice, safePage } = paginate(rows, page, PAGE_SIZE)

  const total = round2(all.reduce((s, r) => s + balanceOf(r), 0))
  const overdue = round2(all.filter((r) => daysOverdue(r.due_date) > 0).reduce((s, r) => s + balanceOf(r), 0))
  const debtors = new Set(all.map((r) => r.customer_id)).size

  const agingTotals = useMemo(() => {
    const t: Record<string, number> = { total: 0 }
    for (const row of aging.data ?? []) {
      t.total += row.total
      for (const col of AGING_COLS) t[col.key] = (t[col.key] ?? 0) + (row[col.key] ?? 0)
    }
    return t
  }, [aging.data])

  if (receivables.isLoading) return <PageLoader label="Cargando cuentas por cobrar…" />
  if (receivables.isError) {
    return (
      <EmptyState
        icon={<AlertTriangle className="h-6 w-6" />}
        title="No se pudieron cargar las cuentas"
        description={errorMessage(receivables.error)}
        action={<Button onClick={() => receivables.refetch()}>Reintentar</Button>}
      />
    )
  }

  const payCustomerRcv = pay ? all.filter((r) => r.customer_id === pay.customerId) : []

  return (
    <div>
      <PageHeader title="Cuentas por cobrar" description="Lo que te deben tus clientes, por antigüedad y vencimiento." />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Por cobrar" value={money(total, currency)} icon={<HandCoins className="h-5 w-5" />} />
        <StatCard
          label="Vencido"
          value={money(overdue, currency)}
          icon={<AlertTriangle className="h-5 w-5" />}
          tone={overdue > 0 ? 'red' : 'slate'}
        />
        <StatCard label="Clientes con saldo" value={debtors} icon={<Users className="h-5 w-5" />} tone="slate" />
        <StatCard label="Documentos" value={all.length} icon={<CalendarClock className="h-5 w-5" />} tone="slate" />
      </div>

      {all.length === 0 ? (
        <EmptyState
          icon={<HandCoins className="h-6 w-6" />}
          title="Nadie te debe nada"
          description="Las ventas a crédito del punto de venta aparecerán aquí hasta que se cobren."
        />
      ) : (
        <>
          <Card className="mb-5">
            <CardHeader title="Antigüedad de saldos" subtitle="Días de atraso desde el vencimiento." />
            {aging.isLoading ? (
              <div className="flex justify-center p-8"><Spinner /></div>
            ) : aging.isError ? (
              <p className="p-5 text-sm text-red-600">{errorMessage(aging.error)}</p>
            ) : (
              <>
                <div className="hidden overflow-x-auto lg:block">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                        <th className="px-4 py-3 font-medium">Cliente</th>
                        {AGING_COLS.map((c) => (
                          <th key={c.key} className="px-4 py-3 text-right font-medium">{c.label}</th>
                        ))}
                        <th className="px-4 py-3 text-right font-medium">Total</th>
                        <th className="px-4 py-3" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(aging.data ?? []).map((row) => (
                        <tr key={row.customer_id} className="hover:bg-slate-50/60">
                          <td className="px-4 py-3">
                            <Link to={`/clientes/${row.customer_id}`} className="font-medium text-slate-800 hover:text-brand-600">
                              {row.customer_name}
                            </Link>
                          </td>
                          {AGING_COLS.map((c) => (
                            <td
                              key={c.key}
                              className={
                                c.key !== 'current' && row[c.key]
                                  ? 'px-4 py-3 text-right tabular-nums text-red-600'
                                  : 'px-4 py-3 text-right tabular-nums text-slate-600'
                              }
                            >
                              {row[c.key] ? money(row[c.key], currency) : '—'}
                            </td>
                          ))}
                          <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(row.total, currency)}</td>
                          <td className="px-4 py-3 text-right">
                            <Button size="sm" variant="ghost" onClick={() => setPay({ customerId: row.customer_id })}>
                              Abonar
                            </Button>
                          </td>
                        </tr>
                      ))}
                      <tr className="bg-slate-50 font-semibold">
                        <td className="px-4 py-3 text-slate-700">Total</td>
                        {AGING_COLS.map((c) => (
                          <td key={c.key} className="px-4 py-3 text-right tabular-nums">
                            {money(agingTotals[c.key] ?? 0, currency)}
                          </td>
                        ))}
                        <td className="px-4 py-3 text-right tabular-nums">{money(agingTotals.total, currency)}</td>
                        <td />
                      </tr>
                    </tbody>
                  </table>
                </div>
                <DataList>
                  {(aging.data ?? []).map((row) => (
                    <DataRow
                      key={row.customer_id}
                      title={row.customer_name}
                      titleExtra={`Total ${money(row.total, currency)}`}
                      onClick={() => navigate(`/clientes/${row.customer_id}`)}
                      actions={
                        <ActionMenu
                          title={row.customer_name}
                          items={[
                            { label: 'Registrar abono', icon: <Banknote className="h-4 w-4" />, onClick: () => setPay({ customerId: row.customer_id }) },
                            { label: 'Ver estado de cuenta', onClick: () => navigate(`/clientes/${row.customer_id}`) },
                          ]}
                        />
                      }
                    >
                      <DataFields cols={3}>
                        {AGING_COLS.map((c) => (
                          <DataField key={c.key} label={c.label}>
                            {row[c.key] ? money(row[c.key], currency) : '—'}
                          </DataField>
                        ))}
                      </DataFields>
                    </DataRow>
                  ))}
                </DataList>
              </>
            )}
          </Card>

          <Card>
            <CardHeader title="Cuentas abiertas" subtitle="Las vencidas aparecen resaltadas." />
            <div className="border-b border-slate-100 p-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value)
                    setPage(0)
                  }}
                  placeholder="Buscar por cliente o concepto"
                  className="pl-9"
                />
              </div>
            </div>
            {rows.length === 0 ? (
              <p className="p-5 text-sm text-slate-500">Ninguna cuenta coincide con la búsqueda.</p>
            ) : (
              <>
                <div className="hidden overflow-x-auto lg:block">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                        <th className="px-4 py-3 font-medium">Cliente</th>
                        <th className="px-4 py-3 font-medium">Concepto</th>
                        <th className="px-4 py-3 font-medium">Vence</th>
                        <th className="px-4 py-3 text-right font-medium">Monto</th>
                        <th className="px-4 py-3 text-right font-medium">Pagado</th>
                        <th className="px-4 py-3 text-right font-medium">Saldo</th>
                        <th className="px-4 py-3" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {slice.map((r) => {
                        const late = daysOverdue(r.due_date)
                        return (
                          <tr key={r.id} className={late > 0 ? 'bg-red-50/40' : 'hover:bg-slate-50/60'}>
                            <td className="px-4 py-3">
                              <Link to={`/clientes/${r.customer_id}`} className="font-medium text-slate-800 hover:text-brand-600">
                                {nameOf(r.customer_id)}
                              </Link>
                            </td>
                            <td className="px-4 py-3 text-slate-600">
                              {r.sale_id ? (
                                <Link to={`/ventas/${r.sale_id}`} className="hover:text-brand-600">
                                  {r.description ?? 'Venta a crédito'}
                                </Link>
                              ) : (
                                r.description ?? 'Cuenta'
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <span className="text-slate-600">{fmtDateShort(r.due_date)}</span>
                              {late > 0 && <Badge tone="red" className="ml-2">{late} d vencida</Badge>}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">{money(r.amount, currency)}</td>
                            <td className="px-4 py-3 text-right tabular-nums text-slate-600">{money(r.paid_amount, currency)}</td>
                            <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(balanceOf(r), currency)}</td>
                            <td className="px-4 py-3 text-right">
                              <Button size="sm" variant="ghost" onClick={() => setPay({ customerId: r.customer_id, receivableId: r.id })}>
                                Abonar
                              </Button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <DataList>
                  {slice.map((r) => {
                    const late = daysOverdue(r.due_date)
                    return (
                      <DataRow
                        key={r.id}
                        title={nameOf(r.customer_id)}
                        titleExtra={r.description ?? undefined}
                        tone={late > 0 ? 'danger' : undefined}
                        badges={late > 0 ? <Badge tone="red">{late} d vencida</Badge> : undefined}
                        actions={
                          <ActionMenu
                            title={nameOf(r.customer_id)}
                            items={[
                              {
                                label: 'Abonar a esta cuenta',
                                icon: <Banknote className="h-4 w-4" />,
                                onClick: () => setPay({ customerId: r.customer_id, receivableId: r.id }),
                              },
                              { label: 'Ver estado de cuenta', onClick: () => navigate(`/clientes/${r.customer_id}`) },
                            ]}
                          />
                        }
                      >
                        <DataFields>
                          <DataField label="Vence">{fmtDate(r.due_date)}</DataField>
                          <DataField label="Saldo">{money(balanceOf(r), currency)}</DataField>
                        </DataFields>
                      </DataRow>
                    )
                  })}
                </DataList>
                <Pagination page={safePage} pageSize={PAGE_SIZE} total={rows.length} onPage={setPage} label="cuentas" />
              </>
            )}
          </Card>
        </>
      )}

      {pay && (
        <ReceivePaymentModal
          open
          onClose={() => setPay(null)}
          customerId={pay.customerId}
          customerName={nameOf(pay.customerId)}
          receivables={payCustomerRcv}
          receivableId={pay.receivableId}
        />
      )}
    </div>
  )
}
