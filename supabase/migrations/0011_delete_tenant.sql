-- ═══════════════════════════════════════════════════════════════════════════
-- Ferddo · 0011 · Eliminar un negocio EN CASCADA (solo super-admin)
-- ═══════════════════════════════════════════════════════════════════════════
-- Suspender un negocio (0008) le corta el acceso pero lo conserva todo. Esta
-- migración añade el paso final e IRREVERSIBLE: borrar el negocio con todo lo
-- suyo (items, avisos, bitácora, invitaciones, suscripción, perfiles y
-- archivos), a petición del dueño o por incumplimiento.
--
-- Piezas y por qué existe cada una:
--   1) `tenant_purges` — bitácora del borrado, que SOBREVIVE al negocio. Sin
--      ella no quedaría rastro de a quién se le borró qué: `audit_logs` no
--      sirve, porque su tenant_id es NOT NULL con FK en cascada y el propio
--      borrado se llevaría la evidencia.
--   2) La marca de transacción `ferddo.purging_tenant` + `is_purging_tenant()`,
--      para cortocircuitar los triggers que reaccionan al DELETE. Durante un
--      borrado total, ese trabajo va de inútil a FATAL: basta con que un
--      trigger levante una excepción a mitad para que la transacción entera
--      revierta y el negocio quede INBORRABLE, siempre.
--   3) `norm_name()` — normaliza el nombre igual que `norm()` en TypeScript,
--      para que la confirmación no sea una trampa.
--   4) `admin_tenant_purge_preview()` — cuenta qué se va a borrar; la UI lo
--      enseña ANTES de pedir la confirmación.
--   5) `admin_delete_tenant()` — el borrado, hijo→padre, con guardia de
--      super-admin, confirmación del nombre y bitácora.
--   6) Políticas de Storage: por SQL solo se borra la fila de metadatos, no el
--      archivo, así que el vaciado real lo hace el cliente con la API.
--
-- INVARIANTES (consistentes con 0005–0010):
--   • No se crea NINGUNA política de DELETE cross-tenant: `tenants` sigue sin
--     política de DELETE para el cliente. Todo pasa por RPC SECURITY DEFINER
--     con guardia `auth_is_platform_admin()`.
--   • La ortogonalidad se mantiene: un super-admin no tiene negocio, así que
--     nunca puede borrar "el suyo" ni dejarse a sí mismo sin panel.
-- ═══════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────────
-- 1) Bitácora de borrados
-- ──────────────────────────────────────────────────────────────────────────
-- `tenant_id` va SIN foreign key A PROPÓSITO: con FK, el borrado del negocio se
-- llevaría por delante la fila que documenta ese mismo borrado.
create table if not exists public.tenant_purges (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  tenant_name      text,
  owner_email      text,
  deleted_by       uuid references auth.users (id) on delete set null,
  deleted_by_email text,
  -- ¿Se borraron también las cuentas de login de sus usuarios?
  deleted_users    boolean not null default false,
  -- Cuántas filas cayeron de cada tabla: es lo que permite auditar el alcance
  -- REAL del borrado, no el que se suponía.
  counts           jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists tenant_purges_created_idx on public.tenant_purges (created_at desc);

alter table public.tenant_purges enable row level security;

-- Solo el super-admin la lee; nadie la escribe desde el cliente (la escribe la
-- RPC definer). Sin el `auth_tenant_id() is null` del resto de políticas
-- cross-tenant: aquí no hay datos de negocios vivos, y así la bitácora sigue
-- siendo legible aunque el rol se hubiera concedido por error a alguien con
-- negocio —justo el caso en el que hace falta mirarla.
drop policy if exists tenant_purges_platform_select on public.tenant_purges;
create policy tenant_purges_platform_select on public.tenant_purges
  for select to authenticated using (public.auth_is_platform_admin());

-- Permisos explícitos (convención de 0003/0009/0010). Sin el REVOKE, las
-- default privileges de Supabase dejan a `authenticated` con INSERT/UPDATE/
-- DELETE de tabla sobre la BITÁCORA de borrados: hoy solo lo frena la RLS y un
-- PATCH devolvería 204 con 0 filas, en silencio.
-- El GRANT del SELECT sí se hace explícito porque de él depende la política de
-- Storage del final (su subconsulta corre con el rol `authenticated`).
revoke insert, update, delete on public.tenant_purges from anon, authenticated;
grant select on public.tenant_purges to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 2) Marca de "borrado en curso"
-- ──────────────────────────────────────────────────────────────────────────
-- Es una variable de TRANSACCIÓN (`set_config(..., true)`): se desvanece al
-- terminar la RPC y no puede quedarse pegada entre peticiones de un pool.
-- Se prefiere a `session_replication_role`, que exige superusuario y además
-- apagaría también las cascadas de FK.
--
-- Doble condición a propósito: además de la marca exige ser super-admin. Hoy un
-- cliente no puede ejecutar `SET`, pero si algún día pudiera, la marca sola le
-- permitiría saltarse los triggers de reacción del resto de la aplicación.
--
-- Se declara aquí, con la maquinaria de purga a la que pertenece, aunque quien
-- la USA sea `block_write_if_tenant_suspended` (0008). El `create or replace`
-- la hace idempotente si esa migración ya la dejó puesta.
-- Se retira antes de crearla: si 0008 la dejó puesta con otro nombre de
-- parámetro, `create or replace` fallaría con "cannot change name of input
-- parameter". Nadie depende de ella por catálogo (plpgsql resuelve las llamadas
-- por nombre en tiempo de ejecución), así que soltarla y recrearla es inocuo.
drop function if exists public.is_purging_tenant(uuid);

create or replace function public.is_purging_tenant(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- La marca va PRIMERO: es prácticamente gratis y corta el `and` antes de
  -- pagar el `auth_is_platform_admin()` (lectura + parseo del JWT) en CADA fila
  -- que se borra.
  select coalesce(current_setting('ferddo.purging_tenant', true), '') = p_tenant::text
     and public.auth_is_platform_admin()
$$;

revoke all on function public.is_purging_tenant(uuid) from public, anon;
grant execute on function public.is_purging_tenant(uuid) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 3) Nombre normalizado, para que la confirmación no sea una trampa
-- ──────────────────────────────────────────────────────────────────────────
-- El cliente compara con `norm()` de TypeScript y el servidor tiene que llegar
-- al MISMO resultado. `btrim` de Postgres solo quita el espacio ASCII, así que
-- un nombre guardado con un tabulador, un salto de línea o un espacio duro
-- (U+00A0, lo que pega cualquiera desde un chat) haría que la UI diera el visto
-- bueno y el servidor respondiera "el nombre no coincide" señalando un carácter
-- invisible: el super-admin no tendría forma de escribirlo bien nunca.
--
-- Reglas, en este orden: U+00A0 → espacio normal, minúsculas, colapsar todo
-- espacio en blanco a uno solo, recortar los extremos.
create or replace function public.norm_name(p_text text)
returns text
language sql
immutable
as $$
  select btrim(regexp_replace(lower(replace(coalesce(p_text, ''), chr(160), ' ')), '\s+', ' ', 'g'))
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 4) Índices que hacen posible el borrado en el tiempo disponible
-- ──────────────────────────────────────────────────────────────────────────
-- (a) Recorrido por tenant_id: cada `delete from X where tenant_id = $1`. Ya
--     está cubierto (profiles/items/notifications/audit_logs en 0001,
--     tenant_invites en 0006, plan_requests en 0010, subscriptions por su
--     unique). Si añades una tabla con tenant_id, dale su índice ahí mismo.
--
-- (b) Lo que de verdad se olvida: las columnas que apuntan a `auth.users`. Con
--     p_delete_users, al borrar CADA usuario PostgreSQL comprueba todas las FK
--     que lo referencian, y esas comprobaciones van por la columna de la FK, no
--     por tenant_id. Sin índice, cada usuario borrado provoca un escaneo
--     completo de tablas que no crecen con el negocio que se borra, sino con
--     TODA la plataforma. Es lo que hace que la purga no quepa en el límite de
--     tiempo justo en los negocios grandes, que son los que se quieren borrar.
create index if not exists tenants_created_by_idx         on public.tenants (created_by);
create index if not exists items_created_by_idx           on public.items (created_by);
create index if not exists audit_logs_user_idx            on public.audit_logs (user_id);
create index if not exists tenant_invites_created_by_idx  on public.tenant_invites (created_by);
create index if not exists tenant_invites_accepted_by_idx on public.tenant_invites (accepted_by);
create index if not exists plan_requests_requested_by_idx on public.plan_requests (requested_by);
create index if not exists plan_requests_resolved_by_idx  on public.plan_requests (resolved_by);
create index if not exists tenant_purges_deleted_by_idx   on public.tenant_purges (deleted_by);
-- `plan_settings.updated_by` se queda sin índice: la tabla tiene una fila por
-- plan y el escaneo cuesta menos que mantener el índice.

-- ──────────────────────────────────────────────────────────────────────────
-- 5) Vista previa: qué se va a borrar
-- ──────────────────────────────────────────────────────────────────────────
create or replace function public.admin_tenant_purge_preview(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
-- Son una docena de conteos; con los índices sobra, pero el rol `authenticated`
-- viene con statement_timeout = 8s y no interesa que la vista previa muera
-- antes que el borrado al que precede.
set statement_timeout = '20s'
as $$
declare
  v_t      public.tenants;
  v_files  int;
  v_result jsonb;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;

  select * into v_t from public.tenants where id = p_tenant;
  if not found then
    raise exception 'Negocio no encontrado';
  end if;

  -- Los archivos viven en Storage, fuera del modelo de datos. Si el rol de la
  -- función no alcanzara `storage.objects`, se devuelve null (la UI enseña "—")
  -- en vez de tumbar la vista previa entera por un dato accesorio.
  begin
    select count(*) into v_files
    from storage.objects
    where bucket_id in ('logos', 'files')
      and (storage.foldername(name))[1] = p_tenant::text;
  exception when others then
    v_files := null;
  end;

  select jsonb_build_object(
    'tenant_id',   v_t.id,
    'name',        v_t.name,
    'suspended',   (v_t.suspended_at is not null),
    'created_at',  v_t.created_at,
    'owner_email', (
      select au.email
      from public.profiles pr
      join auth.users au on au.id = pr.id
      where pr.tenant_id = p_tenant and pr.role = 'owner'
      order by pr.created_at
      limit 1
    ),
    'members',       (select count(*) from public.profiles where tenant_id = p_tenant),
    'items',         (select count(*) from public.items where tenant_id = p_tenant),
    'active_items',  (select count(*) from public.items where tenant_id = p_tenant and status = 'active'),
    'amount_total',  (select coalesce(sum(amount), 0) from public.items where tenant_id = p_tenant),
    'notifications', (select count(*) from public.notifications where tenant_id = p_tenant),
    'audit_logs',    (select count(*) from public.audit_logs where tenant_id = p_tenant),
    'invites',       (select count(*) from public.tenant_invites where tenant_id = p_tenant),
    'plan_requests', (select count(*) from public.plan_requests where tenant_id = p_tenant),
    'files',         v_files
  ) into v_result;

  return v_result;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 6) El borrado
-- ──────────────────────────────────────────────────────────────────────────
-- `p_confirm_name` tiene que coincidir con el nombre del negocio. Se valida
-- también aquí, no solo en la UI: es la última red contra borrar el negocio
-- equivocado por un id mal pegado.
create or replace function public.admin_delete_tenant(
  p_tenant       uuid,
  p_confirm_name text,
  p_delete_users boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
-- El rol `authenticated` viene con `statement_timeout = 8s`: un negocio con un
-- año de historia no cabe, y como todo va en una transacción el corte revierte
-- TODO → el negocio quedaba inborrable y reintentar daba lo mismo. Este ajuste
-- de función es EXACTAMENTE un `set local` al entrar (así lo define Postgres), y
-- PostgREST además lo aplica antes de la llamada; un `set local` escrito dentro
-- del cuerpo NO serviría, porque el temporizador del statement ya está armado.
-- 50 s a propósito: por DEBAJO del corte HTTP del gateway (60 s), con margen
-- para el TLS y para serializar la respuesta. Así, si algo se pasa de tiempo,
-- quien aborta es Postgres —rollback limpio y error claro— y no la petición,
-- que dejaría el borrado hecho, los archivos sin limpiar y la UI diciendo que
-- falló.
set statement_timeout = '50s'
as $$
declare
  v_t      public.tenants;
  v_tbl    text;
  v_n      bigint;
  v_counts jsonb := '{}'::jsonb;
  v_owner  text;
  v_actor  uuid := auth.uid();
  v_uids   uuid[];
  v_files  bigint := 0;
  v_paths  jsonb := '[]'::jsonb;
  -- Orden hijo → padre. No se confía en el orden de las cascadas de FK: hoy
  -- todas son ON DELETE CASCADE y un `delete from tenants` bastaría, pero en
  -- cuanto alguien clone `items` con una tabla hija en RESTRICT (el caso normal
  -- al crecer), el borrado empezaría a fallar según el orden en que PostgreSQL
  -- decida disparar las cascadas. Aquí el orden es explícito y, de paso, es lo
  -- que permite contar cuánto cayó de cada tabla.
  -- Al añadir una tabla con tenant_id, añádela A ESTA LISTA.
  v_order  text[] := array[
    'items',
    'notifications',
    'audit_logs',
    'tenant_invites',
    'plan_requests',
    'subscriptions',
    'profiles'           -- desvincula a los usuarios; su login se decide abajo
  ];
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;

  -- Serializa contra cualquier otra operación del panel sobre este negocio
  -- (suspender, cambiar plan, resolver una solicitud) mientras desaparece.
  perform pg_advisory_xact_lock(hashtext('ferddo_purge:' || p_tenant::text));

  select * into v_t from public.tenants where id = p_tenant for update;
  if not found then
    raise exception 'Negocio no encontrado';
  end if;

  -- Un negocio cuyo nombre se quedó en blanco convertiría la confirmación en un
  -- trámite vacío: cualquier casilla vacía "coincidiría" y bastaría un clic.
  if public.norm_name(v_t.name) = '' then
    raise exception 'Este negocio no tiene nombre: ponle uno antes de borrarlo (así la confirmación sirve de algo)';
  end if;
  if public.norm_name(p_confirm_name) is distinct from public.norm_name(v_t.name) then
    raise exception 'El nombre no coincide: escribe exactamente "%" para confirmar', v_t.name;
  end if;

  -- ── Fotografía para la bitácora (ANTES de borrar) ──────────────────────
  select au.email into v_owner
  from public.profiles pr
  join auth.users au on au.id = pr.id
  where pr.tenant_id = p_tenant and pr.role = 'owner'
  order by pr.created_at
  limit 1;

  select coalesce(array_agg(pr.id), '{}'::uuid[]) into v_uids
  from public.profiles pr
  where pr.tenant_id = p_tenant
    -- Cinturón: un super-admin no tiene negocio (0007/0008), pero si alguna vez
    -- lo tuviera por un arreglo manual, su cuenta de plataforma no se borra.
    and not exists (select 1 from public.platform_admins pa where pa.user_id = pr.id);

  -- ── Marca el borrado en curso (apaga los triggers de reacción) ─────────
  -- En particular `block_write_if_tenant_suspended` (0008), que bloquea también
  -- el DELETE: sin esto, borrar un negocio SUSPENDIDO —el caso normal, primero
  -- se suspende y luego se borra— fallaría con CUENTA_SUSPENDIDA.
  perform set_config('ferddo.purging_tenant', p_tenant::text, true);

  -- ── Borrado, hijo → padre ──────────────────────────────────────────────
  foreach v_tbl in array v_order loop
    execute format('delete from public.%I where tenant_id = $1', v_tbl) using p_tenant;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object(v_tbl, v_n);
  end loop;

  -- ── Archivos ───────────────────────────────────────────────────────────
  -- Los archivos NO se borran por SQL: quitar la fila de `storage.objects` deja
  -- el blob huérfano en el bucket, invisible y para siempre, ocupando espacio
  -- que se paga. Se devuelven sus rutas y el cliente las borra con la API de
  -- Storage, que sí elimina el archivo. Si esa segunda parte falla, las filas
  -- siguen ahí y la bitácora dice cuántas eran → se puede reintentar sin haber
  -- perdido nada.
  begin
    select count(*) into v_files
    from storage.objects
    where bucket_id in ('logos', 'files')
      and (storage.foldername(name))[1] = p_tenant::text;

    select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket_id, 'path', name)), '[]'::jsonb)
    into v_paths
    from (
      select bucket_id, name
      from storage.objects
      where bucket_id in ('logos', 'files')
        and (storage.foldername(name))[1] = p_tenant::text
      order by bucket_id, name
      -- Tope solo para no devolver un JSON gigantesco. Está muy por encima de
      -- cualquier negocio real, y si alguna vez se pasara, `counts.files` (que
      -- NO va topado) delata la diferencia y la UI puede avisar en vez de
      -- cantar victoria.
      limit 20000
    ) f;
  exception when others then
    -- Sin privilegio sobre storage: se sigue borrando la base (que es lo que
    -- pidió el super-admin) y queda constancia de que los archivos no se tocaron.
    v_files := -1;
    v_paths := '[]'::jsonb;
  end;
  v_counts := v_counts || jsonb_build_object('files', v_files);

  -- ── El negocio ─────────────────────────────────────────────────────────
  delete from public.tenants where id = p_tenant;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('tenants', v_n);

  -- ── Cuentas de login ───────────────────────────────────────────────────
  -- Por omisión NO se borran (mismo criterio que admin_remove_member): la
  -- persona conserva su acceso y puede crear otro negocio. Con p_delete_users
  -- se borra la cuenta entera de Auth, sesiones incluidas.
  -- `cardinality` y no `array_length`: con el array vacío este devuelve 0 y
  -- aquel NULL, que convertiría el `if` en NULL en vez de en falso.
  if p_delete_users and cardinality(v_uids) > 0 then
    -- Es el único DELETE del proyecto contra el esquema `auth`. Si al rol de la
    -- función le faltara el privilegio, sin este bloque el error tumbaría TODO
    -- el borrado y el negocio quedaría inborrable cada vez que se marque la
    -- casilla. Se anota -1 y la UI lo dice.
    begin
      delete from auth.users where id = any(v_uids);
      get diagnostics v_n = row_count;
      v_counts := v_counts || jsonb_build_object('auth_users', v_n);
    exception when insufficient_privilege then
      v_counts := v_counts || jsonb_build_object('auth_users', -1);
    end;
  end if;

  -- ── Bitácora ───────────────────────────────────────────────────────────
  insert into public.tenant_purges (
    tenant_id, tenant_name, owner_email, deleted_by, deleted_by_email,
    deleted_users, counts
  )
  values (
    p_tenant, v_t.name, v_owner, v_actor,
    (select email from auth.users where id = v_actor),
    coalesce(p_delete_users, false), v_counts
  );

  return jsonb_build_object(
    'tenant_id', p_tenant,
    'name',      v_t.name,
    'counts',    v_counts,
    -- Rutas que el cliente debe vaciar con la API de Storage (ver arriba).
    'files',     v_paths
  );
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 7) Bitácora para el panel
-- ──────────────────────────────────────────────────────────────────────────
create or replace function public.admin_list_tenant_purges(p_limit integer default 20)
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

  select coalesce(jsonb_agg(r order by (r->>'created_at') desc), '[]'::jsonb)
  into result
  from (
    select jsonb_build_object(
             'id',               id,
             'tenant_id',        tenant_id,
             'tenant_name',      tenant_name,
             'owner_email',      owner_email,
             'deleted_by_email', deleted_by_email,
             'deleted_users',    deleted_users,
             'counts',           counts,
             'created_at',       created_at
           ) as r
    from public.tenant_purges
    order by created_at desc
    -- `greatest(..., 1)`: un p_limit de 0 o negativo devolvería una lista vacía
    -- que la UI interpretaría como "nunca se ha borrado nada".
    limit greatest(coalesce(p_limit, 20), 1)
  ) s;

  return result;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 8) Permisos
-- ──────────────────────────────────────────────────────────────────────────
do $$
declare
  f text;
  fns text[] := array[
    'public.admin_tenant_purge_preview(uuid)',
    'public.admin_delete_tenant(uuid, text, boolean)',
    'public.admin_list_tenant_purges(integer)'
  ];
begin
  foreach f in array fns loop
    -- También de `anon`: las default privileges de Supabase le conceden EXECUTE
    -- explícito y `revoke ... from public` no retira una concesión nominal. La
    -- guardia interna ya lo pararía, pero un endpoint de borrado no tiene por
    -- qué ser invocable sin token.
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

revoke all on function public.norm_name(text) from public, anon;
grant execute on function public.norm_name(text) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 9) Storage: el super-admin solo alcanza carpetas de negocios YA borrados
-- ──────────────────────────────────────────────────────────────────────────
-- El vaciado de verdad lo hace el cliente con la API de Storage (con las rutas
-- que devuelve admin_delete_tenant), y para eso necesita poder LEER (select, que
-- también hace falta para el RETURNING del borrado) y BORRAR con su token.
--
-- El alcance se acota con `tenant_purges`: solo son alcanzables los archivos
-- cuya primera carpeta es el id de un negocio que YA pasó por
-- admin_delete_tenant. Sin esa condición —bastaba con `auth_is_platform_admin()`—
-- el token del super-admin quedaría con lectura y BORRADO de los archivos de
-- TODOS los negocios vivos: un camino de escritura cross-tenant por política
-- (justo lo que 0007 prohíbe), sin confirmación de nombre, sin bitácora y sin
-- copia, porque el archivo es el único original que existe.
--
-- Mínimo privilegio también en los verbos: SELECT + DELETE, nunca INSERT/UPDATE.
-- Y se compara como TEXTO: `(storage.foldername(name))[1]` es una cadena
-- arbitraria (alguien sube "tmp/x.png") y castearla a uuid reventaría la
-- política entera con un error de tipo en vez de devolver false.
do $$
declare
  b text;
  -- `in (select …)` en vez de `exists (… where … = name)`: dentro del
  -- subselect, un `name` sin cualificar se resolvería PRIMERO contra
  -- `tenant_purges`, así que el día que esa tabla tuviera una columna `name` el
  -- predicado se rebindearía en silencio y la limpieza dejaría de borrar nada.
  scope text :=
    'bucket_id = %L and public.auth_is_platform_admin() and public.auth_tenant_id() is null '
    || 'and (storage.foldername(name))[1] in (select tp.tenant_id::text from public.tenant_purges tp)';
begin
  foreach b in array array['logos', 'files'] loop
    execute format('drop policy if exists %I on storage.objects', b || '_platform_read');
    execute format(
      'create policy %I on storage.objects for select to authenticated using (' || scope || ')',
      b || '_platform_read', b
    );
    execute format('drop policy if exists %I on storage.objects', b || '_platform_delete');
    execute format(
      'create policy %I on storage.objects for delete to authenticated using (' || scope || ')',
      b || '_platform_delete', b
    );
  end loop;
end $$;

-- PostgREST cachea el esquema, incluidos los ajustes por función (el
-- statement_timeout de arriba). Supabase suele recargarlo con su event trigger
-- de DDL; esto lo hace explícito. Los dos avisos son transaccionales (si la
-- migración revierte, no se emiten) e inofensivos si nadie escucha.
notify pgrst, 'reload schema';
notify pgrst, 'reload config';
