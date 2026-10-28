import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Eye, FileX, RotateCcw, X } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import {
  ECF_LIST_LIMIT,
  useElectronicInvoices,
  useEcfTypes,
  useInvoiceEvents,
  useRetryEcf,
  type EcfInvoiceFilters,
} from '@/hooks/invoicing'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Field, Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Modal } from '@/components/ui/Modal'
import { ActionMenu, type ActionItem } from '@/components/ui/ActionMenu'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { EmptyState, Spinner } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { ECF_STATUS } from '@/lib/labels'
import { fmtDateTime, money } from '@/lib/format'
import { errorMessage } from '@/lib/errors'
import { SimBadge, ecfTypeLabel, ENV_INFO } from '@/features/invoicing/shared'
import type { EcfStatus, ElectronicInvoice, ElectronicInvoiceEvent, FiscalSettings } from '@/types/erp'

const EMPTY_FILTERS: EcfInvoiceFilters = { status: '', type: '', from: '', to: '' }

const STATUS_OPTIONS = Object.entries(ECF_STATUS) as [EcfStatus, { label: string }][]

/** Etiquetas de los eventos de la bitácora (electronic_invoice_events.event). */
const EVENT_LABEL: Record<string, string> = {
  created: 'Creado con e-NCF asignado',
  provider_result: 'Respuesta del proveedor',
  manual_retry: 'Reintento manual',
}

export function InvoicesTab({ timezone }: { timezone: string }) {
  const { can, tenant } = useAuth()
  const [filters, setFilters] = useState<EcfInvoiceFilters>(EMPTY_FILTERS)
  const [detail, setDetail] = useState<ElectronicInvoice | null>(null)
  const invoices = useElectronicInvoices(filters, timezone)
  const types = useEcfTypes()
  const retry = useRetryEcf()
  const toast = useToast()
  const canRetry = can('ecf.manage')
  const currency = tenant?.currency
  const filtered = Object.values(filters).some(Boolean)

  const doRetry = (inv: ElectronicInvoice) =>
    retry.mutate(inv.id, {
      onSuccess: () => {
        toast.success(`${inv.encf} vuelve a la cola. Pulsa “Procesar cola ahora” para enviarlo ya.`)
        setDetail(null)
      },
      onError: (e) => toast.error(errorMessage(e, 'No se pudo reintentar.')),
    })

  const actionsFor = (inv: ElectronicInvoice): ActionItem[] => {
    const items: ActionItem[] = [{ label: 'Ver detalle', icon: <Eye className="h-4 w-4" />, onClick: () => setDetail(inv) }]
    if (inv.status === 'error' && canRetry) {
      items.push({ label: 'Reintentar envío', icon: <RotateCcw className="h-4 w-4" />, onClick: () => doRetry(inv) })
    }
    return items
  }

  const set = <K extends keyof EcfInvoiceFilters>(k: K, v: EcfInvoiceFilters[K]) => setFilters((f) => ({ ...f, [k]: v }))

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
          <Field label="Estado">
            <Select value={filters.status} onChange={(e) => set('status', e.target.value as EcfStatus | '')}>
              <option value="">Todos</option>
              {STATUS_OPTIONS.map(([code, s]) => (
                <option key={code} value={code}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tipo">
            <Select value={filters.type} onChange={(e) => set('type', e.target.value)}>
              <option value="">Todos</option>
              {types.data?.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.code} · {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Desde">
            <Input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set('from', e.target.value)} />
          </Field>
          <Field label="Hasta">
            <Input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set('to', e.target.value)} />
          </Field>
          <Button variant="ghost" onClick={() => setFilters(EMPTY_FILTERS)} disabled={!filtered}>
            <X className="h-4 w-4" /> Limpiar
          </Button>
        </CardBody>
      </Card>

      {invoices.isLoading ? (
        <div className="flex items-center justify-center gap-3 py-12 text-sm text-slate-500">
          <Spinner /> Cargando comprobantes…
        </div>
      ) : invoices.isError ? (
        <Card>
          <CardBody className="space-y-3 text-center">
            <p className="text-sm text-red-600">{errorMessage(invoices.error, 'No se pudieron cargar los comprobantes.')}</p>
            <Button variant="outline" size="sm" onClick={() => void invoices.refetch()}>
              Reintentar
            </Button>
          </CardBody>
        </Card>
      ) : !invoices.data?.length ? (
        <EmptyState
          icon={<FileX className="h-6 w-6" />}
          title={filtered ? 'Ningún comprobante con esos filtros' : 'Aún no hay comprobantes electrónicos'}
          description={
            filtered
              ? 'Prueba con otro estado, tipo o rango de fechas.'
              : 'Se crean al vender con e-CF activado: cada venta reserva su e-NCF y queda en cola para enviarse.'
          }
        />
      ) : (
        <Card>
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">e-NCF</th>
                  <th className="px-4 py-2.5 font-medium">Tipo</th>
                  <th className="px-4 py-2.5 font-medium">Comprador</th>
                  <th className="px-4 py-2.5 text-right font-medium">Total</th>
                  <th className="px-4 py-2.5 font-medium">Estado</th>
                  <th className="px-4 py-2.5 font-medium">Intentos</th>
                  <th className="px-4 py-2.5 font-medium">Fecha</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {invoices.data.map((inv) => (
                  <tr key={inv.id} className="align-top hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => setDetail(inv)}
                        className="font-mono font-semibold text-slate-800 hover:text-brand-600"
                      >
                        {inv.encf}
                      </button>
                      {inv.simulated && (
                        <div className="mt-1">
                          <SimBadge />
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{ecfTypeLabel(inv.ecf_type, types.data)}</td>
                    <td className="px-4 py-3">
                      <BuyerCell inv={inv} />
                    </td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums text-slate-800">
                      {money(inv.total, inv.currency || currency)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={ECF_STATUS[inv.status].tone}>{ECF_STATUS[inv.status].label}</Badge>
                    </td>
                    <td className="max-w-[16rem] px-4 py-3 text-slate-600">
                      <span className="tabular-nums">{inv.attempts}</span>
                      {inv.last_error && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-red-600" title={inv.last_error}>
                          {inv.last_error}
                        </p>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-500">{fmtDateTime(inv.issue_date)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        {inv.status === 'error' && canRetry && (
                          <Button variant="outline" size="sm" onClick={() => doRetry(inv)} loading={retry.isPending && retry.variables === inv.id}>
                            <RotateCcw className="h-4 w-4" /> Reintentar
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => setDetail(inv)}>
                          Ver
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DataList>
            {invoices.data.map((inv) => (
              <DataRow
                key={inv.id}
                title={<span className="font-mono">{inv.encf}</span>}
                titleExtra={ecfTypeLabel(inv.ecf_type, types.data)}
                onClick={() => setDetail(inv)}
                tone={inv.status === 'error' || inv.status === 'rejected' ? 'danger' : undefined}
                badges={
                  <>
                    <Badge tone={ECF_STATUS[inv.status].tone}>{ECF_STATUS[inv.status].label}</Badge>
                    {inv.simulated && <SimBadge />}
                  </>
                }
                actions={<ActionMenu items={actionsFor(inv)} title={inv.encf} />}
              >
                <DataFields>
                  <DataField label="Comprador">{inv.buyer_name || 'Consumidor final'}</DataField>
                  <DataField label="Total">{money(inv.total, inv.currency || currency)}</DataField>
                  <DataField label="Fecha">{fmtDateTime(inv.issue_date)}</DataField>
                  <DataField label="Intentos">{inv.attempts}</DataField>
                  {inv.last_error && (
                    <DataField label="Último error" wrap className="col-span-2">
                      <span className="text-red-600">{inv.last_error}</span>
                    </DataField>
                  )}
                </DataFields>
              </DataRow>
            ))}
          </DataList>
          {invoices.data.length >= ECF_LIST_LIMIT && (
            <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
              Se muestran los {ECF_LIST_LIMIT} más recientes. Usa los filtros para acotar la búsqueda.
            </p>
          )}
        </Card>
      )}

      <InvoiceDetailModal
        invoice={detail}
        onClose={() => setDetail(null)}
        typeLabel={detail ? ecfTypeLabel(detail.ecf_type, types.data) : ''}
        currency={currency}
        canRetry={canRetry}
        retrying={retry.isPending}
        onRetry={doRetry}
      />
    </div>
  )
}

function BuyerCell({ inv }: { inv: ElectronicInvoice }) {
  if (!inv.buyer_name && !inv.buyer_id) return <span className="text-slate-400">Consumidor final</span>
  return (
    <div className="min-w-0">
      <p className="truncate text-slate-800">{inv.buyer_name ?? '—'}</p>
      {inv.buyer_id && (
        <p className="text-xs text-slate-400">
          {(inv.buyer_id_type ?? '').toUpperCase()} {inv.buyer_id}
        </p>
      )}
    </div>
  )
}

function InvoiceDetailModal({
  invoice,
  onClose,
  typeLabel,
  currency,
  canRetry,
  retrying,
  onRetry,
}: {
  invoice: ElectronicInvoice | null
  onClose: () => void
  typeLabel: string
  currency?: string
  canRetry: boolean
  retrying: boolean
  onRetry: (inv: ElectronicInvoice) => void
}) {
  const events = useInvoiceEvents(invoice?.id ?? null)
  if (!invoice) return null
  const cur = invoice.currency || currency
  const env = ENV_INFO[invoice.environment as FiscalSettings['environment']]

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={<span className="font-mono">{invoice.encf}</span>}
      footer={
        <>
          {invoice.status === 'error' && canRetry && (
            <Button variant="outline" onClick={() => onRetry(invoice)} loading={retrying}>
              <RotateCcw className="h-4 w-4" /> Reintentar
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cerrar
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={ECF_STATUS[invoice.status].tone}>{ECF_STATUS[invoice.status].label}</Badge>
          {invoice.simulated && <SimBadge />}
          {env && <Badge tone={env.tone}>Ambiente: {env.label}</Badge>}
        </div>

        {invoice.simulated && (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Emitido con el simulador: <strong>sin validez fiscal</strong>. La DGII no tiene registro de este comprobante.
          </p>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
          <Info label="Tipo" wide>
            {typeLabel}
          </Info>
          <Info label="Fecha de emisión">{fmtDateTime(invoice.issue_date)}</Info>
          <Info label="Comprador" wide>
            {invoice.buyer_name || 'Consumidor final'}
            {invoice.buyer_id && (
              <span className="block text-xs text-slate-500">
                {(invoice.buyer_id_type ?? '').toUpperCase()} {invoice.buyer_id}
              </span>
            )}
          </Info>
          <Info label="Subtotal">{money(invoice.subtotal, cur)}</Info>
          <Info label="ITBIS">{money(invoice.tax_total, cur)}</Info>
          <Info label="Total">
            <strong>{money(invoice.total, cur)}</strong>
          </Info>
          {invoice.reference_encf && <Info label="Modifica a">{invoice.reference_encf}</Info>}
          <Info label="Track ID">{invoice.track_id ?? '—'}</Info>
          <Info label="Código de seguridad">{invoice.security_code ?? '—'}</Info>
          <Info label="Intentos">{invoice.attempts}</Info>
          {invoice.sent_at && <Info label="Enviado">{fmtDateTime(invoice.sent_at)}</Info>}
          {invoice.resolved_at && <Info label="Resuelto">{fmtDateTime(invoice.resolved_at)}</Info>}
          {['pending', 'sent', 'error'].includes(invoice.status) && (
            <Info label="Próximo intento">{fmtDateTime(invoice.next_attempt_at)}</Info>
          )}
          <Info label="Origen">
            {invoice.source_type === 'sale' ? (
              <Link to={`/ventas/${invoice.source_id}`} className="font-medium text-brand-600 hover:underline">
                Ver venta
              </Link>
            ) : (
              'Devolución de venta'
            )}
          </Info>
        </dl>

        {invoice.last_error && (
          <div className="flex gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="min-w-0 break-words">{invoice.last_error}</p>
          </div>
        )}

        {invoice.status === 'rejected' && (
          <p className="text-xs text-slate-500">
            Un rechazo no se reintenta: el contenido del documento tenía un problema. Corrige el dato (por ejemplo, el
            RNC del cliente) y emite un nuevo comprobante.
          </p>
        )}

        {invoice.messages.length > 0 && (
          <section>
            <h4 className="mb-2 text-sm font-semibold text-slate-800">Mensajes</h4>
            <ul className="space-y-1.5">
              {invoice.messages.map((m, i) => (
                <li key={i} className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
                  {m.code && <span className="mr-2 font-mono text-xs text-slate-400">{m.code}</span>}
                  {m.message ?? '—'}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h4 className="mb-2 text-sm font-semibold text-slate-800">Historial</h4>
          {events.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Spinner size="sm" /> Cargando historial…
            </div>
          ) : events.isError ? (
            <p className="text-sm text-red-600">{errorMessage(events.error, 'No se pudo cargar el historial.')}</p>
          ) : (
            <Timeline events={events.data ?? []} />
          )}
        </section>
      </div>
    </Modal>
  )
}

function Info({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2 min-w-0 sm:col-span-1' : 'min-w-0'}>
      <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="break-words text-slate-800">{children}</dd>
    </div>
  )
}

/** Lee mensajes/error del `detail` saneado del evento sin confiar en su forma. */
function eventNotes(detail: Record<string, unknown> | null): string[] {
  if (!detail) return []
  const out: string[] = []
  if (typeof detail.error === 'string' && detail.error) out.push(detail.error)
  if (Array.isArray(detail.messages)) {
    for (const m of detail.messages) {
      if (m && typeof m === 'object' && typeof (m as { message?: unknown }).message === 'string') {
        out.push((m as { message: string }).message)
      }
    }
  }
  if (typeof detail.track_id === 'string' && detail.track_id) out.push(`Track ID: ${detail.track_id}`)
  return out
}

function Timeline({ events }: { events: ElectronicInvoiceEvent[] }) {
  if (!events.length) return <p className="text-sm text-slate-500">Sin eventos registrados.</p>
  return (
    <ol className="relative space-y-4 border-l border-slate-200 pl-5">
      {events.map((ev) => {
        const to = ev.status_to ? ECF_STATUS[ev.status_to] : null
        const notes = eventNotes(ev.detail)
        return (
          <li key={ev.id} className="relative">
            <span className="absolute -left-[1.6rem] top-1 h-2.5 w-2.5 rounded-full bg-brand-500 ring-4 ring-white" />
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-slate-800">{EVENT_LABEL[ev.event] ?? ev.event}</span>
              {to && <Badge tone={to.tone}>{to.label}</Badge>}
            </div>
            <p className="text-xs text-slate-400">{fmtDateTime(ev.created_at)}</p>
            {notes.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
                {notes.map((n, i) => (
                  <li key={i} className="break-words">
                    {n}
                  </li>
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ol>
  )
}
