# Arquitectura del starter — CONTRATO VINCULANTE

Este documento es la **fuente de verdad** del proyecto. Todo archivo generado
debe respetarlo al pie de la letra: nombres de tablas, firmas de RPC, nombres de
tipos TypeScript, rutas de archivo, claves de cache y variables de entorno.
Si algo no está aquí, sigue el patrón del archivo hermano más cercano.

Destilado de MisanRD (`/Users/robertochacona/Documents/Projects/MisanRD`), que es
la referencia viva: cuando dudes de un detalle de implementación, **lee el archivo
equivalente allí** y adáptalo quitando el dominio (sanes/participantes/pagos).

> **Ferddo (ERP/POS/e-CF).** Este contrato describe el núcleo SaaS heredado del
> starter (0001–0011). El dominio de Ferddo —multiempresa con `tenant_members`,
> permisos, catálogo, inventario, POS, caja, e-CF, compras, gastos, cotizaciones,
> reportes— está en las migraciones **0012–0019**, en `src/types/erp.ts` y en
> **`docs/SAAS_IMPLEMENTATION_PLAN.md`**, que mandan sobre lo que aquí diga de
> `items` (entidad retirada) o de `profiles.tenant_id` (ahora = empresa ACTIVA).

---

## 0. Identidad y marcadores de posición

| Concepto | Valor en el starter | Dónde aparece |
|---|---|---|
| Nombre visible | `Ferddo` | UI, títulos, correos |
| Slug de máquina | `ferddo` | claves de storage, `project_id`, package name |
| Paquete npm | `saas-starter` | `package.json` name |
| Dominio ejemplo | `https://ferddo.com` | `index.html`, `config.toml` |
| Entidad de dominio de ejemplo | `items` / `Item` | tabla, tipo, hooks, feature |

`scripts/rename.mjs` reemplaza `Ferddo`/`ferddo` en todo el repo. **Nunca**
escribas "MisanRD", "san", "sanes", "participante", "cuota", "moroso" ni "PayPal"
en el código generado: el starter es genérico.

Idioma: **comentarios y textos de UI en español**. Identificadores en inglés.

---

## 1. Stack (fijo, no negociable)

- React 18.3 + TypeScript 5.7 `strict` + Vite 6
- Tailwind CSS 3.4 (sin librería de UI; primitivas propias)
- `react-router-dom` 6 — **HashRouter por defecto**, conmutable a BrowserRouter
  con `VITE_ROUTER=browser` (ver §7)
- TanStack Query 5 + `@tanstack/react-query-persist-client` + `query-sync-storage-persister`
- `@supabase/supabase-js` 2
- `react-hook-form` + `zod` + `@hookform/resolvers`
- `lucide-react`, `clsx`, `date-fns`
- `vite-plugin-pwa` (workbox)
- Backend: Supabase (Postgres + Auth + Storage + RLS + Edge Functions Deno)

Alias `@/` → `src/`, declarado **en `vite.config.ts` Y en `tsconfig.app.json`**.

---

## 2. Modelo de datos (SQL)

### 2.1 Enums

```
member_role          = ('owner', 'admin')
subscription_status  = ('trial', 'active', 'past_due', 'canceled')
plan_code            = ('basic', 'pro')
item_status          = ('draft', 'active', 'archived')
plan_request_status  = ('pending', 'approved', 'rejected')
```

### 2.2 Tablas del núcleo

**`tenants`** — el negocio / espacio de trabajo
```
id uuid pk default gen_random_uuid()
name text not null
logo_url text
phone text
whatsapp text
email text
address text
currency text not null default 'DOP'
locale text not null default 'es-DO'
suspended_at timestamptz          -- lo mueve SOLO el super-admin
created_by uuid references auth.users(id) on delete set null
created_at timestamptz not null default now()
updated_at timestamptz not null default now()
```

**`profiles`** — 1 por usuario de auth; lo enlaza a su tenant
```
id uuid pk references auth.users(id) on delete cascade
tenant_id uuid references tenants(id) on delete cascade   -- NULL = sin negocio
full_name text
avatar_url text
role member_role not null default 'owner'
created_at timestamptz not null default now()
```

**`subscriptions`** — 1 por tenant (`tenant_id` es `unique`)
```
id uuid pk
tenant_id uuid not null unique references tenants(id) on delete cascade
plan plan_code not null default 'basic'
status subscription_status not null default 'trial'
started_at timestamptz not null default now()
trial_ends_at timestamptz
current_period_end timestamptz
updated_at timestamptz not null default now()
```

**`items`** — ENTIDAD DE EJEMPLO. Es el molde que copiará quien use el starter.
Debe demostrar el patrón completo: tenant_id + RLS + tope de plan + guard de
consistencia + updated_at.
```
id uuid pk
tenant_id uuid not null references tenants(id) on delete cascade
name text not null
description text
amount numeric(12,2) not null default 0 check (amount >= 0)
status item_status not null default 'draft'
due_date date
created_by uuid references auth.users(id) on delete set null
created_at timestamptz not null default now()
updated_at timestamptz not null default now()
índices: items_tenant_idx (tenant_id), items_status_idx (tenant_id, status)
```

**`notifications`** — `id, tenant_id, title, body, read bool default false, created_at`
**`audit_logs`** — `id, tenant_id, user_id, action, entity, entity_id, meta jsonb, created_at`
  índice `(tenant_id, created_at desc)`

### 2.3 Tablas de plataforma / plan

**`tenant_invites`** (0006)
```
id, tenant_id fk, code text unique default encode(gen_random_bytes(9),'hex'),
email text, role member_role default 'admin',
created_by, expires_at default now()+14d, accepted_at, accepted_by, created_at
```

**`platform_admins`** (0007) — `user_id uuid pk references auth.users, note text, created_at`
  RLS activada, **SELECT solo para super-admins, sin políticas de escritura**.

**`plan_settings`** (0009) — única fuente de verdad de precios y topes
```
plan plan_code primary key
name text not null
price_monthly numeric(12,2) not null default 0 check (>= 0)
price_usd     numeric(12,2) not null default 0 check (>= 0)
max_items     integer            -- NULL = ilimitado
max_members   integer            -- NULL = ilimitado
features      text[] not null default '{}'
is_offered    boolean not null default true
is_featured   boolean not null default false
sort_order    integer not null default 0
updated_at timestamptz not null default now()
updated_by uuid references auth.users(id) on delete set null
```
Siembra: `basic` (Gratis, max_items 10, max_members 1, sort 1, offered) y
`pro` (price_monthly 1500, price_usd 25, max_items NULL, max_members NULL,
sort 2, offered, featured).
RLS: `select` para `anon, authenticated` (la landing muestra precios sin sesión).
Además `revoke insert, update, delete on plan_settings from anon, authenticated`.

**`plan_requests`** (0010)
```
id, tenant_id fk, requested_plan plan_code, status plan_request_status default 'pending',
note text, requested_by uuid, resolved_by uuid, resolved_at timestamptz, created_at
```

**`tenant_purges`** (0011) — bitácora de negocios eliminados.
`tenant_id` va **SIN foreign key** (debe sobrevivir al borrado del tenant).
```
id, tenant_id uuid not null, tenant_name text, owner_email text,
deleted_by uuid, deleted_by_email text, deleted_users boolean,
counts jsonb not null default '{}', created_at
```

---

## 3. Funciones SQL (firmas exactas)

### 3.1 Predicados base (todas `stable security definer set search_path = public`)
```sql
auth_tenant_id() returns uuid                -- select tenant_id from profiles where id = auth.uid()
auth_is_owner() returns boolean              -- role = 'owner'
auth_is_platform_admin() returns boolean     -- exists en platform_admins
```
`auth_is_platform_admin` se concede a `authenticated, anon`; las otras a `authenticated`.

### 3.2 Triggers genéricos
```sql
set_updated_at()            -- before update en tenants, profiles(no), subscriptions, items
profiles_guard()            -- before update: tenant_id y role INMUTABLES (excepto super-admin)
tenants_guard()             -- before update: suspended_at solo lo cambia el super-admin
block_write_if_tenant_suspended()  -- before insert/update/DELETE en items y notifications
enforce_item_consistency()  -- before insert/update en items: el tenant_id debe ser auth_tenant_id()
enforce_item_limit()        -- before insert en items: lee max_items de plan_settings
enforce_member_limit()      -- before insert en profiles: lee max_members de plan_settings
```
`block_write_if_tenant_suspended` **debe eximir al super-admin y a la purga**
(si no, un negocio suspendido no se puede borrar). Usa
`current_setting('ferddo.purging_tenant', true)` como marca de transacción y un
helper `is_purging_tenant()`.

### 3.3 Casos de uso
```sql
setup_tenant(p_name text, p_full_name text default null, p_whatsapp text default null) returns uuid
  -- idempotente; rechaza a super-admins; crea tenants + profiles(owner) + subscriptions(basic/trial 30d)
create_invite(p_role member_role default 'admin', p_email text default null) returns text
  -- solo owner; exige plan con max_members NULL o > 1; error 'PLAN_LIMIT_MEMBERS: ...'
accept_invite(p_code text) returns uuid
  -- reclamo ATÓMICO (update condicional + get diagnostics row_count); rechaza super-admins
  -- y a quien ya tenga profile
request_plan_change(p_plan plan_code, p_note text default null) returns uuid
dashboard_summary() returns jsonb
  -- { total_items, active_items, draft_items, archived_items, amount_total,
  --   amount_this_month, members, created_this_week }
```

### 3.4 RPCs de super-admin (todas con guardia `if not auth_is_platform_admin() then raise exception 'No autorizado'`)
```sql
admin_overview() returns jsonb
admin_list_tenants() returns jsonb
admin_tenant_summary(p_tenant uuid) returns jsonb
admin_set_subscription(p_tenant uuid, p_plan plan_code, p_status subscription_status default null) returns void
admin_set_tenant_suspended(p_tenant uuid, p_suspended boolean) returns void
admin_list_members(p_tenant uuid) returns jsonb
admin_set_member_role(p_tenant uuid, p_user uuid, p_role member_role) returns void
admin_remove_member(p_tenant uuid, p_user uuid) returns void
admin_set_user_banned(p_user uuid, p_banned boolean) returns void      -- update auth.users.banned_until
admin_grant_platform_admin(p_email text, p_note text default null) returns uuid
admin_revoke_platform_admin(p_user uuid) returns void
admin_list_platform_admins() returns jsonb
admin_update_plan(p_plan plan_code, p_name text default null, p_price_monthly numeric default null,
                  p_price_usd numeric default null, p_max_items integer default null,
                  p_max_members integer default null, p_clear_max boolean default false,
                  p_features text[] default null, p_is_offered boolean default null,
                  p_is_featured boolean default null, p_sort_order integer default null) returns jsonb
admin_list_plan_requests(p_status text default null) returns jsonb
admin_resolve_plan_request(p_id uuid, p_approve boolean, p_note text default null) returns void
admin_tenant_purge_preview(p_tenant uuid) returns jsonb
admin_delete_tenant(p_tenant uuid, p_confirm_name text, p_delete_users boolean default false) returns jsonb
admin_list_tenant_purges(p_limit integer default 20) returns jsonb
```

**Invariantes obligatorias:**
- `admin_grant_platform_admin` exige una cuenta **sin** `profiles.tenant_id`.
- `admin_revoke_platform_admin` y `admin_set_member_role`/`admin_remove_member`
  garantizan ≥1 super-admin y ≥1 owner por tenant, con
  `pg_advisory_xact_lock` para evitar write-skew.
- `admin_delete_tenant` compara el nombre con una función `norm_name()` que
  normaliza igual que `norm()` en TS (trim, colapsar espacios incl. U+00A0,
  minúsculas). Pone `set local statement_timeout = '50s'` dentro de la función,
  marca `set local ferddo.purging_tenant = <tenant>`, borra **hijo→padre** y
  devuelve `{ tenant_id, name, counts, files }` con las rutas de Storage para
  que el cliente las vacíe con la API.
- Toda RPC lleva `revoke all ... from public` + `grant execute ... to authenticated`.

---

## 4. RLS — reglas de oro

1. Toda tabla con `tenant_id` lleva `enable row level security` y una política
   `for all to authenticated using (tenant_id = auth_tenant_id()) with check (tenant_id = auth_tenant_id())`.
2. `profiles`: **sin política de INSERT** (el único camino es `setup_tenant` /
   `accept_invite`). SELECT: `tenant_id = auth_tenant_id() or id = auth.uid()`.
   UPDATE: `id = auth.uid()` (+ `profiles_guard`).
3. `subscriptions`: **solo SELECT** para el cliente.
4. `tenants`: SELECT `id = auth_tenant_id()`; INSERT `created_by = auth.uid()`;
   UPDATE `id = auth_tenant_id()` (+ `tenants_guard`).
5. `tenant_invites`: SELECT y DELETE solo `tenant_id = auth_tenant_id() and auth_is_owner()`.
   Sin INSERT/UPDATE de cliente.
6. `platform_admins`: SELECT solo super-admin. Sin escritura de cliente.
7. `plan_settings`: SELECT para `anon, authenticated`. Sin escritura (+ `revoke`).
8. Lectura cross-tenant del super-admin: políticas **PERMISIVAS y SOLO SELECT**,
   predicado `auth_is_platform_admin() and auth_tenant_id() is null`, aplicadas a
   `tenants, profiles, subscriptions, items, notifications, audit_logs,
   plan_requests, tenant_purges`.
   **EXCLUIDAS a propósito** (secretos bearer): `tenant_invites`.

---

## 5. Storage

Buckets: `logos` (público) y `files` (privado).
Convención de rutas: `<tenant_id>/...`; las políticas comparan
`(storage.foldername(name))[1] = auth_tenant_id()::text`.
El super-admin obtiene acceso a una carpeta **solo si ese tenant aparece en
`tenant_purges`** (para poder vaciarla tras el borrado).

---

## 6. Tipos TypeScript — `src/types/db.ts`

Exporta exactamente (mismos nombres, mismo casing snake_case en los campos):
```ts
MemberRole, SubscriptionStatus, PlanCode, ItemStatus, PlanRequestStatus
Tenant, Profile, Subscription, Item, Notification, AuditLog
PlanSettingRow            // vive en hooks/plans.ts, NO aquí
AdminOverview, AdminTenantRow, AdminMember, PlatformAdminRow,
AdminTenantSummary, MyPlanRequest, AdminPlanRequestRow,
AdminTenantPurgePreview, AdminTenantPurgeResult, AdminTenantPurgeRow,
DashboardSummary
```

---

## 7. Frontend — contrato de módulos

### 7.1 `src/lib/supabase.ts`
```ts
export const supabase        // storageKey: 'ferddo-auth'
export const hasSupabaseConfig: boolean
export const functionsUrl: string   // `${url}/functions/v1`
```
Si faltan las env, `console.error` claro y `createClient(url ?? '', key ?? '')`.

### 7.2 `src/lib/queryClient.ts`
`staleTime: 30_000`, `gcTime: 14 días`, `retry: 1`,
`refetchOnWindowFocus: false`, `mutations.networkMode: 'always'`.

### 7.3 `src/lib/offline.ts`
```ts
export const OFFLINE_CREATE_ITEM_KEY = ['createItem'] as const
export const persister                    // localStorage, key 'ferddo-query-cache'
export class NotMyQueueError extends Error // centinela: sin sesión, o cola de otra cuenta
export function pendingSyncCount(qc): number
export function registerOfflineMutations(qc): void
export async function resumeIfAuthed(qc): Promise<void>
export async function flushOfflineQueue(qc): Promise<number>
export async function clearOfflineCache(qc): Promise<void>
```
`registerOfflineMutations` fija `networkMode:'online'` para `OFFLINE_CREATE_ITEM_KEY`,
con `mutationFn` idempotente (id de cliente `crypto.randomUUID()`, trata el código
`23505` como éxito) y `onMutate` optimista sobre `['items']`.

**El guard de propiedad va DENTRO del `mutationFn`, y esto no es negociable.**
`QueryClient.mount()` —que `QueryClientProvider` llama al montar— se suscribe a
`focusManager` y a `onlineManager` y ejecuta `resumePausedMutations()` por su
cuenta, que reanuda *todas* las mutaciones pausadas sin mirar la sesión:

```js
// @tanstack/query-core · mutationCache.js
resumePausedMutations() {
  const pausedMutations = this.getAll().filter((x) => x.state.isPaused)
  ...
}
```

Por eso cualquier comprobación colocada fuera (en `resumeIfAuthed`, en un
`useEffect`, en el `onAuthStateChange`) es decorativa: la librería reanuda antes
y por otro camino. Sin el guard interno, cerrar sesión con trabajo en cola hace
que se reintente como `anon`, la RLS devuelva 42501, se agoten los reintentos, la
mutación pase a `error` y **desaparezca de localStorage en el siguiente volcado**:
pérdida silenciosa de datos.

El guard lee `supabase.auth.getSession()` (localStorage, sin red) y lanza
`NotMyQueueError` sin tocar la base. La política de reintento lo trata como
siempre reintentable con un minuto de espera, para que no gaste el presupuesto de
los fallos reales:
```ts
retry:      (n, err) => err instanceof NotMyQueueError ? true : n < 3
retryDelay: (n, err) => err instanceof NotMyQueueError ? 60_000 : Math.min(1000 * 2 ** n, 30_000)
```
`resumeIfAuthed` reanuda las mutaciones `isPaused` **o** `pending` del usuario
actual — hoy es una optimización, no la defensa. `clearOfflineCache` **conserva**
la cola.

### 7.4 `src/lib/constants.ts`
```ts
APP_NAME, APP_TAGLINE, PUBLIC_URL, LEGAL_CONTACT_EMAIL
PlanInfo { code, name, price, priceUsd, maxItems, maxMembers, features,
           isOffered, isFeatured, sortOrder }
PLANS: Record<PlanCode, PlanInfo>          // respaldo offline
PLAN_ORDER: PlanCode[]
ITEM_STATUS_LABEL: Record<ItemStatus, string>
planOrderFrom(plans), planPriceLabel(plan)
LEGAL_PATHS = { privacy: '/privacidad', terms: '/terminos' }
CLEAN_PATHS: readonly string[]
appUrl(path), legalUrl(page)
```

### 7.5 `src/lib/router.tsx`
```ts
export const AppRouter   // HashRouter por defecto; BrowserRouter si VITE_ROUTER === 'browser'
export const IS_HASH_ROUTER: boolean
export function routeHref(path: string): string   // '#/x' o '/x' según el modo
```

### 7.6 `src/auth/AuthProvider.tsx`
API pública **exacta** (`useAuth()`):
```ts
{ loading, session, user, profile, tenant, subscription,
  plan: PlanInfo, plans: Record<PlanCode, PlanInfo>,
  needsOnboarding, contextReady, isPlatformAdmin, isOwner,
  refresh(): Promise<void>, signOut(): Promise<void> }
```
Reglas copiadas de MisanRD y obligatorias:
- `loadContext` usa un contador de generación (`loadSeq`) para descartar cargas obsoletas.
- Si la consulta de `profiles` **falla**, NO se pisa el perfil con `null`.
- `contextFor` guarda el uid ya cargado; `contextReady = uid === contextFor`.
- `needsOnboarding = Boolean(user) && contextReady && !profile?.tenant_id && !isPlatformAdmin`.
- `signOut` hace `flushOfflineQueue` → `supabase.auth.signOut()` → `clearOfflineCache`.

### 7.7 `src/App.tsx`
- `lazyWithRetry` con guard `sessionStorage` clave **`ferddo-chunk-reloaded`**
  (idéntica a la del listener `vite:preloadError` en `main.tsx`).
- Guards: `PublicOnly`, `ProtectedLayout`, `RequirePlatformAdmin`, `OnboardingGuard`,
  `SuspendedScreen`, `FullLoader`.
- Rutas:
  ```
  /privacidad /terminos                    públicas, sin guard
  /login /registro /recuperar              PublicOnly
  /restablecer                             sin guard (llega con sesión de recuperación)
  /bienvenida                              OnboardingGuard
  /admin  /admin/negocio/:id               RequirePlatformAdmin
  ProtectedLayout:
    index → DashboardPage
    /items  /items/:id(no)  → ItemsPage
    /configuracion → SettingsPage
    /perfil → ProfilePage
  *  → Navigate to '/'
  ```
- Visitante sin sesión en `/` → `<LandingPage/>`; en cualquier otra ruta protegida → `/login`.

### 7.8 `src/main.tsx`
Orden estricto de imports con efecto secundario:
`@/lib/recoveryBootstrap` → `@/lib/cleanPaths`, luego React.
Árbol: `StrictMode > ErrorBoundary > PersistQueryClientProvider > AuthProvider > ToastProvider > App`.
`persistOptions`: `maxAge` 14 días, `buster: 'ferddo-v1'`,
`dehydrateOptions.shouldDehydrateMutation: (m) => m.state.isPaused || m.state.status === 'pending'`
(lo `pending` también: una mutación que espera a que vuelva su dueño no está
`paused`, y con el filtro estrecho se caía de localStorage al recargar),
`onSuccess: () => void resumeIfAuthed(queryClient)`.
Listener `vite:preloadError` con el mismo guard de recarga única.

### 7.9 Primitivas de UI — `src/components/ui/`
Firmas que el resto del código asume:
```
Button.tsx      export const Button  (forwardRef; variant: primary|secondary|outline|ghost|danger,
                                      size: sm|md|lg|icon, loading?: boolean)
Card.tsx        export function Card, CardHeader({title,subtitle,action}), CardBody
Input.tsx       export const Input, Textarea (forwardRef); export function Field({label,hint,error,required,children})
Select.tsx      export const Select (forwardRef)
Modal.tsx       export function Modal({open,onClose,title,children,footer,size?})
Badge.tsx       export function Badge({tone: 'brand'|'green'|'amber'|'red'|'slate', children})
DataList.tsx    export function DataList, DataRow({title,titleExtra,subtitle,badges,actions,leading,tone,onClick}),
                DataFields, DataField({label,children})
ActionMenu.tsx  export type ActionItem {label,icon?,onClick,tone?,disabled?,hint?}
                export function ActionMenu({items,label?,title?,className?})
StatCard.tsx    export function StatCard({label,value,icon,tone?,hint?})
Pagination.tsx  export function Pagination({page,pageSize,total,onPage}); export function paginate<T>()
Segmented.tsx   export function Segmented<T extends string>({value,onChange,options})
misc.tsx        export function Spinner({size?}), PageLoader({label?}), EmptyState({icon,title,description,action}), Avatar({name,src?,size?})
toast.tsx       export function ToastProvider, useToast(): {show,success,error,info}
```
Reglas: `cn()` de `@/lib/cn` para clases; `forwardRef` + `...props` en las que
envuelven un elemento HTML; variantes por **objeto de lookup**, nunca ternarios
encadenados.

### 7.10 Regla móvil (obligatoria)
Ningún listado puede exigir scroll horizontal en el teléfono. Patrón:
```tsx
<div className="hidden overflow-x-auto lg:block"><table>…</table></div>
<DataList>{rows.map(r => <DataRow … actions={<ActionMenu items={…}/>} />)}</DataList>
```
Revisar cada pantalla a 360 px.

### 7.11 Claves de cache (query keys)
```
['plan-settings']                 ['dashboard']
['team','members']  ['team','invites']
['my-plan-request']               ['admin','overview'] ['admin','tenants']
['admin','members', tenantId]     ['admin','plan-requests'] ['admin','platform-admins']
['admin','tenant-summary', id]    ['admin','purges']
```

**Ferddo (ERP).** Claves añadidas — no inventes otras para estos datos:
```
['my-tenants'] ['business-types'] ['permissions-catalog'] ['plan-usage']
['branches'] ['registers'] ['taxes'] ['categories'] ['products'] ['stock', branchId] ['stock','all']
['customers'] ['customer-balances'] ['suppliers'] ['receivables'] ['payables']
['inventory', …] ['sales', filtros] ['sales','detail',id] ['cash', …] ['pos', …]
['purchases', …] ['expenses', …] ['quotations', …] ['ecf', …] ['reports', …]
['team','members'] ['team','invites'] ['team','role-permissions']
```
`['dashboard']` sigue siendo el comodín que invalida toda mutación que mueve cifras.

### 7.12 Hooks — `src/hooks/`
```
core.ts      lecturas compartidas del ERP (useBranches, useRegisters, useTaxes, useProducts,
             useStockMap, useCustomers, useCustomerBalances, useSuppliers, useMyTenants…)
settings.ts  sucursales, cajas, impuestos
pos.ts sales.ts cash.ts products.ts inventory.ts customers.ts receivables.ts suppliers.ts
purchases.ts payables.ts expenses.ts quotations.ts invoicing.ts reports.ts  (uno por módulo)
tenant.ts    useUpdateTenant()
profile.ts   useUpdateProfile(), useChangePassword(), useChangeEmail(), useSignOutOthers()
items.ts     useItems(), useItem(id), useCreateItem(), useUpdateItem(), useDeleteItem()
dashboard.ts useDashboard()
plans.ts     PlanSettingRow, fetchPlanSettings(), toPlanMap(), usePlanSettings(), useAdminUpdatePlan()
plan.ts      useMyPlanRequest(), useRequestPlanChange(), useMyPlanUsage()
team.ts      useTeamMembers(), usePendingInvites(), useCreateInvite(), useRevokeInvite(), useAcceptInvite()
admin.ts     useAdminOverview, useAdminTenants, useAdminUpdateSubscription, useAdminSetTenantSuspended,
             useAdminTenantSummary, useAdminMembers, useAdminSetMemberRole, useAdminRemoveMember,
             useAdminSetUserBanned, useAdminPlanRequests, useAdminResolvePlanRequest,
             useAdminPlatformAdmins, useAdminGrantPlatformAdmin, useAdminRevokePlatformAdmin,
             useAdminTenantPurgePreview, useAdminDeleteTenant, useAdminTenantPurges
```
**Ningún componente importa `supabase` directamente.** Única excepción:
`AuthProvider.tsx` y `pages/auth/*` (login, registro, OAuth, recuperación).

---

## 8. Variables de entorno

Frontend (`VITE_`, PÚBLICAS — acaban en `dist`):
```
VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_APP_NAME,
VITE_PUBLIC_URL, VITE_BASE, VITE_ROUTER
```
Servidor (secretos de Supabase, NUNCA `VITE_`):
```
SMTP_PASSWORD, RESEND_API_KEY, PUBLIC_SITE_URL
```

---

## 9. Build y despliegue

`vite.config.ts`:
- `base = process.env.VITE_BASE ?? '/'`
- alias `@`
- `VitePWA` con `registerType:'autoUpdate'`, manifest, `globPatterns`
  incluyendo `assets/index-*.js` y `assets/vendor-*.js`,
  `runtimeCaching`: (a) `CacheFirst` `app-assets` para
  `request.destination==='script' && sameOrigin && pathname.includes('/assets/')`;
  (b) `NetworkFirst` `supabase-read` para GET a `/(rest|storage)/` de supabase.
- `manualChunks`: `vendor` = react, react-dom, react-router, @tanstack, @supabase,
  lucide-react, date-fns **y `/clsx`** (crítico: si `clsx` cae en un chunk no
  precacheado, la app no monta y la pantalla queda en blanco antes de React).

Se entregan **los dos** destinos:
- `.github/workflows/deploy.yml` → GitHub Pages (secrets `VITE_*`, `npm ci`, `npm run icons`, `npm run build`).
- `vercel.json` → rewrite SPA a `/index.html`.

---

## 10. Migraciones (nombres exactos y orden)

```
0001_schema.sql            enums + tenants, profiles, subscriptions, items, notifications, audit_logs
0002_functions.sql         auth_tenant_id, auth_is_owner, set_updated_at, setup_tenant,
                           enforce_item_limit, enforce_member_limit, dashboard_summary
0003_rls.sql               RLS de todas las tablas de 0001
0004_storage.sql           buckets logos/files + políticas por carpeta
0005_security_hardening.sql profiles_guard, enforce_item_consistency, cierre del INSERT de profiles
0006_invites.sql           tenant_invites + create_invite + accept_invite (canje atómico) + auth_is_owner
0007_platform_admin.sql    platform_admins, auth_is_platform_admin, SELECT cross-tenant,
                           admin_overview/list_tenants/set_subscription, ortogonalidad
0008_platform_admin_ops.sql suspensión, tenants_guard, block_write_if_tenant_suspended,
                           gestión de miembros y de super-admins, admin_tenant_summary
0009_plan_settings.sql     plan_settings + topes leídos de la tabla + admin_update_plan
0010_plan_requests.sql     plan_requests + request_plan_change + admin_list/resolve
0011_delete_tenant.sql     tenant_purges + purge_preview + admin_delete_tenant + índices FK
```
Cada archivo abre con una cabecera `-- ═══ Ferddo · NNNN · <título> ═══` y
explica **por qué** existe, no solo qué hace. Idempotente donde se pueda
(`create table if not exists`, `drop policy if exists`, `create or replace`).

---

## 11. Inventario de archivos (dueño único por archivo)

```
raíz    package.json tsconfig.json tsconfig.app.json tsconfig.node.json
        vite.config.ts tailwind.config.js postcss.config.js index.html
        .gitignore .env.example vercel.json .github/workflows/deploy.yml
        public/.nojekyll public/robots.txt
scripts generate-icons.mjs  rename.mjs  grant-platform-admin.sql
src     main.tsx App.tsx index.css vite-env.d.ts
        auth/AuthProvider.tsx
        components/ErrorBoundary.tsx Layout.tsx Logo.tsx OfflineBar.tsx PageHeader.tsx
        components/ui/{Button,Card,Input,Select,Modal,Badge,DataList,ActionMenu,
                       StatCard,Pagination,Segmented,misc,toast}.tsx
        features/dashboard/DashboardPage.tsx
        features/items/{ItemsPage,ItemFormModal}.tsx
        features/settings/SettingsPage.tsx
        features/profile/ProfilePage.tsx
        features/admin/{AdminPage,AdminTenantDetail,PlansCard,DeleteTenantModal}.tsx
        features/landing/LandingPage.tsx
        features/legal/{LegalDoc,PrivacyPage,TermsPage}.tsx
        pages/auth/{AuthLayout,LoginPage,RegisterPage,ForgotPasswordPage,
                    ResetPasswordPage,OnboardingPage,GoogleButton}.tsx
        hooks/{tenant,profile,items,dashboard,plans,plan,team,admin}.ts
        lib/{supabase,queryClient,offline,cn,constants,errors,format,storage,
             router,recoveryBootstrap,cleanPaths}.ts(x)
        types/db.ts
supabase config.toml seed.sql migrations/*.sql
        functions/_shared/cors.ts  functions/welcome/{index.ts,email.ts}
        templates/{confirmation,recovery,magic_link}.html
docs    README.md CLAUDE.md ARQUITECTURA.md (este archivo)
```

---

## 12. Trampas ya pagadas — respétalas o las repites

1. **`clsx` fuera de `vendor`** ⇒ pantalla en blanco antes de React. Ver §9.
2. **Chunks lazy sin `CacheFirst`** ⇒ tras un deploy, import fallido y app muerta.
   Mitigado además con `lazyWithRetry` + `ErrorBoundary`.
3. **Inputs < 16 px en iOS** ⇒ zoom automático al enfocar. En `index.css`,
   `@media (max-width: 640px) { input, select, textarea { font-size: 16px !important } }`.
   El `!important` es obligatorio: en Tailwind v3 la clase `text-sm` gana al
   selector de elemento. **Nunca** usar `maximum-scale=1` ni `user-scalable=no`.
4. **`base` y dominio se cortan juntos**: con `base=/repo/` la app queda rota en
   un dominio propio. Por eso `VITE_BASE` es una variable.
5. **`statement_timeout`**: PostgREST lo hoistea y `authenticated` trae 8 s.
   Las RPC pesadas fijan `set local statement_timeout` dentro.
6. **Storage no se borra por SQL**: hacerlo deja el blob huérfano. La RPC
   devuelve rutas y el cliente las vacía con la API (`removeTenantFiles`).
7. **Triggers que reaccionan al DELETE** rompen una purga. De ahí la marca de
   transacción `ferddo.purging_tenant`.
8. **Tabla nueva ⇒ `revoke` explícito**: Supabase concede INSERT/UPDATE/DELETE a
   `anon`/`authenticated` por defecto; sin RLS de escritura el PATCH devuelve 204
   silencioso en vez de 42501.
9. **Guard de la cola offline DENTRO del `mutationFn`** — TanStack Query reanuda
   las mutaciones pausadas desde sus propios suscriptores de foco y red; un guard
   externo no se ejecuta. Ver §7.3.
10. **No cambiar el `buster` del persister** en un deploy: descarta la cola de
   mutaciones offline sin subir.

## 13. Calidad exigida

- `tsc -b --noEmit` sin errores, con `strict`, `noUnusedLocals`, `noUnusedParameters`.
- Sin `any` salvo en fronteras con datos crudos, y ahí acotado con un cast comentado.
- Comentarios que expliquen **por qué**, al estilo de MisanRD. No comentar lo obvio.
- Todo `.rpc()` y `.from()` comprueba `error` y lo lanza.
