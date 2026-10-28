-- ═══ Ferddo · 0016 · Facturación electrónica (e-CF DGII) ═══
--
-- Por qué así:
--   · Cada empresa factura con SU identidad fiscal (fiscal_settings.rnc). La
--     plataforma no emite nada con su propio RNC.
--   · El ciclo fiscal está DESACOPLADO de la venta: create_sale() solo deja el
--     documento en `pending` con su e-NCF reservado. El envío lo hace la Edge
--     Function `ecf` con un proveedor intercambiable (ElectronicInvoiceProvider),
--     reclamando lotes con `for update skip locked` para que dos procesadores
--     nunca envíen el mismo documento.
--   · Estados comercial y fiscal separados (sale_status ≠ ecf_status) y una
--     bitácora inmutable de cada comunicación (electronic_invoice_events).
--   · Certificados y credenciales: tabla fiscal_secrets SIN ningún permiso
--     para el cliente; la escribe y lee solo la Edge Function (service_role),
--     cifrada con una clave que vive en `supabase secrets`, nunca en la base.
--
-- Lo que NO hace (y está documentado en docs/SAAS_IMPLEMENTATION_PLAN.md): no
-- genera el XML firmado según el XSD oficial ni habla directamente con los
-- servicios de la DGII. Eso lo hace el proveedor autorizado que se conecte,
-- o un adaptador directo cuando la empresa complete su certificación.

-- ── Catálogo de tipos de e-CF (configuración global) ───────────────────────
create table if not exists public.ecf_types (
  code               text primary key,
  name               text not null,
  requires_buyer_id  boolean not null default false,
  is_note            boolean not null default false,
  -- Si Ferddo ya sabe originarlo desde sus documentos (venta, devolución…).
  is_supported       boolean not null default false,
  sort_order         integer not null default 0
);
alter table public.ecf_types enable row level security;
drop policy if exists ecf_types_read on public.ecf_types;
create policy ecf_types_read on public.ecf_types for select to authenticated using (true);
revoke all on public.ecf_types from anon;
revoke insert, update, delete on public.ecf_types from authenticated;
grant select on public.ecf_types to authenticated;

-- Tipos publicados por la DGII (dgii.gov.do → Comprobantes Fiscales Electrónicos).
insert into public.ecf_types (code, name, requires_buyer_id, is_note, is_supported, sort_order) values
  ('31', 'Factura de Crédito Fiscal Electrónica', true,  false, true,  1),
  ('32', 'Factura de Consumo Electrónica',        false, false, true,  2),
  ('33', 'Nota de Débito Electrónica',            false, true,  false, 3),
  ('34', 'Nota de Crédito Electrónica',           false, true,  true,  4),
  ('41', 'Compras Electrónico',                   false, false, false, 5),
  ('43', 'Gastos Menores Electrónico',            false, false, false, 6),
  ('44', 'Regímenes Especiales Electrónica',      true,  false, false, 7),
  ('45', 'Gubernamental Electrónico',             true,  false, false, 8),
  ('46', 'Exportaciones Electrónico',             false, false, false, 9),
  ('47', 'Pagos al Exterior Electrónico',         false, false, false, 10)
on conflict (code) do update set name = excluded.name;

-- Cuota mensual de e-CF por plan (NULL = sin tope).
alter table public.plan_settings add column if not exists max_ecf_monthly integer
  check (max_ecf_monthly is null or max_ecf_monthly >= 0);

-- ── Configuración fiscal por empresa ────────────────────────────────────────
create table if not exists public.fiscal_settings (
  tenant_id        uuid primary key references public.tenants (id) on delete cascade,
  ecf_enabled      boolean not null default false,
  -- test / certification / production. El simulador NUNCA en producción.
  environment      text not null default 'test' check (environment in ('test', 'certification', 'production')),
  provider         text not null default 'simulator',
  -- Configuración NO secreta del proveedor (ids, endpoints que el proveedor
  -- documente). Las credenciales van a fiscal_secrets.
  provider_config  jsonb not null default '{}'::jsonb,
  status           text not null default 'not_configured'
                   check (status in ('not_configured', 'configuring', 'certifying', 'authorized', 'suspended')),
  rnc              text check (rnc is null or rnc ~ '^([0-9]{9}|[0-9]{11})$'),
  legal_name       text,
  trade_name       text,
  fiscal_address   text,
  email            text,
  phone            text,
  default_ecf_type text not null default '32' references public.ecf_types (code),
  -- Metadatos del certificado (sujeto, vencimiento). El certificado en sí no.
  certificate_info jsonb,
  credentials_set  boolean not null default false,
  updated_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (not (provider = 'simulator' and environment = 'production'))
);
select public._setup_tenant_table('fiscal_settings', null);
drop policy if exists fiscal_settings_select on public.fiscal_settings;
create policy fiscal_settings_select on public.fiscal_settings for select to authenticated
  using (tenant_id = (select public.auth_tenant_id())
         and ((select public.has_perm('ecf.view')) or (select public.has_perm('fiscal.manage'))
              or (select public.has_perm('sales.create'))));

create table if not exists public.fiscal_secrets (
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  kind        text not null check (kind in ('certificate', 'certificate_password', 'provider_credentials')),
  ciphertext  text not null,
  iv          text not null,
  key_version integer not null default 1,
  created_at  timestamptz not null default now(),
  rotated_at  timestamptz,
  primary key (tenant_id, kind)
);
alter table public.fiscal_secrets enable row level security;
-- Sin políticas y sin permisos: ni el dueño de la empresa puede leerlos de
-- vuelta. Solo service_role (Edge Function), que se salta la RLS.
revoke all on public.fiscal_secrets from anon, authenticated;

-- Rangos de e-NCF autorizados por la DGII, por tipo.
create table if not exists public.fiscal_sequences (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  ecf_type          text not null references public.ecf_types (code),
  start_number      bigint not null check (start_number > 0),
  end_number        bigint not null,
  next_number       bigint not null,
  expires_on        date,
  authorization_ref text,
  is_active         boolean not null default true,
  created_by        uuid references auth.users (id) on delete set null default auth.uid(),
  created_at        timestamptz not null default now(),
  check (end_number >= start_number),
  check (next_number between start_number and end_number + 1),
  check (end_number < 10000000000)
);
create index if not exists fiscal_sequences_tenant_idx on public.fiscal_sequences (tenant_id, ecf_type, is_active);
create index if not exists fiscal_sequences_created_by_idx on public.fiscal_sequences (created_by);
select public._setup_tenant_table('fiscal_sequences', null);

-- ── Documentos fiscales ─────────────────────────────────────────────────────
create table if not exists public.electronic_invoices (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants (id) on delete cascade,
  branch_id            uuid,
  source_type          text not null check (source_type in ('sale', 'sale_return')),
  source_id            uuid not null,
  ecf_type             text not null references public.ecf_types (code),
  encf                 text not null,
  environment          text not null,
  provider             text not null,
  simulated            boolean not null default false,
  issue_date           timestamptz not null default now(),
  buyer_id_type        text,
  buyer_id             text,
  buyer_name           text,
  currency             text not null default 'DOP',
  subtotal             numeric(14, 2) not null,
  tax_total            numeric(14, 2) not null,
  total                numeric(14, 2) not null,
  reference_invoice_id uuid references public.electronic_invoices (id),
  reference_encf       text,
  status               ecf_status not null default 'pending',
  track_id             text,
  security_code        text,
  qr_url               text,
  signed_at            timestamptz,
  sent_at              timestamptz,
  resolved_at          timestamptz,
  messages             jsonb not null default '[]'::jsonb,
  xml_path             text,
  attempts             integer not null default 0,
  next_attempt_at      timestamptz not null default now(),
  last_error           text,
  created_by           uuid references auth.users (id) on delete set null default auth.uid(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (tenant_id, id),
  -- Ni dos documentos con el mismo e-NCF, ni dos del mismo tipo para el
  -- mismo origen: la emisión duplicada es imposible por construcción.
  unique (tenant_id, encf),
  unique (tenant_id, source_type, source_id, ecf_type)
);
create index if not exists electronic_invoices_tenant_idx on public.electronic_invoices (tenant_id, created_at desc);
create index if not exists electronic_invoices_queue_idx on public.electronic_invoices (status, next_attempt_at)
  where status in ('pending', 'sending', 'sent', 'error');
create index if not exists electronic_invoices_source_idx on public.electronic_invoices (source_type, source_id);
create index if not exists electronic_invoices_ref_idx on public.electronic_invoices (reference_invoice_id);
create index if not exists electronic_invoices_created_by_idx on public.electronic_invoices (created_by);
select public._setup_tenant_table('electronic_invoices', null);

create table if not exists public.electronic_invoice_events (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  invoice_id uuid not null,
  event      text not null,
  status_from ecf_status,
  status_to  ecf_status,
  -- Resumen SANEADO de la petición/respuesta: nunca certificados ni tokens.
  detail     jsonb,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, invoice_id) references public.electronic_invoices (tenant_id, id) on delete cascade
);
create index if not exists electronic_invoice_events_invoice_idx on public.electronic_invoice_events (invoice_id, created_at);
create index if not exists electronic_invoice_events_created_by_idx on public.electronic_invoice_events (created_by);
select public._setup_tenant_table('electronic_invoice_events', null);
drop trigger if exists trg_immutable on public.electronic_invoice_events;
create trigger trg_immutable before update or delete on public.electronic_invoice_events
  for each row execute function public.prevent_mutation();

-- Lo fiscal lo ve quien tenga ecf.view o quien vende (para reimprimir).
drop policy if exists electronic_invoices_select on public.electronic_invoices;
create policy electronic_invoices_select on public.electronic_invoices for select to authenticated
  using (tenant_id = (select public.auth_tenant_id())
         and ((select public.has_perm('ecf.view')) or (select public.has_perm('sales.create'))));

-- ── Reserva de e-NCF ────────────────────────────────────────────────────────
-- Formato: E + tipo (2) + secuencial (10) = 13 caracteres.
create or replace function public.next_encf(p_tenant uuid, p_type text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq fiscal_sequences;
begin
  select * into v_seq from fiscal_sequences
  where tenant_id = p_tenant and ecf_type = p_type and is_active
    and next_number <= end_number
    and (expires_on is null or expires_on >= current_date)
  order by start_number
  limit 1
  for update;
  if not found then
    raise exception 'ECF_SEQUENCE: No hay secuencia de e-NCF disponible para el tipo %. Regístrala en Facturación electrónica.', p_type;
  end if;
  update fiscal_sequences set next_number = next_number + 1 where id = v_seq.id;
  return 'E' || p_type || lpad(v_seq.next_number::text, 10, '0');
end;
$$;
revoke all on function public.next_encf(uuid, text) from public, anon, authenticated;

create or replace function public.ecf_check_quota(p_tenant uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max   integer;
  v_name  text;
  v_used  integer;
  v_tz    text;
begin
  select ps.max_ecf_monthly, ps.name into v_max, v_name
  from subscriptions s join plan_settings ps on ps.plan = s.plan where s.tenant_id = p_tenant;
  if v_max is null then
    return;
  end if;
  select timezone into v_tz from tenants where id = p_tenant;
  select count(*) into v_used from electronic_invoices
  where tenant_id = p_tenant and status <> 'voided'
    and created_at >= (date_trunc('month', now() at time zone v_tz) at time zone v_tz);
  if v_used >= v_max then
    raise exception 'PLAN_LIMIT_ECF: El plan % incluye % comprobantes electrónicos al mes. Actualiza tu plan para emitir más.', v_name, v_max;
  end if;
end;
$$;
revoke all on function public.ecf_check_quota(uuid) from public, anon, authenticated;

create or replace function public.ecf_log(p_invoice uuid, p_event text, p_from ecf_status, p_to ecf_status, p_detail jsonb default null)
returns void
language sql
security definer
set search_path = public
as $$
  insert into electronic_invoice_events (tenant_id, invoice_id, event, status_from, status_to, detail)
  select tenant_id, id, p_event, p_from, p_to, p_detail from electronic_invoices where id = p_invoice
$$;
revoke all on function public.ecf_log(uuid, text, ecf_status, ecf_status, jsonb) from public, anon, authenticated;

-- Llamada desde create_sale(); misma transacción que la venta.
create or replace function public.ecf_create_for_sale(p_sale uuid, p_type text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s    sales;
  v_fs   fiscal_settings;
  v_t    ecf_types;
  v_c    customers;
  v_encf text;
  v_id   uuid;
begin
  perform public.require_module('invoicing');
  select * into v_s from sales where id = p_sale;
  select * into v_fs from fiscal_settings where tenant_id = v_s.tenant_id;
  if not found or not v_fs.ecf_enabled then
    raise exception 'ECF_DISABLED: La facturación electrónica no está activada en esta empresa.';
  end if;
  select * into v_t from ecf_types where code = p_type;
  if not found or not v_t.is_supported or v_t.is_note then
    raise exception 'Tipo de comprobante % no disponible para ventas', p_type;
  end if;
  if v_s.customer_id is not null then
    select * into v_c from customers where id = v_s.customer_id;
  end if;
  -- Crédito fiscal: el comprador debe estar identificado con RNC o cédula.
  if v_t.requires_buyer_id and (v_c.id is null or v_c.doc_type not in ('rnc', 'cedula')) then
    raise exception 'ECF_BUYER: Para % el cliente debe tener RNC o cédula.', v_t.name;
  end if;
  perform public.ecf_check_quota(v_s.tenant_id);
  v_encf := public.next_encf(v_s.tenant_id, p_type);

  insert into electronic_invoices (tenant_id, branch_id, source_type, source_id, ecf_type, encf, environment,
                                   provider, simulated, buyer_id_type, buyer_id, buyer_name,
                                   subtotal, tax_total, total)
  values (v_s.tenant_id, v_s.branch_id, 'sale', p_sale, p_type, v_encf, v_fs.environment, v_fs.provider,
          v_fs.provider = 'simulator', v_c.doc_type, v_c.doc_number, v_c.name,
          v_s.subtotal, v_s.tax_total, v_s.total)
  returning id into v_id;
  perform public.ecf_log(v_id, 'created', null, 'pending', jsonb_build_object('source', 'sale', 'number', v_s.number));
  return jsonb_build_object('invoice_id', v_id, 'encf', v_encf, 'status', 'pending', 'simulated', v_fs.provider = 'simulator');
end;
$$;
revoke all on function public.ecf_create_for_sale(uuid, text) from public, anon, authenticated;

-- Nota de crédito (34) por una devolución de una venta con e-CF.
create or replace function public.ecf_create_credit_note(p_return uuid, p_original uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_r    sale_returns;
  v_o    electronic_invoices;
  v_fs   fiscal_settings;
  v_encf text;
  v_id   uuid;
begin
  select * into v_r from sale_returns where id = p_return;
  select * into v_o from electronic_invoices where id = p_original;
  select * into v_fs from fiscal_settings where tenant_id = v_r.tenant_id;
  if not coalesce(v_fs.ecf_enabled, false) then
    raise exception 'ECF_DISABLED: La venta tiene comprobante electrónico pero la facturación está desactivada; reactívala para emitir la nota de crédito.';
  end if;
  perform public.ecf_check_quota(v_r.tenant_id);
  v_encf := public.next_encf(v_r.tenant_id, '34');
  insert into electronic_invoices (tenant_id, branch_id, source_type, source_id, ecf_type, encf, environment,
                                   provider, simulated, buyer_id_type, buyer_id, buyer_name, subtotal, tax_total,
                                   total, reference_invoice_id, reference_encf)
  values (v_r.tenant_id, v_o.branch_id, 'sale_return', p_return, '34', v_encf, v_fs.environment, v_fs.provider,
          v_fs.provider = 'simulator', v_o.buyer_id_type, v_o.buyer_id, v_o.buyer_name, v_r.subtotal, v_r.tax_total,
          v_r.total, v_o.id, v_o.encf)
  returning id into v_id;
  perform public.ecf_log(v_id, 'created', null, 'pending', jsonb_build_object('source', 'sale_return', 'references', v_o.encf));
  return jsonb_build_object('invoice_id', v_id, 'encf', v_encf, 'status', 'pending');
end;
$$;
revoke all on function public.ecf_create_credit_note(uuid, uuid) from public, anon, authenticated;

-- ── Administración desde la app ─────────────────────────────────────────────
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
  v_new.provider_config := coalesce(p -> 'provider_config', v_old.provider_config);
  v_new.default_ecf_type := coalesce(nullif(p ->> 'default_ecf_type', ''), v_old.default_ecf_type);
  v_new.ecf_enabled    := coalesce((p ->> 'ecf_enabled')::boolean, v_old.ecf_enabled);

  if v_new.provider = 'simulator' and v_new.environment = 'production' then
    raise exception 'El simulador no puede usarse en producción: configura un proveedor autorizado.';
  end if;
  if v_new.ecf_enabled and (v_new.rnc is null or v_new.legal_name is null or v_new.fiscal_address is null) then
    raise exception 'Para activar la facturación electrónica completa RNC, razón social y dirección fiscal.';
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
  perform public.log_audit('fiscal.settings_updated', 'fiscal_settings', v_tenant,
    jsonb_build_object('environment', v_new.environment, 'provider', v_new.provider, 'enabled', v_new.ecf_enabled));
end;
$$;

create or replace function public.add_fiscal_sequence(
  p_type text, p_start bigint, p_end bigint, p_expires_on date default null, p_authorization_ref text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_id     uuid;
begin
  perform public.require_perm('fiscal.manage');
  if not exists (select 1 from ecf_types where code = p_type) then
    raise exception 'Tipo de e-CF inválido';
  end if;
  if p_start is null or p_end is null or p_start < 1 or p_end < p_start then
    raise exception 'Rango inválido';
  end if;
  -- Dos rangos activos solapados del mismo tipo podrían repetir un e-NCF.
  if exists (select 1 from fiscal_sequences where tenant_id = v_tenant and ecf_type = p_type
             and int8range(start_number, end_number, '[]') && int8range(p_start, p_end, '[]')) then
    raise exception 'El rango se solapa con otro ya registrado para el tipo %', p_type;
  end if;
  insert into fiscal_sequences (tenant_id, ecf_type, start_number, end_number, next_number, expires_on, authorization_ref)
  values (v_tenant, p_type, p_start, p_end, p_start, p_expires_on, nullif(btrim(p_authorization_ref), ''))
  returning id into v_id;
  perform public.log_audit('fiscal.sequence_added', 'fiscal_sequence', v_id,
                           jsonb_build_object('type', p_type, 'start', p_start, 'end', p_end));
  return v_id;
end;
$$;

create or replace function public.set_fiscal_sequence_active(p_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_perm('fiscal.manage');
  update fiscal_sequences set is_active = p_active where id = p_id and tenant_id = public.auth_tenant_id();
  if not found then
    raise exception 'Secuencia no encontrada';
  end if;
  perform public.log_audit('fiscal.sequence_' || case when p_active then 'enabled' else 'disabled' end, 'fiscal_sequence', p_id);
end;
$$;

-- Reintento manual de un documento en error técnico. Un RECHAZO no se
-- reintenta: el contenido estaba mal y hay que emitir otro documento.
create or replace function public.ecf_retry(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status ecf_status;
begin
  perform public.require_perm('ecf.manage');
  select status into v_status from electronic_invoices where id = p_id and tenant_id = public.auth_tenant_id() for update;
  if v_status is null then
    raise exception 'Comprobante no encontrado';
  end if;
  if v_status <> 'error' then
    raise exception 'Solo se reintentan comprobantes con error técnico';
  end if;
  update electronic_invoices set status = 'pending', next_attempt_at = now() where id = p_id;
  perform public.ecf_log(p_id, 'manual_retry', v_status, 'pending');
end;
$$;

-- ── Cola del procesador (solo service_role, desde la Edge Function) ────────
-- Contenido canónico del documento (JSON). El adaptador del proveedor lo
-- traduce a su formato; Ferddo no inventa el XML oficial.
create or replace function public.ecf_build_payload(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_i  electronic_invoices;
  v_fs fiscal_settings;
  v_items jsonb;
begin
  select * into v_i from electronic_invoices where id = p_id;
  select * into v_fs from fiscal_settings where tenant_id = v_i.tenant_id;
  if v_i.source_type = 'sale' then
    select jsonb_agg(jsonb_build_object(
             'line', si.line_no, 'description', si.description, 'quantity', si.quantity,
             'unit', p.unit, 'unit_price', si.unit_price, 'discount', si.discount,
             'tax_rate', si.tax_rate, 'subtotal', si.subtotal, 'tax', si.tax_amount, 'total', si.total,
             'kind', p.kind) order by si.line_no)
    into v_items
    from sale_items si join products p on p.id = si.product_id
    where si.sale_id = v_i.source_id;
  else
    select jsonb_agg(jsonb_build_object(
             'line', si.line_no, 'description', si.description, 'quantity', ri.quantity,
             'unit', p.unit, 'unit_price', si.unit_price, 'tax_rate', si.tax_rate,
             'subtotal', ri.subtotal, 'tax', ri.tax_amount, 'total', ri.total, 'kind', p.kind) order by si.line_no)
    into v_items
    from sale_return_items ri
    join sale_items si on si.id = ri.sale_item_id
    join products p on p.id = si.product_id
    where ri.return_id = v_i.source_id;
  end if;
  return jsonb_build_object(
    'invoice_id', v_i.id, 'tenant_id', v_i.tenant_id, 'ecf_type', v_i.ecf_type, 'encf', v_i.encf,
    'environment', v_i.environment, 'provider', v_i.provider, 'issue_date', v_i.issue_date,
    'currency', v_i.currency,
    'issuer', jsonb_build_object('rnc', v_fs.rnc, 'legal_name', v_fs.legal_name, 'trade_name', v_fs.trade_name,
                                 'address', v_fs.fiscal_address, 'email', v_fs.email, 'phone', v_fs.phone),
    'buyer', case when v_i.buyer_id is null and v_i.buyer_name is null then null
                  else jsonb_build_object('id_type', v_i.buyer_id_type, 'id', v_i.buyer_id, 'name', v_i.buyer_name) end,
    'items', coalesce(v_items, '[]'::jsonb),
    'totals', jsonb_build_object('subtotal', v_i.subtotal, 'tax', v_i.tax_total, 'total', v_i.total),
    'reference', case when v_i.reference_encf is null then null
                      else jsonb_build_object('encf', v_i.reference_encf,
                                              'issue_date', (select issue_date from electronic_invoices where id = v_i.reference_invoice_id)) end,
    'provider_config', v_fs.provider_config,
    'track_id', v_i.track_id
  );
end;
$$;

-- Reclama un lote: los pendientes/errores vencidos se ENVÍAN; los `sent`
-- (en proceso) se CONSULTAN. skip locked = dos procesadores nunca toman el
-- mismo documento; un `sending` de más de 10 min (procesador caído) se recupera.
create or replace function public.ecf_claim(p_tenant uuid default null, p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb := '[]'::jsonb;
  v_r    record;
begin
  for v_r in
    select id, status from electronic_invoices
    where (p_tenant is null or tenant_id = p_tenant)
      and next_attempt_at <= now()
      and (status in ('pending', 'error', 'sent')
           or (status = 'sending' and updated_at < now() - interval '10 minutes'))
      and attempts < 12
    order by next_attempt_at
    limit greatest(least(coalesce(p_limit, 20), 100), 1)
    for update skip locked
  loop
    update electronic_invoices
       set status = case when v_r.status = 'sent' then 'sent' else 'sending' end::ecf_status,
           attempts = attempts + 1,
           next_attempt_at = now() + interval '2 minutes'
     where id = v_r.id;
    v_rows := v_rows || jsonb_build_object(
      'action', case when v_r.status = 'sent' then 'status' else 'submit' end,
      'payload', public.ecf_build_payload(v_r.id));
  end loop;
  return v_rows;
end;
$$;

-- Resultado del proveedor. p_result:
-- { status: sent|accepted|accepted_conditional|rejected|error, track_id?, security_code?,
--   qr_url?, signed_at?, messages?: [...], xml_path?, error? }
create or replace function public.ecf_record_result(p_id uuid, p_result jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_i    electronic_invoices;
  v_to   ecf_status := (p_result ->> 'status')::ecf_status;
begin
  select * into v_i from electronic_invoices where id = p_id for update;
  if not found then
    raise exception 'Comprobante no encontrado';
  end if;
  if v_i.status in ('accepted', 'accepted_conditional', 'rejected', 'voided') then
    return; -- veredicto final: un resultado tardío o repetido no lo cambia
  end if;
  update electronic_invoices set
    status        = v_to,
    track_id      = coalesce(p_result ->> 'track_id', track_id),
    security_code = coalesce(p_result ->> 'security_code', security_code),
    qr_url        = coalesce(p_result ->> 'qr_url', qr_url),
    signed_at     = coalesce((p_result ->> 'signed_at')::timestamptz, signed_at),
    xml_path      = coalesce(p_result ->> 'xml_path', xml_path),
    sent_at       = case when v_to in ('sent', 'accepted', 'accepted_conditional', 'rejected')
                         then coalesce(sent_at, now()) else sent_at end,
    resolved_at   = case when v_to in ('accepted', 'accepted_conditional', 'rejected') then now() end,
    messages      = coalesce(p_result -> 'messages', messages),
    last_error    = case when v_to = 'error' then left(p_result ->> 'error', 1000) end,
    -- Reintentos con espera exponencial: 1, 2, 4… minutos, tope 6 h.
    next_attempt_at = case
      when v_to = 'error' then now() + least(interval '1 minute' * power(2, v_i.attempts), interval '6 hours')
      when v_to = 'sent'  then now() + interval '1 minute' * least(power(2, v_i.attempts), 60)
      else next_attempt_at end
  where id = p_id;
  insert into electronic_invoice_events (tenant_id, invoice_id, event, status_from, status_to, detail, created_by)
  values (v_i.tenant_id, p_id, 'provider_result', v_i.status, v_to,
          jsonb_build_object('track_id', p_result ->> 'track_id', 'messages', p_result -> 'messages',
                             'error', left(p_result ->> 'error', 1000)), null);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.ecf_build_payload(uuid)', 'public.ecf_claim(uuid, integer)', 'public.ecf_record_result(uuid, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.save_fiscal_settings(jsonb)',
    'public.add_fiscal_sequence(text, bigint, bigint, date, text)',
    'public.set_fiscal_sequence_active(uuid, boolean)',
    'public.ecf_retry(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
