-- ═══════════════════════════════════════════════════════════════════════════
-- Ferddo · 0010 · Solicitudes de cambio de plan (dueña → super-admin)
-- ═══════════════════════════════════════════════════════════════════════════
-- El cliente NO puede cambiarse el plan solo: `subscriptions` es de solo lectura
-- desde el cliente (0003) porque el plan decide los topes que cobra el producto.
-- Sin un canal explícito, la única vía para subir de plan sería escribir por
-- WhatsApp, y el super-admin acabaría moviendo suscripciones a mano sin rastro
-- de quién pidió qué ni cuándo.
--
-- Esta migración añade ese canal: la dueña SOLICITA desde Configuración, la
-- solicitud aparece en el panel del super-admin, y él la APRUEBA (cambia el
-- plan) o la RECHAZA. Queda la fila como bitácora.
--
-- INVARIANTES DE SEGURIDAD (consistentes con 0005–0009):
--   • El cliente no escribe: no hay políticas INSERT/UPDATE/DELETE. Todo pasa
--     por RPCs SECURITY DEFINER con guardia explícita.
--   • Solo se solicita para el negocio PROPIO (auth_tenant_id()), y solo la
--     dueña: un admin invitado no decide cuánto paga el negocio.
--   • Solo el super-admin (sin negocio propio) lee todas y resuelve.
-- ═══════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────────
-- 1) Tabla
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.plan_requests (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  requested_plan plan_code not null,
  status         plan_request_status not null default 'pending',
  -- Sirve dos veces: el motivo que escribe la dueña y, al resolver, la
  -- respuesta del super-admin añadida debajo.
  note           text,
  requested_by   uuid references auth.users (id) on delete set null,
  resolved_by    uuid references auth.users (id) on delete set null,
  resolved_at    timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists plan_requests_tenant_idx on public.plan_requests (tenant_id);
create index if not exists plan_requests_status_idx on public.plan_requests (status);

-- A lo sumo UNA solicitud pendiente por negocio. En un índice y no en la RPC:
-- dos pestañas pulsando "Solicitar" a la vez pasan las dos por el `if not
-- exists` y solo la base puede arbitrar la carrera.
create unique index if not exists plan_requests_one_pending_idx
  on public.plan_requests (tenant_id)
  where status = 'pending';

alter table public.plan_requests enable row level security;

-- ──────────────────────────────────────────────────────────────────────────
-- 2) RLS — SOLO lectura; la escritura va por RPCs definer
-- ──────────────────────────────────────────────────────────────────────────
-- El negocio ve sus propias solicitudes (Configuración muestra el estado de la
-- que está pendiente).
drop policy if exists plan_requests_select_own on public.plan_requests;
create policy plan_requests_select_own on public.plan_requests
  for select to authenticated
  using (tenant_id = public.auth_tenant_id());

-- Lectura cross-tenant del super-admin: PERMISIVA y SOLO SELECT, con el mismo
-- predicado que el resto (0007). El `auth_tenant_id() is null` mantiene la
-- ortogonalidad: quien tiene negocio no es super-admin, y al revés.
drop policy if exists plan_requests_platform_select on public.plan_requests;
create policy plan_requests_platform_select on public.plan_requests
  for select to authenticated
  using (public.auth_is_platform_admin() and public.auth_tenant_id() is null);

-- (sin políticas insert/update/delete → escritura denegada al cliente)

-- Y el REVOKE detrás de la RLS: sin él, un PATCH del cliente devolvería 204 con
-- 0 filas en vez de 42501, y un intento de auto-aprobarse el plan se
-- confundiría con un no-op en los registros.
revoke insert, update, delete on public.plan_requests from anon, authenticated;
grant select on public.plan_requests to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 3) La dueña solicita un cambio de plan
-- ──────────────────────────────────────────────────────────────────────────
create or replace function public.request_plan_change(
  p_plan plan_code,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid;
  v_current plan_code;
  v_offered boolean;
  v_id      uuid;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;
  -- Un super-admin no tiene negocio: no aplica (y la comprobación evita que un
  -- error de datos le cree una solicitud fantasma sin tenant).
  if public.auth_is_platform_admin() then
    raise exception 'Un super-admin no solicita planes';
  end if;
  if not public.auth_is_owner() then
    raise exception 'Solo la dueña de la cuenta puede solicitar un cambio de plan';
  end if;

  v_tenant := public.auth_tenant_id();
  if v_tenant is null then
    raise exception 'Sin negocio asociado';
  end if;

  -- Un plan retirado sigue existiendo en el enum y en plan_settings (para los
  -- negocios que ya lo tienen), pero no se puede pedir.
  select is_offered into v_offered from plan_settings where plan = p_plan;
  if not found then
    raise exception 'Ese plan no existe';
  end if;
  if not v_offered then
    raise exception 'Ese plan ya no se ofrece';
  end if;

  select plan into v_current from subscriptions where tenant_id = v_tenant;
  if v_current = p_plan then
    raise exception 'Ya tienes el plan solicitado';
  end if;

  -- Serializa contra la otra pestaña: el índice único ya impediría la segunda
  -- fila, pero con el lock la segunda llamada ACTUALIZA la pendiente en vez de
  -- reventar con un error de duplicado que no le dice nada a nadie.
  perform pg_advisory_xact_lock(hashtext('ferddo_plan_request:' || v_tenant::text));

  select id into v_id
  from plan_requests
  where tenant_id = v_tenant and status = 'pending'
  limit 1;

  if v_id is null then
    insert into plan_requests (tenant_id, requested_plan, note, requested_by)
    values (v_tenant, p_plan, nullif(btrim(p_note), ''), auth.uid())
    returning id into v_id;
  else
    -- Ya había una pendiente: se reescribe con lo último que pidió la dueña.
    -- Devolver la vieja tal cual sería peor —la UI diría "solicitado Pro"
    -- mientras el panel del super-admin sigue mostrando el plan anterior.
    update plan_requests
       set requested_plan = p_plan,
           note           = coalesce(nullif(btrim(p_note), ''), note),
           requested_by   = auth.uid(),
           created_at     = now()
     where id = v_id;
  end if;

  return v_id;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 4) El super-admin lista las solicitudes
-- ──────────────────────────────────────────────────────────────────────────
-- Devuelve jsonb ya "hidratado" (nombre del negocio, plan actual, dueño) porque
-- el panel no puede hacer esos joins desde el cliente: las políticas
-- cross-tenant son de SELECT y no le dan acceso a auth.users.
create or replace function public.admin_list_plan_requests(p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_status plan_request_status;
  result   jsonb;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;

  -- El filtro llega como texto (es lo que manda un `?status=`), así que se
  -- valida a mano: castear directo al enum daría el error críptico de Postgres
  -- "invalid input value for enum".
  if nullif(btrim(coalesce(p_status, '')), '') is not null then
    if btrim(p_status) not in ('pending', 'approved', 'rejected') then
      raise exception 'Estado inválido: %', p_status;
    end if;
    v_status := btrim(p_status)::plan_request_status;
  end if;

  select coalesce(jsonb_agg(r order by ord, created_at desc), '[]'::jsonb)
  into result
  from (
    select
      -- Las pendientes primero: son las únicas sobre las que hay que actuar.
      (pr.status <> 'pending') as ord,
      pr.created_at            as created_at,
      jsonb_build_object(
        'id',             pr.id,
        'tenant_id',      pr.tenant_id,
        'tenant_name',    t.name,
        'requested_plan', pr.requested_plan,
        'current_plan',   s.plan,
        'status',         pr.status,
        'note',           pr.note,
        'created_at',     pr.created_at,
        'resolved_at',    pr.resolved_at,
        'whatsapp',       t.whatsapp,
        'owner_name',     o.full_name,
        'owner_email',    au.email
      ) as r
    from plan_requests pr
    join tenants t on t.id = pr.tenant_id
    left join subscriptions s on s.tenant_id = pr.tenant_id
    -- lateral + limit 1: un negocio debería tener un solo owner, pero si por
    -- un arreglo manual tuviera dos, el join normal duplicaría la solicitud.
    left join lateral (
      select pf.id, pf.full_name
      from profiles pf
      where pf.tenant_id = pr.tenant_id and pf.role = 'owner'
      order by pf.created_at
      limit 1
    ) o on true
    left join auth.users au on au.id = o.id
    where v_status is null or pr.status = v_status
  ) sub;

  return result;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 5) El super-admin aprueba (cambia el plan) o rechaza
-- ──────────────────────────────────────────────────────────────────────────
create or replace function public.admin_resolve_plan_request(
  p_id      uuid,
  p_approve boolean,
  p_note    text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_plan   plan_code;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;

  -- `for update` sobre la fila PENDIENTE: bloquea y, de paso, garantiza que dos
  -- super-admins pulsando a la vez no resuelvan la misma solicitud dos veces
  -- (la segunda no encuentra nada que bloquear y aborta).
  select tenant_id, requested_plan into v_tenant, v_plan
  from plan_requests
  where id = p_id and status = 'pending'
  for update;

  if v_tenant is null then
    raise exception 'Solicitud no encontrada o ya resuelta';
  end if;

  if p_approve then
    -- Misma escritura idempotente que admin_set_subscription (0007): si por lo
    -- que sea el negocio no tuviera fila de suscripción, se le crea.
    insert into subscriptions (tenant_id, plan, status)
    values (v_tenant, v_plan, 'active')
    on conflict (tenant_id) do update
      set plan   = excluded.plan,
          status = 'active';
  end if;

  update plan_requests
     set status      = case when p_approve then 'approved' else 'rejected' end::plan_request_status,
         -- La nota del super-admin se AÑADE, no sustituye: la de la dueña es la
         -- que explica por qué pidió el cambio y sin ella la decisión guardada
         -- no se entiende meses después. concat_ws se salta los NULL.
         note        = case
                         when nullif(btrim(coalesce(p_note, '')), '') is null then note
                         else concat_ws(chr(10), note, 'Respuesta: ' || btrim(p_note))
                       end,
         resolved_at = now(),
         resolved_by = auth.uid()
   where id = p_id;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 6) Permisos de ejecución
-- ──────────────────────────────────────────────────────────────────────────
-- `from public, anon` (convención de 0009): el revoke a PUBLIC no retira la
-- concesión nominal que Supabase le da a anon.
do $$
declare
  f text;
  fns text[] := array[
    'public.request_plan_change(plan_code, text)',
    'public.admin_list_plan_requests(text)',
    'public.admin_resolve_plan_request(uuid, boolean, text)'
  ];
begin
  foreach f in array fns loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
