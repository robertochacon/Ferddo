// ═══════════════════════════════════════════════════════════════════════════
// Ferddo · Proveedor SIMULADO de e-CF
//
// Existe para que una empresa pruebe el ciclo completo (venta → e-NCF → envío
// → veredicto) en los ambientes de prueba y certificación sin un proveedor
// autorizado. NO firma, NO genera el XML oficial y NO habla con la DGII.
//
// Garantías que no se negocian:
//   · Nunca en producción (lo impide también un check en fiscal_settings).
//   · Cada mensaje dice "Simulación: sin validez fiscal".
//   · Nunca devuelve una `qr_url`: un QR que apunte a la DGII haría pasar por
//     válido un comprobante que no existe para ella.
//   · Determinista: el mismo documento produce siempre el mismo trackId, código
//     y veredicto, para que reprocesarlo no cambie la historia.
// ═══════════════════════════════════════════════════════════════════════════
import {
  type ConfigurationCheck,
  type EcfPayload,
  type ElectronicInvoiceProvider,
  type ProviderMessage,
  type ProviderResult,
  SIMULATION_NOTICE,
} from './provider.ts'

/** Tipos que exigen comprador identificado (espejo de ecf_types.requires_buyer_id). */
const REQUIRES_BUYER_ID = new Set(['31', '44', '45'])
/** Notas de débito/crédito: deben referenciar el e-NCF que modifican. */
const IS_NOTE = new Set(['33', '34'])

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Dígito verificador de RNC (9) y cédula (11). Gemelo de `checkDocNumber()` en
 * src/lib/labels.ts. Que el dígito cuadre NO significa que el RNC exista: eso
 * solo lo confirma la DGII, y el simulador no la consulta.
 */
function validDocNumber(value: string | null | undefined): boolean {
  const d = (value ?? '').replace(/\D/g, '')
  if (d.length === 9) {
    const w = [7, 9, 8, 6, 5, 4, 3, 2]
    const sum = w.reduce((s, x, i) => s + x * Number(d[i]), 0)
    const r = sum % 11
    const check = r === 0 ? 2 : r === 1 ? 1 : 11 - r
    return check === Number(d[8])
  }
  if (d.length === 11) {
    let sum = 0
    for (let i = 0; i < 10; i++) {
      let p = Number(d[i]) * (i % 2 === 0 ? 1 : 2)
      if (p > 9) p -= 9
      sum += p
    }
    return (10 - (sum % 10)) % 10 === Number(d[10])
  }
  return false
}

function notice(extra: string): ProviderMessage[] {
  return [
    { code: 'SIMULACION', message: SIMULATION_NOTICE },
    { code: 'SIM_INFO', message: extra },
  ]
}

/** Motivos de rechazo simulado, en el orden en que los revisaría un validador. */
function rejectionReasons(p: EcfPayload): ProviderMessage[] {
  const out: ProviderMessage[] = []
  if (!validDocNumber(p.issuer?.rnc)) {
    out.push({ code: 'SIM_RNC_EMISOR', message: 'RNC del emisor inválido o sin dígito verificador correcto.' })
  }
  if (REQUIRES_BUYER_ID.has(p.ecf_type)) {
    const buyerId = p.buyer?.id ?? null
    const idType = p.buyer?.id_type ?? null
    if (!buyerId || (idType !== 'rnc' && idType !== 'cedula')) {
      out.push({
        code: 'SIM_COMPRADOR',
        message: `El tipo ${p.ecf_type} exige identificar al comprador con RNC o cédula.`,
      })
    } else if (!validDocNumber(buyerId)) {
      out.push({ code: 'SIM_COMPRADOR', message: 'El RNC o la cédula del comprador no es válido.' })
    }
  }
  if (IS_NOTE.has(p.ecf_type) && !p.reference?.encf) {
    out.push({ code: 'SIM_REFERENCIA', message: 'La nota debe referenciar el e-NCF que modifica.' })
  }
  if (!/^E\d{2}\d{10}$/.test(p.encf)) {
    out.push({ code: 'SIM_ENCF', message: 'El e-NCF no tiene el formato E + tipo (2) + secuencial (10).' })
  }
  return out
}

export const simulatorProvider: ElectronicInvoiceProvider = {
  name: 'simulator',
  simulated: true,
  resolvesImmediately: true,

  async authenticate() {
    // Sin credenciales: el simulador no tiene a quién autenticarse.
  },

  validateConfiguration({ environment }): ConfigurationCheck {
    if (environment === 'production') {
      return {
        ok: false,
        errors: ['El simulador no puede usarse en producción: configura un proveedor autorizado.'],
      }
    }
    return { ok: true, errors: [] }
  },

  async submitInvoice(payload): Promise<ProviderResult> {
    const hash = await sha256Hex(`track:${payload.invoice_id}:${payload.encf}`)
    return {
      status: 'sent',
      track_id: `SIM-${hash.slice(0, 20).toUpperCase()}`,
      messages: notice('Documento recibido por el simulador.'),
    }
  },

  async getInvoiceStatus(trackId, payload): Promise<ProviderResult> {
    const reasons = rejectionReasons(payload)
    if (reasons.length) {
      return {
        status: 'rejected',
        track_id: trackId,
        messages: [{ code: 'SIMULACION', message: SIMULATION_NOTICE }, ...reasons],
      }
    }
    // Código de 6 caracteres derivado del documento, solo para que el ciclo
    // (impresión, consulta) se pueda probar. No es un código de seguridad real.
    const hash = await sha256Hex(`code:${payload.encf}:${trackId}`)
    return {
      status: 'accepted',
      track_id: trackId,
      security_code: hash.slice(0, 6).toUpperCase(),
      messages: notice('Aceptado por el simulador. Este comprobante no existe para la DGII.'),
    }
  },
}
