import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import { Input } from '@/components/ui/Input'
import { useBranches, useProducts, useTaxes } from '@/hooks/core'
import { useTeamMembers } from '@/hooks/team'
import { cn } from '@/lib/cn'
import { priceLines } from '@/lib/pricing'
import type { Branch, Product, RestaurantOrderItem } from '@/types/erp'

/*
 * Piezas comunes de Mesas y Cocina. Copias deliberadas de las del POS
 * (NumberInput, Chip, parseNum…): allí no se exportan y el POS no se toca
 * desde este módulo.
 */

// localStorage puede no existir (modo privado, cuota llena): nunca debe tumbar
// la pantalla, solo dejar de recordar.
export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
export function writeStorage(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* sin almacenamiento: se sigue sin recordar */
  }
}

export const r2 = (n: number) => Math.round(n * 100) / 100
/** Cantidades con 3 decimales, igual que restaurant_order_items.quantity. */
export const r3 = (n: number) => Math.round(n * 1000) / 1000
export function parseNum(s: string): number {
  const n = Number(s.replace(/,/g, '.').trim())
  return Number.isFinite(n) ? n : NaN
}
/** Para buscar sin que importen tildes ni mayúsculas ("cafe" encuentra "Café"). */
export const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
export const fmtQty = (n: number) =>
  Number.isInteger(n) ? String(n) : n.toLocaleString('es-DO', { maximumFractionDigits: 3 })
export const productLabel = (p: Product) => (p.variant_label ? `${p.name} ${p.variant_label}` : p.name)
/** Con ratón se enfoca el buscador; en táctil no, para no abrir el teclado encima del salón. */
export const finePointer = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches

/**
 * 10 % de ley tal como lo calcula create_sale: round(subtotal_sin_ITBIS × 0.10, 2).
 * En centavos para no arrastrar errores de coma flotante.
 */
export const serviceChargeOf = (subtotal: number) => Math.round(Math.round(subtotal * 100) / 10) / 100

/** Minutos enteros desde `iso` hasta `now`. */
export function minutesSince(iso: string | null | undefined, now: number): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60_000)) : 0
}

export function fmtMinutes(min: number): string {
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return `${h} h ${min % 60} min`
}

/** Reloj que avanza cada `ms`, para los "hace N min" del salón y de cocina. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

/**
 * Sucursales en las que esta persona puede trabajar. Cortesía de UI: la base
 * vuelve a comprobar `can_access_branch()` en cada RPC.
 */
export function useMyBranches() {
  const { user, memberRole } = useAuth()
  const branches = useBranches()
  const members = useTeamMembers()
  const list = useMemo(() => {
    const me = members.data?.find((m) => m.user_id === user?.id)
    const unrestricted = memberRole === 'owner' || memberRole === 'admin' || !me || me.branch_ids == null
    return (branches.data ?? []).filter((b) => b.is_active && (unrestricted || (me?.branch_ids ?? []).includes(b.id)))
  }, [branches.data, members.data, user?.id, memberRole])
  return { branches: list, isLoading: branches.isLoading, isError: branches.isError, error: branches.error, refetch: branches.refetch }
}

/**
 * Sucursal elegida, recordada por empresa y pantalla. Si la recordada ya no
 * está disponible se cae a la primera (o a "todas" si `allowAll`).
 */
export function useBranchChoice(scope: string, branches: Branch[], allowAll = false) {
  const { tenant } = useAuth()
  const key = `ferddo-rest-branch:${scope}:${tenant?.id ?? ''}`
  const [id, setId] = useState<string>(() => readStorage(key) ?? '')
  const choose = (next: string) => {
    setId(next)
    writeStorage(key, next)
  }
  const valid = branches.some((b) => b.id === id) || (allowAll && id === '')
  const effective = valid ? id : (branches[0]?.id ?? '')
  return [effective, choose] as const
}

/** Preferencia "10 % de ley" por empresa. Por defecto encendida: es lo habitual en RD. */
export function useServiceChargePref() {
  const { tenant } = useAuth()
  const key = `ferddo-rest-service:${tenant?.id ?? ''}`
  const [on, setOn] = useState<boolean>(() => readStorage(key) !== '0')
  const set = (v: boolean) => {
    setOn(v)
    writeStorage(key, v ? '1' : '0')
  }
  return [on, set] as const
}

/** Línea que aún se debe: ni cobrada ni anulada. */
export const isBillable = (it: RestaurantOrderItem) => !it.billed_sale_id && it.kitchen_status !== 'canceled'

export interface PriceContext {
  productMap: Map<string, Product>
  taxRate: Map<string, number>
  pricesIncludeTax: boolean
}

/** Índices del catálogo para las vistas previas de importes. */
export function usePriceContext(): PriceContext & { products: Product[]; isLoading: boolean; isError: boolean; error: unknown; refetch: () => void } {
  const { tenant } = useAuth()
  const products = useProducts()
  const taxes = useTaxes()
  const productMap = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p])), [products.data])
  const taxRate = useMemo(() => new Map((taxes.data ?? []).map((t) => [t.id, Number(t.rate)])), [taxes.data])
  return {
    productMap,
    taxRate,
    pricesIncludeTax: Boolean(tenant?.prices_include_tax),
    products: products.data ?? [],
    isLoading: products.isLoading,
    isError: products.isError,
    error: products.error,
    refetch: () => void products.refetch(),
  }
}

/**
 * Vista previa de lo que costarían unas líneas con el precio de catálogo
 * vigente. Es solo eso, vista previa: el importe real lo calcula create_sale
 * al cobrar (precios, listas, impuestos).
 */
export function pricePreview(
  lines: { product_id: string; quantity: number }[],
  ctx: PriceContext,
  globalDiscount = 0,
) {
  return priceLines(
    lines.map((l) => {
      const p = ctx.productMap.get(l.product_id)
      return {
        product_id: l.product_id,
        quantity: l.quantity,
        unit_price: p ? Number(p.price) : 0,
        tax_rate: p?.tax_id ? (ctx.taxRate.get(p.tax_id) ?? 0) : 0,
      }
    }),
    globalDiscount,
    ctx.pricesIncludeTax,
  )
}

export function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'h-9 shrink-0 whitespace-nowrap rounded-full px-4 text-sm font-medium transition-colors',
        active ? 'bg-brand-600 text-white' : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
      )}
    >
      {children}
    </button>
  )
}

/**
 * Campo numérico que confirma al salir o con Enter. Mientras se escribe guarda
 * el texto tal cual: con `value={number}` directo, teclear "1." saltaría a 1.
 */
export function NumberInput({
  value,
  onCommit,
  decimals,
  className,
  ...rest
}: {
  value: number
  onCommit: (n: number) => void
  decimals: number
  className?: string
  'aria-label'?: string
  id?: string
}) {
  const [text, setText] = useState(String(value))
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setText(String(value))
  }, [value, focused])
  const commit = () => {
    const n = parseNum(text)
    if (Number.isNaN(n)) {
      setText(String(value))
      return
    }
    const f = 10 ** decimals
    onCommit(Math.round(n * f) / f)
  }
  return (
    <Input
      {...rest}
      inputMode="decimal"
      value={text}
      onFocus={(e) => {
        setFocused(true)
        e.currentTarget.select()
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setFocused(false)
        commit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
          e.currentTarget.blur()
        }
      }}
      className={className}
    />
  )
}
