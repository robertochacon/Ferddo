import { useState, type FormEvent } from 'react'
import { Armchair, LayoutGrid, Pencil, Plus, Power } from 'lucide-react'
import { ActionMenu, type ActionItem } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Field, Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import {
  useOpenOrders,
  useRestaurantAreas,
  useRestaurantTables,
  useSaveArea,
  useSaveTable,
  useSetAreaActive,
  useSetTableActive,
} from '@/hooks/restaurant'
import { errorMessage } from '@/lib/errors'
import type { RestaurantArea, RestaurantTable } from '@/types/erp'

/*
 * Configuración del salón de una sucursal: áreas (terraza, salón, barra…) y
 * mesas. No hay borrado (la base no tiene política de DELETE): una mesa con
 * cuentas en su historia se DESACTIVA y deja de salir en el salón.
 */

export function AdminView({ branchId }: { branchId: string }) {
  const toast = useToast()
  const areas = useRestaurantAreas()
  const tables = useRestaurantTables()
  const open = useOpenOrders(branchId)
  const setAreaActive = useSetAreaActive()
  const setTableActive = useSetTableActive()
  const [areaForm, setAreaForm] = useState<RestaurantArea | 'new' | null>(null)
  const [tableForm, setTableForm] = useState<RestaurantTable | 'new' | null>(null)

  if (areas.isLoading || tables.isLoading) return <PageLoader label="Cargando el salón…" />
  if (areas.isError || tables.isError) {
    return (
      <EmptyState
        title="No se pudo cargar la configuración del salón"
        description={errorMessage(areas.error ?? tables.error)}
        action={
          <Button
            variant="outline"
            onClick={() => {
              void areas.refetch()
              void tables.refetch()
            }}
          >
            Reintentar
          </Button>
        }
      />
    )
  }

  const branchAreas = (areas.data ?? []).filter((a) => a.branch_id === branchId)
  const branchTables = (tables.data ?? []).filter((t) => t.branch_id === branchId)
  const areaName = (id: string | null) => (id ? (branchAreas.find((a) => a.id === id)?.name ?? '—') : 'Sin área')
  const busyTables = new Set((open.data ?? []).map((o) => o.table_id).filter(Boolean) as string[])

  const toggleArea = (a: RestaurantArea) =>
    setAreaActive.mutate(
      { id: a.id, active: !a.is_active },
      {
        onSuccess: () => toast.success(a.is_active ? `Área ${a.name} desactivada` : `Área ${a.name} activada`),
        onError: (err) => toast.error(errorMessage(err)),
      },
    )
  const toggleTable = (t: RestaurantTable) => {
    // Una mesa inactiva no sale en el salón: con cuentas abiertas, se perderían de vista.
    if (t.is_active && busyTables.has(t.id)) {
      toast.error(`${t.name} tiene cuentas abiertas: cóbralas o muévelas antes de desactivarla.`)
      return
    }
    setTableActive.mutate(
      { id: t.id, active: !t.is_active },
      {
        onSuccess: () => toast.success(t.is_active ? `${t.name} desactivada` : `${t.name} activada`),
        onError: (err) => toast.error(errorMessage(err)),
      },
    )
  }

  const areaActions = (a: RestaurantArea): ActionItem[] => [
    { label: 'Editar', icon: <Pencil className="h-4 w-4" />, onClick: () => setAreaForm(a) },
    {
      label: a.is_active ? 'Desactivar' : 'Activar',
      icon: <Power className="h-4 w-4" />,
      tone: a.is_active ? 'danger' : 'success',
      hint: a.is_active ? 'Sus mesas pasan a "Otras mesas" en el salón.' : undefined,
      onClick: () => toggleArea(a),
    },
  ]
  const tableActions = (t: RestaurantTable): ActionItem[] => [
    { label: 'Editar', icon: <Pencil className="h-4 w-4" />, onClick: () => setTableForm(t) },
    {
      label: t.is_active ? 'Desactivar' : 'Activar',
      icon: <Power className="h-4 w-4" />,
      tone: t.is_active ? 'danger' : 'success',
      onClick: () => toggleTable(t),
    },
  ]

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Áreas"
          subtitle="Agrupan las mesas en el salón: terraza, salón, barra…"
          action={
            <Button size="sm" onClick={() => setAreaForm('new')}>
              <Plus className="h-4 w-4" /> Nueva área
            </Button>
          }
        />
        {branchAreas.length === 0 ? (
          <EmptyState
            icon={<LayoutGrid className="h-6 w-6" />}
            title="Sin áreas"
            description="Son opcionales: si no creas ninguna, todas las mesas salen juntas."
          />
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-5 py-2.5">Nombre</th>
                    <th className="px-5 py-2.5">Mesas</th>
                    <th className="px-5 py-2.5">Orden</th>
                    <th className="px-5 py-2.5">Estado</th>
                    <th className="px-5 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {branchAreas.map((a) => (
                    <tr key={a.id}>
                      <td className="px-5 py-2.5 font-medium text-slate-800">{a.name}</td>
                      <td className="px-5 py-2.5 tabular-nums">
                        {branchTables.filter((t) => t.area_id === a.id && t.is_active).length}
                      </td>
                      <td className="px-5 py-2.5 tabular-nums">{a.sort_order}</td>
                      <td className="px-5 py-2.5">
                        <Badge tone={a.is_active ? 'green' : 'slate'}>{a.is_active ? 'Activa' : 'Inactiva'}</Badge>
                      </td>
                      <td className="px-5 py-2.5 text-right">
                        <ActionMenu items={areaActions(a)} title={a.name} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <DataList>
              {branchAreas.map((a) => (
                <DataRow
                  key={a.id}
                  title={a.name}
                  tone={a.is_active ? undefined : 'muted'}
                  subtitle={`${branchTables.filter((t) => t.area_id === a.id && t.is_active).length} mesas`}
                  badges={!a.is_active && <Badge tone="slate">Inactiva</Badge>}
                  actions={<ActionMenu items={areaActions(a)} title={a.name} />}
                />
              ))}
            </DataList>
          </>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Mesas"
          subtitle={`${branchTables.filter((t) => t.is_active).length} activas`}
          action={
            <Button size="sm" onClick={() => setTableForm('new')}>
              <Plus className="h-4 w-4" /> Nueva mesa
            </Button>
          }
        />
        {branchTables.length === 0 ? (
          <EmptyState
            icon={<Armchair className="h-6 w-6" />}
            title="Aún no hay mesas"
            description="Crea las mesas de esta sucursal para tomar pedidos por mesa. Sin mesas igual puedes abrir cuentas para llevar."
            action={<Button onClick={() => setTableForm('new')}>Crear la primera mesa</Button>}
          />
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-5 py-2.5">Mesa</th>
                    <th className="px-5 py-2.5">Área</th>
                    <th className="px-5 py-2.5">Puestos</th>
                    <th className="px-5 py-2.5">Orden</th>
                    <th className="px-5 py-2.5">Estado</th>
                    <th className="px-5 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {branchTables.map((t) => (
                    <tr key={t.id}>
                      <td className="px-5 py-2.5 font-medium text-slate-800">{t.name}</td>
                      <td className="px-5 py-2.5">{areaName(t.area_id)}</td>
                      <td className="px-5 py-2.5 tabular-nums">{t.seats}</td>
                      <td className="px-5 py-2.5 tabular-nums">{t.sort_order}</td>
                      <td className="px-5 py-2.5">
                        <Badge tone={t.is_active ? 'green' : 'slate'}>{t.is_active ? 'Activa' : 'Inactiva'}</Badge>
                      </td>
                      <td className="px-5 py-2.5 text-right">
                        <ActionMenu items={tableActions(t)} title={t.name} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <DataList>
              {branchTables.map((t) => (
                <DataRow
                  key={t.id}
                  title={t.name}
                  tone={t.is_active ? undefined : 'muted'}
                  badges={!t.is_active && <Badge tone="slate">Inactiva</Badge>}
                  actions={<ActionMenu items={tableActions(t)} title={t.name} />}
                >
                  <DataFields>
                    <DataField label="Área">{areaName(t.area_id)}</DataField>
                    <DataField label="Puestos">{t.seats}</DataField>
                  </DataFields>
                </DataRow>
              ))}
            </DataList>
          </>
        )}
      </Card>

      {areaForm && (
        <AreaFormModal
          branchId={branchId}
          area={areaForm === 'new' ? null : areaForm}
          nextOrder={branchAreas.length + 1}
          onClose={() => setAreaForm(null)}
        />
      )}
      {tableForm && (
        <TableFormModal
          branchId={branchId}
          table={tableForm === 'new' ? null : tableForm}
          areas={branchAreas.filter((a) => a.is_active || (tableForm !== 'new' && a.id === tableForm.area_id))}
          nextOrder={branchTables.length + 1}
          onClose={() => setTableForm(null)}
        />
      )}
    </div>
  )
}

function AreaFormModal({
  branchId,
  area,
  nextOrder,
  onClose,
}: {
  branchId: string
  area: RestaurantArea | null
  nextOrder: number
  onClose: () => void
}) {
  const toast = useToast()
  const save = useSaveArea()
  const [name, setName] = useState(area?.name ?? '')
  const [order, setOrder] = useState(String(area?.sort_order ?? nextOrder))
  const [error, setError] = useState<string>()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('Escribe el nombre del área')
      return
    }
    save.mutate(
      { id: area?.id, branch_id: branchId, name: name.trim(), sort_order: Math.trunc(Number(order) || 0) },
      {
        onSuccess: () => {
          toast.success(area ? 'Área actualizada' : 'Área creada')
          onClose()
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={area ? `Editar ${area.name}` : 'Nueva área'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="area-form" loading={save.isPending}>
            Guardar
          </Button>
        </>
      }
    >
      <form id="area-form" onSubmit={submit} className="space-y-4">
        <Field label="Nombre" required htmlFor="area-name" error={error}>
          <Input
            id="area-name"
            value={name}
            maxLength={60}
            onChange={(e) => {
              setName(e.target.value)
              setError(undefined)
            }}
            placeholder="Terraza"
            autoFocus
          />
        </Field>
        <Field label="Orden en el salón" htmlFor="area-order" hint="Las áreas se muestran de menor a mayor.">
          <Input id="area-order" inputMode="numeric" value={order} onChange={(e) => setOrder(e.target.value)} />
        </Field>
      </form>
    </Modal>
  )
}

function TableFormModal({
  branchId,
  table,
  areas,
  nextOrder,
  onClose,
}: {
  branchId: string
  table: RestaurantTable | null
  areas: RestaurantArea[]
  nextOrder: number
  onClose: () => void
}) {
  const toast = useToast()
  const save = useSaveTable()
  const [name, setName] = useState(table?.name ?? `Mesa ${nextOrder}`)
  const [seats, setSeats] = useState(String(table?.seats ?? 4))
  const [areaId, setAreaId] = useState(table?.area_id ?? '')
  const [order, setOrder] = useState(String(table?.sort_order ?? nextOrder))
  const [errors, setErrors] = useState<{ name?: string; seats?: string }>({})

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const n = Math.trunc(Number(seats))
    const next: typeof errors = {}
    if (!name.trim()) next.name = 'Escribe el nombre de la mesa'
    if (!Number.isFinite(n) || n < 1 || n > 50) next.seats = 'Entre 1 y 50 puestos'
    setErrors(next)
    if (next.name || next.seats) return
    save.mutate(
      {
        id: table?.id,
        branch_id: branchId,
        area_id: areaId || null,
        name: name.trim(),
        seats: n,
        sort_order: Math.trunc(Number(order) || 0),
      },
      {
        onSuccess: () => {
          toast.success(table ? 'Mesa actualizada' : 'Mesa creada')
          onClose()
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={table ? `Editar ${table.name}` : 'Nueva mesa'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="table-form" loading={save.isPending}>
            Guardar
          </Button>
        </>
      }
    >
      <form id="table-form" onSubmit={submit} className="space-y-4">
        <Field label="Nombre" required htmlFor="table-name" error={errors.name}>
          <Input id="table-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Puestos" required htmlFor="table-seats" error={errors.seats}>
            <Input id="table-seats" inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value)} />
          </Field>
          <Field label="Orden" htmlFor="table-order">
            <Input id="table-order" inputMode="numeric" value={order} onChange={(e) => setOrder(e.target.value)} />
          </Field>
        </div>
        <Field label="Área" htmlFor="table-area">
          <Select id="table-area" value={areaId} onChange={(e) => setAreaId(e.target.value)}>
            <option value="">Sin área</option>
            {areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
      </form>
    </Modal>
  )
}
