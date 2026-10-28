-- ═══════════════════════════════════════════════════════════════════════════
-- Ferddo · 0002 · Funciones y triggers (lógica de negocio)
-- ═══════════════════════════════════════════════════════════════════════════
-- Aquí vive lo que la aplicación NO puede garantizar por sí sola:
--  · quién es el tenant del usuario (base de todo el RLS de 0003),
--  · el onboarding (crear negocio + perfil + suscripción en una transacción),
--  · los topes de plan (defensa en profundidad: la UI también los muestra,
--    pero quien llame a la API directamente choca igual contra el trigger),
--  · las métricas del dashboard en UNA sola ida y vuelta.
--
-- Convención de errores: los topes lanzan mensajes con prefijo de protocolo
-- ('PLAN_LIMIT_ITEMS: …'), porque src/lib/errors.ts recorta hasta el primer
-- ':' y enseña solo la parte amigable. Si cambias el prefijo, cambia allí.
-- ═══════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────────
-- auth_tenant_id() — tenant del usuario autenticado (cimiento del RLS)
-- ──────────────────────────────────────────────────────────────────────────
-- security definer: las políticas de profiles la invocan, y sin definer leer
-- profiles desde una política SOBRE profiles sería recursión infinita.
-- search_path fijo: una función definer sin search_path se puede secuestrar
-- creando objetos homónimos en un esquema temporal.
create or replace function public.auth_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id from public.profiles where id = auth.uid()
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- auth_is_owner() — ¿el usuario actual es dueño de su tenant?
-- ──────────────────────────────────────────────────────────────────────────
-- Separa "puede usar la app" (admin) de "puede tocar plan, equipo y negocio"
-- (owner). El coalesce evita que un usuario sin perfil devuelva NULL: en una
-- política un NULL se comporta como falso, pero un `not auth_is_owner()` en
-- plpgsql no, y ahí sí importa.
create or replace function public.auth_is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role = 'owner' from public.profiles where id = auth.uid()), false)
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- set_updated_at() — trigger genérico de marca de tiempo
-- ──────────────────────────────────────────────────────────────────────────
-- En la base y no en el cliente: así el reloj es el del servidor y ningún
-- cliente puede mentir con la fecha (ni olvidarse de mandarla).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tenants_updated on public.tenants;
create trigger trg_tenants_updated before update on public.tenants
  for each row execute function public.set_updated_at();

drop trigger if exists trg_subscriptions_updated on public.subscriptions;
create trigger trg_subscriptions_updated before update on public.subscriptions
  for each row execute function public.set_updated_at();

drop trigger if exists trg_items_updated on public.items;
create trigger trg_items_updated before update on public.items
  for each row execute function public.set_updated_at();

-- profiles NO lleva updated_at a propósito: es una fila de enlace, no un
-- documento editable, y su historial interesa en audit_logs.

-- ──────────────────────────────────────────────────────────────────────────
-- setup_tenant() — onboarding: negocio + perfil + suscripción
-- ──────────────────────────────────────────────────────────────────────────
-- security definer porque en este instante el usuario todavía NO tiene perfil:
-- auth_tenant_id() devuelve NULL y el RLS le cerraría las tres inserciones.
-- Es el ÚNICO camino de alta (profiles no tiene política de INSERT, ver 0005).
--
-- Idempotente: si el usuario ya tiene tenant devuelve el suyo en vez de crear
-- otro. El onboarding se reintenta solo tras un error de red y sin esto cada
-- reintento dejaría un negocio huérfano.
create or replace function public.setup_tenant(
  p_name text,
  p_full_name text default null,
  p_whatsapp text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_tenant uuid;
begin
  if v_uid is null then
    raise exception 'No autenticado';
  end if;

  select tenant_id into v_tenant from profiles where id = v_uid;
  if v_tenant is not null then
    return v_tenant; -- ya tiene negocio: no se crea otro
  end if;

  insert into tenants (name, whatsapp, created_by)
  values (
    coalesce(nullif(trim(p_name), ''), 'Mi negocio'),
    nullif(trim(p_whatsapp), ''),
    v_uid
  )
  returning id into v_tenant;

  -- Quien crea el negocio es su dueño; los demás entran como 'admin' por
  -- invitación (0006).
  insert into profiles (id, tenant_id, full_name, role)
  values (v_uid, v_tenant, nullif(trim(p_full_name), ''), 'owner');

  -- Prueba de 30 días sobre el plan básico. La suscripción se crea siempre,
  -- aunque el plan sea gratis: el resto del sistema asume que existe una fila.
  insert into subscriptions (tenant_id, plan, status, trial_ends_at)
  values (v_tenant, 'basic', 'trial', now() + interval '30 days');

  return v_tenant;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- Topes de plan (defensa en profundidad)
-- ──────────────────────────────────────────────────────────────────────────
-- ATENCIÓN: en esta migración los topes son CONSTANTES DE RESPALDO escritas a
-- mano, porque plan_settings todavía no existe (llega en 0009). La 0009
-- redefine estas dos funciones para leer max_items / max_members de la tabla y
-- que el super-admin pueda cambiarlos sin desplegar. No dupliques los números
-- en otro sitio: el frontend usa PLANS de constants.ts solo como respaldo
-- offline, la verdad está en la base.

create or replace function public.enforce_item_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan  plan_code;
  v_max   integer;
  v_count int;
begin
  select plan into v_plan from subscriptions where tenant_id = new.tenant_id;
  v_plan := coalesce(v_plan, 'basic'); -- sin suscripción se trata como básico

  -- NULL = ilimitado (misma semántica que plan_settings.max_items en 0009).
  v_max := case when v_plan = 'basic' then 10 else null end;

  if v_max is not null then
    select count(*) into v_count from items where tenant_id = new.tenant_id;
    if v_count >= v_max then
      raise exception 'PLAN_LIMIT_ITEMS: Tu plan permite máximo % items. Actualiza tu plan para crear más.', v_max;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_item_limit on public.items;
create trigger trg_enforce_item_limit
  before insert on public.items
  for each row execute function public.enforce_item_limit();

create or replace function public.enforce_member_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan  plan_code;
  v_max   integer;
  v_count int;
begin
  -- Un perfil sin negocio (recién registrado, o cuenta de plataforma) no ocupa
  -- cupo de nadie.
  if new.tenant_id is null then
    return new;
  end if;

  select plan into v_plan from subscriptions where tenant_id = new.tenant_id;
  v_plan := coalesce(v_plan, 'basic');

  v_max := case when v_plan = 'basic' then 1 else null end;

  if v_max is not null then
    -- El dueño del negocio recién creado siempre cabe: setup_tenant inserta su
    -- perfil ANTES que la suscripción, así que aquí el conteo todavía es 0.
    select count(*) into v_count from profiles where tenant_id = new.tenant_id;
    if v_count >= v_max then
      raise exception 'PLAN_LIMIT_MEMBERS: Tu plan permite % usuario(s) en el negocio. Actualiza tu plan para invitar a más personas.', v_max;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_member_limit on public.profiles;
create trigger trg_enforce_member_limit
  before insert on public.profiles
  for each row execute function public.enforce_member_limit();

-- ──────────────────────────────────────────────────────────────────────────
-- dashboard_summary() — todas las métricas del tenant en una sola llamada
-- ──────────────────────────────────────────────────────────────────────────
-- Una RPC en vez de seis consultas: el dashboard se abre en móviles con red
-- mala y cada ida y vuelta cuesta. Devuelve jsonb para poder añadir claves sin
-- romper a los clientes viejos (el tipo DashboardSummary las declara opcionales
-- donde toca).
--
-- Criterio de las ventanas de tiempo, para que la UI lo cuente igual:
--  · amount_this_month  → items CREADOS en el mes en curso (no vencimientos).
--  · created_this_week  → items creados desde el lunes (date_trunc('week')).
-- Ambas usan la zona horaria de la base; con un solo país es lo esperado.
create or replace function public.dashboard_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  t      uuid := auth_tenant_id();
  result jsonb;
begin
  -- Sin negocio (onboarding pendiente o super-admin) no hay nada que resumir.
  -- Se devuelve {} y no un error: el dashboard pinta ceros sin romperse.
  if t is null then
    return '{}'::jsonb;
  end if;

  select jsonb_build_object(
    'total_items',       (select count(*) from items where tenant_id = t),
    'active_items',      (select count(*) from items where tenant_id = t and status = 'active'),
    'draft_items',       (select count(*) from items where tenant_id = t and status = 'draft'),
    'archived_items',    (select count(*) from items where tenant_id = t and status = 'archived'),
    'amount_total',      (select coalesce(sum(amount), 0) from items where tenant_id = t),
    'amount_this_month', (select coalesce(sum(amount), 0) from items
                           where tenant_id = t and created_at >= date_trunc('month', now())),
    'members',           (select count(*) from profiles where tenant_id = t),
    'created_this_week', (select count(*) from items
                           where tenant_id = t and created_at >= date_trunc('week', now()))
  ) into result;

  return result;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- Permisos de ejecución
-- ──────────────────────────────────────────────────────────────────────────
-- Postgres concede EXECUTE a `public` en cada función nueva: sin el revoke,
-- hasta `anon` podría llamarlas. Se revoca primero y se concede solo lo justo.
--
-- `from public, anon` y no solo `from public`: las default privileges de
-- Supabase le dan a `anon` un EXECUTE NOMINAL propio, y revocar el de PUBLIC no
-- retira una concesión nominal. Sin el `, anon`, la clave anónima —que va
-- publicada en el bundle del navegador— entra igual al cuerpo de la función.
-- No hay escalada (la guardia interna para), pero es superficie de ataque
-- gratis. Misma convención en 0005-0011.
revoke all on function public.auth_tenant_id() from public, anon;
revoke all on function public.auth_is_owner() from public, anon;
revoke all on function public.setup_tenant(text, text, text) from public, anon;
revoke all on function public.dashboard_summary() from public, anon;

grant execute on function public.auth_tenant_id() to authenticated;
grant execute on function public.auth_is_owner() to authenticated;
grant execute on function public.setup_tenant(text, text, text) to authenticated;
grant execute on function public.dashboard_summary() to authenticated;

-- Las funciones de trigger no las llama nadie desde el cliente. Se les quita
-- EXECUTE a todo el mundo: los triggers siguen disparando igual, porque el
-- permiso se comprueba al CREAR el trigger, no al ejecutarlo.
revoke all on function public.set_updated_at() from public, anon;
revoke all on function public.enforce_item_limit() from public, anon;
revoke all on function public.enforce_member_limit() from public, anon;
