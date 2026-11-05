import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LogIn } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/Button'
import { Field, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/toast'
import { errorMessage } from '@/lib/errors'

/**
 * Confirmación para entrar a un negocio como gestor (admin_enter_tenant, 0028).
 *
 * El motivo es obligatorio porque es lo que el dueño verá en su Equipo y lo que
 * queda en las dos bitácoras: «revisar» no le dice nada a nadie dentro de un mes.
 * El mínimo de 5 caracteres lo exige la base; aquí solo se avisa antes.
 */
export function EnterSupportModal({
  tenant,
  onClose,
}: {
  tenant: { id: string; name: string } | null
  onClose: () => void
}) {
  const { enterSupport } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  // Cada negocio empieza con el motivo en blanco: arrastrar el anterior haría
  // registrar en este negocio el motivo de otro.
  useEffect(() => setReason(''), [tenant?.id])

  const enter = async () => {
    if (!tenant) return
    setBusy(true)
    try {
      await enterSupport(tenant.id, reason.trim())
      toast.success(`Estás dentro de ${tenant.name} como administrador.`)
      navigate('/')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo entrar al negocio.'))
      setBusy(false)
    }
  }

  return (
    <Modal
      open={Boolean(tenant)}
      onClose={onClose}
      title={tenant ? `Entrar a ${tenant.name}` : 'Entrar como gestor'}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button onClick={() => void enter()} loading={busy} disabled={reason.trim().length < 5}>
            <LogIn className="h-4 w-4" /> Entrar como gestor
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
          <li>Entras con el rol <b>Administrador</b>: ves y operas el negocio como lo haría su encargado.</li>
          <li>El acceso dura <b>2 horas</b> y se cierra solo. Puedes salir antes desde la franja superior.</li>
          <li>Queda registrado con tu correo y el motivo, y el dueño lo ve en su Equipo, desde donde puede cortarlo.</li>
        </ul>
        <Field label="Motivo del acceso" required hint="Lo verá el dueño del negocio.">
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={300}
            placeholder="Ej. El dueño reporta que no puede cerrar la caja."
            autoFocus
          />
        </Field>
      </div>
    </Modal>
  )
}
