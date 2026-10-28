import { useMemo, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Ban, FileText, Printer, Receipt, Undo2 } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { RequireAccess } from '@/components/RequireAccess'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useBranches, useRegisters } from '@/hooks/core'
import { useMemberNames } from '@/hooks/team'
import { useOpenSessions } from '@/hooks/cash'
import { newClientUid, useReturnSale, useSale, useVoidSale, type ReturnSaleInput, type SaleDetail } from '@/hooks/sales'
import { errorMessage } from '@/lib/errors'
import { fmtDateTime, money } from '@/lib/format'
import { ECF_STATUS, PAYMENT_METHOD_LABEL, SALE_STATUS } from '@/lib/labels'
import { ECF_TYPE_LABEL, printSaleReceipt } from '@/features/pos/receipt'
import type { ElectronicInvoice, SaleItem } from '@/types/erp'

/*
 * Detalle de una venta: líneas, pagos, devoluciones y su estado fiscal, con
 * las acciones de reimprimir, anular y devolver. Las condiciones de anulación
 * se muestran aquí para no ofrecer un botón que la base va a rechazar, pero
 * quien decide es `void_sale()`.
 */

export function SaleDetailPage() {
  return (
    <RequireAccess module="pos">
      <SaleDetailScreen />
    </RequireAccess>
  )
}

const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toLocaleString('es-DO', { maximumFractionDigits: 3 }))

/** e-CF que cuentan como "emitido" para la regla de anulación de void_sale(). */
const blocksVoid = (inv: ElectronicInvoice) => inv.source_type === 'sale' && !['error', 'voided'].includes(inv.status)

function SaleDetailScreen() {
  const { id } = useParams<{ id: string }>()
  const { tenant, can } = useAuth()
  const toast = useToast()
  const sale = useSale(id)
  const names = useMemberNames()
  const registers = useRegisters()
  const branches = useBranches()
  const currency = tenant?.currency ?? 'DOP'
  const m = (n: number) => money(n, currency)

  const [voidOpen, setVoidOpen] = useState(false)
  const [returnOpen, setReturnOpen] = useState(false)
  // Idempotencia de la devolución: uno por intento, conservado si se cierra
  // el modal tras un fallo de red y se vuelve a intentar.
  const [returnUid, setReturnUid] = useState<string | null>(null)

  if (sale.isLoading) return <PageLoader label="Cargando venta…" />
  if (sale.isError || !sale.data) {
    return (
      <EmptyState
        icon={<Receipt className="h-6 w-6" />}
        title="No se pudo abrir la venta"
        description={errorMessage(sale.error, 'Venta no encontrada')}
        action={
          <Link to="/ventas">
            <Button variant="outline">Volver a ventas</Button>
          </Link>
        }
      />
    )
  }

  const d = sale.data
  const s = d.sale
  const st = SALE_STATUS[s.status]
  const register = registers.data?.find((r) => r.id === s.register_id) ?? null
  const branch = branches.data?.find((b) => b.id === s.branch_id) ?? null
  const saleInvoices = d.invoices.filter((i) => i.source_type === 'sale')
  const canVoid = can('sales.void') && s.status === 'completed'
  const canReturn = can('sales.return') && (s.status === 'completed' || s.status === 'partially_returned')

  const reprint = () => {
    if (!tenant) return
    try {
      printSaleReceipt({
        tenant,
        detail: d,
        register,
        branch,
        cashierName: s.created_by ? names[s.created_by] : null,
        sellerName: s.seller_id ? names[s.seller_id] : null,
        reprint: true,
      })
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo imprimir'))
    }
  }

  return (
    <div className="space-y-4">
      <Link to="/ventas" className="inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-700">
        <ArrowLeft className="h-4 w-4" /> Ventas
      </Link>
      <PageHeader
        title={`Venta ${s.number}`}
        description={fmtDateTime(s.created_at)}
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={reprint}>
              <Printer className="h-4 w-4" /> Reimprimir
            </Button>
            {canReturn && (
              <Button
                variant="outline"
                onClick={() => {
                  if (!returnUid) setReturnUid(newClientUid())
                  setReturnOpen(true)
                }}
              >
                <Undo2 className="h-4 w-4" /> Devolución
              </Button>
            )}
            {canVoid && (
              <Button variant="danger" onClick={() => setVoidOpen(true)}>
                <Ban className="h-4 w-4" /> Anular
              </Button>
            )}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Resumen"
            action={
              <span className="flex flex-wrap justify-end gap-1">
                <Badge tone={st.tone}>{st.label}</Badge>
                {s.credit_amount > 0 && <Badge tone="amber">Crédito</Badge>}
              </span>
            }
          />
          <CardBody>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
              <Info label="Cliente">
                {d.customer ? (
                  <Link to={`/clientes/${d.customer.id}`} className="font-medium text-brand-700 hover:underline">
                    {d.customer.name}
                  </Link>
                ) : (
                  'Consumidor final'
                )}
                {d.customer?.doc_number && <span className="block text-xs text-slate-500">{d.customer.doc_number}</span>}
              </Info>
              <Info label="Vendedor">{s.seller_id ? (names[s.seller_id] ?? '—') : '—'}</Info>
              <Info label="Cajero">{s.created_by ? (names[s.created_by] ?? '—') : '—'}</Info>
              <Info label="Caja">{register?.name ?? '—'}</Info>
              {branch && <Info label="Sucursal">{branch.name}</Info>}
              <Info label="Comprobante">{s.ecf_type ? `e-CF ${s.ecf_type}` : 'Interno'}</Info>
            </dl>
            {s.notes && <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">{s.notes}</p>}
            {s.status === 'voided' && (
              <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
                Anulada {fmtDateTime(s.voided_at)}
                {s.voided_by ? ` por ${names[s.voided_by] ?? 'otro usuario'}` : ''}. Motivo: {s.void_reason ?? '—'}
              </p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Totales" />
          <CardBody>
            <dl className="space-y-1.5 text-sm">
              <TotalRow label="Subtotal" value={m(s.subtotal)} />
              {s.discount_total > 0 && <TotalRow label="Descuento" value={`−${m(s.discount_total)}`} />}
              <TotalRow label="ITBIS" value={m(s.tax_total)} />
              <div className="flex items-baseline justify-between border-t border-slate-100 pt-2">
                <dt className="font-semibold text-slate-800">Total</dt>
                <dd className="text-xl font-bold tabular-nums text-slate-900">{m(s.total)}</dd>
              </div>
              {s.returned_total > 0 && <TotalRow label="Devuelto" value={`−${m(s.returned_total)}`} />}
              {s.change_due > 0 && <TotalRow label="Devuelta entregada" value={m(s.change_due)} />}
            </dl>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Productos" subtitle={`${d.items.length} línea(s)`} />
        <LinesTable items={d.items} currency={currency} />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Pagos" />
          <CardBody>
            {d.payments.length === 0 ? (
              <p className="text-sm text-slate-500">Sin pagos registrados.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {d.payments.map((p) => (
                  <li key={p.id} className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="font-medium text-slate-700">{PAYMENT_METHOD_LABEL[p.method]}</span>
                      {p.reference && <span className="block truncate text-xs text-slate-500">Ref. {p.reference}</span>}
                      {p.method === 'cash' && p.tendered != null && p.tendered !== p.amount && (
                        <span className="block text-xs text-slate-500">
                          Recibido {m(p.tendered)} · devuelta {m(p.tendered - p.amount)}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums">{m(p.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
            {d.receivable && (
              <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Cuenta por cobrar: {m(d.receivable.amount)} · pagado {m(d.receivable.paid_amount)} · vence{' '}
                {d.receivable.due_date}
              </p>
            )}
          </CardBody>
        </Card>

        <EcfCard invoices={saleInvoices} requested={s.ecf_type} currency={currency} />
      </div>

      {d.returns.length > 0 && (
        <Card>
          <CardHeader title="Devoluciones" />
          <ul className="divide-y divide-slate-100">
            {d.returns.map((r) => {
              const note = d.invoices.find((i) => i.source_type === 'sale_return' && i.source_id === r.id)
              return (
                <li key={r.id} className="px-5 py-3 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-800">{r.number}</p>
                      <p className="text-xs text-slate-500">
                        {fmtDateTime(r.created_at)} · {PAYMENT_METHOD_LABEL[r.refund_method]}
                        {r.restock ? ' · repuesto al inventario' : ' · sin reponer inventario'}
                        {r.created_by ? ` · ${names[r.created_by] ?? ''}` : ''}
                      </p>
                      <p className="mt-1 text-slate-600">{r.reason}</p>
                      <p className="text-xs text-slate-500">
                        {r.items
                          .map((ri) => {
                            const it = d.items.find((x) => x.id === ri.sale_item_id)
                            return `${fmtQty(ri.quantity)} × ${it?.description ?? 'producto'}`
                          })
                          .join(', ')}
                      </p>
                      {note && (
                        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                          <span className="text-slate-500">Nota de crédito</span>
                          <span className="font-mono font-medium text-slate-800">{note.encf}</span>
                          <Badge tone={ECF_STATUS[note.status].tone}>{ECF_STATUS[note.status].label}</Badge>
                          {note.simulated && <Badge tone="amber">Simulación</Badge>}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 font-semibold tabular-nums text-red-600">−{m(r.total)}</span>
                  </div>
                </li>
              )
            })}
          </ul>
        </Card>
      )}

      {voidOpen && <VoidModal detail={d} onClose={() => setVoidOpen(false)} />}
      {returnOpen && returnUid && (
        <ReturnModal
          detail={d}
          clientUid={returnUid}
          currency={currency}
          onClose={() => setReturnOpen(false)}
          onDone={() => {
            setReturnOpen(false)
            setReturnUid(null)
          }}
        />
      )}
    </div>
  )
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="truncate text-slate-700">{children}</dd>
    </div>
  )
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-slate-600">
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}

function LinesTable({ items, currency }: { items: SaleItem[]; currency: string }) {
  const m = (n: number) => money(n, currency)
  return (
    <>
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Descripción</th>
              <th className="px-4 py-3 text-right">Cant.</th>
              <th className="px-4 py-3 text-right">Precio</th>
              <th className="px-4 py-3 text-right">Desc.</th>
              <th className="px-4 py-3 text-right">ITBIS</th>
              <th className="px-4 py-3 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((it) => (
              <tr key={it.id}>
                <td className="px-4 py-3">
                  <span className="text-slate-800">{it.description}</span>
                  {it.returned_qty > 0 && (
                    <span className="ml-2 text-xs text-amber-700">devuelto {fmtQty(it.returned_qty)}</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{fmtQty(it.quantity)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{m(it.unit_price)}</td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-500">
                  {it.discount > 0 ? `−${m(it.discount)}` : '—'}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-500">{m(it.tax_amount)}</td>
                <td className="px-4 py-3 text-right font-semibold tabular-nums">{m(it.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <DataList>
        {items.map((it) => (
          <DataRow
            key={it.id}
            title={it.description}
            badges={it.returned_qty > 0 ? <Badge tone="amber">Devuelto {fmtQty(it.returned_qty)}</Badge> : undefined}
          >
            <DataFields>
              <DataField label="Cantidad">
                {fmtQty(it.quantity)} × {m(it.unit_price)}
              </DataField>
              <DataField label="Total">{m(it.total)}</DataField>
              <DataField label="Descuento">{it.discount > 0 ? `−${m(it.discount)}` : '—'}</DataField>
              <DataField label="ITBIS">{m(it.tax_amount)}</DataField>
            </DataFields>
          </DataRow>
        ))}
      </DataList>
    </>
  )
}

function EcfCard({
  invoices,
  requested,
  currency,
}: {
  invoices: ElectronicInvoice[]
  requested: string | null
  currency: string
}) {
  return (
    <Card>
      <CardHeader title="Comprobante fiscal" />
      <CardBody className="space-y-4">
        {invoices.length === 0 ? (
          <div className="flex items-start gap-3 text-sm text-slate-600">
            <FileText className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
            <p>
              {requested
                ? `Se pidió e-CF ${requested}, pero no hay un comprobante registrado para esta venta.`
                : 'Comprobante interno: esta venta no tiene comprobante fiscal electrónico.'}
            </p>
          </div>
        ) : (
          invoices.map((inv) => {
            const status = ECF_STATUS[inv.status]
            return (
              <div key={inv.id} className="space-y-2 text-sm">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={status.tone}>{status.label}</Badge>
                  {inv.simulated && <Badge tone="amber">Simulación — sin validez fiscal</Badge>}
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                  <Info label="Tipo">{ECF_TYPE_LABEL[inv.ecf_type] ?? inv.ecf_type}</Info>
                  <Info label="e-NCF">
                    <span className="font-mono">{inv.encf}</span>
                  </Info>
                  <Info label="Emisión">{fmtDateTime(inv.issue_date)}</Info>
                  <Info label="Monto">{money(inv.total, currency)}</Info>
                  {inv.security_code && (
                    <Info label="Código de seguridad">
                      <span className="font-mono">{inv.security_code}</span>
                    </Info>
                  )}
                  {inv.track_id && <Info label="TrackId">{inv.track_id}</Info>}
                  {inv.buyer_id && <Info label="Comprador">{`${inv.buyer_name ?? ''} ${inv.buyer_id}`.trim()}</Info>}
                </dl>
                {inv.messages.length > 0 && (
                  <ul className="space-y-1 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    {inv.messages.map((msg, i) => (
                      <li key={i}>
                        {msg.code ? <span className="font-mono">{msg.code}: </span> : null}
                        {msg.message ?? ''}
                      </li>
                    ))}
                  </ul>
                )}
                {inv.last_error && (
                  <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">{inv.last_error}</p>
                )}
              </div>
            )
          })
        )}
      </CardBody>
    </Card>
  )
}

// ── Anular ──────────────────────────────────────────────────────────────────

function VoidModal({ detail, onClose }: { detail: SaleDetail; onClose: () => void }) {
  const toast = useToast()
  const voidSale = useVoidSale()
  const [reason, setReason] = useState('')

  // Las mismas condiciones que void_sale(), para explicar ANTES por qué no.
  const blockers: string[] = []
  if (!detail.sessionOpen) blockers.push('La caja de esta venta ya cerró: registra una devolución en su lugar.')
  if (detail.invoices.some(blocksVoid))
    blockers.push('Tiene comprobante fiscal electrónico: registra una devolución para emitir la nota de crédito.')
  if (detail.receivable && detail.receivable.paid_amount > 0)
    blockers.push('Es a crédito y ya tiene abonos: registra una devolución.')

  const submit = () => {
    if (!reason.trim()) {
      toast.error('Indica el motivo de la anulación')
      return
    }
    voidSale.mutate(
      { saleId: detail.sale.id, reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success(`Venta ${detail.sale.number} anulada`)
          onClose()
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Anular venta ${detail.sale.number}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="danger"
            onClick={submit}
            loading={voidSale.isPending}
            disabled={blockers.length > 0 || !reason.trim()}
          >
            Anular venta
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-slate-600">
          Anular revierte la venta por completo: devuelve el inventario, saca el dinero de la caja y cancela la cuenta
          por cobrar. Solo es posible mientras la caja de la venta siga abierta y sin comprobante fiscal emitido; si no,
          lo que corresponde es una devolución.
        </p>
        {blockers.length > 0 ? (
          <ul className="space-y-1 rounded-xl bg-red-50 px-3 py-2 text-red-700">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        ) : (
          <Field label="Motivo" required>
            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </Field>
        )}
      </div>
    </Modal>
  )
}

// ── Devolución ──────────────────────────────────────────────────────────────

type RefundMethod = ReturnSaleInput['refundMethod']

function ReturnModal({
  detail,
  clientUid,
  currency,
  onClose,
  onDone,
}: {
  detail: SaleDetail
  clientUid: string
  currency: string
  onClose: () => void
  onDone: () => void
}) {
  const toast = useToast()
  const returnSale = useReturnSale()
  const sessions = useOpenSessions()
  const registers = useRegisters()
  const m = (n: number) => money(n, currency)

  const returnable = detail.items.filter((it) => it.quantity - it.returned_qty > 0)
  const [qty, setQty] = useState<Record<string, string>>({})
  const rcv = detail.receivable
  const rcvOpen = rcv && rcv.status === 'open' ? rcv.amount - rcv.paid_amount : 0
  const firstMethod = detail.payments.find((p) => p.method === 'cash' || p.method === 'card' || p.method === 'transfer')
    ?.method as RefundMethod | undefined
  const [method, setMethod] = useState<RefundMethod>(rcvOpen > 0 ? 'credit_note' : (firstMethod ?? 'cash'))
  const [restock, setRestock] = useState(true)
  const [reason, setReason] = useState('')

  // Cajas abiertas donde se puede sacar el dinero del reembolso.
  const openRegisters = useMemo(() => {
    const regName = new Map((registers.data ?? []).map((r) => [r.id, r.name]))
    return (sessions.data ?? []).map((s) => ({ id: s.register_id, name: regName.get(s.register_id) ?? s.number }))
  }, [sessions.data, registers.data])
  const [registerId, setRegisterId] = useState<string>('')
  const effectiveRegister =
    registerId ||
    openRegisters.find((r) => r.id === detail.sale.register_id)?.id ||
    openRegisters[0]?.id ||
    ''

  const parsed = returnable.map((it) => {
    const max = it.quantity - it.returned_qty
    const raw = Number((qty[it.id] ?? '').replace(',', '.'))
    const q = Number.isFinite(raw) && raw > 0 ? Math.round(raw * 1000) / 1000 : 0
    return { it, max, q, over: q > max + 1e-9 }
  })
  const chosen = parsed.filter((p) => p.q > 0)
  // Estimación: la base reparte igual (proporcional a lo cobrado en la línea).
  const estimate = chosen.reduce((s, p) => s + Math.round((p.it.total * p.q * 100) / p.it.quantity) / 100, 0)
  const needsRegister = method !== 'credit_note'

  let problem: string | null = null
  if (parsed.some((p) => p.over)) problem = 'Hay cantidades mayores que lo que queda por devolver.'
  else if (needsRegister && !effectiveRegister) problem = 'Abre una caja para devolver dinero, o usa nota de crédito.'
  else if (method === 'credit_note' && estimate > rcvOpen + 0.01)
    problem = `El saldo pendiente de la venta (${m(rcvOpen)}) no cubre la devolución; reembolsa por otro método.`

  const submit = () => {
    if (!chosen.length) {
      toast.error('Indica qué cantidades se devuelven')
      return
    }
    if (!reason.trim()) {
      toast.error('Indica el motivo de la devolución')
      return
    }
    if (problem) {
      toast.error(problem)
      return
    }
    returnSale.mutate(
      {
        clientUid,
        saleId: detail.sale.id,
        registerId: needsRegister ? effectiveRegister : null,
        refundMethod: method,
        reason: reason.trim(),
        restock,
        items: chosen.map((p) => ({ sale_item_id: p.it.id, quantity: p.q })),
      },
      {
        onSuccess: (r) => {
          toast.success(
            `Devolución ${r.number ?? ''} registrada${r.total != null ? ` por ${m(r.total)}` : ''}`.replace(/\s+/g, ' '),
          )
          if (r.ecf?.encf) toast.info(`Nota de crédito electrónica ${r.ecf.encf} generada`)
          onDone()
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    )
  }

  const methodOptions: RefundMethod[] = rcvOpen > 0 ? ['credit_note', 'cash', 'card', 'transfer'] : ['cash', 'card', 'transfer']

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Devolución de ${detail.sale.number}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={returnSale.isPending}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={returnSale.isPending} disabled={!chosen.length || !reason.trim() || Boolean(problem)}>
            Registrar devolución {estimate > 0 ? `(${m(estimate)})` : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {returnable.length === 0 ? (
          <p className="text-sm text-slate-500">Todo lo vendido ya fue devuelto.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {parsed.map(({ it, max, over }) => (
              <li key={it.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-medium text-slate-800">{it.description}</p>
                  <p className="text-xs text-slate-500">
                    Vendido {fmtQty(it.quantity)}
                    {it.returned_qty > 0 ? ` · devuelto ${fmtQty(it.returned_qty)}` : ''} · {m(it.total)}
                  </p>
                </div>
                <Input
                  aria-label={`Cantidad a devolver de ${it.description}`}
                  inputMode="decimal"
                  placeholder="0"
                  value={qty[it.id] ?? ''}
                  onChange={(e) => setQty((q) => ({ ...q, [it.id]: e.target.value }))}
                  className={over ? 'w-20 border-red-400 text-center' : 'w-20 text-center'}
                />
                <Button type="button" variant="ghost" size="sm" onClick={() => setQty((q) => ({ ...q, [it.id]: String(max) }))}>
                  Todo
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Reembolso">
            <Select value={method} onChange={(e) => setMethod(e.target.value as RefundMethod)}>
              {methodOptions.map((k) => (
                <option key={k} value={k}>
                  {k === 'credit_note' ? 'Descontar de lo que debe (nota de crédito)' : PAYMENT_METHOD_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          {needsRegister && (
            <Field label="Caja de donde sale el dinero">
              {openRegisters.length ? (
                <Select value={effectiveRegister} onChange={(e) => setRegisterId(e.target.value)}>
                  {openRegisters.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <p className="rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800">No hay cajas abiertas.</p>
              )}
            </Field>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={restock}
            onChange={(e) => setRestock(e.target.checked)}
            className="h-5 w-5 rounded border-slate-300 text-brand-600"
          />
          Devolver los productos al inventario
        </label>

        <Field label="Motivo" required>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>

        {problem && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{problem}</p>}
        {detail.invoices.some((i) => i.source_type === 'sale' && !['error', 'voided', 'rejected'].includes(i.status)) && (
          <p className="text-xs text-slate-500">
            La venta tiene comprobante electrónico: se emitirá automáticamente una nota de crédito (e-CF 34).
          </p>
        )}
      </div>
    </Modal>
  )
}
