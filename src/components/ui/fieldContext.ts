import { createContext, useContext, type AriaAttributes } from 'react'

/**
 * Lo que un <Field> le dice al control que lleva dentro: con qué `id` lo nombra
 * su etiqueta y qué texto lo describe (la pista o el error).
 *
 * Va por contexto y no clonando `children` porque el control casi nunca es el
 * hijo directo: suele ir envuelto con un icono delante (`<div className="relative">
 * <Icon/><Input/></div>`). Así Input, Textarea y Select se asocian solos, sin
 * que cada formulario tenga que inventar ids.
 */
export interface FieldControl {
  id: string
  describedBy?: string
  invalid: boolean
  required: boolean
}

export const FieldContext = createContext<FieldControl | null>(null)

type ControlProps = { id?: string } & Pick<AriaAttributes, 'aria-describedby' | 'aria-invalid' | 'aria-required'>

/**
 * Mezcla en las props de una primitiva lo que aporta su <Field>. Un control con
 * un `id` PROPIO distinto se queda fuera: es la salida para el campo extra que
 * comparte Field con otro (un filtro encima de un desplegable), que de otro
 * modo duplicaría el id.
 */
export function useFieldControl<P extends ControlProps>(props: P): P {
  const field = useContext(FieldContext)
  if (!field || (props.id && props.id !== field.id)) return props
  const describedBy = [props['aria-describedby'], field.describedBy].filter(Boolean).join(' ') || undefined
  return {
    ...props,
    id: field.id,
    'aria-describedby': describedBy,
    'aria-invalid': props['aria-invalid'] ?? (field.invalid || undefined),
    // aria-required y no `required`: el atributo nativo activaría la validación
    // del navegador en formularios que validan a su manera.
    'aria-required': props['aria-required'] ?? (field.required || undefined),
  }
}
