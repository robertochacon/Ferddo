import { useEffect, useMemo, useState } from 'react'
import { addDays, endOfMonth, format, startOfMonth, subMonths } from 'date-fns'
import { Ban, Check, Paperclip, Pencil, Plus, Receipt, Tags, Wallet, X } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { PageHeader } from '@/components/PageHeader'
import { RequireAccess } from '@/components/RequireAccess'
import { ActionMenu, type ActionItem } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Pagination, paginate } from '@/components/ui/Pagination'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState, PageLoader, Spinner } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useBranches, useSuppliers } from '@/hooks/core'
import { useCreateExpense, useExpenseCategories, useExpenses, useSaveExpenseCategory, useVoidExpense } from '@/hooks/expenses'
import { useOpenAttachment } from '@/hooks/purchases'
import { errorMessage } from '@/lib/errors'
import { fmtDateShort, money } from '@/lib/format'
import { EXPENSE_STATUS, newClientUid, PAYMENT_METHOD_LABEL } from '@/lib/labels'
import type { Expense, ExpenseCategory, PaymentMethod } from '@/types/erp'
import { AttachmentField } from '@/features/purchases/AttachmentField'
import { parseAmount, PaymentFields, round2, todayIso } from '@/features/receivables/paymentShared'

type Period = 'today' | 'month' | 'prev' | 'range'
const PAGE_SIZE = 25
const ymd = (d: Date) => format(d, 'yyyy-MM-dd')

function periodRange(period: Period, custom: { from: string; to: string }): { from: string; to: string } {
  const now = new Date()
  const ranges: Record<Period, () => { from: string; to: string }> = {
    today: () => ({ from: ymd(now), to: ymd(now) }),
    month: () => ({ from: ymd(startOfMonth(now)), to: ymd(endOfMonth(now)) }),
    prev: () => {
      const prev = subMonths(now, 1)
      return { from: ymd(startOfMonth(prev)), to: ymd(endOfMonth(prev)) }
    },
    range: () => custom,
  }
  return ranges[period]()
}

export function ExpensesPage() {
  return (
    <RequireAccess module="expenses" perm="expenses.manage">
      <ExpensesContent />
    </RequireAccess>
  )
}

function ExpensesContent() {
  const { tenant } = useAuth()
  const toast = useToast()
  const currency = tenant?.currency ?? 'DOP'
  const [period, setPeriod] = useState<Period>('month')
  const [custom, setCustom] = useState(() => ({ from: ymd(startOfMonth(new Date())), to: todayIso() }))
  const [categoryId, setCategoryId] = useState('')
  const [page, setPage] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [voiding, setVoiding] = useState<Expense | null>(null)

  const { from, to } = periodRange(period, custom)
  const expenses = useExpenses(from, to)
  const categories = useExpenseCategories()
  const suppliers = useSuppliers()
  const openFile = useOpenAttachment()

  const categoryName = useMemo(() => new Map((categories.data ?? []).map((c) => [c.id, c.name])), [categories.data])
  const supplierName = useMemo(() => new Map((suppliers.data ?? []).map((s) => [s.id, s.name])), [suppliers.data])

  const rows = useMemo(
    () => (expenses.data ?? []).filter((e) => !categoryId || e.category_id === categoryId),
    [expenses.data, categoryId],
  )
  const live = rows.filter((e) => e.status !== 'voided')
  const total = round2(live.reduce((s, e) => s + e.amount, 0))
  const tax = round2(live.reduce((s, e) => s + e.tax_amount, 0))
  const pending = round2(live.filter((e) => e.status === 'pending').reduce((s, e) => s + e.amount, 0))

  const byCategory = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of live) m.set(e.category_id, round2((m.get(e.category_id) ?? 0) + e.amount))
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [live])

  const { slice, safePage } = paginate(rows, page, PAGE_SIZE)

  const viewFile = (path: string) => openFile.mutate(path, { onError: (err) => toast.error(errorMessage(err)) })

  const actionsFor = (e: Expense): ActionItem[] => {
    const items: ActionItem[] = []
    if (e.attachment_path) {
      const path = e.attachment_path
      items.push({ label: 'Ver adjunto', icon: <Paperclip className="h-4 w-4" />, onClick: () => viewFile(path) })
    }
    if (e.status !== 'voided') {
      items.push({ label: 'Anular', icon: <Ban className="h-4 w-4" />, tone: 'danger', onClick: () => setVoiding(e) })
    }
    return items
  }

  return (
    <div>
      <PageHeader
        title="Gastos"
        description="Lo que sale del negocio fuera de las compras de mercancía."
        action={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> Nuevo gasto
          </Button>
        }
      />

      <div className="mb-4 space-y-3">
        <Segmented
          value={period}
          onChange={(p) => {
            setPeriod(p)
            setPage(0)
          }}
          label="Periodo"
          options={[
            { value: 'today', label: 'Hoy' },
            { value: 'month', label: 'Este mes' },
            { value: 'prev', label: 'Mes anterior' },
            { value: 'range', label: 'Rango' },
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          {period === 'range' && (
            <>
              <Field label="Desde">
                <Input
                  type="date"
                  value={custom.from}
                  max={custom.to}
                  onChange={(e) => e.target.value && setCustom((c) => ({ ...c, from: e.target.value }))}
                />
              </Field>
              <Field label="Hasta">
                <Input
                  type="date"
                  value={custom.to}
                  min={custom.from}
                  onChange={(e) => e.target.value && setCustom((c) => ({ ...c, to: e.target.value }))}
                />
              </Field>
            </>
          )}
          <Field label="Categoría">
            <Select
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value)
                setPage(0)
              }}
            >
              <option value="">Todas</option>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label="Total de gastos" value={money(total, currency)} icon={<Wallet className="h-5 w-5" />} hint={`${live.length} gastos`} />
        <StatCard label="ITBIS incluido" value={money(tax, currency)} icon={<Receipt className="h-5 w-5" />} tone="slate" />
        <StatCard
          label="Por pagar"
          value={money(pending, currency)}
          icon={<Ban className="h-5 w-5" />}
          tone={pending > 0 ? 'amber' : 'slate'}
          className="col-span-2 lg:col-span-1"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0">
          {expenses.isLoading ? (
            <PageLoader label="Cargando gastos…" />
          ) : expenses.isError ? (
            <EmptyState
              icon={<Wallet className="h-6 w-6" />}
              title="No se pudieron cargar los gastos"
              description={errorMessage(expenses.error)}
              action={<Button onClick={() => expenses.refetch()}>Reintentar</Button>}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<Wallet className="h-6 w-6" />}
              title="No hay gastos en este periodo"
              description="Registra luz, alquiler, sueldos, transporte… para saber cuánto te queda de verdad."
              action={
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className="h-4 w-4" /> Nuevo gasto
                </Button>
              }
            />
          ) : (
            <Card>
              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-4 py-3 font-medium">Gasto</th>
                      <th className="px-4 py-3 font-medium">Fecha</th>
                      <th className="px-4 py-3 font-medium">Categoría</th>
                      <th className="px-4 py-3 font-medium">Estado</th>
                      <th className="px-4 py-3 text-right font-medium">Monto</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {slice.map((e) => (
                      <tr key={e.id} className={e.status === 'voided' ? 'bg-slate-50/60 text-slate-400' : undefined}>
                        <td className="px-4 py-3">
                          <p className="font-medium text-slate-800">{e.description}</p>
                          <p className="text-xs text-slate-400">
                            {[e.number, e.supplier_id ? supplierName.get(e.supplier_id) : null, e.ncf].filter(Boolean).join(' · ')}
                          </p>
                        </td>
                        <td className="px-4 py-3 text-slate-600">{fmtDateShort(e.expense_date)}</td>
                        <td className="px-4 py-3 text-slate-600">{categoryName.get(e.category_id) ?? '—'}</td>
                        <td className="px-4 py-3">
                          <Badge tone={EXPENSE_STATUS[e.status].tone}>{EXPENSE_STATUS[e.status].label}</Badge>
                          {e.method && e.status === 'paid' && (
                            <span className="ml-1 text-xs text-slate-400">{PAYMENT_METHOD_LABEL[e.method]}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(e.amount, currency)}</td>
                        <td className="px-4 py-3 text-right">
                          {actionsFor(e).length > 0 && <ActionMenu items={actionsFor(e)} title={e.description} />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <DataList>
                {slice.map((e) => (
                  <DataRow
                    key={e.id}
                    title={e.description}
                    titleExtra={`${e.number} · ${fmtDateShort(e.expense_date)}`}
                    tone={e.status === 'voided' ? 'muted' : undefined}
                    badges={<Badge tone={EXPENSE_STATUS[e.status].tone}>{EXPENSE_STATUS[e.status].label}</Badge>}
                    actions={actionsFor(e).length > 0 ? <ActionMenu items={actionsFor(e)} title={e.description} /> : undefined}
                  >
                    <DataFields>
                      <DataField label="Monto">{money(e.amount, currency)}</DataField>
                      <DataField label="Categoría">{categoryName.get(e.category_id) ?? '—'}</DataField>
                    </DataFields>
                  </DataRow>
                ))}
              </DataList>
              <Pagination page={safePage} pageSize={PAGE_SIZE} total={rows.length} onPage={setPage} label="gastos" />
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Por categoría" />
            <CardBody>
              {byCategory.length === 0 ? (
                <p className="text-sm text-slate-500">Sin gastos en el periodo.</p>
              ) : (
                <ul className="space-y-3">
                  {byCategory.map(([id, amount]) => (
                    <li key={id}>
                      <div className="flex justify-between gap-3 text-sm">
                        <span className="truncate text-slate-700">{categoryName.get(id) ?? 'Categoría'}</span>
                        <span className="shrink-0 font-semibold tabular-nums">{money(amount, currency)}</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-brand-500" style={{ width: `${total ? (amount / total) * 100 : 0}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
          <CategoriesCard categories={categories.data ?? []} loading={categories.isLoading} />
        </div>
      </div>

      {createOpen && <CreateExpenseModal categories={categories.data ?? []} onClose={() => setCreateOpen(false)} />}
      {voiding && <VoidExpenseModal expense={voiding} onClose={() => setVoiding(null)} />}
    </div>
  )
}

// ── Categorías ──────────────────────────────────────────────────────────────

function CategoriesCard({ categories, loading }: { categories: ExpenseCategory[]; loading: boolean }) {
  const toast = useToast()
  const saveCat = useSaveExpenseCategory()
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)

  const run = async (input: Parameters<typeof saveCat.mutateAsync>[0], ok: string) => {
    try {
      await saveCat.mutateAsync(input)
      toast.success(ok)
      return true
    } catch (err) {
      toast.error(errorMessage(err))
      return false
    }
  }

  const add = async () => {
    const n = name.trim()
    if (!n) return
    if (categories.some((c) => c.name.toLowerCase() === n.toLowerCase())) {
      toast.error('Ya existe una categoría con ese nombre')
      return
    }
    if (await run({ name: n }, 'Categoría creada')) setName('')
  }

  return (
    <Card>
      <CardHeader title="Categorías" subtitle="Agrupa los gastos para ver en qué se va el dinero." />
      <CardBody className="space-y-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Electricidad" maxLength={60} />
          <Button type="submit" variant="secondary" disabled={!name.trim()} loading={saveCat.isPending && !editing}>
            <Plus className="h-4 w-4" />
            <span className="sr-only">Agregar categoría</span>
          </Button>
        </form>
        {loading ? (
          <div className="flex justify-center py-4"><Spinner /></div>
        ) : categories.length === 0 ? (
          <p className="text-sm text-slate-500">Crea al menos una categoría para registrar gastos.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {categories.map((c) => (
              <li key={c.id} className="flex items-center gap-2 py-2">
                {editing?.id === c.id ? (
                  <>
                    <Input
                      autoFocus
                      value={editing.name}
                      onChange={(e) => setEditing({ id: c.id, name: e.target.value })}
                      maxLength={60}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Guardar"
                      disabled={!editing.name.trim()}
                      onClick={async () => {
                        if (await run({ id: c.id, name: editing.name.trim() }, 'Categoría renombrada')) setEditing(null)
                      }}
                    >
                      <Check className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" aria-label="Cancelar" onClick={() => setEditing(null)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-slate-700">
                      <Tags className="h-4 w-4 shrink-0 text-slate-400" />
                      <span className="truncate">{c.name}</span>
                      {!c.is_active && <Badge tone="slate">Inactiva</Badge>}
                    </span>
                    <ActionMenu
                      title={c.name}
                      items={[
                        { label: 'Renombrar', icon: <Pencil className="h-4 w-4" />, onClick: () => setEditing({ id: c.id, name: c.name }) },
                        {
                          label: c.is_active ? 'Desactivar' : 'Activar',
                          hint: c.is_active ? 'No se ofrecerá en gastos nuevos; los anteriores la conservan.' : undefined,
                          onClick: () =>
                            void run({ id: c.id, is_active: !c.is_active }, c.is_active ? 'Categoría desactivada' : 'Categoría activada'),
                        },
                      ]}
                    />
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}

// ── Alta de gasto ───────────────────────────────────────────────────────────

/** ITBIS contenido en un monto que ya lo incluye (18 %): monto − monto / 1.18. */
const includedTax = (amount: number) => round2(amount - amount / 1.18)

function CreateExpenseModal({ categories, onClose }: { categories: ExpenseCategory[]; onClose: () => void }) {
  const toast = useToast()
  const branches = useBranches()
  const suppliers = useSuppliers()
  const create = useCreateExpense()
  // Uno por apertura: un reintento tras un corte de red no registra el gasto dos veces.
  const [uid] = useState(newClientUid)

  const activeCategories = categories.filter((c) => c.is_active)
  const activeBranches = (branches.data ?? []).filter((b) => b.is_active)
  const [categoryId, setCategoryId] = useState(activeCategories.length === 1 ? activeCategories[0].id : '')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [hasTax, setHasTax] = useState(false)
  const [taxAmount, setTaxAmount] = useState('')
  const [taxTouched, setTaxTouched] = useState(false)
  const [date, setDate] = useState(todayIso)
  const [branchId, setBranchId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [ncf, setNcf] = useState('')
  const [paid, setPaid] = useState<'paid' | 'pending'>('paid')
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [registerId, setRegisterId] = useState('')
  const [dueDate, setDueDate] = useState(() => ymd(addDays(new Date(), 30)))
  const [attachment, setAttachment] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!branchId && activeBranches.length) {
      setBranchId((activeBranches.find((b) => b.is_main) ?? activeBranches[0]).id)
    }
  }, [branchId, activeBranches])

  // El ITBIS se propone solo (18 % incluido) mientras el usuario no lo toque:
  // muchas facturas traen otra tasa o parte exenta, y ahí manda lo que escriba.
  useEffect(() => {
    if (!hasTax || taxTouched) return
    const a = parseAmount(amount)
    setTaxAmount(Number.isFinite(a) && a > 0 ? String(includedTax(a)) : '')
  }, [amount, hasTax, taxTouched])

  const submit = async () => {
    setError(null)
    const value = round2(parseAmount(amount))
    const taxValue = hasTax ? round2(parseAmount(taxAmount || '0')) : 0
    if (!categoryId) return setError('Elige una categoría')
    if (!description.trim()) return setError('Describe el gasto')
    if (!Number.isFinite(value) || value <= 0) return setError('Escribe un monto mayor que cero')
    if (!Number.isFinite(taxValue) || taxValue < 0 || taxValue > value) return setError('El ITBIS no puede ser mayor que el monto')
    if (!branchId) return setError('Elige la sucursal')
    if (paid === 'pending' && !dueDate) return setError('Indica cuándo vence el pago')
    try {
      await create.mutateAsync({
        client_uid: uid,
        branch_id: branchId,
        category_id: categoryId,
        supplier_id: supplierId || null,
        description: description.trim(),
        amount: value,
        tax_amount: taxValue,
        expense_date: date,
        paid: paid === 'paid',
        method: paid === 'paid' ? method : null,
        register_id: paid === 'paid' && method === 'cash' && registerId ? registerId : null,
        ncf: ncf.trim() || null,
        attachment_path: attachment,
        due_date: paid === 'pending' ? dueDate : null,
      })
      toast.success(paid === 'paid' ? 'Gasto registrado' : 'Gasto registrado en cuentas por pagar')
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
      title="Nuevo gasto"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} loading={create.isPending} disabled={activeCategories.length === 0}>
            Registrar gasto
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {activeCategories.length === 0 && (
          <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-700">
            Primero crea una categoría en la sección «Categorías» de esta pantalla.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Categoría" required>
            <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Selecciona…</option>
              {activeCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fecha" required>
            <Input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Descripción" required>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} placeholder="Ej. Factura de luz de octubre" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Monto total" required>
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <div className="space-y-1.5">
            <label className="flex h-[22px] items-center gap-2 text-sm font-medium text-slate-700">
              <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={hasTax} onChange={(e) => setHasTax(e.target.checked)} />
              Incluye ITBIS
            </label>
            {hasTax && (
              <Input
                inputMode="decimal"
                value={taxAmount}
                onChange={(e) => {
                  setTaxTouched(true)
                  setTaxAmount(e.target.value)
                }}
                aria-label="ITBIS incluido"
              />
            )}
            {hasTax && <p className="text-xs text-slate-500">ITBIS contenido en el monto (18 % propuesto).</p>}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Proveedor" hint="Opcional.">
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Sin proveedor</option>
              {(suppliers.data ?? [])
                .filter((s) => s.is_active)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="NCF" hint="Para el reporte 606.">
            <Input value={ncf} onChange={(e) => setNcf(e.target.value.toUpperCase())} maxLength={19} />
          </Field>
        </div>
        {activeBranches.length > 1 && (
          <Field label="Sucursal" required>
            <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              {activeBranches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Segmented
          value={paid}
          onChange={setPaid}
          label="¿Ya se pagó?"
          options={[
            { value: 'paid', label: 'Pagado ahora' },
            { value: 'pending', label: 'Pagar después' },
          ]}
        />
        {paid === 'paid' ? (
          <PaymentFields
            method={method}
            onMethod={setMethod}
            registerId={registerId}
            onRegister={setRegisterId}
            cashRegister="optional"
          />
        ) : (
          <Field label="Vence" required hint="Queda en cuentas por pagar hasta que lo pagues.">
            <Input type="date" value={dueDate} min={date} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        )}

        <Field label="Comprobante">
          <AttachmentField folder="expenses" path={attachment} onChange={setAttachment} />
        </Field>

        {error && <p className="text-sm font-medium text-red-600">{error}</p>}
      </div>
    </Modal>
  )
}

function VoidExpenseModal({ expense, onClose }: { expense: Expense; onClose: () => void }) {
  const toast = useToast()
  const voidMut = useVoidExpense()
  const [reason, setReason] = useState('')

  const confirm = async () => {
    try {
      await voidMut.mutateAsync({ id: expense.id, reason: reason.trim() })
      toast.success(`Gasto ${expense.number} anulado`)
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={`Anular gasto ${expense.number}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Volver
          </Button>
          <Button variant="danger" onClick={() => void confirm()} loading={voidMut.isPending} disabled={!reason.trim()}>
            Anular
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          {expense.session_id
            ? 'El efectivo vuelve a la caja de donde salió (si sigue abierta).'
            : expense.status === 'pending'
              ? 'Se cancela la cuenta por pagar (si no tiene pagos).'
              : 'El gasto deja de contar en los totales.'}
        </p>
        <Field label="Motivo" required>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </Field>
      </div>
    </Modal>
  )
}
