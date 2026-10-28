import { clsx, type ClassValue } from 'clsx'

/**
 * Une clases condicionalmente (envoltorio de clsx).
 *
 * OJO: es clsx a secas, SIN tailwind-merge. Dos clases del mismo eje
 * (`h-4 w-4` y `h-8 w-8`) acaban las dos en el DOM y gana la que Tailwind emita
 * más tarde en su hoja, que es el orden de su escala y no el orden en que se
 * pasan. Por eso las primitivas de UI eligen tamaño/variante con un objeto de
 * lookup y no dejan que `className` los pise.
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs)
}
