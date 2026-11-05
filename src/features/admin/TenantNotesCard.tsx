import { useMemo, useState, type FormEvent } from 'react'
import { StickyNote, Trash2 } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Textarea } from '@/components/ui/Input'
import { Pagination, usePaged } from '@/components/ui/Pagination'
import { EmptyState, PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { errorMessage } from '@/lib/errors'
import { fmtDateTime } from '@/lib/format'
import { useAddTenantNote, useAdminPlatformAdmins, useDeleteTenantNote, useTenantNotes } from '@/hooks/admin'

/** Igual que el `check` de la tabla: la base rechaza más, aquí se avisa antes. */
const MAX_NOTE = 2000

/**
 * Notas internas del equipo Ferddo sobre un negocio (`tenant_admin_notes`,
 * 0028): llamadas, acuerdos, incidencias. El negocio NO las ve; la RLS solo
 * deja leerlas a super-admins.
 */
export function TenantNotesCard({ tenantId, className }: { tenantId: string; className?: string }) {
  const { user } = useAuth()
  const toast = useToast()
  const notes = useTenantNotes(tenantId)
  const admins = useAdminPlatformAdmins()
  const add = useAddTenantNote()
  const remove = useDeleteTenantNote()
  const [body, setBody] = useState('')
  const paged = usePaged(notes.data ?? [])

  // El autor se resuelve con la lista de super-admins que el panel ya carga: la
  // nota solo guarda el id, y un autor que dejó de ser super-admin sale como tal.
  const authorEmail = useMemo(
    () => new Map((admins.data ?? []).map((a) => [a.user_id, a.email ?? a.user_id])),
    [admins.data],
  )

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!body.trim()) return
    try {
      await add.mutateAsync({ tenant: tenantId, body })
      setBody('')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo guardar la nota.'))
    }
  }

  const del = async (id: string) => {
    if (!window.confirm('¿Borrar esta nota?')) return
    try {
      await remove.mutateAsync({ id, tenant: tenantId })
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo borrar la nota.'))
    }
  }

  return (
    <Card className={className}>
      <CardHeader title="Notas internas" subtitle="Solo las ve el equipo Ferddo; el negocio no." />
      <CardBody className="space-y-3">
        <form onSubmit={submit} className="space-y-2">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            maxLength={MAX_NOTE}
            placeholder="Ej. Llamó por la factura de octubre; quedamos en revisar el lunes."
            aria-label="Nueva nota"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs tabular-nums text-slate-400">{body.length} / {MAX_NOTE}</span>
            <Button type="submit" size="sm" loading={add.isPending} disabled={!body.trim()}>
              Guardar nota
            </Button>
          </div>
        </form>
      </CardBody>

      {notes.isLoading ? (
        <PageLoader label="Cargando notas…" />
      ) : notes.isError ? (
        <p className="p-6 text-center text-sm text-red-600">{errorMessage(notes.error, 'No se pudieron cargar las notas.')}</p>
      ) : (notes.data ?? []).length === 0 ? (
        <EmptyState className="m-5" icon={<StickyNote className="h-5 w-5" />} title="Sin notas"
          description="Apunta aquí lo que el resto del equipo debería saber de este negocio." />
      ) : (
        <>
          <ul className="divide-y divide-slate-100 border-t border-slate-100">
            {paged.slice.map((n) => (
              <li key={n.id} className="flex gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap break-words text-sm text-slate-800">{n.body}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    {fmtDateTime(n.created_at)} · {(n.author_id && authorEmail.get(n.author_id)) || 'ex super-admin'}
                  </p>
                </div>
                {/* La RLS solo deja borrar las propias: el botón no se ofrece en las ajenas. */}
                {n.author_id === user?.id && (
                  <Button variant="ghost" size="icon" className="shrink-0 text-red-600 hover:bg-red-50"
                    aria-label="Borrar nota" onClick={() => void del(n.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <Pagination {...paged.pager} label="notas" />
        </>
      )}
    </Card>
  )
}
