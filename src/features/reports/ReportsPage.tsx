import { useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, Download, Info, Package, Receipt, Scale, Wallet } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { useBranches } from '@/hooks/core'
import {
  PERIOD_LABEL,
  daysBetween,
  presetRange,
  useExpensesReport,
  useInventoryValuation,
  useSalesReport,
  useTaxReport,
  type DateRange,
  type PeriodPreset,
  type SalesGroup,
} from '@/hooks/reports'
import { RequireAccess } from '@/components/RequireAccess'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Segmented } from '@/components/ui/Segmented'
import { StatCard } from '@/components/ui/StatCard'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { EmptyState, Spinner } from '@/components/ui/misc'
import { DailySalesChart, BarList } from '@/features/reports/charts'
import { downloadCsv, toCsv } from '@/lib/csv'
import { fmtDate, money, num } from '@/lib/format'
import { errorMessage } from '@/lib/errors'
import { PAYMENT_METHOD_LABEL } from '@/lib/labels'
import { cn } from '@/lib/cn'
import type { PaymentMethod, ReportRow } from '@/types/erp'

export function ReportsPage() {
  return (
    <RequireAccess module="reports" perm="reports.view">
      <Reports />
    </RequireAccess>
  )
}

type Section = 'sales' | 'taxes' | 'expenses' | 'inventory'

const SECTIONS: { value: Section; label: string }[] = [
  { value: 'sales', label: 'Ventas' },
  { value: 'taxes', label: 'Impuestos' },
  { value: 'expenses', label: 'Gastos' },
  { value: 'inventory', label: 'Inventario' },
]

const PRESETS: PeriodPreset[] = ['today', 'yesterday', 'last7', 'month', 'prev_month', 'custom']

const DEFAULT_TZ = 'America/Santo_Domingo'

function Reports() {
  const { tenant } = useAuth()
  const tz = tenant?.timezone || DEFAULT_TZ
  const currency = tenant?.currency
  const branches = useBranches()

  const [preset, setPreset] = useState<PeriodPreset>('month')
  const [custom, setCustom] = useState<DateRange>(() => presetRange('month', tz))
  const [branchId, setBranchId] = useState<string>('')
  const [section, setSection] = useState<Section>('sales')

  const range = useMemo(() => (preset === 'custom' ? custom : presetRange(preset, tz)), [preset, custom, tz])
  // La base admite como mucho un año (report_sales); se avisa aquí en vez de
  // dejar que la RPC devuelva un error genérico.
  const rangeError = validateRange(range)
  const valid = rangeError === null
  const branch = branchId || null
  const branchName = branches.data?.find((b) => b.id === branchId)?.name
  const multiBranch = (branches.data?.length ?? 0) > 1

  return (
    <div>
      <PageHeader
        title="Reportes"
        description={`${fmtDate(range.from)} – ${fmtDate(range.to)}${branchName ? ` · ${branchName}` : ''}`}
      />

      <Card className="mb-4">
        <CardBody className="space-y-4">
          <Segmented
            label="Período"
            value={preset}
            onChange={setPreset}
            options={PRESETS.map((p) => ({ value: p, label: PERIOD_LABEL[p] }))}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {preset === 'custom' && (
              <>
                <Field label="Desde">
                  <Input
                    type="date"
                    value={custom.from}
                    max={custom.to || undefined}
                    onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                  />
                </Field>
                <Field label="Hasta">
                  <Input
                    type="date"
                    value={custom.to}
                    min={custom.from || undefined}
                    onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                  />
                </Field>
              </>
            )}
            {multiBranch && (
              <Field label="Sucursal" hint="Aplica a ventas e inventario.">
                <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                  <option value="">Todas las sucursales</option>
                  {branches.data?.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          {rangeError && (
            <p className="flex items-center gap-2 text-sm font-medium text-red-600">
              <AlertTriangle className="h-4 w-4" /> {rangeError}
            </p>
          )}
        </CardBody>
      </Card>

      <Segmented label="Sección" value={section} onChange={setSection} options={SECTIONS} className="mb-4" />

      {section === 'sales' && <SalesSection range={range} branch={branch} valid={valid} currency={currency} />}
      {section === 'taxes' && <TaxesSection range={range} valid={valid} currency={currency} branchSet={Boolean(branch)} />}
      {section === 'expenses' && (
        <ExpensesSection range={range} valid={valid} currency={currency} branchSet={Boolean(branch)} />
      )}
      {section === 'inventory' && <InventorySection branch={branch} currency={currency} />}

      <Criteria />
    </div>
  )
}

function validateRange(r: DateRange): string | null {
  if (!r.from || !r.to) return 'Elige las dos fechas.'
  if (r.to < r.from) return 'La fecha final es anterior a la inicial.'
  if (daysBetween(r.from, r.to).length > 370) return 'El rango máximo es de un año.'
  return null
}

// ── Piezas comunes ──────────────────────────────────────────────────────────

interface Column<T> {
  key: string
  label: string
  value: (row: T) => string | number
  render?: (row: T) => ReactNode
  align?: 'left' | 'right'
}

const ALIGN = { left: 'text-left', right: 'text-right' } as const

/**
 * Tabla exportable. En escritorio, tabla; por debajo de `lg`, lista de
 * tarjetas (regla móvil). El CSV exporta los valores CRUDOS (sin símbolo de
 * moneda) para que Excel los sume.
 */
function ReportTable<T>({
  title,
  subtitle,
  rows,
  columns,
  filename,
  rowKey,
  footer,
}: {
  title: string
  subtitle?: string
  rows: T[]
  columns: Column<T>[]
  filename: string
  rowKey: (row: T, i: number) => string
  footer?: ReactNode
}) {
  const [first, ...rest] = columns
  const exportCsv = () => {
    const raw = rows.map((r) => Object.fromEntries(columns.map((c) => [c.key, c.value(r)])))
    downloadCsv(filename, toCsv(raw, columns.map((c) => ({ key: c.key, label: c.label }))))
  }
  return (
    <Card>
      <CardHeader
        title={title}
        subtitle={subtitle}
        action={
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows.length}>
            <Download className="h-4 w-4" /> CSV
          </Button>
        }
      />
      {rows.length === 0 ? (
        <CardBody>
          <p className="text-center text-sm text-slate-500">Sin datos en este período.</p>
        </CardBody>
      ) : (
        <>
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  {columns.map((c) => (
                    <th key={c.key} className={cn('px-5 py-2.5 font-medium', ALIGN[c.align ?? 'left'])}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r, i) => (
                  <tr key={rowKey(r, i)} className="hover:bg-slate-50/60">
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={cn('px-5 py-2.5 text-slate-700', ALIGN[c.align ?? 'left'], c.align === 'right' && 'tabular-nums')}
                      >
                        {c.render ? c.render(r) : c.value(r)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DataList>
            {rows.map((r, i) => (
              <DataRow key={rowKey(r, i)} title={first.render ? first.render(r) : first.value(r)}>
                {rest.length > 0 && (
                  <DataFields>
                    {rest.map((c) => (
                      <DataField key={c.key} label={c.label}>
                        {c.render ? c.render(r) : c.value(r)}
                      </DataField>
                    ))}
                  </DataFields>
                )}
              </DataRow>
            ))}
          </DataList>
        </>
      )}
      {footer && <div className="border-t border-slate-100 px-5 py-3 text-sm">{footer}</div>}
    </Card>
  )
}

function Loading({ label }: { label: string }) {
  return (
    <Card>
      <CardBody className="flex items-center justify-center gap-3 py-10 text-sm text-slate-500">
        <Spinner /> {label}
      </CardBody>
    </Card>
  )
}

function ErrorCard({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Card>
      <CardBody className="space-y-3 text-center">
        <p className="text-sm text-red-600">{errorMessage(error, 'No se pudo cargar el reporte.')}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Reintentar
        </Button>
      </CardBody>
    </Card>
  )
}

const r2 = (v: number) => Math.round(v * 100) / 100

// ── Ventas ──────────────────────────────────────────────────────────────────

type Breakdown = Exclude<SalesGroup, 'day'>

const BREAKDOWNS: { value: Breakdown; label: string }[] = [
  { value: 'product', label: 'Producto' },
  { value: 'category', label: 'Categoría' },
  { value: 'seller', label: 'Vendedor' },
  { value: 'branch', label: 'Sucursal' },
  { value: 'method', label: 'Método de pago' },
]

const BREAKDOWN_NOTE: Partial<Record<Breakdown, string>> = {
  method: 'Suma de los pagos recibidos; no descuenta devoluciones.',
  product: 'Cantidades y montos netos de lo devuelto. Costo = costo promedio al vender.',
  category: 'Cantidades y montos netos de lo devuelto. Costo = costo promedio al vender.',
}

function methodLabel(key: string): string {
  return PAYMENT_METHOD_LABEL[key as PaymentMethod] ?? key
}

function SalesSection({
  range,
  branch,
  valid,
  currency,
}: {
  range: DateRange
  branch: string | null
  valid: boolean
  currency?: string
}) {
  const [group, setGroup] = useState<Breakdown>('product')
  const byDay = useSalesReport(range, 'day', branch, valid)
  // Solo se pide el desglose que se está mirando: cinco RPC a la vez por cada
  // cambio de fecha serían cinco vueltas para enseñar una tabla.
  const breakdown = useSalesReport(range, group, branch, valid)

  const series = useMemo(() => {
    const map = new Map((byDay.data ?? []).map((r) => [r.key, r]))
    return daysBetween(range.from, range.to).map((day) => ({
      day,
      total: map.get(day)?.total ?? 0,
      count: map.get(day)?.count ?? 0,
    }))
  }, [byDay.data, range.from, range.to])

  const totals = useMemo(() => {
    const rows = byDay.data ?? []
    const total = rows.reduce((s, r) => s + r.total, 0)
    const count = rows.reduce((s, r) => s + (r.count ?? 0), 0)
    return { total, count, avg: count ? total / count : 0, tax: rows.reduce((s, r) => s + (r.tax ?? 0), 0) }
  }, [byDay.data])

  if (!valid) return null

  const money2 = (v: number) => money(v, currency)
  const dayColumns: Column<ReportRow>[] = [
    { key: 'day', label: 'Día', value: (r) => r.key, render: (r) => fmtDate(r.key) },
    { key: 'count', label: 'Ventas', value: (r) => r.count ?? 0, align: 'right', render: (r) => num(r.count) },
    { key: 'discount', label: 'Descuentos', value: (r) => r2(r.discount ?? 0), align: 'right', render: (r) => money2(r.discount ?? 0) },
    { key: 'tax', label: 'ITBIS', value: (r) => r2(r.tax ?? 0), align: 'right', render: (r) => money2(r.tax ?? 0) },
    { key: 'total', label: 'Total', value: (r) => r2(r.total), align: 'right', render: (r) => money2(r.total) },
  ]

  const breakdownColumns: Record<Breakdown, Column<ReportRow>[]> = {
    product: [
      { key: 'key', label: 'Producto', value: (r) => r.key },
      { key: 'quantity', label: 'Cantidad', value: (r) => r.quantity ?? 0, align: 'right', render: (r) => num(r.quantity) },
      { key: 'total', label: 'Ventas', value: (r) => r2(r.total), align: 'right', render: (r) => money2(r.total) },
      { key: 'cost', label: 'Costo', value: (r) => r2(r.cost ?? 0), align: 'right', render: (r) => money2(r.cost ?? 0) },
    ],
    category: [
      { key: 'key', label: 'Categoría', value: (r) => r.key },
      { key: 'quantity', label: 'Cantidad', value: (r) => r.quantity ?? 0, align: 'right', render: (r) => num(r.quantity) },
      { key: 'total', label: 'Ventas', value: (r) => r2(r.total), align: 'right', render: (r) => money2(r.total) },
      { key: 'cost', label: 'Costo', value: (r) => r2(r.cost ?? 0), align: 'right', render: (r) => money2(r.cost ?? 0) },
    ],
    seller: [
      { key: 'key', label: 'Vendedor', value: (r) => r.key },
      { key: 'count', label: 'Ventas', value: (r) => r.count ?? 0, align: 'right', render: (r) => num(r.count) },
      { key: 'total', label: 'Total', value: (r) => r2(r.total), align: 'right', render: (r) => money2(r.total) },
    ],
    branch: [
      { key: 'key', label: 'Sucursal', value: (r) => r.key },
      { key: 'count', label: 'Ventas', value: (r) => r.count ?? 0, align: 'right', render: (r) => num(r.count) },
      { key: 'total', label: 'Total', value: (r) => r2(r.total), align: 'right', render: (r) => money2(r.total) },
    ],
    method: [
      { key: 'key', label: 'Método', value: (r) => methodLabel(r.key) },
      { key: 'count', label: 'Pagos', value: (r) => r.count ?? 0, align: 'right', render: (r) => num(r.count) },
      { key: 'total', label: 'Total', value: (r) => r2(r.total), align: 'right', render: (r) => money2(r.total) },
    ],
  }

  const breakdownLabel = BREAKDOWNS.find((b) => b.value === group)?.label ?? ''

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Ventas" value={money2(totals.total)} icon={<Wallet className="h-5 w-5" />} />
        <StatCard label="Transacciones" value={num(totals.count)} icon={<Receipt className="h-5 w-5" />} tone="slate" />
        <StatCard label="Ticket promedio" value={money2(totals.avg)} tone="green" icon={<Scale className="h-5 w-5" />} />
        <StatCard
          label="ITBIS en ventas"
          value={money2(totals.tax)}
          tone="slate"
          hint="Antes de devoluciones"
          icon={<Receipt className="h-5 w-5" />}
        />
      </div>

      {byDay.isLoading ? (
        <Loading label="Cargando ventas…" />
      ) : byDay.isError ? (
        <ErrorCard error={byDay.error} onRetry={() => void byDay.refetch()} />
      ) : (
        <>
          {series.length > 1 && (
            <Card>
              <CardHeader title="Ventas por día" subtitle="Total cobrado con ITBIS, neto de devoluciones" />
              <CardBody>
                <DailySalesChart data={series} currency={currency} />
              </CardBody>
            </Card>
          )}
          <ReportTable
            title="Detalle por día"
            rows={byDay.data ?? []}
            columns={dayColumns}
            filename={`ventas-por-dia_${range.from}_${range.to}`}
            rowKey={(r) => r.key}
          />
        </>
      )}

      <Card>
        <CardBody>
          <p className="mb-2 text-sm font-medium text-slate-700">Desglose por</p>
          <Select
            value={group}
            onChange={(e) => setGroup(e.target.value as Breakdown)}
            className="sm:max-w-xs"
            aria-label="Desglose de ventas"
          >
            {BREAKDOWNS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </Select>
        </CardBody>
      </Card>

      {breakdown.isLoading ? (
        <Loading label="Cargando desglose…" />
      ) : breakdown.isError ? (
        <ErrorCard error={breakdown.error} onRetry={() => void breakdown.refetch()} />
      ) : (
        <>
          {group === 'method' && (breakdown.data?.length ?? 0) > 0 && (
            <Card>
              <CardHeader title="Reparto por método de pago" />
              <CardBody>
                <BarList
                  rows={(breakdown.data ?? []).map((r) => ({ key: r.key, label: methodLabel(r.key), value: r.total }))}
                  format={money2}
                />
              </CardBody>
            </Card>
          )}
          <ReportTable
            title={`Ventas por ${breakdownLabel.toLowerCase()}`}
            subtitle={BREAKDOWN_NOTE[group]}
            rows={breakdown.data ?? []}
            columns={breakdownColumns[group]}
            filename={`ventas-por-${group}_${range.from}_${range.to}`}
            rowKey={(r, i) => `${r.key}-${i}`}
          />
        </>
      )}
    </div>
  )
}

// ── Impuestos ───────────────────────────────────────────────────────────────

/** sale_items.tax_rate es fracción (0.18); por si llegara en puntos, se respeta. */
function pct(rate: number): string {
  const p = rate <= 1 ? rate * 100 : rate
  return `${num(Math.round(p * 100) / 100)} %`
}

function BranchNote({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      Este reporte es de toda la empresa: el filtro de sucursal no se aplica aquí.
    </p>
  )
}

function TaxesSection({
  range,
  valid,
  currency,
  branchSet,
}: {
  range: DateRange
  valid: boolean
  currency?: string
  branchSet: boolean
}) {
  const q = useTaxReport(range, valid)
  if (!valid) return null
  if (q.isLoading) return <Loading label="Cargando impuestos…" />
  if (q.isError || !q.data) return <ErrorCard error={q.error} onRetry={() => void q.refetch()} />
  const t = q.data
  const m = (v: number) => money(v, currency)

  const lines = [
    { key: 'sales', label: 'ITBIS facturado en ventas', value: t.itbis_sales },
    { key: 'returns', label: '(−) ITBIS de devoluciones', value: -t.itbis_returns },
    { key: 'collected', label: 'ITBIS cobrado neto', value: t.itbis_collected },
    { key: 'purchases', label: 'ITBIS pagado en compras recibidas', value: t.itbis_purchases },
    { key: 'expenses', label: 'ITBIS pagado en gastos', value: t.itbis_expenses },
    { key: 'paid', label: 'ITBIS pagado total', value: t.itbis_paid },
    { key: 'difference', label: 'Diferencia (cobrado − pagado)', value: t.difference },
  ]

  return (
    <div className="space-y-4">
      <BranchNote show={branchSet} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label="ITBIS cobrado" value={m(t.itbis_collected)} hint="Ventas − devoluciones" icon={<Receipt className="h-5 w-5" />} />
        <StatCard label="ITBIS pagado" value={m(t.itbis_paid)} hint="Compras + gastos" tone="slate" icon={<Wallet className="h-5 w-5" />} />
        <StatCard
          label="Diferencia"
          value={m(t.difference)}
          tone={t.difference > 0 ? 'amber' : 'green'}
          hint={t.difference > 0 ? 'Cobrado mayor que pagado' : 'Pagado mayor o igual que cobrado'}
          icon={<Scale className="h-5 w-5" />}
          className="col-span-2 lg:col-span-1"
        />
      </div>
      <ReportTable
        title="ITBIS cobrado vs. pagado"
        subtitle="Guía para tu contador; no sustituye la declaración IT-1 ni sus ajustes."
        rows={lines}
        columns={[
          { key: 'label', label: 'Concepto', value: (r) => r.label },
          { key: 'value', label: 'Monto', value: (r) => r2(r.value), align: 'right', render: (r) => m(r.value) },
        ]}
        filename={`itbis_${range.from}_${range.to}`}
        rowKey={(r) => r.key}
      />
      <ReportTable
        title="ITBIS de ventas por tasa"
        subtitle="Base = subtotal sin ITBIS de las líneas vendidas (antes de devoluciones)."
        rows={t.by_rate}
        columns={[
          { key: 'rate', label: 'Tasa', value: (r) => pct(r.tax_rate) },
          { key: 'base', label: 'Base', value: (r) => r2(r.base), align: 'right', render: (r) => m(r.base) },
          { key: 'tax', label: 'ITBIS', value: (r) => r2(r.tax), align: 'right', render: (r) => m(r.tax) },
        ]}
        filename={`itbis-por-tasa_${range.from}_${range.to}`}
        rowKey={(r) => String(r.tax_rate)}
      />
    </div>
  )
}

// ── Gastos ──────────────────────────────────────────────────────────────────

function ExpensesSection({
  range,
  valid,
  currency,
  branchSet,
}: {
  range: DateRange
  valid: boolean
  currency?: string
  branchSet: boolean
}) {
  const q = useExpensesReport(range, valid)
  if (!valid) return null
  if (q.isLoading) return <Loading label="Cargando gastos…" />
  if (q.isError) return <ErrorCard error={q.error} onRetry={() => void q.refetch()} />
  const rows = q.data ?? []
  const m = (v: number) => money(v, currency)
  const total = rows.reduce((s, r) => s + r.total, 0)
  const tax = rows.reduce((s, r) => s + (r.tax ?? 0), 0)

  return (
    <div className="space-y-4">
      <BranchNote show={branchSet} />
      {rows.length > 0 && (
        <Card>
          <CardHeader title="Gastos por categoría" subtitle={`${m(total)} en total, sin anulados`} />
          <CardBody>
            <BarList rows={rows.map((r) => ({ key: r.key, label: r.key, value: r.total }))} format={m} />
          </CardBody>
        </Card>
      )}
      <ReportTable
        title="Detalle de gastos"
        rows={rows}
        columns={[
          { key: 'key', label: 'Categoría', value: (r) => r.key },
          { key: 'count', label: 'Gastos', value: (r) => r.count ?? 0, align: 'right', render: (r) => num(r.count) },
          { key: 'tax', label: 'ITBIS', value: (r) => r2(r.tax ?? 0), align: 'right', render: (r) => m(r.tax ?? 0) },
          { key: 'total', label: 'Total', value: (r) => r2(r.total), align: 'right', render: (r) => m(r.total) },
        ]}
        filename={`gastos_${range.from}_${range.to}`}
        rowKey={(r) => r.key}
        footer={
          rows.length > 0 && (
            <div className="flex justify-between font-semibold text-slate-800">
              <span>Total</span>
              <span className="tabular-nums">
                {m(total)} <span className="text-xs font-normal text-slate-500">(ITBIS {m(tax)})</span>
              </span>
            </div>
          )
        }
      />
    </div>
  )
}

// ── Inventario ──────────────────────────────────────────────────────────────

function InventorySection({ branch, currency }: { branch: string | null; currency?: string }) {
  const q = useInventoryValuation(branch)
  if (q.isLoading) return <Loading label="Calculando valoración…" />
  if (q.isError || !q.data) return <ErrorCard error={q.error} onRetry={() => void q.refetch()} />
  const v = q.data
  const m = (x: number) => money(x, currency)

  if (v.products === 0) {
    return (
      <EmptyState
        icon={<Package className="h-6 w-6" />}
        title="Sin existencias valorizables"
        description="Cuando registres entradas de inventario, aquí verás cuánto vale al costo y a precio de venta."
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label="Valor al costo" value={m(v.total_cost)} icon={<Wallet className="h-5 w-5" />} />
        <StatCard label="Valor a precio de venta" value={m(v.total_retail)} tone="green" icon={<Receipt className="h-5 w-5" />} />
        <StatCard
          label="Registros con existencia"
          value={num(v.products)}
          tone="slate"
          hint="Producto × sucursal con cantidad > 0"
          icon={<Package className="h-5 w-5" />}
          className="col-span-2 lg:col-span-1"
        />
      </div>
      <ReportTable
        title="Valoración por categoría"
        subtitle="Existencia actual × costo promedio vigente. Es una foto de hoy, no depende del período."
        rows={v.by_category}
        columns={[
          { key: 'category', label: 'Categoría', value: (r) => r.category },
          { key: 'cost', label: 'Al costo', value: (r) => r2(r.cost_value), align: 'right', render: (r) => m(r.cost_value) },
          { key: 'retail', label: 'A precio de venta', value: (r) => r2(r.retail_value), align: 'right', render: (r) => m(r.retail_value) },
          {
            key: 'potential',
            label: 'Diferencia potencial',
            value: (r) => r2(r.retail_value - r.cost_value),
            align: 'right',
            render: (r) => m(r.retail_value - r.cost_value),
          },
        ]}
        filename={`inventario-valorizado_${new Date().toISOString().slice(0, 10)}`}
        rowKey={(r) => r.category}
      />
    </div>
  )
}

// ── Criterios ───────────────────────────────────────────────────────────────

/** Cómo se calcula cada cifra. Sin esto, "ventas" y "margen" se leen como ganancia. */
function Criteria() {
  return (
    <Card className="mt-6">
      <CardHeader title="Cómo se calculan estas cifras" />
      <CardBody>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-600">
          <li>
            <strong>Ventas</strong> = total cobrado (con ITBIS) de las ventas no anuladas, menos las devoluciones.
          </li>
          <li>
            <strong>Margen bruto estimado</strong> = ventas sin ITBIS − costo de lo vendido (costo promedio al momento
            de la venta). No descuenta gastos: <strong>no es ganancia</strong>.
          </li>
          <li>
            <strong>ITBIS cobrado vs. pagado</strong> es una guía para tu contador; no sustituye la declaración IT-1.
          </li>
          <li>Los días se cortan en la zona horaria de la empresa, no en la de tu dispositivo.</li>
        </ul>
      </CardBody>
    </Card>
  )
}
