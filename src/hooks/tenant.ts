import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/auth/AuthProvider'
import type { Tenant } from '@/types/db'

/**
 * Campos de la empresa que se editan desde Configuración.
 *
 * Fuera a propósito:
 * - `suspended_at`: decisión comercial del super-admin; `tenants_guard` (0008)
 *   rechaza el cambio si viene de cualquier otro.
 * - `settings`: jsonb compartido con otros módulos (POS, e-CF). Un PATCH aquí lo
 *   reemplazaría ENTERO y borraría las claves que esta pantalla no conoce.
 *
 * La RLS de `tenants` (0013) exige `settings.manage` para el UPDATE: sin ese
 * permiso PostgREST devuelve 0 filas, por eso el hook comprueba que se tocó una.
 */
export type TenantUpdate = Partial<
  Pick<
    Tenant,
    | 'name'
    | 'legal_name'
    | 'rnc'
    | 'business_type'
    | 'logo_url'
    | 'phone'
    | 'whatsapp'
    | 'email'
    | 'address'
    | 'province'
    | 'municipality'
    | 'currency'
    | 'locale'
    | 'timezone'
    | 'receipt_footer'
    | 'prices_include_tax'
    | 'allow_negative_stock'
    | 'modules'
  >
>

/**
 * Actualiza los datos de la empresa activa.
 *
 * El `id` es opcional: si no viene se usa el de la sesión. La RLS solo permite
 * tocar `id = auth_tenant_id()`, así que mandar otro no abre ninguna puerta.
 */
export function useUpdateTenant() {
  const { tenant, refresh } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, ...patch }: TenantUpdate & { id?: string }) => {
      const tenantId = id ?? tenant?.id
      if (!tenantId) throw new Error('Sin empresa activa')
      const { data, error } = await supabase.from('tenants').update(patch).eq('id', tenantId).select('id')
      if (error) throw error
      // Sin permiso, la RLS no lanza: filtra la fila y el UPDATE "funciona" sobre
      // cero filas. Sin esta comprobación el toast diría «guardado» sin guardar.
      if (!data || data.length === 0) {
        throw new Error('No tienes permiso para modificar los datos de la empresa.')
      }
    },
    // Nombre, logo, moneda y módulos los sirve el AuthProvider, no react-query:
    // sin este refresh la cabecera y el menú seguirían con los datos viejos.
    onSuccess: async () => {
      await refresh()
      qc.invalidateQueries({ queryKey: ['my-tenants'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}
