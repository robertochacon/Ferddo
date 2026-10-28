import { FlaskConical, ServerCrash } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Card, CardBody } from '@/components/ui/Card'
import { errorMessage } from '@/lib/errors'
import { isEcfNotDeployed } from '@/hooks/invoicing'
import type { Tone } from '@/lib/labels'
import type { EcfType, FiscalSettings } from '@/types/erp'

/** Qué significa cada ambiente. Se enseña junto al selector: es una decisión legal, no técnica. */
export const ENV_INFO: Record<FiscalSettings['environment'], { label: string; description: string; tone: Tone }> = {
  test: {
    label: 'Pruebas',
    description: 'Para practicar el flujo completo con el simulador. Nada se envía a la DGII y nada tiene validez fiscal.',
    tone: 'slate',
  },
  certification: {
    label: 'Certificación',
    description:
      'Para completar el set de pruebas de la DGII a través de un proveedor autorizado. Con el simulador solo sirve para ensayar; no certifica nada.',
    tone: 'amber',
  },
  production: {
    label: 'Producción',
    description:
      'Comprobantes con validez fiscal. Exige estar autorizado por la DGII como emisor electrónico, certificado digital vigente y un proveedor certificado integrado. El simulador no se puede usar aquí.',
    tone: 'green',
  },
}

export const FISCAL_STATUS: Record<FiscalSettings['status'], { label: string; tone: Tone }> = {
  not_configured: { label: 'Sin configurar', tone: 'slate' },
  configuring: { label: 'En configuración', tone: 'slate' },
  certifying: { label: 'En certificación', tone: 'amber' },
  authorized: { label: 'En producción', tone: 'green' },
  suspended: { label: 'Suspendida', tone: 'red' },
}

/** Proveedores conocidos. Solo el simulador está integrado; no se listan marcas que no existen en el código. */
export const PROVIDER_LABEL: Record<string, string> = {
  simulator: 'Simulador (sin validez fiscal)',
}

export function providerLabel(code: string): string {
  return PROVIDER_LABEL[code] ?? `${code} (pendiente de integrar)`
}

export function ecfTypeLabel(code: string, types: EcfType[] | undefined): string {
  const t = types?.find((x) => x.code === code)
  return t ? `${code} · ${t.name}` : code
}

/** e-NCF de muestra para un tipo y número: E + tipo (2) + secuencial (10). */
export function encfPreview(type: string, n: number): string {
  return `E${type}${String(Math.max(0, Math.trunc(n))).padStart(10, '0')}`
}

/** Marca visible en TODO lo que salió del simulador. */
export function SimBadge() {
  return (
    <Badge tone="amber" className="font-semibold">
      <FlaskConical className="h-3 w-3" /> SIMULACIÓN
    </Badge>
  )
}

/**
 * Aviso cuando la Edge Function `ecf` no responde. Es el error típico de un
 * proyecto recién creado: las migraciones están aplicadas pero la función no
 * se ha desplegado, y sin este texto el usuario solo vería "error de red".
 */
export function FunctionError({ error }: { error: unknown }) {
  if (!error) return null
  if (!isEcfNotDeployed(error)) {
    return (
      <Card className="mb-4 border-red-200">
        <CardBody className="text-sm text-red-700">{errorMessage(error)}</CardBody>
      </Card>
    )
  }
  return (
    <Card className="mb-4 border-amber-200 bg-amber-50/60">
      <CardBody className="flex gap-3 text-sm text-amber-900">
        <ServerCrash className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0 space-y-1.5">
          <p className="font-semibold">El procesador de comprobantes no está disponible.</p>
          <p>
            La Edge Function <code className="rounded bg-amber-100 px-1">ecf</code> no respondió; lo más probable es
            que no esté desplegada. Quien administre el proyecto de Supabase debe ejecutar:
          </p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-white/70 p-2 text-xs">
            supabase functions deploy ecf{'\n'}supabase secrets set FISCAL_ENC_KEY=… ECF_CRON_SECRET=…
          </pre>
          <p className="text-xs">
            Mientras tanto, las ventas siguen guardándose y sus comprobantes quedan en cola como “Pendiente de envío”.
          </p>
        </div>
      </CardBody>
    </Card>
  )
}
