import { useState, type ChangeEvent } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { onlineManager } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/Button'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { useToast } from '@/components/ui/toast'
import { useCustomers } from '@/hooks/core'
import { useCreateCustomer, useUpdateCustomer, type UpdateCustomerInput } from '@/hooks/customers'
import { customerPriceListId, usePriceLists } from '@/hooks/priceLists'
import { errorMessage } from '@/lib/errors'
import { checkDocNumber } from '@/lib/labels'
import type { Customer, CustomerDocType } from '@/types/erp'

const DOC_LABEL: Record<CustomerDocType, string> = {
  rnc: 'RNC',
  cedula: 'Cédula',
  passport: 'Pasaporte',
  none: 'Sin documento',
}

/** Largo exacto que exige el check de la tabla (0014). */
const DOC_LENGTH: Partial<Record<CustomerDocType, number>> = { rnc: 9, cedula: 11 }

/*
 * El formato se valida aquí igual que en el check de `customers`: si el
 * formulario aceptara algo que la base rechaza, un alta hecha sin conexión
 * fallaría horas después, cuando ya nadie está mirando. El dígito verificador,
 * en cambio, solo AVISA: la última palabra la tiene la DGII.
 */
const schema = z
  .object({
    name: z.string().trim().min(2, 'Escribe el nombre'),
    kind: z.enum(['person', 'company']),
    doc_type: z.enum(['rnc', 'cedula', 'passport', 'none']),
    doc_number: z.string().trim(),
    phone: z.string().trim(),
    email: z
      .string()
      .trim()
      .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Correo inválido'),
    address: z.string().trim(),
    credit_limit: z.coerce.number({ invalid_type_error: 'Escribe un número' }).min(0, 'No puede ser negativo'),
    credit_days: z.coerce
      .number({ invalid_type_error: 'Escribe un número' })
      .int('Días enteros')
      .min(0, 'Mínimo 0')
      .max(365, 'Máximo 365'),
    notes: z.string().trim(),
    is_active: z.boolean(),
    /** '' = sin lista (precio de catálogo). */
    price_list_id: z.string(),
  })
  .superRefine((v, ctx) => {
    const len = DOC_LENGTH[v.doc_type]
    if (len && !new RegExp(`^[0-9]{${len}}$`).test(v.doc_number)) {
      ctx.addIssue({ code: 'custom', path: ['doc_number'], message: `El ${DOC_LABEL[v.doc_type]} lleva ${len} dígitos` })
    }
    if (v.doc_type === 'passport' && v.doc_number === '') {
      ctx.addIssue({ code: 'custom', path: ['doc_number'], message: 'Escribe el número de pasaporte' })
    }
  })

type Values = z.infer<typeof schema>

/**
 * Alta y edición de cliente. El alta va por la cola offline (funciona sin
 * señal); la edición es en línea, porque pisar con datos viejos una ficha que
 * otro ya cambió es peor que pedir conexión.
 */
export function CustomerFormModal({
  open,
  ...props
}: {
  open: boolean
  onClose: () => void
  customer?: Customer | null
  onSaved?: (id: string) => void
}) {
  if (!open) return null
  return <CustomerForm {...props} />
}

function CustomerForm({
  onClose,
  customer,
  onSaved,
}: {
  onClose: () => void
  customer?: Customer | null
  onSaved?: (id: string) => void
}) {
  const { tenant, user, can } = useAuth()
  const toast = useToast()
  const customers = useCustomers()
  const priceLists = usePriceLists()
  // Asignar lista es dar precio especial: la base lo exige (trigger de 0023)
  // aunque quien edite solo tenga customers.manage.
  const canAssignList = can('prices.manage')
  const currentListId = customerPriceListId(customer)
  const create = useCreateCustomer()
  const update = useUpdateCustomer()
  // Un id por apertura del formulario: si el alta se reintenta, la base ve la
  // misma fila y la cola lo toma como ya subido.
  const [newId] = useState(() => crypto.randomUUID())
  const editing = Boolean(customer)

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: customer?.name ?? '',
      kind: customer?.kind ?? 'person',
      doc_type: customer?.doc_type ?? 'none',
      doc_number: customer?.doc_number ?? '',
      phone: customer?.phone ?? '',
      email: customer?.email ?? '',
      address: customer?.address ?? '',
      credit_limit: Number(customer?.credit_limit ?? 0),
      credit_days: customer?.credit_days ?? 30,
      notes: customer?.notes ?? '',
      is_active: customer?.is_active ?? true,
      price_list_id: currentListId ?? '',
    },
  })

  const docType = watch('doc_type')
  const docNumber = watch('doc_number')
  const len = DOC_LENGTH[docType]
  const checkWarning =
    len && docNumber.length === len && checkDocNumber(docNumber) === 'bad_check'
      ? 'El dígito verificador no cuadra. Revisa el número; si estás seguro, puedes guardarlo igual.'
      : undefined

  const docReg = register('doc_number')

  const onSubmit = async (v: Values) => {
    const docNumberValue = v.doc_type === 'none' ? null : v.doc_number
    // Documento repetido: la base lo rechaza con 23505, y la cola offline lee
    // ese código como "ya estaba subido" y descartaría la fila sin avisar.
    if (docNumberValue) {
      const dup = (customers.data ?? []).find((c) => c.doc_number === docNumberValue && c.id !== customer?.id)
      if (dup) {
        setError('doc_number', { message: `Ya existe un cliente con ese documento: ${dup.name}` })
        return
      }
    }
    const fields = {
      name: v.name,
      kind: v.kind,
      doc_type: v.doc_type,
      doc_number: docNumberValue,
      phone: v.phone || null,
      email: v.email || null,
      address: v.address || null,
      credit_limit: v.credit_limit,
      credit_days: v.credit_days,
      notes: v.notes || null,
    }
    const listId = v.price_list_id || null
    // Solo se manda si cambió y quien edita puede asignar listas: así editar el
    // teléfono de un cliente con lista no choca con el trigger de permisos.
    const listChanged = canAssignList && listId !== currentListId
    try {
      if (customer) {
        const patch: UpdateCustomerInput = { id: customer.id, ...fields, is_active: v.is_active }
        if (listChanged) patch.price_list_id = listId
        await update.mutateAsync(patch)
        toast.success('Cliente actualizado')
        onSaved?.(customer.id)
      } else {
        if (!tenant) throw new Error('No hay una empresa activa')
        const input = { id: newId, tenant_id: tenant.id, created_by: user?.id ?? null, ...fields }
        if (onlineManager.isOnline()) {
          await create.mutateAsync(input)
          // La lista va en un UPDATE aparte: el alta pasa por la cola offline,
          // cuya forma (CreateCustomerInput) no lleva lista, y una fila
          // rehidratada mañana no sabría qué hacer con un campo nuevo.
          if (listChanged) {
            try {
              await update.mutateAsync({ id: newId, price_list_id: listId })
              toast.success('Cliente creado con su lista de precios')
            } catch (err) {
              toast.error(`El cliente se creó, pero no se pudo asignar la lista: ${errorMessage(err)}`)
            }
          } else {
            toast.success('Cliente creado')
          }
        } else {
          // Sin red la mutación queda en cola y su promesa no se resuelve hasta
          // que vuelva la señal: se dispara y se cierra el formulario.
          create.mutate(input)
          toast.info(
            listChanged
              ? 'Sin conexión: el cliente se subirá al volver la señal. Asígnale la lista de precios después, desde su ficha.'
              : 'Sin conexión: el cliente se guardó en el teléfono y se subirá al volver la señal.',
          )
        }
        onSaved?.(newId)
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
      title={editing ? 'Editar cliente' : 'Nuevo cliente'}
      footer={
        <>
          <Button variant="outline" type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="customer-form" loading={isSubmitting}>
            {editing ? 'Guardar cambios' : 'Crear cliente'}
          </Button>
        </>
      }
    >
      <form id="customer-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <Field label="Nombre" required error={errors.name?.message}>
            <Input autoFocus {...register('name')} placeholder="Ej. Juan Pérez / Ferretería El Clavo" />
          </Field>
          <Field label="Tipo">
            <Select {...register('kind')}>
              <option value="person">Persona</option>
              <option value="company">Empresa</option>
            </Select>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
          <Field label="Documento">
            <Select
              {...register('doc_type', {
                onChange: (e: ChangeEvent<HTMLSelectElement>) => {
                  const t = e.target.value as CustomerDocType
                  if (t === 'none') setValue('doc_number', '')
                  else if (t !== 'passport') setValue('doc_number', docNumber.replace(/\D/g, '').slice(0, DOC_LENGTH[t]))
                },
              })}
            >
              {(Object.keys(DOC_LABEL) as CustomerDocType[]).map((t) => (
                <option key={t} value={t}>
                  {DOC_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Número" error={errors.doc_number?.message} hint={checkWarning}>
            <Input
              {...docReg}
              onChange={(e) => {
                // RNC y cédula se guardan solo con dígitos: así los guiones que
                // trae la tarjeta no rompen la búsqueda ni el check de la base.
                if (len) e.target.value = e.target.value.replace(/\D/g, '').slice(0, len)
                void docReg.onChange(e)
              }}
              disabled={docType === 'none'}
              inputMode={len ? 'numeric' : 'text'}
              placeholder={len ? `${len} dígitos, sin guiones` : ''}
              className={checkWarning ? 'border-amber-400' : undefined}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Teléfono">
            <Input inputMode="tel" {...register('phone')} />
          </Field>
          <Field label="Correo" error={errors.email?.message}>
            <Input type="email" inputMode="email" {...register('email')} />
          </Field>
        </div>

        <Field label="Dirección">
          <Input {...register('address')} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Límite de crédito" hint="0 = no se le vende a crédito." error={errors.credit_limit?.message}>
            <Input inputMode="decimal" {...register('credit_limit')} />
          </Field>
          <Field label="Días de crédito" error={errors.credit_days?.message}>
            <Input inputMode="numeric" {...register('credit_days')} />
          </Field>
        </div>

        <Field
          label="Lista de precios"
          hint={
            !canAssignList
              ? 'Solo quien gestiona precios puede cambiar la lista del cliente.'
              : priceLists.isError
                ? errorMessage(priceLists.error, 'No se pudieron cargar las listas.')
                : (priceLists.data ?? []).length === 0 && !priceLists.isLoading
                  ? 'Aún no hay listas. Créalas en Productos → Listas de precios.'
                  : 'El POS y las cotizaciones le cobran los precios de esta lista.'
          }
        >
          <Select {...register('price_list_id')} disabled={!canAssignList || priceLists.isLoading}>
            <option value="">Precio de catálogo (sin lista)</option>
            {(priceLists.data ?? [])
              .filter((l) => l.is_active || l.id === currentListId)
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.is_active ? '' : ' (inactiva)'}
                </option>
              ))}
          </Select>
        </Field>

        <Field label="Notas">
          <Textarea rows={2} {...register('notes')} />
        </Field>

        {editing && (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" className="h-4 w-4 rounded border-slate-300" {...register('is_active')} />
            Cliente activo
          </label>
        )}
      </form>
    </Modal>
  )
}
