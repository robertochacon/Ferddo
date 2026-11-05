// Casillas del paginador (src/components/ui/Pagination.tsx). Va aparte, sin
// React, para poder probarla con el runner nativo de Node (pageItems.test.ts).

export type PageItem = number | 'gap-start' | 'gap-end'

/**
 * Qué casillas pintar: siempre la primera y la última, la actual con sus
 * vecinas, y «…» donde se salta. `slots` es el total de casillas (impar, ≥ 5)
 * y el resultado nunca lo excede, así el paginador no cambia de ancho al
 * avanzar. Ej. con 7: 1 2 3 4 5 … 25 · 1 … 9 10 11 … 25 · 1 … 21 22 23 24 25.
 */
export function pageItems(page: number, pages: number, slots: number): PageItem[] {
  if (pages <= slots) return Array.from({ length: pages }, (_, i) => i)
  const inner = slots - 2 // casillas entre la primera y la última
  const last = pages - 1
  // Cerca de un extremo no hace falta el «…» de ese lado: se aprovecha la casilla.
  if (page < inner - 1) return [...Array.from({ length: inner }, (_, i) => i), 'gap-end', last]
  if (page > last - (inner - 1)) return [0, 'gap-start', ...Array.from({ length: inner }, (_, i) => last - inner + 1 + i)]
  const side = (inner - 3) / 2 // vecinas a cada lado de la actual
  return [0, 'gap-start', ...Array.from({ length: inner - 2 }, (_, i) => page - side + i), 'gap-end', last]
}
