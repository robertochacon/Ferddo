import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  BarChart3,
  Banknote,
  Boxes,
  Building2,
  ChefHat,
  UtensilsCrossed,
  Wrench,
  Check,
  ChevronDown,
  FileSpreadsheet,
  FileText,
  HandCoins,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  Plus,
  Receipt,
  Settings,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Truck,
  UserRound,
  Users,
  Wallet,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useAuth } from '@/auth/AuthProvider'
import { Wordmark, Logo } from '@/components/Logo'
import { OfflineBar } from '@/components/OfflineBar'
import { Avatar } from '@/components/ui/misc'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { useToast } from '@/components/ui/toast'
import { useBusinessTypes, useCreateAdditionalBusiness, useMyTenants } from '@/hooks/core'
import { errorMessage } from '@/lib/errors'
import { ROLE_LABEL } from '@/lib/labels'
import type { ModuleCode, SubscriptionStatus } from '@/types/db'

/**
 * Cascarón de la app protegida: navegación, cabecera y <Outlet/>.
 *
 * UNA sola lista de destinos (NAV) alimenta la barra lateral y el cajón del
 * móvil, y cada destino declara el módulo y el permiso que exige: así una
 * pantalla nueva no puede aparecer en un sitio y faltar en otro, ni enseñarse a
 * quien no puede usarla. Ocultar NO es la seguridad (la base decide en cada
 * RPC y política); es para no ofrecer botones que fallarían.
 */
interface NavItemDef {
  to: string
  label: string
  icon: LucideIcon
  /** Solo para '/': sin `end` la raíz quedaría activa en todas las rutas. */
  end?: boolean
  /** Basta con UNO de estos módulos activos. */
  modules?: ModuleCode[]
  perm?: string
}

interface NavGroup {
  label: string | null
  items: NavItemDef[]
}

const NAV: NavGroup[] = [
  {
    label: null,
    items: [
      { to: '/', label: 'Inicio', icon: LayoutDashboard, end: true },
      { to: '/pos', label: 'Vender', icon: ShoppingCart, modules: ['pos'], perm: 'sales.create' },
    ],
  },
  {
    label: 'Restaurante y taller',
    items: [
      { to: '/mesas', label: 'Mesas y cuentas', icon: UtensilsCrossed, modules: ['restaurant'], perm: 'restaurant.orders' },
      { to: '/cocina', label: 'Cocina', icon: ChefHat, modules: ['restaurant'], perm: 'restaurant.kitchen' },
      { to: '/taller', label: 'Órdenes de trabajo', icon: Wrench, modules: ['workshop'], perm: 'workshop.manage' },
    ],
  },
  {
    label: 'Ventas',
    items: [
      { to: '/ventas', label: 'Ventas', icon: Receipt, modules: ['pos'] },
      { to: '/caja', label: 'Caja', icon: Banknote, modules: ['pos'] },
      { to: '/cotizaciones', label: 'Cotizaciones', icon: FileText, modules: ['quotations'] },
      { to: '/clientes', label: 'Clientes', icon: Users },
      { to: '/cuentas-por-cobrar', label: 'Cuentas por cobrar', icon: HandCoins, modules: ['credit'], perm: 'receivables.manage' },
    ],
  },
  {
    label: 'Catálogo',
    items: [
      { to: '/productos', label: 'Productos y servicios', icon: Package },
      { to: '/inventario', label: 'Inventario', icon: Boxes, modules: ['inventory'], perm: 'inventory.view' },
    ],
  },
  {
    label: 'Compras y gastos',
    items: [
      { to: '/compras', label: 'Compras', icon: ShoppingBag, modules: ['purchases'], perm: 'purchases.manage' },
      { to: '/proveedores', label: 'Proveedores', icon: Truck, modules: ['purchases', 'expenses', 'payables'] },
      { to: '/cuentas-por-pagar', label: 'Cuentas por pagar', icon: Wallet, modules: ['payables'], perm: 'payables.manage' },
      { to: '/gastos', label: 'Gastos', icon: Banknote, modules: ['expenses'], perm: 'expenses.manage' },
    ],
  },
  {
    label: 'Fiscal y reportes',
    items: [
      { to: '/facturacion', label: 'Facturación e-CF', icon: FileSpreadsheet, modules: ['invoicing'], perm: 'ecf.view' },
      { to: '/reportes', label: 'Reportes', icon: BarChart3, modules: ['reports'], perm: 'reports.view' },
    ],
  },
  {
    label: 'Cuenta',
    items: [
      { to: '/configuracion', label: 'Configuración', icon: Settings },
      { to: '/perfil', label: 'Mi perfil', icon: UserRound },
    ],
  },
]

/** Accesos fijos de la barra inferior del teléfono; el resto vive en "Más". */
const BOTTOM: NavItemDef[] = [
  { to: '/', label: 'Inicio', icon: LayoutDashboard, end: true },
  { to: '/pos', label: 'Vender', icon: ShoppingCart, modules: ['pos'], perm: 'sales.create' },
  { to: '/ventas', label: 'Ventas', icon: Receipt, modules: ['pos'] },
  { to: '/productos', label: 'Productos', icon: Package },
]

const STATUS_BADGE: Record<SubscriptionStatus, { label: string; tone: 'green' | 'amber' | 'red' | 'slate' }> = {
  trial: { label: 'Prueba', tone: 'amber' },
  active: { label: 'Activo', tone: 'green' },
  past_due: { label: 'Pago pendiente', tone: 'red' },
  canceled: { label: 'Vencido', tone: 'slate' },
}

function useVisible() {
  const { hasModule, can } = useAuth()
  return (item: NavItemDef) =>
    (!item.modules || item.modules.some((m) => hasModule(m))) && (!item.perm || can(item.perm))
}

export function Layout() {
  const { tenant, profile, plan, subscription, isPlatformAdmin, signOut } = useAuth()
  const navigate = useNavigate()
  const visible = useVisible()
  const [menuOpen, setMenuOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const handleSignOut = async () => {
    setMenuOpen(false)
    await signOut()
    navigate('/login')
  }

  const groups = NAV.map((g) => ({ ...g, items: g.items.filter(visible) })).filter((g) => g.items.length)

  return (
    <div className="min-h-[100dvh] bg-slate-100">
      {/* ── Barra lateral (desde lg) ────────────────────────────────────── */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-slate-200 bg-white lg:flex">
        <div className="flex h-16 items-center px-5">
          <Wordmark />
        </div>
        <NavGroups groups={groups} isPlatformAdmin={isPlatformAdmin} />
        <div className="border-t border-slate-100 p-3">
          <PlanPill plan={plan.name} status={subscription?.status} />
        </div>
      </aside>

      {/* ── Cajón del móvil ("Más") ─────────────────────────────────────── */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setDrawerOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-white shadow-xl animate-fade-in">
            <div className="flex h-16 items-center justify-between px-4">
              <Wordmark />
              <button
                onClick={() => setDrawerOpen(false)}
                aria-label="Cerrar menú"
                className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <NavGroups
              groups={groups}
              isPlatformAdmin={isPlatformAdmin}
              onNavigate={() => setDrawerOpen(false)}
            />
            <div className="border-t border-slate-100 p-3">
              <PlanPill plan={plan.name} status={subscription?.status} />
            </div>
          </div>
        </div>
      )}

      {/* ── Contenido ───────────────────────────────────────────────────── */}
      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-slate-200 bg-white/90 px-3 backdrop-blur sm:px-4">
          <Logo className="h-8 w-8 lg:hidden" decorative />
          <div className="min-w-0 flex-1">
            <TenantSwitcher />
          </div>

          <div className="relative">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Menú de la cuenta"
              className="flex items-center gap-2 rounded-full p-1 hover:bg-slate-100"
            >
              <Avatar name={profile?.full_name ?? tenant?.name} src={profile?.avatar_url} size="sm" />
            </button>
            {menuOpen && (
              <>
                {/* Capa invisible: un toque en cualquier sitio cierra el menú
                    (no hay `blur` en un toque fuera). */}
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 z-20 mt-2 w-56 rounded-xl border border-slate-200 bg-white p-2 shadow-card-hover animate-fade-in">
                  <div className="px-2 py-1.5">
                    <p className="truncate text-sm font-medium text-slate-800">
                      {profile?.full_name ?? 'Mi cuenta'}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      {profile?.role ? ROLE_LABEL[profile.role] : ''} · {tenant?.name}
                    </p>
                  </div>
                  <div className="my-1 border-t border-slate-100" />
                  <MenuItem
                    icon={UserRound}
                    label="Mi perfil"
                    onClick={() => {
                      setMenuOpen(false)
                      navigate('/perfil')
                    }}
                  />
                  <MenuItem
                    icon={Settings}
                    label="Configuración"
                    onClick={() => {
                      setMenuOpen(false)
                      navigate('/configuracion')
                    }}
                  />
                  <MenuItem icon={LogOut} label="Cerrar sesión" onClick={handleSignOut} danger />
                </div>
              </>
            )}
          </div>
        </header>

        <OfflineBar />

        {/* `pb-24` en móvil: la barra inferior es fija y taparía la última fila. */}
        <main className="mx-auto w-full max-w-7xl px-3 py-5 pb-24 sm:px-4 lg:pb-8">
          <Outlet />
        </main>
      </div>

      {/* ── Barra inferior (solo móvil) ─────────────────────────────────── */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        {BOTTOM.filter(visible).map((item) => (
          <BottomItem key={item.to} {...item} />
        ))}
        <button
          onClick={() => setDrawerOpen(true)}
          className="flex flex-1 flex-col items-center gap-0.5 py-2 text-slate-500"
        >
          <Menu className="h-5 w-5" />
          <span className="max-w-full truncate px-1 text-[10px] font-medium">Más</span>
        </button>
      </nav>
    </div>
  )
}

/* ── Piezas ─────────────────────────────────────────────────────────────── */

function NavGroups({
  groups,
  isPlatformAdmin,
  onNavigate,
}: {
  groups: NavGroup[]
  isPlatformAdmin: boolean
  onNavigate?: () => void
}) {
  return (
    <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-2">
      {groups.map((g, i) => (
        <div key={g.label ?? i} className="space-y-1">
          {g.label && (
            <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              {g.label}
            </p>
          )}
          {g.items.map((item) => (
            <SideItem key={item.to} {...item} onClick={onNavigate} />
          ))}
        </div>
      ))}
      {/* El panel de plataforma no es parte de la app del negocio. */}
      {isPlatformAdmin && <SideItem to="/admin" label="Plataforma" icon={ShieldCheck} onClick={onNavigate} />}
    </nav>
  )
}

/**
 * Empresa activa + cambio entre las empresas a las que pertenece la persona.
 * El cambio lo valida switch_tenant() en la base: solo se puede activar una
 * empresa donde exista membresía activa.
 */
function TenantSwitcher() {
  const { tenant, switchTenant } = useAuth()
  const { data: tenants } = useMyTenants()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)

  const choose = async (id: string) => {
    setOpen(false)
    if (id === tenant?.id) return
    setBusy(true)
    try {
      await switchTenant(id)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        className="flex max-w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left hover:bg-slate-100"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Building2 className="h-4 w-4 shrink-0 text-slate-400" />
        <span className="truncate text-sm font-semibold text-slate-800">{tenant?.name ?? 'Mi negocio'}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-20 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white p-2 shadow-card-hover animate-fade-in">
            <p className="px-2 py-1 text-xs font-medium text-slate-500">Mis empresas</p>
            {(tenants ?? []).map((t) => (
              <button
                key={t.id}
                onClick={() => choose(t.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-slate-100"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-slate-800">{t.name}</span>
                  <span className="block truncate text-xs text-slate-500">{ROLE_LABEL[t.role]}</span>
                </span>
                {t.id === tenant?.id && <Check className="h-4 w-4 text-brand-600" />}
              </button>
            ))}
            <div className="my-1 border-t border-slate-100" />
            <button
              onClick={() => {
                setOpen(false)
                setCreating(true)
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50"
            >
              <Plus className="h-4 w-4" /> Nueva empresa
            </button>
          </div>
        </>
      )}
      <NewBusinessModal open={creating} onClose={() => setCreating(false)} />
    </div>
  )
}

function NewBusinessModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: types } = useBusinessTypes()
  const create = useCreateAdditionalBusiness()
  const toast = useToast()
  const [name, setName] = useState('')
  const [type, setType] = useState('other')

  const submit = async () => {
    try {
      await create.mutateAsync({ name: name.trim(), business_type: type })
      toast.success('Empresa creada')
      setName('')
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nueva empresa"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={create.isPending} disabled={name.trim().length < 2}>
            Crear empresa
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-500">
          Cada empresa tiene sus propios datos, empleados, plan y facturación. Tú quedas como propietario.
        </p>
        <Field label="Nombre comercial" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Colmado La Esquina" />
        </Field>
        <Field label="Tipo de negocio">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            {(types ?? []).map((t) => (
              <option key={t.code} value={t.code}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  )
}

function SideItem({ to, label, icon: Icon, end, onClick }: NavItemDef & { onClick?: () => void }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
          isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
        )
      }
    >
      <Icon className="h-5 w-5 shrink-0" />
      {label}
    </NavLink>
  )
}

function BottomItem({ to, label, icon: Icon, end }: NavItemDef) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn('flex flex-1 flex-col items-center gap-0.5 py-2', isActive ? 'text-brand-600' : 'text-slate-500')
      }
    >
      <Icon className="h-5 w-5" />
      <span className="max-w-full truncate px-1 text-[10px] font-medium">{label}</span>
    </NavLink>
  )
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  danger = false,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors',
        danger ? 'text-red-600 hover:bg-red-50' : 'text-slate-600 hover:bg-slate-100',
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  )
}

/** Plan vigente al pie de la barra lateral. */
function PlanPill({ plan, status }: { plan: string; status?: SubscriptionStatus }) {
  const badge = status ? STATUS_BADGE[status] : null
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2">
      <div className="min-w-0">
        <p className="text-xs text-slate-500">Plan</p>
        <p className="truncate text-sm font-semibold text-slate-800">{plan}</p>
      </div>
      {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
    </div>
  )
}
