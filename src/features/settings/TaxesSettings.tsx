import { useState } from 'react'
import { Ban, Pencil, Percent, Play, Plus, Star } from 'lucide-react'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ActionMenu, type ActionItem } from '@/components/ui/ActionMenu'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Field, Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useTaxes } from '@/hooks/core'
import { useSaveTax, useSetDefaultTax, useSetTaxActive } from '@/hooks/settings'
import { errorMessage, isUniqueViolation } from '@/lib/errors'
import { cn } from '@/lib/cn'
import type { Tax } from '@/types/erp'
import { LoadError } from './parts'

/**
 * Tasa guardada (fracción) → texto en %. Se redondea a 2 decimales porque
 * 0.18 * 100 en coma flotante da 18.000000000000004.
 */
function pct(rate: number): string {
  return `${Number((rate * 100).toFixed(2)).toLocaleString('es-DO')} %`
}

/**
 * Impuestos de la empresa (ITBIS 18 %, 16 %, exento…). Se escriben en % y se
 * guardan como fracción, que es lo que usa el cálculo de precios del POS.
 * No se borran (los usan productos y ventas pasadas): se desactivan.
 */
export function TaxesSettings() {
  const toast = useToast()
  const taxes = useTaxes()
  const setActive = useSetTaxActive()
  const setDefault = useSetDefaultTax()
  const [editing, setEditing] = useState<{ tax: Tax | null } | null>(null)

  const run = async (p: Promise<unknown>, ok: string) => {
    try {
      await p
      toast.success(ok)
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  const actionsFor = (t: Tax): ActionItem[] => {
    const items: ActionItem[] = [
      { label: 'Editar', icon: <Pencil className="h-4 w-4" />, onClick: () => setEditing({ tax: t }) },
    ]
    if (!t.is_default) {
      items.push({
        label: 'Usar por defecto',
        icon: <Star className="h-4 w-4" />,
        hint: 'Se aplica a los productos nuevos',
        onClick: () => void run(setDefault.mutateAsync(t.id), `${t.name} es ahora el impuesto por defecto.`),
      })
    }
    items.push(
      t.is_active
        ? {
            label: 'Desactivar',
            icon: <Ban className="h-4 w-4" />,
            tone: 'danger',
            hint: 'Los productos que ya lo usan lo conservan',
            onClick: () => void run(setActive.mutateAsync({ id: t.id, active: false }), 'Impuesto desactivado.'),
          }
        : {
            label: 'Reactivar',
            icon: <Play className="h-4 w-4" />,
            tone: 'success',
            onClick: () => void run(setActive.mutateAsync({ id: t.id, active: true }), 'Impuesto reactivado.'),
          },
    )
    return items
  }

  const rows = taxes.data ?? []
  const badges = (t: Tax) => (
    <>
      {t.is_default && <Badge tone="brand">Por defecto</Badge>}
      {!t.is_active && <Badge tone="slate">Inactivo</Badge>}
    </>
  )

  return (
    <Card>
      <CardHeader
        title="Impuestos"
        subtitle="Tasas que puedes asignar a tus productos y servicios"
        action={
          <Button size="sm" onClick={() => setEditing({ tax: null })}>
            <Plus className="h-4 w-4" /> Nuevo
          </Button>
        }
      />
      {taxes.isLoading ? (
        <PageLoader label="Cargando impuestos…" />
      ) : taxes.isError ? (
        <LoadError error={taxes.error} onRetry={() => taxes.refetch()} what="los impuestos" />
      ) : rows.length === 0 ? (
        <EmptyState
          className="m-5"
          icon={<Percent className="h-5 w-5" />}
          title="Sin impuestos"
          description="Agrega el ITBIS (18 %) y las tasas que uses."
        />
      ) : (
        <>
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3 font-medium">Nombre</th>
                  <th className="px-4 py-3 font-medium">Código</th>
                  <th className="px-4 py-3 text-right font-medium">Tasa</th>
                  <th className="px-4 py-3 font-medium">Estado</th>
                  <th className="px-4 py-3 text-right font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map((t) => (
                  <tr key={t.id} className={cn(!t.is_active && 'bg-slate-50/60 text-slate-400')}>
                    <td className="px-4 py-3 font-medium text-slate-800">{t.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">{t.code}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">{pct(t.rate)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {badges(t)}
                        {t.is_active && !t.is_default && <Badge tone="green">Activo</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <ActionMenu title={t.name} label={`Opciones de ${t.name}`} items={actionsFor(t)} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DataList>
            {rows.map((t) => (
              <DataRow
                key={t.id}
                title={t.name}
                titleExtra={t.code}
                tone={t.is_active ? undefined : 'muted'}
                badges={badges(t)}
                actions={<ActionMenu title={t.name} label={`Opciones de ${t.name}`} items={actionsFor(t)} />}
              >
                <DataFields>
                  <DataField label="Tasa">{pct(t.rate)}</DataField>
                </DataFields>
              </DataRow>
            ))}
          </DataList>
        </>
      )}
      <CardBody className="border-t border-slate-100">
        <p className="text-xs text-slate-500">
          Cambiar la tasa de un impuesto afecta a las ventas NUEVAS; las ya registradas guardan la
          tasa con la que se cobraron.
        </p>
      </CardBody>

      <TaxModal open={Boolean(editing)} tax={editing?.tax ?? null} onClose={() => setEditing(null)} />
    </Card>
  )
}

function TaxModal({ open, tax, onClose }: { open: boolean; tax: Tax | null; onClose: () => void }) {
  const toast = useToast()
  const save = useSaveTax()
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [rate, setRate] = useState('')

  const key = open ? (tax?.id ?? 'new') : ''
  const [synced, setSynced] = useState('')
  if (key !== synced) {
    setSynced(key)
    if (open) {
      setName(tax?.name ?? '')
      setCode(tax?.code ?? '')
      setRate(tax ? String(Number((tax.rate * 100).toFixed(2))) : '')
    }
  }

  const submit = async () => {
    const n = Number(rate.replace(',', '.'))
    if (!name.trim()) return toast.error('El impuesto necesita un nombre.')
    if (!code.trim()) return toast.error('El impuesto necesita un código corto (ej. ITBIS18).')
    // La base exige 0 ≤ tasa < 1 (en fracción): se avisa antes en %.
    if (!Number.isFinite(n) || n < 0 || n >= 100) return toast.error('La tasa va de 0 a 99.99 %.')
    try {
      await save.mutateAsync({
        id: tax?.id,
        name: name.trim(),
        code: code.trim().toUpperCase(),
        // 4 decimales: los mismos que la columna numeric(7,4).
        rate: Number((n / 100).toFixed(4)),
      })
      toast.success(tax ? 'Impuesto actualizado' : 'Impuesto creado')
      onClose()
    } catch (err) {
      // El código es único por empresa (0014): el mensaje crudo de Postgres
      // llegaría en inglés y con el nombre del índice.
      if (isUniqueViolation(err)) return toast.error('Ya existe un impuesto con ese código.')
      toast.error(errorMessage(err, 'No se pudo guardar el impuesto'))
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={tax ? `Editar ${tax.name}` : 'Nuevo impuesto'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => void submit()} loading={save.isPending}>Guardar</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Nombre" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. ITBIS 18 %" />
        </Field>
        <Field label="Código" required hint="Único en tu empresa">
          <Input value={code} maxLength={20} onChange={(e) => setCode(e.target.value)} placeholder="Ej. ITBIS18" />
        </Field>
        <Field label="Tasa (%)" required hint="Escribe 18 para 18 %. 0 = exento.">
          <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="18" />
        </Field>
      </div>
    </Modal>
  )
}
