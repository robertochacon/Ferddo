import { useState } from 'react'
import { format, parseISO, isValid } from 'date-fns'
import { Check } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { useToast } from '@/components/ui/toast'
import { planOrderFrom, planPriceLabel } from '@/lib/constants'
import { errorMessage } from '@/lib/errors'
import { useAdminUpdateSubscription } from '@/hooks/admin'
import type { PlanCode, SubscriptionStatus } from '@/types/db'

/*
 * Editor de la suscripción de un negocio, compartido por el modal de la lista
 * de /admin y por la ficha del negocio: una sola implementación de "qué se
 * puede cambiar y cómo se guardan las fechas".
 */

export const SUB_STATUS_LABEL: Record<SubscriptionStatus, string> = {
  trial: 'Prueba',
  active: 'Activo',
  past_due: 'Vencido',
  canceled: 'Cancelado',
}
export const SUB_STATUS_TONE: Record<SubscriptionStatus, 'green' | 'amber' | 'red' | 'slate'> = {
  trial: 'amber',
  active: 'green',
  past_due: 'red',
  canceled: 'slate',
}
const SUB_STATUSES: SubscriptionStatus[] = ['trial', 'active', 'past_due', 'canceled']

/** ISO de la base → valor de `<input type="date">` (yyyy-MM-dd, hora local). */
function toDateInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = parseISO(iso)
  return isValid(d) ? format(d, 'yyyy-MM-dd') : ''
}

/**
 * `<input type="date">` → timestamptz. Se guarda el FINAL del día local: "vence
 * el 30" tiene que dejar trabajar todo el 30. Mandar la fecha a secas la
 * convertiría en las 00:00 UTC, que en RD es la tarde del día anterior.
 */
function fromDateInput(value: string): string | null {
  if (!value) return null
  const d = parseISO(`${value}T23:59:59`)
  return isValid(d) ? d.toISOString() : null
}

export interface SubscriptionSnapshot {
  tenantId: string
  tenantName: string
  plan: PlanCode | null
  status: SubscriptionStatus | null
  currentPeriodEnd: string | null
  trialEndsAt: string | null
}

export function SubscriptionEditor({
  sub,
  onSaved,
  onCancel,
}: {
  sub: SubscriptionSnapshot
  onSaved?: () => void
  onCancel?: () => void
}) {
  const { plans } = useAuth()
  const toast = useToast()
  const update = useAdminUpdateSubscription()
  const [plan, setPlan] = useState<PlanCode>(sub.plan ?? 'basic')
  const [status, setStatus] = useState<SubscriptionStatus>(sub.status ?? 'active')
  const [periodEnd, setPeriodEnd] = useState(toDateInput(sub.currentPeriodEnd))
  const [trialEnd, setTrialEnd] = useState(toDateInput(sub.trialEndsAt))

  // Se rehidrata si cambia lo guardado (tras el invalidate de ['admin']), pero
  // durante el render y no en un efecto: sin fotograma con los valores viejos.
  const key = `${sub.tenantId}|${sub.plan}|${sub.status}|${sub.currentPeriodEnd}|${sub.trialEndsAt}`
  const [synced, setSynced] = useState(key)
  if (synced !== key) {
    setSynced(key)
    setPlan(sub.plan ?? 'basic')
    setStatus(sub.status ?? 'active')
    setPeriodEnd(toDateInput(sub.currentPeriodEnd))
    setTrialEnd(toDateInput(sub.trialEndsAt))
  }

  // Todos los planes del enum, no solo los ofrecidos: a un cliente antiguo se le
  // puede mantener en un plan retirado.
  const codes = Array.from(new Set([...planOrderFrom(plans), ...(Object.keys(plans) as PlanCode[])]))

  const save = async () => {
    try {
      await update.mutateAsync({
        tenant: sub.tenantId,
        plan,
        status,
        currentPeriodEnd: fromDateInput(periodEnd),
        trialEndsAt: fromDateInput(trialEnd),
      })
      toast.success(`Suscripción de "${sub.tenantName}" actualizada.`)
      onSaved?.()
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo actualizar la suscripción.'))
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Plan">
          <Select value={plan} onChange={(e) => setPlan(e.target.value as PlanCode)}>
            {codes.map((p) => (
              <option key={p} value={p}>
                {plans[p].name} — {planPriceLabel(plans[p])}
                {plans[p].isOffered ? '' : ' (retirado)'}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Estado">
          <Select value={status} onChange={(e) => setStatus(e.target.value as SubscriptionStatus)}>
            {SUB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {SUB_STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Fin del periodo pagado" hint="Hasta qué día está cubierto">
          <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        </Field>
        <Field label="Fin de la prueba" hint="Solo cuenta con estado «Prueba»">
          <Input type="date" value={trialEnd} onChange={(e) => setTrialEnd(e.target.value)} />
        </Field>
      </div>
      <p className="text-xs text-slate-500">
        El plan manda sobre los topes y los módulos que aplica la base. Bajarlo no borra nada: lo
        que ya existe se conserva, lo que se pierde es poder crear más. Una fecha vacía deja la
        que había (no se puede borrar desde aquí).
      </p>
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="outline" onClick={onCancel}>
            Cancelar
          </Button>
        )}
        <Button onClick={() => void save()} loading={update.isPending}>
          <Check className="h-4 w-4" /> Guardar suscripción
        </Button>
      </div>
    </div>
  )
}
