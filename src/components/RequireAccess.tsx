import type { ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { EmptyState } from '@/components/ui/misc'
import { MODULE_LABEL } from '@/lib/labels'
import type { ModuleCode } from '@/types/db'

/**
 * Envuelve una pantalla que exige un módulo y/o un permiso. Es cortesía de UI
 * (quien entra por la URL ve un aviso en vez de una pantalla rota): la
 * autorización real la hacen las políticas RLS y las RPC en la base.
 */
export function RequireAccess({
  module,
  perm,
  children,
}: {
  /** Basta con que UNO esté activo. */
  module?: ModuleCode | ModuleCode[]
  perm?: string
  children: ReactNode
}) {
  const { hasModule, can } = useAuth()
  const mods = module ? (Array.isArray(module) ? module : [module]) : []
  if (mods.length && !mods.some((m) => hasModule(m))) {
    return (
      <EmptyState
        icon={<Lock className="h-6 w-6" />}
        title="Módulo no disponible"
        description={`${MODULE_LABEL[mods[0]]} no está activo en tu empresa o tu plan. Actívalo en Configuración o actualiza tu plan.`}
      />
    )
  }
  if (perm && !can(perm)) {
    return (
      <EmptyState
        icon={<Lock className="h-6 w-6" />}
        title="Sin permiso"
        description="Tu rol no tiene acceso a esta sección. Pídele al administrador de la empresa que te lo conceda."
      />
    )
  }
  return <>{children}</>
}
