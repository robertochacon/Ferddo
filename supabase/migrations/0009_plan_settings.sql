-- ═══════════════════════════════════════════════════════════════════════════
-- Ferddo · 0009 · Los planes se administran desde /admin
-- ═══════════════════════════════════════════════════════════════════════════
-- Hasta aquí, "cuánto cuesta" y "cuánto cabe" vivían en TRES sitios que había
-- que mantener a mano y sincronizados:
--   • los números escritos dentro de enforce_item_limit / enforce_member_limit
--     (0002)                                    → lo que la base IMPEDÍA
--   • src/lib/constants.ts (PLANS)              → lo que la app MOSTRABA
--   • la landing pública                        → lo que se ANUNCIABA
-- Cambiar uno solo bastaba para que la app prometiera un tope y la base
-- devolviera otro, o para anunciar un precio que nadie cobraba.
--
-- Esta migración deja UNA fuente de verdad en la base, editable por el
-- super-admin sin desplegar, de la que beben los topes y toda la interfaz.
-- `PLANS` en constants.ts se degrada a RESPALDO OFFLINE: es lo que se pinta
-- cuando la consulta falla o el teléfono está sin red, nunca la verdad.
--
-- SEMÁNTICA DE LOS TOPES (importa y no es obvia):
--   max_items / max_members = NULL significa ILIMITADO, no "cero".
--   Por eso admin_update_plan necesita la bandera p_clear_max: en una firma con
--   argumentos opcionales, un NULL a secas quiere decir "no lo toques", así que
--   sin bandera no habría forma de PONER ilimitado.
-- ═══════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────────
-- 1) Tabla
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.plan_settings (
  plan          plan_code primary key,
  name          text not null,
  -- Dos precios y no un cálculo: la moneda local es la que se ANUNCIA y el
  -- dólar es el que cobra cualquier pasarela internacional. Guardarlos por
  -- separado hace que la paridad sea una decisión explícita del super-admin y
  -- no una conversión que se desactualiza sola.
  price_monthly numeric(12, 2) not null default 0 check (price_monthly >= 0),
  price_usd     numeric(12, 2) not null default 0 check (price_usd >= 0),
  -- NULL = ilimitado. El check descarta el 0, que solo sería una forma
  -- silenciosa de dejar el plan inservible (ni un item, ni un usuario).
  max_items     integer check (max_items is null or max_items > 0),
  max_members   integer check (max_members is null or max_members > 0),
  features      text[] not null default '{}',
  -- ¿Se ofrece hoy? Un plan retirado se deja en false en vez de borrarlo: los
  -- negocios que ya lo tienen conservan su nombre, su precio y sus topes.
  is_offered    boolean not null default true,
  -- Cuál se pinta como "Recomendado" en la landing. Se declara, no se deduce
  -- de la posición ni del precio: el más caro no tiene por qué ser el que se
  -- quiere empujar.
  is_featured   boolean not null default false,
  sort_order    integer not null default 0,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users (id) on delete set null
);

alter table public.plan_settings enable row level security;

-- Los precios son públicos: la landing los muestra a un visitante sin sesión.
drop policy if exists plan_settings_read on public.plan_settings;
create policy plan_settings_read on public.plan_settings
  for select to anon, authenticated using (true);

-- (sin políticas de escritura → el único camino es admin_update_plan)

-- ──────────────────────────────────────────────────────────────────────────
-- 2) Negar la escritura de forma EXPLÍCITA (trampa conocida)
-- ──────────────────────────────────────────────────────────────────────────
-- La RLS de arriba ya impide cualquier cambio (no hay políticas de escritura),
-- pero Supabase concede INSERT/UPDATE/DELETE a anon y authenticated por defecto
-- sobre las tablas nuevas. El resultado sería que un PATCH anónimo devuelve
-- 204 "No Content" —correcto, 0 filas afectadas— en lugar de un rechazo claro.
--
-- Para la tabla que decide cuánto se cobra y cuánto cabe, un intento de
-- escritura tiene que fallar RUIDOSAMENTE (42501): es la diferencia entre ver
-- un ataque en los registros y no enterarse nunca.
revoke insert, update, delete on public.plan_settings from anon, authenticated;

-- La lectura se conserva, y se hace explícita porque de ella depende la landing.
grant select on public.plan_settings to anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 3) Siembra (idempotente)
-- ──────────────────────────────────────────────────────────────────────────
-- `do nothing` y no `do update`: en una base ya viva, el super-admin pudo haber
-- cambiado precios y topes desde el panel, y reejecutar la migración no puede
-- devolverlos a los valores de fábrica.
insert into public.plan_settings
  (plan, name, price_monthly, price_usd, max_items, max_members, features, is_offered, is_featured, sort_order)
values
  ('basic', 'Gratis', 0, 0, 10, 1, array[
      'Hasta 10 items',
      'Un solo usuario',
      'Panel con las métricas del negocio',
      'Soporte por correo'
    ], true, false, 1),
  ('pro', 'Pro', 1500, 25, null, null, array[
      'Items ilimitados',
      'Usuarios ilimitados',
      'Invitaciones para tu equipo',
      'Historial y bitácora completos',
      'Soporte prioritario'
    ], true, true, 2)
on conflict (plan) do nothing;

-- ──────────────────────────────────────────────────────────────────────────
-- 4) Los topes salen ahora de la tabla, no de números escritos a mano
-- ──────────────────────────────────────────────────────────────────────────
-- Se REEMPLAZAN las funciones de 0002. Los números de allí quedan solo como
-- respaldo para el caso raro de que falte la fila del plan (una base a medio
-- migrar, un plan nuevo del enum todavía sin configurar): mejor aplicar el tope
-- histórico que dejar el plan abierto de par en par.
--
-- Ojo con la distinción: "la fila existe y max_items es NULL" = ilimitado;
-- "no hay fila" = respaldo. Un `select ... into` deja NULL en ambos casos, así
-- que hay que mirar `found` y no el valor.

create or replace function public.enforce_item_limit()
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
  select plan into v_plan from subscriptions where tenant_id = new.tenant_id;
  v_plan := coalesce(v_plan, 'basic'); -- sin suscripción se trata como básico

  select ps.max_items, ps.name into v_max, v_name
  from plan_settings ps where ps.plan = v_plan;

  if not found then
    v_max  := case when v_plan = 'basic' then 10 else null end;
    v_name := v_plan::text;
  end if;

  if v_max is not null then
    select count(*) into v_count from items where tenant_id = new.tenant_id;
    if v_count >= v_max then
      raise exception 'PLAN_LIMIT_ITEMS: El plan % permite máximo % items. Actualiza tu plan para crear más.', v_name, v_max;
    end if;
  end if;

  return new;
end;
$$;

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
  -- Un perfil sin negocio (recién registrado, o cuenta de plataforma) no ocupa
  -- cupo de nadie.
  if new.tenant_id is null then
    return new;
  end if;

  select plan into v_plan from subscriptions where tenant_id = new.tenant_id;
  v_plan := coalesce(v_plan, 'basic');

  select ps.max_members, ps.name into v_max, v_name
  from plan_settings ps where ps.plan = v_plan;

  if not found then
    v_max  := case when v_plan = 'basic' then 1 else null end;
    v_name := v_plan::text;
  end if;

  if v_max is not null then
    -- El dueño del negocio recién creado siempre cabe: setup_tenant inserta su
    -- perfil ANTES que la suscripción, así que aquí el conteo todavía es 0.
    select count(*) into v_count from profiles where tenant_id = new.tenant_id;
    if v_count >= v_max then
      raise exception 'PLAN_LIMIT_MEMBERS: El plan % permite % usuario(s) en el negocio. Actualiza tu plan para invitar a más personas.', v_name, v_max;
    end if;
  end if;

  return new;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 5) Invitar también depende de la tabla
-- ──────────────────────────────────────────────────────────────────────────
-- 0006 aplica el tope con un número escrito a mano, porque allí plan_settings
-- todavía no existe. Eso vuelve a partir la verdad en dos: si el super-admin
-- sube max_members del plan gratis a 3, la dueña seguiría sin poder invitar.
--
-- La regla pasa a ser la única que importa: el plan admite más de un usuario
-- (max_members NULL = ilimitado, o mayor que 1). El tope duro lo sigue
-- aplicando enforce_member_limit al ACEPTAR la invitación; esta comprobación
-- solo evita repartir códigos que nadie va a poder canjear.
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
  v_max    integer;
  v_name   text;
  v_code   text;
begin
  select tenant_id, role into v_tenant, v_role from profiles where id = v_uid;
  if v_tenant is null then
    raise exception 'No autorizado';
  end if;
  -- Guardia de suspensión, copiada TAL CUAL de la versión de 0008. Esta
  -- migración reescribe la función entera para leer el tope de plan_settings, y
  -- en la primera pasada se llevó por delante esta comprobación: como
  -- create_invite es SECURITY DEFINER, el insert no pasa por RLS, y un negocio
  -- suspendido volvía a emitir códigos en bucle. Si vuelves a reescribir el
  -- cuerpo, esta guardia se copia con él (0008 la añadió, aquí se conserva).
  if exists (select 1 from tenants where id = v_tenant and suspended_at is not null) then
    raise exception 'CUENTA_SUSPENDIDA: Este negocio está suspendido. Contacta al administrador de la plataforma.';
  end if;
  if v_role <> 'owner' then
    raise exception 'Solo la dueña de la cuenta puede invitar a otras personas';
  end if;

  select plan into v_plan from subscriptions where tenant_id = v_tenant;
  v_plan := coalesce(v_plan, 'basic');

  select ps.max_members, ps.name into v_max, v_name
  from plan_settings ps where ps.plan = v_plan;

  if not found then
    v_max  := case when v_plan = 'basic' then 1 else null end;
    v_name := v_plan::text;
  end if;

  if v_max is not null and v_max <= 1 then
    raise exception 'PLAN_LIMIT_MEMBERS: El plan % es de un solo usuario. Actualiza tu plan para invitar a más personas.', v_name;
  end if;

  insert into tenant_invites (tenant_id, role, email, created_by)
  values (v_tenant, coalesce(p_role, 'admin'), nullif(trim(p_email), ''), v_uid)
  returning code into v_code;

  return v_code;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 6) RPC del super-admin para editar un plan
-- ──────────────────────────────────────────────────────────────────────────
-- Todos los argumentos son opcionales: la UI manda solo lo que cambió y el
-- coalesce conserva el resto. Esa comodidad es justo lo que obliga a p_clear_max
-- (ver la cabecera): sin bandera, "vaciar el tope" y "no tocar el tope" serían
-- el mismo NULL.
create or replace function public.admin_update_plan(
  p_plan          plan_code,
  p_name          text     default null,
  p_price_monthly numeric  default null,
  p_price_usd     numeric  default null,
  p_max_items     integer  default null,
  p_max_members   integer  default null,
  p_clear_max     boolean  default false,
  p_features      text[]   default null,
  p_is_offered    boolean  default null,
  p_is_featured   boolean  default null,
  p_sort_order    integer  default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row plan_settings;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;

  -- Se valida aquí y no solo en el formulario: esta RPC es un endpoint HTTP y
  -- cualquiera con sesión de super-admin puede llamarla con lo que quiera.
  if p_price_monthly is not null and p_price_monthly < 0 then
    raise exception 'El precio mensual no puede ser negativo';
  end if;
  if p_price_usd is not null and p_price_usd < 0 then
    raise exception 'El precio en US$ no puede ser negativo';
  end if;
  if p_max_items is not null and p_max_items < 1 then
    raise exception 'El tope de items debe ser 1 o más (usa "ilimitado" para quitarlo)';
  end if;
  if p_max_members is not null and p_max_members < 1 then
    raise exception 'El tope de usuarios debe ser 1 o más (usa "ilimitado" para quitarlo)';
  end if;
  if p_name is not null and btrim(p_name) = '' then
    raise exception 'El plan necesita un nombre';
  end if;

  -- Un solo destacado: si se marca este, se desmarcan los demás. Se hace en la
  -- RPC y no con un índice único parcial porque el orden importa —el índice
  -- rechazaría el segundo UPDATE en vez de mover la etiqueta.
  if coalesce(p_is_featured, false) then
    update plan_settings set is_featured = false where plan <> p_plan and is_featured;
  end if;

  update plan_settings set
    name          = coalesce(nullif(btrim(p_name), ''), name),
    price_monthly = coalesce(p_price_monthly, price_monthly),
    price_usd     = coalesce(p_price_usd, price_usd),
    -- Una sola bandera para los dos topes: "ilimitado" es una propiedad del
    -- plan entero, y en la UI se marca con una casilla, no tope por tope.
    max_items     = case when p_clear_max then null else coalesce(p_max_items, max_items) end,
    max_members   = case when p_clear_max then null else coalesce(p_max_members, max_members) end,
    features      = coalesce(p_features, features),
    is_offered    = coalesce(p_is_offered, is_offered),
    is_featured   = coalesce(p_is_featured, is_featured),
    sort_order    = coalesce(p_sort_order, sort_order),
    updated_at    = now(),
    updated_by    = auth.uid()
  where plan = p_plan
  returning * into v_row;

  if v_row.plan is null then
    raise exception 'Plan % no encontrado', p_plan;
  end if;

  return to_jsonb(v_row);
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 7) Permisos de ejecución
-- ──────────────────────────────────────────────────────────────────────────
-- `from public, anon` y no solo `from public`: las default privileges de
-- Supabase conceden EXECUTE explícito a anon, y un revoke a PUBLIC no retira
-- una concesión nominal. La guardia interna ya lo pararía, pero editar precios
-- no tiene por qué ser ni siquiera invocable sin token.
do $$
declare
  f text := 'public.admin_update_plan(plan_code, text, numeric, numeric, integer, integer, boolean, text[], boolean, boolean, integer)';
begin
  execute format('revoke all on function %s from public, anon', f);
  execute format('grant execute on function %s to authenticated', f);
end $$;

revoke all on function public.create_invite(member_role, text) from public, anon;
grant execute on function public.create_invite(member_role, text) to authenticated;

-- Las funciones de trigger no las llama nadie desde el cliente (misma
-- convención que 0002): los triggers siguen disparando porque el permiso se
-- comprueba al CREAR el trigger, no al ejecutarlo.
revoke all on function public.enforce_item_limit() from public, anon;
revoke all on function public.enforce_member_limit() from public, anon;
