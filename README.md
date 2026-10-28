# Ferddo — starter SaaS multi-tenant

Esqueleto de producción para una aplicación **multi-tenant** (varios negocios
aislados en la misma base de datos) con React + Supabase.

- **Frontend:** React 18 + TypeScript `strict` + Vite 6 + Tailwind + PWA
- **Backend:** Supabase — Postgres con **RLS**, Auth, Storage y Edge Functions
- **Incluye:** registro y acceso (correo o Google), alta del negocio, equipo con
  invitaciones, planes con topes aplicados **en la base**, panel de super-admin,
  páginas legales, cache offline y cola de escritura para una entidad.

### Qué NO es

**No es un producto.** No tiene tu dominio de negocio: trae una entidad de
ejemplo llamada `items` que existe solo para enseñar el patrón completo
(tabla → RLS → tope de plan → tipo → hook → pantalla). El trabajo de quien usa
esto es sustituirla por lo suyo.

Tampoco es una plantilla que se personaliza por configuración: es **código que
vas a editar**. Está comentado explicando el *porqué* de cada decisión rara
justo donde te la vas a encontrar.

---

## 1. Arranque en 10 minutos

Necesitas Node 20+, una cuenta en [Supabase](https://supabase.com) y el
[CLI](https://supabase.com/docs/guides/cli) (`brew install supabase/tap/supabase`).

```bash
# 1. Proyecto Supabase: créalo en supabase.com y copia el Project Ref,
#    la Project URL y la anon key (Settings → API).

npm install

cp .env.example .env
#    Rellena VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY. Nada más hace falta
#    para desarrollo.

supabase link --project-ref TU_PROJECT_REF
supabase db push                 # aplica supabase/migrations/0001…0011
supabase functions deploy welcome

npm run icons                    # íconos PWA + favicon desde public/logo.png

npm run dev
```

> **El logo es la fuente única de los íconos.** `public/logo.png` viene con un
> marcador de posición: sustitúyelo por el tuyo (PNG **cuadrado**, 512 px o más)
> y vuelve a correr `npm run icons`. De ahí salen `favicon.ico`, los íconos del
> manifiesto, el *maskable* de Android y la imagen social `og.png`; `public/icons/`
> no se versiona a propósito, lo regenera el build del CI. Si te saltas el paso,
> la PWA se instala con el logo del starter.

Abre el enlace de Vite, regístrate en `/registro` y crea tu negocio: la pantalla
de bienvenida llama a `setup_tenant()`, que arma el negocio, tu perfil de `owner`
y una suscripción `basic` en prueba de 30 días. **No hay datos de demostración**
(`supabase/seed.sql` explica por qué está vacío a propósito).

Dos ajustes más, cuando toque:

- **URLs de retorno.** `supabase/config.toml` ya declara las de `localhost`.
  Cuando despliegues, añade ahí el origen real y aplica con
  `SMTP_PASSWORD="re_..." supabase config push`. Sin esto, el enlace de
  recuperación de contraseña te manda al `site_url` en vez de a donde estabas.
- **Correo propio.** Sin SMTP configurado, Supabase usa su remitente compartido,
  limitado a unos pocos correos por hora. Las plantillas con marca están en
  `supabase/templates/`.

> ¿Local con Docker? `supabase start` aplica migraciones y levanta todo; los
> correos se leen en `http://localhost:54324`.

---

## 2. Haz que sea tuyo

### 2.1 El nombre

```bash
node scripts/rename.mjs "Mi Producto" miproducto          # simulacro
node scripts/rename.mjs "Mi Producto" miproducto --yes    # escribe
```

Sustituye `Ferddo` (nombre visible) y `ferddo` (slug de máquina: clave de
`localStorage`, `project_id` de Supabase, GUC de Postgres) en todo el repo. Sin
`--yes` solo imprime qué cambiaría — míralo antes, reescribe medio árbol de una
pasada.

Después, a mano: tu `public/logo.png` + `npm run icons`, el dominio de ejemplo en
`index.html`, `supabase/config.toml` y `src/lib/constants.ts`, y la paleta en
`tailwind.config.js`.

### 2.2 La entidad de ejemplo: `items` → lo tuyo

`items` es un molde, no una tabla que quieras conservar. Renombrarla toca estos
archivos y nada más:

| Archivo | Qué hay que cambiar |
|---|---|
| `supabase/migrations/0012_<tu_entidad>.sql` | **migración NUEVA** (ver abajo) |
| `src/types/db.ts` | `Item`, `ItemStatus` |
| `src/hooks/items.ts` | el módulo entero → `src/hooks/<tu_entidad>.ts` |
| `src/lib/offline.ts` | `OFFLINE_CREATE_ITEM_KEY`, `CreateItemInput`, la clave `['items']` |
| `src/lib/constants.ts` | `ITEM_STATUS_LABEL`, las viñetas de `PLANS` |
| `src/features/items/*` | `ItemsPage`, `ItemFormModal` |
| `src/App.tsx` | el `lazyWithRetry` y la ruta `/items` |
| `src/components/Layout.tsx` | la entrada del menú |
| `src/hooks/dashboard.ts`, `features/dashboard/` | los campos de `dashboard_summary()` |
| `src/features/admin/PlansCard.tsx` | el campo `max_items` del formulario de planes |

La parte de base de datos va en una **migración nueva**, nunca editando la 0001
(§ CLAUDE.md → migraciones). Lo mínimo:

```sql
-- 0012_widgets.sql
alter table public.items rename to widgets;
alter type item_status rename to widget_status;
alter table public.plan_settings rename column max_items to max_widgets;
-- Los triggers y las funciones que las nombran hay que reescribirlos:
-- enforce_item_consistency, enforce_item_limit, dashboard_summary,
-- admin_update_plan, admin_tenant_purge_preview, admin_delete_tenant.
```

Si aún no has desplegado nada, es más limpio **editar 0001–0011 directamente** y
hacer `supabase db reset`. La regla de "no tocar migraciones aplicadas" empieza a
valer el día que la base tiene datos que te importan.

---

## 3. La arquitectura en una pantalla

```
  NAVEGADOR
  ┌──────────────────────────────────────────────────────────┐
  │  features/ y components/                                 │
  │  Solo props y hooks. NUNCA importan `supabase`.          │
  ├──────────────────────────────────────────────────────────┤
  │  src/hooks/*.ts   — TanStack Query                       │
  │  Única capa que habla con la base. Cache, invalidación,   │
  │  estado optimista, cola offline.                         │
  └───────────────────────────┬──────────────────────────────┘
                              │ supabase-js  (JWT del usuario)
                              ▼
  ┌──────────────────────────────────────────────────────────┐
  │  PostgREST      /rest/v1/<tabla>      /rest/v1/rpc/<fn>  │
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  POSTGRES
  ┌──────────────────────────────────────────────────────────┐
  │  RLS       qué filas existen para ti                     │
  │            tenant_id = auth_tenant_id()                  │
  │  TRIGGERS  invariantes que el cliente no puede saltarse   │
  │            topes de plan, consistencia, campos inmutables │
  │  RPC       casos de uso que no caben en un SELECT         │
  │            setup_tenant, accept_invite, admin_*           │
  └───────────────────────────▲──────────────────────────────┘
                              │ service_role
  ┌──────────────────────────────────────────────────────────┐
  │  EDGE FUNCTIONS (Deno) — correo, terceros, secretos       │
  └──────────────────────────────────────────────────────────┘
```

Cuatro decisiones lo explican casi todo:

1. **La lógica vive en la base.** Los topes de plan, la consistencia entre tablas
   y los campos inmutables son triggers y funciones `security definer`, no
   validaciones del formulario. El cliente es sustituible: alguien puede llamar a
   PostgREST con `curl` y la anon key. Si la regla no está en Postgres, no existe.
2. **Aislamiento por fila, no por conexión.** Un solo Postgres, un solo esquema;
   `tenant_id` en cada tabla y una política RLS idéntica en todas
   (`tenant_id = auth_tenant_id()`). No hay "base por cliente" ni un `WHERE` que
   se te pueda olvidar en una consulta.
3. **Las Edge Functions son la válvula de escape,** no la capa de negocio. Solo
   se usan para lo que Postgres no puede hacer: hablar con terceros y guardar
   secretos. Hoy solo hay una (`welcome`).
4. **La frontera de confianza es el prefijo `VITE_`.** Todo lo que lo lleva acaba
   dentro de `dist/` y es público — la anon key incluida, que es pública por
   diseño porque sin RLS no protegería nada. Los secretos de verdad viven en
   `supabase secrets set` y solo los ven las Edge Functions.

---

## 4. Añadir una entidad nueva

Es el 90% del trabajo que harás. Cinco pasos, en este orden.

### 4.1 Migración

`supabase/migrations/0012_widgets.sql` — el patrón completo está en `items`
(0001 + 0002 + 0003 + 0005 + 0009), cópialo:

```sql
create table if not exists public.widgets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists widgets_tenant_idx on public.widgets(tenant_id);

create trigger widgets_set_updated_at
  before update on public.widgets
  for each row execute function public.set_updated_at();
```

### 4.2 RLS — no es opcional

```sql
alter table public.widgets enable row level security;

-- Supabase concede INSERT/UPDATE/DELETE a anon y authenticated POR DEFECTO.
-- Sin este revoke y sin la política, un PATCH ajeno devuelve 204 (0 filas
-- afectadas) en vez de 42501: parece que funciona y no hace nada.
revoke all on public.widgets from anon;

drop policy if exists widgets_tenant on public.widgets;
create policy widgets_tenant on public.widgets
  for all to authenticated
  using (tenant_id = public.auth_tenant_id())
  with check (tenant_id = public.auth_tenant_id());

-- El super-admin lee todos los negocios: PERMISIVA y SOLO SELECT.
drop policy if exists widgets_platform_read on public.widgets;
create policy widgets_platform_read on public.widgets
  for select to authenticated
  using (public.auth_is_platform_admin() and public.auth_tenant_id() is null);
```

Si la entidad debe contarse contra el plan o bloquearse en un negocio suspendido,
añade también los triggers `enforce_*_consistency`, `enforce_*_limit` y
`block_write_if_tenant_suspended` (calcados de `items`), y **acuérdate de
`admin_delete_tenant`**: la purga borra hijo→padre y una tabla nueva que no esté
en esa lista rompe el borrado por *foreign key*.

### 4.3 Tipo

En `src/types/db.ts`, snake_case igual que la columna:

```ts
export interface Widget {
  id: string
  tenant_id: string
  name: string
  created_by: string | null
  created_at: string
  updated_at: string
}
```

### 4.4 Hook

`src/hooks/widgets.ts`. Copia `src/hooks/items.ts`: una query por clave de cache,
`if (error) throw error` en cada llamada, e invalidar en `onSuccess` **todo lo que
la mutación deja desfasado** (casi siempre también `['dashboard']`).

```ts
export function useWidgets() {
  return useQuery({
    queryKey: ['widgets'],
    queryFn: async (): Promise<Widget[]> => {
      const { data, error } = await supabase.from('widgets').select('*')
      if (error) throw error
      return (data ?? []) as Widget[]
    },
  })
}
```

`tenant_id` no se pasa en el `select`: lo filtra la RLS. En el `insert` sí, y el
trigger de consistencia comprueba que sea el tuyo.

### 4.5 Pantalla

`src/features/widgets/WidgetsPage.tsx`, con las primitivas de
`src/components/ui/`. Luego: `lazyWithRetry` + `<Route path="widgets">` en
`src/App.tsx` y la entrada en el menú de `src/components/Layout.tsx`.

**Regla móvil:** tabla en `lg:` y `DataList`/`DataRow` + `ActionMenu` abajo.
Ningún listado puede exigir scroll horizontal en el teléfono; revísalo a 360 px.

---

## 5. El primer super-admin

El panel `/admin` (ver todos los negocios, cambiar planes, suspender, borrar) lo
abre quien esté en `platform_admins`. Esa tabla **no se puede escribir desde el
cliente** —RLS sin políticas de escritura— y la RPC que da de alta a los demás
exige ya ser super-admin. Al primero hay que darlo de alta desde fuera:

1. Crea la cuenta en **Auth → Users → Add user** (marca *Auto Confirm User*) o
   regístrate por la app **sin crear negocio**.
2. Abre `scripts/grant-platform-admin.sql`, cambia el correo y ejecútalo en el
   **SQL Editor** de Supabase. Es idempotente y trae dos consultas de
   verificación.

> Un super-admin **no puede tener negocio**. Las políticas de lectura
> cross-tenant exigen `auth_is_platform_admin() and auth_tenant_id() is null`: con
> `tenant_id`, el panel se queda ciego. Usa una cuenta aparte de la que uses como
> cliente.

---

## 6. Despliegue

El repo trae los dos destinos listos.

| | GitHub Pages | Vercel / Netlify |
|---|---|---|
| Archivo | `.github/workflows/deploy.yml` | `vercel.json` |
| `VITE_BASE` | `/mi-repo/` en *project page*; `/` en dominio propio o *user page* | `/` |
| `VITE_ROUTER` | vacío → **HashRouter** | `browser` → URLs limpias |
| URL | `…/#/items` | `…/items` |

**`VITE_BASE`, `VITE_ROUTER` y el dominio se cortan juntos.** Los dos errores que
dejan la app en blanco o en 404:

- `VITE_BASE=/mi-repo/` con un dominio propio: los `<script>` apuntan a
  `/mi-repo/assets/…`, que ahí no existe. Pantalla en blanco, sin error visible.
- `VITE_ROUTER=browser` en GitHub Pages: la portada carga, pero recargar en
  `/items` devuelve el 404 de Pages. Pages no sabe reescribir a `index.html`;
  por eso el HashRouter es el valor por defecto.

En Pages: **Settings → Pages → Source: GitHub Actions**, y los `VITE_*` como
*secrets* del repositorio (son públicos igual; van ahí solo para no fijar tu
proyecto Supabase en el código).

Y en los dos casos, añade el origen desplegado a `additional_redirect_urls` de
`supabase/config.toml` y haz `supabase config push`.

---

## 7. Variables de entorno

**Frontend** — `.env`, prefijo `VITE_`, **acaban dentro de `dist/` y son públicas**:

| Variable | Obligatoria | Para qué |
|---|---|---|
| `VITE_SUPABASE_URL` | sí | Project URL de Supabase |
| `VITE_SUPABASE_ANON_KEY` | sí | Clave `anon` (pública por diseño; **nunca** la `service_role`) |
| `VITE_APP_NAME` | no | Nombre visible; si falta, el de `src/lib/constants.ts` |
| `VITE_PUBLIC_URL` | recomendada | URL del sitio desplegado, para los enlaces que salen de la app |
| `VITE_BASE` | no | Prefijo del build. Por defecto `/` |
| `VITE_ROUTER` | no | `browser` para URLs limpias; vacío = HashRouter |

**Servidor** — `supabase secrets set …`, nunca con prefijo `VITE_`:

| Variable | Para qué |
|---|---|
| `RESEND_API_KEY` | Envío del correo de bienvenida. Sin ella la función responde `{ sent: false }` y el registro sigue funcionando |
| `WELCOME_FROM` | Remitente de ese correo, formato `Ferddo <hola@tudominio.com>`. **Ponla en producción:** el valor por defecto es `Ferddo <onboarding@resend.dev>`, el remitente de pruebas de Resend, que **solo entrega a la dirección dueña de la cuenta** — a cualquier otra falla, y la función traga el error y responde 200 |
| `PUBLIC_SITE_URL` | Dominio que enlaza ese correo |
| `SMTP_PASSWORD` | Correos de autenticación. Se pasa **al `config push`**, no a `secrets set` |

> El dominio de `WELCOME_FROM` tiene que estar **verificado en Resend**
> (*Domains → Add domain* y sus registros DNS). Sirve el mismo remitente que uses
> para el SMTP de autenticación.

> ⚠️ Nunca hagas `supabase config push` sin `SMTP_PASSWORD` (ni sin las dos
> variables de Google si lo tienes activo) en el entorno: el push sincroniza el
> archivo completo y dejaría esas credenciales vacías, tumbando todos los correos
> de autenticación.

---

## 8. Trampas ya pagadas

Están en `ARQUITECTURA.md` §12 con detalle. El resumen y el porqué:

1. **`clsx` tiene que ir en el chunk `vendor`** (`vite.config.ts` → `manualChunks`).
   Si cae en un chunk que el service worker no precachea, la app no llega ni a
   montar React: pantalla en blanco, sin error en pantalla.
2. **Los chunks *lazy* van con `CacheFirst`.** Tras un deploy, el `index.html`
   cacheado pide chunks que ya no existen. Mitigado además por `lazyWithRetry`
   (una recarga, una sola vez, con guard en `sessionStorage`) y el `ErrorBoundary`.
3. **Inputs a 16 px en móvil** (`src/index.css`, con `!important`). Por debajo,
   iOS hace zoom al enfocar y no vuelve. El `!important` es obligatorio: en
   Tailwind 3 la clase `text-sm` gana al selector de elemento. Y **nunca**
   `maximum-scale=1`: rompe la accesibilidad.
4. **`base` y dominio se cortan juntos** — ver §6.
5. **`statement_timeout`**: PostgREST lo hoistea y `authenticated` trae 8 s. Una
   RPC pesada (la purga de un negocio) fija su propio `set local statement_timeout`
   dentro de la función, o muere a mitad.
6. **Storage no se borra por SQL.** Borrar la fila deja el blob huérfano
   ocupando espacio para siempre. `admin_delete_tenant` devuelve las rutas y el
   cliente las vacía con la API (`removeTenantFiles`).
7. **Los triggers que reaccionan al DELETE rompen una purga**: un negocio
   suspendido no se podría borrar. De ahí la marca de transacción
   `ferddo.purging_tenant`.
8. **Tabla nueva ⇒ `revoke` explícito** — ver §4.2.
9. **No cambies el `buster` del persister** (`ferddo-v1`, en `src/main.tsx`) en
   un deploy: descarta la cola de mutaciones offline **sin subirla**.
10. **El guard de sesión de la cola offline va DENTRO del `mutationFn`**
    (`src/lib/offline.ts`). `QueryClient.mount()` se suscribe por su cuenta a
    `focusManager` y `onlineManager` y llama a `resumePausedMutations()`, que
    reanuda TODA la cola sin mirar quién está conectado: cualquier comprobación
    puesta fuera se la salta la propia librería. El camino de ejecución de la
    mutación es el único punto que no se puede esquivar.

---

## 9. Lo que no trae

| Falta | Dónde encajaría |
|---|---|
| **Pasarela de pago** | Edge Function + tabla de órdenes. El precio lo fija el servidor, acreditar tiene que ser idempotente y el webhook verificar la firma contra el cuerpo crudo. `plan_requests` es el hueco: hoy el super-admin aprueba a mano |
| **Tests** | Vitest + Testing Library para hooks y utilidades; para RLS, `supabase test db` (pgTAP) — es donde más rentan, porque una política mal escrita no da error, da resultados de menos… o de más |
| **i18n** | Todos los textos están en el JSX en español. Extraerlos a `react-intl`/`i18next` es mecánico pero toca cada pantalla |
| **Realtime** | `supabase.channel()` en la capa de hooks, invalidando la clave de cache correspondiente. Nunca en un componente |
| **Búsqueda y paginación de servidor** | Hoy se pagina en el cliente porque el plan acota la lista y es lo único que funciona sin conexión. Con volumen, `range()` + índices |
| **Borrado de la propia cuenta por el usuario** | Existe `admin_delete_tenant` para el super-admin; falta el equivalente auto-servicio |

---

## 10. Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm run build` | `tsc -b` + build a `dist/` |
| `npm run lint` | Solo tipos (`tsc -b --noEmit`) |
| `npm run icons` | Íconos PWA y favicon desde `public/logo.png` |
| `npm run rename` | Renombra `Ferddo`/`ferddo` (ver §2.1) |
| `npm run preview` | Sirve el `dist/` ya construido |
| `npm run db:push` | `supabase db push` — migraciones al proyecto enlazado |
| `npm run db:start` | `supabase start` — Supabase local con Docker |
| `npm run db:reset` | `supabase db reset` — recrea la base local desde cero |
| `npm run types:gen` | Tipos de la base local a `src/types/supabase.ts`. Solo de consulta: `src/types/db.ts`, el que importa la app, se escribe a mano |
| `supabase functions deploy welcome` | Despliega la Edge Function |

---

Documentación complementaria: **`ARQUITECTURA.md`** (el contrato: nombres de
tablas, firmas de RPC, claves de cache) y **`CLAUDE.md`** (convenciones para
trabajar en este repo).
