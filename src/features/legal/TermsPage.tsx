import {
  Bullets,
  DocLink,
  H3,
  LegalDoc,
  Li,
  MailLink,
  Note,
  P,
  Todo,
  type LegalSection,
} from './LegalDoc'
import { APP_NAME, LEGAL_PATHS } from '@/lib/constants'

/**
 * Términos del Servicio públicos (ruta `/terminos`, sin sesión).
 *
 * Igual que la política de privacidad: describe las reglas REALES del producto
 * —las que aplican los triggers de la base de datos y los guards del cliente—,
 * no una plantilla.
 *
 * A propósito NO fija precios ni topes en números: viven en `plan_settings` y el
 * super-admin los cambia en caliente, así que un número escrito aquí quedaría
 * desmentido por la propia aplicación. Se remiten a los publicados en la app.
 *
 * Rellena todos los <Todo> antes de publicar: sin ellos, este documento no
 * identifica a nadie ni dice qué ley lo rige, que es justo lo que lo hace valer.
 */
const UPDATED = '[COMPLETAR: fecha de publicación]'

const SECTIONS: LegalSection[] = [
  {
    id: 'aceptacion',
    title: 'Quiénes somos y qué estás aceptando',
    body: (
      <>
        <P>
          {APP_NAME} es un servicio operado por <Todo>razón social</Todo>, con domicilio en{' '}
          <Todo>dirección completa</Todo>. Al crear una cuenta o usar el servicio aceptas estos
          términos y la <DocLink to={LEGAL_PATHS.privacy}>Política de Privacidad</DocLink>. Si no
          estás de acuerdo, no uses {APP_NAME}.
        </P>
        <P>
          Se aplican tanto a quien abre la cuenta como a cualquier persona que sea invitada a
          administrarla.
        </P>
      </>
    ),
  },
  {
    id: 'que-es',
    title: `Qué es ${APP_NAME} y qué no es`,
    body: (
      <>
        <P>
          {APP_NAME} es un <strong>sistema de punto de venta, inventario y facturación</strong> para
          negocios: registras ventas, existencias, caja, créditos, compras y gastos, y trabajas
          sobre ellos con tu equipo. Está preparado para emitir comprobantes fiscales electrónicos
          (e-CF), pero <strong>no es la DGII ni actúa en su nombre</strong>: la autorización como
          emisor electrónico y el cumplimiento fiscal de tu negocio son responsabilidad tuya.
        </P>
        <Note>
          <strong>
            {APP_NAME} no es un banco, ni una entidad financiera, ni una plataforma de pagos, ni un
            asesor contable, fiscal o legal.
          </strong>{' '}
          El dinero de tu negocio no pasa por la aplicación: lo que guardas aquí son anotaciones
          tuyas. No custodiamos fondos, no verificamos lo que registras y no supervisamos tus
          operaciones.
        </Note>
        <Bullets>
          <Li>
            Un dato anotado en {APP_NAME} significa que <strong>alguien de tu cuenta lo escribió</strong>.
            No es prueba de nada frente a un tercero ni garantiza que sea correcto.
          </Li>
          <Li>
            Los documentos que genera la aplicación son de uso interno.{' '}
            <strong>No son documentos fiscales</strong> salvo que tú los conviertas en tales por tus
            propios medios.
          </Li>
          <Li>
            Los acuerdos con tus clientes o proveedores son tuyos. No somos parte de ellos ni
            respondemos por cómo se cumplan.
          </Li>
        </Bullets>
      </>
    ),
  },
  {
    id: 'cuenta',
    title: 'Tu cuenta',
    body: (
      <Bullets>
        <Li>Tienes que ser mayor de 18 años y usar datos verdaderos.</Li>
        <Li>
          Eres responsable de todo lo que ocurra en tu cuenta. Elige una contraseña que no uses en
          otros sitios y no la compartas: quien la tenga entra como si fueras tú.
        </Li>
        <Li>
          <strong>Puede que no verifiquemos el correo al registrarte</strong>, para que puedas
          empezar de una vez. Eso significa que alguien podría dar de alta una dirección que no es
          suya: si te pasa, escríbenos a <MailLink /> y la liberamos.
        </Li>
        <Li>
          Con el plan que lo permita puedes invitar a otras personas a administrar tu cuenta. Ven los
          mismos datos que tú y actúan en tu nombre; los códigos de invitación caducan solos y puedes
          revocarlos cuando quieras.
        </Li>
        <Li>
          Una cuenta es de una persona. Compartir credenciales entre varias, en lugar de invitarlas,
          es motivo de suspensión.
        </Li>
      </Bullets>
    ),
  },
  {
    id: 'tu-contenido',
    title: 'Lo que guardas y de qué respondes',
    body: (
      <>
        <P>
          Los datos que cargas son tuyos y son tu responsabilidad. Al guardarlos en {APP_NAME} te
          comprometes a:
        </P>
        <Bullets>
          <Li>
            Tener derecho a tratarlos. Si incluyen datos de otras personas, a contar con su permiso
            y a decirles que los llevas en esta aplicación.
          </Li>
          <Li>
            Anotar solo lo necesario. Los campos de texto son libres: no los uses para información
            sensible que no haga falta para tu negocio.
          </Li>
          <Li>
            Atender las solicitudes de esas personas sobre sus propios datos. Frente a ellas, el
            responsable eres tú.
          </Li>
          <Li>Cumplir la normativa que te aplique por tu actividad y por tu país.</Li>
        </Bullets>
        <P>
          Nosotros no revisamos ni moderamos lo que guardas, salvo cuando una denuncia o una
          obligación legal nos obliga a mirarlo.
        </P>
      </>
    ),
  },
  {
    id: 'planes',
    title: 'Planes, precios y límites',
    body: (
      <>
        <P>
          Cada plan tiene topes —de productos, sucursales, cajas, comprobantes electrónicos al mes y
          personas en el equipo— y un conjunto de módulos; los planes superiores los levantan y
          añaden funciones. Las cuentas nuevas empiezan con un periodo de prueba.
        </P>
        <Note tone="brand">
          Los precios, los topes de cada plan y las funciones incluidas son{' '}
          <strong>los que aparezcan publicados en la aplicación en el momento de contratar</strong>.
          Pueden cambiar: los cambios no afectan a un periodo ya pagado, pero sí a los siguientes.
        </Note>
        <Bullets>
          <Li>
            <strong>Los topes se aplican en el servidor.</strong> Al llegar al límite, la aplicación
            no deja crear más hasta que subas de plan o liberes espacio.
          </Li>
          <Li>
            Desactivar y volver a activar un producto, una sucursal o una caja no sirve para
            saltarse el tope: el límite se revisa en el servidor.
          </Li>
          <Li>
            Bajar de plan con más contenido del que permite el nuevo tope no borra nada, pero impide
            crear más hasta quedar por debajo del límite.
          </Li>
          <Li>
            Si te habilitamos un tope mayor por cortesía, es para tu cuenta y no un plan comprado:
            podemos retirarlo avisándote.
          </Li>
        </Bullets>
      </>
    ),
  },
  {
    id: 'pagos',
    title: 'Cómo se paga',
    body: (
      <>
        <P>
          <Todo>
            describe aquí el método de cobro: pasarela, periodicidad, renovación automática o no,
            moneda, impuestos aplicables y cómo se emite el comprobante
          </Todo>
        </P>
        <Bullets>
          <Li>
            Los precios se muestran en <Todo>moneda</Todo> e incluyen o excluyen impuestos según{' '}
            <Todo>indícalo</Todo>.
          </Li>
          <Li>
            El cambio de plan se solicita desde la aplicación y queda activo cuando lo confirmamos.
          </Li>
          <Li>Una cuenta suspendida no puede contratar ni cambiar de plan.</Li>
        </Bullets>
      </>
    ),
  },
  {
    id: 'reembolsos',
    title: 'Reembolsos',
    body: (
      <>
        <P>
          Lo que se contrata es un servicio digital de acceso inmediato.{' '}
          <Todo>
            política de reembolso: plazo de desistimiento, casos cubiertos y cómo se solicita
          </Todo>
        </P>
        <H3>Si se revierte un pago</H3>
        <P>
          Un reembolso o un contracargo retira el plan que ese pago habilitó: la cuenta vuelve al
          plan gratuito y a sus topes. El contenido no se borra, pero deja de poder crecer mientras
          esté por encima del límite. Un contracargo que consideremos abusivo puede acabar en
          suspensión.
        </P>
      </>
    ),
  },
  {
    id: 'uso-prohibido',
    title: 'Lo que no se puede hacer',
    body: (
      <Bullets>
        <Li>
          Usar {APP_NAME} para cualquier actividad ilegal, para captar dinero del público sin
          autorización o para blanquear fondos.
        </Li>
        <Li>Guardar datos de personas que no te autorizaron, o usarlos para algo distinto de tu negocio.</Li>
        <Li>Suplantar a otra persona o negocio, o dar datos falsos para abrir una cuenta.</Li>
        <Li>
          Intentar acceder a datos de otro negocio, romper la seguridad, hacer ingeniería inversa,
          extraer datos de forma masiva o sobrecargar el servicio a propósito.
        </Li>
        <Li>Revender, alquilar o dar acceso a {APP_NAME} como si fuera tuyo.</Li>
        <Li>Enviar mensajes no solicitados a partir de los datos que guardas aquí.</Li>
      </Bullets>
    ),
  },
  {
    id: 'suspension',
    title: 'Suspensión y cierre de cuentas',
    body: (
      <>
        <P>
          Si incumples estos términos, si detectamos un uso abusivo, fraudulento o ilegal, o si una
          autoridad nos lo exige, podemos:
        </P>
        <Bullets>
          <Li>
            <strong>Suspender la cuenta.</strong> Los datos siguen ahí, pero se congela: no se puede
            crear ni modificar nada hasta que se reactive.
          </Li>
          <Li>
            <strong>Bloquear un acceso concreto</strong>, o retirárselo a una persona invitada.
          </Li>
          <Li>
            <strong>Eliminar la cuenta</strong> en casos graves o reincidentes.
          </Li>
        </Bullets>
        <P>
          Salvo que una obligación legal lo impida, avisamos antes y explicamos el motivo. No
          devolvemos lo pagado por un periodo que se pierda a causa de un incumplimiento tuyo.
        </P>
      </>
    ),
  },
  {
    id: 'cerrar-cuenta',
    title: 'Cerrar tu cuenta y qué se conserva',
    body: (
      <Bullets>
        <Li>
          Puedes dejar de usar {APP_NAME} cuando quieras. Para que{' '}
          <strong>eliminemos la cuenta y todo su contenido, escríbenos a <MailLink /></strong> desde
          el correo de la cuenta.
        </Li>
        <Li>
          Eliminar borra los productos, el inventario, las ventas, la caja, los comprobantes, las
          compras, los gastos, la bitácora y los archivos subidos.{' '}
          <strong>No se puede deshacer</strong> y el tiempo que quedara de un plan pagado se pierde.
        </Li>
        <Li>
          Antes de pedirlo, descarga lo que quieras conservar: después no podemos recuperarlo.
        </Li>
        <Li>
          Guardamos una constancia mínima del borrado (fecha, nombre del negocio, correo del dueño y
          conteos) por obligaciones contables y para prevenir fraudes, como se explica en la{' '}
          <DocLink to={LEGAL_PATHS.privacy}>Política de Privacidad</DocLink>.
        </Li>
      </Bullets>
    ),
  },
  {
    id: 'disponibilidad',
    title: 'Disponibilidad, modo sin conexión y respaldos',
    body: (
      <>
        <P>
          Hacemos lo posible para que {APP_NAME} esté siempre disponible, pero{' '}
          <strong>no garantizamos que funcione sin interrupciones</strong>. Puede haber cortes,
          mantenimientos y fallos de los proveedores de los que dependemos.
        </P>
        <Bullets>
          <Li>
            Puedes trabajar sin internet, pero{' '}
            <strong>un cambio solo es definitivo cuando sube al servidor</strong> y lo ves reflejado
            en la aplicación. Hasta entonces vive en tu aparato y podría perderse si lo formateas o
            borras los datos del navegador.
          </Li>
          <Li>
            Lo pendiente sube cuando vuelvas a entrar con la misma cuenta y haya conexión. Es tu
            responsabilidad comprobar que quedó registrado.
          </Li>
          <Li>
            Hacemos respaldos del servicio, pero no son un servicio de recuperación a tu medida:
            exporta lo que sea crítico para ti.
          </Li>
          <Li>
            Podemos cambiar, añadir o retirar funciones. Si retiramos algo importante, avisamos con
            antelación.
          </Li>
        </Bullets>
      </>
    ),
  },
  {
    id: 'propiedad',
    title: 'De quién es cada cosa',
    body: (
      <>
        <P>
          El nombre {APP_NAME}, el logo, el diseño y el software son nuestros. Te damos permiso para
          usar la aplicación mientras cumplas estos términos; no te cedemos ningún derecho sobre
          ella.
        </P>
        <P>
          <strong>Los datos que registras son tuyos.</strong> Nos autorizas únicamente a alojarlos y
          procesarlos para prestarte el servicio, en los términos de la{' '}
          <DocLink to={LEGAL_PATHS.privacy}>Política de Privacidad</DocLink>.
        </P>
        <P>
          Si nos envías una sugerencia, podemos aplicarla sin deberte nada por ello.
        </P>
      </>
    ),
  },
  {
    id: 'responsabilidad',
    title: 'Hasta dónde respondemos',
    body: (
      <>
        <P>
          {APP_NAME} se presta «tal como está». En la medida en que la ley lo permita, no respondemos
          por:
        </P>
        <Bullets>
          <Li>
            Lo que ocurra con tu negocio: pérdidas, faltantes, acuerdos incumplidos o desacuerdos con
            terceros.
          </Li>
          <Li>
            Errores en lo que se registra en la aplicación, ni por decisiones que tomes a partir de
            esos registros.
          </Li>
          <Li>
            Datos filtrados por compartir una contraseña, dejar una sesión abierta o perder un
            aparato desbloqueado.
          </Li>
          <Li>Fallos de los proveedores de los que dependemos, ni por lucro cesante o daños indirectos.</Li>
        </Bullets>
        <P>
          Si tuviéramos que responder por algo, el límite total será el monto que nos hayas pagado en
          los 12 meses anteriores al hecho. Nada de esto excluye las responsabilidades que la ley no
          permite excluir.
        </P>
      </>
    ),
  },
  {
    id: 'cambios',
    title: 'Cambios en estos términos',
    body: (
      <P>
        Podemos actualizarlos. Cuando lo hagamos, cambiamos la fecha del inicio de esta página y, si
        el cambio es importante, avisamos dentro de la aplicación o por correo. Seguir usando{' '}
        {APP_NAME} después de eso cuenta como aceptación. Si no estás de acuerdo, puedes cerrar tu
        cuenta.
      </P>
    ),
  },
  {
    id: 'ley',
    title: 'Ley aplicable',
    body: (
      <P>
        Estos términos se rigen por las leyes de <Todo>país</Todo>. Cualquier controversia se
        someterá a los tribunales de <Todo>ciudad o jurisdicción</Todo>, sin perjuicio de que
        intentemos resolverla antes escribiéndonos a <MailLink />. Si algún punto resultara inválido,
        el resto sigue vigente.
      </P>
    ),
  },
]

export function TermsPage() {
  return (
    <LegalDoc
      title="Términos del Servicio"
      updated={UPDATED}
      lead={
        <>
          Estas son las reglas de uso de {APP_NAME}. Lo más importante en dos líneas:{' '}
          <strong>
            la aplicación registra las ventas, el inventario y la facturación de tu negocio, pero no
            maneja tu dinero ni responde por lo que anotes en ella
          </strong>
          , y los datos que cargas siguen siendo tuyos. Lo demás está detallado abajo.
        </>
      }
      sections={SECTIONS}
    />
  )
}
