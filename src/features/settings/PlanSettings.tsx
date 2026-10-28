import { useState } from 'react'
import { Check, Clock, Crown, Info, Sparkles } from 'lucide-react'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Field, Textarea } from '@/components/ui/Input'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/auth/AuthProvider'
import { useMyPlanRequest, useMyPlanUsage, useRequestPlanChange, type PlanUsage } from '@/hooks/plan'
import { LEGAL_CONTACT_EMAIL, planOrderFrom, planPriceLabel, type PlanInfo } from '@/lib/constants'
import { fmtDate, num } from '@/lib/format'
import { errorMessage } from '@/lib/errors'
import { MODULE_LABEL, type Tone } from '@/lib/labels'
import { cn } from '@/lib/cn'
import type { ModuleCode, PlanCode, SubscriptionStatus } from '@/types/db'
import { LoadError } from './parts'

const STATUS: Record<SubscriptionStatus, { label: string; tone: Tone }> = {
  trial: { label: 'En prueba', tone: 'amber' },
  active: { label: 'Activo', tone: 'green' },
  past_due: { label: 'Pago pendiente', tone: 'red' },
  canceled: { label: 'Cancelado', tone: 'slate' },
}

/** Topes que se comparan con `my_plan_usage()`. */
const USAGE_ROWS: { key: keyof PlanUsage; label: string; limit: (p: PlanInfo) => number | null }[] = [
  { key: 'products', label: 'Productos', limit: (p) => p.maxProducts },
  { key: 'members', label: 'Usuarios activos', limit: (p) => p.maxMembers },
  { key: 'branches', label: 'Sucursales', limit: (p) => p.maxBranches },
  { key: 'registers', label: 'Cajas', limit: (p) => p.maxRegisters },
  { key: 'ecf_month', label: 'e-CF este mes', limit: (p) => p.maxEcfMonthly },
]

/** Color de la barra según lo lleno que está el tope. */
function barTone(ratio: number): string {
  if (ratio >= 1) return 'bg-red-500'
  if (ratio >= 0.8) return 'bg-amber-500'
  return 'bg-brand-500'
}

const ALL_MODULES = Object.keys(MODULE_LABEL) as ModuleCode[]

/**
 * Suscripción de la empresa: qué plan tiene, cuánto usa y cómo cambiar.
 *
 * El cambio de plan se SOLICITA (`request_plan_change`, exige
 * `subscription.manage`): lo aprueba la plataforma porque decide cuánto cabe y
 * cuánto se cobra. El cobro, por ahora, se coordina a mano.
 */
export function PlanSettings() {
  const { plan, plans, subscription, can } = useAuth()
  const usage = useMyPlanUsage()
  const myRequest = useMyPlanRequest()
  const [requesting, setRequesting] = useState<PlanCode | null>(null)

  const status = subscription ? STATUS[subscription.status] : null
  const canRequest = can('subscription.manage')
  const pending = myRequest.data ?? null
  const offered = planOrderFrom(plans)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Tu plan" action={status && <Badge tone={status.tone}>{status.label}</Badge>} />
          <CardBody className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Crown className="h-5 w-5 text-accent-500" />
              <span className="text-lg font-bold text-slate-800">{plan.name}</span>
              <span className="text-slate-400">· {planPriceLabel(plan)}</span>
            </div>
            {subscription?.status === 'trial' && subscription.trial_ends_at && (
              <p className="text-sm text-slate-600">
                Tu periodo de prueba termina el <strong>{fmtDate(subscription.trial_ends_at)}</strong>.
              </p>
            )}
            {subscription?.current_period_end && subscription.status !== 'trial' && (
              <p className="text-sm text-slate-600">
                Pagado hasta el <strong>{fmtDate(subscription.current_period_end)}</strong>.
              </p>
            )}
            {subscription?.status === 'past_due' && (
              <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">
                Tu suscripción tiene un pago pendiente. Escríbenos para regularizarla y evitar que la
                cuenta pase a solo lectura.
              </p>
            )}
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Módulos incluidos</p>
              <div className="flex flex-wrap gap-1.5">
                {(plan.modules ?? ALL_MODULES).map((m) => (
                  <Badge key={m} tone="brand">{MODULE_LABEL[m]}</Badge>
                ))}
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Consumo" subtitle="Lo que usas frente a los topes de tu plan" />
          {usage.isLoading ? (
            <CardBody><p className="text-sm text-slate-400">Calculando…</p></CardBody>
          ) : usage.isError ? (
            <LoadError error={usage.error} onRetry={() => usage.refetch()} what="el consumo" />
          ) : (
            <CardBody className="space-y-3">
              {USAGE_ROWS.map((row) => {
                const used = usage.data?.[row.key] ?? 0
                const max = row.limit(plan)
                // 0 en e-CF = el plan no incluye facturación electrónica.
                if (max === 0) {
                  return (
                    <div key={row.key} className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-slate-600">{row.label}</span>
                      <span className="text-slate-400">No incluido</span>
                    </div>
                  )
                }
                const ratio = max == null ? 0 : Math.min(1, used / max)
                return (
                  <div key={row.key}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="text-slate-600">{row.label}</span>
                      <span className="font-semibold tabular-nums text-slate-800">
                        {num(used)} <span className="font-normal text-slate-400">/ {max == null ? 'ilimitado' : num(max)}</span>
                      </span>
                    </div>
                    {max != null && (
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div className={cn('h-full rounded-full', barTone(ratio))} style={{ width: `${ratio * 100}%` }} />
                      </div>
                    )}
                  </div>
                )
              })}
            </CardBody>
          )}
        </Card>
      </div>

      {pending && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <Clock className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Solicitaste el plan <strong>{plans[pending.requested_plan]?.name ?? pending.requested_plan}</strong> el{' '}
            {fmtDate(pending.created_at)}. Te contactaremos para activarlo.
          </span>
        </div>
      )}

      <div>
        <h2 className="mb-3 text-base font-semibold text-slate-800">Planes disponibles</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {offered.map((code) => {
            const p = plans[code]
            const isCurrent = code === plan.code
            return (
              <div
                key={code}
                className={cn(
                  'flex flex-col rounded-2xl border bg-white p-5 shadow-card',
                  isCurrent ? 'border-brand-400 ring-2 ring-brand-500/20' : 'border-slate-200',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-1.5 font-bold text-slate-800">
                    {p.isFeatured && <Sparkles className="h-4 w-4 text-accent-500" />}
                    {p.name}
                  </p>
                  {isCurrent && <Badge tone="brand">Tu plan</Badge>}
                </div>
                <p className="mt-1 text-xl font-extrabold text-brand-950">{planPriceLabel(p)}</p>
                <ul className="mt-3 flex-1 space-y-1.5">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm text-slate-600">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-mint-500" /> {f}
                    </li>
                  ))}
                </ul>
                {!isCurrent && canRequest && (
                  <Button
                    variant={p.isFeatured ? 'primary' : 'outline'}
                    className="mt-4 w-full"
                    disabled={pending?.requested_plan === code}
                    onClick={() => setRequesting(code)}
                  >
                    {pending?.requested_plan === code ? 'Solicitud enviada' : `Solicitar ${p.name}`}
                  </Button>
                )}
              </div>
            )
          })}
        </div>
        {!canRequest && (
          <p className="mt-3 text-xs text-slate-500">
            Solo quien gestiona la suscripción (normalmente el dueño) puede solicitar un cambio de plan.
          </p>
        )}
      </div>

      <p className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-600">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
        <span>
          Por ahora el pago se coordina directamente con nosotros (transferencia o depósito). Al
          solicitar un plan te contactamos para activarlo; también puedes escribir a{' '}
          <a className="font-medium text-brand-600 hover:underline" href={`mailto:${LEGAL_CONTACT_EMAIL}`}>
            {LEGAL_CONTACT_EMAIL}
          </a>
          .
        </span>
      </p>

      <RequestModal code={requesting} onClose={() => setRequesting(null)} />
    </div>
  )
}

function RequestModal({ code, onClose }: { code: PlanCode | null; onClose: () => void }) {
  const { plans } = useAuth()
  const toast = useToast()
  const request = useRequestPlanChange()
  const [note, setNote] = useState('')
  const p = code ? plans[code] : null

  const send = async () => {
    if (!code) return
    try {
      await request.mutateAsync({ plan: code, note: note.trim() || undefined })
      toast.success(`Solicitud de ${plans[code].name} enviada. Te contactaremos para activarlo.`)
      setNote('')
      onClose()
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo enviar la solicitud'))
    }
  }

  return (
    <Modal
      open={Boolean(code)}
      onClose={onClose}
      size="sm"
      title={p ? `Solicitar ${p.name}` : 'Solicitar plan'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => void send()} loading={request.isPending}>Enviar solicitud</Button>
        </>
      }
    >
      {p && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            {p.name} cuesta <strong>{planPriceLabel(p)}</strong>. Recibimos tu solicitud y te
            escribimos para coordinar el pago; el plan se activa al confirmarlo.
          </p>
          <Field label="Nota (opcional)" hint="Ej. mejor horario para llamarte o cómo prefieres pagar">
            <Textarea rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      )}
    </Modal>
  )
}
