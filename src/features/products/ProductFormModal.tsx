import { useEffect, useMemo, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ImagePlus, Plus, Trash2 } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Segmented } from '@/components/ui/Segmented'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/auth/AuthProvider'
import { useBranches, useCategories, useTaxes } from '@/hooks/core'
import {
  useCreateCategory,
  useCreateProduct,
  useUpdateProduct,
  useUploadProductImage,
  type ProductInput,
} from '@/hooks/products'
import { errorMessage } from '@/lib/errors'
import { money } from '@/lib/format'
import { cn } from '@/lib/cn'
import type { Product, ProductKind } from '@/types/erp'
import { UNITS, marginPct, netPrice, parseDecimal } from './catalog'

/** Campo numérico opcional y no negativo, escrito como texto (acepta coma decimal). */
const nonNegative = (msg: string) =>
  z.string().refine((v) => {
    const n = parseDecimal(v)
    return n === null || (!Number.isNaN(n) && n >= 0)
  }, msg)

const schema = z
  .object({
    kind: z.enum(['product', 'service']),
    name: z.string().trim().min(1, 'Escribe el nombre'),
    parent_id: z.string(),
    variant_label: z.string(),
    code: z.string(),
    sku: z.string(),
    barcode: z.string(),
    category_id: z.string(),
    brand: z.string(),
    unit: z.string().trim().min(1, 'Elige la unidad'),
    cost: nonNegative('Costo inválido'),
    price: nonNegative('Precio inválido'),
    tax_id: z.string(),
    track_stock: z.boolean(),
    min_stock: nonNegative('Cantidad inválida'),
    duration_minutes: z.string().refine((v) => v.trim() === '' || /^[1-9]\d{0,4}$/.test(v.trim()), 'Minutos enteros, mayor que 0'),
    description: z.string(),
    is_active: z.boolean(),
    initial_qty: nonNegative('Cantidad inválida'),
    initial_branch: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.parent_id && !v.variant_label.trim()) {
      ctx.addIssue({ code: 'custom', path: ['variant_label'], message: 'Indica qué la distingue (talla, color…)' })
    }
    if ((parseDecimal(v.initial_qty) ?? 0) > 0 && !v.initial_branch) {
      ctx.addIssue({ code: 'custom', path: ['initial_branch'], message: 'Elige la sucursal' })
    }
  })

type FormValues = z.infer<typeof schema>

const KIND_OPTIONS: { value: ProductKind; label: string }[] = [
  { value: 'product', label: 'Producto' },
  { value: 'service', label: 'Servicio' },
]

const text = (v: string | null | undefined) => v ?? ''
const orNull = (v: string) => v.trim() || null

/**
 * Alta y edición de un producto o servicio. Se monta solo mientras está
 * abierto (lo decide la página), así los valores por defecto se toman del
 * producto recién elegido y no de uno anterior.
 */
export function ProductFormModal({
  product,
  products,
  onClose,
}: {
  /** null = alta. */
  product: Product | null
  /** Catálogo completo, para elegir el producto "padre" de una variante. */
  products: Product[]
  onClose: () => void
}) {
  const toast = useToast()
  const { tenant, can, hasModule } = useAuth()
  const currency = tenant?.currency ?? 'DOP'
  const editing = Boolean(product)
  const canPrice = can('prices.manage')
  // La existencia inicial va por inventory_adjust, que exige permiso y módulo.
  const canInitialStock = !editing && hasModule('inventory') && can('inventory.adjust')

  const { data: taxes = [] } = useTaxes()
  const { data: categories = [] } = useCategories()
  const { data: branches = [] } = useBranches()
  const create = useCreateProduct()
  const update = useUpdateProduct()
  const upload = useUploadProductImage()
  const createCategory = useCreateCategory()

  const [imageUrl, setImageUrl] = useState<string | null>(product?.image_url ?? null)
  const [newCategory, setNewCategory] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const defaultTax = taxes.find((t) => t.is_default && t.is_active)
  const mainBranch = branches.find((b) => b.is_main) ?? branches[0]

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      kind: product?.kind ?? 'product',
      name: text(product?.name),
      parent_id: text(product?.parent_id),
      variant_label: text(product?.variant_label),
      code: text(product?.code),
      sku: text(product?.sku),
      barcode: text(product?.barcode),
      category_id: text(product?.category_id),
      brand: text(product?.brand),
      unit: product?.unit ?? 'unidad',
      cost: product ? String(Number(product.cost)) : '',
      price: product ? String(Number(product.price)) : '',
      tax_id: product ? text(product.tax_id) : (defaultTax?.id ?? ''),
      track_stock: product?.track_stock ?? true,
      min_stock: product && Number(product.min_stock) > 0 ? String(Number(product.min_stock)) : '',
      duration_minutes: product?.duration_minutes ? String(product.duration_minutes) : '',
      description: text(product?.description),
      is_active: product?.is_active ?? true,
      initial_qty: '',
      initial_branch: mainBranch?.id ?? '',
    },
  })

  const kind = watch('kind')
  const trackStock = watch('track_stock')
  const parentId = watch('parent_id')
  const taxId = watch('tax_id')
  const unit = watch('unit')
  const priceStr = watch('price')
  const costStr = watch('cost')
  const categoryId = watch('category_id')
  const initialBranch = watch('initial_branch')

  // Impuestos y sucursales pueden llegar después de montar el formulario: en un
  // alta se rellenan los valores por defecto en cuanto existan.
  useEffect(() => {
    if (!editing && !taxId && defaultTax) setValue('tax_id', defaultTax.id)
  }, [editing, taxId, defaultTax, setValue])
  useEffect(() => {
    if (!initialBranch && mainBranch) setValue('initial_branch', mainBranch.id)
  }, [initialBranch, mainBranch, setValue])

  // Un servicio nunca lleva existencia (check de la tabla). Se apaga aquí para
  // que el formulario no ofrezca algo que la base va a rechazar.
  useEffect(() => {
    if (kind === 'service' && trackStock) setValue('track_stock', false)
  }, [kind, trackStock, setValue])

  const setKind = (k: ProductKind) => {
    setValue('kind', k, { shouldDirty: true })
    if (k === 'service' && unit === 'unidad') setValue('unit', 'servicio')
    if (k === 'product' && unit === 'servicio') setValue('unit', 'unidad')
    if (k === 'product' && !editing) setValue('track_stock', true)
    // El padre debe ser del mismo tipo; al cambiarlo deja de valer.
    setValue('parent_id', '')
  }

  const hasChildren = useMemo(
    () => Boolean(product && products.some((p) => p.parent_id === product.id)),
    [product, products],
  )
  // Un solo nivel de variantes: el padre no puede ser a su vez variante.
  const parentCandidates = useMemo(
    () =>
      products.filter(
        (p) => p.id !== product?.id && !p.parent_id && p.kind === kind && (p.is_active || p.id === parentId),
      ),
    [products, product, kind, parentId],
  )

  const categoryOptions = categories.filter((c) => c.is_active || c.id === categoryId)
  const taxOptions = taxes.filter((t) => t.is_active || t.id === taxId)
  const unitOptions: string[] = (UNITS as readonly string[]).includes(unit) ? [...UNITS] : [unit, ...UNITS]

  // Vista previa del margen: contra el precio NETO cuando el precio incluye ITBIS.
  const selectedTax = taxes.find((t) => t.id === taxId)
  const rate = selectedTax?.rate ?? 0
  const includesTax = tenant?.prices_include_tax ?? true
  const priceNum = parseDecimal(priceStr) ?? 0
  const costNum = parseDecimal(costStr) ?? 0
  const validNums = !Number.isNaN(priceNum) && !Number.isNaN(costNum)
  const margin = validNums ? marginPct(priceNum, costNum, rate, includesTax) : null
  const net = validNums ? netPrice(priceNum, rate, includesTax) : 0

  const onUpload = async (file: File | undefined) => {
    if (!file) return
    try {
      setImageUrl(await upload.mutateAsync(file))
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo subir la imagen'))
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const onCreateCategory = async () => {
    const name = (newCategory ?? '').trim()
    if (!name) return
    try {
      const cat = await createCategory.mutateAsync(name)
      setValue('category_id', cat.id, { shouldDirty: true })
      setNewCategory(null)
      toast.success('Categoría creada')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo crear la categoría'))
    }
  }

  const submit = handleSubmit(async (v) => {
    const isService = v.kind === 'service'
    const payload: ProductInput = {
      kind: v.kind,
      name: v.name.trim(),
      parent_id: orNull(v.parent_id),
      variant_label: v.parent_id ? orNull(v.variant_label) : null,
      code: orNull(v.code),
      sku: orNull(v.sku),
      barcode: orNull(v.barcode),
      category_id: orNull(v.category_id),
      brand: orNull(v.brand),
      unit: v.unit.trim(),
      cost: parseDecimal(v.cost) ?? 0,
      price: parseDecimal(v.price) ?? 0,
      tax_id: orNull(v.tax_id),
      track_stock: !isService && v.track_stock,
      min_stock: !isService && v.track_stock ? (parseDecimal(v.min_stock) ?? 0) : 0,
      duration_minutes: isService && v.duration_minutes.trim() ? Number(v.duration_minutes) : null,
      description: orNull(v.description),
      image_url: imageUrl,
      is_active: v.is_active,
    }
    try {
      if (product) {
        // Sin prices.manage el precio no viaja: aunque no cambie, mandarlo es
        // ruido, y si alguien manipula el formulario la base lo rechazaría igual.
        const { price, ...rest } = payload
        await update.mutateAsync({ id: product.id, patch: canPrice ? { ...rest, price } : rest })
        toast.success('Cambios guardados')
        onClose()
        return
      }
      const qty = parseDecimal(v.initial_qty) ?? 0
      const res = await create.mutateAsync({
        product: payload,
        initialStock: canInitialStock && payload.track_stock && qty > 0 ? { branchId: v.initial_branch, quantity: qty } : null,
      })
      if (res.stockError) {
        toast.error(
          `${isService ? 'Servicio creado' : 'Producto creado'}, pero no se registró la existencia inicial: ${errorMessage(res.stockError)}`,
        )
      } else {
        toast.success(isService ? 'Servicio creado' : 'Producto creado')
      }
      onClose()
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo guardar'))
    }
  })

  const busy = isSubmitting || create.isPending || update.isPending
  const title = editing ? `Editar ${product?.kind === 'service' ? 'servicio' : 'producto'}` : 'Nuevo producto o servicio'

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" form="product-form" loading={busy} disabled={upload.isPending}>
            {editing ? 'Guardar cambios' : 'Crear'}
          </Button>
        </>
      }
    >
      <form id="product-form" onSubmit={submit} className="space-y-5" noValidate>
        {!editing && <Segmented value={kind} onChange={setKind} options={KIND_OPTIONS} label="Tipo" />}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre" required error={errors.name?.message} className="sm:col-span-2">
            <Input {...register('name')} placeholder={kind === 'service' ? 'Ej.: Cambio de aceite' : 'Ej.: Cemento gris 42.5 kg'} />
          </Field>

          <Field label="Categoría">
            {newCategory === null ? (
              <div className="flex gap-2">
                <Select {...register('category_id')}>
                  <option value="">Sin categoría</option>
                  {categoryOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
                {can('products.manage') && (
                  <Button type="button" variant="outline" size="icon" className="shrink-0" onClick={() => setNewCategory('')} aria-label="Nueva categoría" title="Nueva categoría">
                    <Plus className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex gap-2">
                <Input
                  autoFocus
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void onCreateCategory()
                    }
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      setNewCategory(null)
                    }
                  }}
                  placeholder="Nueva categoría"
                />
                <Button type="button" size="sm" className="h-11 shrink-0" onClick={() => void onCreateCategory()} loading={createCategory.isPending} disabled={!newCategory.trim()}>
                  Crear
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-11 shrink-0" onClick={() => setNewCategory(null)}>
                  Cancelar
                </Button>
              </div>
            )}
          </Field>

          <Field label="Marca">
            <Input {...register('brand')} />
          </Field>

          <Field label="Código interno" error={errors.code?.message}>
            <Input {...register('code')} autoComplete="off" />
          </Field>
          <Field label="SKU" error={errors.sku?.message}>
            <Input {...register('sku')} autoComplete="off" />
          </Field>
          <Field label="Código de barras" error={errors.barcode?.message} hint="Puedes escanearlo con el lector.">
            <Input
              {...register('barcode')}
              autoComplete="off"
              inputMode="numeric"
              // El lector manda Enter al final: aquí no debe enviar el formulario.
              onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
            />
          </Field>
          <Field label="Unidad de medida" required error={errors.unit?.message}>
            <Select {...register('unit')}>
              {unitOptions.map((u) => (
                <option key={u} value={u}>
                  {u.charAt(0).toUpperCase() + u.slice(1)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {/* Precios */}
        <div className="grid gap-4 rounded-2xl border border-slate-200 p-4 sm:grid-cols-3">
          <Field label="Costo" error={errors.cost?.message}>
            <Input {...register('cost')} inputMode="decimal" placeholder="0.00" />
          </Field>
          <Field
            label={includesTax ? 'Precio (ITBIS incluido)' : 'Precio (sin ITBIS)'}
            error={errors.price?.message}
            hint={editing && !canPrice ? 'Tu rol no puede cambiar precios.' : undefined}
          >
            <Input {...register('price')} inputMode="decimal" placeholder="0.00" disabled={editing && !canPrice} />
          </Field>
          <Field label="Impuesto">
            <Select {...register('tax_id')}>
              {(taxOptions.length === 0 || taxId === '') && <option value="">Sin impuesto</option>}
              {taxOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({Math.round(t.rate * 10000) / 100}%)
                </option>
              ))}
            </Select>
          </Field>
          <div className="sm:col-span-3">
            <MarginPreview margin={margin} net={net} cost={costNum} currency={currency} includesTax={includesTax} rate={rate} price={priceNum} />
          </div>
        </div>

        {/* Inventario / servicio */}
        {kind === 'product' ? (
          <div className="space-y-4">
            <label className="flex items-start gap-3">
              <input type="checkbox" {...register('track_stock')} className="mt-0.5 h-5 w-5 rounded border-slate-300 text-brand-600" />
              <span>
                <span className="block text-sm font-medium text-slate-700">Controlar existencia</span>
                <span className="block text-xs text-slate-500">
                  Descuenta del inventario al vender. Apágalo para productos que no se cuentan (p. ej. hielo a granel).
                </span>
              </span>
            </label>
            {trackStock && (
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Existencia mínima" error={errors.min_stock?.message} hint="Avisa cuando baje de aquí.">
                  <Input {...register('min_stock')} inputMode="decimal" placeholder="0" />
                </Field>
                {canInitialStock && (
                  <>
                    <Field label="Existencia inicial" error={errors.initial_qty?.message}>
                      <Input {...register('initial_qty')} inputMode="decimal" placeholder="0" />
                    </Field>
                    <Field label="En la sucursal" error={errors.initial_branch?.message}>
                      <Select {...register('initial_branch')}>
                        {branches
                          .filter((b) => b.is_active)
                          .map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                      </Select>
                    </Field>
                  </>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Duración (minutos)" error={errors.duration_minutes?.message} hint="Opcional; útil para agendar.">
              <Input {...register('duration_minutes')} inputMode="numeric" placeholder="Ej.: 45" />
            </Field>
          </div>
        )}

        {/* Variantes */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Variante de"
            hint={hasChildren ? 'Este producto ya tiene variantes; no puede ser variante de otro.' : 'Para tallas, colores o presentaciones de un mismo artículo.'}
          >
            <Select {...register('parent_id')} disabled={hasChildren}>
              <option value="">— No es variante —</option>
              {parentCandidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          {parentId && (
            <Field label="Etiqueta de la variante" required error={errors.variant_label?.message}>
              <Input {...register('variant_label')} placeholder="Ej.: Talla M, Rojo, 1 galón" />
            </Field>
          )}
        </div>

        <Field label="Descripción">
          <Textarea {...register('description')} rows={3} />
        </Field>

        {/* Imagen */}
        <div className="flex items-center gap-4">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
            {imageUrl ? (
              <img src={imageUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <ImagePlus className="h-6 w-6 text-slate-300" />
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void onUpload(e.target.files?.[0])} />
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} loading={upload.isPending}>
              <ImagePlus className="h-4 w-4" /> {imageUrl ? 'Cambiar imagen' : 'Subir imagen'}
            </Button>
            {imageUrl && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setImageUrl(null)}>
                <Trash2 className="h-4 w-4" /> Quitar
              </Button>
            )}
          </div>
        </div>

        <label className="flex items-center gap-3">
          <input type="checkbox" {...register('is_active')} className="h-5 w-5 rounded border-slate-300 text-brand-600" />
          <span className="text-sm font-medium text-slate-700">Activo (se puede vender)</span>
        </label>
      </form>
    </Modal>
  )
}

const MARGIN_TONE = {
  bad: 'bg-red-50 text-red-700',
  low: 'bg-amber-50 text-amber-700',
  good: 'bg-emerald-50 text-emerald-700',
  none: 'bg-slate-50 text-slate-500',
} as const

function MarginPreview({
  margin,
  net,
  cost,
  price,
  rate,
  currency,
  includesTax,
}: {
  margin: number | null
  net: number
  cost: number
  price: number
  rate: number
  currency: string
  includesTax: boolean
}) {
  if (margin === null) {
    return <p className={cn('rounded-xl px-3 py-2 text-sm', MARGIN_TONE.none)}>Escribe el precio para ver el margen.</p>
  }
  let tone: keyof typeof MARGIN_TONE = 'good'
  if (margin < 0) tone = 'bad'
  else if (margin < 10) tone = 'low'
  const final = includesTax ? price : price * (1 + rate)
  return (
    <div className={cn('rounded-xl px-3 py-2 text-sm', MARGIN_TONE[tone])}>
      <p className="font-semibold">
        Margen {margin.toLocaleString('es-DO', { maximumFractionDigits: 1 })}% · ganancia {money(net - cost, currency)} por unidad
      </p>
      <p className="text-xs opacity-80">
        {includesTax
          ? `Precio sin ITBIS: ${money(net, currency)}`
          : `El cliente paga ${money(final, currency)} con impuesto`}
      </p>
    </div>
  )
}
