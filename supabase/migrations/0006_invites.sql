-- ═══════════════════════════════════════════════════════════════════════════
-- Ferddo · 0006 · Invitaciones de equipo (segundo usuario en un negocio)
-- ═══════════════════════════════════════════════════════════════════════════
-- La 0005 cerró el INSERT de profiles porque dejaba entrar a cualquiera en el
-- negocio de otro. Eso dejó un hueco funcional: ya no había forma de sumar un
-- segundo usuario. Esta migración lo reabre por el único camino defendible:
--
--   1) El OWNER genera un código con create_invite() (SECURITY DEFINER: es la
--      función quien decide el tenant_id, no el cliente).
--   2) La persona invitada se registra por su cuenta y canjea el código con
--      accept_invite(), que le crea el profile con ESE tenant y ESE rol.
--
-- El código es una credencial al portador: quien lo tenga entra al negocio.
-- De ahí tres decisiones que conviene no relajar:
--   · Caduca a los 14 días y se puede revocar (delete) en cualquier momento.
--   · Solo el OWNER lo ve; un 'admin' del mismo negocio no puede leerlo ni
--     fabricarse uno para colar a un tercero.
--   · El canje es ATÓMICO: un código = un uso, incluso con dos canjes en
--     carrera (ver accept_invite).
-- Por lo mismo, tenant_invites queda EXCLUIDA de la lectura cross-tenant del
-- super-admin en 0007: soporte no necesita ver credenciales ajenas.
-- ═══════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────────
-- tenant_invites — códigos emitidos, vivos y ya canjeados
-- ──────────────────────────────────────────────────────────────────────────
-- La fila NO se borra al canjearse (accepted_at / accepted_by): sirve de
-- bitácora de "quién entró con qué invitación y cuándo", que es justo lo que
-- se busca cuando aparece un usuario inesperado en un negocio.
--
-- 9 bytes aleatorios en hexadecimal = 18 caracteres, 72 bits de entropía: se
-- dicta por teléfono sin dolor y adivinarlo a fuerza bruta no es una opción.
-- gen_random_bytes() viene de pgcrypto, que se instala en 0001.
create table if not exists public.tenant_invites (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  code        text not null unique default encode(extensions.gen_random_bytes(9), 'hex'),
  -- Correo de destino: informativo (a quién se le mandó). No se valida contra
  -- el correo de quien canjea, para no romper el caso "me registré con otro".
  email       text,
  role        member_role not null default 'admin',
  created_by  uuid references auth.users (id) on delete set null,
  expires_at  timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists tenant_invites_tenant_idx on public.tenant_invites (tenant_id);
-- El unique de `code` ya crea su índice; este índice extra es el que usa el
-- listado de invitaciones pendientes del panel de equipo.
create index if not exists tenant_invites_pending_idx
  on public.tenant_invites (tenant_id, accepted_at);

alter table public.tenant_invites enable row level security;

-- ──────────────────────────────────────────────────────────────────────────
-- Políticas: SOLO el owner, y SOLO leer y revocar
-- ──────────────────────────────────────────────────────────────────────────
-- Sin política de INSERT ni de UPDATE a propósito. Crear una invitación es
-- decidir a qué negocio y con qué rol entra alguien: eso lo hace create_invite()
-- y nada más. Un INSERT abierto (aunque exigiera `tenant_id = auth_tenant_id()`)
-- dejaría que un 'admin' se saltara la regla de "solo el owner invita".
drop policy if exists invites_select on public.tenant_invites;
create policy invites_select on public.tenant_invites
  for select to authenticated
  using (tenant_id = auth_tenant_id() and auth_is_owner());

drop policy if exists invites_delete on public.tenant_invites;
create policy invites_delete on public.tenant_invites
  for delete to authenticated
  using (tenant_id = auth_tenant_id() and auth_is_owner());

-- Permisos de tabla (trampa conocida: Supabase concede escritura a anon y
-- authenticated en cada tabla nueva; sin RLS de escritura, un PATCH devuelve
-- 204 silencioso en vez de 42501 y el intento se confunde con un no-op).
-- `anon` pierde hasta el SELECT: aquí vive una credencial al portador y no hay
-- ningún caso de uso sin sesión.
revoke all on public.tenant_invites from anon;
revoke insert, update on public.tenant_invites from authenticated;
-- El DELETE sí se concede: lo respalda la política de arriba (revocar un código).
grant select, delete on public.tenant_invites to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- create_invite() — solo el owner, y solo si el plan admite más de un usuario
-- ──────────────────────────────────────────────────────────────────────────
-- Devuelve el código en claro: es la única vez que se muestra cómodamente, y
-- la UI lo copia al portapapeles. Queda legible en la tabla para que el owner
-- pueda volver a consultarlo mientras siga vivo.
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
  if v_role <> 'owner' then
    raise exception 'Solo el dueño de la cuenta puede invitar a otros usuarios';
  end if;

  -- TOPE DE MIEMBROS. Aquí es una CONSTANTE DE RESPALDO: plan_settings todavía
  -- no existe (llega en 0009), así que "el plan permite más de un usuario" se
  -- traduce a "no es el básico". La 0009 REESCRIBE esta función para leer
  -- max_members de la tabla (null = ilimitado, > 1 = puede invitar) y que el
  -- super-admin cambie el cupo sin desplegar. No dupliques el número: la verdad
  -- vivirá allí.
  --
  -- Es un chequeo de cortesía, no la defensa: quien se salte esta RPC choca
  -- igual contra enforce_member_limit() (0002) al insertarse el profile. Aquí
  -- solo se evita emitir un código que luego no se podría canjear.
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

-- ──────────────────────────────────────────────────────────────────────────
-- accept_invite() — canje ATÓMICO del código
-- ──────────────────────────────────────────────────────────────────────────
-- La versión ingenua (leer, comprobar accepted_at, insertar el profile,
-- marcar la invitación) tiene una carrera clásica: dos canjes simultáneos leen
-- el mismo NULL y ambos entran. Aquí el UPDATE condicional
-- `where accepted_at is null` ES el reclamo —lo resuelve el propio motor con el
-- bloqueo de fila— y `get diagnostics row_count` dice si te tocó a ti.
--
-- Y como todo ocurre en UNA transacción, si el INSERT en profiles falla (por
-- ejemplo, el tope de miembros de 0002), el canje se revierte con él y el
-- código sigue sirviendo. Marcar la invitación primero es seguro justo por eso.
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
  -- Un usuario pertenece como mucho a un negocio. Si ya tiene profile (aunque
  -- sea sin tenant), el camino es otro; no se le muda de sitio por un código.
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

  -- Reclamo atómico: solo tiene éxito si nadie lo canjeó antes.
  update tenant_invites
  set accepted_at = now(), accepted_by = v_uid
  where id = v_inv.id and accepted_at is null;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    raise exception 'Este código ya fue utilizado';
  end if;

  -- El nombre que puso al registrarse (auth.users.raw_user_meta_data) ahorra
  -- pedírselo otra vez; si no lo hay, queda null y lo completa en su perfil.
  select raw_user_meta_data ->> 'full_name' into v_name from auth.users where id = v_uid;

  insert into profiles (id, tenant_id, full_name, role)
  values (v_uid, v_inv.tenant_id, v_name, v_inv.role);

  return v_inv.tenant_id;
end;
$$;

-- La 0007 vuelve a definir accept_invite() para que ADEMÁS rechace a un
-- super-admin de plataforma (su cuenta debe quedar sin negocio), y la 0008 le
-- añade la guardia de negocio suspendido. Cada una copia la versión anterior
-- entera: si tocas esta, revisa aquellas.

-- ──────────────────────────────────────────────────────────────────────────
-- Permisos de ejecución (misma convención que 0002)
-- ──────────────────────────────────────────────────────────────────────────
-- auth_is_owner(), que usan las dos políticas de arriba, ya existe desde 0002
-- con su grant a `authenticated`; no se redefine aquí.
-- `, anon` porque el revoke a PUBLIC no retira el EXECUTE nominal que Supabase
-- concede a ese rol (ver 0002). Emitir o canjear un código de invitación no
-- tiene por qué ser ni siquiera invocable sin sesión.
revoke all on function public.create_invite(member_role, text) from public, anon;
revoke all on function public.accept_invite(text) from public, anon;

grant execute on function public.create_invite(member_role, text) to authenticated;
grant execute on function public.accept_invite(text) to authenticated;
