-- ═══ Ferddo · 0028 · Acceso de soporte, bitácora del panel y notas internas ═══
--
-- POR QUÉ EXISTE
-- Hasta aquí el super-admin era un principal SIN negocio (0007): veía métricas
-- agregadas y nunca datos comerciales. Para dar soporte de verdad hace falta
-- entrar a un negocio y operar como lo haría su administrador. Esta migración
-- abre esa puerta SIN romper el modelo:
--
--   • El acceso es una membresía normal en `tenant_members`, con rol `admin`,
--     marcada con `support_until` (caducidad) y `support_reason` (motivo). Así
--     TODA la seguridad existente (RLS por `auth_tenant_id()`, `has_perm`,
--     sucursales) aplica igual que a cualquier empleado: no hay un camino nuevo
--     de lectura cross-tenant ni una excepción que auditar aparte.
--   • La caducidad la aplica la BASE en `auth_tenant_id()`: pasada la hora, el
--     super-admin deja de pertenecer al negocio aunque el cliente no haga nada.
--   • Mientras está dentro, `auth_tenant_id()` no es null, así que las
--     políticas cross-tenant de 0007 (`… and auth_tenant_id() is null`) dejan
--     de aplicarle: ve SOLO ese negocio, como cualquier miembro.
--   • Entrar y salir queda en la bitácora del negocio (`audit_logs`) y en la de
--     plataforma; el dueño ve el acceso en su Equipo y puede cortarlo.
--
-- Además:
--   • `platform_audit_logs`: bitácora de lo que hacen los super-admins
--     (planes, suspensiones, roles, bloqueos, borrados, accesos de soporte).
--     Se alimenta por TRIGGERS sobre las tablas afectadas, no tocando cada RPC:
--     una RPC nueva que cambie esas tablas queda auditada sin acordarse.
--   • `tenant_admin_notes`: notas internas del equipo Ferddo por negocio. El
--     negocio NO las ve.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Membresía de soporte ─────────────────────────────────────────────────
alter table public.tenant_members
  add column if not exists support_until  timestamptz,
  add column if not exists support_reason text;

alter table public.tenant_members drop constraint if exists tenant_members_support_chk;
alter table public.tenant_members add constraint tenant_members_support_chk
  check ((support_until is null) = (support_reason is null));

-- Fila de soporte vigente o miembro normal. Un solo predicado para no repetir
-- (y desincronizar) la regla de caducidad en cada consulta.
create or replace function public.member_is_current(p_support_until timestamptz)
returns boolean
language sql
stable  -- depende de now(): no puede ser immutable
as $$
  select p_support_until is null or p_support_until > now()
$$;

-- La caducidad se aplica AQUÍ: todo lo demás (auth_member_role, has_perm,
-- my_permissions, RLS) cuelga de esta función. Pasada la hora, el super-admin
-- deja de pertenecer al negocio sin que nadie tenga que borrar nada.
create or replace function public.auth_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.tenant_id
  from public.profiles p
  where p.id = auth.uid()
    and exists (
      select 1 from public.tenant_members m
      where m.tenant_id = p.tenant_id and m.user_id = p.id and m.is_active
        and public.member_is_current(m.support_until)
    )
$$;

-- Soporte no ocupa plaza: el tope del plan es de las personas del negocio.
-- Sin esto, un negocio con el equipo completo no podría recibir soporte, y el
-- acceso le quitaría una plaza mientras dura.
create or replace function public.enforce_member_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan  plan_code;
  v_max   integer;
  v_name  text;
  v_count int;
begin
  if new.support_until is not null then
    return new;
  end if;
  if not new.is_active or (tg_op = 'UPDATE' and old.is_active) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('ferddo_members:' || new.tenant_id::text));
  select plan into v_plan from subscriptions where tenant_id = new.tenant_id;
  v_plan := coalesce(v_plan, 'basic');
  select ps.max_members, ps.name into v_max, v_name from plan_settings ps where ps.plan = v_plan;
  if v_max is not null then
    select count(*) into v_count from tenant_members
    where tenant_id = new.tenant_id and is_active and support_until is null and user_id <> new.user_id;
    if v_count >= v_max then
      raise exception 'PLAN_LIMIT_MEMBERS: El plan % permite % usuario(s) en la empresa. Actualiza tu plan para agregar más personas.', v_name, v_max;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.create_invite(
  p_role member_role default 'admin',
  p_email text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_plan   plan_code;
  v_max    integer;
  v_name   text;
  v_count  int;
  v_code   text;
begin
  perform public.require_perm('team.manage');
  if exists (select 1 from tenants where id = v_tenant and suspended_at is not null) then
    raise exception 'CUENTA_SUSPENDIDA: Este negocio está suspendido. Contacta al administrador de la plataforma.';
  end if;
  -- Solo un dueño crea otro dueño: un admin no puede ascenderse por la puerta
  -- de atrás invitándose a sí mismo con otra cuenta.
  if p_role = 'owner' and not public.auth_is_owner() then
    raise exception 'Solo el dueño puede invitar a otro dueño';
  end if;
  select plan into v_plan from subscriptions where tenant_id = v_tenant;
  v_plan := coalesce(v_plan, 'basic');
  select ps.max_members, ps.name into v_max, v_name from plan_settings ps where ps.plan = v_plan;
  if v_max is not null then
    select count(*) into v_count from tenant_members
    where tenant_id = v_tenant and is_active and support_until is null;
    if v_count >= v_max then
      raise exception 'PLAN_LIMIT_MEMBERS: El plan % permite % usuario(s). Actualiza tu plan para invitar a más personas.', v_name, v_max;
    end if;
  end if;
  insert into tenant_invites (tenant_id, role, email, created_by)
  values (v_tenant, coalesce(p_role, 'admin'), nullif(trim(p_email), ''), auth.uid())
  returning code into v_code;
  perform public.log_audit('team.invite', 'tenant_invite', null, jsonb_build_object('role', p_role));
  return v_code;
end;
$$;

create or replace function public.my_plan_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  t    uuid := public.auth_tenant_id();
  v_tz text;
begin
  if t is null then
    raise exception 'No autorizado';
  end if;
  select timezone into v_tz from tenants where id = t;
  return jsonb_build_object(
    'products',  (select count(*) from products where tenant_id = t),
    'members',   (select count(*) from tenant_members where tenant_id = t and is_active and support_until is null),
    'branches',  (select count(*) from branches where tenant_id = t),
    'registers', (select count(*) from cash_registers where tenant_id = t),
    'ecf_month', (select count(*) from electronic_invoices where tenant_id = t and status <> 'voided'
                    and created_at >= date_trunc('month', now() at time zone v_tz) at time zone v_tz));
end;
$$;

-- El negocio puede CORTAR el acceso de soporte (set_member_active), pero no
-- convertirlo en otra cosa: ascender a Ferddo a dueño le daría un acceso que
-- ya no caduca de hecho (podría transferirse la propiedad) y saltaría la
-- auditoría. Tampoco puede tocar la caducidad: no hay grant de UPDATE, y las
-- RPC del equipo no escriben esas columnas.
create or replace function public.tenant_members_support_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.support_until is not null and new.role is distinct from old.role
     and not public.auth_is_platform_admin() then
    raise exception 'FORBIDDEN: El acceso de soporte de Ferddo no puede cambiar de rol. Puedes desactivarlo si quieres cortarlo.';
  end if;
  return new;
end;
$$;
revoke all on function public.tenant_members_support_guard() from public, anon, authenticated;
drop trigger if exists trg_tenant_members_support_guard on public.tenant_members;
create trigger trg_tenant_members_support_guard
  before update on public.tenant_members
  for each row execute function public.tenant_members_support_guard();

-- Equipo visto desde el negocio: el soporte aparece mientras está vigente,
-- con su caducidad y su motivo (este último solo para quien gestiona el equipo).
create or replace function public.list_team_members()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_manage boolean := public.has_perm('team.manage');
begin
  if v_tenant is null then
    raise exception 'No autorizado';
  end if;
  -- Cualquier miembro ve nombres (los necesita para "vendedor", "cajero"),
  -- pero el correo solo quien administra el equipo.
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'user_id', m.user_id, 'role', m.role, 'is_active', m.is_active,
             'branch_ids', m.branch_ids, 'created_at', m.created_at,
             'full_name', coalesce(p.full_name, u.raw_user_meta_data ->> 'full_name'),
             'email', case when v_manage then u.email end,
             'support_until', m.support_until,
             'support_reason', case when v_manage then m.support_reason end
           ) order by (m.role = 'owner') desc, (m.support_until is not null), m.created_at), '[]'::jsonb)
    from tenant_members m
    left join profiles p on p.id = m.user_id
    left join auth.users u on u.id = m.user_id
    where m.tenant_id = v_tenant and public.member_is_current(m.support_until)
  );
end;
$$;

create or replace function public.my_tenants()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'name', t.name, 'logo_url', t.logo_url, 'role', m.role,
           'business_type', t.business_type, 'suspended', t.suspended_at is not null,
           'active', t.id = public.auth_tenant_id()
         ) order by t.name), '[]'::jsonb)
  from tenant_members m
  join tenants t on t.id = m.tenant_id
  where m.user_id = auth.uid() and m.is_active and public.member_is_current(m.support_until)
$$;

create or replace function public.admin_list_members(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', m.user_id, 'full_name', p.full_name, 'role', m.role, 'is_active', m.is_active,
             'created_at', m.created_at, 'email', u.email,
             'banned', (u.banned_until is not null and u.banned_until > now()),
             'support_until', m.support_until
           ) order by (m.role = 'owner') desc, (m.support_until is not null), m.created_at), '[]'::jsonb)
    from tenant_members m
    left join profiles p on p.id = m.user_id
    left join auth.users u on u.id = m.user_id
    where m.tenant_id = p_tenant and public.member_is_current(m.support_until)
  );
end;
$$;

-- ── 2. Bitácora de plataforma ───────────────────────────────────────────────
-- NO es una tabla de negocio: no lleva `_setup_tenant_table` ni entra en la
-- purga. `tenant_id` va SIN foreign key a propósito, con el nombre copiado:
-- la bitácora tiene que sobrevivir al borrado del negocio (es justo cuando más
-- falta hace saber quién lo borró y qué se tocó antes).
create table if not exists public.platform_audit_logs (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references auth.users (id) on delete set null,
  actor_email text,
  action      text not null,
  tenant_id   uuid,
  tenant_name text,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists platform_audit_logs_created_idx on public.platform_audit_logs (created_at desc);
create index if not exists platform_audit_logs_tenant_idx on public.platform_audit_logs (tenant_id, created_at desc);

alter table public.platform_audit_logs enable row level security;
revoke all on public.platform_audit_logs from anon;
revoke insert, update, delete on public.platform_audit_logs from authenticated;
grant select on public.platform_audit_logs to authenticated;
drop policy if exists platform_audit_logs_select on public.platform_audit_logs;
create policy platform_audit_logs_select on public.platform_audit_logs
  for select to authenticated using (public.auth_is_platform_admin());

-- Única vía de escritura. Solo la llaman triggers y RPC definer de este archivo.
create or replace function public._platform_audit(
  p_action      text,
  p_tenant      uuid,
  p_meta        jsonb default '{}'::jsonb,
  p_tenant_name text default null
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.platform_audit_logs (actor_id, actor_email, action, tenant_id, tenant_name, meta)
  values (
    auth.uid(),
    (select email from auth.users where id = auth.uid()),
    p_action,
    p_tenant,
    coalesce(p_tenant_name, (select name from public.tenants where id = p_tenant)),
    coalesce(p_meta, '{}'::jsonb)
  )
$$;
revoke all on function public._platform_audit(text, uuid, jsonb, text) from public, anon, authenticated;

-- Columnas que cambiaron entre OLD y NEW: {col: {from, to}}. Genérico para que
-- una columna nueva en la tabla quede auditada sin tocar este archivo.
create or replace function public._jsonb_diff(p_old jsonb, p_new jsonb, p_ignore text[] default '{}')
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_object_agg(n.key, jsonb_build_object('from', o.value, 'to', n.value)), '{}'::jsonb)
  from jsonb_each(p_new) n
  join jsonb_each(p_old) o using (key)
  where o.value is distinct from n.value and not (n.key = any (p_ignore))
$$;

-- Un solo trigger para todas las tablas del panel. Solo registra lo que hace
-- un super-admin con sesión (auth.uid() no nulo): los cambios del propio
-- negocio ya van a su `audit_logs`, y los de service_role/SQL directo no
-- tienen a quién atribuirse.
create or replace function public._audit_platform_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_diff jsonb;
  v_user uuid;
begin
  if auth.uid() is null or not public.auth_is_platform_admin() then
    return null;
  end if;

  case tg_table_name
  when 'subscriptions' then
    v_diff := public._jsonb_diff(to_jsonb(old), to_jsonb(new), array['updated_at']);
    if v_diff <> '{}'::jsonb then
      perform public._platform_audit('subscription.update', new.tenant_id, jsonb_build_object('changes', v_diff));
    end if;

  when 'tenants' then
    if new.suspended_at is distinct from old.suspended_at then
      perform public._platform_audit(
        case when new.suspended_at is null then 'tenant.reactivate' else 'tenant.suspend' end, new.id);
    end if;

  when 'tenant_members' then
    -- Las filas de soporte se registran explícitamente al entrar y salir; y la
    -- purga de un negocio no debe dejar una línea por cada miembro borrado.
    if tg_op = 'DELETE' then
      if old.support_until is not null or public.is_purging_tenant(old.tenant_id) then
        return null;
      end if;
      perform public._platform_audit('member.remove', old.tenant_id, jsonb_build_object(
        'user_id', old.user_id, 'email', (select email from auth.users where id = old.user_id), 'role', old.role));
    else
      if new.support_until is not null or old.support_until is not null then
        return null;
      end if;
      v_user := new.user_id;
      if new.role is distinct from old.role then
        perform public._platform_audit('member.role', new.tenant_id, jsonb_build_object(
          'user_id', v_user, 'email', (select email from auth.users where id = v_user),
          'from', old.role, 'to', new.role));
      end if;
      if new.is_active is distinct from old.is_active then
        perform public._platform_audit(
          case when new.is_active then 'member.activate' else 'member.deactivate' end, new.tenant_id,
          jsonb_build_object('user_id', v_user, 'email', (select email from auth.users where id = v_user)));
      end if;
    end if;

  when 'platform_admins' then
    if tg_op = 'INSERT' then
      perform public._platform_audit('platform_admin.grant', null, jsonb_build_object(
        'user_id', new.user_id, 'email', (select email from auth.users where id = new.user_id)));
    else
      perform public._platform_audit('platform_admin.revoke', null, jsonb_build_object(
        'user_id', old.user_id, 'email', (select email from auth.users where id = old.user_id)));
    end if;

  when 'plan_settings' then
    v_diff := public._jsonb_diff(to_jsonb(old), to_jsonb(new), array['updated_at']);
    if v_diff <> '{}'::jsonb then
      perform public._platform_audit('plan.update', null, jsonb_build_object('plan', new.plan, 'changes', v_diff));
    end if;

  when 'plan_requests' then
    if new.status is distinct from old.status then
      perform public._platform_audit('plan_request.resolve', new.tenant_id, jsonb_build_object(
        'requested_plan', new.requested_plan, 'status', new.status));
    end if;

  when 'tenant_purges' then
    perform public._platform_audit('tenant.delete', new.tenant_id, jsonb_build_object(
      'owner_email', new.owner_email, 'deleted_users', new.deleted_users), new.tenant_name);
  end case;
  return null;
end;
$$;
revoke all on function public._audit_platform_change() from public, anon, authenticated;

drop trigger if exists trg_platform_audit on public.subscriptions;
create trigger trg_platform_audit after update on public.subscriptions
  for each row execute function public._audit_platform_change();
drop trigger if exists trg_platform_audit on public.tenants;
create trigger trg_platform_audit after update of suspended_at on public.tenants
  for each row execute function public._audit_platform_change();
drop trigger if exists trg_platform_audit on public.tenant_members;
create trigger trg_platform_audit after update or delete on public.tenant_members
  for each row execute function public._audit_platform_change();
drop trigger if exists trg_platform_audit on public.platform_admins;
create trigger trg_platform_audit after insert or delete on public.platform_admins
  for each row execute function public._audit_platform_change();
drop trigger if exists trg_platform_audit on public.plan_settings;
create trigger trg_platform_audit after update on public.plan_settings
  for each row execute function public._audit_platform_change();
drop trigger if exists trg_platform_audit on public.plan_requests;
create trigger trg_platform_audit after update of status on public.plan_requests
  for each row execute function public._audit_platform_change();
drop trigger if exists trg_platform_audit on public.tenant_purges;
create trigger trg_platform_audit after insert on public.tenant_purges
  for each row execute function public._audit_platform_change();

-- El bloqueo toca `auth.users`, donde no ponemos triggers (es de GoTrue): se
-- registra desde la propia RPC. Mismo cuerpo que 0008 + la línea de auditoría.
create or replace function public.admin_set_user_banned(p_user uuid, p_banned boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  -- Un super-admin no se puede dejar fuera a sí mismo ni a un colega: sería
  -- una forma indirecta de saltarse el invariante de >= 1 super-admin operativo.
  if exists (select 1 from public.platform_admins where user_id = p_user) then
    raise exception 'No puedes bloquear el acceso de un super-admin';
  end if;
  -- 100 años = "indefinido" en la práctica; GoTrue no tiene un valor infinito y
  -- el desbloqueo es poner null, no esperar la fecha.
  update auth.users
    set banned_until = case when p_banned then now() + interval '100 years' else null end
  where id = p_user;
  if not found then
    raise exception 'Usuario no encontrado';
  end if;
  perform public._platform_audit(
    case when p_banned then 'user.ban' else 'user.unban' end,
    (select m.tenant_id from tenant_members m where m.user_id = p_user order by (m.role = 'owner') desc, m.created_at limit 1),
    jsonb_build_object('user_id', p_user, 'email', (select email from auth.users where id = p_user)));
end;
$$;

-- ── 3. Entrar y salir como gestor ───────────────────────────────────────────
create or replace function public.admin_enter_tenant(p_tenant uuid, p_reason text)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  -- Dos horas: suficiente para una sesión de soporte y corto para que un
  -- acceso olvidado no quede abierto. Para más, se vuelve a entrar (y queda
  -- otra línea en la bitácora, que es lo que se quiere).
  v_until  timestamptz := now() + interval '2 hours';
  v_name   text;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'FORBIDDEN: Solo un super-admin de Ferddo puede entrar a un negocio como gestor.';
  end if;
  if char_length(v_reason) < 5 then
    raise exception 'SUPPORT_REASON_REQUIRED: Escribe el motivo del acceso (al menos 5 caracteres). Queda en la bitácora del negocio.';
  end if;
  select name into v_name from tenants where id = p_tenant;
  if v_name is null then
    raise exception 'Negocio no encontrado';
  end if;
  -- Un super-admin no es miembro real de ningún negocio (0007). Si lo fuera,
  -- convertir esa membresía en soporte la haría caducar y la borraría al salir.
  if exists (select 1 from tenant_members where tenant_id = p_tenant and user_id = v_uid and support_until is null) then
    raise exception 'Ya perteneces a ese negocio como miembro; entra desde tu lista de empresas.';
  end if;

  -- Un acceso a la vez: entrar a otro negocio cierra el anterior (y lo registra).
  perform public._support_close(v_uid, p_tenant);

  insert into tenant_members (tenant_id, user_id, role, branch_ids, is_active, support_until, support_reason)
  values (p_tenant, v_uid, 'admin', null, true, v_until, v_reason)
  on conflict (tenant_id, user_id) do update
    set role = 'admin', branch_ids = null, is_active = true,
        support_until = excluded.support_until, support_reason = excluded.support_reason;

  -- El super-admin no suele tener perfil (no creó negocio): se crea aquí. El
  -- guard de perfiles deja pasar al super-admin.
  insert into profiles (id, tenant_id, role, full_name)
  values (v_uid, p_tenant, 'admin',
          (select coalesce(raw_user_meta_data ->> 'full_name', email) from auth.users where id = v_uid))
  on conflict (id) do update set tenant_id = excluded.tenant_id, role = 'admin';

  insert into audit_logs (tenant_id, user_id, action, entity, entity_id, meta)
  values (p_tenant, v_uid, 'support.enter', 'tenant', p_tenant,
          jsonb_build_object('reason', v_reason, 'until', v_until));
  perform public._platform_audit('support.enter', p_tenant, jsonb_build_object('reason', v_reason, 'until', v_until));
  return v_until;
end;
$$;

-- Cierra los accesos de soporte de `p_user` (salvo el de `p_keep`) y deja
-- constancia en las dos bitácoras. `expired` distingue "salió" de "caducó".
create or replace function public._support_close(p_user uuid, p_keep uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in
    delete from tenant_members
    where user_id = p_user and support_until is not null and tenant_id is distinct from p_keep
    returning tenant_id, support_until
  loop
    insert into audit_logs (tenant_id, user_id, action, entity, entity_id, meta)
    values (r.tenant_id, p_user, 'support.exit', 'tenant', r.tenant_id,
            jsonb_build_object('expired', r.support_until <= now()));
    perform public._platform_audit('support.exit', r.tenant_id, jsonb_build_object('expired', r.support_until <= now()));
  end loop;
end;
$$;
revoke all on function public._support_close(uuid, uuid) from public, anon, authenticated;

create or replace function public.admin_exit_tenant()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if not public.auth_is_platform_admin() then
    raise exception 'FORBIDDEN: Solo un super-admin puede salir del modo soporte.';
  end if;
  perform public._support_close(v_uid);
  -- De vuelta a principal SIN negocio: es lo que reactiva el panel /admin y las
  -- lecturas cross-tenant de 0007 (`auth_tenant_id() is null`).
  update profiles set tenant_id = null where id = v_uid;
end;
$$;

-- ── 4. Notas internas por negocio ───────────────────────────────────────────
-- Excepción DELIBERADA a la regla de "tabla de negocio ⇒ _setup_tenant_table":
-- estas filas cuelgan de un negocio pero son del equipo Ferddo. Con el molde,
-- el propio negocio las leería; aquí la única política es la del super-admin.
create table if not exists public.tenant_admin_notes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  author_id  uuid references auth.users (id) on delete set null default auth.uid(),
  body       text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists tenant_admin_notes_tenant_idx on public.tenant_admin_notes (tenant_id, created_at desc);

alter table public.tenant_admin_notes enable row level security;
revoke all on public.tenant_admin_notes from anon;
revoke update on public.tenant_admin_notes from authenticated;
grant select, insert, delete on public.tenant_admin_notes to authenticated;

drop policy if exists tenant_admin_notes_select on public.tenant_admin_notes;
create policy tenant_admin_notes_select on public.tenant_admin_notes
  for select to authenticated using (public.auth_is_platform_admin());
drop policy if exists tenant_admin_notes_insert on public.tenant_admin_notes;
create policy tenant_admin_notes_insert on public.tenant_admin_notes
  for insert to authenticated with check (public.auth_is_platform_admin() and author_id = auth.uid());
-- Cada quien borra las suyas: una nota es el testimonio de quien la escribió.
drop policy if exists tenant_admin_notes_delete on public.tenant_admin_notes;
create policy tenant_admin_notes_delete on public.tenant_admin_notes
  for delete to authenticated using (public.auth_is_platform_admin() and author_id = auth.uid());

-- La purga borra hijo → padre: las notas, antes que nadie.
create or replace function public.tenant_tables_purge_order()
returns text[]
language sql
immutable
as $$
  select array[
    'tenant_admin_notes',
    'appointments',
    'restaurant_order_items', 'kitchen_tickets', 'restaurant_orders', 'restaurant_tables', 'restaurant_areas',
    'work_order_advances', 'work_order_items', 'work_orders', 'assets',
    'electronic_invoice_events', 'electronic_invoices', 'fiscal_sequences', 'fiscal_secrets', 'fiscal_settings',
    'receivable_payments', 'payable_payments', 'expenses', 'customer_payments', 'supplier_payments',
    'purchase_receipts', 'receivables', 'payables', 'sale_return_items', 'sale_returns', 'sale_payments', 'sale_items', 'sales',
    'quotation_items', 'quotations', 'cash_movements', 'cash_sessions', 'cash_registers',
    'inventory_movements', 'inventory_documents', 'stock_levels', 'purchase_items', 'purchases',
    'price_list_items', 'customers', 'price_lists',
    'product_components', 'products', 'categories', 'taxes', 'suppliers', 'expense_categories',
    'document_sequences', 'role_permissions', 'tenant_members', 'branches', 'subscription_events',
    'notifications', 'audit_logs', 'tenant_invites', 'plan_requests', 'subscriptions'
  ]
$$;
revoke all on function public.tenant_tables_purge_order() from public, anon, authenticated;

-- ── 5. Permisos de las RPC públicas ─────────────────────────────────────────
do $$
declare
  f   text;
  fns text[] := array[
    'public.admin_enter_tenant(uuid, text)',
    'public.admin_exit_tenant()',
    'public.admin_list_members(uuid)',
    'public.admin_set_user_banned(uuid, boolean)',
    'public.list_team_members()',
    'public.my_tenants()',
    'public.my_plan_usage()',
    'public.create_invite(member_role, text)'
  ];
begin
  foreach f in array fns loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke all on function public.member_is_current(timestamptz) from public, anon;
grant execute on function public.member_is_current(timestamptz) to authenticated;
revoke all on function public._jsonb_diff(jsonb, jsonb, text[]) from public, anon, authenticated;

notify pgrst, 'reload schema';
