import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowDownCircle,
  ArrowUpCircle,
  Eye,
  History,
  Lock,
  LockOpen,
  Printer,
  Wallet,
} from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { RequireAccess } from '@/components/RequireAccess'
import { PageHeader } from '@/components/PageHeader'
import { ActionMenu, type ActionItem } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { EmptyState, PageLoader, Spinner } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useBranches, useRegisters } from '@/hooks/core'
import { useMemberNames, useTeamMembers } from '@/hooks/team'
import {
  useCashMove,
  useCashMovements,
  useCashSessionReport,
  useClosedSessions,
  useCloseCashSession,
  useOpenCashSession,
  useOpenSessions,
} from '@/hooks/cash'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import { fmtDateTime, money, num } from '@/lib/format'
import { CASH_KIND_LABEL, PAYMENT_METHOD_LABEL } from '@/lib/labels'
import { printCashReport } from '@/features/pos/receipt'
import type { CashMovementKind, CashRegister, CashSession, CashSessionReport, PaymentMethod } from '@/types/erp'

/*
 * Caja: sesiones abiertas con su "esperado" en vivo, entradas/salidas de
 * efectivo, arqueo y cierre, e historial.
 *
 * El esperado y la diferencia los calcula la base (cash_session_report /
 * close_cash_session) sumando el libro de movimientos; aquí solo se enseñan.
 * La diferencia que se ve ANTES de confirmar es orientativa: si entra una
 * venta mientras se cuenta, el cierre usa el esperado del momento exacto.
 */

export function CashPage() {
  return (
    <RequireAccess module={['cash', 'pos']}>
      <CashScreen />
    </RequireAccess>
  )
}

const r2 = (n: number) => Math.round(n * 100) / 100
const parseNum = (s: string) => {
  const n = Number(s.replace(/,/g, '.').trim())
  return Number.isFinite(n) ? n : NaN
}

/** Sobrante, faltante o cuadre: tono por signo (lookup, no ternarios). */
const DIFF_TONE = {
  zero: 'text-emerald-700',
  over: 'text-amber-700',
  short: 'text-red-600',
} as const
const diffKind = (d: number): keyof typeof DIFF_TONE => (Math.abs(d) < 0.005 ? 'zero' : d > 0 ? 'over' : 'short')
const DIFF_BADGE: Record<keyof typeof DIFF_TONE, 'green' | 'amber' | 'red'> = {
  zero: 'green',
  over: 'amber',
  short: 'red',
}
const DIFF_LABEL: Record<keyof typeof DIFF_TONE, string> = {
  zero: 'Cuadrada',
  over: 'Sobrante',
  short: 'Faltante',
}

type MoveState = { session: CashSession; kind: 'cash_in' | 'cash_out' } | null

function CashScreen() {
  const { user, tenant, can, memberRole } = useAuth()
  const open = useOpenSessions()
  const closed = useClosedSessions()
  const registers = useRegisters()
  const branches = useBranches()
  const members = useTeamMembers()
  const names = useMemberNames()
  const currency = tenant?.currency ?? 'DOP'
  const m = (n: number | null | undefined) => money(n ?? 0, currency)

  const [move, setMove] = useState<MoveState>(null)
  const [closing, setClosing] = useState<CashSession | null>(null)
  const [closedReport, setClosedReport] = useState<CashSessionReport | null>(null)
  const [opening, setOpening] = useState<CashRegister | null>(null)
  const [viewing, setViewing] = useState<CashSession | null>(null)

  const viewAll = can('cash.view_all')
  const regMap = useMemo(() => new Map((registers.data ?? []).map((r) => [r.id, r])), [registers.data])
  const branchName = useMemo(() => new Map((branches.data ?? []).map((b) => [b.id, b.name])), [branches.data])

  // Las mías primero: es la que el cajero viene a cerrar.
  const openSessions = useMemo(
    () =>
      [...(open.data ?? [])].sort((a, b) => Number(b.opened_by === user?.id) - Number(a.opened_by === user?.id)),
    [open.data, user?.id],
  )
  const openRegisterIds = new Set(openSessions.map((s) => s.register_id))
  const me = members.data?.find((mb) => mb.user_id === user?.id)
  const unrestricted = memberRole === 'owner' || memberRole === 'admin' || !me || me.branch_ids == null
  const closedRegisters = (registers.data ?? []).filter(
    (r) => r.is_active && !openRegisterIds.has(r.id) && (unrestricted || (me?.branch_ids ?? []).includes(r.branch_id)),
  )

  if (open.isLoading || registers.isLoading) return <PageLoader label="Cargando cajas…" />
  if (open.isError) {
    return (
      <EmptyState
        icon={<Wallet className="h-6 w-6" />}
        title="No se pudieron cargar las cajas"
        description={errorMessage(open.error)}
        action={
          <Button variant="outline" onClick={() => open.refetch()}>
            Reintentar
          </Button>
        }
      />
    )
  }

  const canManage = (s: CashSession) => s.opened_by === user?.id || viewAll

  return (
    <div className="space-y-6">
      <PageHeader title="Caja" description="Apertura, movimientos de efectivo, arqueo y cierre." />

      {/* ── Abiertas ── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Cajas abiertas</h2>
        {openSessions.length === 0 ? (
          <EmptyState
            icon={<Lock className="h-6 w-6" />}
            title="No hay cajas abiertas"
            description="Abre una caja para empezar a vender y registrar efectivo."
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {openSessions.map((s) => (
              <OpenSessionCard
                key={s.id}
                session={s}
                register={regMap.get(s.register_id) ?? null}
                branchName={branchName.get(s.branch_id) ?? null}
                openedByName={s.opened_by ? (names[s.opened_by] ?? '—') : '—'}
                mine={s.opened_by === user?.id}
                canSeeReport={canManage(s)}
                canMove={can('cash.move') && canManage(s)}
                canClose={can('cash.close') && canManage(s)}
                currency={currency}
                onMove={(kind) => setMove({ session: s, kind })}
                onClose={() => setClosing(s)}
                onView={() => setViewing(s)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Abrir ── */}
      {closedRegisters.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Cajas cerradas</h2>
          <Card>
            <ul className="divide-y divide-slate-100">
              {closedRegisters.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-800">{r.name}</p>
                    <p className="truncate text-xs text-slate-500">{branchName.get(r.branch_id) ?? ''}</p>
                  </div>
                  {can('cash.open') ? (
                    <Button variant="secondary" size="sm" onClick={() => setOpening(r)}>
                      <LockOpen className="h-4 w-4" /> Abrir
                    </Button>
                  ) : (
                    <Badge tone="slate">Cerrada</Badge>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {/* ── Historial ── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Historial de cierres {viewAll ? '' : '(tus cajas)'}
        </h2>
        {closed.isLoading ? (
          <PageLoader label="Cargando historial…" />
        ) : closed.isError ? (
          <EmptyState
            icon={<History className="h-6 w-6" />}
            title="No se pudo cargar el historial"
            description={errorMessage(closed.error)}
            action={
              <Button variant="outline" onClick={() => closed.refetch()}>
                Reintentar
              </Button>
            }
          />
        ) : (closed.data ?? []).length === 0 ? (
          <EmptyState icon={<History className="h-6 w-6" />} title="Aún no hay cierres" />
        ) : (
          <Card>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Sesión</th>
                    <th className="px-4 py-3">Caja</th>
                    <th className="px-4 py-3">Cajero</th>
                    <th className="px-4 py-3">Apertura</th>
                    <th className="px-4 py-3">Cierre</th>
                    <th className="px-4 py-3 text-right">Esperado</th>
                    <th className="px-4 py-3 text-right">Contado</th>
                    <th className="px-4 py-3 text-right">Diferencia</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {closed.data!.map((s) => {
                    const dk = diffKind(s.difference ?? 0)
                    return (
                      <tr key={s.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setViewing(s)}>
                        <td className="px-4 py-3 font-medium text-brand-700">{s.number}</td>
                        <td className="px-4 py-3">{regMap.get(s.register_id)?.name ?? '—'}</td>
                        <td className="max-w-[10rem] truncate px-4 py-3 text-slate-600">
                          {s.opened_by ? (names[s.opened_by] ?? '—') : '—'}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-600">{fmtDateTime(s.opened_at)}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-600">{fmtDateTime(s.closed_at)}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{m(s.expected_cash)}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{m(s.counted_cash)}</td>
                        <td className={cn('px-4 py-3 text-right font-semibold tabular-nums', DIFF_TONE[dk])}>
                          {m(s.difference)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <DataList>
              {closed.data!.map((s) => {
                const dk = diffKind(s.difference ?? 0)
                return (
                  <DataRow
                    key={s.id}
                    title={`${s.number} · ${regMap.get(s.register_id)?.name ?? ''}`}
                    subtitle={s.opened_by ? names[s.opened_by] : undefined}
                    onClick={() => setViewing(s)}
                    tone={dk === 'short' ? 'danger' : undefined}
                    badges={<Badge tone={DIFF_BADGE[dk]}>{DIFF_LABEL[dk]}</Badge>}
                    actions={
                      <ActionMenu
                        title={`Sesión ${s.number}`}
                        items={[{ label: 'Ver detalle', icon: <Eye className="h-4 w-4" />, onClick: () => setViewing(s) }]}
                      />
                    }
                  >
                    <DataFields>
                      <DataField label="Cierre">{fmtDateTime(s.closed_at)}</DataField>
                      <DataField label="Esperado">{m(s.expected_cash)}</DataField>
                      <DataField label="Contado">{m(s.counted_cash)}</DataField>
                      <DataField label="Diferencia">
                        <span className={DIFF_TONE[dk]}>{m(s.difference)}</span>
                      </DataField>
                    </DataFields>
                  </DataRow>
                )
              })}
            </DataList>
          </Card>
        )}
      </section>

      {move && <MoveModal state={move} currency={currency} onClose={() => setMove(null)} />}
      {opening && <OpenModal register={opening} onClose={() => setOpening(null)} />}
      {closing && (
        <CloseModal
          session={closing}
          registerName={regMap.get(closing.register_id)?.name ?? ''}
          currency={currency}
          onClose={() => setClosing(null)}
          onClosed={(report) => {
            setClosing(null)
            setClosedReport(report)
          }}
        />
      )}
      {closedReport && (
        <ClosedResultModal
          report={closedReport}
          currency={currency}
          closedByName={closedReport.session.closed_by ? names[closedReport.session.closed_by] : null}
          onClose={() => setClosedReport(null)}
        />
      )}
      {viewing && (
        <SessionDetailModal
          session={viewing}
          registerName={regMap.get(viewing.register_id)?.name ?? ''}
          currency={currency}
          names={names}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  )
}

// ── Tarjeta de caja abierta ─────────────────────────────────────────────────

function OpenSessionCard({
  session,
  register,
  branchName,
  openedByName,
  mine,
  canSeeReport,
  canMove,
  canClose,
  currency,
  onMove,
  onClose,
  onView,
}: {
  session: CashSession
  register: CashRegister | null
  branchName: string | null
  openedByName: string
  mine: boolean
  canSeeReport: boolean
  canMove: boolean
  canClose: boolean
  currency: string
  onMove: (kind: 'cash_in' | 'cash_out') => void
  onClose: () => void
  onView: () => void
}) {
  const { tenant } = useAuth()
  const report = useCashSessionReport(session.id, canSeeReport)
  const m = (n: number) => money(n, currency)
  const methods = Object.entries(report.data?.by_method ?? {})

  const more: ActionItem[] = [
    { label: 'Ver movimientos', icon: <Eye className="h-4 w-4" />, onClick: onView },
  ]
  if (report.data && tenant) {
    const data = report.data
    more.push({
      label: 'Imprimir corte parcial',
      icon: <Printer className="h-4 w-4" />,
      onClick: () => printCashReport({ tenant, report: data }),
    })
  }

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {register?.name ?? 'Caja'} {mine && <Badge tone="brand">Mía</Badge>}
          </span>
        }
        subtitle={`${session.number}${branchName ? ` · ${branchName}` : ''} · ${openedByName} · ${fmtDateTime(session.opened_at)}`}
        action={canSeeReport ? <ActionMenu title={`Caja ${register?.name ?? ''}`} items={more} /> : undefined}
      />
      <CardBody className="space-y-4">
        {!canSeeReport ? (
          <p className="text-sm text-slate-500">Abierta por otra persona. Solo quien la abrió o un supervisor ve su arqueo.</p>
        ) : report.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner size="sm" /> Calculando…
          </p>
        ) : report.isError ? (
          <p className="text-sm text-red-600">{errorMessage(report.error)}</p>
        ) : report.data ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-emerald-50 px-3 py-2">
                <p className="text-xs text-emerald-700">Efectivo esperado</p>
                <p className="text-xl font-bold tabular-nums text-emerald-900">{m(report.data.expected_cash)}</p>
                <p className="text-[11px] text-emerald-700">Fondo {m(session.opening_amount)}</p>
              </div>
              <div className="rounded-xl bg-slate-50 px-3 py-2">
                <p className="text-xs text-slate-500">Ventas</p>
                <p className="text-xl font-bold tabular-nums text-slate-900">{m(report.data.sales_total)}</p>
                <p className="text-[11px] text-slate-500">
                  {num(report.data.sales_count)} venta(s)
                  {report.data.credit_total > 0 ? ` · crédito ${m(report.data.credit_total)}` : ''}
                </p>
              </div>
            </div>
            {methods.length > 0 && (
              <dl className="space-y-1 text-sm">
                {methods.map(([k, v]) => (
                  <div key={k} className="flex justify-between text-slate-600">
                    <dt>{PAYMENT_METHOD_LABEL[k as PaymentMethod] ?? k}</dt>
                    <dd className="tabular-nums">{m(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </>
        ) : null}

        {(canMove || canClose) && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {canMove && (
              <>
                <Button variant="outline" size="sm" onClick={() => onMove('cash_in')}>
                  <ArrowDownCircle className="h-4 w-4 text-emerald-600" /> Entrada
                </Button>
                <Button variant="outline" size="sm" onClick={() => onMove('cash_out')}>
                  <ArrowUpCircle className="h-4 w-4 text-red-500" /> Salida
                </Button>
              </>
            )}
            {canClose && (
              <Button size="sm" className="col-span-2 sm:col-span-1" onClick={onClose}>
                <Lock className="h-4 w-4" /> Cerrar caja
              </Button>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

// ── Modales ─────────────────────────────────────────────────────────────────

function OpenModal({ register, onClose }: { register: CashRegister; onClose: () => void }) {
  const toast = useToast()
  const openSession = useOpenCashSession()
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    const v = amount.trim() === '' ? 0 : parseNum(amount)
    if (Number.isNaN(v) || v < 0) {
      toast.error('Indica un monto inicial válido')
      return
    }
    openSession.mutate(
      { registerId: register.id, openingAmount: r2(v), note: note.trim() || null },
      {
        onSuccess: () => {
          toast.success(`Caja ${register.name} abierta`)
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
      title={`Abrir caja · ${register.name}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => submit()} loading={openSession.isPending}>
            Abrir caja
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Fondo inicial (efectivo)">
          <Input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </Field>
        <Field label="Nota (opcional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  )
}

function MoveModal({ state, currency, onClose }: { state: NonNullable<MoveState>; currency: string; onClose: () => void }) {
  const toast = useToast()
  const cashMove = useCashMove()
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const isIn = state.kind === 'cash_in'
  const value = parseNum(amount)

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (Number.isNaN(value) || value <= 0) {
      toast.error('El monto debe ser mayor que cero')
      return
    }
    if (!note.trim()) {
      toast.error('Indica el motivo del movimiento')
      return
    }
    cashMove.mutate(
      { sessionId: state.session.id, kind: state.kind, amount: r2(value), note: note.trim() },
      {
        onSuccess: () => {
          toast.success(`${CASH_KIND_LABEL[state.kind]} de ${money(r2(value), currency)} registrada`)
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
      title={`${CASH_KIND_LABEL[state.kind]} · ${state.session.number}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant={isIn ? 'primary' : 'danger'}
            onClick={() => submit()}
            loading={cashMove.isPending}
            disabled={!note.trim() || !(value > 0)}
          >
            Registrar
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-600">
          {isIn
            ? 'Dinero que entra a la caja sin ser una venta (cambio, reposición del fondo…).'
            : 'Dinero que sale de la caja sin ser un gasto registrado (retiro a bóveda, depósito…).'}
        </p>
        <Field label="Monto" required>
          <Input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </Field>
        <Field label="Motivo" required>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={isIn ? 'Ej.: cambio para la caja' : 'Ej.: retiro parcial a bóveda'} />
        </Field>
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  )
}

function CloseModal({
  session,
  registerName,
  currency,
  onClose,
  onClosed,
}: {
  session: CashSession
  registerName: string
  currency: string
  onClose: () => void
  onClosed: (report: CashSessionReport) => void
}) {
  const toast = useToast()
  const report = useCashSessionReport(session.id)
  const close = useCloseCashSession()
  const [counted, setCounted] = useState('')
  const [notes, setNotes] = useState('')
  const m = (n: number) => money(n, currency)

  const value = parseNum(counted)
  const hasValue = counted.trim() !== '' && !Number.isNaN(value) && value >= 0
  const expected = report.data?.expected_cash ?? 0
  const diff = hasValue ? r2(value - expected) : 0
  const dk = diffKind(diff)

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (!hasValue) {
      toast.error('Indica el efectivo contado')
      return
    }
    close.mutate(
      { sessionId: session.id, countedCash: r2(value), notes: notes.trim() || null },
      {
        onSuccess: (r) => {
          toast.success(`Caja ${registerName} cerrada`)
          onClosed(r)
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Cerrar caja · ${registerName}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => submit()} loading={close.isPending} disabled={!hasValue || report.isLoading}>
            Confirmar cierre
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {report.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner size="sm" /> Calculando el esperado…
          </p>
        ) : report.isError ? (
          <p className="text-sm text-red-600">{errorMessage(report.error)}</p>
        ) : (
          <div className="rounded-xl bg-slate-50 px-3 py-2 text-sm">
            <div className="flex justify-between text-slate-600">
              <span>Fondo inicial</span>
              <span className="tabular-nums">{m(session.opening_amount)}</span>
            </div>
            {Object.entries(report.data?.by_kind ?? {}).map(([k, v]) => (
              <div key={k} className="flex justify-between text-slate-600">
                <span>{CASH_KIND_LABEL[k as CashMovementKind] ?? k}</span>
                <span className="tabular-nums">{m(v)}</span>
              </div>
            ))}
            <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 font-semibold text-slate-800">
              <span>Efectivo esperado</span>
              <span className="tabular-nums">{m(expected)}</span>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              Los conceptos incluyen tarjeta y transferencia; el esperado es solo el efectivo.
            </p>
          </div>
        )}
        <Field label="Efectivo contado" required hint="Cuenta billetes y monedas de la gaveta.">
          <Input inputMode="decimal" placeholder="0.00" value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus className="text-lg" />
        </Field>
        {hasValue && report.data && (
          <div className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2">
            <span className="text-sm text-slate-600">{DIFF_LABEL[dk]}</span>
            <span className={cn('text-xl font-bold tabular-nums', DIFF_TONE[dk])}>{m(diff)}</span>
          </div>
        )}
        <Field label="Observaciones (opcional)">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  )
}

function ClosedResultModal({
  report,
  currency,
  closedByName,
  onClose,
}: {
  report: CashSessionReport
  currency: string
  closedByName: string | null | undefined
  onClose: () => void
}) {
  const { tenant } = useAuth()
  const toast = useToast()
  const s = report.session
  const dk = diffKind(s.difference ?? 0)
  const m = (n: number | null) => money(n ?? 0, currency)

  const print = () => {
    if (!tenant) return
    try {
      printCashReport({ tenant, report, closedByName })
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo imprimir'))
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Caja cerrada · ${s.number}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Listo
          </Button>
          <Button onClick={print} autoFocus>
            <Printer className="h-4 w-4" /> Imprimir cierre
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-slate-50 px-2 py-2">
            <p className="text-[11px] text-slate-500">Esperado</p>
            <p className="font-semibold tabular-nums">{m(s.expected_cash)}</p>
          </div>
          <div className="rounded-xl bg-slate-50 px-2 py-2">
            <p className="text-[11px] text-slate-500">Contado</p>
            <p className="font-semibold tabular-nums">{m(s.counted_cash)}</p>
          </div>
          <div className="rounded-xl bg-slate-50 px-2 py-2">
            <p className="text-[11px] text-slate-500">{DIFF_LABEL[dk]}</p>
            <p className={cn('font-bold tabular-nums', DIFF_TONE[dk])}>{m(s.difference)}</p>
          </div>
        </div>
        <p className="text-slate-600">
          {num(report.sales_count)} venta(s) por {m(report.sales_total)}
          {report.credit_total > 0 ? `, ${m(report.credit_total)} a crédito` : ''}.
        </p>
      </div>
    </Modal>
  )
}

function SessionDetailModal({
  session,
  registerName,
  currency,
  names,
  onClose,
}: {
  session: CashSession
  registerName: string
  currency: string
  names: Record<string, string>
  onClose: () => void
}) {
  const { tenant } = useAuth()
  const report = useCashSessionReport(session.id)
  const movements = useCashMovements(session.id)
  const m = (n: number | null | undefined) => money(n ?? 0, currency)
  const closed = session.status === 'closed'
  const dk = diffKind(session.difference ?? 0)

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`${session.number} · ${registerName}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cerrar
          </Button>
          <Button
            disabled={!report.data || !tenant}
            onClick={() =>
              report.data &&
              tenant &&
              printCashReport({
                tenant,
                report: report.data,
                closedByName: session.closed_by ? names[session.closed_by] : null,
              })
            }
          >
            <Printer className="h-4 w-4" /> Imprimir
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          <Info label="Abrió">{session.opened_by ? (names[session.opened_by] ?? '—') : '—'}</Info>
          <Info label="Apertura">{fmtDateTime(session.opened_at)}</Info>
          <Info label="Fondo inicial">{m(session.opening_amount)}</Info>
          {closed && (
            <>
              <Info label="Cerró">{session.closed_by ? (names[session.closed_by] ?? '—') : '—'}</Info>
              <Info label="Cierre">{fmtDateTime(session.closed_at)}</Info>
              <Info label="Esperado / contado">
                {m(session.expected_cash)} / {m(session.counted_cash)}
              </Info>
              <Info label={DIFF_LABEL[dk]}>
                <span className={cn('font-semibold', DIFF_TONE[dk])}>{m(session.difference)}</span>
              </Info>
            </>
          )}
          {!closed && report.data && <Info label="Efectivo esperado">{m(report.data.expected_cash)}</Info>}
        </dl>
        {session.notes && <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">{session.notes}</p>}
        {report.isError && <p className="text-sm text-red-600">{errorMessage(report.error)}</p>}

        <div>
          <h4 className="mb-2 text-sm font-semibold text-slate-700">Movimientos</h4>
          {movements.isLoading ? (
            <p className="flex items-center gap-2 text-sm text-slate-500">
              <Spinner size="sm" /> Cargando…
            </p>
          ) : movements.isError ? (
            <p className="text-sm text-red-600">{errorMessage(movements.error)}</p>
          ) : (movements.data ?? []).length === 0 ? (
            <p className="text-sm text-slate-500">Sin movimientos.</p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Hora</th>
                      <th className="px-3 py-2">Concepto</th>
                      <th className="px-3 py-2">Método</th>
                      <th className="px-3 py-2">Detalle</th>
                      <th className="px-3 py-2 text-right">Monto</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {movements.data!.map((mv) => (
                      <tr key={mv.id}>
                        <td className="whitespace-nowrap px-3 py-2 text-slate-500">{fmtDateTime(mv.created_at)}</td>
                        <td className="px-3 py-2">{CASH_KIND_LABEL[mv.kind]}</td>
                        <td className="px-3 py-2 text-slate-600">{PAYMENT_METHOD_LABEL[mv.method]}</td>
                        <td className="max-w-[14rem] truncate px-3 py-2 text-slate-600">
                          <MovementRef refType={mv.reference_type} refId={mv.reference_id} note={mv.note} />
                        </td>
                        <td
                          className={cn(
                            'px-3 py-2 text-right font-medium tabular-nums',
                            mv.amount < 0 ? 'text-red-600' : 'text-slate-800',
                          )}
                        >
                          {m(mv.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <DataList>
                {movements.data!.map((mv) => (
                  <DataRow
                    key={mv.id}
                    title={CASH_KIND_LABEL[mv.kind]}
                    titleExtra={`${fmtDateTime(mv.created_at)} · ${PAYMENT_METHOD_LABEL[mv.method]}${mv.created_by ? ` · ${names[mv.created_by] ?? ''}` : ''}`}
                    subtitle={<MovementRef refType={mv.reference_type} refId={mv.reference_id} note={mv.note} />}
                    badges={
                      <span className={cn('text-sm font-semibold tabular-nums', mv.amount < 0 ? 'text-red-600' : 'text-slate-800')}>
                        {m(mv.amount)}
                      </span>
                    }
                  />
                ))}
              </DataList>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

function MovementRef({ refType, refId, note }: { refType: string | null; refId: string | null; note: string | null }) {
  if (refType === 'sale' && refId) {
    return (
      <Link to={`/ventas/${refId}`} className="text-brand-700 hover:underline">
        Ver venta{note ? ` · ${note}` : ''}
      </Link>
    )
  }
  return <span>{note ?? '—'}</span>
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="truncate text-slate-700">{children}</dd>
    </div>
  )
}
