# CLAUDE.md — cómo se trabaja en este repo

Instrucciones para un agente que edita este código. Lo obligatorio y por qué;
los detalles (nombres de tablas, firmas de RPC, claves de cache) están en
**`ARQUITECTURA.md`**, que manda sobre este archivo.

## Lo primero

1. Lee `ARQUITECTURA.md` antes de crear cualquier archivo nuevo.
2. Antes de inventar un patrón, **abre el archivo hermano más cercano y cópialo**.
   Moldes de referencia: `src/hooks/core.ts` (lecturas), `src/hooks/team.ts`
   (mutaciones por RPC), `supabase/migrations/0015_pos_cash.sql` (RPC
   transaccional e idempotente) y `_setup_tenant_table()` en la 0013 (tabla nueva).
3. Ferddo es un POS/ERP con facturación electrónica para RD. El plan, el estado
   por fase y lo pendiente están en **`docs/SAAS_IMPLEMENTATION_PLAN.md`**:
   actualízalo al terminar cada bloque de trabajo.
4. Comentarios y textos de interfaz **en español**. Identificadores en inglés.
5. Comenta el **porqué**, no el qué. Un comentario que repite el código sobra;
   uno que explica una decisión rara ahorra un bug futuro.

## Frontend

**Capa de hooks obligatoria.** Ningún componente importa `supabase`. Toda
lectura o escritura pasa por `src/hooks/*.ts` con TanStack Query. Única
excepción, ya escrita: `src/auth/AuthProvider.tsx` y `src/pages/auth/*` (login,
registro, OAuth, recuperación), que hablan con `supabase.auth`, no con datos.

- Toda llamada `.from()` y `.rpc()` comprueba `error` y lo lanza: `if (error) throw error`.
- Las claves de cache son las de `ARQUITECTURA.md` §7.11. No inventes claves
  nuevas para datos que ya tienen una.
- En `onSuccess` invalida **todo lo que la mutación deja desfasado**, casi siempre
  también `['dashboard']`. Si la fila se borró, `removeQueries`, no `invalidateQueries`:
  volver a pedirla solo gasta una vuelta de red para guardar un `null`.
- UI solo con las primitivas de `src/components/ui/`. Clases con `cn()`
  (`@/lib/cn`). Variantes por **objeto de lookup**, nunca ternarios encadenados.
- `forwardRef` + `...props` en cualquier primitiva que envuelva un elemento HTML.

**Regla móvil (no negociable).** Ningún listado puede exigir scroll horizontal en
el teléfono:

```tsx
<div className="hidden overflow-x-auto lg:block"><table>…</table></div>
<DataList>{rows.map((r) => <DataRow … actions={<ActionMenu items={…} />} />)}</DataList>
```

Revisa cada pantalla a **360 px** antes de darla por hecha. Y los inputs se
quedan a 16 px en móvil (`src/index.css`, con `!important`): por debajo, iOS hace
zoom al enfocar y no vuelve.

**TypeScript.** `strict` con `noUnusedLocals` y `noUnusedParameters`: un import o
un parámetro sin usar **rompe el build**. Nada de `any` salvo en una frontera con
datos crudos, y ahí acotado y con un comentario que diga por qué.

## Base de datos

**La lógica vive en Postgres.** Topes de plan, consistencia entre tablas y campos
inmutables son triggers y funciones `security definer`, no validaciones del
formulario. Cualquiera puede llamar a PostgREST con `curl` y la anon key: si la
regla no está en la base, no existe. La validación del cliente es cortesía, no
seguridad.

**Migraciones**

- Se numeran `NNNN_titulo.sql`, cuatro dígitos, correlativo. La siguiente libre es
  la que toque después de la última de `supabase/migrations/`. Un solo hueco por número.
  **Ya están aplicadas en el proyecto real** (`Ferddo Saas`): todo cambio es una migración nueva.
- Cabecera `-- ═══ Ferddo · NNNN · <título> ═══` y una explicación de **por qué**
  existe la migración.
- Idempotente donde se pueda: `create table if not exists`, `drop policy if exists`,
  `create or replace function`.
- **Nunca se edita una migración ya aplicada.** Si `supabase db push` la corrió en
  un proyecto real, ese archivo es historia: el CLI lleva la cuenta por nombre y
  no la vuelve a ejecutar, así que tu cambio nunca llega al servidor mientras en
  local sí — y las dos bases divergen en silencio. Todo cambio es una migración
  nueva. (Antes del primer despliegue, con la base aún vacía, sí vale editar y
  hacer `supabase db reset`.)

**Tabla nueva de empresa ⇒ `select public._setup_tenant_table('tabla', 'permiso.de.escritura' | null)`**
(0013): aplica RLS, revoke, políticas por tenant + permiso, bloqueo por suspensión
y `updated_at` de una vez. Añade la tabla a `tenant_tables_purge_order()` (0018) en
orden hijo→padre. Referencias a otras tablas de empresa con FK compuesta
`(tenant_id, x_id) references x (tenant_id, id)`. Dinero en `numeric`, nunca float.
Operaciones financieras: RPC con `client_uid` idempotente. El detalle de las cuatro
reglas que aplica el molde:

**Tabla nueva ⇒ siempre las cuatro cosas**

1. `tenant_id uuid not null references public.tenants(id) on delete cascade` + índice.
2. `alter table … enable row level security`.
3. `revoke all on … from anon;` — Supabase concede INSERT/UPDATE/DELETE a `anon` y
   `authenticated` por defecto. Sin revoke ni política, un PATCH ajeno devuelve
   **204 con 0 filas** en vez de 42501: parece que funciona y no hace nada.
4. Política `for all to authenticated using/with check (tenant_id = auth_tenant_id())`,
   y si el super-admin debe verla, otra **permisiva y solo SELECT** con
   `auth_is_platform_admin() and auth_tenant_id() is null`.

Además: añádela a `admin_delete_tenant` (borra hijo→padre; una tabla que falte
rompe la purga por *foreign key*) y decide si necesita
`block_write_if_tenant_suspended`.

**RPC nueva:** `security definer set search_path = public`, guardia de
autorización en la primera línea, `revoke all … from public` + `grant execute …
to authenticated`. Si puede tardar, `set local statement_timeout` dentro: PostgREST
hoistea el suyo y `authenticated` trae 8 s.

## Protocolo de errores de plan

Los triggers que aplican un tope lanzan el mensaje con un prefijo técnico:

```sql
raise exception 'PLAN_LIMIT_PRODUCTS: El plan % permite máximo % productos. Actualiza tu plan para agregar más.', v_name, v_max;
```

- Prefijos en uso: `PLAN_LIMIT_PRODUCTS`, `PLAN_LIMIT_MEMBERS`, `PLAN_LIMIT_BRANCHES`,
  `PLAN_LIMIT_REGISTERS`, `PLAN_LIMIT_ECF`, `PLAN_LIMIT_MODULE`; además `FORBIDDEN`,
  `SUBSCRIPTION_EXPIRED`, `CASH_SESSION_REQUIRED`, `CREDIT_LIMIT`, `STOCK_INSUFFICIENT`,
  `APPOINTMENT_OVERLAP`, `ECF_*`. Uno nuevo sigue el patrón `MARCA_EN_MAYUSCULAS: mensaje`.
- El prefijo existe **para que el código lo reconozca**, no para enseñárselo a
  nadie: `errorMessage()` (`src/lib/errors.ts`) recorta hasta los primeros dos
  puntos y pinta solo el texto amigable.
- Por eso el mensaje va **después de `: `** y en español, con la salida a mano
  ("Actualiza tu plan…"). No pongas ahí un texto técnico: es lo que lee el usuario.
- La UI nunca compone su propio mensaje de tope. Manda el de la base, que conoce
  el número real del plan vigente (`plan_settings`).

## Comandos

```bash
npm run dev                             # desarrollo
npm run lint                            # tsc -b --noEmit  ← pásalo antes de terminar
npm test                                # cálculo de precios (node:test)
npm run test:db                         # integración SQL contra el proyecto enlazado (se revierte)
npm run build                           # tipos + build a dist/

supabase db push --linked               # aplica migraciones al proyecto enlazado
supabase db reset                       # recrea la base LOCAL desde cero (borra datos)
supabase db query --linked "select …"   # consulta puntual contra el proyecto enlazado
supabase functions deploy welcome       # despliega la Edge Function
supabase config push                    # SIEMPRE con SMTP_PASSWORD en el entorno
```

## Prohibiciones

- No ejecutes `supabase db push`, `config push` ni `functions deploy` sin que te
  lo pidan: escriben en un proyecto real.
- No cambies el `buster` del persister (`ferddo-v1`, `src/main.tsx`): descarta la
  cola de mutaciones offline **sin subirla**.
- No saques `clsx` del chunk `vendor` (`vite.config.ts`): la app no monta y la
  pantalla se queda en blanco antes de React.
- No pongas un secreto detrás de `VITE_`: acaba en `dist/`, que se publica tal
  cual. Los secretos van en `supabase secrets set`.
- No añadas dependencias sin necesidad. El stack de `ARQUITECTURA.md` §1 está
  cerrado; sin librería de UI, a propósito.
