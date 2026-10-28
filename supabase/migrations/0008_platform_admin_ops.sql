-- ═══════════════════════════════════════════════════════════════════════════
-- Ferddo · 0008 · Operaciones de mantenimiento del super-admin
-- ═══════════════════════════════════════════════════════════════════════════
-- La 0007 dio LECTURA cross-tenant y el cambio de plan. Aquí llega lo que
-- convierte el panel en una herramienta de operación real:
--   • Suspender / reactivar un negocio completo (queda en solo lectura).
--   • Gestionar los usuarios de cada negocio (rol, quitar, bloquear el login).
--   • Alta y baja de otros super-admins desde la propia UI.
--   • Resumen por negocio para el detalle (drill-down).
--
-- Se mantienen las invariantes del sistema, y ninguna es "de UI":
--   · >= 1 owner por negocio y >= 1 super-admin en la plataforma, con
--     pg_advisory_xact_lock para que dos operaciones simultáneas no dejen cero
--     (write-skew clásico: ambas leen "hay 2" y ambas quitan uno).
--   · Ortogonalidad del rol (0007): un super-admin sigue sin profile ni tenant.
--   · Toda mutación sigue yendo por RPC SECURITY DEFINER con guardia; no se
--     añade ni una política de escritura cross-tenant.
-- ═══════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────────
-- 1) Marca de "purga en curso" (la usan los triggers de más abajo y la 0011)
-- ──────────────────────────────────────────────────────────────────────────
-- Trampa ya pagada: los triggers que reaccionan a un DELETE rompen el borrado
-- de un negocio. La 0011 borra hijo→padre dentro de una transacción marcada con
-- `set local ferddo.purging_tenant = <tenant>`; las funciones que estorban a esa
-- purga preguntan por la marca y se apartan.
--
-- Es una variable de TRANSACCIÓN (tercer argumento `true` en set_config), así
-- que se desvanece al terminar la RPC: no puede quedarse pegada entre
-- peticiones de un pool de conexiones.
--
-- Doble condición a propósito: además de la marca exige ser super-admin. Un
-- cliente por REST no puede ejecutar `SET`, pero si algún día pudiera, la marca
-- a solas le serviría para saltarse guardas de negocio.
create or replace function public.is_purging_tenant(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- La marca va PRIMERO: es prácticamente gratis y corta el `and` antes de
  -- pagar auth_is_platform_admin() (lookup + parseo del JWT) en CADA fila
  -- borrada, que en un negocio con historia son decenas de miles.
  select coalesce(current_setting('ferddo.purging_tenant', true), '') = p_tenant::text
     and public.auth_is_platform_admin()
$$;

revoke all on function public.is_purging_tenant(uuid) from public, anon;
-- El grant es para los triggers INVOKER que la consultan (corren con el rol del
-- llamador); los definer no lo necesitan, pero tampoco estorba.
grant execute on function public.is_purging_tenant(uuid) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 2) Suspensión de negocios
-- ──────────────────────────────────────────────────────────────────────────
-- `tenants.suspended_at` ya existe desde 0001; lo que falta es hacerla valer.
-- Suspender = SOLO LECTURA, no apagón: el negocio sigue entrando y viendo sus
-- datos (puede exportarlos, y sobre todo puede leer por qué está suspendido),
-- pero no escribe nada.
create or replace function public.block_write_if_tenant_suspended()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 1) La purga (0011). Sin esta salida, borrar un negocio suspendido —el caso
  --    NORMAL: primero se suspende, luego se elimina— fallaría a mitad del
  --    borrado con CUENTA_SUSPENDIDA.
  if public.is_purging_tenant(coalesce(new.tenant_id, old.tenant_id)) then
    return coalesce(new, old);
  end if;

  -- 2) El super-admin, fuera de la purga: las RPCs del panel corren en su
  --    nombre y tienen que poder tocar un negocio suspendido (es justo cuando
  --    hace falta). No debilita nada: por RLS él no tiene NINGUNA política de
  --    escritura, así que esto solo abre lo que ya pasaba por una RPC definer.
  if public.auth_is_platform_admin() then
    return coalesce(new, old);
  end if;

  if exists (
    select 1 from public.tenants
    where id = coalesce(new.tenant_id, old.tenant_id) and suspended_at is not null
  ) then
    raise exception 'CUENTA_SUSPENDIDA: Este negocio está suspendido. Contacta al administrador de la plataforma.';
  end if;

  return coalesce(new, old);
end;
$$;

revoke all on function public.block_write_if_tenant_suspended() from public, anon;

-- INSERT, UPDATE **y DELETE**. El DELETE es el que se olvida y el que más duele
-- omitir: sin él, una cuenta suspendida por impago puede borrar su rastro.
-- `coalesce(new, old)` en el cuerpo es lo que permite servir a los tres.
--
-- Se aplica a las tablas operativas del tenant. audit_logs queda FUERA a
-- propósito: es la bitácora, y debe poder seguir registrando lo que pase
-- (incluida la propia suspensión) sin depender del estado del negocio.
--
-- tenant_invites SÍ entra, y no por simetría: es la RED que hace que la
-- suspensión no se pueda perder. La guardia de la sección 8 vive DENTRO de
-- create_invite(), y esa función se reescribe entera en cada migración que toca
-- el tope de miembros (0009 lo hizo y se dejó la guardia por el camino). El
-- trigger está en la TABLA, así que sobrevive a cualquier reescritura del
-- cuerpo y no hay forma de insertar un código saltándoselo. La guardia interna
-- se conserva igual: da el mensaje bueno antes de gastar el insert.
do $$
declare
  t    text;
  tbls text[] := array['items', 'notifications', 'tenant_invites'];
begin
  foreach t in array tbls loop
    execute format('drop trigger if exists trg_block_suspended on public.%I', t);
    execute format(
      'create trigger trg_block_suspended before insert or update or delete on public.%I '
      || 'for each row execute function public.block_write_if_tenant_suspended()',
      t
    );
  end loop;
end $$;

-- La bitácora es APPEND-ONLY, y hasta aquí no lo era: `audit_logs_all` (0003)
-- es un `for all` y `authenticated` conservaba el GRANT de UPDATE y DELETE, así
-- que cualquiera podía reescribir o borrar el rastro de su propio negocio —y un
-- negocio suspendido, además, sin chocar con trg_block_suspended, del que
-- audit_logs queda fuera a propósito. La exención existe para que la bitácora
-- siga REGISTRANDO, no para que se pueda limpiar. Se deja el INSERT (la app
-- escribe ahí) y el SELECT (el negocio consulta su historial); lo que se cierra
-- es reescribir el pasado. El borrado real de una bitácora es la purga de 0011,
-- que va por RPC SECURITY DEFINER y no depende de este grant.
revoke update, delete on public.audit_logs from authenticated;

-- CRÍTICO: sin este guard, el dueño de un negocio suspendido hacía
-- `PATCH /tenants {suspended_at: null}` y se reactivaba solo. La política
-- `tenants_update` de 0003 le deja escribir su propia fila y la RLS no
-- restringe COLUMNAS — exactamente el mismo agujero que profiles_guard cerró
-- en 0005 con role y tenant_id.
create or replace function public.tenants_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.auth_is_platform_admin() then
    return new; -- el super-admin suspende, reactiva y edita
  end if;
  if new.suspended_at is distinct from old.suspended_at then
    raise exception 'No autorizado para cambiar el estado de suspensión del negocio';
  end if;
  -- Y mientras esté suspendido, congelado del todo (nombre, logo, contacto):
  -- la suspensión no sería gran cosa si el negocio pudiera seguir operando su
  -- ficha pública.
  if old.suspended_at is not null then
    raise exception 'CUENTA_SUSPENDIDA: Este negocio está suspendido. Contacta al administrador de la plataforma.';
  end if;
  return new;
end;
$$;

revoke all on function public.tenants_guard() from public, anon;

drop trigger if exists trg_tenants_guard on public.tenants;
create trigger trg_tenants_guard
  before update on public.tenants
  for each row execute function public.tenants_guard();

create or replace function public.admin_set_tenant_suspended(p_tenant uuid, p_suspended boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  update public.tenants
    set suspended_at = case when p_suspended then now() else null end
  where id = p_tenant;
  if not found then
    raise exception 'Negocio no encontrado';
  end if;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 3) profiles_guard() con excepción para el super-admin
-- ──────────────────────────────────────────────────────────────────────────
-- El cliente normal sigue sin poder cambiar tenant_id ni role (invariante de
-- 0005). El super-admin SÍ: reasignar el owner o degradar a alguien son
-- operaciones legítimas del panel, y todas pasan por este trigger.
--
-- Funciona porque auth.uid() dentro de una función SECURITY DEFINER sigue
-- siendo el del LLAMADOR: la RPC corre con permisos elevados, pero la identidad
-- que comprueba auth_is_platform_admin() es la de quien la invocó de verdad.
create or replace function public.profiles_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.auth_is_platform_admin() then
    return new; -- reasignar rol/negocio desde las RPCs admin_*
  end if;
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'No se permite cambiar el negocio de un perfil';
  end if;
  if new.role is distinct from old.role then
    raise exception 'No se permite cambiar el rol desde el cliente';
  end if;
  return new;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 4) Gestión de usuarios por negocio
-- ──────────────────────────────────────────────────────────────────────────
-- Las tres funciones reciben p_tenant además de p_user y comprueban que el
-- usuario pertenezca A ESE negocio. Es redundante mientras la UI mande el par
-- correcto, y es justo por eso: convierte un id copiado de otra pantalla en un
-- error claro en vez de en una edición cross-tenant silenciosa.
create or replace function public.admin_list_members(p_tenant uuid)
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

  -- `banned` se calcula contra now(): banned_until es una fecha, no una
  -- bandera, y una del pasado significa "ya no está bloqueado".
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id',         p.id,
             'full_name',  p.full_name,
             'role',       p.role,
             'created_at', p.created_at,
             'email',      u.email,
             'banned',     (u.banned_until is not null and u.banned_until > now())
           )
           order by (p.role = 'owner') desc, p.created_at
         ), '[]'::jsonb)
  into result
  from public.profiles p
  left join auth.users u on u.id = p.id
  where p.tenant_id = p_tenant;

  return result;
end;
$$;

create or replace function public.admin_set_member_role(
  p_tenant uuid,
  p_user   uuid,
  p_role   member_role
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owners int;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_user and tenant_id = p_tenant
  ) then
    raise exception 'Usuario no encontrado en ese negocio';
  end if;

  -- Serializa las operaciones de membresía del MISMO negocio. Sin el lock, dos
  -- degradaciones concurrentes leen cada una "hay 2 owners", ambas pasan la
  -- comprobación y el negocio se queda con cero (write-skew).
  perform pg_advisory_xact_lock(hashtext('ferddo_owner:' || p_tenant::text));

  update public.profiles set role = p_role where id = p_user;

  -- El invariante se verifica DESPUÉS del cambio: es más simple de leer que
  -- razonar sobre casos ("¿degrado al último owner?") y, al ir todo en una
  -- transacción, el raise revierte el update.
  select count(*) into v_owners
  from public.profiles where tenant_id = p_tenant and role = 'owner';
  if v_owners < 1 then
    raise exception 'No puedes dejar al negocio sin dueño; asigna otro dueño primero';
  end if;
end;
$$;

create or replace function public.admin_remove_member(p_tenant uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owners int;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_user and tenant_id = p_tenant
  ) then
    raise exception 'Usuario no encontrado en ese negocio';
  end if;

  perform pg_advisory_xact_lock(hashtext('ferddo_owner:' || p_tenant::text));

  -- Saca al usuario del negocio borrando su profile. NO borra su cuenta de
  -- login: puede crear su propio negocio después, o aceptar otra invitación.
  delete from public.profiles where id = p_user;

  select count(*) into v_owners
  from public.profiles where tenant_id = p_tenant and role = 'owner';
  if v_owners < 1 then
    raise exception 'No puedes quitar al único dueño; reasigna el dueño primero';
  end if;
end;
$$;

-- Bloquear / desbloquear el LOGIN de un usuario (banned_until, de GoTrue).
-- Es distinto de suspender el negocio: aquí se cierra la puerta a UNA persona
-- (cuenta comprometida, abuso), sin tocar a sus compañeros de equipo.
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
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 5) Gestión de super-admins de plataforma
-- ──────────────────────────────────────────────────────────────────────────
create or replace function public.admin_list_platform_admins()
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
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'user_id',    pa.user_id,
             'email',      u.email,
             'note',       pa.note,
             'created_at', pa.created_at
           )
           order by pa.created_at
         ), '[]'::jsonb)
  into result
  from public.platform_admins pa
  left join auth.users u on u.id = pa.user_id;
  return result;
end;
$$;

-- Por CORREO y no por uuid: es el único identificador que una persona conoce y
-- puede teclear sin equivocarse. La cuenta tiene que existir ya en Auth; esta
-- RPC promueve, no registra (crear usuarios es de la API de admin de Supabase).
create or replace function public.admin_grant_platform_admin(
  p_email text,
  p_note  text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;

  select id into v_uid from auth.users where lower(email) = lower(trim(p_email));
  if v_uid is null then
    raise exception 'No existe un usuario con ese correo (créalo primero en Auth)';
  end if;

  -- Preserva la ortogonalidad del rol (0007): un super-admin es una cuenta SIN
  -- negocio. Se mira el tenant_id y no la mera existencia del profile, porque
  -- una fila con tenant_id null es alguien que se registró y nunca completó el
  -- onboarding: esa cuenta sí puede promoverse.
  if exists (select 1 from public.profiles where id = v_uid and tenant_id is not null) then
    raise exception 'Ese usuario pertenece a un negocio; un super-admin debe ser una cuenta sin negocio';
  end if;

  insert into public.platform_admins (user_id, note)
  values (v_uid, coalesce(nullif(trim(p_note), ''), 'alta desde el panel'))
  on conflict (user_id) do nothing;

  return v_uid;
end;
$$;

create or replace function public.admin_revoke_platform_admin(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;

  -- Mismo razonamiento que con los owners: sin lock, dos bajas concurrentes
  -- dejan la plataforma sin nadie que pueda volver a entrar al panel (y
  -- recuperarse de eso exige SQL con service_role).
  perform pg_advisory_xact_lock(hashtext('ferddo_platform_admins'));

  delete from public.platform_admins where user_id = p_user;

  select count(*) into v_count from public.platform_admins;
  if v_count < 1 then
    raise exception 'No puedes eliminar al único super-admin de la plataforma';
  end if;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 6) Resumen por negocio (detalle / drill-down)
-- ──────────────────────────────────────────────────────────────────────────
-- Mismas claves que dashboard_summary() (0002) para que el panel reutilice el
-- formateo, más lo que solo interesa desde fuera. `pending_invites` sale de
-- aquí y no de la RLS: tenant_invites está excluida de la lectura cross-tenant
-- (0007) porque su `code` es una credencial; un CONTEO no revela ninguno.
create or replace function public.admin_tenant_summary(p_tenant uuid)
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
    'total_items',       (select count(*) from items where tenant_id = p_tenant),
    'active_items',      (select count(*) from items where tenant_id = p_tenant and status = 'active'),
    'draft_items',       (select count(*) from items where tenant_id = p_tenant and status = 'draft'),
    'archived_items',    (select count(*) from items where tenant_id = p_tenant and status = 'archived'),
    'amount_total',      (select coalesce(sum(amount), 0) from items where tenant_id = p_tenant),
    'amount_this_month', (select coalesce(sum(amount), 0) from items
                           where tenant_id = p_tenant and created_at >= date_trunc('month', now())),
    'members',           (select count(*) from profiles where tenant_id = p_tenant),
    'created_this_week', (select count(*) from items
                           where tenant_id = p_tenant and created_at >= date_trunc('week', now())),
    'pending_invites',   (select count(*) from tenant_invites
                           where tenant_id = p_tenant and accepted_at is null and expires_at > now())
  ) into result;

  return result;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 7) admin_list_tenants() — se le añade la bandera `suspended`
-- ──────────────────────────────────────────────────────────────────────────
-- Copia fiel de la de 0007 con una clave más: el listado es donde se decide a
-- quién suspender o reactivar, así que el estado tiene que verse ahí.
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
        'suspended',     (t.suspended_at is not null),
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

-- ──────────────────────────────────────────────────────────────────────────
-- 8) Congelar las invitaciones de un negocio suspendido
-- ──────────────────────────────────────────────────────────────────────────
-- Las dos RPCs de 0006/0007 son SECURITY DEFINER, así que insertan y actualizan
-- tenant_invites SIN pasar por trg_block_suspended. Sin esta guardia, un negocio
-- suspendido seguiría emitiendo códigos y sumando usuarios: la suspensión sería
-- porosa justo por donde entra gente nueva.
--
-- Se copian ENTERAS otra vez (create or replace no parchea cuerpos). Encadenado
-- de versiones para no perderse: 0006 crea → 0007 añade la guardia anti
-- super-admin → 0008 (aquí) añade la guardia de suspensión → la 0009 reescribe
-- create_invite para leer max_members de plan_settings.
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
  v_uid    uuid := auth.uid();
  v_tenant uuid;
  v_role   member_role;
  v_plan   plan_code;
  v_code   text;
begin
  select tenant_id, role into v_tenant, v_role from profiles where id = v_uid;
  if v_tenant is null then
    raise exception 'No autorizado';
  end if;
  if exists (select 1 from tenants where id = v_tenant and suspended_at is not null) then
    raise exception 'CUENTA_SUSPENDIDA: Este negocio está suspendido. Contacta al administrador de la plataforma.';
  end if;
  if v_role <> 'owner' then
    raise exception 'Solo el dueño de la cuenta puede invitar a otros usuarios';
  end if;

  -- Constante de respaldo hasta la 0009 (ver el comentario largo en 0006).
  select plan into v_plan from subscriptions where tenant_id = v_tenant;
  if coalesce(v_plan, 'basic') = 'basic' then
    raise exception 'PLAN_LIMIT_MEMBERS: Tu plan permite un solo usuario en el negocio. Actualiza tu plan para invitar a más personas.';
  end if;

  insert into tenant_invites (tenant_id, role, email, created_by)
  values (v_tenant, coalesce(p_role, 'admin'), nullif(trim(p_email), ''), v_uid)
  returning code into v_code;

  return v_code;
end;
$$;

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
  -- Un código emitido ANTES de la suspensión no debe servir para entrar ahora.
  if exists (select 1 from tenants where id = v_inv.tenant_id and suspended_at is not null) then
    raise exception 'CUENTA_SUSPENDIDA: Este negocio está suspendido. Contacta al administrador de la plataforma.';
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

-- ──────────────────────────────────────────────────────────────────────────
-- 9) Permisos de ejecución
-- ──────────────────────────────────────────────────────────────────────────
-- En bucle porque son nueve firmas con el mismo par revoke/grant y escribirlas
-- a mano invita a olvidar justo el revoke, que es la mitad que importa.
-- `from public, anon`: el revoke a PUBLIC no retira el EXECUTE nominal que las
-- default privileges de Supabase le dan a `anon` (ver 0002), y suspender un
-- negocio o dar de alta un super-admin no debe ser ni invocable sin sesión.
do $$
declare
  f   text;
  fns text[] := array[
    'public.admin_set_tenant_suspended(uuid, boolean)',
    'public.admin_list_members(uuid)',
    'public.admin_set_member_role(uuid, uuid, member_role)',
    'public.admin_remove_member(uuid, uuid)',
    'public.admin_set_user_banned(uuid, boolean)',
    'public.admin_list_platform_admins()',
    'public.admin_grant_platform_admin(text, text)',
    'public.admin_revoke_platform_admin(uuid)',
    'public.admin_tenant_summary(uuid)'
  ];
begin
  foreach f in array fns loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
