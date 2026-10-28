import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { fmtDate, fmtDateShort, fmtWeekday, money, num } from '@/lib/format'

/*
 * Gráficos mínimos en SVG, sin librería (el stack está cerrado a propósito).
 * Una sola serie y un solo tono de marca: el título dice qué se pinta, así que
 * no hace falta leyenda. El texto va siempre en tinta neutra (slate), nunca en
 * el color de la barra. Cada barra es su propia zona de lectura: al pasar el
 * dedo/ratón o al enfocarla con el teclado, la línea de lectura de arriba dice
 * el día, el monto y el número de ventas. Debajo hay una tabla solo para
 * lectores de pantalla, para que ningún dato dependa de ver el gráfico.
 */

/** Cifra compacta para los ejes: 1.2 mil, 3.4 M. */
function compact(value: number): string {
  return new Intl.NumberFormat('es-DO', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

/** Tope "redondo" del eje: 1, 2, 2.5, 5 o 10 × potencia de 10. */
function niceMax(value: number): number {
  if (value <= 0) return 1
  const pow = 10 ** Math.floor(Math.log10(value))
  const steps = [1, 2, 2.5, 5, 10]
  const f = steps.find((s) => s * pow >= value) ?? 10
  return f * pow
}

/** Barra con el extremo de datos redondeado (4px) y la base recta. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h)
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`
}

export interface DailyPoint {
  day: string
  total: number
  count: number
}

const PAD_LEFT = 44
const PAD_BOTTOM = 22
const PAD_TOP = 8

export function DailySalesChart({
  data,
  currency,
  height = 180,
  label = 'Ventas por día',
}: {
  data: DailyPoint[]
  currency?: string
  height?: number
  label?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [active, setActive] = useState<number | null>(null)

  // Se mide el contenedor en vez de escalar un viewBox: con preserveAspectRatio
  // las esquinas redondeadas y el texto de los ejes se deformarían.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const max = niceMax(Math.max(0, ...data.map((d) => d.total)))
  const plotW = Math.max(0, width - PAD_LEFT)
  const plotH = height - PAD_BOTTOM - PAD_TOP
  const band = data.length ? plotW / data.length : 0
  // Barra fina (≤ 24px) y al menos 2px de aire entre vecinas.
  const barW = Math.max(1, Math.min(24, band * 0.7, band - 2))
  const ticks = [0, max / 2, max]
  const labelIdx = data.length > 2 ? [0, Math.floor((data.length - 1) / 2), data.length - 1] : data.map((_, i) => i)

  // Por defecto la lectura muestra el último día: es lo que se viene a mirar.
  const shown = active ?? (data.length ? data.length - 1 : null)
  const point = shown != null ? data[shown] : null
  const totalAll = data.reduce((s, d) => s + d.total, 0)

  return (
    <div className="space-y-2">
      <div className="flex min-h-[2.5rem] flex-wrap items-baseline justify-between gap-x-3 text-sm" aria-live="polite">
        {point ? (
          <p className="text-slate-600">
            <span className="font-semibold text-slate-900">{money(point.total, currency)}</span>{' '}
            <span className="text-slate-500">
              · {fmtWeekday(point.day)} {fmtDate(point.day)} · {num(point.count)}{' '}
              {point.count === 1 ? 'venta' : 'ventas'}
            </span>
          </p>
        ) : (
          <span />
        )}
        <p className="text-xs text-slate-500">
          Total del período: <span className="font-semibold text-slate-700">{money(totalAll, currency)}</span>
        </p>
      </div>
      <div ref={ref} className="w-full" style={{ height }}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={label} onPointerLeave={() => setActive(null)}>
            {ticks.map((t) => {
              const y = PAD_TOP + plotH - (t / max) * plotH
              return (
                <g key={t}>
                  <line x1={PAD_LEFT} x2={width} y1={y} y2={y} className="stroke-slate-200" strokeWidth={1} />
                  <text
                    x={PAD_LEFT - 6}
                    y={y}
                    textAnchor="end"
                    dominantBaseline="middle"
                    className="fill-slate-400 text-[10px] tabular-nums"
                  >
                    {compact(t)}
                  </text>
                </g>
              )
            })}
            {data.map((d, i) => {
              const h = (d.total / max) * plotH
              const x = PAD_LEFT + i * band + (band - barW) / 2
              const y = PAD_TOP + plotH - h
              const isActive = shown === i
              return (
                <g key={d.day}>
                  {h > 0 && (
                    <path
                      d={barPath(x, y, barW, h)}
                      className={cn('transition-colors', isActive ? 'fill-brand-700' : 'fill-brand-500')}
                    />
                  )}
                  {/* Zona de lectura: toda la franja, más grande que la barra. */}
                  <rect
                    x={PAD_LEFT + i * band}
                    y={PAD_TOP}
                    width={band}
                    height={plotH}
                    fill="transparent"
                    tabIndex={0}
                    role="button"
                    aria-label={`${fmtDate(d.day)}: ${money(d.total, currency)}, ${d.count} ventas`}
                    onPointerEnter={() => setActive(i)}
                    onPointerDown={() => setActive(i)}
                    onFocus={() => setActive(i)}
                    className="cursor-pointer outline-none focus-visible:stroke-brand-400"
                  />
                </g>
              )
            })}
            {labelIdx.map((i) => {
              const d = data[i]
              if (!d) return null
              // Los extremos se anclan hacia dentro para que la fecha no se
              // salga del SVG por los bordes.
              let anchor: 'start' | 'middle' | 'end' = 'middle'
              let ax = PAD_LEFT + i * band + band / 2
              if (i === 0 && data.length > 1) {
                anchor = 'start'
                ax = PAD_LEFT
              } else if (i === data.length - 1 && data.length > 1) {
                anchor = 'end'
                ax = PAD_LEFT + (i + 1) * band
              }
              return (
                <text
                  key={`l-${d.day}`}
                  x={ax}
                  y={height - 6}
                  textAnchor={anchor}
                  className="fill-slate-400 text-[10px] tabular-nums"
                >
                  {fmtDateShort(d.day).slice(0, 5)}
                </text>
              )
            })}
          </svg>
        )}
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th>Día</th>
            <th>Monto</th>
            <th>Ventas</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.day}>
              <td>{fmtDate(d.day)}</td>
              <td>{money(d.total, currency)}</td>
              <td>{d.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Barras horizontales para repartos (métodos de pago, categorías). La etiqueta
 * y el valor van en texto; la barra solo da la proporción frente al mayor.
 */
export function BarList({
  rows,
  format,
  className,
}: {
  rows: { key: string; label: string; value: number; hint?: string }[]
  format: (value: number) => string
  className?: string
}) {
  const max = Math.max(0, ...rows.map((r) => r.value))
  const total = rows.reduce((s, r) => s + r.value, 0)
  return (
    <ul className={cn('space-y-3', className)}>
      {rows.map((r) => {
        const pct = max > 0 ? (r.value / max) * 100 : 0
        const share = total > 0 ? Math.round((r.value / total) * 100) : 0
        return (
          <li key={r.key} title={`${r.label}: ${format(r.value)} (${share} %)`}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-slate-700">{r.label}</span>
              <span className="shrink-0 font-semibold tabular-nums text-slate-900">
                {format(r.value)}
                <span className="ml-1.5 text-xs font-normal text-slate-400">{share} %</span>
              </span>
            </div>
            {r.hint && <p className="text-xs text-slate-400">{r.hint}</p>}
            <div className="mt-1 h-2 w-full rounded-full bg-brand-50">
              <div className="h-2 rounded-full bg-brand-500" style={{ width: `${Math.max(pct, r.value > 0 ? 2 : 0)}%` }} />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
