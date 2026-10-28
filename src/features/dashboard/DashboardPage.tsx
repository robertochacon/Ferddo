import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  BarChart3,
  Clock,
  FileSpreadsheet,
  HandCoins,
  PackageX,
  Receipt,
  Scale,
  ShoppingCart,
  TrendingUp,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { useDashboard } from '@/hooks/dashboard'
import { useBranches } from '@/hooks/core'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Select } from '@/components/ui/Select'
import { StatCard } from '@/components/ui/StatCard'
import { PageLoader } from '@/components/ui/misc'
import { DailySalesChart, BarList } from '@/features/reports/charts'
import { money, num } from '@/lib/format'
import { errorMessage } from '@/lib/errors'
import { cn } from '@/lib/cn'
import { ECF_STATUS, PAYMENT_METHOD_LABEL } from '@/lib/labels'
import type { ModuleCode } from '@/types/db'
import type { EcfStatus, PaymentMethod } from '@/types/erp'

/**
 * Inicio. Dos caras según el permiso:
 *   · Sin `reports.view` (cajero, vendedor…): accesos rápidos a lo que SÍ
 *     puede hacer. Pedir el tablero respondería FORBIDDEN, así que ni se pide.
 *   · Con `reports.view`: el tablero, todo de UNA llamada a
 *     `dashboard_summary(p_branch)` con las cifras ya agregadas en la base.
 */
export function DashboardPage() {
  const { profile, tenant, can } = useAuth()
  // Solo el primer nombre: en un teléfono, un nombre completo parte el saludo
  // en tres líneas.
  const firstName = profile?.full_name?.trim().split(/\s+/)[0]
  const title = firstName ? `¡Hola, ${firstName}!` : '¡Hola!'
  const showBoard = can('reports.view')

  return (
    <div>
      {showBoard ? (
        <Board title={title} tenantName={tenant?.name} />
      ) : (
        <>
          <PageHeader title={title} description={tenant?.name ? `Bienvenido a ${tenant.name}` : undefined} />
          <SubscriptionBanner />
          <QuickActions />
        </>
      )}
    </div>
  )
}

// ── Suscripción ─────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000

type BannerTone = 'info' | 'warn' | 'danger'

const BANNER_TONE: Record<BannerTone, string> = {
  info: 'border-brand-200 bg-brand-50 text-brand-800',
  warn: 'border-amber-200 bg-amber-50 text-amber-800',
  danger: 'border-red-200 bg-red-50 text-red-800',
}

function bannerFor(status: string, trialEndsAt: string | null): { tone: BannerTone; text: string } | null {
  if (status === 'past_due') return { tone: 'danger', text: 'Tu suscripción tiene un pago pendiente.' }
  if (status === 'canceled') return { tone: 'danger', text: 'Tu suscripción está cancelada.' }
  if (status !== 'trial' || !trialEndsAt) return null
  const days = Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / DAY_MS)
  if (days <= 0) return { tone: 'danger', text: 'Tu período de prueba terminó.' }
  const text = days === 1 ? 'Te queda 1 día de prueba.' : `Te quedan ${days} días de prueba.`
  return { tone: days <= 7 ? 'warn' : 'info', text }
}

function SubscriptionBanner() {
  const { subscription, plan, can, isOwner } = useAuth()
  if (!subscription) return null
  const banner = bannerFor(subscription.status, subscription.trial_ends_at)
  if (!banner) return null
  // Solo quien puede cambiar el plan ve el enlace; los demás, solo el aviso.
  const canManage = isOwner || can('subscription.manage')
  return (
    <div
      className={cn(
        'mb-4 flex flex-col gap-2 rounded-2xl border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between',
        BANNER_TONE[banner.tone],
      )}
    >
      <p className="flex items-start gap-2">
        <Clock className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <strong>{banner.text}</strong> Plan actual: {plan.name}.
        </span>
      </p>
      {canManage && (
        <Link to="/configuracion" className="shrink-0 font-semibold underline-offset-2 hover:underline">
          Ver planes
        </Link>
      )}
    </div>
  )
}

// ── Inicio sin tablero ──────────────────────────────────────────────────────

interface QuickAction {
  to: string
  label: string
  description: string
  icon: LucideIcon
  module?: ModuleCode
  perms?: string[]
}

const QUICK_ACTIONS: QuickAction[] = [
  { to: '/pos', label: 'Vender', description: 'Abre el punto de venta', icon: ShoppingCart, module: 'pos', perms: ['sales.create'] },
  {
    to: '/caja',
    label: 'Caja',
    description: 'Apertura, movimientos y cierre',
    icon: Banknote,
    module: 'pos',
    perms: ['cash.open', 'cash.close', 'cash.move', 'cash.view_all', 'sales.create'],
  },
  { to: '/clientes', label: 'Clientes', description: 'Consulta y registra clientes', icon: Users },
]

function QuickActions() {
  const { can, hasModule } = useAuth()
  const actions = QUICK_ACTIONS.filter(
    (a) => (!a.module || hasModule(a.module)) && (!a.perms || a.perms.some((p) => can(p))),
  )
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {actions.map((a) => (
        <Link
          key={a.to}
          to={a.to}
          className="group flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-card transition-shadow hover:shadow-card-hover"
        >
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
            <a.icon className="h-6 w-6" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-slate-800">{a.label}</span>
            <span className="block text-sm text-slate-500">{a.description}</span>
          </span>
          <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 transition-colors group-hover:text-brand-500" />
        </Link>
      ))}
      <p className="text-sm text-slate-500 sm:col-span-3">
        El tablero con ventas y reportes está disponible para los roles con permiso de reportes.
      </p>
    </div>
  )
}

// ── Tablero ─────────────────────────────────────────────────────────────────

function Board({ title, tenantName }: { title: string; tenantName?: string }) {
  const { tenant, hasModule } = useAuth()
  const branches = useBranches()
  const [branchId, setBranchId] = useState('')
  const { data, isLoading, isError, error, refetch, isFetching } = useDashboard(branchId || null)
  const currency = tenant?.currency
  const m = (v: number) => money(v, currency)
  const multiBranch = (branches.data?.length ?? 0) > 1

  const header = (
    <PageHeader
      title={title}
      description={tenantName ? `Resumen de ${tenantName}` : 'Resumen de tu negocio'}
      action={
        multiBranch ? (
          <Select
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            aria-label="Sucursal"
            className="w-full sm:w-56"
          >
            <option value="">Todas las sucursales</option>
            {branches.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        ) : undefined
      }
    />
  )

  if (isLoading) {
    return (
      <>
        {header}
        <PageLoader label="Cargando tu resumen…" />
      </>
    )
  }
  if (isError || !data) {
    return (
      <>
        {header}
        <Card>
          <CardBody className="space-y-3 text-center">
            <p className="text-sm text-red-600">{errorMessage(error, 'No se pudo cargar el resumen.')}</p>
            <Button variant="outline" onClick={() => void refetch()} loading={isFetching}>
              Reintentar
            </Button>
          </CardBody>
        </Card>
      </>
    )
  }

  const avgTicket = data.count_month ? data.sales_month / data.count_month : 0
  const methods = Object.entries(data.payment_methods_month)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ key: k, label: PAYMENT_METHOD_LABEL[k as PaymentMethod] ?? k, value: v }))
  const hasSales30 = data.sales_by_day.some((d) => d.total > 0)

  return (
    <>
      {header}
      <SubscriptionBanner />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Ventas hoy"
          value={m(data.sales_today)}
          icon={<Wallet className="h-5 w-5" />}
          hint={`${num(data.count_today)} ${data.count_today === 1 ? 'venta' : 'ventas'}`}
        />
        <StatCard
          label="Ventas del mes"
          value={m(data.sales_month)}
          icon={<TrendingUp className="h-5 w-5" />}
          tone="green"
          hint="Con ITBIS, neto de devoluciones"
        />
        <StatCard label="Transacciones del mes" value={num(data.count_month)} icon={<Receipt className="h-5 w-5" />} tone="slate" />
        <StatCard label="Ticket promedio" value={m(avgTicket)} icon={<Scale className="h-5 w-5" />} tone="slate" hint="Este mes" />
        <StatCard
          label="Margen bruto estimado"
          value={m(data.gross_margin_month)}
          icon={<BarChart3 className="h-5 w-5" />}
          tone="accent"
          hint="Ventas sin ITBIS − costo. No es ganancia."
        />
        {hasModule('credit') && (
          <StatCard
            label="Por cobrar"
            value={m(data.receivables_open)}
            icon={<HandCoins className="h-5 w-5" />}
            tone={data.receivables_overdue > 0 ? 'amber' : 'slate'}
            hint={data.receivables_overdue > 0 ? `${m(data.receivables_overdue)} vencido` : 'Nada vencido'}
          />
        )}
        {hasModule('payables') && (
          <StatCard label="Por pagar" value={m(data.payables_open)} icon={<Wallet className="h-5 w-5" />} tone="slate" />
        )}
        {hasModule('expenses') && (
          <StatCard label="Gastos del mes" value={m(data.expenses_month)} icon={<Banknote className="h-5 w-5" />} tone="red" />
        )}
      </div>

      <Card className="mt-4">
        <CardHeader
          title="Ventas de los últimos 30 días"
          subtitle="Toca o pasa sobre una barra para ver el día"
          action={
            hasModule('reports') ? (
              <Link to="/reportes" className="text-sm font-medium text-brand-600 hover:underline">
                Reportes
              </Link>
            ) : undefined
          }
        />
        <CardBody>
          {hasSales30 ? (
            <DailySalesChart data={data.sales_by_day} currency={currency} label="Ventas de los últimos 30 días" />
          ) : (
            <p className="py-8 text-center text-sm text-slate-500">Aún no hay ventas en los últimos 30 días.</p>
          )}
        </CardBody>
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Métodos de pago" subtitle="Este mes" />
          <CardBody>
            {methods.length ? (
              <BarList rows={methods} format={m} />
            ) : (
              <p className="text-center text-sm text-slate-500">Sin cobros este mes.</p>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Productos más vendidos" subtitle="Este mes, por monto" />
          <CardBody>
            {data.top_products_month.length ? (
              <ol className="space-y-2.5">
                {data.top_products_month.map((p, i) => (
                  <li key={p.product_id || i} className="flex items-center gap-3 text-sm">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-slate-800">{p.name}</span>
                      <span className="block text-xs text-slate-400">{num(p.quantity)} unid.</span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums text-slate-900">{m(p.amount)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-center text-sm text-slate-500">Sin ventas este mes.</p>
            )}
          </CardBody>
        </Card>

        {hasModule('inventory') && <LowStockCard data={data.low_stock} total={data.low_stock_count} />}
        {hasModule('invoicing') && <EcfMonthCard counts={data.ecf_month} />}
      </div>
    </>
  )
}

function LowStockCard({
  data,
  total,
}: {
  data: { id: string; name: string; min_stock: number; stock: number }[]
  total: number
}) {
  return (
    <Card>
      <CardHeader
        title="Existencia baja"
        subtitle={total ? `${num(total)} ${total === 1 ? 'producto' : 'productos'} en o bajo el mínimo` : 'Todo por encima del mínimo'}
        action={
          <Link to="/inventario" className="text-sm font-medium text-brand-600 hover:underline">
            Inventario
          </Link>
        }
      />
      <CardBody>
        {data.length ? (
          <ul className="divide-y divide-slate-100">
            {data.map((p) => (
              <li key={p.id} className="flex items-center gap-3 py-2 text-sm first:pt-0 last:pb-0">
                <PackageX className={cn('h-4 w-4 shrink-0', p.stock <= 0 ? 'text-red-500' : 'text-amber-500')} />
                <span className="min-w-0 flex-1 truncate text-slate-800">{p.name}</span>
                <span className="shrink-0 tabular-nums text-slate-600">
                  <strong className="text-slate-900">{num(p.stock)}</strong> / mín. {num(p.min_stock)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-center text-sm text-slate-500">Ningún producto con existencia baja.</p>
        )}
      </CardBody>
    </Card>
  )
}

const ECF_ORDER: EcfStatus[] = [
  'accepted',
  'accepted_conditional',
  'sent',
  'pending',
  'sending',
  'error',
  'rejected',
  'voided',
]

function EcfMonthCard({ counts }: { counts: Record<string, number> }) {
  const total = Object.values(counts).reduce((s, v) => s + v, 0)
  const problems = (counts.error ?? 0) + (counts.rejected ?? 0)
  let body: ReactNode
  if (!total) {
    body = <p className="text-center text-sm text-slate-500">No se han emitido comprobantes electrónicos este mes.</p>
  } else {
    body = (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {ECF_ORDER.filter((s) => (counts[s] ?? 0) > 0).map((s) => (
            <Badge key={s} tone={ECF_STATUS[s].tone}>
              {ECF_STATUS[s].label}: <strong className="tabular-nums">{num(counts[s])}</strong>
            </Badge>
          ))}
        </div>
        {problems > 0 && (
          <p className="flex items-start gap-2 text-sm text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {num(problems)} {problems === 1 ? 'comprobante necesita' : 'comprobantes necesitan'} atención.
          </p>
        )}
      </div>
    )
  }
  return (
    <Card>
      <CardHeader
        title="Comprobantes electrónicos"
        subtitle={`${num(total)} este mes`}
        action={
          <Link to="/facturacion" className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline">
            <FileSpreadsheet className="h-4 w-4" /> Facturación
          </Link>
        }
      />
      <CardBody>{body}</CardBody>
    </Card>
  )
}
