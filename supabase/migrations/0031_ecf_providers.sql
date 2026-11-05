-- ═══ Ferddo · 0031 · Catálogo de proveedores de e-CF y cambio de proveedor ═══
--
-- POR QUÉ EXISTE
-- Hasta aquí el proveedor de e-CF era un texto libre en `fiscal_settings` y la
-- lista de proveedores vivía escrita a mano en el frontend (solo el simulador).
-- Cambiar de proveedor —el día que se conecte uno autorizado, o si uno falla—
-- obligaba a tocar código y negocio por negocio. Esta migración lo convierte en
-- algo que se gestiona desde el panel de plataforma:
--
--   • `ecf_providers`: catálogo global. Qué proveedores hay, cuáles se ofrecen
--     a los negocios, cuáles sirven para producción y qué datos pide cada uno
--     (configuración no secreta y claves de sus credenciales). El código de
--     cada proveedor tiene que coincidir con un adaptador de la Edge Function
--     `ecf` (supabase/functions/_shared/ecf/registry.ts): el catálogo dice qué
--     se OFRECE; el adaptador, qué se sabe ENVIAR.
--   • Claves foráneas desde `fiscal_settings` y `electronic_invoices`: ya no
--     se puede apuntar a un proveedor que no exista, ni borrar uno en uso.
--   • Cambiar de proveedor (el negocio desde su configuración, o el
--     super-admin para uno o para todos) REASIGNA los comprobantes que aún no
--     salieron (`pending`/`error` sin `track_id`). Los ya enviados se quedan
--     con el suyo: solo ese proveedor puede consultar su estado. Cada
--     reasignación deja un evento `provider_changed` en la bitácora del
--     comprobante.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Catálogo ─────────────────────────────────────────────────────────────
-- Tabla de PLATAFORMA (no de negocio): sin tenant_id, sin _setup_tenant_table.
-- La leen todos los usuarios con sesión (el negocio elige de aquí); no hay nada
-- secreto en ella. Solo se escribe por las RPC admin_* de abajo.
create table if not exists public.ecf_providers (
  code              text primary key check (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name              text not null check (char_length(btrim(name)) between 2 and 80),
  description       text check (description is null or char_length(description) <= 500),
  website           text check (website is null or website ~ '^https://\S{3,300}$'),
  -- Se ofrece a los negocios. Desactivar NO saca a quien ya lo usa: solo deja
  -- de aparecer para elegirlo.
  is_enabled        boolean not null default false,
  -- Lo que emite no tiene validez fiscal (simulador).
  is_simulated      boolean not null default false,
  allows_production boolean not null default true,
  -- [{key, label, required, help}]: datos NO secretos que el negocio llena y
  -- van a fiscal_settings.provider_config.
  config_fields     jsonb not null default '[]'::jsonb,
  -- [{key, label, help}]: claves que el adaptador espera en las credenciales
  -- cifradas (fiscal_secrets.provider_credentials). Solo los nombres.
  credential_fields jsonb not null default '[]'::jsonb,
  sort_order        integer not null default 100,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (not (is_simulated and allows_production))
);
alter table public.ecf_providers enable row level security;
revoke all on public.ecf_providers from anon;
revoke insert, update, delete on public.ecf_providers from authenticated;
grant select on public.ecf_providers to authenticated;
drop policy if exists ecf_providers_read on public.ecf_providers;
create policy ecf_providers_read on public.ecf_providers for select to authenticated using (true);
drop trigger if exists trg_ecf_providers_updated on public.ecf_providers;
create trigger trg_ecf_providers_updated before update on public.ecf_providers
  for each row execute function public.set_updated_at();

insert into public.ecf_providers (code, name, description, is_enabled, is_simulated, allows_production, sort_order)
values ('simulator', 'Simulador (sin validez fiscal)',
        'Recorre el ciclo completo (envío, aceptación, rechazo) sin hablar con la DGII. Para practicar y probar; '
        || 'sus comprobantes no existen para la DGII.',
        true, true, false, 0)
on conflict (code) do nothing;

-- Cualquier proveedor ya usado entra al catálogo (desactivado) antes de poner
-- las claves foráneas: un valor huérfano haría fallar la migración.
insert into public.ecf_providers (code, name, is_enabled)
select distinct provider, provider, false
from (select provider from public.fiscal_settings union select provider from public.electronic_invoices) u
where provider ~ '^[a-z][a-z0-9_]{1,39}$'
on conflict (code) do nothing;

alter table public.fiscal_settings drop constraint if exists fiscal_settings_provider_fk;
alter table public.fiscal_settings add constraint fiscal_settings_provider_fk
  foreign key (provider) references public.ecf_providers (code);
alter table public.electronic_invoices drop constraint if exists electronic_invoices_provider_fk;
alter table public.electronic_invoices add constraint electronic_invoices_provider_fk
  foreign key (provider) references public.ecf_providers (code);
create index if not exists electronic_invoices_provider_idx on public.electronic_invoices (provider);

-- Forma de config_fields / credential_fields: lista de hasta 20 objetos con
-- `key` (snake_case, única) y `label`. Lo demás (`required`, `help`) es opcional.
create or replace function public._ecf_fields_valid(p jsonb)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) <= 20
     and not exists (
       select 1 from jsonb_array_elements(p) f
       where jsonb_typeof(f) <> 'object'
          or coalesce(f ->> 'key', '') !~ '^[a-z][a-z0-9_]{0,39}$'
          or char_length(btrim(coalesce(f ->> 'label', ''))) not between 1 and 80
          or char_length(coalesce(f ->> 'help', '')) > 200
          or (f ? 'required' and jsonb_typeof(f -> 'required') <> 'boolean'))
     and (select count(distinct f ->> 'key') from jsonb_array_elements(p) f) = jsonb_array_length(p)
$$;
alter table public.ecf_providers drop constraint if exists ecf_providers_fields_chk;
alter table public.ecf_providers add constraint ecf_providers_fields_chk
  check (public._ecf_fields_valid(config_fields) and public._ecf_fields_valid(credential_fields));

-- ── 2. Reasignar lo que aún no salió ────────────────────────────────────────
-- Solo `pending`/`error` SIN track_id: ningún proveedor los tiene. `sending`
-- está en vuelo y `sent` ya lo tiene el proveedor anterior. Se adelanta el
-- siguiente intento: con proveedor nuevo no tiene sentido esperar el backoff
-- de los fallos del anterior.
create or replace function public._ecf_repoint_unsent(p_tenant uuid, p_to text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sim boolean := (select is_simulated from ecf_providers where code = p_to);
  v_n   integer;
begin
  with cand as (
    select id, provider as old_provider from electronic_invoices
    where tenant_id = p_tenant and status in ('pending', 'error') and track_id is null and provider <> p_to
    for update
  ), upd as (
    update electronic_invoices i
       set provider = p_to, simulated = v_sim, next_attempt_at = now()
      from cand
     where i.id = cand.id
    returning i.id, i.tenant_id, i.status, cand.old_provider
  ), ev as (
    insert into electronic_invoice_events (tenant_id, invoice_id, event, status_from, status_to, detail)
    select tenant_id, id, 'provider_changed', status, status, jsonb_build_object('from', old_provider, 'to', p_to)
    from upd
    returning 1
  )
  select count(*) into v_n from ev;
  return v_n;
end;
$$;
revoke all on function public._ecf_repoint_unsent(uuid, text) from public, anon, authenticated;

-- Reglas del catálogo que valen para el negocio y para el panel por igual.
create or replace function public._ecf_check_provider(p_provider text, p_environment text, p_changed boolean)
returns ecf_providers
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v ecf_providers;
begin
  select * into v from ecf_providers where code = p_provider;
  if not found then
    raise exception 'ECF_PROVIDER_UNKNOWN: El proveedor "%" no existe en el catálogo.', p_provider;
  end if;
  -- Quien ya lo usa puede seguir guardando aunque se haya dejado de ofrecer.
  if p_changed and not v.is_enabled then
    raise exception 'ECF_PROVIDER_DISABLED: % no está disponible para elegirlo ahora.', v.name;
  end if;
  if p_environment = 'production' and not v.allows_production then
    -- Mismo texto que 0016 para el simulador: es el caso que más se verá.
    if v.is_simulated then
      raise exception 'ECF_PROVIDER_NOT_PRODUCTION: El simulador no puede usarse en producción: sus comprobantes no tienen validez fiscal. Configura un proveedor autorizado.';
    end if;
    raise exception 'ECF_PROVIDER_NOT_PRODUCTION: % no puede usarse en producción: elige un proveedor autorizado.', v.name;
  end if;
  return v;
end;
$$;
revoke all on function public._ecf_check_provider(text, text, boolean) from public, anon, authenticated;

-- ── 3. Guardado desde el negocio ────────────────────────────────────────────
-- Mismo cuerpo que 0016 con el catálogo en lugar del texto libre: proveedor
-- válido y ofrecido, producción solo si el proveedor la admite, campos
-- obligatorios de su configuración llenos al activar, y reasignación de lo
-- pendiente al cambiar.
create or replace function public.save_fiscal_settings(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_old    fiscal_settings;
  v_new    fiscal_settings;
  v_rnc    text := nullif(regexp_replace(coalesce(p ->> 'rnc', ''), '[^0-9]', '', 'g'), '');
  v_prov   ecf_providers;
  v_missing text;
  v_moved  integer := 0;
begin
  perform public.require_perm('fiscal.manage');
  perform public.require_module('invoicing');
  select * into v_old from fiscal_settings where tenant_id = v_tenant for update;
  if not found then
    insert into fiscal_settings (tenant_id) values (v_tenant) returning * into v_old;
  end if;
  v_new := v_old;
  v_new.rnc            := coalesce(v_rnc, v_old.rnc);
  v_new.legal_name     := coalesce(nullif(btrim(p ->> 'legal_name'), ''), v_old.legal_name);
  v_new.trade_name     := coalesce(nullif(btrim(p ->> 'trade_name'), ''), v_old.trade_name);
  v_new.fiscal_address := coalesce(nullif(btrim(p ->> 'fiscal_address'), ''), v_old.fiscal_address);
  v_new.email          := coalesce(nullif(btrim(p ->> 'email'), ''), v_old.email);
  v_new.phone          := coalesce(nullif(btrim(p ->> 'phone'), ''), v_old.phone);
  v_new.environment    := coalesce(nullif(p ->> 'environment', ''), v_old.environment);
  v_new.provider       := coalesce(nullif(p ->> 'provider', ''), v_old.provider);
  -- La configuración es de CADA proveedor: al cambiar, la del anterior no vale.
  v_new.provider_config := coalesce(p -> 'provider_config',
                                    case when v_new.provider = v_old.provider then v_old.provider_config else '{}'::jsonb end);
  v_new.default_ecf_type := coalesce(nullif(p ->> 'default_ecf_type', ''), v_old.default_ecf_type);
  v_new.ecf_enabled    := coalesce((p ->> 'ecf_enabled')::boolean, v_old.ecf_enabled);

  if jsonb_typeof(v_new.provider_config) <> 'object' then
    raise exception 'La configuración del proveedor debe ser un objeto clave-valor.';
  end if;
  v_prov := public._ecf_check_provider(v_new.provider, v_new.environment, v_new.provider is distinct from v_old.provider);

  if v_new.ecf_enabled and (v_new.rnc is null or v_new.legal_name is null or v_new.fiscal_address is null) then
    raise exception 'Para activar la facturación electrónica completa RNC, razón social y dirección fiscal.';
  end if;
  if v_new.ecf_enabled then
    select string_agg(f ->> 'label', ', ') into v_missing
    from jsonb_array_elements(v_prov.config_fields) f
    where coalesce((f ->> 'required')::boolean, false)
      and btrim(coalesce(v_new.provider_config ->> (f ->> 'key'), '')) = '';
    if v_missing is not null then
      raise exception 'ECF_PROVIDER_CONFIG: Para activar con % completa: %.', v_prov.name, v_missing;
    end if;
  end if;
  if v_new.environment = 'production' and v_new.ecf_enabled and not v_new.credentials_set then
    raise exception 'Para producción primero carga el certificado y las credenciales del proveedor.';
  end if;
  v_new.status := case
    when not v_new.ecf_enabled then 'configuring'
    when v_new.environment = 'production' then 'authorized'
    when v_new.environment = 'certification' then 'certifying'
    else 'configuring' end;

  update fiscal_settings set
    rnc = v_new.rnc, legal_name = v_new.legal_name, trade_name = v_new.trade_name,
    fiscal_address = v_new.fiscal_address, email = v_new.email, phone = v_new.phone,
    environment = v_new.environment, provider = v_new.provider, provider_config = v_new.provider_config,
    default_ecf_type = v_new.default_ecf_type, ecf_enabled = v_new.ecf_enabled, status = v_new.status,
    updated_by = auth.uid()
  where tenant_id = v_tenant;
  if v_new.provider is distinct from v_old.provider then
    v_moved := public._ecf_repoint_unsent(v_tenant, v_new.provider);
  end if;
  perform public.log_audit('fiscal.settings_updated', 'fiscal_settings', v_tenant,
    jsonb_build_object('environment', v_new.environment, 'provider', v_new.provider, 'enabled', v_new.ecf_enabled,
                       'provider_from', case when v_new.provider is distinct from v_old.provider then v_old.provider end,
                       'repointed', v_moved));
end;
$$;

-- ── 4. Panel de plataforma ──────────────────────────────────────────────────

-- Catálogo con su uso: cuántos negocios lo tienen y qué hay en vuelo con él.
create or replace function public.admin_list_ecf_providers()
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
    select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object(
             'tenants',            (select count(*) from fiscal_settings f where f.provider = p.code),
             'enabled_tenants',    (select count(*) from fiscal_settings f where f.provider = p.code and f.ecf_enabled),
             'production_tenants', (select count(*) from fiscal_settings f where f.provider = p.code and f.environment = 'production'),
             'unsent_invoices',    (select count(*) from electronic_invoices i where i.provider = p.code
                                      and i.status in ('pending', 'error') and i.track_id is null),
             'in_flight_invoices', (select count(*) from electronic_invoices i where i.provider = p.code
                                      and (i.status in ('sending', 'sent') or (i.status = 'error' and i.track_id is not null))),
             'total_invoices',     (select count(*) from electronic_invoices i where i.provider = p.code)
           ) order by p.sort_order, p.name), '[]'::jsonb)
    from ecf_providers p
  );
end;
$$;

-- Alta o edición. El código no se cambia (lo referencian negocios, comprobantes
-- y el adaptador): para renombrar se edita `name`.
create or replace function public.admin_save_ecf_provider(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := btrim(coalesce(p ->> 'code', ''));
  v_old  ecf_providers;
  v_new  ecf_providers;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  if v_code !~ '^[a-z][a-z0-9_]{1,39}$' then
    raise exception 'El código va en minúsculas, sin espacios (letras, números y _), y empieza por una letra.';
  end if;
  select * into v_old from ecf_providers where code = v_code for update;
  v_new.code              := v_code;
  v_new.name              := btrim(coalesce(p ->> 'name', v_old.name, ''));
  -- Clave ausente = no tocar; presente y vacía = borrar.
  v_new.description       := case when p ? 'description' then nullif(btrim(p ->> 'description'), '') else v_old.description end;
  v_new.website           := case when p ? 'website' then nullif(btrim(p ->> 'website'), '') else v_old.website end;
  v_new.is_enabled        := coalesce((p ->> 'is_enabled')::boolean, v_old.is_enabled, false);
  v_new.is_simulated      := coalesce((p ->> 'is_simulated')::boolean, v_old.is_simulated, false);
  v_new.allows_production := coalesce((p ->> 'allows_production')::boolean, v_old.allows_production, true);
  v_new.config_fields     := coalesce(p -> 'config_fields', v_old.config_fields, '[]'::jsonb);
  v_new.credential_fields := coalesce(p -> 'credential_fields', v_old.credential_fields, '[]'::jsonb);
  v_new.sort_order        := coalesce((p ->> 'sort_order')::integer, v_old.sort_order, 100);

  if char_length(v_new.name) < 2 then
    raise exception 'Escribe el nombre del proveedor.';
  end if;
  if v_new.is_simulated and v_new.allows_production then
    raise exception 'Un proveedor simulado no puede permitir producción: sus comprobantes no tienen validez fiscal.';
  end if;
  if not public._ecf_fields_valid(v_new.config_fields) or not public._ecf_fields_valid(v_new.credential_fields) then
    raise exception 'Revisa los campos: cada uno necesita una clave única en minúsculas (p. ej. issuer_id) y una etiqueta.';
  end if;
  -- Quitar «producción» a un proveedor con negocios en producción los dejaría
  -- en un estado que su propia configuración ya no permite guardar.
  if v_old.code is not null and v_old.allows_production and not v_new.allows_production
     and exists (select 1 from fiscal_settings where provider = v_code and environment = 'production') then
    raise exception 'ECF_PROVIDER_IN_USE: Hay negocios en producción con este proveedor. Muévelos antes de quitarle producción.';
  end if;

  if v_old.code is null then
    insert into ecf_providers (code, name, description, website, is_enabled, is_simulated, allows_production,
                               config_fields, credential_fields, sort_order)
    values (v_new.code, v_new.name, v_new.description, v_new.website, v_new.is_enabled, v_new.is_simulated,
            v_new.allows_production, v_new.config_fields, v_new.credential_fields, v_new.sort_order);
    perform public._platform_audit('ecf_provider.create', null, jsonb_build_object('code', v_code, 'name', v_new.name));
  else
    update ecf_providers set
      name = v_new.name, description = v_new.description, website = v_new.website, is_enabled = v_new.is_enabled,
      is_simulated = v_new.is_simulated, allows_production = v_new.allows_production,
      config_fields = v_new.config_fields, credential_fields = v_new.credential_fields, sort_order = v_new.sort_order
    where code = v_code;
    perform public._platform_audit('ecf_provider.update', null, jsonb_build_object('code', v_code, 'name', v_new.name,
      'changes', public._jsonb_diff(to_jsonb(v_old), to_jsonb(v_new), array['created_at', 'updated_at'])));
  end if;
end;
$$;

create or replace function public.admin_delete_ecf_provider(p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  select name into v_name from ecf_providers where code = p_code for update;
  if v_name is null then
    raise exception 'Proveedor no encontrado';
  end if;
  -- Las FK lo impedirían igual; aquí se dice por qué y qué hacer.
  if exists (select 1 from fiscal_settings where provider = p_code)
     or exists (select 1 from electronic_invoices where provider = p_code) then
    raise exception 'ECF_PROVIDER_IN_USE: % tiene negocios o comprobantes. Desactívalo para que no se elija más; su historial lo necesita.', v_name;
  end if;
  delete from ecf_providers where code = p_code;
  perform public._platform_audit('ecf_provider.delete', null, jsonb_build_object('code', p_code, 'name', v_name));
end;
$$;

-- Estado fiscal de un negocio visto desde el panel: proveedor, ambiente y lo
-- que se reasignaría al cambiarlo. Sin RNC ni datos del contribuyente.
create or replace function public.admin_get_tenant_ecf(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v fiscal_settings;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  select * into v from fiscal_settings where tenant_id = p_tenant;
  return jsonb_build_object(
    'configured',      v.tenant_id is not null,
    'provider',        coalesce(v.provider, 'simulator'),
    'environment',     coalesce(v.environment, 'test'),
    'status',          coalesce(v.status, 'not_configured'),
    'ecf_enabled',     coalesce(v.ecf_enabled, false),
    'credentials_set', coalesce(v.credentials_set, false),
    'unsent_invoices', (select count(*) from electronic_invoices where tenant_id = p_tenant
                          and status in ('pending', 'error') and track_id is null),
    'in_flight_invoices', (select count(*) from electronic_invoices where tenant_id = p_tenant
                          and (status in ('sending', 'sent') or (status = 'error' and track_id is not null)))
  );
end;
$$;

-- Un negocio a otro proveedor (soporte). Misma regla que el negocio: tiene que
-- estar ofrecido y admitir su ambiente. La configuración del anterior se
-- descarta (es suya); el certificado sigue cargado.
create or replace function public._ecf_switch_tenant(p_tenant uuid, p_to text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fs    fiscal_settings;
  v_prov  ecf_providers;
  v_moved integer;
begin
  select * into v_fs from fiscal_settings where tenant_id = p_tenant for update;
  -- Se valida ANTES de escribir: un código inexistente debe dar el mensaje del
  -- catálogo, no el error técnico de la clave foránea.
  v_prov := public._ecf_check_provider(p_to, coalesce(v_fs.environment, 'test'), v_fs.provider is distinct from p_to);
  if v_fs.tenant_id is null then
    -- Negocio que nunca abrió su configuración fiscal: se crea con el proveedor
    -- (desactivada, en pruebas). `from` queda null: «desde nada».
    insert into fiscal_settings (tenant_id, provider) values (p_tenant, p_to);
  end if;
  update fiscal_settings
     set provider = p_to,
         provider_config = case when provider = p_to then provider_config else '{}'::jsonb end,
         updated_by = auth.uid()
   where tenant_id = p_tenant;
  v_moved := public._ecf_repoint_unsent(p_tenant, p_to);
  insert into audit_logs (tenant_id, user_id, action, entity, entity_id, meta)
  values (p_tenant, auth.uid(), 'fiscal.provider_changed_by_platform', 'fiscal_settings', p_tenant,
          jsonb_build_object('from', v_fs.provider, 'to', p_to, 'reason', p_reason, 'repointed', v_moved));
  return jsonb_build_object('from', v_fs.provider, 'to', p_to, 'repointed', v_moved,
    'missing_config', (select coalesce(jsonb_agg(f ->> 'label'), '[]'::jsonb) from jsonb_array_elements(v_prov.config_fields) f
                       where coalesce((f ->> 'required')::boolean, false)));
end;
$$;
revoke all on function public._ecf_switch_tenant(uuid, text, text) from public, anon, authenticated;

create or replace function public.admin_set_tenant_ecf_provider(p_tenant uuid, p_provider text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  r        jsonb;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  if char_length(v_reason) < 5 then
    raise exception 'ECF_REASON_REQUIRED: Escribe el motivo del cambio (al menos 5 caracteres). Queda en la bitácora del negocio.';
  end if;
  if not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'Negocio no encontrado';
  end if;
  r := public._ecf_switch_tenant(p_tenant, p_provider, v_reason);
  perform public._platform_audit('ecf.provider_change', p_tenant, r || jsonb_build_object('reason', v_reason));
  return r;
end;
$$;

-- Todos los negocios de un proveedor a otro (el día que se conecte uno
-- autorizado, o si uno deja de servir). Los que están en producción no se
-- mueven a un proveedor que no la admite: se cuentan como omitidos.
create or replace function public.admin_migrate_ecf_provider(p_from text, p_to text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_to      ecf_providers;
  v_moved   integer := 0;
  v_skipped integer := 0;
  v_repoint integer := 0;
  t         record;
  r         jsonb;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  set local statement_timeout = '50s';
  if char_length(v_reason) < 5 then
    raise exception 'ECF_REASON_REQUIRED: Escribe el motivo de la migración (al menos 5 caracteres). Queda en la bitácora.';
  end if;
  if p_from = p_to then
    raise exception 'El proveedor de origen y el de destino son el mismo.';
  end if;
  if not exists (select 1 from ecf_providers where code = p_from) then
    raise exception 'ECF_PROVIDER_UNKNOWN: El proveedor "%" no existe en el catálogo.', p_from;
  end if;
  select * into v_to from ecf_providers where code = p_to;
  if not found then
    raise exception 'ECF_PROVIDER_UNKNOWN: El proveedor "%" no existe en el catálogo.', p_to;
  end if;
  if not v_to.is_enabled then
    raise exception 'ECF_PROVIDER_DISABLED: Activa % antes de migrar negocios a él.', v_to.name;
  end if;

  for t in select tenant_id, environment from fiscal_settings where provider = p_from order by tenant_id for update loop
    if t.environment = 'production' and not v_to.allows_production then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    r := public._ecf_switch_tenant(t.tenant_id, p_to, v_reason);
    v_moved := v_moved + 1;
    v_repoint := v_repoint + (r ->> 'repointed')::integer;
  end loop;

  r := jsonb_build_object('from', p_from, 'to', p_to, 'moved', v_moved, 'skipped_production', v_skipped,
                          'repointed', v_repoint, 'reason', v_reason);
  perform public._platform_audit('ecf.provider_migrate', null, r);
  return r;
end;
$$;

do $$
declare
  f   text;
  fns text[] := array[
    'public.save_fiscal_settings(jsonb)',
    'public.admin_list_ecf_providers()',
    'public.admin_save_ecf_provider(jsonb)',
    'public.admin_delete_ecf_provider(text)',
    'public.admin_get_tenant_ecf(uuid)',
    'public.admin_set_tenant_ecf_provider(uuid, text, text)',
    'public.admin_migrate_ecf_provider(text, text, text)'
  ];
begin
  foreach f in array fns loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke all on function public._ecf_fields_valid(jsonb) from public, anon;

notify pgrst, 'reload schema';
