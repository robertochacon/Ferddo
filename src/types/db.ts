// Tipos del dominio: espejo a mano del esquema de supabase/migrations.
//
// Se escriben a mano (y no con `npm run types:gen`) porque la mitad de lo que
// consume la app no son tablas sino el JSON que devuelven las RPC
// `security definer`, que el generador no sabe describir. Los nombres de campo
// van en snake_case, IGUAL que en la base: así una fila cruda de PostgREST o el
// jsonb de una RPC encajan sin traducir nada por el medio, que es donde se
// cuelan los errores silenciosos.
//
// Regla: si cambias una columna o el `jsonb_build_object` de una RPC, cambia
// también su interfaz aquí en el mismo commit.

// ── Enums (espejo de los `create type` de 0001 y 0012) ──────────────────────
export type MemberRole =
  | 'owner'
  | 'admin'
  | 'supervisor'
  | 'cashier'
  | 'seller'
  | 'inventory'
  | 'purchasing'
  | 'accounting'
  | 'kitchen'
  | 'service'
export type SubscriptionStatus = 'trial' | 'active' | 'past_due' | 'canceled'
/** basic = Básico, pro = Negocio, enterprise = Empresa (nombre visible en plan_settings). */
export type PlanCode = 'basic' | 'pro' | 'enterprise'
export type PlanRequestStatus = 'pending' | 'approved' | 'rejected'
/** Módulos funcionales (ver business_types / plan_settings.modules, migración 0013). */
export type ModuleCode =
  | 'pos'
  | 'inventory'
  | 'cash'
  | 'credit'
  | 'invoicing'
  | 'purchases'
  | 'expenses'
  | 'payables'
  | 'quotations'
  | 'reports'
  | 'restaurant'
  | 'workshop'
  | 'appointments'

// ── Tablas del núcleo ───────────────────────────────────────────────────────

/** El negocio / espacio de trabajo. Todo lo demás cuelga de aquí. */
export interface Tenant {
  id: string
  name: string
  logo_url: string | null
  phone: string | null
  whatsapp: string | null
  email: string | null
  address: string | null
  currency: string
  locale: string
  legal_name: string | null
  /** RNC (9 dígitos) o cédula (11). */
  rnc: string | null
  business_type: string
  province: string | null
  municipality: string | null
  timezone: string
  /** Módulos encendidos en la empresa; los efectivos son estos ∩ los del plan. */
  modules: ModuleCode[]
  /** El precio de venta ya incluye el ITBIS (lo habitual en RD). */
  prices_include_tax: boolean
  allow_negative_stock: boolean
  receipt_footer: string | null
  settings: Record<string, unknown>
  /** Suspensión comercial: mientras esté puesta, el negocio queda en solo lectura. */
  suspended_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/**
 * Un usuario de auth y su empresa ACTIVA. La pertenencia real (puede ser a
 * varias empresas) vive en `tenant_members`; `tenant_id` es solo el puntero que
 * se mueve con `switch_tenant()`. null = sin empresa (onboarding pendiente o
 * cuenta de plataforma).
 */
export interface Profile {
  id: string
  tenant_id: string | null
  full_name: string | null
  avatar_url: string | null
  role: MemberRole
  created_at: string
}

/** Una por negocio (`tenant_id` es unique). El cliente solo la LEE. */
export interface Subscription {
  id: string
  tenant_id: string
  plan: PlanCode
  status: SubscriptionStatus
  started_at: string
  trial_ends_at: string | null
  current_period_end: string | null
  updated_at: string
}

export interface Notification {
  id: string
  tenant_id: string
  title: string
  body: string | null
  read: boolean
  created_at: string
}

export interface AuditLog {
  id: string
  tenant_id: string
  user_id: string | null
  action: string
  entity: string | null
  entity_id: string | null
  meta: Record<string, unknown> | null
  created_at: string
}

// ── Super-admin de plataforma (cross-tenant) ────────────────────────────────
// Estas formas NO son tablas: son el jsonb que devuelven las RPC `admin_*`.

/** `admin_overview()` — cifras globales, SOLO agregadas. */
export interface AdminOverview {
  tenants: number
  active_tenants_30d: number
  members: number
  branches: number
  sales_30d: number
  ecf_30d: number
  ecf_errors: number
  platform_admins: number
  /**
   * Agregados como objeto {plan: n} y no como columnas fijas: si mañana el enum
   * `plan_code` crece, la UI no se queda ciega. De ahí el `Partial`.
   */
  by_plan: Partial<Record<PlanCode, number>>
  by_status: Partial<Record<SubscriptionStatus, number>>
  by_business_type: Record<string, number>
}

/** `admin_list_tenants()` — una fila por negocio, con su plan y su dueño. */
export interface AdminTenantRow {
  id: string
  name: string
  rnc: string | null
  business_type: string
  created_at: string
  whatsapp: string | null
  currency: string
  suspended: boolean
  /** null si el negocio se quedó sin fila en `subscriptions` (dato inconsistente). */
  plan: PlanCode | null
  sub_status: SubscriptionStatus | null
  trial_ends_at: string | null
  current_period_end: string | null
  owner_name: string | null
  owner_email: string | null
  members: number
  branches: number
  products: number
  sales_30d: number
  ecf_errors: number
  last_sale_at: string | null
}

/** `admin_list_members(p_tenant)` — miembros de un negocio + estado de su cuenta. */
export interface AdminMember {
  id: string
  full_name: string | null
  role: MemberRole
  is_active: boolean
  created_at: string
  email: string | null
  /** `auth.users.banned_until` en el futuro: la cuenta no puede iniciar sesión. */
  banned: boolean
}

/** `admin_list_platform_admins()`. */
export interface PlatformAdminRow {
  user_id: string
  email: string | null
  note: string | null
  created_at: string
}

/** `admin_tenant_summary(p_tenant)` — uso del negocio visto desde fuera (agregados). */
export interface AdminTenantSummary {
  members: number
  branches: number
  registers: number
  products: number
  customers: number
  sales_30d: number
  sales_total: number
  last_sale_at: string | null
  ecf_by_status: Record<string, number>
  ecf_environment: string | null
  ecf_enabled: boolean | null
  pending_invites: number
  subscription_history: {
    plan: PlanCode
    status: SubscriptionStatus
    created_at: string
    current_period_end: string | null
  }[]
}

// ── Solicitudes de cambio de plan ───────────────────────────────────────────

/** Vista de la dueña: su propia solicitud (lectura directa de `plan_requests`). */
export interface MyPlanRequest {
  id: string
  requested_plan: PlanCode
  status: PlanRequestStatus
  created_at: string
}

/** Vista del super-admin: todas las solicitudes, con el negocio que las pidió. */
export interface AdminPlanRequestRow {
  id: string
  tenant_id: string
  tenant_name: string
  requested_plan: PlanCode
  current_plan: PlanCode | null
  status: PlanRequestStatus
  note: string | null
  created_at: string
  resolved_at: string | null
  whatsapp: string | null
  owner_name: string | null
  owner_email: string | null
}

// ── Eliminar un negocio (borrado en cascada) ────────────────────────────────

/** `admin_tenant_purge_preview()` — lo que se va a borrar, para enseñarlo ANTES de confirmar. */
export interface AdminTenantPurgePreview {
  tenant_id: string
  name: string
  suspended: boolean
  created_at: string
  owner_email: string | null
  /** Filas por tabla (tenant_members, products, sales, electronic_invoices…). */
  counts: Record<string, number>
  /** `null` = no se pudo contar (sin privilegio sobre Storage), que NO es "cero". */
  files: number | null
}

/**
 * `admin_delete_tenant()` + lo que añade el cliente tras vaciar Storage.
 * Los archivos NO se borran por SQL (dejaría el blob huérfano en el bucket): la
 * RPC devuelve sus rutas y la app las elimina con la API, así que las cifras de
 * archivos se completan en el navegador.
 */
export interface AdminTenantPurgeResult {
  tenant_id: string
  name: string
  /** Filas borradas por tabla. `files: -1` = el servidor no pudo leer Storage. */
  counts: Record<string, number>
  files: { bucket: string; path: string }[]
  /** Archivos que la propia app borró del bucket (no viene del servidor). */
  files_removed: number
  files_failed: number
  /** Archivos que siguen en el bucket tras el intento; `null` si no se pudo listar. */
  files_pending: number | null
  /** `true` = no hay cuenta fiable de archivos, así que la UI no debe cantar victoria. */
  files_unknown: boolean
}

/** `admin_list_tenant_purges()` — bitácora: un negocio que ya se eliminó. */
export interface AdminTenantPurgeRow {
  id: string
  tenant_id: string
  tenant_name: string
  owner_email: string | null
  deleted_by_email: string | null
  deleted_users: boolean
  counts: Record<string, number>
  created_at: string
}

// ── Dashboard del negocio ───────────────────────────────────────────────────

/**
 * `dashboard_summary(p_branch)`. Criterios de cálculo en la migración 0018 y en
 * docs/SAAS_IMPLEMENTATION_PLAN.md. La RPC devuelve `{}` sin empresa activa,
 * así que el hook rellena ceros.
 */
export interface DashboardSummary {
  sales_today: number
  count_today: number
  sales_month: number
  count_month: number
  tax_month: number
  /** Ventas netas sin ITBIS − costo de lo vendido. NO descuenta gastos. */
  gross_margin_month: number
  payment_methods_month: Record<string, number>
  top_products_month: { product_id: string; name: string; quantity: number; amount: number }[]
  sales_by_day: { day: string; total: number; count: number }[]
  low_stock: { id: string; name: string; min_stock: number; stock: number }[]
  low_stock_count: number
  receivables_open: number
  receivables_overdue: number
  payables_open: number
  expenses_month: number
  ecf_month: Record<string, number>
  open_sessions: number
  members: number
}
