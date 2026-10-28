import { useMemo, type ComponentType } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Building2, CreditCard, KeyRound, Percent, Store, Users, type LucideIcon } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { useAuth } from '@/auth/AuthProvider'
import { LEGAL_CONTACT_EMAIL, LEGAL_PATHS } from '@/lib/constants'
import { cn } from '@/lib/cn'
import { CompanySettings } from './CompanySettings'
import { BranchesSettings } from './BranchesSettings'
import { TaxesSettings } from './TaxesSettings'
import { TeamSettings } from './TeamSettings'
import { RolesSettings } from './RolesSettings'
import { PlanSettings } from './PlanSettings'

/**
 * Configuración de la empresa, por secciones.
 *
 * Cada sección se enseña solo a quien tiene el permiso que la base exige para
 * ESCRIBIR en ella (`settings.manage`, `branches.manage`, `team.manage`,
 * `roles.manage`). Es cortesía de UI: la RLS y las RPC vuelven a comprobarlo.
 * «Plan» lo ve cualquier miembro (es informativo); solicitar un cambio exige
 * `subscription.manage`.
 *
 * La sección va en la URL (`?s=equipo`): el botón «atrás» funciona y se puede
 * mandar el enlace directo a una sección.
 */

type SectionId = 'empresa' | 'sucursales' | 'impuestos' | 'equipo' | 'roles' | 'plan'

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon; perm: string | null }[] = [
  { id: 'empresa', label: 'Empresa', icon: Building2, perm: 'settings.manage' },
  { id: 'sucursales', label: 'Sucursales y cajas', icon: Store, perm: 'branches.manage' },
  { id: 'impuestos', label: 'Impuestos', icon: Percent, perm: 'settings.manage' },
  { id: 'equipo', label: 'Equipo', icon: Users, perm: 'team.manage' },
  { id: 'roles', label: 'Roles y permisos', icon: KeyRound, perm: 'roles.manage' },
  { id: 'plan', label: 'Plan', icon: CreditCard, perm: null },
]

const VIEWS: Record<SectionId, ComponentType> = {
  empresa: CompanySettings,
  sucursales: BranchesSettings,
  impuestos: TaxesSettings,
  equipo: TeamSettings,
  roles: RolesSettings,
  plan: PlanSettings,
}

export function SettingsPage() {
  const { tenant, can } = useAuth()
  const [params, setParams] = useSearchParams()

  const visible = useMemo(() => SECTIONS.filter((s) => s.perm == null || can(s.perm)), [can])
  const requested = params.get('s') as SectionId | null
  // Una sección pedida por URL a la que no se tiene acceso cae a la primera
  // permitida, en vez de pintar una pantalla que la base va a rechazar.
  const current = visible.find((s) => s.id === requested) ?? visible[0]

  // Sin negocio no hay nada que configurar. Pasa un instante al recargar, antes
  // de que el AuthProvider termine de cargar el contexto.
  if (!tenant || !current) return null

  const View = VIEWS[current.id]

  return (
    <div>
      <PageHeader title="Configuración" description={`Ajustes de ${tenant.name}`} />

      {/* Botones que se envuelven en varias líneas, no una barra con scroll
          lateral: a 360 px seis pestañas no caben y una barra deslizable
          esconde justo las que no se ven. */}
      <nav aria-label="Secciones de configuración" className="mb-5 flex flex-wrap gap-2">
        {visible.map((s) => {
          const active = s.id === current.id
          return (
            <button
              key={s.id}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => setParams(s.id === visible[0].id ? {} : { s: s.id })}
              className={cn(
                'inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40',
                active
                  ? 'bg-brand-600 text-white shadow-sm'
                  : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
              )}
            >
              <s.icon className="h-4 w-4" />
              {s.label}
            </button>
          )
        })}
      </nav>

      <View />

      <LegalLinks />
    </div>
  )
}

/**
 * Enlaces legales dentro de la app. Configuración es el único sitio de la zona
 * con sesión donde la gente los busca: en la landing y en el registro están,
 * pero quien ya entró no vuelve a pasar por ahí.
 */
function LegalLinks() {
  return (
    <div className="mt-8 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-slate-400">
      <Link to={LEGAL_PATHS.privacy} className="hover:text-brand-500 hover:underline">
        Política de Privacidad
      </Link>
      <span aria-hidden className="h-1 w-1 rounded-full bg-slate-300" />
      <Link to={LEGAL_PATHS.terms} className="hover:text-brand-500 hover:underline">
        Condiciones del Servicio
      </Link>
      <span aria-hidden className="h-1 w-1 rounded-full bg-slate-300" />
      <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} className="hover:text-brand-500 hover:underline">
        Contacto
      </a>
    </div>
  )
}
