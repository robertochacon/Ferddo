import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { lazy, Suspense, type ComponentType, type ReactNode } from 'react'
import { AppRouter } from '@/lib/router'
import { useAuth } from '@/auth/AuthProvider'
import { Layout } from '@/components/Layout'
import { Logo } from '@/components/Logo'
import { Spinner } from '@/components/ui/misc'
import { LEGAL_PATHS } from '@/lib/constants'

// Las pantallas de autenticación van en el bundle principal (sin lazy): son lo
// PRIMERO que ve quien no tiene sesión, y diferirlas añade un viaje de red justo
// en el momento en que la app todavía no ha demostrado nada.
import { LoginPage } from '@/pages/auth/LoginPage'
import { RegisterPage } from '@/pages/auth/RegisterPage'
import { ForgotPasswordPage } from '@/pages/auth/ForgotPasswordPage'
import { ResetPasswordPage } from '@/pages/auth/ResetPasswordPage'
import { OnboardingPage } from '@/pages/auth/OnboardingPage'

/** Guard anti-bucle de recarga. DEBE ser la MISMA clave que usa main.tsx. */
const CHUNK_RELOAD_KEY = 'ferddo-chunk-reloaded'

/**
 * `lazy()` que se recupera de un chunk que no carga.
 *
 * El caso real: tras un deploy, el service worker sirve un index.html viejo que
 * apunta a hashes que ya no existen en el servidor, así que el `import()` falla
 * y la pantalla se queda en blanco para siempre. Aquí se recarga UNA vez para
 * traer el HTML y los chunks frescos. El guard en sessionStorage evita el bucle
 * de recargas; si tras recargar sigue fallando, el error se propaga al
 * <ErrorBoundary> y al menos se ve "Algo salió mal" en vez de nada. Al cargar
 * bien, el guard se limpia para que la próxima vez vuelva a haber un intento.
 */
function lazyWithRetry<T extends ComponentType<unknown>>(factory: () => Promise<{ default: T }>) {
  return lazy(() =>
    factory()
      .then((m) => {
        sessionStorage.removeItem(CHUNK_RELOAD_KEY)
        return m
      })
      .catch((err) => {
        if (!sessionStorage.getItem(CHUNK_RELOAD_KEY)) {
          sessionStorage.setItem(CHUNK_RELOAD_KEY, '1')
          window.location.reload()
          // Se queda colgada a propósito (ni resuelve ni rechaza) hasta que la
          // recarga tome efecto: resolver aquí pintaría un error de un instante.
          return new Promise<{ default: T }>(() => {})
        }
        throw err
      }),
  )
}

// El resto de pantallas sí van en carga diferida: quien entra sin sesión no paga
// el peso del panel de super-admin ni el de la app completa.
const DashboardPage = lazyWithRetry(() =>
  import('@/features/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
)
const PosPage = lazyWithRetry(() =>
  import('@/features/pos/PosPage').then((m) => ({ default: m.PosPage })),
)
const SalesPage = lazyWithRetry(() =>
  import('@/features/sales/SalesPage').then((m) => ({ default: m.SalesPage })),
)
const SaleDetailPage = lazyWithRetry(() =>
  import('@/features/sales/SaleDetailPage').then((m) => ({ default: m.SaleDetailPage })),
)
const CashPage = lazyWithRetry(() =>
  import('@/features/cash/CashPage').then((m) => ({ default: m.CashPage })),
)
const ProductsPage = lazyWithRetry(() =>
  import('@/features/products/ProductsPage').then((m) => ({ default: m.ProductsPage })),
)
const InventoryPage = lazyWithRetry(() =>
  import('@/features/inventory/InventoryPage').then((m) => ({ default: m.InventoryPage })),
)
const CustomersPage = lazyWithRetry(() =>
  import('@/features/customers/CustomersPage').then((m) => ({ default: m.CustomersPage })),
)
const CustomerDetailPage = lazyWithRetry(() =>
  import('@/features/customers/CustomerDetailPage').then((m) => ({ default: m.CustomerDetailPage })),
)
const ReceivablesPage = lazyWithRetry(() =>
  import('@/features/receivables/ReceivablesPage').then((m) => ({ default: m.ReceivablesPage })),
)
const SuppliersPage = lazyWithRetry(() =>
  import('@/features/suppliers/SuppliersPage').then((m) => ({ default: m.SuppliersPage })),
)
const PurchasesPage = lazyWithRetry(() =>
  import('@/features/purchases/PurchasesPage').then((m) => ({ default: m.PurchasesPage })),
)
const PurchaseFormPage = lazyWithRetry(() =>
  import('@/features/purchases/PurchaseFormPage').then((m) => ({ default: m.PurchaseFormPage })),
)
const PayablesPage = lazyWithRetry(() =>
  import('@/features/payables/PayablesPage').then((m) => ({ default: m.PayablesPage })),
)
const ExpensesPage = lazyWithRetry(() =>
  import('@/features/expenses/ExpensesPage').then((m) => ({ default: m.ExpensesPage })),
)
const QuotationsPage = lazyWithRetry(() =>
  import('@/features/quotations/QuotationsPage').then((m) => ({ default: m.QuotationsPage })),
)
const QuotationFormPage = lazyWithRetry(() =>
  import('@/features/quotations/QuotationFormPage').then((m) => ({ default: m.QuotationFormPage })),
)
const InvoicingPage = lazyWithRetry(() =>
  import('@/features/invoicing/InvoicingPage').then((m) => ({ default: m.InvoicingPage })),
)
const ReportsPage = lazyWithRetry(() =>
  import('@/features/reports/ReportsPage').then((m) => ({ default: m.ReportsPage })),
)
const SettingsPage = lazyWithRetry(() =>
  import('@/features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })),
)
const ProfilePage = lazyWithRetry(() =>
  import('@/features/profile/ProfilePage').then((m) => ({ default: m.ProfilePage })),
)
const AdminPage = lazyWithRetry(() =>
  import('@/features/admin/AdminPage').then((m) => ({ default: m.AdminPage })),
)
const AdminTenantDetail = lazyWithRetry(() =>
  import('@/features/admin/AdminTenantDetail').then((m) => ({ default: m.AdminTenantDetail })),
)
const LandingPage = lazyWithRetry(() =>
  import('@/features/landing/LandingPage').then((m) => ({ default: m.LandingPage })),
)
const PrivacyPage = lazyWithRetry(() =>
  import('@/features/legal/PrivacyPage').then((m) => ({ default: m.PrivacyPage })),
)
const TermsPage = lazyWithRetry(() =>
  import('@/features/legal/TermsPage').then((m) => ({ default: m.TermsPage })),
)

/** Arranque de la app: es lo primero que se ve al entrar y al recargar. */
function FullLoader() {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-6 bg-slate-50">
      <Logo className="h-24 w-24 animate-pulse" />
      <div className="flex flex-col items-center gap-3">
        <Spinner size="xl" />
        <p className="text-sm font-medium text-slate-500">Cargando…</p>
      </div>
    </div>
  )
}

/** Solo para quien NO tiene sesión (login, registro, recuperar). */
function PublicOnly({ children }: { children: ReactNode }) {
  const { loading, user, contextReady, needsOnboarding, isPlatformAdmin } = useAuth()
  // Justo tras iniciar sesión hay un instante con sesión pero sin perfil cargado.
  // Esperar aquí evita el rebote «crear negocio → panel»: el destino se decide
  // una sola vez, ya sabiendo si la cuenta tiene negocio.
  if (loading || (user && !contextReady)) return <FullLoader />
  if (user) {
    const to = isPlatformAdmin ? '/admin' : needsOnboarding ? '/bienvenida' : '/'
    return <Navigate to={to} replace />
  }
  return <>{children}</>
}

/** Pantalla de bloqueo para los negocios suspendidos por la plataforma. */
function SuspendedScreen() {
  const { tenant, signOut } = useAuth()
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-slate-50 px-6 text-center">
      <Logo className="h-14 w-14 opacity-70" />
      <h1 className="text-lg font-bold text-slate-900">Cuenta suspendida</h1>
      <p className="max-w-sm text-sm text-slate-500">
        El acceso a <span className="font-medium">{tenant?.name}</span> está temporalmente
        suspendido. Contacta al administrador de la plataforma para reactivarlo.
      </p>
      <button
        onClick={() => signOut()}
        className="text-sm font-medium text-brand-600 hover:underline"
      >
        Cerrar sesión
      </button>
    </div>
  )
}

/** Requiere sesión + negocio configurado. Es el marco de toda la app interna. */
function ProtectedLayout() {
  const { loading, user, contextReady, needsOnboarding, isPlatformAdmin, tenant } = useAuth()
  const location = useLocation()
  if (loading) return <FullLoader />
  // Visitante sin sesión: en la raíz ve la landing pública; en cualquier otra
  // ruta protegida se le manda a iniciar sesión.
  if (!user) {
    if (location.pathname === '/') return <LandingPage />
    return <Navigate to="/login" replace />
  }
  // Con sesión pero sin el perfil cargado: esperar en vez de adivinar. Adivinar
  // aquí manda al onboarding a alguien que sí tiene negocio.
  if (!contextReady) return <FullLoader />
  // Super-admin sin negocio propio: su lugar es el panel de plataforma.
  if (isPlatformAdmin && !tenant) return <Navigate to="/admin" replace />
  if (needsOnboarding) return <Navigate to="/bienvenida" replace />
  if (tenant?.suspended_at) return <SuspendedScreen />
  return <Layout />
}

/** Requiere sesión + ser super-admin de plataforma. */
function RequirePlatformAdmin({ children }: { children: ReactNode }) {
  const { loading, user, contextReady, isPlatformAdmin } = useAuth()
  if (loading) return <FullLoader />
  if (!user) return <Navigate to="/login" replace />
  // Sin el contexto cargado `isPlatformAdmin` todavía es false, y sin esta espera
  // el super-admin quedaría expulsado de su propio panel cada vez que recargue.
  if (!contextReady) return <FullLoader />
  if (!isPlatformAdmin) return <Navigate to="/" replace />
  return <>{children}</>
}

/** Paso de alta del negocio: sesión sin tenant. */
function OnboardingGuard() {
  const { loading, user, contextReady, needsOnboarding } = useAuth()
  if (loading) return <FullLoader />
  if (!user) return <Navigate to="/login" replace />
  if (!contextReady) return <FullLoader />
  if (!needsOnboarding) return <Navigate to="/" replace />
  return <OnboardingPage />
}

export default function App() {
  return (
    <AppRouter>
      <Suspense fallback={<FullLoader />}>
        <Routes>
          {/* Páginas legales: SIN guard a propósito. Tienen que abrirse con y sin
              sesión, y desde fuera de la app (un buscador, el formulario de un
              tercero, un enlace por mensaje). Ver también las URL limpias en
              public/privacidad/ y src/lib/cleanPaths.ts. */}
          <Route path={LEGAL_PATHS.privacy} element={<PrivacyPage />} />
          <Route path={LEGAL_PATHS.terms} element={<TermsPage />} />

          <Route
            path="/login"
            element={
              <PublicOnly>
                <LoginPage />
              </PublicOnly>
            }
          />
          <Route
            path="/registro"
            element={
              <PublicOnly>
                <RegisterPage />
              </PublicOnly>
            }
          />
          <Route
            path="/recuperar"
            element={
              <PublicOnly>
                <ForgotPasswordPage />
              </PublicOnly>
            }
          />
          {/* Sin guard: el enlace del correo abre una sesión de recuperación, así
              que aquí se llega "autenticado" y PublicOnly lo rebotaría. */}
          <Route path="/restablecer" element={<ResetPasswordPage />} />
          <Route path="/bienvenida" element={<OnboardingGuard />} />

          {/* Panel de plataforma (super-admin, cross-tenant) */}
          <Route
            path="/admin"
            element={
              <RequirePlatformAdmin>
                <AdminPage />
              </RequirePlatformAdmin>
            }
          />
          <Route
            path="/admin/negocio/:id"
            element={
              <RequirePlatformAdmin>
                <AdminTenantDetail />
              </RequirePlatformAdmin>
            }
          />

          {/* App protegida */}
          <Route element={<ProtectedLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="pos" element={<PosPage />} />
            <Route path="ventas" element={<SalesPage />} />
            <Route path="ventas/:id" element={<SaleDetailPage />} />
            <Route path="caja" element={<CashPage />} />
            <Route path="productos" element={<ProductsPage />} />
            <Route path="inventario" element={<InventoryPage />} />
            <Route path="clientes" element={<CustomersPage />} />
            <Route path="clientes/:id" element={<CustomerDetailPage />} />
            <Route path="cuentas-por-cobrar" element={<ReceivablesPage />} />
            <Route path="proveedores" element={<SuppliersPage />} />
            <Route path="compras" element={<PurchasesPage />} />
            <Route path="compras/nueva" element={<PurchaseFormPage />} />
            <Route path="compras/:id" element={<PurchaseFormPage />} />
            <Route path="cuentas-por-pagar" element={<PayablesPage />} />
            <Route path="gastos" element={<ExpensesPage />} />
            <Route path="cotizaciones" element={<QuotationsPage />} />
            <Route path="cotizaciones/nueva" element={<QuotationFormPage />} />
            <Route path="cotizaciones/:id" element={<QuotationFormPage />} />
            <Route path="facturacion" element={<InvoicingPage />} />
            <Route path="reportes" element={<ReportsPage />} />
            <Route path="configuracion" element={<SettingsPage />} />
            <Route path="perfil" element={<ProfilePage />} />
          </Route>

          {/* Catch-all a la raíz: desde ahí ProtectedLayout decide si toca la
              landing (sin sesión) o el panel (con sesión). */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AppRouter>
  )
}
