-- ═══════════════════════════════════════════════════════════════════════════
-- Ferddo · 0003 · Row Level Security (aislamiento multi-tenant)
-- ═══════════════════════════════════════════════════════════════════════════
-- Esta migración es la que convierte la base en multi-tenant de verdad. Todo
-- lo demás (la UI, los hooks, las RPC) puede equivocarse y filtrar un id ajeno;
-- aquí es donde ese id deja de existir para quien no es su dueño.
--
-- Regla general: un usuario solo ve/edita filas cuyo tenant_id == su tenant,
-- donde "su tenant" lo resuelve auth_tenant_id() (0002, security definer: lee
-- profiles sin caer en la recursión de su propia RLS).
--
-- Dos cosas que NO están aquí a propósito:
--   · La lectura cross-tenant del super-admin llega en 0007, cuando existe
--     platform_admins. Es PERMISIVA y SOLO SELECT: el panel nunca escribe por
--     política, escribe por RPC definer con bitácora.
--   · profiles_insert existe hoy pero la 0005 la ELIMINA: dejar que el cliente
--     inserte su propio profile es un camino directo a colarse en un tenant
--     ajeno. Se conserva el paso intermedio para que la historia de por qué se
--     cerró quede en el repositorio, no en la memoria de alguien.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.tenants       enable row level security;
alter table public.profiles      enable row level security;
alter table public.subscriptions enable row level security;
alter table public.items         enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_logs    enable row level security;

-- ──────────────────────────────────────────────────────────────────────────
-- tenants — el negocio propio
-- ──────────────────────────────────────────────────────────────────────────
-- El INSERT se compara contra auth.uid() y no contra auth_tenant_id() porque en
-- el momento de crear el negocio el usuario todavía no tiene profile: su
-- auth_tenant_id() es null y cualquier predicado por tenant lo rechazaría.
-- (La vía normal sigue siendo setup_tenant(); esta política es la que permite
-- que esa RPC tenga un equivalente honesto desde el cliente si algún día hace
-- falta.) No hay política de DELETE: borrar un negocio es asunto del
-- super-admin, con confirmación de nombre y bitácora (0011).
drop policy if exists tenants_select on public.tenants;
create policy tenants_select on public.tenants
  for select to authenticated using (id = auth_tenant_id());

drop policy if exists tenants_insert on public.tenants;
create policy tenants_insert on public.tenants
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists tenants_update on public.tenants;
create policy tenants_update on public.tenants
  for update to authenticated
  using (id = auth_tenant_id())
  with check (id = auth_tenant_id());

-- ──────────────────────────────────────────────────────────────────────────
-- profiles — quién eres y a qué negocio perteneces
-- ──────────────────────────────────────────────────────────────────────────
-- El SELECT lleva el `or id = auth.uid()` para el usuario recién registrado:
-- su tenant_id es null, auth_tenant_id() es null, y sin esa rama no podría
-- leer ni su propia fila (null = null es null, no true) → onboarding roto.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (tenant_id = auth_tenant_id() or id = auth.uid());

-- OJO: la 0005 elimina esta política. Ver la cabecera.
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert to authenticated with check (id = auth.uid());

-- Solo tu propia fila, y aun así con límites: profiles_guard() (0005) congela
-- tenant_id y role para que un PATCH no sirva ni para mudarse de negocio ni
-- para auto-ascenderse a owner.
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ──────────────────────────────────────────────────────────────────────────
-- subscriptions — SOLO LECTURA desde el cliente
-- ──────────────────────────────────────────────────────────────────────────
-- El plan y su estado deciden los topes que cobra el producto: si el cliente
-- pudiera escribirlos, el plan gratuito sería infinito. Los mueve el
-- super-admin por RPC definer (0007/0008) tras resolver una solicitud (0010).
drop policy if exists subscriptions_select on public.subscriptions;
create policy subscriptions_select on public.subscriptions
  for select to authenticated using (tenant_id = auth_tenant_id());

-- ──────────────────────────────────────────────────────────────────────────
-- Tablas de trabajo del tenant — lectura y escritura completas dentro de casa
-- ──────────────────────────────────────────────────────────────────────────
-- `using` filtra lo que puedes ver/tocar; `with check` valida la fila
-- RESULTANTE. Hacen falta las dos: sin `with check` podrías insertar filas con
-- el tenant_id de otro (escritura cross-tenant) o mover las tuyas fuera.
drop policy if exists items_all on public.items;
create policy items_all on public.items
  for all to authenticated
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

drop policy if exists notifications_all on public.notifications;
create policy notifications_all on public.notifications
  for all to authenticated
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

drop policy if exists audit_logs_all on public.audit_logs;
create policy audit_logs_all on public.audit_logs
  for all to authenticated
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

-- ──────────────────────────────────────────────────────────────────────────
-- Permisos de tabla explícitos (defensa en profundidad)
-- ──────────────────────────────────────────────────────────────────────────
-- Supabase concede INSERT/UPDATE/DELETE a `anon` y `authenticated` sobre las
-- tablas nuevas. Cuando ese GRANT sobra y solo lo frena la RLS, el intento no
-- falla: PostgREST responde 204 "No Content" —correcto, 0 filas afectadas— y
-- el ataque se ve igual que un no-op. Con el REVOKE responde 42501 y queda en
-- los registros. Es la diferencia entre enterarte y no enterarte.
--
-- `anon` no tiene NINGUNA política aquí (todas son `to authenticated`), así que
-- ya no podía escribir: el revoke solo cambia el silencio por un error ruidoso.
revoke insert, update, delete on
  public.tenants,
  public.profiles,
  public.subscriptions,
  public.items,
  public.notifications,
  public.audit_logs
from anon;

-- `authenticated`: se le quita lo que ninguna política le concede.
--   · subscriptions → lectura y nada más.
--   · tenants       → sin DELETE (lo borra el super-admin por RPC).
--   · profiles      → sin DELETE (un usuario no se "des-perfila"; se le quita
--                     del equipo por RPC, o cae en cascada con auth.users).
-- El INSERT de profiles sobrevive a esta migración porque su política todavía
-- existe; la 0005 quita las dos cosas a la vez.
revoke insert, update, delete on public.subscriptions from authenticated;
revoke delete                  on public.tenants       from authenticated;
revoke delete                  on public.profiles      from authenticated;

-- La lectura sí se hace explícita: de ella dependen el onboarding, el guard de
-- suscripción del layout y los topes que la UI muestra antes de intentar nada.
grant select on public.subscriptions to authenticated;
