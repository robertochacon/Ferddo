// Tipos del ERP/POS: espejo a mano de las migraciones 0013–0018.
//
// Separado de db.ts (núcleo SaaS) solo por tamaño; las reglas son las mismas:
// snake_case igual que la columna, y si cambia una columna o el jsonb de una
// RPC, se cambia aquí en el mismo commit. Los numeric de Postgres llegan como
// number por PostgREST; dentro de un jsonb pueden llegar como string, de ahí
// que los hooks que leen RPC hagan Number() donde importa.

import type { MemberRole, ModuleCode } from '@/types/db'

export type ProductKind = 'product' | 'service'
export type PaymentMethod = 'cash' | 'card' | 'transfer' | 'credit' | 'credit_note' | 'other'
export type SaleStatus = 'completed' | 'voided' | 'partially_returned' | 'returned'
export type CashSessionStatus = 'open' | 'closed'
export type CashMovementKind =
  | 'sale'
  | 'sale_void'
  | 'refund'
  | 'cash_in'
  | 'cash_out'
  | 'receivable_payment'
  | 'payable_payment'
  | 'expense'
export type InventoryMovementKind =
  | 'initial'
  | 'purchase'
  | 'sale'
  | 'sale_void'
  | 'sale_return'
  | 'adjustment_in'
  | 'adjustment_out'
  | 'transfer_in'
  | 'transfer_out'
  | 'count'
export type DocumentStatus = 'open' | 'paid' | 'canceled'
export type PurchaseStatus = 'draft' | 'ordered' | 'received' | 'canceled'
export type ExpenseStatus = 'paid' | 'pending' | 'voided'
export type QuotationStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired' | 'converted'
export type EcfStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'accepted'
  | 'accepted_conditional'
  | 'rejected'
  | 'error'
  | 'voided'
export type CustomerDocType = 'rnc' | 'cedula' | 'passport' | 'none'

// ── Configuración global ────────────────────────────────────────────────────
export interface BusinessType {
  code: string
  label: string
  modules: ModuleCode[]
  sort_order: number
}

export interface Permission {
  code: string
  module: string
  label: string
  sort_order: number
}

export interface MyTenant {
  id: string
  name: string
  logo_url: string | null
  role: MemberRole
  business_type: string
  suspended: boolean
  active: boolean
}

export interface TeamMemberRow {
  user_id: string
  role: MemberRole
  is_active: boolean
  branch_ids: string[] | null
  created_at: string
  full_name: string | null
  /** Solo llega a quien tiene team.manage. */
  email: string | null
}

// ── Empresa ─────────────────────────────────────────────────────────────────
export interface Branch {
  id: string
  tenant_id: string
  name: string
  code: string | null
  address: string | null
  province: string | null
  municipality: string | null
  phone: string | null
  is_main: boolean
  is_active: boolean
  settings: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface CashRegister {
  id: string
  tenant_id: string
  branch_id: string
  name: string
  /** { paper_width: 58 | 80, … } */
  settings: { paper_width?: 58 | 80; [k: string]: unknown }
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface Tax {
  id: string
  tenant_id: string
  name: string
  code: string
  /** Fracción: 0.18 = 18 %. */
  rate: number
  is_default: boolean
  is_active: boolean
}

export interface Category {
  id: string
  tenant_id: string
  name: string
  parent_id: string | null
  is_active: boolean
}

// ── Catálogo ────────────────────────────────────────────────────────────────
export interface Product {
  id: string
  tenant_id: string
  kind: ProductKind
  parent_id: string | null
  variant_label: string | null
  code: string | null
  sku: string | null
  barcode: string | null
  name: string
  description: string | null
  category_id: string | null
  brand: string | null
  unit: string
  cost: number
  price: number
  tax_id: string | null
  track_stock: boolean
  min_stock: number
  duration_minutes: number | null
  image_url: string | null
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface Customer {
  id: string
  tenant_id: string
  name: string
  kind: 'person' | 'company'
  doc_type: CustomerDocType
  doc_number: string | null
  phone: string | null
  email: string | null
  address: string | null
  credit_limit: number
  credit_days: number
  notes: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface CustomerBalance {
  tenant_id: string
  customer_id: string
  balance: number
  oldest_due: string
  open_documents: number
}

export interface Supplier {
  id: string
  tenant_id: string
  name: string
  rnc: string | null
  contact_name: string | null
  phone: string | null
  email: string | null
  address: string | null
  payment_terms_days: number
  notes: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface SupplierBalance {
  tenant_id: string
  supplier_id: string
  balance: number
  oldest_due: string
  open_documents: number
}

// ── Inventario ──────────────────────────────────────────────────────────────
export interface StockLevel {
  tenant_id: string
  branch_id: string
  product_id: string
  quantity: number
  updated_at: string
}

export interface InventoryMovement {
  id: string
  tenant_id: string
  branch_id: string
  product_id: string
  kind: InventoryMovementKind
  quantity: number
  unit_cost: number
  balance_after: number
  reference_type: string | null
  reference_id: string | null
  line_ref: string | null
  reason: string | null
  created_by: string | null
  created_at: string
}

export interface InventoryDocument {
  id: string
  tenant_id: string
  kind: 'adjustment' | 'transfer' | 'count'
  number: string
  branch_id: string
  to_branch_id: string | null
  note: string | null
  lines: number
  created_by: string | null
  created_at: string
}

// ── Caja y ventas ───────────────────────────────────────────────────────────
export interface CashSession {
  id: string
  tenant_id: string
  branch_id: string
  register_id: string
  number: string
  status: CashSessionStatus
  opened_by: string | null
  opened_at: string
  opening_amount: number
  closed_by: string | null
  closed_at: string | null
  expected_cash: number | null
  counted_cash: number | null
  difference: number | null
  totals: Record<string, number> | null
  notes: string | null
}

export interface CashMovement {
  id: string
  tenant_id: string
  session_id: string
  kind: CashMovementKind
  method: PaymentMethod
  amount: number
  reference_type: string | null
  reference_id: string | null
  note: string | null
  created_by: string | null
  created_at: string
}

/** `cash_session_report()` */
export interface CashSessionReport {
  session: CashSession
  register_name: string | null
  opened_by_name: string | null
  expected_cash: number
  by_method: Record<string, number>
  by_kind: Record<string, number>
  sales_count: number
  sales_total: number
  credit_total: number
}

export interface Sale {
  id: string
  tenant_id: string
  client_uid: string
  branch_id: string
  register_id: string
  session_id: string
  seq: number
  number: string
  status: SaleStatus
  customer_id: string | null
  seller_id: string | null
  quotation_id: string | null
  subtotal: number
  discount_total: number
  tax_total: number
  total: number
  paid_total: number
  change_due: number
  credit_amount: number
  returned_total: number
  ecf_type: string | null
  notes: string | null
  created_by: string | null
  created_at: string
  voided_at: string | null
  voided_by: string | null
  void_reason: string | null
}

export interface SaleItem {
  id: string
  tenant_id: string
  sale_id: string
  line_no: number
  product_id: string
  description: string
  quantity: number
  unit_price: number
  discount: number
  tax_id: string | null
  tax_rate: number
  subtotal: number
  tax_amount: number
  total: number
  unit_cost: number
  returned_qty: number
}

export interface SalePayment {
  id: string
  tenant_id: string
  sale_id: string
  method: PaymentMethod
  amount: number
  tendered: number | null
  reference: string | null
  created_at: string
}

export interface SaleReturn {
  id: string
  tenant_id: string
  sale_id: string
  number: string
  session_id: string | null
  refund_method: PaymentMethod
  restock: boolean
  subtotal: number
  tax_total: number
  total: number
  reason: string
  created_by: string | null
  created_at: string
}

/** Respuesta de `create_sale()`. */
export interface CreateSaleResult {
  sale_id: string
  number: string
  total: number
  change_due: number
  replayed: boolean
  ecf: { invoice_id: string; encf: string; status: EcfStatus; simulated: boolean } | null
}

// ── Cuentas por cobrar / pagar ──────────────────────────────────────────────
export interface Receivable {
  id: string
  tenant_id: string
  customer_id: string
  sale_id: string | null
  description: string | null
  amount: number
  paid_amount: number
  due_date: string
  status: DocumentStatus
  created_at: string
}

export interface CustomerPayment {
  id: string
  tenant_id: string
  number: string
  customer_id: string
  amount: number
  method: PaymentMethod
  session_id: string | null
  reference: string | null
  note: string | null
  created_by: string | null
  created_at: string
}

export interface AgingRow {
  customer_id: string
  customer_name: string
  total: number
  current: number | null
  d1_30: number | null
  d31_60: number | null
  d61_90: number | null
  d90_plus: number | null
}

export interface Payable {
  id: string
  tenant_id: string
  supplier_id: string | null
  source_type: 'purchase' | 'expense' | 'manual'
  source_id: string | null
  description: string
  amount: number
  paid_amount: number
  due_date: string
  status: DocumentStatus
  created_at: string
}

export interface SupplierPayment {
  id: string
  tenant_id: string
  number: string
  supplier_id: string | null
  amount: number
  method: PaymentMethod
  session_id: string | null
  reference: string | null
  note: string | null
  created_at: string
}

// ── Compras, gastos, cotizaciones ───────────────────────────────────────────
export interface Purchase {
  id: string
  tenant_id: string
  branch_id: string
  supplier_id: string
  seq: number
  number: string
  status: PurchaseStatus
  supplier_invoice: string | null
  supplier_ncf: string | null
  order_date: string
  due_date: string | null
  received_at: string | null
  received_by: string | null
  subtotal: number
  discount_total: number
  tax_total: number
  total: number
  notes: string | null
  attachment_path: string | null
  canceled_reason: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface PurchaseItem {
  id: string
  purchase_id: string
  line_no: number
  product_id: string
  description: string
  quantity: number
  unit_cost: number
  discount: number
  tax_rate: number
  subtotal: number
  tax_amount: number
  total: number
}

export interface ExpenseCategory {
  id: string
  tenant_id: string
  name: string
  is_active: boolean
}

export interface Expense {
  id: string
  tenant_id: string
  number: string
  branch_id: string
  category_id: string
  supplier_id: string | null
  description: string
  amount: number
  tax_amount: number
  expense_date: string
  method: PaymentMethod | null
  status: ExpenseStatus
  ncf: string | null
  attachment_path: string | null
  session_id: string | null
  payable_id: string | null
  void_reason: string | null
  created_by: string | null
  created_at: string
}

export interface Quotation {
  id: string
  tenant_id: string
  branch_id: string
  seq: number
  number: string
  customer_id: string | null
  status: QuotationStatus
  valid_until: string
  subtotal: number
  discount_total: number
  tax_total: number
  total: number
  global_discount: number
  notes: string | null
  terms: string | null
  converted_sale_id: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface QuotationItem {
  id: string
  quotation_id: string
  line_no: number
  product_id: string
  description: string
  quantity: number
  unit_price: number
  /** Descuento total de la línea (propio + reparto del global). */
  discount: number
  /** Solo el descuento propio de la línea (para reeditar). */
  line_discount: number
  tax_id: string | null
  tax_rate: number
  subtotal: number
  tax_amount: number
  total: number
}

// ── Facturación electrónica ────────────────────────────────────────────────
export interface EcfType {
  code: string
  name: string
  requires_buyer_id: boolean
  is_note: boolean
  is_supported: boolean
  sort_order: number
}

export interface FiscalSettings {
  tenant_id: string
  ecf_enabled: boolean
  environment: 'test' | 'certification' | 'production'
  provider: string
  provider_config: Record<string, unknown>
  status: 'not_configured' | 'configuring' | 'certifying' | 'authorized' | 'suspended'
  rnc: string | null
  legal_name: string | null
  trade_name: string | null
  fiscal_address: string | null
  email: string | null
  phone: string | null
  default_ecf_type: string
  certificate_info: { subject?: string; expires_at?: string; uploaded_at?: string } | null
  credentials_set: boolean
  updated_at: string
}

export interface FiscalSequence {
  id: string
  tenant_id: string
  ecf_type: string
  start_number: number
  end_number: number
  next_number: number
  expires_on: string | null
  authorization_ref: string | null
  is_active: boolean
  created_at: string
}

export interface ElectronicInvoice {
  id: string
  tenant_id: string
  branch_id: string | null
  source_type: 'sale' | 'sale_return'
  source_id: string
  ecf_type: string
  encf: string
  environment: string
  provider: string
  /** Emitido con el simulador: SIN validez fiscal. */
  simulated: boolean
  issue_date: string
  buyer_id_type: string | null
  buyer_id: string | null
  buyer_name: string | null
  currency: string
  subtotal: number
  tax_total: number
  total: number
  reference_invoice_id: string | null
  reference_encf: string | null
  status: EcfStatus
  track_id: string | null
  security_code: string | null
  qr_url: string | null
  signed_at: string | null
  sent_at: string | null
  resolved_at: string | null
  messages: { code?: string; message?: string }[]
  xml_path: string | null
  attempts: number
  next_attempt_at: string
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface ElectronicInvoiceEvent {
  id: string
  invoice_id: string
  event: string
  status_from: EcfStatus | null
  status_to: EcfStatus | null
  detail: Record<string, unknown> | null
  created_at: string
}

// ── Reportes ────────────────────────────────────────────────────────────────
export interface ReportRow {
  key: string
  count?: number
  quantity?: number
  total: number
  tax?: number
  discount?: number
  cost?: number
}

export interface TaxReport {
  itbis_sales: number
  itbis_returns: number
  itbis_collected: number
  itbis_purchases: number
  itbis_expenses: number
  itbis_paid: number
  difference: number
  by_rate: { tax_rate: number; base: number; tax: number }[]
}

export interface InventoryValuation {
  total_cost: number
  total_retail: number
  products: number
  by_category: { category: string; cost_value: number; retail_value: number }[]
}

export interface PlanUsage {
  products: number
  members: number
  branches: number
  registers: number
  ecf_month: number
}
