import { useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { addDays, format, parseISO, startOfWeek } from 'date-fns'
import { es } from 'date-fns/locale'
import {
  Ban,
  Banknote,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  MessageCircle,
  Pencil,
  Play,
  Plus,
  Printer,
  Receipt,
  UserCheck,
  UserX,
} from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { PageHeader } from '@/components/PageHeader'
import { RequireAccess } from '@/components/RequireAccess'
import { ActionMenu, type ActionItem } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useAppointments, useSetAppointmentStatus } from '@/hooks/appointments'
import { useBranches, useCustomerBalances, useCustomers, useRegisters } from '@/hooks/core'
import { useSaleDetailFetcher } from '@/hooks/sales'
import { useTeamMembers } from '@/hooks/team'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import { fmtDate, fmtWeekday } from '@/lib/format'
import { APPOINTMENT_STATUS, newClientUid } from '@/lib/labels'
import { printSaleReceipt } from '@/features/pos/receipt'
import type { Appointment, AppointmentStatus, CreateSaleResult, Customer } from '@/types/erp'
import { AppointmentCheckoutModal, CheckoutSuccess } from './AppointmentCheckoutModal'
import { AppointmentFormModal } from './AppointmentFormModal'
import { dayStart, fmtTime, isClosed, shiftDay, todayKey, whatsappReminderUrl } from './shared'

/*
 * Agenda de citas por día.
 *
 * Se pide la SEMANA del día elegido en una sola consulta: la tira de días
 * enseña cuántas citas tiene cada uno y moverse dentro de la semana no vuelve
 * a la red. El día se filtra aquí.
 *
 * Leer la agenda basta con tener el módulo; agendar y cambiar estados exige
 * appointments.manage, y cobrar, sales.create (lo vuelven a comprobar las RPC).
 */

type View = 'list' | 'staff'

/** Color de la franja lateral de cada cita: el estado se ve sin leer la etiqueta. */
const STATUS_BAR: Record<AppointmentStatus, string> = {
  scheduled: 'border-slate-300',
  confirmed: 'border-brand-500',
  in_progress: 'border-amber-400',
  done: 'border-emerald-500',
  canceled: 'border-red-300',
  no_show: 'border-slate-200',
}

export function AppointmentsPage() {
  return (
    <RequireAccess module="appointments">
      <AppointmentsContent />
    </RequireAccess>
  )
}

function AppointmentsContent() {
  const toast = useToast()
  const navigate = useNavigate()
  const { tenant, can, hasModule } = useAuth()
  const canManage = can('appointments.manage')
  const canCharge = can('sales.create') && hasModule('pos')
  const currency = tenant?.currency ?? 'DOP'

  const [day, setDay] = useState(todayKey)
  const [staff, setStaff] = useState('')
  const [view, setView] = useState<View>('list')
  const [editing, setEditing] = useState<{ appointment: Appointment | null } | null>(null)
  const [canceling, setCanceling] = useState<Appointment | null>(null)
  const [charging, setCharging] = useState<{ appointment: Appointment; uid: string } | null>(null)
  const [result, setResult] = useState<{ r: CreateSaleResult; registerId: string } | null>(null)
  const [printing, setPrinting] = useState(false)
  // client_uid por cita: se conserva entre aperturas del cobro hasta que la
  // base lo confirme, para que un reintento tras un corte no cobre dos veces.
  const uids = useRef<Record<string, string>>({})

  const weekStart = startOfWeek(dayStart(day), { weekStartsOn: 1 })
  const range = { from: weekStart.toISOString(), to: addDays(weekStart, 7).toISOString(), staffId: staff }
  const appts = useAppointments(range)
  const customers = useCustomers()
  const balances = useCustomerBalances()
  const members = useTeamMembers()
  const registers = useRegisters()
  const branches = useBranches()
  const setStatus = useSetAppointmentStatus()
  const fetchSale = useSaleDetailFetcher()

  const customerById = useMemo(() => new Map((customers.data ?? []).map((c) => [c.id, c])), [customers.data])
  const memberName = useMemo(
    () => new Map((members.data ?? []).map((m) => [m.user_id, m.full_name ?? m.email ?? 'Sin nombre'])),
    [members.data],
  )
  const staffOptions = useMemo(() => (members.data ?? []).filter((m) => m.is_active), [members.data])

  const week = useMemo(() => {
    const all = appts.data ?? []
    return Array.from({ length: 7 }, (_, i) => {
      const start = addDays(weekStart, i)
      const end = addDays(start, 1)
      const key = format(start, 'yyyy-MM-dd')
      const items = all.filter((a) => parseISO(a.starts_at) < end && parseISO(a.ends_at) > start)
      return { key, date: start, items }
    })
    // weekStart se deriva de `day`: depender de su ISO evita recalcular con cada render.
  }, [appts.data, range.from])

  const today = todayKey()
  const rows = week.find((d) => d.key === day)?.items ?? []
  const active = rows.filter((a) => a.status !== 'canceled' && a.status !== 'no_show')

  const customerOf = (a: Appointment): Customer | null => (a.customer_id ? (customerById.get(a.customer_id) ?? null) : null)
  const whoOf = (a: Appointment) => customerOf(a)?.name ?? a.contact_name ?? 'Cliente'
  const phoneOf = (a: Appointment) => (a.customer_id ? (customerOf(a)?.phone ?? null) : a.contact_phone)
  const staffOf = (a: Appointment) => (a.staff_id ? (memberName.get(a.staff_id) ?? 'Profesional') : 'Sin asignar')

  const changeStatus = (a: Appointment, status: AppointmentStatus, done: string) =>
    setStatus.mutate(
      { id: a.id, status },
      {
        onSuccess: () => toast.success(done),
        onError: (err) => toast.error(errorMessage(err, 'No se pudo cambiar el estado')),
      },
    )

  const openCharge = (a: Appointment) => {
    const uid = uids.current[a.id] ?? newClientUid()
    uids.current[a.id] = uid
    setCharging({ appointment: a, uid })
  }

  const actionsFor = (a: Appointment): ActionItem[] => {
    const items: ActionItem[] = []
    const closed = isClosed(a)
    const open = !closed && !a.sale_id
    if (canManage && open) {
      items.push({ label: 'Editar', icon: <Pencil className="h-4 w-4" />, onClick: () => setEditing({ appointment: a }) })
      if (a.status === 'scheduled') {
        items.push({
          label: 'Confirmar',
          icon: <UserCheck className="h-4 w-4" />,
          onClick: () => changeStatus(a, 'confirmed', 'Cita confirmada'),
        })
      }
      if (a.status === 'scheduled' || a.status === 'confirmed') {
        items.push({
          label: 'Iniciar atención',
          icon: <Play className="h-4 w-4" />,
          onClick: () => changeStatus(a, 'in_progress', 'Atención iniciada'),
        })
      }
      items.push({
        label: 'Marcar atendida',
        icon: <CheckCircle2 className="h-4 w-4" />,
        tone: 'success',
        hint: canCharge ? 'Sin cobrar ahora: se puede cobrar después' : undefined,
        onClick: () => changeStatus(a, 'done', 'Cita marcada como atendida'),
      })
      if (a.status === 'scheduled' || a.status === 'confirmed') {
        items.push({
          label: 'No asistió',
          icon: <UserX className="h-4 w-4" />,
          onClick: () => changeStatus(a, 'no_show', 'Cita marcada como no asistida'),
        })
      }
    }
    // appt_checkout también cobra una cita ya "atendida" sin venta: atender
    // primero y cobrar en recepción después es el flujo normal de un consultorio.
    if (canCharge && !a.sale_id && a.status !== 'canceled' && a.status !== 'no_show') {
      items.push({ label: 'Cobrar', icon: <Banknote className="h-4 w-4" />, tone: 'success', onClick: () => openCharge(a) })
    }
    const wa = !closed
      ? whatsappReminderUrl({
          phone: phoneOf(a),
          name: whoOf(a),
          title: a.title,
          startsAt: a.starts_at,
          business: tenant?.name ?? null,
        })
      : null
    if (wa) {
      items.push({
        label: 'Recordar por WhatsApp',
        icon: <MessageCircle className="h-4 w-4" />,
        onClick: () => window.open(wa, '_blank', 'noopener,noreferrer'),
      })
    }
    if (a.sale_id && hasModule('pos')) {
      items.push({
        label: 'Ver venta',
        icon: <Receipt className="h-4 w-4" />,
        onClick: () => navigate(`/ventas/${a.sale_id}`),
      })
    }
    if (canManage && open) {
      items.push({ label: 'Cancelar cita', icon: <Ban className="h-4 w-4" />, tone: 'danger', onClick: () => setCanceling(a) })
    }
    return items
  }

  const printReceipt = async () => {
    if (!result || !tenant) return
    setPrinting(true)
    try {
      const sd = await fetchSale(result.r.sale_id)
      printSaleReceipt({
        tenant,
        detail: sd,
        register: registers.data?.find((r) => r.id === result.registerId) ?? null,
        branch: branches.data?.find((b) => b.id === sd.sale.branch_id) ?? null,
        cashierName: sd.sale.created_by ? (memberName.get(sd.sale.created_by) ?? null) : null,
        sellerName: sd.sale.seller_id ? (memberName.get(sd.sale.seller_id) ?? null) : null,
      })
    } catch (err) {
      toast.error(`La venta está guardada, pero no se pudo imprimir: ${errorMessage(err)}`)
    } finally {
      setPrinting(false)
    }
  }

  // Vista por profesional (solo pantalla ancha): una columna por quien tiene citas ese día.
  const columns = useMemo(() => {
    const ids = [...new Set(rows.map((a) => a.staff_id ?? ''))]
    return ids
      .sort((x, y) => (x === '' ? 1 : y === '' ? -1 : (memberName.get(x) ?? '').localeCompare(memberName.get(y) ?? '')))
      .map((id) => ({ id, name: id ? (memberName.get(id) ?? 'Profesional') : 'Sin asignar', items: rows.filter((a) => (a.staff_id ?? '') === id) }))
  }, [rows, memberName])
  const byStaff = view === 'staff' && staff === '' && columns.length > 1

  const newAppointment = () => setEditing({ appointment: null })

  const card = (a: Appointment, showStaff: boolean) => (
    <AppointmentCard
      key={a.id}
      a={a}
      who={whoOf(a)}
      phone={phoneOf(a)}
      staffName={showStaff ? staffOf(a) : null}
      actions={actionsFor(a)}
      onOpen={canManage && !isClosed(a) && !a.sale_id ? () => setEditing({ appointment: a }) : undefined}
    />
  )

  return (
    <div>
      <PageHeader
        title="Citas"
        description="Agenda por profesional: confirma, atiende, recuerda por WhatsApp y cobra."
        action={
          canManage ? (
            <Button onClick={newAppointment}>
              <Plus className="h-4 w-4" /> Nueva cita
            </Button>
          ) : undefined
        }
      />

      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" aria-label="Día anterior" onClick={() => setDay((d) => shiftDay(d, -1))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant={day === today ? 'secondary' : 'outline'} onClick={() => setDay(todayKey())}>
              Hoy
            </Button>
            <Button variant="outline" size="icon" aria-label="Día siguiente" onClick={() => setDay((d) => shiftDay(d, 1))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <Input
            type="date"
            aria-label="Ir a la fecha"
            value={day}
            onChange={(e) => e.target.value && setDay(e.target.value)}
            className="w-auto min-w-0 flex-1 sm:w-44 sm:flex-none"
          />
        </div>

        <WeekStrip days={week} selected={day} today={today} onPick={setDay} />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Profesional">
            <Select value={staff} onChange={(e) => setStaff(e.target.value)}>
              <option value="">Todos</option>
              {staffOptions.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.full_name ?? m.email ?? 'Sin nombre'}
                </option>
              ))}
              <option value="none">Sin asignar</option>
            </Select>
          </Field>
          {staff === '' && columns.length > 1 && (
            <div className="hidden items-end lg:flex">
              <Segmented<View>
                value={view}
                onChange={setView}
                label="Vista"
                className="w-full"
                options={[
                  { value: 'list', label: 'Lista' },
                  { value: 'staff', label: 'Por profesional' },
                ]}
              />
            </div>
          )}
        </div>
      </div>

      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="truncate font-semibold text-slate-800">
          {fmtWeekday(day)}, {fmtDate(day)}
        </h2>
        {rows.length > 0 && (
          <p className="shrink-0 text-sm text-slate-500">
            {active.length} {active.length === 1 ? 'cita' : 'citas'}
          </p>
        )}
      </div>

      {appts.isLoading ? (
        <PageLoader label="Cargando agenda…" />
      ) : appts.isError ? (
        <EmptyState
          icon={<CalendarDays className="h-6 w-6" />}
          title="No se pudo cargar la agenda"
          description={errorMessage(appts.error)}
          action={<Button onClick={() => appts.refetch()}>Reintentar</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<CalendarDays className="h-6 w-6" />}
          title="No hay citas este día"
          description={
            canManage
              ? 'Agenda la cita con el cliente, el servicio y el profesional. Puedes recordársela por WhatsApp y cobrarla al terminar.'
              : 'Cuando se agenden citas para este día aparecerán aquí.'
          }
          action={
            canManage ? (
              <Button onClick={newAppointment}>
                <Plus className="h-4 w-4" /> Agendar cita
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {byStaff && (
            // Las columnas se desplazan por dentro si son muchas; solo existe desde `lg`.
            <div className="hidden overflow-x-auto pb-2 lg:block">
              <div
                className="grid gap-3"
                style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(16rem, 1fr))` }}
              >
                {columns.map((col) => (
                  <section key={col.id || 'none'} className="min-w-0 rounded-2xl bg-slate-100/70 p-2">
                    <header className="flex items-center justify-between px-1.5 pb-2">
                      <h3 className="truncate text-sm font-semibold text-slate-700">{col.name}</h3>
                      <span className="text-xs font-medium text-slate-500">{col.items.length}</span>
                    </header>
                    <Card>
                      <ul className="divide-y divide-slate-100">{col.items.map((a) => card(a, false))}</ul>
                    </Card>
                  </section>
                ))}
              </div>
            </div>
          )}
          <Card className={cn(byStaff && 'lg:hidden')}>
            <ul className="divide-y divide-slate-100">{rows.map((a) => card(a, true))}</ul>
          </Card>
        </>
      )}

      {editing && (
        <AppointmentFormModal
          appointment={editing.appointment}
          defaultDay={day}
          defaultStaffId={staff && staff !== 'none' ? staff : null}
          onClose={() => setEditing(null)}
        />
      )}

      {canceling && <CancelModal appointment={canceling} onClose={() => setCanceling(null)} />}

      {charging && (
        <AppointmentCheckoutModal
          appointment={charging.appointment}
          customer={customerOf(charging.appointment)}
          balance={
            charging.appointment.customer_id ? (balances.data?.[charging.appointment.customer_id]?.balance ?? 0) : 0
          }
          clientUid={charging.uid}
          currency={currency}
          onClose={() => setCharging(null)}
          onDone={(r, registerId) => {
            delete uids.current[charging.appointment.id]
            setCharging(null)
            setResult({ r, registerId })
          }}
        />
      )}

      {result && (
        <Modal
          open
          onClose={() => setResult(null)}
          title="Cita cobrada"
          footer={
            <>
              <Link to={`/ventas/${result.r.sale_id}`}>
                <Button variant="outline">Ver venta</Button>
              </Link>
              <Button variant="outline" onClick={() => void printReceipt()} loading={printing}>
                <Printer className="h-4 w-4" /> Imprimir
              </Button>
              <Button onClick={() => setResult(null)}>Listo</Button>
            </>
          }
        >
          <CheckoutSuccess result={result.r} currency={currency} />
        </Modal>
      )}
    </div>
  )
}

// ── Tira de la semana ───────────────────────────────────────────────────────

/**
 * Siete botones en rejilla (no en fila desplazable): a 360px caben de sobra
 * (unos 44px cada uno) y no hay nada que arrastrar de lado.
 */
function WeekStrip({
  days,
  selected,
  today,
  onPick,
}: {
  days: { key: string; date: Date; items: Appointment[] }[]
  selected: string
  today: string
  onPick: (day: string) => void
}) {
  return (
    <div className="grid grid-cols-7 gap-1" role="group" aria-label="Días de la semana">
      {days.map((d) => {
        const count = d.items.filter((a) => a.status !== 'canceled' && a.status !== 'no_show').length
        const isSel = d.key === selected
        return (
          <button
            key={d.key}
            type="button"
            aria-pressed={isSel}
            aria-label={`${format(d.date, "EEEE d 'de' MMMM", { locale: es })}: ${count} citas`}
            onClick={() => onPick(d.key)}
            className={cn(
              'flex min-w-0 flex-col items-center rounded-xl border py-1.5 transition-colors',
              isSel
                ? 'border-brand-600 bg-brand-600 text-white'
                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
            )}
          >
            <span className={cn('text-[11px] uppercase', isSel ? 'text-brand-100' : 'text-slate-400')}>
              {format(d.date, 'EEE', { locale: es }).replace('.', '')}
            </span>
            <span className={cn('text-base font-semibold', d.key === today && !isSel && 'text-brand-600')}>
              {format(d.date, 'd')}
            </span>
            <span className={cn('h-4 text-[11px] font-medium', isSel ? 'text-white' : 'text-slate-500')}>
              {count > 0 ? count : ''}
            </span>
          </button>
        )
      })}
    </div>
  )
}

// ── Cita ────────────────────────────────────────────────────────────────────

function AppointmentCard({
  a,
  who,
  phone,
  staffName,
  actions,
  onOpen,
}: {
  a: Appointment
  who: string
  phone: string | null
  /** null = no se enseña (vista por profesional, la columna ya lo dice). */
  staffName: string | null
  actions: ActionItem[]
  onOpen?: () => void
}) {
  const s = APPOINTMENT_STATUS[a.status]
  const dimmed = a.status === 'canceled' || a.status === 'no_show'
  return (
    <li className={cn('flex items-start gap-3 p-3 sm:p-4', dimmed && 'bg-slate-50/60')}>
      <div className="w-[4.5rem] shrink-0 pt-0.5 text-right">
        <p className={cn('text-sm font-semibold tabular-nums text-slate-800', dimmed && 'text-slate-400 line-through')}>
          {fmtTime(a.starts_at)}
        </p>
        <p className="text-xs tabular-nums text-slate-400">{fmtTime(a.ends_at)}</p>
      </div>
      <div className={cn('min-w-0 flex-1 border-l-4 pl-3', STATUS_BAR[a.status])}>
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="block max-w-full text-left font-semibold text-slate-800 hover:text-brand-600"
          >
            <span className="block truncate">{a.title}</span>
          </button>
        ) : (
          <p className={cn('truncate font-semibold text-slate-800', dimmed && 'text-slate-500')}>{a.title}</p>
        )}
        <p className="truncate text-sm text-slate-600">
          {who}
          {phone ? <span className="text-slate-400"> · {phone}</span> : null}
        </p>
        {staffName && <p className="truncate text-xs text-slate-500">{staffName}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge tone={s.tone}>{s.label}</Badge>
          {a.sale_id && <Badge tone="green">Cobrada</Badge>}
        </div>
        {a.status === 'canceled' && a.cancel_reason && (
          <p className="mt-1 line-clamp-2 text-xs text-slate-500">Motivo: {a.cancel_reason}</p>
        )}
        {a.notes && !dimmed && <p className="mt-1 line-clamp-2 text-xs text-slate-500">{a.notes}</p>}
      </div>
      {actions.length > 0 && (
        <div className="-mr-1 shrink-0">
          <ActionMenu items={actions} title={`${fmtTime(a.starts_at)} · ${who}`} />
        </div>
      )}
    </li>
  )
}

// ── Cancelar ────────────────────────────────────────────────────────────────

function CancelModal({ appointment, onClose }: { appointment: Appointment; onClose: () => void }) {
  const toast = useToast()
  const setStatus = useSetAppointmentStatus()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    if (!reason.trim()) {
      setError('Indica el motivo de la cancelación.')
      return
    }
    setError(null)
    setStatus.mutate(
      { id: appointment.id, status: 'canceled', reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success('Cita cancelada')
          onClose()
        },
        onError: (err) => setError(errorMessage(err, 'No se pudo cancelar la cita')),
      },
    )
  }

  return (
    <Modal
      open
      onClose={() => !setStatus.isPending && onClose()}
      title="Cancelar cita"
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={setStatus.isPending}>
            Volver
          </Button>
          <Button variant="danger" onClick={submit} loading={setStatus.isPending}>
            Cancelar cita
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          {appointment.title} · {fmtTime(appointment.starts_at)}. El horario queda libre para otra cita.
        </p>
        <Field label="Motivo" required error={error ?? undefined}>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ej.: El cliente pidió cambiar el día"
            autoFocus
          />
        </Field>
      </div>
    </Modal>
  )
}
