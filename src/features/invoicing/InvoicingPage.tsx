import { useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { useFiscalSequences, useFiscalSettings, useProcessEcfQueue, type EcfProcessSummary } from '@/hooks/invoicing'
import { RequireAccess } from '@/components/RequireAccess'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Segmented } from '@/components/ui/Segmented'
import { PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { errorMessage } from '@/lib/errors'
import { num } from '@/lib/format'
import { ENV_INFO, FISCAL_STATUS, FunctionError, SimBadge, providerLabel } from '@/features/invoicing/shared'
import { InvoicesTab } from '@/features/invoicing/InvoicesTab'
import { ConfigTab } from '@/features/invoicing/ConfigTab'
import { SequencesTab } from '@/features/invoicing/SequencesTab'
import { GuideTab } from '@/features/invoicing/GuideTab'
import { isEcfNotDeployed } from '@/hooks/invoicing'

export function InvoicingPage() {
  return (
    <RequireAccess module="invoicing" perm="ecf.view">
      <Invoicing />
    </RequireAccess>
  )
}

type Tab = 'docs' | 'config' | 'sequences' | 'guide'

const DEFAULT_TZ = 'America/Santo_Domingo'

/** Resumen legible del lote procesado por la Edge Function. */
function summaryText(s: EcfProcessSummary): string {
  if (!s.claimed) return 'No había comprobantes pendientes en la cola.'
  const parts = [
    s.accepted && `${num(s.accepted)} aceptados`,
    s.accepted_conditional && `${num(s.accepted_conditional)} aceptados condicional`,
    s.rejected && `${num(s.rejected)} rechazados`,
    s.sent && `${num(s.sent)} en proceso`,
    s.errors && `${num(s.errors)} con error`,
  ].filter(Boolean)
  return `Procesados ${num(s.claimed)}: ${parts.join(', ') || 'sin cambios'}.`
}

function Invoicing() {
  const { can, tenant } = useAuth()
  const tz = tenant?.timezone || DEFAULT_TZ
  const settings = useFiscalSettings()
  const sequences = useFiscalSequences()
  const process = useProcessEcfQueue()
  const toast = useToast()
  const canConfigure = can('fiscal.manage')
  const [tab, setTab] = useState<Tab>('docs')

  const tabs: { value: Tab; label: string }[] = [
    { value: 'docs', label: 'Comprobantes' },
    ...(canConfigure ? [{ value: 'config' as const, label: 'Configuración' }] : []),
    { value: 'sequences', label: 'Secuencias' },
    { value: 'guide', label: 'Guía' },
  ]

  const runQueue = () =>
    process.mutate(undefined, {
      onSuccess: (s) => toast.success(summaryText(s)),
      // El aviso de despliegue se pinta en la página; el toast solo para lo demás.
      onError: (e) => {
        if (!isEcfNotDeployed(e)) toast.error(errorMessage(e, 'No se pudo procesar la cola.'))
      },
    })

  if (settings.isLoading) return <PageLoader label="Cargando facturación electrónica…" />

  const fs = settings.data ?? null
  const env = fs ? ENV_INFO[fs.environment] : null
  const status = fs ? FISCAL_STATUS[fs.status] : FISCAL_STATUS.not_configured

  return (
    <div>
      <PageHeader
        title="Facturación electrónica"
        description="Comprobantes fiscales electrónicos (e-CF) de la DGII."
        action={
          <Button variant="outline" onClick={runQueue} loading={process.isPending}>
            <RefreshCw className="h-4 w-4" /> Procesar cola ahora
          </Button>
        }
      />

      {settings.isError && (
        <Card className="mb-4">
          <CardBody className="text-sm text-red-600">
            {errorMessage(settings.error, 'No se pudo cargar la configuración fiscal.')}
          </CardBody>
        </Card>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={status.tone}>{status.label}</Badge>
        {env && <Badge tone={env.tone}>Ambiente: {env.label}</Badge>}
        {fs && <span className="text-slate-500">Proveedor: {providerLabel(fs.provider)}</span>}
        {fs?.provider === 'simulator' && <SimBadge />}
      </div>

      {!fs?.ecf_enabled && (
        <Card className="mb-4 border-amber-200 bg-amber-50/60">
          <CardBody className="flex flex-col gap-3 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              La facturación electrónica no está activada: las ventas se guardan sin comprobante electrónico.
            </p>
            {canConfigure && (
              <Button size="sm" variant="secondary" onClick={() => setTab('config')}>
                Configurar
              </Button>
            )}
          </CardBody>
        </Card>
      )}

      <FunctionError error={process.error} />

      <Segmented label="Sección" value={tab} onChange={setTab} options={tabs} className="mb-4" />

      {tab === 'docs' && <InvoicesTab timezone={tz} />}
      {tab === 'config' && canConfigure && <ConfigTab settings={fs} />}
      {tab === 'sequences' && <SequencesTab timezone={tz} />}
      {tab === 'guide' && <GuideTab settings={fs} sequences={sequences.data ?? []} timezone={tz} />}
    </div>
  )
}
