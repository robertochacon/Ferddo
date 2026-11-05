import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/auth/AuthProvider'

/** Datos personales editables. El rol y el negocio NO se tocan desde aquí. */
export interface ProfileUpdate {
  full_name?: string | null
  avatar_url?: string | null
}

/**
 * Actualiza el perfil de quien ha iniciado sesión.
 *
 * La RLS solo permite `id = auth.uid()`, y el trigger `profiles_guard` (0005)
 * bloquea cualquier intento de cambiar `tenant_id` o `role`: aunque se colara un
 * campo de más, la base lo rechaza.
 */
export function useUpdateProfile() {
  const qc = useQueryClient()
  const { user, refresh } = useAuth()
  return useMutation({
    mutationFn: async (update: ProfileUpdate) => {
      if (!user) throw new Error('Sin sesión')
      const { error } = await supabase.from('profiles').update(update).eq('id', user.id)
      if (error) throw error
    },
    onSuccess: async () => {
      // El nombre sale del AuthProvider (cabecera, avatar) y también de la lista
      // del equipo, que es otra consulta con su propio cache.
      await refresh()
      qc.invalidateQueries({ queryKey: ['team', 'members'] })
    },
  })
}

/**
 * Cambia la contraseña, comprobando ANTES la actual.
 *
 * Supabase permite cambiarla solo con la sesión abierta, sin pedir la anterior.
 * Eso significa que quien encuentre un teléfono desbloqueado puede dejar fuera a
 * la dueña de su propia cuenta. Por eso aquí se reautentica primero: el
 * `signInWithPassword` es la prueba de que quien pide el cambio sabe la clave.
 */
export function useChangePassword() {
  const { user } = useAuth()
  return useMutation({
    mutationFn: async ({ current, next }: { current: string; next: string }) => {
      const email = user?.email
      if (!email) throw new Error('Tu cuenta no tiene un correo asociado')

      const { error: authError } = await supabase.auth.signInWithPassword({
        email,
        password: current,
      })
      if (authError) throw new Error('La contraseña actual no es correcta')

      const { error } = await supabase.auth.updateUser({ password: next })
      if (error) throw error
    },
  })
}

/**
 * Pide el cambio de correo: Supabase manda un enlace de confirmación a la
 * dirección nueva y el cambio se aplica al abrirlo.
 *
 * OJO — `double_confirm_changes` (confirmar TAMBIÉN desde el correo viejo) está
 * puesto en supabase/config.toml, pero GoTrue lo IGNORA mientras la confirmación
 * de correo del proyecto esté apagada, que es como viene para que el registro
 * entre directo. Con eso apagado, quien tenga la sesión abierta podría mudar la
 * cuenta a un correo suyo y quedarse con ella. Por eso aquí se vuelve a pedir la
 * contraseña: es lo que de verdad protege el cambio.
 */
export function useChangeEmail() {
  const { user } = useAuth()
  return useMutation({
    mutationFn: async ({ email, password }: { email: string; password: string }) => {
      const current = user?.email
      if (!current) throw new Error('Tu cuenta no tiene un correo asociado')
      if (email.trim().toLowerCase() === current.toLowerCase()) {
        throw new Error('Ese ya es tu correo actual')
      }

      // Mismo motivo que en la contraseña: cambiar el correo es cambiar la llave
      // de recuperación de la cuenta.
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: current,
        password,
      })
      if (authError) throw new Error('La contraseña no es correcta')

      const { error } = await supabase.auth.updateUser({ email: email.trim() })
      if (error) throw error
    },
  })
}

/**
 * Nombre y teléfono guardados en la cuenta de acceso (`user_metadata`), no en
 * `profiles`. Es lo que necesita quien no tiene negocio —el super-admin no
 * suele tener fila en `profiles`— y es de donde el panel lee su nombre (0030).
 * Cada quien edita los suyos con su propia sesión: no hace falta RPC.
 *
 * El teléfono se guarda solo con dígitos (y `+` delante si lo lleva), como el
 * resto de teléfonos de la app.
 */
export function useUpdateAccountData() {
  const qc = useQueryClient()
  const { profile, refresh } = useAuth()
  return useMutation({
    mutationFn: async ({ fullName, phone }: { fullName: string; phone: string }) => {
      const name = fullName.trim()
      const tel = phone.trim().startsWith('+') ? '+' + phone.replace(/\D/g, '') : phone.replace(/\D/g, '')
      const digits = tel.replace(/\D/g, '')
      if (name.length > 80) throw new Error('El nombre no puede pasar de 80 caracteres.')
      if (digits && (digits.length < 7 || digits.length > 15)) {
        throw new Error('El teléfono debe tener entre 7 y 15 dígitos.')
      }
      // GoTrue mezcla `data` con lo que ya hay en user_metadata: solo se tocan estas dos claves.
      const { error } = await supabase.auth.updateUser({ data: { full_name: name || null, phone: tel || null } })
      if (error) throw error
      // Si tiene perfil (p. ej. entró como gestor, 0028), que no quede con el nombre viejo.
      if (profile) {
        const { error: pErr } = await supabase.from('profiles').update({ full_name: name || null }).eq('id', profile.id)
        if (pErr) throw pErr
      }
    },
    onSuccess: async () => {
      await refresh()
      void qc.invalidateQueries({ queryKey: ['admin', 'platform-admins'] })
      void qc.invalidateQueries({ queryKey: ['team', 'members'] })
    },
  })
}

/** Cierra la sesión en los DEMÁS dispositivos, conservando el actual. */
export function useSignOutOthers() {
  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.signOut({ scope: 'others' })
      if (error) throw error
    },
  })
}
