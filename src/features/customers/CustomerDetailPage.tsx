import { useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Banknote, CreditCard, Pencil, Printer, Receipt, Wallet } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Segmented } from '@/components/ui/Segmented'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState, PageLoader, Spinner } from '@/components/ui/misc'
import { useCustomer, useCustomerPayments, useCustomerReceivables, useCustomerSales } from '@/hooks/customers'
import { useMemberNames } from '@/hooks/team'
import { errorMessage } from '@/lib/errors'
import { fmtDate, fmtDateShort, fmtDateTime, money } from '@/lib/format'
import { DOCUMENT_STATUS, PAYMENT_METHOD_LABEL, SALE_STATUS } from '@/lib/labels'
import { esc, printHtml } from '@/lib/print'
import type { Customer, CustomerPayment, Receivable } from '@/types/erp'
import type { Tenant } from '@/types/db'
import { ReceivePaymentModal } from '@/features/receivables/ReceivePaymentModal'
import { daysOverdue, round2 } from '@/features/receivables/paymentShared'
import { CustomerFormModal } from './CustomerFormModal'

type Tab = 'receivables' | 'payments' | 'sales'

const DOC_SHORT: Record<Customer['doc_type'], string> = {
  rnc: 'RNC',
  cedula: 'Cédula',
  passport: 'Pasaporte',
  none: 'Sin documento',
}

const balanceOf = (r: Receivable) => round2(r.amount - r.paid_amount)
const isOverdue = (r: Receivable) => r.status === 'open' && daysOverdue(r.due_date) > 0

export function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { can, hasModule, tenant } = useAuth()
  const currency = tenant?.currency ?? 'DOP'
  const customer = useCustomer(id)
  const receivables = useCustomerReceivables(id)
  const payments = useCustomerPayments(id)
  const sales = useCustomerSales(id)
  const names = useMemberNames()

  const [tab, setTab] = useState<Tab>('receivables')
  const [payOpen, setPayOpen] = useState(false)
  const [payTarget, setPayTarget] = useState<string | undefined>()
  const [editOpen, setEditOpen] = useState(false)

  const canCollect = can('receivables.manage') && hasModule('credit')
  const openRcv = useMemo(() => (receivables.data ?? []).filter((r) => r.status === 'open'), [receivables.data])
  const balance = round2(openRcv.reduce((s, r) => s + balanceOf(r), 0))
  const overdue = round2(openRcv.filter(isOverdue).reduce((s, r) => s + balanceOf(r), 0))

  if (customer.isLoading) return <PageLoader label="Cargando cliente…" />
  if (customer.isError || !customer.data) {
    return (
      <EmptyState
        icon={<AlertTriangle className="h-6 w-6" />}
        title={customer.isError ? 'No se pudo cargar el cliente' : 'Cliente no encontrado'}
        description={customer.isError ? errorMessage(customer.error) : 'Puede que se haya eliminado o que aún no se haya subido.'}
        action={<Button onClick={() => navigate('/clientes')}>Volver a clientes</Button>}
      />
    )
  }
  const c = customer.data
  const limit = Number(c.credit_limit)

  const openPay = (receivableId?: string) => {
    setPayTarget(receivableId)
    setPayOpen(true)
  }

  const print = () => {
    if (!tenant) return
    printHtml(statementHtml(tenant, c, receivables.data ?? [], payments.data ?? [], currency), 'letter', `Estado de cuenta ${c.name}`)
  }

  return (
    <div>
      <Link to="/clientes" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-4 w-4" /> Clientes
      </Link>
      <PageHeader
        title={c.name}
        description={c.doc_type === 'none' ? 'Sin documento' : `${DOC_SHORT[c.doc_type]} ${c.doc_number ?? ''}`}
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={print} disabled={receivables.isLoading || payments.isLoading}>
              <Printer className="h-4 w-4" /> Imprimir
            </Button>
            {can('customers.manage') && (
              <Button variant="outline" onClick={() => setEditOpen(true)}>
                <Pencil className="h-4 w-4" /> Editar
              </Button>
            )}
            {canCollect && (
              <Button onClick={() => openPay()} disabled={balance <= 0}>
                <Banknote className="h-4 w-4" /> Registrar abono
              </Button>
            )}
          </div>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Saldo" value={money(balance, currency)} icon={<Wallet className="h-5 w-5" />} tone="brand" hint={`${openRcv.length} cuentas abiertas`} />
        <StatCard label="Vencido" value={money(overdue, currency)} icon={<AlertTriangle className="h-5 w-5" />} tone={overdue > 0 ? 'red' : 'slate'} />
        <StatCard label="Límite de crédito" value={limit > 0 ? money(limit, currency) : 'Sin crédito'} icon={<CreditCard className="h-5 w-5" />} tone="slate" hint={`${c.credit_days} días`} />
        <StatCard
          label="Disponible"
          value={limit > 0 ? money(Math.max(0, limit - balance), currency) : '—'}
          icon={<Receipt className="h-5 w-5" />}
          tone="green"
        />
      </div>

      <Card className="mb-5">
        <CardHeader
          title="Datos del cliente"
          action={!c.is_active ? <Badge tone="slate">Inactivo</Badge> : undefined}
        />
        <CardBody>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Info label="Tipo">{c.kind === 'company' ? 'Empresa' : 'Persona'}</Info>
            <Info label="Teléfono">{c.phone ?? '—'}</Info>
            <Info label="Correo">{c.email ?? '—'}</Info>
            <Info label="Dirección">{c.address ?? '—'}</Info>
            {c.notes && (
              <Info label="Notas" className="sm:col-span-2 lg:col-span-4">
                {c.notes}
              </Info>
            )}
          </dl>
        </CardBody>
      </Card>

      <Segmented
        value={tab}
        onChange={setTab}
        className="mb-3"
        label="Estado de cuenta"
        options={[
          { value: 'receivables', label: 'Cuentas' },
          { value: 'payments', label: 'Abonos' },
          { value: 'sales', label: 'Compras' },
        ]}
      />

      {tab === 'receivables' && (
        <Card>
          <CardHeader title="Cuentas por cobrar" subtitle="Ventas a crédito y lo que falta por pagar de cada una." />
          {receivables.isLoading ? (
            <div className="flex justify-center p-8"><Spinner /></div>
          ) : receivables.isError ? (
            <p className="p-5 text-sm text-red-600">{errorMessage(receivables.error)}</p>
          ) : (receivables.data ?? []).length === 0 ? (
            <p className="p-5 text-sm text-slate-500">Este cliente no tiene cuentas por cobrar.</p>
          ) : (
            <>
              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-4 py-3 font-medium">Concepto</th>
                      <th className="px-4 py-3 font-medium">Fecha</th>
                      <th className="px-4 py-3 font-medium">Vence</th>
                      <th className="px-4 py-3 text-right font-medium">Monto</th>
                      <th className="px-4 py-3 text-right font-medium">Pagado</th>
                      <th className="px-4 py-3 text-right font-medium">Saldo</th>
                      <th className="px-4 py-3 font-medium">Estado</th>
                      {canCollect && <th className="px-4 py-3" />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(receivables.data ?? []).map((r) => (
                      <tr key={r.id} className={isOverdue(r) ? 'bg-red-50/40' : undefined}>
                        <td className="px-4 py-3 text-slate-700">
                          {r.sale_id ? (
                            <Link to={`/ventas/${r.sale_id}`} className="hover:text-brand-600">
                              {r.description ?? 'Venta a crédito'}
                            </Link>
                          ) : (
                            r.description ?? 'Cuenta'
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-600">{fmtDateShort(r.created_at)}</td>
                        <td className="px-4 py-3 text-slate-600">{fmtDateShort(r.due_date)}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{money(r.amount, currency)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-600">{money(r.paid_amount, currency)}</td>
                        <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(balanceOf(r), currency)}</td>
                        <td className="px-4 py-3">
                          <StatusBadge r={r} />
                        </td>
                        {canCollect && (
                          <td className="px-4 py-3 text-right">
                            {r.status === 'open' && (
                              <Button size="sm" variant="ghost" onClick={() => openPay(r.id)}>
                                Abonar
                              </Button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <DataList>
                {(receivables.data ?? []).map((r) => (
                  <DataRow
                    key={r.id}
                    title={r.description ?? 'Cuenta'}
                    titleExtra={`Vence ${fmtDate(r.due_date)}`}
                    tone={isOverdue(r) ? 'danger' : undefined}
                    badges={<StatusBadge r={r} />}
                    actions={
                      canCollect && r.status === 'open' ? (
                        <Button size="sm" variant="ghost" onClick={() => openPay(r.id)}>
                          Abonar
                        </Button>
                      ) : undefined
                    }
                  >
                    <DataFields cols={3}>
                      <DataField label="Monto">{money(r.amount, currency)}</DataField>
                      <DataField label="Pagado">{money(r.paid_amount, currency)}</DataField>
                      <DataField label="Saldo">{money(balanceOf(r), currency)}</DataField>
                    </DataFields>
                  </DataRow>
                ))}
              </DataList>
            </>
          )}
        </Card>
      )}

      {tab === 'payments' && (
        <Card>
          <CardHeader title="Abonos recibidos" />
          {payments.isLoading ? (
            <div className="flex justify-center p-8"><Spinner /></div>
          ) : payments.isError ? (
            <p className="p-5 text-sm text-red-600">{errorMessage(payments.error)}</p>
          ) : (payments.data ?? []).length === 0 ? (
            <p className="p-5 text-sm text-slate-500">Todavía no hay abonos de este cliente.</p>
          ) : (
            <>
              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-4 py-3 font-medium">Recibo</th>
                      <th className="px-4 py-3 font-medium">Fecha</th>
                      <th className="px-4 py-3 font-medium">Método</th>
                      <th className="px-4 py-3 font-medium">Referencia</th>
                      <th className="px-4 py-3 font-medium">Recibió</th>
                      <th className="px-4 py-3 text-right font-medium">Monto</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(payments.data ?? []).map((p) => (
                      <tr key={p.id}>
                        <td className="px-4 py-3 font-medium text-slate-700">{p.number}</td>
                        <td className="px-4 py-3 text-slate-600">{fmtDateTime(p.created_at)}</td>
                        <td className="px-4 py-3 text-slate-600">{PAYMENT_METHOD_LABEL[p.method]}</td>
                        <td className="px-4 py-3 text-slate-600">{p.reference ?? p.note ?? '—'}</td>
                        <td className="px-4 py-3 text-slate-600">{(p.created_by && names[p.created_by]) || '—'}</td>
                        <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(p.amount, currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <DataList>
                {(payments.data ?? []).map((p) => (
                  <DataRow key={p.id} title={p.number} titleExtra={fmtDateTime(p.created_at)}>
                    <DataFields>
                      <DataField label="Monto">{money(p.amount, currency)}</DataField>
                      <DataField label="Método">{PAYMENT_METHOD_LABEL[p.method]}</DataField>
                      {p.reference && <DataField label="Referencia">{p.reference}</DataField>}
                    </DataFields>
                  </DataRow>
                ))}
              </DataList>
            </>
          )}
        </Card>
      )}

      {tab === 'sales' && (
        <Card>
          <CardHeader title="Historial de compras" subtitle="Ventas hechas a este cliente." />
          {sales.isLoading ? (
            <div className="flex justify-center p-8"><Spinner /></div>
          ) : sales.isError ? (
            <p className="p-5 text-sm text-red-600">{errorMessage(sales.error)}</p>
          ) : (sales.data ?? []).length === 0 ? (
            <p className="p-5 text-sm text-slate-500">No hay ventas registradas a este cliente.</p>
          ) : (
            <>
              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-4 py-3 font-medium">Venta</th>
                      <th className="px-4 py-3 font-medium">Fecha</th>
                      <th className="px-4 py-3 font-medium">Estado</th>
                      <th className="px-4 py-3 text-right font-medium">A crédito</th>
                      <th className="px-4 py-3 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(sales.data ?? []).map((s) => (
                      <tr key={s.id} className="hover:bg-slate-50/60">
                        <td className="px-4 py-3">
                          <Link to={`/ventas/${s.id}`} className="font-medium text-slate-800 hover:text-brand-600">
                            {s.number}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-slate-600">{fmtDateTime(s.created_at)}</td>
                        <td className="px-4 py-3">
                          <Badge tone={SALE_STATUS[s.status].tone}>{SALE_STATUS[s.status].label}</Badge>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                          {s.credit_amount > 0 ? money(s.credit_amount, currency) : '—'}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(s.total, currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <DataList>
                {(sales.data ?? []).map((s) => (
                  <DataRow
                    key={s.id}
                    title={s.number}
                    titleExtra={fmtDateTime(s.created_at)}
                    onClick={() => navigate(`/ventas/${s.id}`)}
                    badges={<Badge tone={SALE_STATUS[s.status].tone}>{SALE_STATUS[s.status].label}</Badge>}
                  >
                    <DataFields>
                      <DataField label="Total">{money(s.total, currency)}</DataField>
                      <DataField label="A crédito">{s.credit_amount > 0 ? money(s.credit_amount, currency) : '—'}</DataField>
                    </DataFields>
                  </DataRow>
                ))}
              </DataList>
            </>
          )}
        </Card>
      )}

      {canCollect && (
        <ReceivePaymentModal
          open={payOpen}
          onClose={() => setPayOpen(false)}
          customerId={c.id}
          customerName={c.name}
          receivables={openRcv}
          receivableId={payTarget}
        />
      )}
      <CustomerFormModal open={editOpen} onClose={() => setEditOpen(false)} customer={c} />
    </div>
  )
}

function Info({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-xs uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5 break-words text-slate-700">{children}</dd>
    </div>
  )
}

function StatusBadge({ r }: { r: Receivable }) {
  if (isOverdue(r)) return <Badge tone="red">Vencida · {daysOverdue(r.due_date)} d</Badge>
  const s = DOCUMENT_STATUS[r.status]
  return <Badge tone={s.tone}>{s.label}</Badge>
}

/** Estado de cuenta en carta: datos del negocio, del cliente, cuentas abiertas y últimos abonos. */
function statementHtml(
  tenant: Tenant,
  c: Customer,
  receivables: Receivable[],
  payments: CustomerPayment[],
  currency: string,
): string {
  const open = receivables.filter((r) => r.status === 'open')
  const total = round2(open.reduce((s, r) => s + balanceOf(r), 0))
  const m = (n: number) => esc(money(n, currency))
  const rows = open
    .map(
      (r) => `<tr>
        <td>${esc(r.description ?? 'Cuenta')}</td>
        <td>${esc(fmtDateShort(r.created_at))}</td>
        <td>${esc(fmtDateShort(r.due_date))}${daysOverdue(r.due_date) > 0 ? ` <b>(${daysOverdue(r.due_date)} d vencida)</b>` : ''}</td>
        <td class="r">${m(r.amount)}</td><td class="r">${m(r.paid_amount)}</td><td class="r b">${m(balanceOf(r))}</td>
      </tr>`,
    )
    .join('')
  const pays = payments
    .slice(0, 20)
    .map(
      (p) => `<tr><td>${esc(p.number)}</td><td>${esc(fmtDateShort(p.created_at))}</td>
        <td>${esc(PAYMENT_METHOD_LABEL[p.method])}</td><td class="r">${m(p.amount)}</td></tr>`,
    )
    .join('')
  return `<div class="doc">
    <table><tr>
      <td>
        <h2>${esc(tenant.legal_name || tenant.name)}</h2>
        ${tenant.rnc ? `<p class="muted">RNC ${esc(tenant.rnc)}</p>` : ''}
        ${tenant.address ? `<p class="muted">${esc(tenant.address)}</p>` : ''}
        ${tenant.phone ? `<p class="muted">Tel. ${esc(tenant.phone)}</p>` : ''}
      </td>
      <td class="r"><h2>Estado de cuenta</h2><p class="muted">${esc(fmtDate(new Date()))}</p></td>
    </tr></table>
    <div class="hr"></div>
    <p class="b">${esc(c.name)}</p>
    ${c.doc_type !== 'none' ? `<p>${esc(DOC_SHORT[c.doc_type])} ${esc(c.doc_number)}</p>` : ''}
    ${c.phone ? `<p>Tel. ${esc(c.phone)}</p>` : ''}
    ${c.address ? `<p>${esc(c.address)}</p>` : ''}
    <h3 style="margin-top:16px">Cuentas pendientes</h3>
    ${
      open.length
        ? `<table><thead><tr><th>Concepto</th><th>Fecha</th><th>Vence</th><th class="r">Monto</th><th class="r">Pagado</th><th class="r">Saldo</th></tr></thead>
           <tbody>${rows}</tbody></table>`
        : '<p class="muted">Sin cuentas pendientes.</p>'
    }
    <p class="r b" style="margin-top:10px;font-size:15px">Saldo total: ${m(total)}</p>
    ${
      pays
        ? `<h3 style="margin-top:16px">Últimos abonos</h3>
           <table><thead><tr><th>Recibo</th><th>Fecha</th><th>Método</th><th class="r">Monto</th></tr></thead><tbody>${pays}</tbody></table>`
        : ''
    }
  </div>`
}
