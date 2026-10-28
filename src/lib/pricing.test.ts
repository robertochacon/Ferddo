// Pruebas del espejo de price_lines(). Sin dependencias: `npm test` usa el
// runner nativo de Node (que ya entiende TypeScript).
// Los casos esperados son los mismos que comprueba supabase/tests/erp_integration.sql
// contra la base, así el cálculo del cliente y el del servidor no divergen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { priceLines } from './pricing.ts'

test('ITBIS incluido: 2 × 118 → base 200, ITBIS 36', () => {
  const r = priceLines([{ quantity: 2, unit_price: 118, tax_rate: 0.18 }], 0, true)
  assert.equal(r.total, 236)
  assert.equal(r.subtotal, 200)
  assert.equal(r.tax_total, 36)
})

test('servicio exento sumado a un producto gravado', () => {
  const r = priceLines(
    [
      { quantity: 2, unit_price: 118, tax_rate: 0.18 },
      { quantity: 1, unit_price: 500, tax_rate: 0 },
    ],
    0,
    true,
  )
  assert.equal(r.total, 736)
  assert.equal(r.tax_total, 36)
})

test('ITBIS excluido: se suma encima', () => {
  const r = priceLines([{ quantity: 3, unit_price: 100, tax_rate: 0.18 }], 0, false)
  assert.equal(r.subtotal, 300)
  assert.equal(r.tax_total, 54)
  assert.equal(r.total, 354)
})

test('descuento general repartido; la última línea se lleva el residuo', () => {
  const r = priceLines(
    [
      { quantity: 1, unit_price: 100, tax_rate: 0.18 },
      { quantity: 1, unit_price: 100, tax_rate: 0.18 },
      { quantity: 1, unit_price: 100, tax_rate: 0.18 },
    ],
    10,
    true,
  )
  assert.equal(r.discount_total, 10)
  assert.equal(r.total, 290)
  assert.deepEqual(
    r.lines.map((l) => l.discount),
    [3.33, 3.33, 3.34],
  )
})

test('descuento general de 18 sobre 118 → total 100', () => {
  const r = priceLines([{ quantity: 1, unit_price: 118, tax_rate: 0.18 }], 18, true)
  assert.equal(r.total, 100)
})

test('cantidades fraccionarias (libras) sin errores de coma flotante', () => {
  const r = priceLines([{ quantity: 1.5, unit_price: 45.5, tax_rate: 0.16 }], 0, true)
  assert.equal(r.total, 68.25)
  assert.equal(r.subtotal + r.tax_total, r.total)
})
