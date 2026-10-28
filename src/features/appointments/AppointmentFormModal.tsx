import { useMemo, useState, type FormEvent } from 'react'
import { Search, UserRound, X } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/Button'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { useToast } from '@/components/ui/toast'
import { useBranches, useCustomers, useProducts } from '@/hooks/core'
import { useTeamMembers } from '@/hooks/team'
import { useSaveAppointment } from '@/hooks/appointments'
import { errorMessage } from '@/lib/errors'
import { norm } from '@/lib/format'
import type { Appointment, Customer, Product } from '@/types/erp'
import {
  addMinutesToTime,
  isoToDay,
  isoToTime,
  localToIso,
  minutesBetween,
  nextHalfHour,
  todayKey,
} from './shared'

/*
 * Alta y edición de una cita.
 *
 * La hora de fin se propone con la duración del servicio y se puede tocar; al
 * mover el inicio, el fin se mueve con él conservando la duración elegida. El
 * solape con otra cita del mismo profesional lo decide la base
 * (APPOINTMENT_OVERLAP): aquí no se consulta antes, porque dos personas
 * agendando a la vez se colarían igual.
 */

type Who = 'customer' | 'contact'

const DEFAULT_MINUTES = 30

const productLabel = (p: Product) => (p.variant_label ? `${p.name} ${p.variant_label}` : p.name)

export function AppointmentFormModal({
  appointment,
  defaultDay,
  defaultStaffId,
  onClose,
}: {
  /** null = cita nueva. */
  appointment: Appointment | null
  /** Día que se está viendo en la agenda: ahí se propone la cita nueva. */
  defaultDay: string
  /** Profesional del filtro, si hay uno elegido. */
  defaultStaffId: string | null
  onClose: () => void
}) {
  const toast = useToast()
  const { user, memberRole } = useAuth()
  const branches = useBranches()
  const customers = useCustomers()
  const products = useProducts()
  const members = useTeamMembers()
  const save = useSaveAppointment()

  const a = appointment
  const initialStart = a ? isoToTime(a.starts_at) : defaultDay === todayKey() ? nextHalfHour() : '09:00'

  const [branchId, setBranchId] = useState(a?.branch_id ?? '')
  const [who, setWho] = useState<Who>(a && !a.customer_id ? 'contact' : 'customer')
  const [customerId, setCustomerId] = useState<string | null>(a?.customer_id ?? null)
  const [contactName, setContactName] = useState(a?.contact_name ?? '')
  const [contactPhone, setContactPhone] = useState(a?.contact_phone ?? '')
  const [serviceId, setServiceId] = useState(a?.service_id ?? '')
  const [title, setTitle] = useState('')
  const [staffId, setStaffId] = useState(a ? (a.staff_id ?? '') : (defaultStaffId ?? ''))
  const [day, setDay] = useState(a ? isoToDay(a.starts_at) : defaultDay)
  const [start, setStart] = useState(initialStart)
  const [end, setEnd] = useState(a ? isoToTime(a.ends_at) : addMinutesToTime(initialStart, DEFAULT_MINUTES))
  const [notes, setNotes] = useState(a?.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const [titleLoaded, setTitleLoaded] = useState(false)

  // ── Catálogo: servicios primero; productos con variantes se agendan por variante ──
  const { services, goods, productById } = useMemo(() => {
    const all = products.data ?? []
    const parents = new Set(all.map((p) => p.parent_id).filter(Boolean) as string[])
    const usable = all.filter((p) => (p.is_active && !parents.has(p.id)) || p.id === a?.service_id)
    return {
      services: usable.filter((p) => p.kind === 'service'),
      goods: usable.filter((p) => p.kind !== 'service'),
      productById: new Map(all.map((p) => [p.id, p])),
    }
  }, [products.data, a?.service_id])
  const service = serviceId ? productById.get(serviceId) : undefined

  // En la edición, el motivo se deja vacío si es el nombre del servicio: así,
  // al cambiar de servicio, el motivo sigue al servicio nuevo (appt_save lo
  // rellena) en vez de quedarse con el nombre del anterior.
  if (a && !titleLoaded && (products.data || !a.service_id)) {
    const svc = a.service_id ? productById.get(a.service_id) : undefined
    // appt_save pone `products.name` tal cual (sin la etiqueta de la variante).
    setTitle(svc && a.title === svc.name ? '' : a.title)
    setTitleLoaded(true)
  }

  // ── Sucursales a las que esta persona tiene acceso (appt_save lo vuelve a comprobar) ──
  const me = members.data?.find((mb) => mb.user_id === user?.id)
  const unrestricted = memberRole === 'owner' || memberRole === 'admin' || !me || me.branch_ids == null
  const branchOptions = (branches.data ?? []).filter(
    (b) => (b.is_active && (unrestricted || (me?.branch_ids ?? []).includes(b.id))) || b.id === branchId,
  )
  const effectiveBranch = branchId || (branchOptions.find((b) => b.is_main) ?? branchOptions[0])?.id || ''

  const staffOptions = (members.data ?? []).filter((mb) => mb.is_active || mb.user_id === staffId)

  const changeStart = (v: string) => {
    // El fin se mueve con el inicio: conserva la duración que había.
    const dur = minutesBetween(start, end)
    setStart(v)
    if (v) setEnd(addMinutesToTime(v, dur > 0 ? dur : DEFAULT_MINUTES))
  }
  const changeService = (id: string) => {
    setServiceId(id)
    const p = id ? productById.get(id) : undefined
    if (p?.duration_minutes && start) setEnd(addMinutesToTime(start, p.duration_minutes))
  }

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    setError(null)
    const cust = who === 'customer' ? customerId : null
    const name = who === 'contact' ? contactName.trim() : ''
    let problem: string | null = null
    if (!effectiveBranch) problem = 'Elige la sucursal.'
    else if (who === 'customer' && !cust) problem = 'Elige el cliente o cambia a "Otra persona".'
    else if (who === 'contact' && !name) problem = 'Escribe el nombre de la persona.'
    else if (!serviceId && !title.trim()) problem = 'Elige un servicio o escribe el motivo de la cita.'
    else if (!day || !start || !end) problem = 'Indica la fecha y las horas de inicio y fin.'
    else if (minutesBetween(start, end) <= 0) problem = 'La hora de fin debe ser posterior a la de inicio.'
    if (problem) {
      setError(problem)
      return
    }
    save.mutate(
      {
        ...(a ? { id: a.id } : {}),
        branch_id: effectiveBranch,
        customer_id: cust,
        contact_name: who === 'contact' ? name : null,
        // Con cliente registrado vale su teléfono de la ficha: no se duplica aquí.
        contact_phone: who === 'contact' ? contactPhone.trim() || null : null,
        staff_id: staffId || null,
        service_id: serviceId || null,
        title: title.trim() || null,
        starts_at: localToIso(day, start),
        ends_at: localToIso(day, end),
        notes: notes.trim() || null,
      },
      {
        onSuccess: () => {
          toast.success(a ? 'Cita actualizada' : 'Cita agendada')
          onClose()
        },
        onError: (err) => setError(errorMessage(err, 'No se pudo guardar la cita')),
      },
    )
  }

  return (
    <Modal
      open
      onClose={() => !save.isPending && onClose()}
      title={a ? 'Editar cita' : 'Nueva cita'}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Cancelar
          </Button>
          <Button onClick={() => submit()} loading={save.isPending}>
            {a ? 'Guardar cambios' : 'Agendar'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {branchOptions.length > 1 && (
          <Field label="Sucursal" required>
            <Select value={effectiveBranch} onChange={(e) => setBranchId(e.target.value)}>
              {branchOptions.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <div className="space-y-3">
          <Segmented<Who>
            label="Para quién"
            value={who}
            onChange={setWho}
            options={[
              { value: 'customer', label: 'Cliente registrado' },
              { value: 'contact', label: 'Otra persona' },
            ]}
          />
          {who === 'customer' ? (
            <CustomerField
              customers={customers.data ?? []}
              loading={customers.isLoading}
              value={customerId}
              onChange={setCustomerId}
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Nombre" required>
                <Input value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Nombre y apellido" />
              </Field>
              <Field label="Teléfono" hint="Para el recordatorio por WhatsApp.">
                <Input
                  type="tel"
                  inputMode="tel"
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  placeholder="809-555-0000"
                />
              </Field>
            </div>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Servicio" hint={service?.duration_minutes ? `Duración: ${service.duration_minutes} min` : undefined}>
            <Select value={serviceId} onChange={(e) => changeService(e.target.value)} disabled={products.isLoading}>
              <option value="">Sin servicio</option>
              {services.length > 0 && (
                <optgroup label="Servicios">
                  {services.map((p) => (
                    <option key={p.id} value={p.id}>
                      {productLabel(p)}
                      {p.duration_minutes ? ` · ${p.duration_minutes} min` : ''}
                    </option>
                  ))}
                </optgroup>
              )}
              {goods.length > 0 && (
                <optgroup label="Productos">
                  {goods.map((p) => (
                    <option key={p.id} value={p.id}>
                      {productLabel(p)}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Field>
          <Field label="Motivo" required={!serviceId}>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={service ? productLabel(service) : 'Ej.: Consulta general'}
              maxLength={200}
            />
          </Field>
        </div>

        <Field label="Profesional" hint="Un profesional no puede tener dos citas a la misma hora.">
          <Select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">Sin asignar</option>
            {staffOptions.map((mb) => (
              <option key={mb.user_id} value={mb.user_id}>
                {mb.full_name ?? mb.email ?? 'Sin nombre'}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Fecha" required className="col-span-2 sm:col-span-1">
            <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
          <Field label="Inicio" required>
            <Input type="time" step={300} value={start} onChange={(e) => changeStart(e.target.value)} />
          </Field>
          <Field label="Fin" required>
            <Input type="time" step={300} value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>

        <Field label="Notas">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Indicaciones, alergias, qué traer…" />
        </Field>

        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</p>}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  )
}

// ── Cliente ─────────────────────────────────────────────────────────────────

const MAX_MATCHES = 8

function CustomerField({
  customers,
  loading,
  value,
  onChange,
}: {
  customers: Customer[]
  loading: boolean
  value: string | null
  onChange: (id: string | null) => void
}) {
  const [q, setQ] = useState('')
  const selected = value ? customers.find((c) => c.id === value) : undefined

  const matches = useMemo(() => {
    const s = norm(q)
    const d = q.replace(/\D/g, '')
    if (!s) return []
    return customers
      .filter((c) => c.is_active)
      .filter(
        (c) =>
          norm(c.name).includes(s) ||
          (d.length >= 3 &&
            ((c.phone ?? '').replace(/\D/g, '').includes(d) || (c.doc_number ?? '').replace(/\D/g, '').includes(d))),
      )
      .slice(0, MAX_MATCHES)
  }, [customers, q])

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2">
        <UserRound className="h-5 w-5 shrink-0 text-slate-400" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-800">{selected?.name ?? 'Cliente'}</p>
          <p className="truncate text-xs text-slate-500">
            {[selected?.phone, selected?.doc_number].filter(Boolean).join(' · ') || 'Sin teléfono registrado'}
          </p>
        </div>
        <button
          type="button"
          aria-label="Quitar cliente"
          onClick={() => {
            onChange(null)
            setQ('')
          }}
          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    )
  }

  return (
    <Field label="Cliente" required>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={loading ? 'Cargando clientes…' : 'Nombre, teléfono o cédula'}
          className="pl-9"
          aria-label="Buscar cliente"
        />
      </div>
      {q.trim() !== '' &&
        (matches.length === 0 ? (
          <p className="px-1 py-2 text-sm text-slate-500">
            Ningún cliente coincide. Usa "Otra persona" para agendar sin registrarlo.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {matches.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onChange(c.id)}
                  className="block w-full px-3 py-2.5 text-left hover:bg-slate-50"
                >
                  <span className="block truncate text-sm font-medium text-slate-800">{c.name}</span>
                  <span className="block truncate text-xs text-slate-500">
                    {[c.phone, c.doc_number].filter(Boolean).join(' · ') || 'Sin teléfono'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}
    </Field>
  )
}
