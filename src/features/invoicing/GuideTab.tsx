import { CalendarClock, CheckCircle2, Circle, ExternalLink } from 'lucide-react'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/cn'
import { dayIn } from '@/hooks/reports'
import type { FiscalSequence, FiscalSettings } from '@/types/erp'

/**
 * Guía de habilitación como emisor electrónico. Es ESTÁTICA a propósito: los
 * pasos y plazos los fija la DGII y cambian por avisos; aquí se resume lo que
 * se sabe y se manda siempre a verificar en dgii.gov.do. Los pasos que Ferddo
 * puede comprobar por sí mismo (datos fiscales, certificado cargado,
 * secuencias) se marcan solos; el resto depende de trámites fuera de la app.
 */

/** Plazo para pequeños y micro contribuyentes (Ley 32-23, Aviso 06-2026). Verificar en dgii.gov.do. */
const SMALL_TAXPAYER_DEADLINE = '2026-11-15'

type StepState = 'done' | 'pending' | 'external'

const STEP_BADGE: Record<StepState, { label: string; tone: 'green' | 'amber' | 'slate' }> = {
  done: { label: 'Listo en Ferddo', tone: 'green' },
  pending: { label: 'Pendiente', tone: 'amber' },
  external: { label: 'Trámite externo', tone: 'slate' },
}

interface Step {
  title: string
  body: string
  state: StepState
}

export function GuideTab({
  settings,
  sequences,
  timezone,
}: {
  settings: FiscalSettings | null
  sequences: FiscalSequence[]
  timezone: string
}) {
  const today = dayIn(timezone)
  const daysLeft = Math.round(
    (new Date(`${SMALL_TAXPAYER_DEADLINE}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / 86_400_000,
  )
  const hasFiscalData = Boolean(settings?.rnc && settings.legal_name && settings.fiscal_address)
  const hasSaleSequence = sequences.some((s) => s.is_active && (s.ecf_type === '31' || s.ecf_type === '32'))
  const realProvider = Boolean(settings && settings.provider !== 'simulator')

  const steps: Step[] = [
    {
      title: 'Registrarte como emisor electrónico en la Oficina Virtual (OFV)',
      body: 'Solicita en la OFV de la DGII la autorización para emitir comprobantes fiscales electrónicos.',
      state: 'external',
    },
    {
      title: 'Obtener el certificado digital',
      body: 'Certificado para procesos tributarios a nombre de la persona física o jurídica, emitido por una entidad de certificación autorizada. Cárgalo en la pestaña Configuración.',
      state: settings?.credentials_set ? 'done' : 'pending',
    },
    {
      title: 'Completar los datos fiscales de la empresa',
      body: 'RNC, razón social y dirección fiscal tal como figuran en la DGII.',
      state: hasFiscalData ? 'done' : 'pending',
    },
    {
      title: 'Elegir un proveedor de facturación electrónica autorizado',
      body: 'Ferddo envía los comprobantes a través de un proveedor certificado por la DGII. Su integración está pendiente; mientras tanto solo funciona el simulador, sin validez fiscal.',
      state: realProvider ? 'done' : 'pending',
    },
    {
      title: 'Superar el set de pruebas / certificación',
      body: 'La DGII exige completar las pruebas en el ambiente de certificación antes de autorizar la emisión en producción.',
      state: 'external',
    },
    {
      title: 'Solicitar y registrar las secuencias e-NCF',
      body: 'Pide la autorización de los rangos en la OFV y regístralos en la pestaña Secuencias (al menos 31 o 32 para vender).',
      state: hasSaleSequence ? 'done' : 'pending',
    },
    {
      title: 'Pasar a producción',
      body: 'Con la autorización de la DGII y el proveedor integrado, cambia el ambiente a Producción. El simulador nunca puede usarse ahí.',
      state: settings?.environment === 'production' ? 'done' : 'pending',
    },
  ]

  return (
    <div className="space-y-4">
      <Card className={cn(daysLeft >= 0 && daysLeft <= 60 ? 'border-amber-200 bg-amber-50/60' : undefined)}>
        <CardBody className="flex gap-3 text-sm text-slate-700">
          <CalendarClock className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="space-y-1">
            <p className="font-semibold text-slate-900">
              Plazo para pequeños y micro contribuyentes: 15 de noviembre de 2026
              {daysLeft > 0 && ` (faltan ${daysLeft} ${daysLeft === 1 ? 'día' : 'días'})`}
              {daysLeft === 0 && ' (es hoy)'}
              {daysLeft < 0 && ' (ya venció)'}
            </p>
            <p>
              Según la Ley 32-23 de Facturación Electrónica y el Aviso 06-2026. Las fechas y los requisitos pueden
              cambiar: <strong>verifica siempre en dgii.gov.do</strong> y con tu contador.
            </p>
            <a
              href="https://dgii.gov.do"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline"
            >
              Ir a dgii.gov.do <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Pasos para emitir comprobantes electrónicos" subtitle="Lista orientativa; verifica en dgii.gov.do" />
        <CardBody>
          <ol className="space-y-4">
            {steps.map((s, i) => {
              const badge = STEP_BADGE[s.state]
              const Icon = s.state === 'done' ? CheckCircle2 : Circle
              return (
                <li key={s.title} className="flex gap-3">
                  <Icon
                    className={cn('mt-0.5 h-5 w-5 shrink-0', s.state === 'done' ? 'text-emerald-600' : 'text-slate-300')}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-slate-800">
                        {i + 1}. {s.title}
                      </p>
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    </div>
                    <p className="mt-0.5 text-sm text-slate-600">{s.body}</p>
                  </div>
                </li>
              )
            })}
          </ol>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Qué hace Ferddo hoy" />
        <CardBody>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-600">
            <li>Reserva un e-NCF por venta (E + tipo + 10 dígitos) de tus rangos autorizados, sin duplicados.</li>
            <li>Emite notas de crédito (34) automáticamente al devolver una venta que tenía comprobante.</li>
            <li>Guarda el historial de cada envío y reintenta solo los errores técnicos, nunca un rechazo.</li>
            <li>
              Con el <strong>simulador</strong> puedes probar todo el ciclo; lo emitido se marca “SIMULACIÓN” y no tiene
              validez fiscal.
            </li>
            <li>
              No genera el XML oficial firmado ni se conecta directamente con la DGII: eso lo hará el proveedor
              autorizado cuando se integre.
            </li>
          </ul>
        </CardBody>
      </Card>
    </div>
  )
}
