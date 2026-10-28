import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/auth/AuthProvider'
import type { MemberRole } from '@/types/db'
import type { TeamMemberRow } from '@/types/erp'

/**
 * Miembros de la empresa activa (list_team_members, migración 0013). Cualquier
 * miembro ve los nombres (hacen falta para "vendedor" o "cajero"); el correo
 * solo llega a quien tiene team.manage.
 */
export function useTeamMembers() {
  return useQuery({
    queryKey: ['team', 'members'],
    queryFn: async (): Promise<TeamMemberRow[]> => {
      const { data, error } = await supabase.rpc('list_team_members')
      if (error) throw error
      return (data ?? []) as TeamMemberRow[]
    },
  })
}

/** Mapa user_id → nombre, para pintar vendedores y cajeros en listados. */
export function useMemberNames(): Record<string, string> {
  const { data } = useTeamMembers()
  return Object.fromEntries((data ?? []).map((m) => [m.user_id, m.full_name ?? m.email ?? 'Sin nombre']))
}

export interface Invite {
  id: string
  code: string
  email: string | null
  role: MemberRole
  expires_at: string
  accepted_at: string | null
  created_at: string
}

/** Invitaciones vivas. La RLS solo deja leerlas al dueño (son credenciales al portador). */
export function usePendingInvites() {
  const { isOwner } = useAuth()
  return useQuery({
    queryKey: ['team', 'invites'],
    enabled: isOwner,
    queryFn: async (): Promise<Invite[]> => {
      const { data, error } = await supabase
        .from('tenant_invites')
        .select('id, code, email, role, expires_at, accepted_at, created_at')
        .is('accepted_at', null)
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as Invite[]
    },
  })
}

export function useCreateInvite() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { role: MemberRole; email?: string | null }): Promise<string> => {
      const { data, error } = await supabase.rpc('create_invite', {
        p_role: input.role,
        p_email: input.email ?? null,
      })
      if (error) throw error
      return data as string
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team', 'invites'] }),
  })
}

export function useRevokeInvite() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('tenant_invites').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team', 'invites'] }),
  })
}

/** Canjea un código: suma la membresía y deja esa empresa como activa. */
export function useAcceptInvite() {
  const qc = useQueryClient()
  const { refresh } = useAuth()
  return useMutation({
    mutationFn: async (code: string): Promise<string> => {
      const { data, error } = await supabase.rpc('accept_invite', { p_code: code.trim() })
      if (error) throw error
      return data as string
    },
    onSuccess: async () => {
      qc.clear()
      await refresh()
    },
  })
}

export function useSetMemberRole() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { userId: string; role: MemberRole; branchIds: string[] | null }) => {
      const { error } = await supabase.rpc('set_member_role', {
        p_user: input.userId,
        p_role: input.role,
        p_branch_ids: input.branchIds,
      })
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team'] }),
  })
}

export function useSetMemberActive() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { userId: string; active: boolean }) => {
      const { error } = await supabase.rpc('set_member_active', { p_user: input.userId, p_active: input.active })
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

/** Permisos por rol de la empresa activa: { role: [permisos] }. */
export function useRolePermissions() {
  return useQuery({
    queryKey: ['team', 'role-permissions'],
    queryFn: async (): Promise<Partial<Record<MemberRole, string[]>>> => {
      const { data, error } = await supabase.from('role_permissions').select('role, permission')
      if (error) throw error
      const out: Partial<Record<MemberRole, string[]>> = {}
      for (const r of (data ?? []) as { role: MemberRole; permission: string }[]) {
        ;(out[r.role] ??= []).push(r.permission)
      }
      return out
    },
  })
}

export function useSetRolePermissions() {
  const qc = useQueryClient()
  const { refresh } = useAuth()
  return useMutation({
    mutationFn: async (input: { role: MemberRole; permissions: string[] }) => {
      const { error } = await supabase.rpc('set_role_permissions', {
        p_role: input.role,
        p_permissions: input.permissions,
      })
      if (error) throw error
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['team', 'role-permissions'] })
      await refresh()
    },
  })
}
