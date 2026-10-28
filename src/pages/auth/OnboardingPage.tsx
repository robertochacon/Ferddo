import { useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  Briefcase,
  Building2,
  Coffee,
  Cog,
  Hammer,
  Handshake,
  Shirt,
  ShoppingBasket,
  ShoppingCart,
  Stethoscope,
  Store,
  Ticket,
  UtensilsCrossed,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { AuthLayout } from './AuthLayout'
import { Field, Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/misc'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/auth/AuthProvider'
import { useToast } from '@/components/ui/toast'
import { useBusinessTypes } from '@/hooks/core'
import { useAcceptInvite } from '@/hooks/team'
import { errorMessage } from '@/lib/errors'
import { APP_NAME } from '@/lib/constants'
import { DR_PROVINCES, MODULE_LABEL, checkDocNumber } from '@/lib/labels'
import { cn } from '@/lib/cn'
import type { BusinessType } from '@/types/erp'

/**
 * Primeros pasos: la cuenta ya existe pero todavía no pertenece a ninguna
 * empresa. Dos caminos, los únicos que crean una membresía:
 *   • crear la empresa (`setup_business`, 0013), que en UNA transacción crea
 *     empresa + dueño + suscripción de prueba + sucursal principal + caja +
 *     impuestos + permisos por rol;
 *   • unirse a una existente con un código (`accept_invite`).
 *
 * El alta va en dos pasos —qué negocio es y luego sus datos— porque el tipo de
 * negocio decide qué módulos se encienden, y verlo antes de rellenar nada ayuda
 * a entender qué se está creando. Los datos fiscales son opcionales: se pueden
 * completar después en Configuración, y pedirlos todos de golpe espanta.
 */
export function OnboardingPage() {
  const [params] = useSearchParams()
  // Un enlace con `?codigo=` abre directamente el canje.
  const initialCode = params.get('codigo') ?? ''
  const [mode, setMode] = useState<'create' | 'join'>(initialCode ? 'join' : 'create')

  return (
    // Sin «Inicio» y con «Cerrar sesión»: aquí hay sesión pero todavía no hay
    // empresa, así que la app no tiene menú y esta es la única salida.
    <AuthLayout
      backToHome={false}
      showSignOut
      title={`Bienvenido a ${APP_NAME}`}
      subtitle="Configura tu negocio en un par de minutos"
    >
      <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
        <ModeTab active={mode === 'create'} onClick={() => setMode('create')} icon={<Store className="h-4 w-4" />}>
          Crear mi negocio
        </ModeTab>
        <ModeTab active={mode === 'join'} onClick={() => setMode('join')} icon={<Ticket className="h-4 w-4" />}>
          Tengo un código
        </ModeTab>
      </div>

      {mode === 'create' ? <CreateFlow /> : <JoinForm initialCode={initialCode} />}
    </AuthLayout>
  )
}

const MODE_TAB = {
  on: 'bg-white text-brand-700 shadow-sm',
  off: 'text-slate-500 hover:text-slate-700',
} as const

function ModeTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean
  onClick: () => void
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition-colors',
        MODE_TAB[active ? 'on' : 'off'],
      )}
    >
      {icon}
      {children}
    </button>
  )
}

/** Icono por tipo de negocio (tabla `business_types`). Uno desconocido cae a Store. */
const TYPE_ICON: Record<string, LucideIcon> = {
  colmado: Store,
  minimarket: ShoppingBasket,
  supermarket: ShoppingCart,
  hardware: Hammer,
  clothing: Shirt,
  auto_parts: Cog,
  cafe: Coffee,
  restaurant: UtensilsCrossed,
  workshop: Wrench,
  clinic: Stethoscope,
  professional: Briefcase,
  services: Handshake,
  other: Building2,
}

interface CreateValues {
  name: string
  businessType: string
  fullName: string
  phone: string
  rnc: string
  legalName: string
  province: string
  municipality: string
  address: string
}

const RNC_WARNING = {
  bad_format: 'Debe tener 9 dígitos (RNC) u 11 (cédula), o déjalo vacío.',
  bad_check: 'El dígito verificador no cuadra. Revísalo; si estás seguro, puedes seguir.',
} as const

function CreateFlow() {
  const navigate = useNavigate()
  const toast = useToast()
  const { user, refresh } = useAuth()
  const types = useBusinessTypes()
  const [step, setStep] = useState<1 | 2>(1)
  const [saving, setSaving] = useState(false)
  const [v, setV] = useState<CreateValues>({
    name: '',
    businessType: '',
    // Quien llegó por Google ya dio su nombre: pedirlo otra vez sobra.
    fullName: (user?.user_metadata?.full_name as string | undefined) ?? '',
    phone: '',
    rnc: '',
    legalName: '',
    province: '',
    municipality: '',
    address: '',
  })
  const set = <K extends keyof CreateValues>(k: K, value: CreateValues[K]) => setV((prev) => ({ ...prev, [k]: value }))

  const rnc = v.rnc.replace(/\D/g, '')
  const rncCheck = rnc ? checkDocNumber(rnc) : 'ok'
  const selectedType = (types.data ?? []).find((t) => t.code === v.businessType) ?? null

  const next = (e: FormEvent) => {
    e.preventDefault()
    if (v.name.trim().length < 2) return toast.error('Escribe el nombre de tu negocio.')
    if (!v.businessType) return toast.error('Elige el tipo de negocio.')
    setStep(2)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    // El formato lo exige la base; el dígito verificador es solo un aviso.
    if (rnc && rncCheck === 'bad_format') return toast.error(RNC_WARNING.bad_format)
    const blank = (s: string) => s.trim() || null
    setSaving(true)
    try {
      // Pantalla de acceso: CLAUDE.md permite hablar con supabase aquí. Es una
      // sola RPC idempotente para el primer negocio (un doble clic devuelve la
      // misma empresa en vez de crear dos).
      const { error } = await supabase.rpc('setup_business', {
        p_name: v.name.trim(),
        p_business_type: v.businessType,
        p_full_name: blank(v.fullName),
        p_phone: blank(v.phone),
        p_rnc: rnc || null,
        p_legal_name: blank(v.legalName),
        p_address: blank(v.address),
        p_province: blank(v.province),
        p_municipality: blank(v.municipality),
        p_email: user?.email ?? null,
        p_additional: false,
      })
      if (error) throw error
      // Bienvenida para quien llegó por Google: ahí no hay `signUp` que la
      // dispare (RegisterPage la manda tras crear la cuenta con correo). Por
      // aquí solo se pasa una vez. Sin esperar y sin avisar si falla.
      if (user?.app_metadata?.provider === 'google') {
        void supabase.functions.invoke('welcome').catch(() => {})
      }
      // Recarga el contexto ANTES de navegar: el guard de primeros pasos mira
      // `profile.tenant_id` y sin esto rebotaría de vuelta aquí.
      await refresh()
      toast.success(`¡Todo listo! ${v.name.trim()} ya está en ${APP_NAME}.`)
      navigate('/')
    } catch (err) {
      toast.error(errorMessage(err, 'No pudimos crear el negocio'))
    } finally {
      setSaving(false)
    }
  }

  if (step === 1) {
    return (
      <form onSubmit={next} className="space-y-5" noValidate>
        <Field label="Nombre comercial" required>
          <div className="relative">
            <Store className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              autoFocus
              placeholder="Ej. Colmado La Esperanza"
              className="pl-9"
              value={v.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </div>
        </Field>

        <div>
          <p className="mb-2 text-sm font-medium text-slate-700">
            ¿Qué tipo de negocio es? <span className="text-red-500">*</span>
          </p>
          {types.isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner size="lg" />
            </div>
          ) : types.isError ? (
            <div className="space-y-2 text-center">
              <p className="text-sm text-red-600">{errorMessage(types.error, 'No se pudieron cargar los tipos de negocio.')}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => types.refetch()}>
                Reintentar
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Tipo de negocio">
              {(types.data ?? []).map((t) => (
                <TypeCard
                  key={t.code}
                  type={t}
                  selected={v.businessType === t.code}
                  onSelect={() => set('businessType', t.code)}
                />
              ))}
            </div>
          )}
        </div>

        {selectedType && (
          <div className="rounded-xl border border-mint-200 bg-mint-50 p-3">
            <p className="text-xs font-semibold text-mint-800">Se activan estos módulos:</p>
            <p className="mt-1 text-xs leading-relaxed text-mint-900">
              {selectedType.modules.map((m) => MODULE_LABEL[m] ?? m).join(' · ')}
            </p>
            <p className="mt-1.5 text-[11px] text-mint-800/80">Los puedes cambiar después en Configuración.</p>
          </div>
        )}

        <Button type="submit" size="lg" className="w-full">
          Continuar <ArrowRight className="h-4 w-4" />
        </Button>
      </form>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <button
        type="button"
        onClick={() => setStep(1)}
        className="inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-brand-600"
      >
        <ArrowLeft className="h-4 w-4" /> {v.name.trim()} · {selectedType?.label ?? 'Cambiar tipo'}
      </button>

      <Field label="Tu nombre">
        <Input placeholder="Ej. María Pérez" autoComplete="name" value={v.fullName} onChange={(e) => set('fullName', e.target.value)} />
      </Field>
      <Field label="Teléfono / WhatsApp" hint="Ej. 8095551234">
        <Input inputMode="tel" autoComplete="tel" value={v.phone} onChange={(e) => set('phone', e.target.value)} />
      </Field>

      <div className="rounded-xl border border-slate-200 p-3">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Datos fiscales <span className="font-normal normal-case">(opcional, para facturar)</span>
        </p>
        <div className="space-y-4">
          <Field
            label="RNC o cédula"
            hint="Solo números"
            error={rnc && rncCheck !== 'ok' ? RNC_WARNING[rncCheck] : undefined}
          >
            <Input
              inputMode="numeric"
              maxLength={13}
              value={v.rnc}
              onChange={(e) => set('rnc', e.target.value.replace(/\D/g, ''))}
            />
          </Field>
          <Field label="Razón social" hint="Como aparece en la DGII">
            <Input value={v.legalName} onChange={(e) => set('legalName', e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Provincia">
          <Select value={v.province} onChange={(e) => set('province', e.target.value)}>
            <option value="">Selecciona…</option>
            {DR_PROVINCES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Municipio">
          <Input value={v.municipality} onChange={(e) => set('municipality', e.target.value)} />
        </Field>
      </div>
      <Field label="Dirección">
        <Input autoComplete="street-address" value={v.address} onChange={(e) => set('address', e.target.value)} />
      </Field>

      <Button type="submit" size="lg" className="w-full" loading={saving}>
        Crear mi negocio
      </Button>
      <p className="text-center text-xs text-slate-400">
        Empiezas con una prueba gratuita. Sin tarjeta.
      </p>
    </form>
  )
}

const TYPE_CARD = {
  on: 'border-brand-500 bg-brand-50 text-brand-800 ring-2 ring-brand-500/20',
  off: 'border-slate-200 bg-white text-slate-700 hover:border-brand-200 hover:bg-slate-50',
} as const

function TypeCard({ type, selected, onSelect }: { type: BusinessType; selected: boolean; onSelect: () => void }) {
  const Icon = TYPE_ICON[type.code] ?? Store
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      title={type.modules.map((m) => MODULE_LABEL[m] ?? m).join(', ')}
      className={cn(
        'flex min-h-[76px] flex-col items-center justify-center gap-1.5 rounded-xl border p-2 text-center transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40',
        TYPE_CARD[selected ? 'on' : 'off'],
      )}
    >
      <Icon className={cn('h-5 w-5', selected ? 'text-brand-600' : 'text-slate-400')} />
      <span className="text-xs font-semibold leading-tight">{type.label}</span>
    </button>
  )
}

function JoinForm({ initialCode }: { initialCode: string }) {
  const navigate = useNavigate()
  const toast = useToast()
  const accept = useAcceptInvite()
  const [code, setCode] = useState(initialCode)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (code.trim().length < 6) return toast.error('El código no parece completo.')
    try {
      // El canje es atómico dentro de `accept_invite`: dos personas con el mismo
      // código no pueden entrar las dos, y el error ya viene en español. El hook
      // recarga el contexto antes de volver (sin eso el guard rebotaría aquí).
      await accept.mutateAsync(code)
      toast.success('¡Te uniste al equipo!')
      navigate('/')
    } catch (err) {
      toast.error(errorMessage(err, 'Código inválido o vencido'))
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field label="Código de invitación" required hint="Te lo comparte quien administra el negocio">
        <div className="relative">
          <Ticket className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            placeholder="Ej. a1b2c3d4e5f6"
            autoCapitalize="none"
            spellCheck={false}
            className="pl-9 font-mono"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
      </Field>
      <Button type="submit" size="lg" className="w-full" loading={accept.isPending}>
        Unirme
      </Button>
    </form>
  )
}
