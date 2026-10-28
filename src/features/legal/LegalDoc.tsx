import { useEffect, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Mail } from 'lucide-react'
import { Wordmark } from '@/components/Logo'
import { APP_NAME, LEGAL_CONTACT_EMAIL, LEGAL_PATHS } from '@/lib/constants'

/**
 * Armazón de las páginas legales públicas (Privacidad y Términos).
 *
 * Son páginas de TEXTO, no de app: una sola columna angosta, sin barra lateral y
 * sin sesión. Se sirven desde el router (`/#/privacidad`, `/#/terminos`) y
 * también desde las URL limpias `/privacidad` y `/terminos` (ver
 * `src/lib/cleanPaths.ts`), porque hay sitios —el formulario de un tercero, un
 * buscador— donde solo cabe una dirección sin fragmento.
 */

export interface LegalSection {
  id: string
  title: string
  body: ReactNode
}

export function LegalDoc({
  title,
  updated,
  lead,
  sections,
}: {
  title: string
  /** Fecha de la última revisión, ya escrita en letras. */
  updated: string
  /** Primer párrafo, en lenguaje llano, antes del índice. */
  lead: ReactNode
  sections: LegalSection[]
}) {
  // Título de la pestaña: estas páginas se abren solas (se pegan en un
  // formulario, se comparten por mensaje), así que el título genérico de la app
  // no basta para saber qué documento se está leyendo. Se restaura al salir para
  // no dejar el título de un documento legal colgado en el resto de la app.
  useEffect(() => {
    const previous = document.title
    document.title = `${title} — ${APP_NAME}`
    return () => {
      document.title = previous
    }
  }, [title])

  // Empezar arriba Y dejar arriba al salir. El router conserva la posición de
  // scroll entre rutas y estos documentos miden miles de píxeles: sin esto, ir
  // de un documento al otro aterriza a mitad del texto, y volver al inicio abre
  // la landing por el pie en vez de por el hero. Se limpia al desmontar para
  // cubrir cualquier salida (los enlaces del pie, el botón de atrás).
  useEffect(() => {
    window.scrollTo(0, 0)
    return () => window.scrollTo(0, 0)
  }, [title])

  return (
    <div className="min-h-[100dvh] bg-slate-50 font-sans text-brand-950">
      <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-slate-50/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link to="/" className="min-w-0" aria-label={`Ir al inicio de ${APP_NAME}`}>
            <Wordmark />
          </Link>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-semibold text-slate-500 transition-colors hover:text-brand-600"
          >
            <ArrowLeft className="h-4 w-4" />
            Inicio
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-16 pt-8 sm:px-6">
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">{title}</h1>
        <p className="mt-2 text-sm text-slate-500">Última actualización: {updated}</p>

        <div className="mt-6 rounded-2xl border border-brand-100 bg-brand-50 p-5 text-[15px] leading-relaxed text-brand-950">
          {lead}
        </div>

        <nav aria-label="Contenido" className="mt-8">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Contenido</h2>
          <ol className="mt-3 space-y-1">
            {sections.map((s, i) => (
              <li key={s.id}>
                {/* Botón, no <a href="#id">: con HashRouter el fragmento ES la
                    ruta, así que un ancla de verdad borraría /#/privacidad y la
                    página se caería a la landing. */}
                <button
                  type="button"
                  onClick={() =>
                    document
                      .getElementById(s.id)
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }
                  className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[15px] text-slate-600 transition-colors hover:bg-white hover:text-brand-600"
                >
                  <span className="w-5 shrink-0 text-right text-sm font-semibold text-slate-400">
                    {i + 1}.
                  </span>
                  <span className="flex-1">{s.title}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-10 space-y-10">
          {sections.map((s, i) => (
            // `scroll-mt-20` deja hueco para la cabecera pegajosa: sin él, el
            // título de la sección queda justo debajo de la barra.
            <section key={s.id} id={s.id} className="scroll-mt-20">
              <h2 className="flex items-baseline gap-2 text-xl font-bold tracking-tight sm:text-2xl">
                <span className="text-base font-extrabold text-brand-400">{i + 1}</span>
                <span>{s.title}</span>
              </h2>
              <div className="mt-3 space-y-3">{s.body}</div>
            </section>
          ))}
        </div>

        <div className="mt-12 rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
          <h2 className="flex items-center gap-2 font-bold">
            <Mail className="h-5 w-5 text-brand-600" />
            ¿Dudas sobre este documento?
          </h2>
          <p className="mt-1.5 text-[15px] text-slate-600">
            Escríbenos a <MailLink /> y te contestamos.
          </p>
        </div>
      </main>

      <footer className="bg-brand-950 py-10 text-white">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="text-sm text-white/50">
            © {new Date().getFullYear()} {APP_NAME}
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <Link to="/" className="text-white/60 transition-colors hover:text-accent-400">
              Inicio
            </Link>
            <Link
              to={LEGAL_PATHS.privacy}
              className="text-white/60 transition-colors hover:text-accent-400"
            >
              Política de Privacidad
            </Link>
            <Link
              to={LEGAL_PATHS.terms}
              className="text-white/60 transition-colors hover:text-accent-400"
            >
              Términos del Servicio
            </Link>
          </div>
        </div>
      </footer>
    </div>
  )
}

/* ── Tipografía del documento ───────────────────────────────────────────────
   `break-words` en todas partes a propósito: los correos y las URL largas son
   lo único que puede provocar scroll horizontal en un teléfono de 360px. */

export function P({ children }: { children: ReactNode }) {
  return <p className="break-words text-[15px] leading-relaxed text-slate-600">{children}</p>
}

/** Subtítulo dentro de una sección. */
export function H3({ children }: { children: ReactNode }) {
  return <h3 className="pt-2 font-bold text-brand-950">{children}</h3>
}

export function Bullets({ children }: { children: ReactNode }) {
  return <ul className="space-y-2 pl-1">{children}</ul>
}

export function Li({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2.5 break-words text-[15px] leading-relaxed text-slate-600">
      {/* Viñeta dibujada, no `list-disc`: con `flex` el texto de la segunda línea
          se alinea con el de la primera en vez de meterse debajo del punto. */}
      <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-300" />
      <span className="flex-1">{children}</span>
    </li>
  )
}

/** Aviso destacado: lo que no se puede pasar por alto. */
export function Note({
  children,
  tone = 'accent',
}: {
  children: ReactNode
  tone?: 'accent' | 'brand'
}) {
  const tones = {
    accent: 'border-accent-200 bg-accent-50 text-accent-900',
    brand: 'border-brand-100 bg-brand-50 text-brand-950',
  }
  return (
    <div className={`rounded-2xl border p-4 text-[15px] leading-relaxed ${tones[tone]}`}>
      {children}
    </div>
  )
}

/**
 * Hueco que quien adopta el starter TIENE que rellenar (razón social, domicilio,
 * país…). Se pinta en amarillo chillón a propósito: un documento legal a medias
 * publicado sin darse cuenta es peor que no tenerlo, así que el marcador tiene
 * que doler a la vista en la propia página, no solo en el código.
 */
export function Todo({ children }: { children: ReactNode }) {
  return (
    <mark className="rounded bg-accent-200 px-1.5 py-0.5 font-semibold text-accent-900">
      [COMPLETAR: {children}]
    </mark>
  )
}

/**
 * Enlace a un correo. Lleva `break-words` (y no `break-all`): en un teléfono el
 * navegador mueve el correo entero a la línea siguiente y solo lo parte si de
 * verdad no cabe, en vez de cortarlo siempre a mitad de palabra.
 */
export function MailLink({ email = LEGAL_CONTACT_EMAIL }: { email?: string }) {
  return (
    <a
      href={`mailto:${email}`}
      className="break-words font-semibold text-brand-600 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
    >
      {email}
    </a>
  )
}

/** Enlace interno entre los dos documentos legales. */
export function DocLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="font-semibold text-brand-600 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
    >
      {children}
    </Link>
  )
}
