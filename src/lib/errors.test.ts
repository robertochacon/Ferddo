// Pruebas de errorMessage(): lo que el usuario lee cuando algo falla.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { errorMessage, NETWORK_MESSAGE } from './errors.ts'

test('fallo de red de cada navegador → mensaje en español', () => {
  for (const raw of [
    'TypeError: Failed to fetch', // supabase-js (PostgrestError) en Chrome
    'Failed to fetch',
    'Load failed', // Safari
    'NetworkError when attempting to fetch resource.', // Firefox
  ]) {
    assert.equal(errorMessage({ message: raw }), NETWORK_MESSAGE, raw)
  }
  assert.equal(errorMessage(new TypeError('Failed to fetch')), NETWORK_MESSAGE)
})

test('marca técnica de la base → solo el texto amigable', () => {
  assert.equal(
    errorMessage({ message: 'PLAN_LIMIT_PRODUCTS: El plan Básico permite máximo 100 productos.' }),
    'El plan Básico permite máximo 100 productos.',
  )
})

test('mensaje normal y error vacío', () => {
  assert.equal(errorMessage({ message: 'Error de red: revisa la conexión' }), 'Error de red: revisa la conexión')
  assert.equal(errorMessage(null, 'No se pudo'), 'No se pudo')
})
