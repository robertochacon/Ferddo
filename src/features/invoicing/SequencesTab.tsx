import { useState, type FormEvent } from 'react'
import { ListOrdered, Plus, Power, PowerOff } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { useAddFiscalSequence, useEcfTypes, useFiscalSequences, useSetSequenceActive } from '@/hooks/invoicing'
import { dayIn } from '@/hooks/reports'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Field, Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { EmptyState, Spinner } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import { fmtDate, num } from '@/lib/format'
import { encfPreview, ecfTypeLabel } from '@/features/invoicing/shared'
import type { Tone } from '@/lib/labels'
import type { FiscalSequence } from '@/types/erp'

/** Tope del secuencial: 10 dígitos (check de fiscal_sequences). */
const MAX_SEQ = 9_999_999_999

type SeqState = 'active' | 'expired' | 'exhausted' | 'inactive'

const SEQ_STATE: Record<SeqState, { label: string; tone: Tone }> = {
  active: { label: 'Activa', tone: 'green' },
  expired: { label: 'Vencida', tone: 'red' },
  exhausted: { label: 'Agotada', tone: 'red' },
  inactive: { label: 'Desactivada', tone: 'slate' },
}

const BAR_TONE: Record<'ok' | 'warn' | 'full', string> = {
  ok: 'bg-brand-500',
  warn: 'bg-amber-500',
  full: 'bg-red-500',
}

function usage(s: FiscalSequence) {
  const total = s.end_number - s.start_number + 1
  const used = Math.min(total, Math.max(0, s.next_number - s.start_number))
  const pct = total > 0 ? (used / total) * 100 : 0
  return { total, used, remaining: total - used, pct }
}

function usageLevel(pct: number): keyof typeof BAR_TONE {
  if (pct >= 100) return 'full'
  if (pct >= 80) return 'warn'
  return 'ok'
}

function rangeError(start: number, end: number): string | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1) return 'Usa números enteros positivos.'
  if (end < start) return 'El final debe ser mayor o igual que el inicio.'
  if (end > MAX_SEQ) return 'El secuencial tiene como máximo 10 dígitos.'
  return null
}

function stateOf(s: FiscalSequence, today: string): SeqState {
  if (!s.is_active) return 'inactive'
  if (s.next_number > s.end_number) return 'exhausted'
  if (s.expires_on && s.expires_on < today) return 'expired'
  return 'active'
}

export function SequencesTab({ timezone }: { timezone: string }) {
  const { can } = useAuth()
  const canManage = can('fiscal.manage')
  const seqs = useFiscalSequences()
  const types = useEcfTypes()
  const setActive = useSetSequenceActive()
  const toast = useToast()
  const today = dayIn(timezone)

  const toggle = (s: FiscalSequence) =>
    setActive.mutate(
      { id: s.id, active: !s.is_active },
      {
        onSuccess: () => toast.success(s.is_active ? 'Secuencia desactivada.' : 'Secuencia activada.'),
        onError: (e) => toast.error(errorMessage(e, 'No se pudo cambiar la secuencia.')),
      },
    )

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Registra aquí los rangos de e-NCF que la DGII te autorizó en la Oficina Virtual. Ferddo los consume en orden;
        sin un rango activo y vigente del tipo elegido, la venta con comprobante no se puede guardar.
      </p>

      {canManage && <AddSequenceForm />}

      {seqs.isLoading ? (
        <div className="flex items-center justify-center gap-3 py-12 text-sm text-slate-500">
          <Spinner /> Cargando secuencias…
        </div>
      ) : seqs.isError ? (
        <Card>
          <CardBody className="space-y-3 text-center">
            <p className="text-sm text-red-600">{errorMessage(seqs.error, 'No se pudieron cargar las secuencias.')}</p>
            <Button variant="outline" size="sm" onClick={() => void seqs.refetch()}>
              Reintentar
            </Button>
          </CardBody>
        </Card>
      ) : !seqs.data?.length ? (
        <EmptyState
          icon={<ListOrdered className="h-6 w-6" />}
          title="Sin secuencias registradas"
          description="Solicita la autorización de secuencias e-NCF en la Oficina Virtual de la DGII y regístralas aquí."
        />
      ) : (
        <Card>
          <CardHeader title="Rangos autorizados" />
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Tipo</th>
                  <th className="px-4 py-2.5 font-medium">Rango</th>
                  <th className="px-4 py-2.5 font-medium">Uso</th>
                  <th className="px-4 py-2.5 font-medium">Próximo</th>
                  <th className="px-4 py-2.5 font-medium">Vence</th>
                  <th className="px-4 py-2.5 font-medium">Estado</th>
                  {canManage && <th className="px-4 py-2.5" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {seqs.data.map((s) => {
                  const st = SEQ_STATE[stateOf(s, today)]
                  return (
                    <tr key={s.id} className="align-top">
                      <td className="px-4 py-3 text-slate-700">
                        {ecfTypeLabel(s.ecf_type, types.data)}
                        {s.authorization_ref && <p className="text-xs text-slate-400">Aut.: {s.authorization_ref}</p>}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">
                        {encfPreview(s.ecf_type, s.start_number)}
                        <br />
                        {encfPreview(s.ecf_type, s.end_number)}
                      </td>
                      <td className="w-56 px-4 py-3">
                        <UsageBar seq={s} />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">
                        {s.next_number <= s.end_number ? encfPreview(s.ecf_type, s.next_number) : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <Expiry date={s.expires_on} today={today} />
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={st.tone}>{st.label}</Badge>
                      </td>
                      {canManage && (
                        <td className="px-4 py-3 text-right">
                          <Button
                            variant={s.is_active ? 'ghost' : 'outline'}
                            size="sm"
                            onClick={() => toggle(s)}
                            loading={setActive.isPending && setActive.variables?.id === s.id}
                          >
                            {s.is_active ? 'Desactivar' : 'Activar'}
                          </Button>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <DataList>
            {seqs.data.map((s) => {
              const st = SEQ_STATE[stateOf(s, today)]
              return (
                <DataRow
                  key={s.id}
                  title={ecfTypeLabel(s.ecf_type, types.data)}
                  titleExtra={s.authorization_ref ? `Aut.: ${s.authorization_ref}` : undefined}
                  badges={<Badge tone={st.tone}>{st.label}</Badge>}
                  actions={
                    canManage ? (
                      <ActionMenu
                        title={ecfTypeLabel(s.ecf_type, types.data)}
                        items={[
                          {
                            label: s.is_active ? 'Desactivar' : 'Activar',
                            icon: s.is_active ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />,
                            tone: s.is_active ? 'danger' : 'success',
                            onClick: () => toggle(s),
                          },
                        ]}
                      />
                    ) : undefined
                  }
                >
                  <UsageBar seq={s} />
                  <DataFields className="mt-3">
                    <DataField label="Desde">
                      <span className="font-mono text-xs">{encfPreview(s.ecf_type, s.start_number)}</span>
                    </DataField>
                    <DataField label="Hasta">
                      <span className="font-mono text-xs">{encfPreview(s.ecf_type, s.end_number)}</span>
                    </DataField>
                    <DataField label="Vence">
                      <Expiry date={s.expires_on} today={today} />
                    </DataField>
                  </DataFields>
                </DataRow>
              )
            })}
          </DataList>
        </Card>
      )}
    </div>
  )
}

function UsageBar({ seq }: { seq: FiscalSequence }) {
  const u = usage(seq)
  const level = usageLevel(u.pct)
  return (
    <div>
      <div className="h-2 w-full rounded-full bg-slate-100">
        <div className={cn('h-2 rounded-full', BAR_TONE[level])} style={{ width: `${Math.max(u.pct, u.used ? 2 : 0)}%` }} />
      </div>
      <p className="mt-1 text-xs text-slate-500">
        <span className="font-semibold text-slate-700">{num(u.used)}</span> de {num(u.total)} usados ·{' '}
        {num(u.remaining)} disponibles
      </p>
    </div>
  )
}

function Expiry({ date, today }: { date: string | null; today: string }) {
  if (!date) return <span className="text-slate-400">Sin fecha</span>
  if (date < today) return <span className="font-medium text-red-600">{fmtDate(date)}</span>
  // Aviso con 30 días: pedir un rango nuevo a la DGII no es inmediato.
  const soon = new Date(`${date}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime() <= 30 * 86_400_000
  return <span className={soon ? 'font-medium text-amber-700' : 'text-slate-700'}>{fmtDate(date)}</span>
}

function AddSequenceForm() {
  const types = useEcfTypes()
  const add = useAddFiscalSequence()
  const toast = useToast()
  const [type, setType] = useState('32')
  const [start, setStart] = useState('1')
  const [end, setEnd] = useState('')
  const [expires, setExpires] = useState('')
  const [ref, setRef] = useState('')

  const s = Number(start)
  const e = Number(end)
  const error = end ? rangeError(s, e) : null
  const selected = types.data?.find((t) => t.code === type)

  const submit = (ev: FormEvent) => {
    ev.preventDefault()
    if (!end || error) return
    add.mutate(
      { type, start: s, end: e, expires_on: expires || null, authorization_ref: ref.trim() || null },
      {
        onSuccess: () => {
          toast.success(`Rango ${encfPreview(type, s)} – ${encfPreview(type, e)} registrado.`)
          setEnd('')
          setRef('')
          setExpires('')
        },
        onError: (err) => toast.error(errorMessage(err, 'No se pudo registrar la secuencia.')),
      },
    )
  }

  return (
    <Card>
      <CardHeader title="Registrar rango autorizado" />
      <CardBody>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Tipo" className="lg:col-span-2">
              <Select value={type} onChange={(ev) => setType(ev.target.value)}>
                {types.data?.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.code} · {t.name}
                    {t.is_supported ? '' : ' (aún no se emite desde Ferddo)'}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Desde" required>
              <Input inputMode="numeric" value={start} onChange={(ev) => setStart(ev.target.value.replace(/\D/g, ''))} />
            </Field>
            <Field label="Hasta" required>
              <Input inputMode="numeric" value={end} onChange={(ev) => setEnd(ev.target.value.replace(/\D/g, ''))} />
            </Field>
            <Field label="Vence">
              <Input type="date" value={expires} onChange={(ev) => setExpires(ev.target.value)} />
            </Field>
            <Field label="Referencia de autorización" className="sm:col-span-2 lg:col-span-3">
              <Input value={ref} onChange={(ev) => setRef(ev.target.value)} placeholder="Número de la solicitud en la OFV" />
            </Field>
            <div className="flex items-end sm:col-span-2 lg:col-span-2">
              <Button type="submit" className="w-full" loading={add.isPending} disabled={!end || Boolean(error)}>
                <Plus className="h-4 w-4" /> Registrar
              </Button>
            </div>
          </div>
          {error ? (
            <p className="text-sm font-medium text-red-600">{error}</p>
          ) : (
            end && (
              <p className="text-xs text-slate-500">
                Del <span className="font-mono">{encfPreview(type, s)}</span> al{' '}
                <span className="font-mono">{encfPreview(type, e)}</span> · {num(e - s + 1)} comprobantes
                {selected?.requires_buyer_id ? ' · exige RNC o cédula del comprador' : ''}
              </p>
            )
          )}
        </form>
      </CardBody>
    </Card>
  )
}
