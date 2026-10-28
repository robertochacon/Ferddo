// ═══════════════════════════════════════════════════════════════════════════
// Ferddo · Contrato de un proveedor de facturación electrónica (e-CF DGII)
//
// ¿Por qué una interfaz y no llamadas directas? Porque Ferddo NO genera el XML
// firmado según el XSD oficial ni habla con los servicios de la DGII: eso lo
// hace un proveedor autorizado (o un adaptador directo cuando la empresa
// complete su certificación). Cada proveedor documenta su propia API; aquí solo
// fijamos lo que la cola necesita de cualquiera de ellos, y el resultado se
// traduce 1:1 al jsonb que espera `ecf_record_result()` (migración 0016).
//
// Regla de honestidad: un adaptador NUEVO se escribe con la documentación
// técnica del proveedor en la mano. No se inventan endpoints, esquemas ni
// detalles de firma.
// ═══════════════════════════════════════════════════════════════════════════

export type EcfEnvironment = 'test' | 'certification' | 'production'

/** Lo que devuelve `ecf_claim()` en cada elemento: enviar o consultar. */
export type EcfAction = 'submit' | 'status'

export interface EcfParty {
  rnc: string | null
  legal_name: string | null
  trade_name: string | null
  address: string | null
  email: string | null
  phone: string | null
}

export interface EcfBuyer {
  id_type: string | null
  id: string | null
  name: string | null
}

export interface EcfLine {
  line: number
  description: string
  quantity: number
  unit: string | null
  unit_price: number
  discount?: number
  tax_rate: number
  subtotal: number
  tax: number
  total: number
  kind: 'product' | 'service'
}

/** Espejo de `ecf_build_payload()`: el contenido canónico del documento. */
export interface EcfPayload {
  invoice_id: string
  tenant_id: string
  ecf_type: string
  encf: string
  environment: EcfEnvironment
  provider: string
  issue_date: string
  currency: string
  issuer: EcfParty
  buyer: EcfBuyer | null
  items: EcfLine[]
  totals: { subtotal: number; tax: number; total: number }
  reference: { encf: string; issue_date: string | null } | null
  /** Configuración NO secreta del proveedor (fiscal_settings.provider_config). */
  provider_config: Record<string, unknown>
  track_id: string | null
}

export interface EcfQueueItem {
  action: EcfAction
  payload: EcfPayload
}

/** Estados que acepta `ecf_record_result()`. */
export type ProviderResultStatus = 'sent' | 'accepted' | 'accepted_conditional' | 'rejected' | 'error'

export interface ProviderMessage {
  code?: string
  message: string
}

/**
 * Resultado de una llamada al proveedor, con la forma EXACTA del `p_result` de
 * `ecf_record_result()`. Nada de lo que vaya aquí puede ser secreto: se guarda
 * en la bitácora de eventos y lo ve el negocio.
 */
export interface ProviderResult {
  status: ProviderResultStatus
  track_id?: string
  security_code?: string
  /** Solo la URL que devuelva el proveedor real. El simulador NUNCA la pone. */
  qr_url?: string
  signed_at?: string
  messages?: ProviderMessage[]
  xml_path?: string
  error?: string
}

export type FiscalSecretKind = 'certificate' | 'certificate_password' | 'provider_credentials'

/**
 * Contexto de una llamada. Los secretos se piden bajo demanda (`getSecret`) y
 * no se pasan descifrados de antemano: un proveedor que no los necesita (el
 * simulador) nunca llega a tenerlos en memoria, y la función no exige
 * FISCAL_ENC_KEY para procesar documentos simulados.
 */
export interface ProviderContext {
  tenantId: string
  environment: EcfEnvironment
  config: Record<string, unknown>
  getSecret: (kind: FiscalSecretKind) => Promise<string | null>
}

export interface ConfigurationCheck {
  ok: boolean
  errors: string[]
}

export interface RetrievedInvoice {
  /** Ruta en Storage del XML firmado, si el proveedor lo entrega. */
  xml_path?: string
  pdf_url?: string
}

export interface ElectronicInvoiceProvider {
  /** Coincide con `fiscal_settings.provider`. */
  readonly name: string
  /** true = lo que emite NO tiene validez fiscal (simulador). */
  readonly simulated: boolean
  /**
   * El proveedor resuelve en el acto: tras un `sent` se puede consultar el
   * estado en la misma pasada sin esperar al siguiente turno de la cola. Un
   * proveedor real normalmente necesita tiempo, así que por defecto es false.
   */
  readonly resolvesImmediately?: boolean
  /** Obtiene o valida la sesión con el proveedor (token, certificado…). */
  authenticate(ctx: ProviderContext): Promise<void>
  /** Comprueba la configuración ANTES de enviar nada. */
  validateConfiguration(cfg: { environment: EcfEnvironment; config: Record<string, unknown> }): ConfigurationCheck
  submitInvoice(payload: EcfPayload, ctx: ProviderContext): Promise<ProviderResult>
  getInvoiceStatus(trackId: string, payload: EcfPayload, ctx: ProviderContext): Promise<ProviderResult>
  retrieveInvoice?(trackId: string, payload: EcfPayload, ctx: ProviderContext): Promise<RetrievedInvoice>
}

/** Texto que acompaña a todo lo que emite el simulador. */
export const SIMULATION_NOTICE = 'Simulación: sin validez fiscal'
