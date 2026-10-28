import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { format, subDays } from 'date-fns'
import { ClipboardList, PackageCheck, Plus, Search, ShoppingCart } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { PageHeader } from '@/components/PageHeader'
import { RequireAccess } from '@/components/RequireAccess'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Field, Input } from '@/components/ui/Input'
import { Pagination, paginate } from '@/components/ui/Pagination'
import { Select } from '@/components/ui/Select'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useBranches, useSuppliers } from '@/hooks/core'
import { PARTIAL_RECEIPT_STATUS, purchaseStatusInfo, usePurchases } from '@/hooks/purchases'
import { errorMessage } from '@/lib/errors'
import { fmtDateShort, money, norm } from '@/lib/format'
import { PURCHASE_STATUS } from '@/lib/labels'
import type { PurchaseStatus } from '@/types/erp'
import { todayIso } from '@/features/receivables/paymentShared'

/** 'partial' no es un estado de la base: 'ordered' con algo ya recibido. */
type StatusFilter = PurchaseStatus | 'partial' | 'all'
const PAGE_SIZE = 25

export function PurchasesPage() {
  return (
    <RequireAccess module="purchases" perm="purchases.manage">
      <PurchasesContent />
    </RequireAccess>
  )
}

function PurchasesContent() {
  const navigate = useNavigate()
  const { tenant } = useAuth()
  const currency = tenant?.currency ?? 'DOP'
  const [from, setFrom] = useState(() => format(subDays(new Date(), 90), 'yyyy-MM-dd'))
  const [to, setTo] = useState(todayIso)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)

  const purchases = usePurchases(from, to)
  const suppliers = useSuppliers()
  const branches = useBranches()
  const supplierName = useMemo(() => new Map((suppliers.data ?? []).map((s) => [s.id, s.name])), [suppliers.data])
  const branchName = useMemo(() => new Map((branches.data ?? []).map((b) => [b.id, b.name])), [branches.data])
  const multiBranch = (branches.data ?? []).length > 1

  const rows = useMemo(() => {
    const q = norm(search)
    return (purchases.data ?? []).filter((p) => {
      if (status === 'partial') {
        if (!p.partially_received) return false
      } else if (status !== 'all' && p.status !== status) return false
      if (!q) return true
      return (
        norm(p.number).includes(q) ||
        norm(supplierName.get(p.supplier_id)).includes(q) ||
        norm(p.supplier_invoice).includes(q) ||
        norm(p.supplier_ncf).includes(q)
      )
    })
  }, [purchases.data, status, search, supplierName])
  const { slice, safePage } = paginate(rows, page, PAGE_SIZE)

  const valid = rows.filter((p) => p.status !== 'canceled')
  const totalAmount = valid.reduce((s, p) => s + p.total, 0)
  const pending = rows.filter((p) => p.status === 'draft' || p.status === 'ordered')
  const received = rows.filter((p) => p.status === 'received')

  return (
    <div>
      <PageHeader
        title="Compras"
        description="Órdenes a proveedores y recepción de mercancía."
        action={
          <Button onClick={() => navigate('/compras/nueva')}>
            <Plus className="h-4 w-4" /> Nueva compra
          </Button>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Desde">
          <Input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </Field>
        <Field label="Hasta">
          <Input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </Field>
        <Field label="Estado">
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as StatusFilter)
              setPage(0)
            }}
          >
            <option value="all">Todos</option>
            {(Object.keys(PURCHASE_STATUS) as PurchaseStatus[]).map((s) => (
              <option key={s} value={s}>
                {PURCHASE_STATUS[s].label}
              </option>
            ))}
            <option value="partial">{PARTIAL_RECEIPT_STATUS.label}</option>
          </Select>
        </Field>
        <Field label="Buscar">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(0)
              }}
              placeholder="Nº, proveedor, factura o NCF"
              className="pl-9"
            />
          </div>
        </Field>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard
          label="Total comprado"
          value={money(totalAmount, currency)}
          icon={<ShoppingCart className="h-5 w-5" />}
          hint={`${valid.length} compras (sin canceladas)`}
        />
        <StatCard
          label="Por recibir"
          value={pending.length}
          icon={<ClipboardList className="h-5 w-5" />}
          tone="amber"
          hint={money(pending.reduce((s, p) => s + p.total, 0), currency)}
        />
        <StatCard
          label="Recibidas"
          value={received.length}
          icon={<PackageCheck className="h-5 w-5" />}
          tone="green"
          hint={money(received.reduce((s, p) => s + p.total, 0), currency)}
          className="col-span-2 lg:col-span-1"
        />
      </div>

      {purchases.isLoading ? (
        <PageLoader label="Cargando compras…" />
      ) : purchases.isError ? (
        <EmptyState
          icon={<ShoppingCart className="h-6 w-6" />}
          title="No se pudieron cargar las compras"
          description={errorMessage(purchases.error)}
          action={<Button onClick={() => purchases.refetch()}>Reintentar</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ShoppingCart className="h-6 w-6" />}
          title="No hay compras en este periodo"
          description="Registra una compra para darle entrada a la mercancía y llevar lo que debes a tus proveedores."
          action={
            <Button onClick={() => navigate('/compras/nueva')}>
              <Plus className="h-4 w-4" /> Nueva compra
            </Button>
          }
        />
      ) : (
        <Card>
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3 font-medium">Compra</th>
                  <th className="px-4 py-3 font-medium">Fecha</th>
                  <th className="px-4 py-3 font-medium">Proveedor</th>
                  {multiBranch && <th className="px-4 py-3 font-medium">Sucursal</th>}
                  <th className="px-4 py-3 font-medium">Factura / NCF</th>
                  <th className="px-4 py-3 font-medium">Estado</th>
                  <th className="px-4 py-3 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {slice.map((p) => (
                  <tr key={p.id} onClick={() => navigate(`/compras/${p.id}`)} className="cursor-pointer hover:bg-slate-50/60">
                    <td className="px-4 py-3 font-medium text-slate-800">{p.number}</td>
                    <td className="px-4 py-3 text-slate-600">{fmtDateShort(p.order_date)}</td>
                    <td className="px-4 py-3 text-slate-700">{supplierName.get(p.supplier_id) ?? '—'}</td>
                    {multiBranch && <td className="px-4 py-3 text-slate-600">{branchName.get(p.branch_id) ?? '—'}</td>}
                    <td className="px-4 py-3 text-slate-600">
                      {[p.supplier_invoice, p.supplier_ncf].filter(Boolean).join(' · ') || '—'}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={p.status} partial={p.partially_received} />
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(p.total, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DataList>
            {slice.map((p) => (
              <DataRow
                key={p.id}
                title={`${p.number} · ${supplierName.get(p.supplier_id) ?? ''}`}
                titleExtra={fmtDateShort(p.order_date)}
                onClick={() => navigate(`/compras/${p.id}`)}
                badges={<StatusBadge status={p.status} partial={p.partially_received} />}
                actions={
                  <Button size="sm" variant="ghost" onClick={() => navigate(`/compras/${p.id}`)}>
                    Abrir
                  </Button>
                }
              >
                <DataFields>
                  <DataField label="Total">{money(p.total, currency)}</DataField>
                  <DataField label="Factura">{p.supplier_invoice ?? p.supplier_ncf ?? '—'}</DataField>
                </DataFields>
              </DataRow>
            ))}
          </DataList>
          <Pagination page={safePage} pageSize={PAGE_SIZE} total={rows.length} onPage={setPage} label="compras" />
        </Card>
      )}
    </div>
  )
}

function StatusBadge({ status, partial }: { status: PurchaseStatus; partial: boolean }) {
  const info = purchaseStatusInfo(status, partial)
  return <Badge tone={info.tone}>{info.label}</Badge>
}
