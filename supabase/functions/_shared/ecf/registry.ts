// ═══════════════════════════════════════════════════════════════════════════
// Ferddo · Registro de proveedores de e-CF
//
// El nombre sale de `fiscal_settings.provider` (vía el payload de la cola), que
// desde la 0031 apunta al catálogo `ecf_providers`: el código de un proveedor
// del catálogo tiene que coincidir con `name` de su adaptador aquí. Un
// proveedor que no esté aquí NO se intenta adivinar: el documento pasa a
// `error` con un mensaje que dice qué falta, y la cola lo reintentará cuando
// se configure. Añadir un proveedor real = un archivo nuevo en esta carpeta,
// escrito con SU documentación técnica, y una línea en este mapa.
// ═══════════════════════════════════════════════════════════════════════════
import type { ElectronicInvoiceProvider } from './provider.ts'
import { simulatorProvider } from './simulator.ts'

const PROVIDERS: Record<string, ElectronicInvoiceProvider> = {
  [simulatorProvider.name]: simulatorProvider,
}

export function getProvider(name: string | null | undefined): ElectronicInvoiceProvider | null {
  if (!name) return null
  return Object.prototype.hasOwnProperty.call(PROVIDERS, name) ? PROVIDERS[name] : null
}

export function providerNotConfiguredMessage(name: string | null | undefined): string {
  return `Proveedor no configurado: "${name ?? '—'}" aún no está integrado en Ferddo. ` +
    'Cambia el proveedor en Facturación → Configuración o contacta a soporte.'
}

export function knownProviders(): string[] {
  return Object.keys(PROVIDERS)
}

/**
 * Adaptadores que de verdad están en este despliegue. El catálogo de la base
 * (`ecf_providers`, 0031) dice qué se OFRECE; esto, qué se sabe ENVIAR. El
 * panel cruza las dos listas para no ofrecer un proveedor sin adaptador.
 */
export function installedProviders(): { code: string; simulated: boolean }[] {
  return Object.values(PROVIDERS).map((p) => ({ code: p.name, simulated: p.simulated }))
}
