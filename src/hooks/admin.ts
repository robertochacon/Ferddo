import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { removeTenantFiles } from '@/lib/storage'
import type {
  AdminMember,
  AdminOverview,
  AdminPlanRequestRow,
  AdminTenantPurgePreview,
  AdminTenantPurgeResult,
  AdminTenantPurgeRow,
  AdminTenantRow,
  AdminTenantSummary,
  MemberRole,
  PlanCode,
  PlanRequestStatus,
  PlatformAdminRow,
  SubscriptionStatus,
} from '@/types/db'

// Todo este módulo habla SOLO por RPC `admin_*`. No es una preferencia de
// estilo: las políticas cross-tenant del super-admin son de SELECT y no le dan
// acceso a `auth.users`, así que los joins con correos y los cambios de plan o
// de rol tienen que venir de funciones `security definer` que además vuelven a
// comprobar `auth_is_platform_admin()`.
//
// Las mutaciones invalidan `['admin']` entero, no la clave exacta: casi
// cualquier cambio (plan, suspensión, rol, borrado) se refleja a la vez en el
// resumen, en la lista de negocios y en el detalle, y perseguir cada clave se
// olvida justo la que hace falta.

/** Métricas globales de la plataforma (todas las cuentas). */
export function useAdminOverview() {
  return useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: async (): Promise<AdminOverview> => {
      const { data, error } = await supabase.rpc('admin_overview')
      if (error) throw error
      return data as AdminOverview
    },
  })
}

/** Listado de todos los negocios con sus métricas y su dueña. */
export function useAdminTenants() {
  return useQuery({
    queryKey: ['admin', 'tenants'],
    queryFn: async (): Promise<AdminTenantRow[]> => {
      const { data, error } = await supabase.rpc('admin_list_tenants')
      if (error) throw error
      return (data ?? []) as AdminTenantRow[]
    },
  })
}

/**
 * Edita la suscripción de un negocio: plan, estado y fechas
 * (`admin_update_subscription`, 0018). Cada cambio deja una fila en
 * `subscription_events` (trigger), que es el historial del detalle.
 *
 * Las fechas `null` significan "no tocar": la RPC hace `coalesce` con lo que
 * había, así que desde aquí no se puede BORRAR una fecha, solo moverla.
 */
export function useAdminUpdateSubscription() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (args: {
      tenant: string
      plan: PlanCode
      status: SubscriptionStatus
      currentPeriodEnd?: string | null
      trialEndsAt?: string | null
    }) => {
      const { error } = await supabase.rpc('admin_update_subscription', {
        p_tenant: args.tenant,
        p_plan: args.plan,
        p_status: args.status,
        p_current_period_end: args.currentPeriodEnd ?? null,
        p_trial_ends_at: args.trialEndsAt ?? null,
      })
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  })
}

/** Suspende / reactiva un negocio entero (queda en solo lectura). */
export function useAdminSetTenantSuspended() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (args: { tenant: string; suspended: boolean }) => {
      const { error } = await supabase.rpc('admin_set_tenant_suspended', {
        p_tenant: args.tenant,
        p_suspended: args.suspended,
      })
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  })
}

/**
 * El panel de un negocio, visto desde fuera: SOLO agregados (conteos, estado
 * de e-CF, historial de suscripción). Por diseño no trae ventas, clientes ni
 * productos concretos: el soporte no necesita leer el negocio de nadie.
 */
export function useAdminTenantSummary(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'tenant-summary', tenantId],
    enabled: Boolean(tenantId),
    queryFn: async (): Promise<AdminTenantSummary> => {
      const { data, error } = await supabase.rpc('admin_tenant_summary', { p_tenant: tenantId })
      if (error) throw error
      return data as AdminTenantSummary
    },
  })
}

// ── Usuarios de un negocio ───────────────────────────────────────────────────

export function useAdminMembers(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'members', tenantId],
    enabled: Boolean(tenantId),
    queryFn: async (): Promise<AdminMember[]> => {
      const { data, error } = await supabase.rpc('admin_list_members', { p_tenant: tenantId })
      if (error) throw error
      return (data ?? []) as AdminMember[]
    },
  })
}

/**
 * Cambia el rol de un miembro. Va el negocio ADEMÁS del usuario: la RPC
 * comprueba que esa persona pertenezca a ese negocio antes de tocar nada, para
 * que un id equivocado en la URL no degrade a la dueña de otra cuenta.
 */
export function useAdminSetMemberRole() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (args: { tenant: string; user: string; role: MemberRole }) => {
      const { error } = await supabase.rpc('admin_set_member_role', {
        p_tenant: args.tenant,
        p_user: args.user,
        p_role: args.role,
      })
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  })
}

/** Saca a una persona del negocio (no borra su cuenta de acceso). */
export function useAdminRemoveMember() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (args: { tenant: string; user: string }) => {
      const { error } = await supabase.rpc('admin_remove_member', {
        p_tenant: args.tenant,
        p_user: args.user,
      })
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  })
}

/** Bloquea / desbloquea el acceso de una cuenta (`auth.users.banned_until`). */
export function useAdminSetUserBanned() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (args: { user: string; banned: boolean }) => {
      const { error } = await supabase.rpc('admin_set_user_banned', {
        p_user: args.user,
        p_banned: args.banned,
      })
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  })
}

// ── Solicitudes de cambio de plan ────────────────────────────────────────────

/** Solicitudes de todas las cuentas. Sin filtro llegan todas, con las pendientes primero. */
export function useAdminPlanRequests(status?: PlanRequestStatus | null) {
  return useQuery({
    // El filtro entra en la clave: sin él, cambiar de pestaña enseñaría la lista
    // de la anterior hasta que respondiera la red.
    queryKey: ['admin', 'plan-requests', status ?? 'todas'],
    queryFn: async (): Promise<AdminPlanRequestRow[]> => {
      const { data, error } = await supabase.rpc('admin_list_plan_requests', {
        p_status: status ?? null,
      })
      if (error) throw error
      return (data ?? []) as AdminPlanRequestRow[]
    },
  })
}

/** Aprueba (y aplica el plan pedido) o rechaza una solicitud. */
export function useAdminResolvePlanRequest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (args: { id: string; approve: boolean; note?: string }) => {
      const { error } = await supabase.rpc('admin_resolve_plan_request', {
        p_id: args.id,
        p_approve: args.approve,
        p_note: args.note ?? null,
      })
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  })
}

// ── Super-admins de plataforma ───────────────────────────────────────────────

export function useAdminPlatformAdmins() {
  return useQuery({
    queryKey: ['admin', 'platform-admins'],
    queryFn: async (): Promise<PlatformAdminRow[]> => {
      const { data, error } = await supabase.rpc('admin_list_platform_admins')
      if (error) throw error
      return (data ?? []) as PlatformAdminRow[]
    },
  })
}

/**
 * Da acceso de plataforma a una cuenta EXISTENTE, por correo. Devuelve su uid.
 *
 * La RPC exige que esa cuenta no pertenezca a ningún negocio: un super-admin con
 * negocio propio sería juez y parte, y además las políticas cross-tenant piden
 * `auth_tenant_id() is null` — no vería nada de todos modos.
 */
export function useAdminGrantPlatformAdmin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (args: { email: string; note?: string }): Promise<string> => {
      const { data, error } = await supabase.rpc('admin_grant_platform_admin', {
        p_email: args.email.trim(),
        p_note: args.note ?? null,
      })
      if (error) throw error
      return data as string
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'platform-admins'] }),
  })
}

/** Quita el acceso de plataforma. La RPC no deja quedarse sin ningún super-admin. */
export function useAdminRevokePlatformAdmin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (user: string) => {
      const { error } = await supabase.rpc('admin_revoke_platform_admin', { p_user: user })
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'platform-admins'] }),
  })
}

// ── Eliminar un negocio (borrado en cascada) ─────────────────────────────────

/**
 * Qué se va a borrar. Se pide al ABRIR el modal, no antes: son una docena de
 * conteos y no hay por qué pagarlos en cada fila de la tabla.
 */
export function useAdminTenantPurgePreview(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'purge-preview', tenantId],
    enabled: Boolean(tenantId),
    // Un conteo viejo aquí es peligroso: es lo que se lee para decidir un
    // borrado irreversible. Siempre fresco y sin dejar rastro al cerrar.
    staleTime: 0,
    gcTime: 0,
    queryFn: async (): Promise<AdminTenantPurgePreview> => {
      const { data, error } = await supabase.rpc('admin_tenant_purge_preview', {
        p_tenant: tenantId,
      })
      if (error) throw error
      return data as AdminTenantPurgePreview
    },
  })
}

/**
 * Borra un negocio con todo lo suyo. IRREVERSIBLE.
 *
 * Dos pasos, en este orden a propósito:
 *   1) La RPC borra la base en UNA transacción (o entra todo, o nada) y devuelve
 *      las rutas de los archivos del negocio.
 *   2) La app vacía esos archivos con la API de Storage — borrarlos por SQL
 *      dejaría el blob huérfano en el bucket.
 * Si falla el paso 2, los archivos siguen listados y la bitácora dice cuántos
 * eran, así que se puede repetir. Al revés (archivos primero) un fallo de la RPC
 * dejaría a un negocio VIVO sin sus imágenes.
 */
export function useAdminDeleteTenant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (args: {
      tenant: string
      /** Nombre del negocio tal cual; el servidor lo vuelve a comprobar. */
      confirmName: string
      /** `true` = borra también las cuentas de acceso de sus usuarios. */
      deleteUsers?: boolean
    }): Promise<AdminTenantPurgeResult> => {
      const { data, error } = await supabase.rpc('admin_delete_tenant', {
        p_tenant: args.tenant,
        p_confirm_name: args.confirmName,
        p_delete_users: args.deleteUsers ?? false,
      })
      if (error) throw error

      // Lo que devuelve el servidor no trae las cifras de archivos: las completa
      // el cliente, que es quien los borra de verdad.
      const result = (data ?? {}) as Omit<
        AdminTenantPurgeResult,
        'files_removed' | 'files_failed' | 'files_pending' | 'files_unknown'
      >
      const files = result.files ?? []
      const { removed, pending } = await removeTenantFiles(args.tenant, files)

      // Lo que quedó se mide sobre el bucket (`pending`). Si no se pudo listar,
      // se cae al conteo del servidor (`counts.files`, que trae -1 si él tampoco
      // pudo leer Storage): nunca se canta éxito sin haberlo comprobado.
      const seen = Number(result.counts?.files ?? 0)
      const left = pending ?? (seen < 0 ? null : Math.max(0, seen - removed))
      return {
        ...result,
        files,
        files_removed: removed,
        files_failed: left ?? 0,
        files_pending: left,
        files_unknown: left === null,
      }
    },
    // `onSettled` y no `onSuccess`: si la RPC borró pero la respuesta se perdió
    // (corte de red a mitad), el camino de error dejaría en pantalla —y en el
    // cache— una fila que ya no existe.
    onSettled: (_data, _err, args) => {
      // Las consultas de ESE negocio ya no tienen sujeto: se QUITAN del cache.
      // `invalidateQueries` solo las marca viejas y las conserva, y el persister
      // las vuelca a localStorage con gcTime de 14 días: quedaría en el disco una
      // copia legible (nombre, contactos, cifras) de un negocio que la app
      // dice haber borrado del todo.
      qc.removeQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) &&
          q.queryKey.includes(args.tenant) &&
          // La vista previa NO: el modal sigue montado en este punto y quitarla
          // la haría renacer y volver a pedirla para un negocio que ya no existe
          // (tiene gcTime 0, así que se descarta sola al cerrarse).
          q.queryKey[1] !== 'purge-preview',
      })
      // La lista de negocios no lleva el id en la clave, así que se le quita la
      // fila a mano: si el refetch de abajo falla (acabar sin red es un final muy
      // posible de este propio borrado) quedaría guardada esa misma copia.
      qc.setQueriesData<AdminTenantRow[]>({ queryKey: ['admin', 'tenants'] }, (old) =>
        Array.isArray(old) ? old.filter((t) => t.id !== args.tenant) : old,
      )
      qc.invalidateQueries({ queryKey: ['admin'] })
      // Mismo motivo, un piso más abajo: el service worker guarda las respuestas
      // REST (NetworkFirst `supabase-read`, ver vite.config.ts).
      if (typeof caches !== 'undefined') void caches.delete('supabase-read')
    },
  })
}

/** Negocios ya eliminados: queda el rastro, no los datos. */
export function useAdminTenantPurges(limit = 20) {
  return useQuery({
    queryKey: ['admin', 'purges', limit],
    queryFn: async (): Promise<AdminTenantPurgeRow[]> => {
      const { data, error } = await supabase.rpc('admin_list_tenant_purges', { p_limit: limit })
      if (error) throw error
      return (data ?? []) as AdminTenantPurgeRow[]
    },
  })
}
