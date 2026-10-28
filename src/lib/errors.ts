/**
 * Extrae un mensaje legible de un error.
 *
 * Los errores de Supabase (PostgrestError) son objetos planos con `.message`,
 * NO instancias de `Error`, así que un `err instanceof Error ? err.message : …`
 * los pierde y acaba enseñando un genérico inútil. Esta función cubre los dos
 * casos.
 *
 * Además limpia la MARCA técnica de la convención que usan los triggers y las
 * RPC de la base: lanzan `MARCA: mensaje humano` y aquí se conserva solo el
 * mensaje (`PLAN_LIMIT_ITEMS: …`, `PLAN_LIMIT_MEMBERS: …`,
 * `CUENTA_SUSPENDIDA: …` → la frase amigable a secas). La marca existe para que
 * el código la pueda reconocer, no para enseñársela a nadie.
 *
 * Se recorta por PATRÓN y no por lista de marcas conocidas: cuando esto miraba
 * solo `PLAN_LIMIT`, la marca `CUENTA_SUSPENDIDA:` llegaba cruda al toast. Una
 * marca nueva en el SQL no debe obligar a tocar este archivo.
 */
export function errorMessage(err: unknown, fallback = 'Ocurrió un error'): string {
  let msg = fallback
  if (err instanceof Error && err.message) {
    msg = err.message
  } else if (
    err &&
    typeof err === 'object' &&
    'message' in err &&
    typeof (err as { message?: unknown }).message === 'string' &&
    (err as { message: string }).message
  ) {
    msg = (err as { message: string }).message
  }
  // El patrón es estrecho a propósito para no descabezar un mensaje legítimo:
  // la marca va al PRINCIPIO, solo A-Z 0-9 _, mínimo 3 caracteres y los dos
  // puntos PEGADOS. Así "Failed to fetch" o "Error de red: revisa la conexión"
  // pasan enteros, porque no son todo mayúsculas.
  // El grupo 2 se queda con TODO el resto (flag `s`, por si el mensaje trae
  // saltos de línea): el texto amigable puede llevar sus propios dos puntos y
  // cortarlo ahí lo dejaría a medias.
  const marked = msg.match(/^([A-Z][A-Z0-9_]{2,}):\s*(.+)$/s)
  if (marked) return marked[2].trim()
  return msg
}

/**
 * ¿El error es un choque de clave única (unique_violation)?
 *
 * Se usa donde una reinserción del MISMO id es en realidad un éxito: la cola
 * offline reintenta con un id generado en el cliente, así que un 23505 significa
 * "ya estaba subido", no "falló".
 */
export function isUniqueViolation(err: unknown): boolean {
  return Boolean(err) && (err as { code?: string }).code === '23505'
}
