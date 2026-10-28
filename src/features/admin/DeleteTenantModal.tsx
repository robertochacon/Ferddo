import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { PageLoader } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast'
import { errorMessage } from '@/lib/errors'
// `norm` es el gemelo EXACTO de `norm_name()` (migración 0011): mismo trim, mismo
// colapso de espacios —el duro U+00A0 incluido, que es el que pega cualquiera al
// copiar un nombre desde un chat— y mismas minúsculas. Vive en @/lib/format y no
// aquí porque las dos puntas tienen que normalizar igual: si divergieran, la UI
// habilitaría el botón y el servidor respondería «el nombre no coincide»
// señalando un carácter invisible, y no habría forma de escribirlo bien nunca.
import { norm, num } from '@/lib/format'
import { useAdminDeleteTenant, useAdminTenantPurgePreview } from '@/hooks/admin'
import type { AdminTenantPurgePreview } from '@/types/db'

/**
 * Borrado en cascada de un negocio. Lo usan la lista de /admin y el detalle.
 *
 * Tres frenos, porque no hay vuelta atrás:
 *   1) Enseña qué se va a borrar, con conteos frescos del servidor (no de la
 *      caché). Sin vista previa NO se borra.
 *   2) Obliga a escribir el nombre del negocio; el servidor lo revalida.
 *   3) Las cuentas de acceso solo se borran si se marca la casilla.
 */
export function DeleteTenantModal({
  tenantId,
  tenantName,
  onClose,
  onDeleted,
}: {
  tenantId: string | null
  /** Nombre ya conocido, para que el título no espere a la vista previa. */
  tenantName?: string | null
  onClose: () => void
  onDeleted?: () => void
}) {
  const toast = useToast()
  const preview = useAdminTenantPurgePreview(tenantId ?? undefined)
  const purge = useAdminDeleteTenant()
  const [confirm, setConfirm] = useState('')
  const [deleteUsers, setDeleteUsers] = useState(false)

  // Al cambiar de negocio (o al cerrar) se limpian los dos controles peligrosos:
  // si no, el nombre tecleado para uno podría quedar validando el siguiente.
  useEffect(() => {
    setConfirm('')
    setDeleteUsers(false)
  }, [tenantId])

  const p = preview.data
  // Miembros (activos o no) que tiene el negocio: decide si se ofrece borrar
  // también las cuentas de acceso.
  const members = Number(p?.counts?.tenant_members ?? 0)
  const name = p?.name ?? tenantName ?? ''
  // Dos condiciones que parecen de más y no lo son:
  //   • `p`: sin vista previa no se borra. Sin conexión la consulta se queda en
  //     `paused` —ni cargando ni con error—, así que el modal se pintaba con el
  //     nombre de la fila y el botón se habilitaba al teclearlo: se borraría a
  //     ciegas, sin haber visto un solo conteo.
  //   • `target !== ''`: con un negocio cuyo nombre se quedó en blanco, la
  //     casilla vacía «coincidiría» y el botón rojo saldría habilitado de
  //     entrada. (La RPC también lo rechaza; aquí se dice por qué.)
  const target = norm(name)
  const canDelete = Boolean(p) && target !== '' && norm(confirm) === target && !purge.isPending

  const run = async () => {
    if (!tenantId || !canDelete) return
    try {
      const res = await purge.mutateAsync({ tenant: tenantId, confirmName: confirm, deleteUsers })
      // `files` cuenta objetos de Storage y `auth_users` puede venir en -1
      // (la base sin privilegio): ninguno de los dos es una fila borrada.
      const counts: Record<string, number> = res.counts ?? {}
      const rows = Object.entries(counts)
        .filter(([table]) => table !== 'files' && table !== 'auth_users')
        .reduce((sum, [, n]) => sum + Math.max(0, n), 0)
      const files = res.files_unknown
        ? 'no se pudo comprobar el almacenamiento'
        : `${num(res.files_removed)} archivo(s) borrado(s), ${num(res.files_pending ?? 0)} pendiente(s)`
      toast.success(`"${res.name}" eliminado: ${num(rows)} registros · ${files}.`)

      // Los datos ya no están, pero estos archivos siguen en el bucket bajo la
      // carpeta con el id del negocio. Se dice cuántos y dónde limpiarlos: un
      // «reintentar» no existe, porque ya no hay negocio al que volver.
      if (res.files_unknown) {
        toast.error(`Revisa Supabase → Storage, carpeta ${res.tenant_id}: no se pudo leer el almacenamiento.`)
      } else if ((res.files_pending ?? 0) > 0) {
        toast.error(`Quedaron ${num(res.files_pending ?? 0)} archivo(s) en el almacenamiento. Bórralos desde Supabase → Storage, carpeta ${res.tenant_id}.`)
      }
      // -1 = la base no pudo tocar `auth.users` (privilegios). El negocio ya no
      // está, pero esas cuentas siguen pudiendo entrar (a un onboarding vacío).
      if (counts.auth_users === -1) {
        toast.error('No se pudieron eliminar las cuentas de acceso: bórralas desde Supabase → Authentication.')
      }
      onClose()
      onDeleted?.()
    } catch (err) {
      // Un «no se pudo eliminar» a secas puede ser mentira: si la petición se
      // cortó DESPUÉS del commit, el negocio sí se borró. Los errores de
      // PostgREST traen `code`; un fallo de red es un TypeError sin `code`.
      const code = (err as { code?: string } | null)?.code
      if (code === '57014') {
        // Timeout de sentencia: Postgres cancela y revierte. No se borró nada.
        toast.error('El borrado tardó demasiado y se canceló: no se borró nada. Inténtalo de nuevo.')
      } else if (code) {
        toast.error(errorMessage(err, 'No se pudo eliminar el negocio.'))
      } else {
        toast.error('Se perdió la conexión y no se pudo confirmar si el negocio se eliminó. Actualiza el panel para verlo.')
      }
    }
  }

  return (
    <Modal
      open={Boolean(tenantId)}
      // Cerrar a mitad de un borrado dejaría la mutación en el aire y sin nadie
      // que lea su resultado: mientras corre, el diálogo no se cierra.
      onClose={purge.isPending ? () => {} : onClose}
      title={name ? `Eliminar "${name}"` : 'Eliminar negocio'}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={purge.isPending}>Cancelar</Button>
          <Button variant="danger" onClick={run} disabled={!canDelete} loading={purge.isPending}>
            <Trash2 className="h-4 w-4" /> Eliminar definitivamente
          </Button>
        </>
      }
    >
      {preview.isPaused ? (
        // Sin conexión la consulta queda en pausa: hay que decirlo, porque el
        // botón se queda deshabilitado y sin explicación parece un error.
        <Note>
          Sin conexión no se puede eliminar un negocio: hace falta leer primero qué se va a borrar.
          Reconéctate y vuelve a intentarlo.
        </Note>
      ) : preview.isLoading ? (
        <PageLoader label="Contando lo que se va a borrar…" />
      ) : preview.isError ? (
        <div className="space-y-3">
          <p className="text-sm text-red-600">{errorMessage(preview.error, 'No se pudo leer el negocio.')}</p>
          <Button variant="outline" size="sm" onClick={() => preview.refetch()}>Volver a intentar</Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex gap-3 rounded-xl border border-red-200 bg-red-50 p-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" />
            <div className="min-w-0 text-sm text-red-800">
              <p className="font-semibold">Esto no se puede deshacer.</p>
              <p className="mt-0.5 text-red-700">
                Se borra el negocio con sus sucursales, productos, inventario, ventas, caja,
                comprobantes electrónicos, compras, gastos, bitácora, invitaciones y archivos.
                La app no guarda ninguna copia.
              </p>
            </div>
          </div>

          {p && <PurgeCounts p={p} />}

          {p && members > 0 && (
            <label className="flex cursor-pointer gap-3 rounded-xl border border-slate-200 p-3">
              <input
                type="checkbox"
                checked={deleteUsers}
                onChange={(e) => setDeleteUsers(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-red-600 focus:ring-red-500"
              />
              <span className="text-sm">
                <span className="font-medium text-slate-800">
                  Eliminar también {members === 1 ? 'la cuenta de acceso' : `las ${members} cuentas de acceso`}
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  Sin marcar, {members === 1 ? 'esa persona conserva' : 'esas personas conservan'} su
                  correo y contraseña y {members === 1 ? 'puede' : 'pueden'} crear otro negocio o
                  unirse a uno. Marcado, se borra la cuenta entera y ya no {members === 1 ? 'podrá' : 'podrán'} entrar.
                  Las cuentas que también pertenecen a otra empresa se conservan siempre.
                </span>
              </span>
            </label>
          )}

          {target === '' ? (
            <Note>
              Este negocio no tiene nombre, así que no hay nada que escribir para confirmar. Ponle
              uno en su Configuración y vuelve: la confirmación es lo único que evita borrar el
              negocio equivocado.
            </Note>
          ) : (
            <div>
              <label htmlFor="confirm-tenant" className="mb-1.5 block text-sm font-medium text-slate-700">
                Escribe <span className="font-mono font-semibold text-slate-900">{name}</span> para confirmar
              </label>
              <Input
                id="confirm-tenant"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={name}
                autoComplete="off"
                spellCheck={false}
                aria-label={`Escribe ${name} para confirmar`}
              />
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

/** Nombre legible de cada tabla que cuenta `admin_tenant_purge_preview` (0018). */
const TABLE_LABEL: Record<string, string> = {
  tenant_members: 'Usuarios',
  branches: 'Sucursales',
  products: 'Productos',
  customers: 'Clientes',
  sales: 'Ventas',
  electronic_invoices: 'Comprobantes e-CF',
  purchases: 'Compras',
  expenses: 'Gastos',
  audit_logs: 'Bitácora',
}

/**
 * Lo que se va a borrar, contado por el servidor en el momento de abrir. Se
 * recorre lo que LLEGA (no una lista fija): si la RPC empieza a contar otra
 * tabla, aparece aquí sin tocar el código, aunque sea con su nombre técnico.
 */
function PurgeCounts({ p }: { p: AdminTenantPurgePreview }) {
  const items = Object.entries(p.counts ?? {}).map(([table, n]) => ({
    label: TABLE_LABEL[table] ?? table,
    value: num(Number(n)),
  }))
  // `null` / negativo = no se pudo contar (sin privilegio sobre Storage), que
  // NO es lo mismo que cero: por eso se pinta un guion y no un 0.
  items.push({ label: 'Archivos', value: p.files == null || p.files < 0 ? '—' : num(p.files) })
  return (
    <div className="rounded-xl border border-slate-200">
      <p className="border-b border-slate-100 px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
        Se va a borrar
      </p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 p-3 sm:grid-cols-4">
        {items.map((it) => (
          <div key={it.label} className="min-w-0">
            <dt className="truncate text-xs text-slate-500">{it.label}</dt>
            <dd className="truncate text-sm font-semibold tabular-nums text-slate-800">{it.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/**
 * Aviso de «esto no se puede hacer ahora mismo». Las clases van escritas
 * enteras, sin interpolar el color: Tailwind rastrea el código buscando nombres
 * de clase completos y un `border-${tone}-200` no llegaría nunca a la hoja.
 */
function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
      <p className="min-w-0">{children}</p>
    </div>
  )
}
