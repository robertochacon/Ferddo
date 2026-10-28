import { useState } from 'react'
import { Ban, Crown, MapPin, Monitor, Pencil, Play, Plus, Printer, Store } from 'lucide-react'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ActionMenu, type ActionItem } from '@/components/ui/ActionMenu'
import { Field, Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Modal } from '@/components/ui/Modal'
import { Segmented } from '@/components/ui/Segmented'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/auth/AuthProvider'
import { useBranches, useRegisters } from '@/hooks/core'
import {
  useSaveBranch,
  useSaveRegister,
  useSetBranchActive,
  useSetMainBranch,
  useSetRegisterActive,
  type BranchInput,
} from '@/hooks/settings'
import { errorMessage } from '@/lib/errors'
import { DR_PROVINCES } from '@/lib/labels'
import { cn } from '@/lib/cn'
import type { Branch, CashRegister } from '@/types/erp'
import { LoadError } from './parts'

/**
 * Sucursales y sus cajas.
 *
 * Tarjeta por sucursal con sus cajas dentro, sin tabla: la relación
 * sucursal → cajas es lo que importa ver, y una tarjeta apilada cabe igual a
 * 360 px que en escritorio (regla móvil sin scroll lateral).
 *
 * Los topes del plan (`PLAN_LIMIT_BRANCHES`, `PLAN_LIMIT_REGISTERS`) los aplica
 * un trigger y llegan como error; aquí solo se enseña el mensaje de la base.
 */
export function BranchesSettings() {
  const { plan } = useAuth()
  const toast = useToast()
  const branches = useBranches()
  const registers = useRegisters()
  const setBranchActive = useSetBranchActive()
  const setMain = useSetMainBranch()
  const setRegisterActive = useSetRegisterActive()

  const [branchModal, setBranchModal] = useState<{ branch: Branch | null } | null>(null)
  const [registerModal, setRegisterModal] = useState<{ register: CashRegister | null; branchId: string } | null>(null)

  const run = async (p: Promise<unknown>, ok: string) => {
    try {
      await p
      toast.success(ok)
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  if (branches.isLoading || registers.isLoading) return <PageLoader label="Cargando sucursales…" />
  if (branches.isError) {
    return <Card><LoadError error={branches.error} onRetry={() => branches.refetch()} what="las sucursales" /></Card>
  }

  const list = branches.data ?? []
  const regs = registers.data ?? []
  const limitText = (n: number | null, what: string) => (n == null ? `${what} ilimitadas` : `hasta ${n} ${what}`)

  const branchActions = (b: Branch): ActionItem[] => {
    const items: ActionItem[] = [
      { label: 'Editar', icon: <Pencil className="h-4 w-4" />, onClick: () => setBranchModal({ branch: b }) },
      {
        label: 'Agregar caja',
        icon: <Monitor className="h-4 w-4" />,
        disabled: !b.is_active,
        onClick: () => setRegisterModal({ register: null, branchId: b.id }),
      },
    ]
    if (!b.is_main) {
      items.push({
        label: 'Marcar como principal',
        icon: <Crown className="h-4 w-4" />,
        hint: 'La que se usa por defecto en reportes y documentos',
        onClick: () => void run(setMain.mutateAsync(b.id), `${b.name} es ahora la sucursal principal.`),
      })
    }
    items.push(
      b.is_active
        ? {
            label: 'Desactivar',
            icon: <Ban className="h-4 w-4" />,
            tone: 'danger',
            // La principal es la de respaldo de todo lo demás: se cambia antes.
            disabled: b.is_main,
            hint: b.is_main ? 'Marca otra como principal primero' : 'Conserva su historial; deja de usarse para vender',
            onClick: () => {
              if (!window.confirm(`¿Desactivar ${b.name}? Su historial se conserva.`)) return
              void run(setBranchActive.mutateAsync({ id: b.id, active: false }), 'Sucursal desactivada.')
            },
          }
        : {
            label: 'Reactivar',
            icon: <Play className="h-4 w-4" />,
            tone: 'success',
            onClick: () => void run(setBranchActive.mutateAsync({ id: b.id, active: true }), 'Sucursal reactivada.'),
          },
    )
    return items
  }

  const registerActions = (r: CashRegister): ActionItem[] => [
    { label: 'Editar', icon: <Pencil className="h-4 w-4" />, onClick: () => setRegisterModal({ register: r, branchId: r.branch_id }) },
    r.is_active
      ? {
          label: 'Desactivar',
          icon: <Ban className="h-4 w-4" />,
          tone: 'danger',
          onClick: () => {
            if (!window.confirm(`¿Desactivar ${r.name}? Sus cierres anteriores se conservan.`)) return
            void run(setRegisterActive.mutateAsync({ id: r.id, active: false }), 'Caja desactivada.')
          },
        }
      : {
          label: 'Reactivar',
          icon: <Play className="h-4 w-4" />,
          tone: 'success',
          onClick: () => void run(setRegisterActive.mutateAsync({ id: r.id, active: true }), 'Caja reactivada.'),
        },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-slate-500">
          Tu plan {plan.name} permite {limitText(plan.maxBranches, 'sucursales')} y{' '}
          {limitText(plan.maxRegisters, 'cajas')}.
        </p>
        <Button onClick={() => setBranchModal({ branch: null })} className="shrink-0">
          <Plus className="h-4 w-4" /> Nueva sucursal
        </Button>
      </div>

      {list.length === 0 ? (
        <EmptyState
          icon={<Store className="h-5 w-5" />}
          title="Sin sucursales"
          description="Crea la primera sucursal para poder abrir caja y vender."
        />
      ) : (
        list.map((b) => {
          const own = regs.filter((r) => r.branch_id === b.id)
          return (
            <Card key={b.id} className={cn(!b.is_active && 'opacity-75')}>
              <CardHeader
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {b.name}
                    {b.code && <span className="text-xs font-normal text-slate-400">{b.code}</span>}
                    {b.is_main && <Badge tone="brand">Principal</Badge>}
                    {!b.is_active && <Badge tone="slate">Inactiva</Badge>}
                  </span>
                }
                subtitle={
                  [b.address, b.municipality, b.province].filter(Boolean).join(', ') || 'Sin dirección'
                }
                action={<ActionMenu title={b.name} label={`Opciones de ${b.name}`} items={branchActions(b)} />}
              />
              <CardBody className="pt-0">
                {own.length === 0 ? (
                  <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-500">
                    Sin cajas. Agrega una para poder abrir turno y cobrar en esta sucursal.
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                    {own.map((r) => (
                      <li key={r.id} className="flex items-center gap-3 px-3 py-2.5">
                        <Monitor className="h-4 w-4 shrink-0 text-slate-400" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-slate-800">{r.name}</p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                            <Badge tone="slate">
                              <Printer className="h-3 w-3" /> {r.settings?.paper_width ?? 80} mm
                            </Badge>
                            {!r.is_active && <Badge tone="amber">Inactiva</Badge>}
                          </div>
                        </div>
                        <ActionMenu title={r.name} label={`Opciones de ${r.name}`} items={registerActions(r)} />
                      </li>
                    ))}
                  </ul>
                )}
                {b.is_active && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-2"
                    onClick={() => setRegisterModal({ register: null, branchId: b.id })}
                  >
                    <Plus className="h-4 w-4" /> Agregar caja
                  </Button>
                )}
              </CardBody>
            </Card>
          )
        })
      )}

      <p className="flex items-start gap-2 text-xs text-slate-500">
        <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Las sucursales y cajas no se borran: tienen ventas e historial colgando. Desactívalas para
        que dejen de usarse.
      </p>

      <BranchModal
        open={Boolean(branchModal)}
        branch={branchModal?.branch ?? null}
        onClose={() => setBranchModal(null)}
      />
      <RegisterModal
        open={Boolean(registerModal)}
        register={registerModal?.register ?? null}
        branchId={registerModal?.branchId ?? ''}
        branches={list.filter((b) => b.is_active || b.id === registerModal?.branchId)}
        onClose={() => setRegisterModal(null)}
      />
    </div>
  )
}

const EMPTY_BRANCH: BranchInput = { name: '', code: '', address: '', province: '', municipality: '', phone: '' }

function BranchModal({ open, branch, onClose }: { open: boolean; branch: Branch | null; onClose: () => void }) {
  const toast = useToast()
  const save = useSaveBranch()
  const [form, setForm] = useState<BranchInput>(EMPTY_BRANCH)

  // Se sincroniza al abrir, durante el render (sin fotograma con los datos de
  // la sucursal anterior). La clave se olvida al cerrar para releer al reabrir.
  const key = open ? (branch?.id ?? 'new') : ''
  const [synced, setSynced] = useState('')
  if (key !== synced) {
    setSynced(key)
    if (open) {
      setForm(
        branch
          ? {
              name: branch.name,
              code: branch.code ?? '',
              address: branch.address ?? '',
              province: branch.province ?? '',
              municipality: branch.municipality ?? '',
              phone: branch.phone ?? '',
            }
          : EMPTY_BRANCH,
      )
    }
  }

  const set = (k: keyof BranchInput, v: string) => setForm({ ...form, [k]: v })
  const blank = (v: string | null) => (v && v.trim() ? v.trim() : null)

  const submit = async () => {
    const name = form.name.trim()
    if (!name) return toast.error('La sucursal necesita un nombre.')
    try {
      await save.mutateAsync({
        id: branch?.id,
        name,
        code: blank(form.code),
        address: blank(form.address),
        province: blank(form.province),
        municipality: blank(form.municipality),
        phone: blank(form.phone),
      })
      toast.success(branch ? 'Sucursal actualizada' : 'Sucursal creada')
      onClose()
    } catch (err) {
      // PLAN_LIMIT_BRANCHES llega con su frase amigable; errorMessage la limpia.
      toast.error(errorMessage(err, 'No se pudo guardar la sucursal'))
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={branch ? `Editar ${branch.name}` : 'Nueva sucursal'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => void submit()} loading={save.isPending}>Guardar</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Nombre" required className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Ej. Sucursal Los Alcarrizos" />
          </Field>
          <Field label="Código" hint="Opcional, corto">
            <Input value={form.code ?? ''} maxLength={10} onChange={(e) => set('code', e.target.value)} placeholder="Ej. S02" />
          </Field>
        </div>
        <Field label="Teléfono">
          <Input inputMode="tel" value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Provincia">
            <Select value={form.province ?? ''} onChange={(e) => set('province', e.target.value)}>
              <option value="">Selecciona…</option>
              {DR_PROVINCES.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </Select>
          </Field>
          <Field label="Municipio">
            <Input value={form.municipality ?? ''} onChange={(e) => set('municipality', e.target.value)} />
          </Field>
        </div>
        <Field label="Dirección">
          <Input value={form.address ?? ''} onChange={(e) => set('address', e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

const PAPER_OPTIONS: { value: '58' | '80'; label: string }[] = [
  { value: '58', label: '58 mm (pequeña)' },
  { value: '80', label: '80 mm (estándar)' },
]

function RegisterModal({
  open,
  register,
  branchId,
  branches,
  onClose,
}: {
  open: boolean
  register: CashRegister | null
  branchId: string
  branches: Branch[]
  onClose: () => void
}) {
  const toast = useToast()
  const save = useSaveRegister()
  const [name, setName] = useState('')
  const [branch, setBranch] = useState('')
  const [paper, setPaper] = useState<'58' | '80'>('80')

  const key = open ? (register?.id ?? `new-${branchId}`) : ''
  const [synced, setSynced] = useState('')
  if (key !== synced) {
    setSynced(key)
    if (open) {
      setName(register?.name ?? '')
      setBranch(register?.branch_id ?? branchId)
      setPaper(register?.settings?.paper_width === 58 ? '58' : '80')
    }
  }

  const submit = async () => {
    if (!name.trim()) return toast.error('La caja necesita un nombre.')
    if (!branch) return toast.error('Elige la sucursal de la caja.')
    try {
      await save.mutateAsync({
        id: register?.id,
        current: register?.settings,
        name: name.trim(),
        branch_id: branch,
        paper_width: paper === '58' ? 58 : 80,
      })
      toast.success(register ? 'Caja actualizada' : 'Caja creada')
      onClose()
    } catch (err) {
      // PLAN_LIMIT_REGISTERS llega con su frase amigable; errorMessage la limpia.
      toast.error(errorMessage(err, 'No se pudo guardar la caja'))
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={register ? `Editar ${register.name}` : 'Nueva caja'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => void submit()} loading={save.isPending}>Guardar</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Nombre" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Caja 2" />
        </Field>
        <Field label="Sucursal" required>
          <Select value={branch} onChange={(e) => setBranch(e.target.value)}>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Ancho del papel de la impresora" hint="Decide cómo se maquetan recibos y cierres">
          <Segmented value={paper} onChange={setPaper} options={PAPER_OPTIONS} label="Ancho del papel" />
        </Field>
      </div>
    </Modal>
  )
}
