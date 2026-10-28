-- ═══════════════════════════════════════════════════════════════════════════
-- Ferddo · 0007 · Super-admin de PLATAFORMA (acceso cross-tenant)
-- ═══════════════════════════════════════════════════════════════════════════
-- Introduce un rol ORTOGONAL al modelo multi-tenant: el super-admin de
-- plataforma. No pertenece a ningún negocio; puede LEER todos los tenants
-- (soporte, auditoría) y ejecutar RPCs administrativas acotadas (cambiar plan
-- y estado de suscripción; la 0008 añade el resto).
--
-- INVARIANTE DE SEGURIDAD (esto NO debilita el aislamiento de 0003):
--   • Las políticas nuevas son PERMISIVAS y su predicado es
--     auth_is_platform_admin(), que es FALSE para todo usuario que no esté en
--     public.platform_admins. Un usuario normal ve exactamente lo mismo que
--     antes: su tenant y nada más. Una política permisiva solo SUMA filas a
--     quien cumple su predicado; no puede quitarle nada a nadie.
--   • No se abre NINGÚN camino de escritura cross-tenant por política: las
--     políticas nuevas son SOLO SELECT. Toda mutación administrativa va por
--     RPC SECURITY DEFINER con guardia explícita, que es donde se puede
--     validar, registrar y limitar.
--   • platform_admins NO tiene política de INSERT/UPDATE/DELETE → ningún
--     cliente (ni siquiera otro super-admin) puede auto-promoverse por REST.
--     El alta inicial se hace con service_role / SQL directo
--     (scripts/grant-platform-admin.sql); desde el panel, por RPC (0008).
--   • El predicado incluye `auth_tenant_id() is null` para preservar la
--     ortogonalidad del rol: un super-admin es un principal SIN negocio. Si
--     por error se promoviera a un dueño con negocio, NO vería datos ajenos
--     mezclados en la app operativa (seguiría viendo solo el suyo); el panel
--     /admin funciona igual porque usa RPCs definer, no RLS.
-- ═══════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────────
-- 1) Registro de super-admins
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  note       text,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;

-- ──────────────────────────────────────────────────────────────────────────
-- 2) Predicado base: ¿el usuario actual es super-admin de plataforma?
-- ──────────────────────────────────────────────────────────────────────────
-- SECURITY DEFINER para leer platform_admins sin recursión de su propia RLS
-- (mismo motivo que auth_tenant_id() en 0002). STABLE + búsqueda por PK: el
-- planificador la evalúa una vez por consulta, así que ponerla en una política
-- que se aplica fila a fila no cuesta nada.
-- Devuelve FALSE (no NULL) para anon y para cualquier no-admin.
create or replace function public.auth_is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.platform_admins where user_id = auth.uid()
  )
$$;

revoke all on function public.auth_is_platform_admin() from public;
-- También a `anon`: el arranque de la app pregunta "¿soy super-admin?" antes de
-- que la sesión esté resuelta, y una llamada sin sesión debe responder `false`,
-- no 42501.
grant execute on function public.auth_is_platform_admin() to authenticated, anon;

-- Los super-admins ven el listado; NADIE escribe desde el cliente.
drop policy if exists platform_admins_select on public.platform_admins;
create policy platform_admins_select on public.platform_admins
  for select to authenticated using (public.auth_is_platform_admin());
-- (sin políticas de insert/update/delete → escritura denegada por RLS)

-- Y los permisos de tabla detrás de esa decisión, para que un intento falle con
-- 42501 y no con un 204 silencioso (trampa conocida, ver 0003).
revoke all on public.platform_admins from anon;
revoke insert, update, delete on public.platform_admins from authenticated;
grant select on public.platform_admins to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 3) Lectura cross-tenant (políticas PERMISIVAS, SOLO SELECT)
-- ──────────────────────────────────────────────────────────────────────────
-- Se suman a las políticas por-tenant de 0003, de modo que el acceso queda:
--   (fila de mi propio tenant)  OR  (soy super-admin de plataforma sin negocio).
--
-- El bucle genera una política por tabla en vez de escribirlas a mano: son
-- idénticas salvo el nombre, y así añadir una tabla al panel es añadir una
-- línea al array (y no olvidarse de la mitad del predicado).
--
-- EXCLUIDA a propósito (mínimo privilegio sobre secretos al portador):
--   • tenant_invites → la columna `code` es la credencial para entrar a un
--     negocio ajeno. Soporte no la necesita para diagnosticar nada, y tenerla
--     al alcance ampliaría el daño si se comprometiera una sesión de admin.
--     Lo que sí hace falta (cuántas invitaciones hay vivas) se sirve desde una
--     RPC definer que devuelve conteos, no códigos (0008).
do $$
declare
  t    text;
  tbls text[] := array[
    'tenants', 'profiles', 'subscriptions', 'items', 'notifications', 'audit_logs'
  ];
begin
  foreach t in array tbls loop
    execute format('drop policy if exists %I on public.%I', t || '_platform_select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated '
      || 'using (public.auth_is_platform_admin() and public.auth_tenant_id() is null)',
      t || '_platform_select', t
    );
  end loop;
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- 4) RPCs administrativas (SECURITY DEFINER + guardia explícita)
-- ──────────────────────────────────────────────────────────────────────────
-- Todas empiezan igual: `if not auth_is_platform_admin() then raise`. Es
-- deliberadamente repetitivo y no se factoriza en un helper: la guardia tiene
-- que ser lo primero que se lee en cada función, no algo heredado de otra.

-- 4.a) Métricas globales de la plataforma (la portada de /admin)
create or replace function public.admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;

  select jsonb_build_object(
    'tenants',         (select count(*) from tenants),
    'members',         (select count(*) from profiles),
    'items',           (select count(*) from items),
    'active_items',    (select count(*) from items where status = 'active'),
    'amount_total',    (select coalesce(sum(amount), 0) from items),
    'platform_admins', (select count(*) from platform_admins),
    -- Agregados como objeto {plan: n} en vez de columnas fijas: si mañana el
    -- enum plan_code crece, la UI no se queda ciega ni hay que migrar nada.
    'by_plan', (
      select coalesce(jsonb_object_agg(plan_txt, c), '{}'::jsonb)
      from (select plan::text as plan_txt, count(*) c from subscriptions group by plan) q
    ),
    'by_status', (
      select coalesce(jsonb_object_agg(status_txt, c), '{}'::jsonb)
      from (select status::text as status_txt, count(*) c from subscriptions group by status) q
    )
  ) into result;

  return result;
end;
$$;

-- 4.b) Listado de todos los negocios, con su plan y su dueño
create or replace function public.admin_list_tenants()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;

  -- El `left join lateral` toma el owner MÁS ANTIGUO del negocio: un tenant
  -- puede tener varios owners tras una reasignación, y el listado necesita uno
  -- solo y estable (si no, la fila bailaría entre recargas).
  -- Los joins son `left` a propósito: un negocio sin suscripción o sin owner es
  -- una anomalía que el panel debe MOSTRAR, no esconder.
  select coalesce(jsonb_agg(t_row order by created_at desc), '[]'::jsonb)
  into result
  from (
    select
      t.created_at as created_at,
      jsonb_build_object(
        'id',            t.id,
        'name',          t.name,
        'created_at',    t.created_at,
        'whatsapp',      t.whatsapp,
        'currency',      t.currency,
        'plan',          s.plan,
        'sub_status',    s.status,
        'trial_ends_at', s.trial_ends_at,
        'owner_name',    o.full_name,
        'owner_email',   au.email,
        'members',       (select count(*) from profiles pr where pr.tenant_id = t.id),
        'items',         (select count(*) from items i where i.tenant_id = t.id),
        'active_items',  (select count(*) from items i where i.tenant_id = t.id and i.status = 'active'),
        'amount_total',  (select coalesce(sum(i.amount), 0) from items i where i.tenant_id = t.id)
      ) as t_row
    from tenants t
    left join subscriptions s on s.tenant_id = t.id
    left join lateral (
      select id, full_name
      from profiles
      where tenant_id = t.id and role = 'owner'
      order by created_at asc
      limit 1
    ) o on true
    left join auth.users au on au.id = o.id
  ) sub;

  return result;
end;
$$;
-- La 0008 la redefine para añadir la bandera `suspended`.

-- 4.c) Cambiar plan / estado de suscripción de cualquier negocio
create or replace function public.admin_set_subscription(
  p_tenant uuid,
  p_plan   plan_code,
  p_status subscription_status default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  if not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'Negocio no encontrado';
  end if;

  -- upsert: un negocio sin fila de suscripción (importado, o creado antes de
  -- que setup_tenant la insertara) se arregla al primer cambio de plan.
  -- p_status null = "no toques el estado": subir de plan no debe resucitar una
  -- suscripción cancelada sin que alguien lo pida explícitamente.
  insert into subscriptions (tenant_id, plan, status)
  values (p_tenant, p_plan, coalesce(p_status, 'active'))
  on conflict (tenant_id) do update
    set plan   = excluded.plan,
        status = coalesce(p_status, subscriptions.status);
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 5) Permisos de ejecución
-- ──────────────────────────────────────────────────────────────────────────
-- El revoke no es decorativo: sin él, `anon` podría llamar a admin_overview().
-- Fallaría en la guardia, sí, pero convierte una RPC de plataforma en un
-- oráculo gratis para cualquiera.
-- Y tiene que decir `from public, anon`: revocar solo el de PUBLIC deja intacto
-- el EXECUTE NOMINAL que las default privileges de Supabase le dan a `anon`
-- (ver 0002), o sea que el revoke a medias no cerraba nada.
-- auth_is_platform_admin() es la ÚNICA excepción de este archivo: ahí `anon`
-- tiene EXECUTE a propósito (ver el grant de la sección 2).
revoke all on function public.admin_overview()     from public, anon;
revoke all on function public.admin_list_tenants() from public, anon;
revoke all on function public.admin_set_subscription(uuid, plan_code, subscription_status) from public, anon;

grant execute on function public.admin_overview()     to authenticated;
grant execute on function public.admin_list_tenants() to authenticated;
grant execute on function public.admin_set_subscription(uuid, plan_code, subscription_status) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 6) Ortogonalidad del rol: un super-admin NUNCA obtiene profile ni tenant
-- ──────────────────────────────────────────────────────────────────────────
-- Defensa en profundidad. Los predicados de arriba exigen `auth_tenant_id() is
-- null`; aquí se cierran los DOS únicos caminos que crean un profile para que
-- esa condición no se pueda romper desde dentro:
--   · setup_tenant()  (0002) — crear tu propio negocio.
--   · accept_invite() (0006) — canjear un código de otro.
-- Sin esto, un super-admin que se creara un negocio (o al que le filtraran un
-- código de invitación) perdería la lectura cross-tenant Y ganaría un tenant
-- propio: el peor de los dos mundos, y en silencio.
--
-- Las dos funciones se copian ENTERAS desde su versión anterior porque
-- `create or replace function` no sabe parchear un cuerpo. Si tocas las
-- originales, este bloque también.

-- 6.a) setup_tenant() — idéntica a la de 0002 + guardia anti super-admin
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
  if public.auth_is_platform_admin() then
    raise exception 'Un super-admin de plataforma no puede crear ni pertenecer a un negocio';
  end if;

  select tenant_id into v_tenant from profiles where id = v_uid;
  if v_tenant is not null then
    return v_tenant; -- ya tiene negocio: no se crea otro (idempotente)
  end if;

  insert into tenants (name, whatsapp, created_by)
  values (
    coalesce(nullif(trim(p_name), ''), 'Mi negocio'),
    nullif(trim(p_whatsapp), ''),
    v_uid
  )
  returning id into v_tenant;

  insert into profiles (id, tenant_id, full_name, role)
  values (v_uid, v_tenant, nullif(trim(p_full_name), ''), 'owner');

  insert into subscriptions (tenant_id, plan, status, trial_ends_at)
  values (v_tenant, 'basic', 'trial', now() + interval '30 days');

  return v_tenant;
end;
$$;

-- 6.b) accept_invite() — idéntica a la de 0006 + guardia anti super-admin
create or replace function public.accept_invite(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_inv     public.tenant_invites;
  v_name    text;
  v_claimed int;
begin
  if v_uid is null then
    raise exception 'No autenticado';
  end if;
  if public.auth_is_platform_admin() then
    raise exception 'Un super-admin de plataforma no puede canjear invitaciones';
  end if;
  if exists (select 1 from profiles where id = v_uid) then
    raise exception 'Ya perteneces a una cuenta';
  end if;

  select * into v_inv from tenant_invites where code = trim(p_code);
  if not found then
    raise exception 'Código de invitación inválido';
  end if;
  if v_inv.expires_at < now() then
    raise exception 'Este código de invitación expiró';
  end if;

  -- Reclamo atómico (ver 0006).
  update tenant_invites
  set accepted_at = now(), accepted_by = v_uid
  where id = v_inv.id and accepted_at is null;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    raise exception 'Este código ya fue utilizado';
  end if;

  select raw_user_meta_data ->> 'full_name' into v_name from auth.users where id = v_uid;

  insert into profiles (id, tenant_id, full_name, role)
  values (v_uid, v_inv.tenant_id, v_name, v_inv.role);

  return v_inv.tenant_id;
end;
$$;
