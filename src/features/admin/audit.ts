import type { Tone } from '@/lib/labels'
import { fmtDate, fmtDateTime } from '@/lib/format'
import { ROLE_LABEL } from '@/lib/labels'
import type { PlanInfo } from '@/lib/constants'
import type { MemberRole, PlanCode, PlatformAuditRow, SubscriptionStatus } from '@/types/db'
import { SUB_STATUS_LABEL } from './SubscriptionEditor'

/*
 * Cómo se lee cada línea de `platform_audit_logs` (0028). Las acciones las
 * escriben triggers y RPC de la base; aquí solo se traducen. Una acción que no
 * esté en el lookup se enseña con su código tal cual en vez de desaparecer.
 */

export type AuditCategory = 'support' | 'billing' | 'ecf' | 'tenants' | 'users' | 'platform'

export const AUDIT_CATEGORY_LABEL: Record<AuditCategory, string> = {
  support: 'Accesos de soporte',
  billing: 'Suscripciones y planes',
  ecf: 'Facturación electrónica',
  tenants: 'Negocios',
  users: 'Usuarios',
  platform: 'Super-admins',
}

const ACTIONS: Record<string, { label: string; tone: Tone; category: AuditCategory }> = {
  'support.enter': { label: 'Entró como gestor', tone: 'amber', category: 'support' },
  'support.exit': { label: 'Salió del modo soporte', tone: 'slate', category: 'support' },
  'support.revoke': { label: 'El negocio cortó el acceso de soporte', tone: 'red', category: 'support' },
  'subscription.update': { label: 'Cambió la suscripción', tone: 'brand', category: 'billing' },
  'plan.update': { label: 'Editó un plan', tone: 'brand', category: 'billing' },
  'plan_request.resolve': { label: 'Resolvió una solicitud de plan', tone: 'brand', category: 'billing' },
  'ecf_provider.create': { label: 'Agregó un proveedor de e-CF', tone: 'brand', category: 'ecf' },
  'ecf_provider.update': { label: 'Editó un proveedor de e-CF', tone: 'brand', category: 'ecf' },
  'ecf_provider.delete': { label: 'Eliminó un proveedor de e-CF', tone: 'red', category: 'ecf' },
  'ecf.provider_change': { label: 'Cambió el proveedor de e-CF', tone: 'amber', category: 'ecf' },
  'ecf.provider_migrate': { label: 'Migró negocios de proveedor de e-CF', tone: 'amber', category: 'ecf' },
  'tenant.suspend': { label: 'Suspendió el negocio', tone: 'red', category: 'tenants' },
  'tenant.reactivate': { label: 'Reactivó el negocio', tone: 'green', category: 'tenants' },
  'tenant.delete': { label: 'Eliminó el negocio', tone: 'red', category: 'tenants' },
  'member.role': { label: 'Cambió un rol', tone: 'brand', category: 'users' },
  'member.activate': { label: 'Reactivó a un miembro', tone: 'green', category: 'users' },
  'member.deactivate': { label: 'Desactivó a un miembro', tone: 'amber', category: 'users' },
  'member.remove': { label: 'Quitó a un miembro', tone: 'red', category: 'users' },
  'user.ban': { label: 'Bloqueó una cuenta', tone: 'red', category: 'users' },
  'user.unban': { label: 'Desbloqueó una cuenta', tone: 'green', category: 'users' },
  'platform_admin.grant': { label: 'Agregó un super-admin', tone: 'brand', category: 'platform' },
  'platform_admin.revoke': { label: 'Quitó un super-admin', tone: 'red', category: 'platform' },
  'platform_admin.update': { label: 'Editó un super-admin', tone: 'brand', category: 'platform' },
}

export function auditAction(row: PlatformAuditRow): { label: string; tone: Tone; category: AuditCategory | null } {
  // La salida por caducidad merece su propio texto: no la hizo nadie a mano.
  if (row.action === 'support.exit' && row.meta?.expired === true) {
    return { label: 'Caducó el acceso de soporte', tone: 'slate', category: 'support' }
  }
  return ACTIONS[row.action] ?? { label: row.action, tone: 'slate', category: null }
}

/** Nombres legibles de las columnas que pueden aparecer en un cambio. */
const FIELD_LABEL: Record<string, string> = {
  plan: 'Plan',
  status: 'Estado',
  current_period_end: 'Pagado hasta',
  trial_ends_at: 'Fin de la prueba',
  name: 'nombre',
  price_dop: 'precio RD$',
  price_usd: 'precio US$',
  max_products: 'tope de productos',
  max_members: 'tope de usuarios',
  max_branches: 'tope de sucursales',
  max_registers: 'tope de cajas',
  max_ecf_monthly: 'tope de e-CF',
  modules: 'módulos',
  features: 'características',
}

/** Columnas de `ecf_providers` en un cambio. */
const ECF_FIELD_LABEL: Record<string, string> = {
  name: 'nombre',
  description: 'descripción',
  website: 'sitio web',
  is_enabled: 'ofrecido',
  is_simulated: 'simulado',
  allows_production: 'producción',
  config_fields: 'datos de configuración',
  credential_fields: 'credenciales',
  sort_order: 'orden',
}

const REQUEST_STATUS_LABEL: Record<string, string> = { approved: 'aprobada', rejected: 'rechazada', pending: 'pendiente' }

const str = (v: unknown) => (v == null ? '' : String(v))

/** Una línea que explica la acción con sus datos (motivo, antes → después…). */
export function auditDetail(row: PlatformAuditRow, plans: Record<PlanCode, PlanInfo>): string {
  const m = row.meta ?? {}
  const planName = (code: unknown) => plans[code as PlanCode]?.name ?? str(code) ?? '—'
  switch (row.action) {
    case 'support.enter':
      return `Motivo: «${str(m.reason)}» · hasta ${fmtDateTime(str(m.until))}`
    case 'subscription.update': {
      const changes = (m.changes ?? {}) as Record<string, { from: unknown; to: unknown }>
      const fmt = (key: string, v: unknown) => {
        if (v == null) return '—'
        if (key === 'plan') return planName(v)
        if (key === 'status') return SUB_STATUS_LABEL[v as SubscriptionStatus] ?? str(v)
        if (key.endsWith('_at') || key.endsWith('_end')) return fmtDate(str(v))
        return str(v)
      }
      return Object.entries(changes)
        .filter(([key]) => key in FIELD_LABEL)
        .map(([key, c]) => `${FIELD_LABEL[key]}: ${fmt(key, c.from)} → ${fmt(key, c.to)}`)
        .join(' · ')
    }
    case 'plan.update': {
      const fields = Object.keys((m.changes ?? {}) as object).map((k) => FIELD_LABEL[k] ?? k)
      return `${planName(m.plan)}: ${fields.join(', ') || 'sin cambios visibles'}`
    }
    case 'plan_request.resolve':
      return `Pidió ${planName(m.requested_plan)} · ${REQUEST_STATUS_LABEL[str(m.status)] ?? str(m.status)}`
    case 'ecf_provider.create':
    case 'ecf_provider.delete':
      return `${str(m.name)} (${str(m.code)})`
    case 'ecf_provider.update': {
      const fields = Object.keys((m.changes ?? {}) as object).map((k) => ECF_FIELD_LABEL[k] ?? k)
      return `${str(m.name)}: ${fields.join(', ') || 'sin cambios visibles'}`
    }
    case 'ecf.provider_change':
      return `${str(m.from) || '—'} → ${str(m.to)} · ${str(m.repointed)} comprobante(s) reasignados · «${str(m.reason)}»`
    case 'ecf.provider_migrate':
      return `${str(m.from)} → ${str(m.to)} · ${str(m.moved)} negocio(s)` +
        (Number(m.skipped_production) ? `, ${str(m.skipped_production)} en producción omitidos` : '') +
        ` · «${str(m.reason)}»`
    case 'member.role':
      return `${str(m.email)}: ${ROLE_LABEL[m.from as MemberRole] ?? str(m.from)} → ${ROLE_LABEL[m.to as MemberRole] ?? str(m.to)}`
    case 'member.remove':
      return `${str(m.email)} (${ROLE_LABEL[m.role as MemberRole] ?? str(m.role)})`
    case 'tenant.delete':
      return `Dueño: ${str(m.owner_email) || '—'}${m.deleted_users ? ' · también se borraron las cuentas' : ''}`
    default:
      return str(m.email)
  }
}
