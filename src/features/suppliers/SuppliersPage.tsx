import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Eye, Pencil, Plus, Search, Truck } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { PageHeader } from '@/components/PageHeader'
import { RequireAccess } from '@/components/RequireAccess'
import { ActionMenu, type ActionItem } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Pagination, paginate } from '@/components/ui/Pagination'
import { Segmented } from '@/components/ui/Segmented'
import { EmptyState, PageLoader, Spinner } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useSuppliers } from '@/hooks/core'
import { useSupplierPayables, useSupplierPayments } from '@/hooks/payables'
import { useSupplierPurchases } from '@/hooks/purchases'
import { useCreateSupplier, useSupplierBalances, useUpdateSupplier } from '@/hooks/suppliers'
import { errorMessage } from '@/lib/errors'
import { digits, fmtDateShort, money, norm } from '@/lib/format'
import { checkDocNumber, DOCUMENT_STATUS, PAYMENT_METHOD_LABEL, PURCHASE_STATUS } from '@/lib/labels'
import type { Supplier } from '@/types/erp'
import { daysOverdue, round2 } from '@/features/receivables/paymentShared'

type Filter = 'active' | 'balance' | 'inactive'
const PAGE_SIZE = 25

export function SuppliersPage() {
  return (
    // Los proveedores sirven a compras y también a gastos y cuentas por pagar
    // (un consultorio no compra mercancía pero sí paga a proveedores).
    <RequireAccess module={['purchases', 'payables', 'expenses']}>
      <SuppliersContent />
    </RequireAccess>
  )
}

function SuppliersContent() {
  const { can, tenant } = useAuth()
  const currency = tenant?.currency ?? 'DOP'
  const suppliers = useSuppliers()
  const balances = useSupplierBalances()
  const canManage = can('suppliers.manage')

  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('active')
  const [page, setPage] = useState(0)
  const [form, setForm] = useState<{ supplier: Supplier | null } | null>(null)
  const [detail, setDetail] = useState<Supplier | null>(null)

  const balanceOf = (id: string) => balances.data?.[id]?.balance ?? 0

  const rows = useMemo(() => {
    const q = norm(search)
    const qd = digits(search)
    return (suppliers.data ?? []).filter((s) => {
      if (filter === 'active' && !s.is_active) return false
      if (filter === 'inactive' && s.is_active) return false
      if (filter === 'balance' && !(balances.data?.[s.id]?.balance ?? 0)) return false
      if (!q) return true
      return (
        norm(s.name).includes(q) ||
        norm(s.contact_name).includes(q) ||
        (qd.length >= 3 && (digits(s.rnc).includes(qd) || digits(s.phone).includes(qd)))
      )
    })
  }, [suppliers.data, balances.data, search, filter])
  const { slice, safePage } = paginate(rows, page, PAGE_SIZE)

  const actionsFor = (s: Supplier): ActionItem[] => [
    { label: 'Ver historial', icon: <Eye className="h-4 w-4" />, onClick: () => setDetail(s) },
    ...(canManage
      ? [{ label: 'Editar', icon: <Pencil className="h-4 w-4" />, onClick: () => setForm({ supplier: s }) }]
      : []),
  ]

  return (
    <div>
      <PageHeader
        title="Proveedores"
        description="A quién le compras y cuánto le debes."
        action={
          canManage && (
            <Button onClick={() => setForm({ supplier: null })}>
              <Plus className="h-4 w-4" /> Nuevo proveedor
            </Button>
          )
        }
      />

      <div className="mb-4 space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(0)
            }}
            placeholder="Buscar por nombre, contacto, RNC o teléfono"
            className="pl-9"
          />
        </div>
        <Segmented
          value={filter}
          onChange={(f) => {
            setFilter(f)
            setPage(0)
          }}
          options={[
            { value: 'active', label: 'Activos' },
            { value: 'balance', label: 'Con deuda' },
            { value: 'inactive', label: 'Inactivos' },
          ]}
        />
      </div>

      {suppliers.isLoading ? (
        <PageLoader label="Cargando proveedores…" />
      ) : suppliers.isError ? (
        <EmptyState
          icon={<Truck className="h-6 w-6" />}
          title="No se pudieron cargar los proveedores"
          description={errorMessage(suppliers.error)}
          action={<Button onClick={() => suppliers.refetch()}>Reintentar</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Truck className="h-6 w-6" />}
          title={search || filter !== 'active' ? 'Ningún proveedor coincide' : 'Aún no hay proveedores'}
          description={
            search || filter !== 'active'
              ? 'Prueba con otra búsqueda o cambia el filtro.'
              : 'Regístralos para cargar compras y llevar lo que les debes.'
          }
          action={
            canManage && !search && filter === 'active' ? (
              <Button onClick={() => setForm({ supplier: null })}>
                <Plus className="h-4 w-4" /> Nuevo proveedor
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3 font-medium">Proveedor</th>
                  <th className="px-4 py-3 font-medium">RNC</th>
                  <th className="px-4 py-3 font-medium">Contacto</th>
                  <th className="px-4 py-3 font-medium">Crédito</th>
                  <th className="px-4 py-3 text-right font-medium">Le debes</th>
                  <th className="px-4 py-3 text-right font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {slice.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <button type="button" onClick={() => setDetail(s)} className="text-left font-medium text-slate-800 hover:text-brand-600">
                        {s.name}
                      </button>
                      {!s.is_active && <Badge tone="slate" className="ml-2">Inactivo</Badge>}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{s.rnc ?? '—'}</td>
                    <td className="px-4 py-3 text-slate-600">
                      {[s.contact_name, s.phone].filter(Boolean).join(' · ') || '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {s.payment_terms_days > 0 ? `${s.payment_terms_days} días` : 'Contado'}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">
                      {balanceOf(s.id) > 0 ? money(balanceOf(s.id), currency) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setDetail(s)}>
                          Historial
                        </Button>
                        {canManage && (
                          <Button size="sm" variant="ghost" onClick={() => setForm({ supplier: s })}>
                            Editar
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DataList>
            {slice.map((s) => (
              <DataRow
                key={s.id}
                title={s.name}
                titleExtra={s.rnc ? `RNC ${s.rnc}` : undefined}
                onClick={() => setDetail(s)}
                tone={s.is_active ? undefined : 'muted'}
                badges={!s.is_active ? <Badge tone="slate">Inactivo</Badge> : undefined}
                actions={<ActionMenu items={actionsFor(s)} title={s.name} />}
              >
                <DataFields>
                  <DataField label="Teléfono">{s.phone ?? '—'}</DataField>
                  <DataField label="Le debes">{balanceOf(s.id) > 0 ? money(balanceOf(s.id), currency) : '—'}</DataField>
                </DataFields>
              </DataRow>
            ))}
          </DataList>
          <Pagination page={safePage} pageSize={PAGE_SIZE} total={rows.length} onPage={setPage} label="proveedores" />
        </Card>
      )}

      {form && <SupplierFormModal supplier={form.supplier} all={suppliers.data ?? []} onClose={() => setForm(null)} />}
      {detail && (
        <SupplierDetailModal
          supplier={detail}
          balance={balanceOf(detail.id)}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  )
}

// ── Alta / edición ──────────────────────────────────────────────────────────

const schema = z.object({
  name: z.string().trim().min(2, 'Escribe el nombre'),
  // Mismo formato que el check de la tabla: 9 dígitos (RNC) u 11 (cédula).
  rnc: z
    .string()
    .trim()
    .refine((v) => v === '' || /^([0-9]{9}|[0-9]{11})$/.test(v), 'El RNC lleva 9 dígitos (u 11 si es una cédula)'),
  contact_name: z.string().trim(),
  phone: z.string().trim(),
  email: z
    .string()
    .trim()
    .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Correo inválido'),
  address: z.string().trim(),
  payment_terms_days: z.coerce
    .number({ invalid_type_error: 'Escribe un número' })
    .int('Días enteros')
    .min(0, 'Mínimo 0')
    .max(365, 'Máximo 365'),
  notes: z.string().trim(),
  is_active: z.boolean(),
})
type Values = z.infer<typeof schema>

function SupplierFormModal({
  supplier,
  all,
  onClose,
}: {
  supplier: Supplier | null
  all: Supplier[]
  onClose: () => void
}) {
  const toast = useToast()
  const create = useCreateSupplier()
  const update = useUpdateSupplier()
  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: supplier?.name ?? '',
      rnc: supplier?.rnc ?? '',
      contact_name: supplier?.contact_name ?? '',
      phone: supplier?.phone ?? '',
      email: supplier?.email ?? '',
      address: supplier?.address ?? '',
      payment_terms_days: supplier?.payment_terms_days ?? 0,
      notes: supplier?.notes ?? '',
      is_active: supplier?.is_active ?? true,
    },
  })
  const rnc = watch('rnc')
  const rncWarning =
    (rnc.length === 9 || rnc.length === 11) && checkDocNumber(rnc) === 'bad_check'
      ? 'El dígito verificador no cuadra. Revísalo; si estás seguro, puedes guardarlo igual.'
      : undefined
  const rncReg = register('rnc')

  const onSubmit = async (v: Values) => {
    if (v.rnc) {
      const dup = all.find((s) => s.rnc === v.rnc && s.id !== supplier?.id)
      if (dup) {
        setError('rnc', { message: `Ya existe un proveedor con ese RNC: ${dup.name}` })
        return
      }
    }
    const input = {
      name: v.name,
      rnc: v.rnc || null,
      contact_name: v.contact_name || null,
      phone: v.phone || null,
      email: v.email || null,
      address: v.address || null,
      payment_terms_days: v.payment_terms_days,
      notes: v.notes || null,
      is_active: v.is_active,
    }
    try {
      if (supplier) {
        await update.mutateAsync({ id: supplier.id, ...input })
        toast.success('Proveedor actualizado')
      } else {
        await create.mutateAsync(input)
        toast.success('Proveedor creado')
      }
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={supplier ? 'Editar proveedor' : 'Nuevo proveedor'}
      footer={
        <>
          <Button variant="outline" type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="supplier-form" loading={isSubmitting}>
            {supplier ? 'Guardar cambios' : 'Crear proveedor'}
          </Button>
        </>
      }
    >
      <form id="supplier-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <Field label="Nombre o razón social" required error={errors.name?.message}>
            <Input autoFocus {...register('name')} />
          </Field>
          <Field label="RNC" error={errors.rnc?.message} hint={rncWarning}>
            <Input
              {...rncReg}
              onChange={(e) => {
                e.target.value = e.target.value.replace(/\D/g, '').slice(0, 11)
                void rncReg.onChange(e)
              }}
              inputMode="numeric"
              placeholder="Solo dígitos"
              className={rncWarning ? 'border-amber-400' : undefined}
            />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Persona de contacto">
            <Input {...register('contact_name')} />
          </Field>
          <Field label="Teléfono">
            <Input inputMode="tel" {...register('phone')} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Correo" error={errors.email?.message}>
            <Input type="email" inputMode="email" {...register('email')} />
          </Field>
          <Field
            label="Días de crédito"
            hint="0 = contado. Fija el vencimiento de sus compras."
            error={errors.payment_terms_days?.message}
          >
            <Input inputMode="numeric" {...register('payment_terms_days')} />
          </Field>
        </div>
        <Field label="Dirección">
          <Input {...register('address')} />
        </Field>
        <Field label="Notas">
          <Textarea rows={2} {...register('notes')} />
        </Field>
        {supplier && (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" className="h-4 w-4 rounded border-slate-300" {...register('is_active')} />
            Proveedor activo
          </label>
        )}
      </form>
    </Modal>
  )
}

// ── Historial ───────────────────────────────────────────────────────────────

type DetailTab = 'purchases' | 'payables' | 'payments'

function SupplierDetailModal({
  supplier,
  balance,
  onClose,
}: {
  supplier: Supplier
  balance: number
  onClose: () => void
}) {
  const { tenant, hasModule, can } = useAuth()
  const currency = tenant?.currency ?? 'DOP'
  const [tab, setTab] = useState<DetailTab>('purchases')
  const purchases = useSupplierPurchases(supplier.id)
  const payables = useSupplierPayables(supplier.id)
  const payments = useSupplierPayments(supplier.id)
  const canOpenPurchases = hasModule('purchases') && can('purchases.manage')

  const loading = { purchases: purchases.isLoading, payables: payables.isLoading, payments: payments.isLoading }[tab]
  const error = { purchases: purchases.error, payables: payables.error, payments: payments.error }[tab]

  return (
    <Modal open onClose={onClose} size="lg" title={supplier.name}>
      <div className="mb-4 grid gap-2 text-sm sm:grid-cols-2">
        <p>
          <span className="text-slate-500">Le debes: </span>
          <b className="text-slate-800">{money(balance, currency)}</b>
        </p>
        <p>
          <span className="text-slate-500">Crédito: </span>
          {supplier.payment_terms_days > 0 ? `${supplier.payment_terms_days} días` : 'Contado'}
        </p>
        {supplier.rnc && <p className="text-slate-600">RNC {supplier.rnc}</p>}
        {(supplier.contact_name || supplier.phone) && (
          <p className="text-slate-600">{[supplier.contact_name, supplier.phone].filter(Boolean).join(' · ')}</p>
        )}
      </div>

      <Segmented
        value={tab}
        onChange={setTab}
        className="mb-3"
        options={[
          { value: 'purchases', label: 'Compras' },
          { value: 'payables', label: 'Cuentas' },
          { value: 'payments', label: 'Pagos' },
        ]}
      />

      {loading ? (
        <div className="flex justify-center p-8"><Spinner /></div>
      ) : error ? (
        <p className="text-sm text-red-600">{errorMessage(error)}</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-100">
          {tab === 'purchases' &&
            ((purchases.data ?? []).length === 0 ? (
              <Empty text="Sin compras registradas." />
            ) : (
              (purchases.data ?? []).map((p) => (
                <li key={p.id} className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    {canOpenPurchases ? (
                      <Link to={`/compras/${p.id}`} className="font-medium text-slate-800 hover:text-brand-600">
                        {p.number}
                      </Link>
                    ) : (
                      <span className="font-medium text-slate-800">{p.number}</span>
                    )}
                    <p className="truncate text-xs text-slate-500">
                      {fmtDateShort(p.order_date)}
                      {p.supplier_invoice ? ` · Fact. ${p.supplier_invoice}` : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-semibold tabular-nums">{money(p.total, currency)}</p>
                    <Badge tone={PURCHASE_STATUS[p.status].tone}>{PURCHASE_STATUS[p.status].label}</Badge>
                  </div>
                </li>
              ))
            ))}
          {tab === 'payables' &&
            ((payables.data ?? []).length === 0 ? (
              <Empty text="Sin cuentas por pagar." />
            ) : (
              (payables.data ?? []).map((p) => {
                const late = p.status === 'open' && daysOverdue(p.due_date) > 0
                return (
                  <li key={p.id} className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-slate-800">{p.description}</p>
                      <p className="text-xs text-slate-500">Vence {fmtDateShort(p.due_date)}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-semibold tabular-nums">{money(round2(p.amount - p.paid_amount), currency)}</p>
                      {late ? (
                        <Badge tone="red">Vencida</Badge>
                      ) : (
                        <Badge tone={DOCUMENT_STATUS[p.status].tone}>{DOCUMENT_STATUS[p.status].label}</Badge>
                      )}
                    </div>
                  </li>
                )
              })
            ))}
          {tab === 'payments' &&
            ((payments.data ?? []).length === 0 ? (
              <Empty text="Sin pagos registrados." />
            ) : (
              (payments.data ?? []).map((p) => (
                <li key={p.id} className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-800">{p.number}</p>
                    <p className="truncate text-xs text-slate-500">
                      {fmtDateShort(p.created_at)} · {PAYMENT_METHOD_LABEL[p.method]}
                      {p.reference ? ` · ${p.reference}` : ''}
                    </p>
                  </div>
                  <p className="shrink-0 font-semibold tabular-nums">{money(p.amount, currency)}</p>
                </li>
              ))
            ))}
        </ul>
      )}
    </Modal>
  )
}

function Empty({ text }: { text: string }) {
  return <li className="px-4 py-6 text-center text-sm text-slate-500">{text}</li>
}
