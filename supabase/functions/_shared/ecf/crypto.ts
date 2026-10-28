// ═══════════════════════════════════════════════════════════════════════════
// Ferddo · Cifrado de secretos fiscales (AES-256-GCM)
//
// Los certificados y credenciales se guardan en `fiscal_secrets` CIFRADOS con
// una clave que vive en `supabase secrets` (FISCAL_ENC_KEY, 32 bytes en
// base64), nunca en la base: quien robe un volcado de Postgres se lleva texto
// cifrado sin la llave. GCM autentica además el contenido, así que un
// ciphertext manipulado falla al descifrar en vez de entregar basura.
//
// Nunca se registra (console.*) ni el texto claro ni la clave. Los mensajes de
// error de este módulo no incluyen datos del secreto.
// ═══════════════════════════════════════════════════════════════════════════

/** Versión de la clave con la que se cifró (fiscal_secrets.key_version). */
export const KEY_VERSION = 1

export class CryptoConfigError extends Error {}

function b64encode(bytes: Uint8Array): string {
  let bin = ''
  // Por trozos: String.fromCharCode(...bytes) revienta la pila con un
  // certificado de varios KB.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

// Devuelve un ArrayBuffer (y no un Uint8Array) porque es lo que WebCrypto
// acepta sin ambigüedad en todas las versiones de los tipos de Deno.
function b64decode(text: string): ArrayBuffer {
  const bin = atob(text)
  const buf = new ArrayBuffer(bin.length)
  const out = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return buf
}

let keyPromise: Promise<CryptoKey> | null = null

function loadKey(): Promise<CryptoKey> {
  if (keyPromise) return keyPromise
  const raw = Deno.env.get('FISCAL_ENC_KEY') ?? ''
  if (!raw) {
    return Promise.reject(new CryptoConfigError('FISCAL_ENC_KEY no está configurada en los secretos de la función.'))
  }
  let bytes: ArrayBuffer
  try {
    bytes = b64decode(raw.trim())
  } catch {
    return Promise.reject(new CryptoConfigError('FISCAL_ENC_KEY no es base64 válido.'))
  }
  if (bytes.byteLength !== 32) {
    return Promise.reject(new CryptoConfigError('FISCAL_ENC_KEY debe tener 32 bytes (base64 de 44 caracteres).'))
  }
  keyPromise = crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  // Si la importación falla, no se cachea el rechazo para siempre.
  keyPromise.catch(() => {
    keyPromise = null
  })
  return keyPromise
}

/** true si la clave existe y tiene el tamaño correcto (sin exponerla). */
export async function hasValidKey(): Promise<boolean> {
  try {
    await loadKey()
    return true
  } catch {
    return false
  }
}

export interface Encrypted {
  ciphertext: string
  iv: string
  key_version: number
}

export async function encryptSecret(plaintext: string): Promise<Encrypted> {
  const key = await loadKey()
  // IV aleatorio de 96 bits por cada cifrado: reutilizar un IV con la misma
  // clave rompe la confidencialidad de GCM.
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  return { ciphertext: b64encode(new Uint8Array(data)), iv: b64encode(iv), key_version: KEY_VERSION }
}

export async function decryptSecret(enc: { ciphertext: string; iv: string }): Promise<string> {
  const key = await loadKey()
  try {
    const data = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64decode(enc.iv) },
      key,
      b64decode(enc.ciphertext),
    )
    return new TextDecoder().decode(data)
  } catch {
    // Mensaje genérico a propósito: ni el ciphertext ni detalles de la clave.
    throw new CryptoConfigError('No se pudo descifrar el secreto fiscal (¿cambió FISCAL_ENC_KEY?).')
  }
}
