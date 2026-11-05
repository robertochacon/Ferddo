// Casillas del paginador: lo que se ve bajo cada listado.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageItems } from './pageItems.ts'

/** Como se lee en pantalla: páginas desde 1 y «…» para los saltos. */
const view = (page: number, pages: number, slots: number) =>
  pageItems(page, pages, slots)
    .map((it) => (typeof it === 'number' ? String(it + 1) : '…'))
    .join(' ')

test('pocas páginas: todas, sin saltos', () => {
  assert.equal(view(0, 1, 7), '1')
  assert.equal(view(2, 7, 7), '1 2 3 4 5 6 7')
  assert.equal(view(0, 5, 5), '1 2 3 4 5')
})

test('7 casillas (escritorio), 25 páginas', () => {
  assert.equal(view(0, 25, 7), '1 2 3 4 5 … 25')
  assert.equal(view(3, 25, 7), '1 2 3 4 5 … 25') // la 4 aún cabe sin «…» delante
  assert.equal(view(4, 25, 7), '1 … 4 5 6 … 25')
  assert.equal(view(9, 25, 7), '1 … 9 10 11 … 25')
  assert.equal(view(20, 25, 7), '1 … 20 21 22 … 25')
  assert.equal(view(21, 25, 7), '1 … 21 22 23 24 25')
  assert.equal(view(24, 25, 7), '1 … 21 22 23 24 25')
})

test('5 casillas (teléfono), 25 páginas', () => {
  assert.equal(view(0, 25, 5), '1 2 3 … 25')
  assert.equal(view(1, 25, 5), '1 2 3 … 25')
  assert.equal(view(9, 25, 5), '1 … 10 … 25')
  assert.equal(view(23, 25, 5), '1 … 23 24 25')
})

test('nunca más casillas que `slots` y la actual siempre visible', () => {
  for (const slots of [5, 7]) {
    for (let pages = 1; pages <= 40; pages++) {
      for (let page = 0; page < pages; page++) {
        const items = pageItems(page, pages, slots)
        assert.ok(items.length <= slots, `${page}/${pages}/${slots}: ${items.length} casillas`)
        assert.ok(items.includes(page), `${page}/${pages}/${slots}: falta la actual`)
        assert.equal(items[0], 0)
        assert.equal(items[items.length - 1], pages - 1)
      }
    }
  }
})
