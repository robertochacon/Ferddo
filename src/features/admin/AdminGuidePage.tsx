import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle, ArrowRight, BarChart3, BookOpen, Building2, CreditCard, FileCheck2, History, LifeBuoy,
  ShieldCheck, UserRound, type LucideIcon,
} from 'lucide-react'
import { Card, CardBody } from '@/components/ui/Card'
import { AdminShell } from './AdminShell'

/**
 * Guía de uso del panel de plataforma: qué hace cada módulo y cómo se usa.
 *
 * Es texto, a propósito, dentro de la app y no en un documento aparte: quien
 * administra la plataforma la tiene a un clic mientras trabaja, y cada sección
 * enlaza al módulo que explica. Si un módulo cambia, esta página cambia con él
 * (mismo commit).
 *
 * El índice desplaza con scrollIntoView y no con anclas `#`: con HashRouter un
 * `#seccion` se interpretaría como una ruta.
 */

interface GuideSection {
  id: string
  title: string
  icon: LucideIcon
  /** Para qué sirve, en una frase. */
  summary: string
  /** Pasos o puntos clave. */
  items: ReactNode[]
  /** Advertencia que conviene leer antes de usarlo. */
  caution?: ReactNode
  link?: { to: string; label: string }
}

const SECTIONS: GuideSection[] = [
  {
    id: 'resumen',
    title: 'Resumen',
    icon: BarChart3,
    summary: 'La foto de la plataforma de un vistazo y lo que pide atención hoy.',
    items: [
      <>Las tarjetas cuentan negocios, usuarios, sucursales, ventas y comprobantes de los últimos 30 días. Son <b>cantidades, no montos</b>: el panel no ve cuánto vende cada negocio.</>,
      <>«Por plan», «Por estado» y «Por tipo de negocio» muestran cómo se reparte la cartera.</>,
      <><b>Requieren atención</b>: pruebas que vencen en 7 días o menos, pruebas ya terminadas y cuentas con el pago vencido. Toca una fila para abrir la ficha de ese negocio.</>,
      <><b>Solicitudes de plan</b>: cuando un negocio pide cambiar de plan aparece aquí. «Aprobar» le cambia el plan en el acto; «Rechazar» la cierra sin tocar nada.</>,
    ],
    link: { to: '/admin', label: 'Ir al resumen' },
  },
  {
    id: 'negocios',
    title: 'Negocios',
    icon: Building2,
    summary: 'Todas las cuentas: buscarlas, revisarlas y actuar sobre ellas.',
    items: [
      <>Busca por nombre, RNC, dueño o correo, y filtra por plan, estado y tipo. «Quitar filtros» vuelve a la lista completa.</>,
      <>El menú <b>⋯</b> de cada fila reúne las acciones: ver detalle, entrar como gestor, usuarios, suscripción, suspender o reactivar, y eliminar.</>,
      <>La <b>ficha del negocio</b> muestra cifras de uso, su suscripción con el historial de cambios, su facturación electrónica, sus usuarios, las notas internas y la actividad del panel sobre ese negocio.</>,
      <><b>Usuarios</b>: cambia el rol de una persona, bloquéale el acceso (no podrá iniciar sesión en ninguna parte) o quítala solo de ese negocio. La base no deja a un negocio sin dueño.</>,
      <><b>Notas internas</b>: apunta llamadas, acuerdos o incidencias. Solo las ve el equipo de Ferddo, nunca el negocio; cada quien borra las suyas.</>,
      <><b>Suspender</b> deja el negocio en solo lectura: su equipo entra pero no puede crear ni cambiar nada. Se deshace con «Reactivar».</>,
    ],
    caution: (
      <><b>Eliminar un negocio no tiene vuelta atrás</b>: borra sus ventas, inventario, caja, comprobantes y archivos. Pide escribir su nombre para confirmar y, opcionalmente, borra también las cuentas de acceso de su gente. Si solo quieres cortarle el acceso, suspéndelo.</>
    ),
    link: { to: '/admin?s=negocios', label: 'Ir a negocios' },
  },
  {
    id: 'soporte',
    title: 'Entrar como gestor (soporte)',
    icon: LifeBuoy,
    summary: 'La única forma de ver un negocio por dentro, para ayudarle con su operación.',
    items: [
      <>Desde la lista (menú ⋯) o desde la ficha, pulsa <b>«Entrar como gestor»</b> y escribe el motivo. Es obligatorio: lo verá el dueño.</>,
      <>Entras con el rol <b>Administrador</b> durante <b>2 horas</b>. Ves y operas el negocio como lo haría su encargado, salvo lo reservado al dueño (como cambiar de plan).</>,
      <>Una franja amarilla arriba recuerda dónde estás y cuánto queda. «Salir al panel» te devuelve; al llegar a cero sales solo.</>,
      <>El dueño ve tu acceso en su Equipo, con el motivo y la hora de fin, y puede cortarlo cuando quiera. No le ocupa una plaza de su plan.</>,
      <>Entrar, salir y los cortes quedan en la bitácora del negocio y en la del panel.</>,
    ],
    caution: <>Estás tocando datos reales de un cliente. Sal en cuanto termines y no hagas cambios que el dueño no haya pedido.</>,
    link: { to: '/admin?s=negocios', label: 'Elegir un negocio' },
  },
  {
    id: 'planes',
    title: 'Planes y suscripciones',
    icon: CreditCard,
    summary: 'Qué se vende, a qué precio y con qué topes; y el plan de cada negocio.',
    items: [
      <>En <b>Planes</b> editas nombre, precio en RD$ (el que se anuncia) y en US$, topes (productos, usuarios, sucursales, cajas, comprobantes al mes), módulos incluidos y las características que se leen en la página pública.</>,
      <>Un tope vacío o marcado como ilimitado no limita. Bajar un tope no borra nada: el negocio que ya lo pasa no puede crear más hasta bajar de él.</>,
      <>Un negocio usa un módulo solo si está en su plan <b>y</b> lo tiene encendido en su Configuración.</>,
      <>La <b>suscripción</b> de cada negocio (menú ⋯ o ficha) cambia su plan, su estado (Prueba, Activo, Vencido, Cancelado) y las fechas de fin del periodo pagado y de la prueba. El cobro se coordina fuera de la app.</>,
    ],
    link: { to: '/admin?s=planes', label: 'Ir a planes' },
  },
  {
    id: 'facturacion',
    title: 'Facturación electrónica (e-CF)',
    icon: FileCheck2,
    summary: 'Los proveedores con los que los negocios envían sus comprobantes a la DGII.',
    items: [
      <><b>Catálogo y adaptador son dos cosas.</b> Aquí decides qué proveedores se ofrecen y qué datos pide cada uno. Para que un proveedor envíe de verdad hace falta su adaptador en la función <code>ecf</code>; cada fila te dice si la función desplegada lo trae.</>,
      <><b>Nuevo proveedor</b>: el código debe ser igual al del adaptador y no se cambia después. Define sus datos de configuración (no secretos, como un ID de emisor; puedes marcarlos obligatorios) y los nombres de sus credenciales.</>,
      <><b>Ofrecer a los negocios</b> lo hace elegible. Apagarlo no saca a quien ya lo usa. «Permite producción» es solo para proveedores autorizados por la DGII; un simulador nunca la permite.</>,
      <><b>Cambiar el proveedor de un negocio</b>: en su ficha, tarjeta «Facturación electrónica», botón «Cambiar». Pide motivo.</>,
      <><b>Migrar negocios</b>: menú ⋯ del proveedor. Pasa a todos sus negocios a otro proveedor de una vez; los que están en producción no se mueven a uno que no la permite.</>,
      <>Al cambiar de proveedor, los comprobantes <b>sin enviar</b> pasan al nuevo; los que <b>ya tiene</b> el anterior se quedan con él hasta que respondan. La configuración del proveedor anterior se descarta y el certificado del negocio se conserva.</>,
    ],
    caution: <>Un proveedor solo se puede eliminar si ningún negocio ni comprobante lo usa. Si ya se usó, desactívalo: su historial lo necesita.</>,
    link: { to: '/admin?s=facturacion', label: 'Ir a facturación e-CF' },
  },
  {
    id: 'bitacora',
    title: 'Bitácora',
    icon: History,
    summary: 'Quién hizo qué desde el panel, y cuándo.',
    items: [
      <>Registra cambios de suscripción y de planes, suspensiones, roles, bloqueos, altas y bajas de super-admins, proveedores de e-CF, negocios eliminados y accesos de soporte.</>,
      <>Filtra por tipo de acción o busca por negocio, autor o detalle. La ficha de cada negocio muestra su propia «Actividad del panel».</>,
      <>Se escribe sola desde la base de datos y nadie la puede editar. Sobrevive al borrado de un negocio: justo cuando más falta hace saber quién lo borró.</>,
      <>Lo que hace cada negocio por su cuenta no va aquí: va a su propia bitácora.</>,
    ],
    link: { to: '/admin?s=bitacora', label: 'Ir a la bitácora' },
  },
  {
    id: 'equipo',
    title: 'Super-admins',
    icon: ShieldCheck,
    summary: 'Las cuentas con acceso a este panel.',
    items: [
      <><b>Agregar</b>: escribe el correo de una cuenta que ya exista y que no pertenezca a ningún negocio; opcionalmente, su función (Soporte, Facturación…).</>,
      <><b>Editar</b> (lápiz): cambia su nombre y su función. El correo no se cambia aquí porque es su acceso.</>,
      <>La lista muestra el último acceso de cada uno: útil para retirar cuentas que ya no se usan.</>,
      <><b>Quitar</b> le retira el acceso al panel. Siempre queda al menos uno: la base rechaza quitar al último.</>,
    ],
    caution: <>Un super-admin puede borrar negocios enteros. Da este acceso solo a quien lo necesite y retíralo cuando deje de necesitarlo.</>,
    link: { to: '/admin?s=equipo', label: 'Ir a super-admins' },
  },
  {
    id: 'perfil',
    title: 'Mi perfil',
    icon: UserRound,
    summary: 'Tus datos y la seguridad de tu cuenta.',
    items: [
      <>Cambia tu nombre y tu teléfono; el resto del equipo ve tu nombre en la lista de super-admins y en tus notas.</>,
      <>Para cambiar la contraseña te pedimos la actual: así nadie que encuentre tu sesión abierta puede dejarte fuera.</>,
      <>«Cerrar las otras sesiones» desconecta los demás dispositivos y conserva el actual. Úsalo si entraste desde un equipo ajeno.</>,
    ],
    link: { to: '/admin/perfil', label: 'Ir a mi perfil' },
  },
]

export function AdminGuidePage() {
  const go = (id: string) => document.getElementById(`guia-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <AdminShell section="guia" title="Guía de uso">
      <Card className="mb-4">
        <CardBody className="space-y-3">
          <div className="flex items-start gap-3">
            <span className="rounded-xl bg-brand-50 p-2 text-brand-600"><BookOpen className="h-5 w-5" /></span>
            <div className="min-w-0">
              <p className="font-semibold text-slate-800">Cómo funciona el panel de plataforma</p>
              <p className="mt-1 text-sm text-slate-600">
                Desde aquí se administran todas las cuentas de Ferddo. Por diseño, el panel ve <b>cifras agregadas</b>,
                nunca las ventas, clientes o productos de un negocio. Para ayudar a un negocio por dentro existe una sola
                puerta, «Entrar como gestor»: temporal, con motivo, visible para el dueño y registrada.
              </p>
            </div>
          </div>
          {/* Índice: salta a cada módulo de esta misma página. */}
          <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
            {SECTIONS.map((s) => (
              <button key={s.id} type="button" onClick={() => go(s.id)}
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-brand-300 hover:text-brand-700">
                <s.icon className="h-3.5 w-3.5" /> {s.title}
              </button>
            ))}
          </div>
        </CardBody>
      </Card>

      <div className="space-y-4">
        {SECTIONS.map((s) => (
          <Card key={s.id} id={`guia-${s.id}`} className="scroll-mt-20">
            <CardBody className="space-y-3">
              <div className="flex items-start gap-3">
                <span className="rounded-xl bg-slate-100 p-2 text-slate-600"><s.icon className="h-5 w-5" /></span>
                <div className="min-w-0">
                  <h2 className="font-semibold text-slate-900">{s.title}</h2>
                  <p className="text-sm text-slate-500">{s.summary}</p>
                </div>
              </div>
              <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-700">
                {s.items.map((item, i) => <li key={i}>{item}</li>)}
              </ul>
              {s.caution && (
                <p className="flex gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{s.caution}</span>
                </p>
              )}
              {s.link && (
                <Link to={s.link.to} className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline">
                  {s.link.label} <ArrowRight className="h-4 w-4" />
                </Link>
              )}
            </CardBody>
          </Card>
        ))}
      </div>
    </AdminShell>
  )
}
