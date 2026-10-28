import { useRef } from 'react'
import { Paperclip, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/toast'
import { useOpenAttachment, useUploadAttachment, type AttachmentFolder } from '@/hooks/purchases'
import { errorMessage } from '@/lib/errors'

/**
 * Adjunto de un documento (factura del proveedor, recibo de un gasto). Sube en
 * cuanto se elige el archivo y devuelve la ruta; la fila se guarda después con
 * esa ruta. Si se cancela el documento, el archivo queda huérfano en la
 * carpeta del negocio: es el precio de no bloquear el formulario esperando la
 * subida al final.
 */
export function AttachmentField({
  folder,
  path,
  onChange,
  disabled,
}: {
  folder: AttachmentFolder
  path: string | null
  onChange: (path: string | null) => void
  disabled?: boolean
}) {
  const toast = useToast()
  const input = useRef<HTMLInputElement>(null)
  const upload = useUploadAttachment(folder)
  const openFile = useOpenAttachment()

  const onFile = async (file: File | undefined) => {
    if (!file) return
    try {
      onChange(await upload.mutateAsync(file))
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      if (input.current) input.current.value = ''
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        ref={input}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      {path ? (
        <>
          <Button
            type="button"
            size="sm"
            variant="outline"
            loading={openFile.isPending}
            onClick={() => openFile.mutate(path, { onError: (err) => toast.error(errorMessage(err)) })}
          >
            <Paperclip className="h-4 w-4" /> Ver adjunto
          </Button>
          {!disabled && (
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>
              <X className="h-4 w-4" /> Quitar
            </Button>
          )}
        </>
      ) : disabled ? (
        <span className="text-sm text-slate-400">Sin adjunto</span>
      ) : (
        <Button type="button" size="sm" variant="outline" loading={upload.isPending} onClick={() => input.current?.click()}>
          <Paperclip className="h-4 w-4" /> Adjuntar foto o PDF
        </Button>
      )}
    </div>
  )
}
