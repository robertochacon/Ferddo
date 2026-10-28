# Ferddo — Plan de implementación SaaS (ERP + POS + e-CF RD)

> Documento vivo. Estados: **Completado** · **En progreso** · **Pendiente** · **Bloqueado**.
> Última actualización: 2026-10-28.

## 1. Arquitectura actual (heredada del starter y conservada)

| Capa | Tecnología | Notas |
|---|---|---|
| Frontend | React 18 + TypeScript `strict` + Vite 6 + Tailwind 3 + PWA | Sin librería de UI: primitivas propias en `src/components/ui/` |
| Datos en cliente | TanStack Query 5 + persistencia en localStorage | Capa obligatoria `src/hooks/*.ts`; ningún componente importa `supabase` |
| Backend | Supabase: Postgres + RLS + Auth + Storage + Edge Functions (Deno) | **La lógica de negocio vive en Postgres** (RPC `security definer` + triggers) |
| Despliegue | GitHub Pages (`.github/workflows/deploy.yml`) o Vercel (`vercel.json`) | HashRouter por defecto |

**Decisión de stack.** El prompt maestro sugería Hono + Kysely como backend. El
repositorio ya tenía un backend completo y probado sobre Postgres/RLS/RPC, que
cumple los mismos objetivos (API REST vía PostgREST, validación en el servidor,
transacciones) sin un servidor que mantener. Por la regla "priorizar el stack
existente" **no se introdujo Hono**: las reglas de negocio son funciones SQL
transaccionales y la integración externa (DGII/proveedor) es una Edge Function.
Zod se usa en los formularios; la validación autoritativa está en la base.

### Lo que ya existía y se reutilizó

- Autenticación (correo + Google), recuperación de contraseña, onboarding.
- Multi-tenant por fila (`tenant_id` + RLS), suspensión de negocios, invitaciones.
- Planes con topes leídos de `plan_settings`, solicitudes de cambio de plan.
- Panel de super-admin, purga auditada de negocios, bitácora `audit_logs`.
- PWA, cola offline con guard de sesión, sistema de diseño y layout responsive.

### Lo que se retiró

- La entidad de ejemplo `items` (tabla, triggers, hooks, pantallas).

## 2. Modelo multiempresa (Fase 1)

```
auth.users ──< tenant_members >── tenants ──< branches ──< cash_registers
     │              (rol, sucursales, activo)      │
     └── profiles.tenant_id = empresa ACTIVA       └──< todo el ERP (tenant_id)
```

- `tenant_members` guarda la pertenencia real (una persona, varias empresas, un rol por empresa).
- `profiles.tenant_id` es solo el puntero a la empresa activa. `profiles_guard`
  solo acepta moverlo a una empresa con membresía activa → todas las políticas
  `tenant_id = auth_tenant_id()` siguen valiendo y **el backend nunca confía en un
  tenant_id enviado por el cliente**.
- `auth_tenant_id()` exige membresía activa: desactivar a un empleado le corta el
  acceso en la siguiente consulta.
- Roles: propietario, administrador, supervisor, cajero, vendedor, inventario,
  compras, contabilidad, cocina, servicios. Permisos por acción (`permissions`),
  plantilla global (`default_role_permissions`) copiada por empresa a
  `role_permissions` (editable). `has_perm()` / `require_perm()` en cada RPC y
  en las políticas de escritura. El propietario siempre tiene todo.
- Restricción por sucursal: `tenant_members.branch_ids` + `can_access_branch()` en
  las RPC de operación.
- Super-admin: `platform_admins`, sin empresa; **no lee datos comerciales** de los
  negocios (las tablas ERP no tienen política de lectura de plataforma); solo
  métricas agregadas por RPC.

## 3. Estado por fase

| Fase | Alcance | Estado |
|---|---|---|
| 1 Núcleo SaaS | Multiempresa, membresías, roles/permisos, sucursales, tipos de negocio y módulos, configuración | **Completado** |
| 2 Gestión comercial | Productos/servicios, variantes (por `parent_id`), categorías, impuestos, clientes, proveedores, inventario por movimientos, kardex, transferencias, conteos, importación CSV | **Completado** |
| 3 POS | Venta transaccional e idempotente, descuentos con permiso, ITBIS incluido/excluido, pago mixto, crédito con límite, caja (apertura, entradas/salidas, arqueo, cierre), tickets 58/80 mm, historial, anulación, devoluciones | **Completado** |
| 4 e-CF | Configuración fiscal por empresa, secuencias e-NCF, documentos y eventos, cola con reintentos, interfaz `ElectronicInvoiceProvider`, simulador, notas de crédito por devolución, almacenamiento cifrado de credenciales | **En progreso** — núcleo listo; proveedor real **Bloqueado** (ver §6) |
| 5 Mini ERP | Compras (borrador→orden→recepción), cuentas por pagar, gastos, cotizaciones y conversión a venta, cuentas por cobrar con antigüedad | **Completado** |
| 6 Reportes | Tablero, ventas por día/producto/categoría/vendedor/sucursal/método, ITBIS, gastos, valoración de inventario, exportación CSV | **Completado** |
| 7 Administración SaaS | Planes Básico/Negocio/Empresa con límites y módulos configurables, historial de suscripción, suspensión controlada por vencimiento, panel global agregado | **Completado** (pasarela de pago **Pendiente**) |
| 8 Especializados | Restaurante (mesas, comandas, cocina), taller (órdenes de trabajo, vehículos), citas | **Pendiente** |

## 4. Migraciones

| Archivo | Qué hace |
|---|---|
| `0001`–`0011` | Starter (núcleo SaaS). `0006` se corrigió antes del primer despliegue: `extensions.gen_random_bytes` (en Supabase pgcrypto vive en el esquema `extensions`). |
| `0012_erp_enums` | Roles, `plan_code enterprise` y enums del ERP (va sola: un valor nuevo de enum no se puede usar en la misma transacción). |
| `0013_tenancy` | Retira `items`; `business_types`, columnas de empresa, `tenant_members`, permisos, `has_perm`, sucursales, `_setup_tenant_table()` (molde RLS), `prevent_mutation`, numeración interna, `setup_business`, `switch_tenant`, invitaciones con rol, equipo. |
| `0014_catalog_inventory` | Impuestos, categorías, productos, clientes, proveedores, `stock_levels` + `inventory_movements` (inmutable), ajustes, transferencias, conteos, importación. |
| `0015_pos_cash` | Cajas, sesiones, movimientos de caja, ventas, `price_lines()` (motor de cálculo único), `create_sale`, `void_sale`, devoluciones, cuentas por cobrar y cobros. |
| `0016_electronic_invoicing` | Tipos e-CF, configuración fiscal, secretos cifrados, secuencias, documentos, eventos, cola del procesador. |
| `0017_purchases_expenses_quotes` | Cuentas por pagar, compras, gastos, cotizaciones. |
| `0018_plans_reports_admin` | Planes y límites, historial de suscripción, siembra de empresas, tablero, reportes, panel global, purga de todo el ERP. |
| `0019_module_fixes` | Compras ⇒ cuentas por pagar en los tipos de negocio (hallazgo de la prueba de integración). |
| `0020_expense_paid_sync` | Al saldar la cuenta por pagar de un gasto, el gasto pasa a pagado. |

Todas aplicadas en el proyecto Supabase **Ferddo Saas** (`zhqhwqkmdlhnmtrhgner`).
Ninguna es destructiva sobre datos reales (la base estaba vacía).

## 5. Reglas de integridad clave

- **Dinero**: `numeric(14,2)`; cantidades `numeric(14,3)`; costos `numeric(14,4)`; tasas `numeric(7,4)`. Nunca `float`.
- **Un solo motor de cálculo**: `price_lines()` (SQL) para ventas y cotizaciones. `src/lib/pricing.ts` es solo vista previa; gana siempre el servidor.
- **Idempotencia**: `client_uid` único por empresa en ventas, devoluciones, cobros, pagos y gastos.
- **Inventario**: solo por movimientos inmutables; el saldo lo mantiene un trigger con candado de fila; índice único `(documento, línea, tipo)` impide duplicar al reprocesar.
- **Caja**: libro inmutable; el esperado del cierre se calcula de los movimientos; las ventas toman `FOR SHARE` sobre la sesión y el cierre `FOR UPDATE`.
- **Fiscal**: estado comercial ≠ estado fiscal; e-NCF único por empresa; un documento por (origen, tipo); un veredicto final no se sobrescribe; eventos inmutables.
- **Cruce entre empresas**: claves foráneas compuestas `(tenant_id, id)`.
- **Suscripción vencida**: los datos se conservan y se leen; las operaciones nuevas fallan con `SUBSCRIPTION_EXPIRED`.

### Métricas (criterios verificables)

- **Ventas** = Σ total (con ITBIS) de ventas no anuladas − Σ devoluciones.
- **Ticket promedio** = ventas del mes ÷ número de ventas no anuladas del mes.
- **Margen bruto estimado** = ventas netas **sin ITBIS** − costo de lo vendido (costo promedio vigente al vender). **No es ganancia**: no descuenta gastos.
- Días y meses en la zona horaria de la empresa (`tenants.timezone`, por defecto America/Santo_Domingo).

## 6. Facturación electrónica — estado y pendientes

**Hecho**

- Modelo de datos fiscal completo y separado del comercial; secuencias e-NCF (`E` + tipo + 10 dígitos) con rangos sin solape y vencimiento; cuota mensual por plan.
- Venta con e-CF 31/32 y nota de crédito 34 automática al devolver una venta con e-CF.
- Edge Function `ecf` con interfaz `ElectronicInvoiceProvider`, registro de proveedores, simulador (solo test/certificación, siempre marcado "sin validez fiscal"), reintentos exponenciales, recuperación de envíos colgados, credenciales cifradas AES-GCM con clave fuera de la base.

**Bloqueado / pendiente (requiere decisiones o credenciales externas)**

1. **Elegir proveedor autorizado** por la DGII y obtener su documentación técnica y credenciales de prueba → implementar su adaptador en `supabase/functions/_shared/ecf/`. No se inventaron endpoints.
2. **Integración directa con la DGII** (alternativa al proveedor): requiere certificación del software, XSD oficiales, firma XML-DSig con certificado del contribuyente, semilla/token de autenticación. Preparado como otro adaptador.
3. **Representación impresa oficial**: el ticket ya muestra e-NCF, código de seguridad y QR cuando el proveedor devuelve `qr_url`; validar el formato contra la norma vigente.
4. **e-CF 33, 41, 43, 44–47**: catálogo cargado; falta originarlos desde compras/gastos/notas de débito.
5. **Contingencia** y **anulación de secuencias (ANECF)**: pendientes de la documentación oficial.
6. **Desplegar** la función: `supabase functions deploy ecf` + `supabase secrets set FISCAL_ENC_KEY=… ECF_CRON_SECRET=…` y programar `/ecf/cron` (pg_cron + pg_net o un scheduler externo).
7. **Legal**: verificar en dgii.gov.do la Ley 32-23, su reglamento y el Aviso 06-2026 (plazo de pequeños/micro: 15 de noviembre de 2026 según fuentes secundarias). **Ferddo no debe presentarse como certificado** hasta completar el proceso.

## 7. Riesgos técnicos

| Riesgo | Mitigación |
|---|---|
| Plazo DGII inminente (15/11/2026) | Priorizar el adaptador del proveedor autorizado (§6.1) |
| Serialización de ventas por empresa (secuencia interna con candado de fila) | Aceptable para pymes; si crece, numerar por sucursal/caja |
| Catálogos > 20 000 productos (lectura completa en el POS) | Pasar a búsqueda de servidor con el índice trigram ya creado |
| POS sin conexión | No implementado a propósito: dependencias de caja, existencias y e-NCF. Estudio aparte (cola de ventas con numeración de contingencia) |
| Impresoras térmicas sin driver | Agente local (pendiente) que exponga una API en `localhost` para ESC/POS |
| Correos de Auth con el SMTP compartido de Supabase | Configurar SMTP propio (`SMTP_PASSWORD`) antes de abrir registros |

## 8. Estrategia de pruebas

| Prueba | Comando | Qué cubre |
|---|---|---|
| Integración de base de datos | `npm run test:db` (`supabase/tests/erp_integration.sql`) | 64 aserciones (todas en verde): aislamiento entre empresas, permisos por rol, multiempresa, venta idempotente, ITBIS, pago mixto, crédito y límite, abonos y conciliación, devoluciones, anulación, kardex = existencia, e-CF (secuencias, e-NCF, nota de crédito, cola exclusiva de service_role, veredicto final inmutable), compras y costo promedio, cuentas por pagar, cotización→venta sin duplicar, gastos, arqueo, tablero, ITBIS, límites de plan y módulo, suscripción vencida, privacidad del super-admin, purga completa. Corre en una transacción que se revierte: no deja datos. |
| Unitarias del cálculo | `npm test` | Espejo TS de `price_lines()` con los mismos casos que la prueba SQL. |
| Tipos | `npm run lint` | `tsc -b --noEmit` estricto. |
| Build | `npm run build` | Bundle de producción. |
| Humo en navegador | Playwright sobre `vite preview` | Landing, login, registro y legales a 1366 px y 360 px: sin errores de ejecución ni scroll horizontal; rutas protegidas redirigen al login. Recorrido con sesión en la web publicada (2026-10-28): registro → onboarding (colmado) → producto con existencia inicial → abrir caja → venta en efectivo con devuelta → existencia 10→9 → caja con esperado correcto; POS, ventas, productos, configuración y e-CF a 360 px sin scroll horizontal. Datos de prueba purgados después. |

Nunca usar el ambiente de producción de la DGII para pruebas.

## 9. Criterios de aceptación

- Un usuario de la empresa A no puede leer ni escribir nada de la empresa B (probado).
- Una venta reintentada con el mismo `client_uid` no duplica cobro ni inventario (probado).
- La existencia siempre es igual a la suma del kardex (probado).
- El esperado de caja cuadra con ventas, cobros, devoluciones y gastos (probado).
- Un e-CF nunca se emite dos veces para el mismo origen y tipo (restricción única).
- Sin permiso, la base rechaza la acción aunque la UI la mostrara (probado).

## 10. Frontend entregado

Pantallas (todas con permisos y módulos, tabla en `lg` y lista en móvil): Inicio/tablero, POS táctil, Ventas y detalle (reimpresión, anulación, devolución), Caja (apertura, entradas/salidas, arqueo, cierre, historial), Productos y servicios (variantes, categorías, imagen, CSV), Inventario (existencias, kardex, ajustes, transferencias, conteos, valoración), Clientes y estado de cuenta, Cuentas por cobrar (antigüedad, abonos), Proveedores, Compras (borrador→orden→recepción con pago), Cuentas por pagar, Gastos, Cotizaciones (impresión/PDF y conversión al POS), Facturación e-CF (comprobantes, configuración, secuencias, guía DGII), Reportes (CSV), Configuración (empresa y módulos, sucursales y cajas, impuestos, equipo, roles y permisos, plan y consumo), Perfil (mis empresas), Onboarding por tipo de negocio, Panel global, Landing.

Limitaciones conocidas: archivos reemplazados en Storage (imágenes, adjuntos abandonados) no se borran; el historial de compras del cliente depende de `sales.view_all`; el certificado .p12 no se inspecciona (solo se cifra y guarda).

## 11. Pendiente de configuración externa

- ~~`supabase config push`~~ aplicado (URLs de GitHub Pages, sin confirmación por correo). Plantillas de correo: requieren SMTP propio en el plan gratuito.
- Desplegar la función `welcome` (correo de bienvenida; hoy falla en silencio por CORS al no existir).
- `supabase functions deploy ecf` + secretos `FISCAL_ENC_KEY`, `ECF_CRON_SECRET` + programar `/ecf/cron`.
- Primer super-admin: `scripts/grant-platform-admin.sql`.
- Términos y condiciones: completar razón social, dirección y plazos de conservación (marcadores `<Todo>`).

## 12. Próximos pasos sugeridos

1. Proveedor e-CF autorizado (adaptador + certificación) — **crítico por plazo**.
2. Desplegar la Edge Function `ecf` y su cron; SMTP propio.
3. Pasarela de pago para suscripciones (Edge Function + webhook firmado, idempotente).
4. Fase 8: restaurante (mesas/comandas reutilizando `create_sale`) y taller (órdenes de trabajo → cotización → venta).
5. Agente local de impresión ESC/POS; estudio del POS offline.
6. Listas de precios, productos compuestos, recepción parcial de compras.
