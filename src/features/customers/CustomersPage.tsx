import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CloudOff, Eye, Pencil, Plus, Search, Users } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { PageHeader } from '@/components/PageHeader'
import { ActionMenu, type ActionItem } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { DataField, DataFields, DataList, DataRow } from '@/components/ui/DataList'
import { Input } from '@/components/ui/Input'
import { Pagination, paginate } from '@/components/ui/Pagination'
import { Segmented } from '@/components/ui/Segmented'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useCustomerBalances, useCustomers } from '@/hooks/core'
import { errorMessage } from '@/lib/errors'
import { digits, money, norm } from '@/lib/format'
import type { Customer } from '@/types/erp'
import { CustomerFormModal } from './CustomerFormModal'

type Filter = 'active' | 'balance' | 'inactive' | 'all'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'active', label: 'Activos' },
  { value: 'balance', label: 'Con saldo' },
  { value: 'inactive', label: 'Inactivos' },
  { value: 'all', label: 'Todos' },
]

const PAGE_SIZE = 25

const DOC_SHORT: Record<Customer['doc_type'], string> = {
  rnc: 'RNC',
  cedula: 'Cédula',
  passport: 'Pasaporte',
  none: '',
}

/** Fila optimista de la cola offline, aún sin subir (ver lib/offline.ts). */
const isPending = (c: Customer) => '_pendingSync' in c

export function CustomersPage() {
  const { can, tenant } = useAuth()
  const navigate = useNavigate()
  const customers = useCustomers()
  const balances = useCustomerBalances()
  const currency = tenant?.currency ?? 'DOP'
  const canManage = can('customers.manage')

  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('active')
  const [page, setPage] = useState(0)
  const [editing, setEditing] = useState<Customer | null>(null)
  const [formOpen, setFormOpen] = useState(false)

  const balanceOf = (id: string) => balances.data?.[id]?.balance ?? 0

  const rows = useMemo(() => {
    const q = norm(search)
    const qDigits = digits(search)
    return (customers.data ?? []).filter((c) => {
      if (filter === 'active' && !c.is_active) return false
      if (filter === 'inactive' && c.is_active) return false
      if (filter === 'balance' && !(balances.data?.[c.id]?.balance ?? 0)) return false
      if (!q) return true
      // El documento y el teléfono se comparan solo por dígitos: la gente los
      // escribe con guiones, espacios o paréntesis y debe encontrarlos igual.
      return (
        norm(c.name).includes(q) ||
        (qDigits.length >= 3 && (digits(c.doc_number).includes(qDigits) || digits(c.phone).includes(qDigits))) ||
        norm(c.doc_number).includes(q)
      )
    })
  }, [customers.data, balances.data, search, filter])

  const { slice, safePage } = paginate(rows, page, PAGE_SIZE)
  const totalBalance = rows.reduce((s, c) => s + balanceOf(c.id), 0)

  const openNew = () => {
    setEditing(null)
    setFormOpen(true)
  }
  const openEdit = (c: Customer) => {
    setEditing(c)
    setFormOpen(true)
  }

  const actionsFor = (c: Customer): ActionItem[] => {
    const items: ActionItem[] = [
      {
        label: 'Ver estado de cuenta',
        icon: <Eye className="h-4 w-4" />,
        onClick: () => navigate(`/clientes/${c.id}`),
        disabled: isPending(c),
        hint: isPending(c) ? 'Disponible cuando se suba' : undefined,
      },
    ]
    if (canManage) {
      items.push({
        label: 'Editar',
        icon: <Pencil className="h-4 w-4" />,
        onClick: () => openEdit(c),
        disabled: isPending(c),
      })
    }
    return items
  }

  const docText = (c: Customer) => (c.doc_type === 'none' ? '—' : `${DOC_SHORT[c.doc_type]} ${c.doc_number ?? ''}`)

  return (
    <div>
      <PageHeader
        title="Clientes"
        description="Fichas, crédito y saldo pendiente de cada cliente."
        action={
          canManage && (
            <Button onClick={openNew}>
              <Plus className="h-4 w-4" /> Nuevo cliente
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
            placeholder="Buscar por nombre, documento o teléfono"
            className="pl-9"
          />
        </div>
        <Segmented
          value={filter}
          onChange={(f) => {
            setFilter(f)
            setPage(0)
          }}
          options={FILTERS}
          label="Filtro de clientes"
        />
      </div>

      {customers.isLoading ? (
        <PageLoader label="Cargando clientes…" />
      ) : customers.isError ? (
        <EmptyState
          icon={<Users className="h-6 w-6" />}
          title="No se pudieron cargar los clientes"
          description={errorMessage(customers.error)}
          action={<Button onClick={() => customers.refetch()}>Reintentar</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Users className="h-6 w-6" />}
          title={search || filter !== 'active' ? 'Ningún cliente coincide' : 'Aún no hay clientes'}
          description={
            search || filter !== 'active'
              ? 'Prueba con otro nombre o cambia el filtro.'
              : 'Registra a tus clientes para venderles a crédito y llevar su estado de cuenta.'
          }
          action={
            canManage && !search && filter === 'active' ? (
              <Button onClick={openNew}>
                <Plus className="h-4 w-4" /> Nuevo cliente
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 text-sm text-slate-500">
            <span>{rows.length} clientes</span>
            <span>
              Saldo: <b className="text-slate-800">{money(totalBalance, currency)}</b>
            </span>
          </div>

          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3 font-medium">Cliente</th>
                  <th className="px-4 py-3 font-medium">Documento</th>
                  <th className="px-4 py-3 font-medium">Teléfono</th>
                  <th className="px-4 py-3 text-right font-medium">Límite</th>
                  <th className="px-4 py-3 text-right font-medium">Saldo</th>
                  <th className="px-4 py-3 text-right font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {slice.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        disabled={isPending(c)}
                        onClick={() => navigate(`/clientes/${c.id}`)}
                        className="text-left font-medium text-slate-800 hover:text-brand-600 disabled:hover:text-slate-800"
                      >
                        {c.name}
                      </button>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {isPending(c) && (
                          <Badge tone="amber">
                            <CloudOff className="h-3 w-3" /> Pendiente de subir
                          </Badge>
                        )}
                        {!c.is_active && <Badge tone="slate">Inactivo</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{docText(c)}</td>
                    <td className="px-4 py-3 text-slate-600">{c.phone ?? '—'}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                      {Number(c.credit_limit) > 0 ? money(c.credit_limit, currency) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-800">
                      {balanceOf(c.id) > 0 ? money(balanceOf(c.id), currency) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        {!isPending(c) && (
                          <Button size="sm" variant="ghost" onClick={() => navigate(`/clientes/${c.id}`)}>
                            Ver
                          </Button>
                        )}
                        {canManage && !isPending(c) && (
                          <Button size="sm" variant="ghost" onClick={() => openEdit(c)}>
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
            {slice.map((c) => (
              <DataRow
                key={c.id}
                title={c.name}
                titleExtra={docText(c) === '—' ? undefined : docText(c)}
                onClick={isPending(c) ? undefined : () => navigate(`/clientes/${c.id}`)}
                tone={c.is_active ? undefined : 'muted'}
                badges={
                  (isPending(c) || !c.is_active) && (
                    <>
                      {isPending(c) && (
                        <Badge tone="amber">
                          <CloudOff className="h-3 w-3" /> Pendiente de subir
                        </Badge>
                      )}
                      {!c.is_active && <Badge tone="slate">Inactivo</Badge>}
                    </>
                  )
                }
                actions={<ActionMenu items={actionsFor(c)} title={c.name} />}
              >
                <DataFields>
                  <DataField label="Teléfono">{c.phone ?? '—'}</DataField>
                  <DataField label="Saldo">{balanceOf(c.id) > 0 ? money(balanceOf(c.id), currency) : '—'}</DataField>
                </DataFields>
              </DataRow>
            ))}
          </DataList>

          <Pagination page={safePage} pageSize={PAGE_SIZE} total={rows.length} onPage={setPage} label="clientes" />
        </Card>
      )}

      <CustomerFormModal open={formOpen} onClose={() => setFormOpen(false)} customer={editing} />
    </div>
  )
}
