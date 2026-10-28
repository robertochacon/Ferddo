import { useMemo, useState } from 'react'
import { Check, Pencil, Plus, Tags, Trash2, X } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { useCategories } from '@/hooks/core'
import { useCreateCategory, useDeleteCategory, useUpdateCategory } from '@/hooks/products'
import { errorMessage } from '@/lib/errors'
import { num } from '@/lib/format'
import type { Category, Product } from '@/types/erp'

/**
 * Gestión de categorías. Borrar es seguro (la FK deja los productos "sin
 * categoría"), pero se avisa de cuántos quedan sueltos antes de hacerlo.
 */
export function CategoriesModal({ products, onClose }: { products: Product[]; onClose: () => void }) {
  const toast = useToast()
  const { data: categories = [], isLoading } = useCategories()
  const create = useCreateCategory()
  const update = useUpdateCategory()
  const remove = useDeleteCategory()
  const [newName, setNewName] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Category | null>(null)

  const usage = useMemo(() => {
    const m: Record<string, number> = {}
    for (const p of products) if (p.category_id) m[p.category_id] = (m[p.category_id] ?? 0) + 1
    return m
  }, [products])

  const onCreate = async () => {
    if (!newName.trim()) return
    try {
      await create.mutateAsync(newName)
      setNewName('')
      toast.success('Categoría creada')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo crear la categoría'))
    }
  }

  const onRename = async () => {
    if (!editing || !editing.name.trim()) return
    try {
      await update.mutateAsync({ id: editing.id, name: editing.name.trim() })
      setEditing(null)
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo renombrar'))
    }
  }

  const onToggle = async (c: Category) => {
    try {
      await update.mutateAsync({ id: c.id, is_active: !c.is_active })
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo actualizar'))
    }
  }

  const onDelete = async (c: Category) => {
    try {
      await remove.mutateAsync(c.id)
      setConfirmDelete(null)
      toast.success('Categoría eliminada')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo eliminar'))
    }
  }

  return (
    <Modal open onClose={onClose} title="Categorías" footer={<Button variant="outline" onClick={onClose}>Cerrar</Button>}>
      <div className="space-y-4">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void onCreate()
          }}
        >
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Nueva categoría" aria-label="Nombre de la nueva categoría" />
          <Button type="submit" className="shrink-0" loading={create.isPending} disabled={!newName.trim()}>
            <Plus className="h-4 w-4" /> Agregar
          </Button>
        </form>

        {isLoading ? (
          <PageLoader />
        ) : categories.length === 0 ? (
          <EmptyState icon={<Tags className="h-6 w-6" />} title="Sin categorías" description="Agrupa tu catálogo para filtrarlo y ver la valoración por categoría." />
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {categories.map((c) => {
              const count = usage[c.id] ?? 0
              if (confirmDelete?.id === c.id) {
                return (
                  <li key={c.id} className="space-y-2 bg-red-50/40 p-3">
                    <p className="text-sm text-slate-700">
                      ¿Eliminar <strong>{c.name}</strong>?{' '}
                      {count > 0 ? `${num(count)} producto(s) quedarán sin categoría.` : 'No tiene productos.'}
                    </p>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                        Cancelar
                      </Button>
                      <Button size="sm" variant="danger" loading={remove.isPending} onClick={() => void onDelete(c)}>
                        Eliminar
                      </Button>
                    </div>
                  </li>
                )
              }
              if (editing?.id === c.id) {
                return (
                  <li key={c.id} className="flex items-center gap-2 p-2">
                    <Input
                      autoFocus
                      value={editing.name}
                      onChange={(e) => setEditing({ id: c.id, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void onRename()
                        if (e.key === 'Escape') {
                          // Que el Escape cierre solo la edición, no el diálogo entero.
                          e.stopPropagation()
                          setEditing(null)
                        }
                      }}
                      aria-label="Nombre de la categoría"
                    />
                    <Button size="icon" variant="ghost" onClick={() => void onRename()} loading={update.isPending} aria-label="Guardar">
                      <Check className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => setEditing(null)} aria-label="Cancelar">
                      <X className="h-4 w-4" />
                    </Button>
                  </li>
                )
              }
              return (
                <li key={c.id} className="flex items-center gap-2 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">{c.name}</p>
                    <p className="text-xs text-slate-400">{num(count)} producto(s)</p>
                  </div>
                  {!c.is_active && <Badge tone="slate">Inactiva</Badge>}
                  <Button size="sm" variant="ghost" onClick={() => void onToggle(c)} disabled={update.isPending}>
                    {c.is_active ? 'Desactivar' : 'Activar'}
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => setEditing({ id: c.id, name: c.name })} aria-label={`Renombrar ${c.name}`}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => setConfirmDelete(c)} aria-label={`Eliminar ${c.name}`}>
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}
