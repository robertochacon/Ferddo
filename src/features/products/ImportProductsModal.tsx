import { useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, FileUp } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { useToast } from '@/components/ui/toast'
import { IMPORT_COLUMNS, useImportProducts, type ImportResult, type ImportRow } from '@/hooks/products'
import { downloadCsv, parseCsv, toCsv } from '@/lib/csv'
import { errorMessage } from '@/lib/errors'
import { num } from '@/lib/format'
import { parseDecimal } from './catalog'

const MAX_ROWS = 5000
const PREVIEW_ROWS = 15

/** Qué significa cada columna de la plantilla (se enseña en el diálogo). */
const COLUMN_HELP: Record<(typeof IMPORT_COLUMNS)[number], string> = {
  name: 'Nombre (obligatorio)',
  sku: 'SKU; si ya existe, se actualiza ese producto',
  barcode: 'Código de barras; también identifica al existente',
  code: 'Código interno',
  description: 'Descripción',
  category: 'Categoría (se crea si no existe)',
  brand: 'Marca',
  unit: 'Unidad (unidad, libra, kg…)',
  cost: 'Costo',
  price: 'Precio de venta',
  tax_code: 'ITBIS18, ITBIS16 o EXENTO (vacío = el predeterminado)',
  kind: 'producto o servicio',
  track_stock: 'sí / no (controla existencia)',
  min_stock: 'Existencia mínima',
  stock: 'Existencia inicial (solo productos nuevos, sucursal principal)',
}

const NUMERIC: ReadonlySet<string> = new Set(['cost', 'price', 'min_stock', 'stock'])

const YES = new Set(['si', 'sí', 's', 'yes', 'y', 'true', '1', 'x', 'verdadero'])
const NO = new Set(['no', 'n', 'false', '0', 'falso'])
const KIND_ALIAS: Record<string, 'product' | 'service'> = {
  product: 'product',
  producto: 'product',
  service: 'service',
  servicio: 'service',
}

interface ParsedRow {
  row: ImportRow
  /** Problemas detectados aquí; la base vuelve a validar todo igual. */
  issues: string[]
}

/**
 * Normaliza una fila del CSV a lo que entiende import_products(). Los casts de
 * la base (`::numeric`, `::boolean`, `::product_kind`) revientan con "1,50",
 * "sí" o "servicio", que es justo como lo escribe la gente: se traducen aquí.
 */
function normalize(raw: Record<string, string>): ParsedRow {
  const row: ImportRow = {}
  const issues: string[] = []
  for (const col of IMPORT_COLUMNS) {
    const v = (raw[col] ?? '').trim()
    if (v === '') continue
    if (NUMERIC.has(col)) {
      const n = parseDecimal(v)
      if (n === null || Number.isNaN(n) || n < 0) issues.push(`${col}: "${v}" no es un número válido`)
      else row[col] = String(n)
    } else if (col === 'track_stock') {
      const k = v.toLowerCase()
      if (YES.has(k)) row.track_stock = 'true'
      else if (NO.has(k)) row.track_stock = 'false'
      else issues.push(`track_stock: "${v}" debe ser sí o no`)
    } else if (col === 'kind') {
      const k = KIND_ALIAS[v.toLowerCase()]
      if (k) row.kind = k
      else issues.push(`kind: "${v}" debe ser producto o servicio`)
    } else if (col === 'tax_code') {
      row.tax_code = v.toUpperCase()
    } else {
      row[col] = v
    }
  }
  if (!row.name) issues.push('Falta el nombre')
  return { row, issues }
}

/**
 * Importación de catálogo por CSV: plantilla → vista previa → importar → resultado.
 * La base inserta o actualiza por SKU/código de barras y devuelve los errores
 * fila a fila sin abortar el archivo entero.
 */
export function ImportProductsModal({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const importer = useImportProducts()
  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [rows, setRows] = useState<ParsedRow[]>([])
  const [missingName, setMissingName] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)

  const downloadTemplate = () => downloadCsv('plantilla-productos', toCsv([], IMPORT_COLUMNS.map((c) => ({ key: c, label: c }))))

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setResult(null)
    try {
      const parsed = parseCsv(await file.text())
      setFileName(file.name)
      // parseCsv ya pasa los encabezados a minúsculas.
      setMissingName(parsed.length > 0 && !('name' in parsed[0]))
      setRows(parsed.map(normalize))
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo leer el archivo'))
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const withIssues = rows.filter((r) => r.issues.length > 0).length
  const tooMany = rows.length > MAX_ROWS
  const canImport = rows.length > 0 && !missingName && !tooMany && !importer.isPending

  const runImport = async () => {
    try {
      // Se mandan TODAS las filas (también las que tienen avisos) para que el
      // número de fila del resultado coincida con el del archivo; la base
      // rechaza las malas una a una sin tumbar las demás.
      const res = await importer.mutateAsync(rows.map((r) => r.row))
      setResult(res)
      if (res.errors.length === 0) toast.success('Importación completada')
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo importar'))
    }
  }

  const reset = () => {
    setRows([])
    setFileName(null)
    setResult(null)
    setMissingName(false)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Importar productos desde CSV"
      size="lg"
      footer={
        result ? (
          <>
            <Button variant="outline" onClick={reset}>
              Importar otro archivo
            </Button>
            <Button onClick={onClose}>Listo</Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose} disabled={importer.isPending}>
              Cancelar
            </Button>
            <Button onClick={() => void runImport()} disabled={!canImport} loading={importer.isPending}>
              Importar {rows.length > 0 ? num(rows.length) : ''} fila(s)
            </Button>
          </>
        )
      }
    >
      {result ? (
        <ImportResultView result={result} rows={rows} />
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
            <p>
              Usa la plantilla (Excel la abre y guarda como CSV). Si el SKU o el código de barras ya existe, se
              <strong> actualiza</strong> nombre, categoría, costo, precio, impuesto y mínimo; si no, se crea.
            </p>
            <details className="mt-2">
              <summary className="cursor-pointer font-medium text-slate-700">Ver columnas</summary>
              <ul className="mt-2 space-y-1 text-xs">
                {IMPORT_COLUMNS.map((c) => (
                  <li key={c}>
                    <code className="font-semibold text-slate-800">{c}</code> — {COLUMN_HELP[c]}
                  </li>
                ))}
              </ul>
            </details>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={downloadTemplate}>
              <Download className="h-4 w-4" /> Descargar plantilla
            </Button>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
            <Button variant="secondary" onClick={() => fileRef.current?.click()}>
              <FileUp className="h-4 w-4" /> {fileName ? 'Elegir otro archivo' : 'Elegir archivo CSV'}
            </Button>
          </div>

          {fileName && (
            <div className="space-y-3">
              <p className="text-sm text-slate-600">
                <span className="font-medium text-slate-800">{fileName}</span>: {num(rows.length)} fila(s)
                {withIssues > 0 && <span className="text-amber-700"> · {num(withIssues)} con avisos</span>}
              </p>
              {missingName && (
                <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
                  El archivo no tiene la columna <code>name</code>. Descarga la plantilla y copia tus datos en ella.
                </p>
              )}
              {tooMany && (
                <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
                  Máximo {num(MAX_ROWS)} filas por importación. Divide el archivo en partes.
                </p>
              )}
              {rows.length === 0 && <p className="text-sm text-slate-500">El archivo no tiene filas de datos.</p>}
              {rows.length > 0 && (
                // Vista previa como lista (no tabla): a 360 px una tabla de 15
                // columnas obligaría a arrastrar de lado.
                <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                  {rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                    <li key={i} className="p-3 text-sm">
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 truncate font-medium text-slate-800">
                          <span className="mr-1.5 text-xs text-slate-400">#{i + 1}</span>
                          {r.row.name ?? '(sin nombre)'}
                        </p>
                        <Badge tone={r.row.kind === 'service' ? 'brand' : 'slate'}>{r.row.kind === 'service' ? 'Servicio' : 'Producto'}</Badge>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-slate-500">
                        {[
                          r.row.sku && `SKU ${r.row.sku}`,
                          r.row.barcode && `CB ${r.row.barcode}`,
                          r.row.category,
                          r.row.price && `Precio ${r.row.price}`,
                          r.row.cost && `Costo ${r.row.cost}`,
                          r.row.stock && `Exist. ${r.row.stock}`,
                        ]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </p>
                      {r.issues.map((msg) => (
                        <p key={msg} className="mt-1 flex items-center gap-1 text-xs text-amber-700">
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {msg}
                        </p>
                      ))}
                    </li>
                  ))}
                  {rows.length > PREVIEW_ROWS && (
                    <li className="p-3 text-center text-xs text-slate-500">… y {num(rows.length - PREVIEW_ROWS)} fila(s) más</li>
                  )}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

function ImportResultView({ result, rows }: { result: ImportResult; rows: ParsedRow[] }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-emerald-50 p-3">
          <p className="text-xl font-bold text-emerald-700">{num(result.inserted)}</p>
          <p className="text-xs text-emerald-700">Creados</p>
        </div>
        <div className="rounded-xl bg-brand-50 p-3">
          <p className="text-xl font-bold text-brand-700">{num(result.updated)}</p>
          <p className="text-xs text-brand-700">Actualizados</p>
        </div>
        <div className="rounded-xl bg-red-50 p-3">
          <p className="text-xl font-bold text-red-700">{num(result.errors.length)}</p>
          <p className="text-xs text-red-700">Con error</p>
        </div>
      </div>
      {result.errors.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-emerald-700">
          <CheckCircle2 className="h-4 w-4" /> Todas las filas se procesaron.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {result.errors.map((e) => (
            <li key={e.row} className="p-3 text-sm">
              <p className="font-medium text-slate-800">
                Fila {e.row}
                {rows[e.row - 1]?.row.name && <span className="font-normal text-slate-500"> · {rows[e.row - 1].row.name}</span>}
              </p>
              <p className="text-xs text-red-600">{e.error}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
