import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { queryClient } from '@/lib/queryClient'
import { clearOfflineCache, flushOfflineQueue, resumeIfAuthed } from '@/lib/offline'
import { PLANS, type PlanInfo } from '@/lib/constants'
import { fetchPlanSettings, toPlanMap } from '@/hooks/plans'
import type { MemberRole, ModuleCode, PlanCode, Profile, Subscription, Tenant } from '@/types/db'

interface AuthState {
  loading: boolean
  session: Session | null
  user: User | null
  profile: Profile | null
  tenant: Tenant | null
  subscription: Subscription | null
  /** Plan del negocio actual, ya con los valores configurados en /admin. */
  plan: PlanInfo
  /** Todos los planes, tal como los dejó el super-admin. */
  plans: Record<PlanCode, PlanInfo>
  needsOnboarding: boolean
  /**
   * `true` cuando el perfil/negocio cargado corresponde a la sesión actual.
   * Mientras sea `false` no se puede decidir a dónde mandar a la persona.
   */
  contextReady: boolean
  isPlatformAdmin: boolean
  /**
   * Dueña del negocio. Es lo que separa a quien puede invitar, cambiar de plan o
   * borrar el negocio de quien solo trabaja dentro (`admin`). La base lo vuelve
   * a comprobar en cada RPC: esto es solo para no enseñar botones que fallarían.
   */
  isOwner: boolean
  /** Rol en la empresa ACTIVA. */
  memberRole: MemberRole | null
  /** Permisos efectivos en la empresa activa (my_permissions()). */
  permissions: string[]
  /** ¿Puede hacer X? Solo para no enseñar botones que fallarían: la base decide. */
  can: (perm: string) => boolean
  /** Módulo encendido en la empresa Y permitido por su plan. */
  hasModule: (mod: ModuleCode) => boolean
  /** Cambia la empresa activa (switch_tenant) y recarga todo el contexto. */
  switchTenant: (tenantId: string) => Promise<void>
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [tenant, setTenant] = useState<Tenant | null>(null)
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false)
  const [permissions, setPermissions] = useState<string[]>([])
  // Arranca con las constantes de respaldo y se refresca desde `plan_settings`.
  // Así ninguna pantalla se queda sin nombre ni precio mientras carga.
  const [plans, setPlans] = useState<Record<PlanCode, PlanInfo>>(PLANS)
  // uid cuyo perfil/negocio YA está cargado. Sirve para saber si lo que hay en
  // el estado corresponde de verdad a la sesión actual.
  const [contextFor, setContextFor] = useState<string | null>(null)
  const mounted = useRef(true)
  // Contador de generación: descarta resultados de cargas obsoletas (p.ej. si el
  // usuario cambia mientras una carga anterior sigue en vuelo).
  const loadSeq = useRef(0)

  const loadContext = useCallback(async (uid: string | undefined) => {
    const seq = ++loadSeq.current
    const isStale = () => !mounted.current || seq !== loadSeq.current

    if (!uid) {
      setProfile(null)
      setTenant(null)
      setSubscription(null)
      setIsPlatformAdmin(false)
      setPermissions([])
      setContextFor(null)
      return
    }

    // Las dos preguntas son independientes y ambas bloquean la decisión de a
    // dónde va la persona: en paralelo se ahorra una vuelta completa de red.
    const [{ data: prof, error: profError }, { data: isAdmin }] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', uid).maybeSingle(),
      supabase.rpc('auth_is_platform_admin'),
    ])

    if (isStale()) return
    // Si la consulta FALLÓ (sin red, por ejemplo) no se pisa el perfil que ya
    // hubiera con un null: eso equivaldría a decir "esta cuenta no tiene
    // negocio" y mandaría al onboarding a quien solo perdió la conexión.
    if (!profError) setProfile(prof as Profile | null)
    setIsPlatformAdmin(Boolean(isAdmin))

    if (prof?.tenant_id) {
      const [{ data: t }, { data: sub }, { data: perms }] = await Promise.all([
        supabase.from('tenants').select('*').eq('id', prof.tenant_id).maybeSingle(),
        supabase.from('subscriptions').select('*').eq('tenant_id', prof.tenant_id).maybeSingle(),
        supabase.rpc('my_permissions'),
      ])
      if (isStale()) return
      setTenant(t as Tenant | null)
      setSubscription(sub as Subscription | null)
      setPermissions((perms as string[] | null) ?? [])
    } else {
      setTenant(null)
      setSubscription(null)
      setPermissions([])
    }

    // Se marca al FINAL: hasta aquí, lo que hay en el estado no describe a este
    // usuario y nadie debería sacar conclusiones de ello.
    // Se marca INCLUSO si la consulta falló: dejarlo sin marcar colgaría la app
    // en el cargador para siempre, que es peor que decidir con lo que hay.
    if (!isStale()) setContextFor(uid)
  }, [])

  /**
   * Los planes NO dependen de la sesión: la landing pública también los pinta,
   * y la RLS de `plan_settings` permite leerlos como anónimo.
   */
  const loadPlans = useCallback(async () => {
    try {
      const rows = await fetchPlanSettings()
      if (mounted.current && rows.length) setPlans(toPlanMap(rows))
    } catch {
      // Sin conexión o tabla no disponible: se conservan los valores de respaldo.
    }
  }, [])

  const refresh = useCallback(async () => {
    const { data } = await supabase.auth.getSession()
    setSession(data.session)
    await Promise.all([loadContext(data.session?.user?.id), loadPlans()])
  }, [loadContext, loadPlans])

  useEffect(() => {
    mounted.current = true
    void loadPlans()
    ;(async () => {
      const { data } = await supabase.auth.getSession()
      setSession(data.session)
      await loadContext(data.session?.user?.id)
      if (mounted.current) setLoading(false)
      // Con sesión ya presente, intenta subir lo que quedó en la cola offline.
      if (data.session) void resumeIfAuthed(queryClient)
    })()

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      loadContext(newSession?.user?.id)
      // Tras (re)iniciar sesión, sube la cola offline del mismo usuario.
      if (newSession) void resumeIfAuthed(queryClient)
    })

    return () => {
      mounted.current = false
      sub.subscription.unsubscribe()
    }
  }, [loadContext, loadPlans])

  const switchTenant = useCallback(
    async (tenantId: string) => {
      const { error } = await supabase.rpc('switch_tenant', { p_tenant: tenantId })
      if (error) throw error
      // Todo lo cacheado es de la empresa anterior: fuera, antes de pintar nada.
      queryClient.clear()
      const { data } = await supabase.auth.getSession()
      await loadContext(data.session?.user?.id)
    },
    [loadContext],
  )

  const signOut = useCallback(async () => {
    // 1) Sube la cola offline mientras el token AÚN es válido (si hay red).
    await flushOfflineQueue(queryClient)
    // 2) Revoca la sesión.
    await supabase.auth.signOut()
    setProfile(null)
    setTenant(null)
    setSubscription(null)
    setIsPlatformAdmin(false)
    setContextFor(null)
    // 3) Limpia SOLO las lecturas (higiene en dispositivos compartidos).
    //    clearOfflineCache CONSERVA la cola de escrituras sin subir: son datos
    //    que la persona ya dio por guardados. Se reintentan en el próximo login.
    await clearOfflineCache(queryClient)
  }, [])

  const value = useMemo<AuthState>(() => {
    const planCode = subscription?.plan ?? 'basic'
    const uid = session?.user?.id ?? null
    // ¿El perfil que tenemos en memoria es el de ESTA sesión?
    const contextReady = uid === contextFor
    const currentPlan = plans[planCode] ?? PLANS[planCode]
    const permSet = new Set(permissions)
    const tenantModules = new Set(tenant?.modules ?? [])
    return {
      contextReady,
      loading,
      session,
      user: session?.user ?? null,
      profile,
      tenant,
      subscription,
      plan: currentPlan,
      plans,
      // El super-admin de plataforma no pertenece a un tenant: no debe caer en onboarding.
      //
      // `contextReady` es imprescindible: al iniciar sesión, onAuthStateChange
      // fija la sesión de inmediato pero el perfil tarda otra vuelta en llegar.
      // Sin esta condición, durante ese hueco parecería que la cuenta no tiene
      // negocio y el guard mandaría al onboarding, para rebotar al panel un
      // instante después. Ese es el parpadeo "crear negocio → panel".
      needsOnboarding:
        Boolean(session?.user) && contextReady && !profile?.tenant_id && !isPlatformAdmin,
      isPlatformAdmin,
      isOwner: profile?.role === 'owner',
      memberRole: profile?.tenant_id ? profile.role : null,
      permissions,
      can: (perm: string) => permSet.has(perm),
      hasModule: (mod: ModuleCode) =>
        tenantModules.has(mod) && (currentPlan.modules == null || currentPlan.modules.includes(mod)),
      switchTenant,
      refresh,
      signOut,
    }
  }, [
    loading,
    session,
    profile,
    tenant,
    subscription,
    plans,
    isPlatformAdmin,
    contextFor,
    permissions,
    switchTenant,
    refresh,
    signOut,
  ])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>')
  return ctx
}
