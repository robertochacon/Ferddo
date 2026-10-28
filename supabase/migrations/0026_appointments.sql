-- ═══ Ferddo · 0026 · Citas y agenda ═══
--
-- Por qué: consultorios, oficinas profesionales y empresas de servicios
-- venden TIEMPO, no mercancía. El módulo 'appointments' da una agenda por
-- profesional (miembro del equipo) con estados, y el cobro de la cita pasa
-- por create_sale como el restaurante y el taller: caja, crédito, e-CF y
-- reportes funcionan igual.
--
-- Dos citas del mismo profesional no se pueden solapar. Lo garantiza una
-- restricción de exclusión (btree_gist), no una consulta previa: dos altas
-- simultáneas no pueden colarse ambas.

create extension if not exists btree_gist with schema extensions;

do $$ begin
  create type appointment_status as enum ('scheduled', 'confirmed', 'in_progress', 'done', 'canceled', 'no_show');
exception when duplicate_object then null; end $$;

-- ── Módulo y permisos ───────────────────────────────────────────────────────
insert into public.permissions (code, module, label, sort_order) values
  ('appointments.manage', 'appointments', 'Agendar y gestionar citas', 100)
on conflict (code) do update set module = excluded.module, label = excluded.label, sort_order = excluded.sort_order;

insert into public.default_role_permissions (role, permission)
select r::member_role, 'appointments.manage'
from unnest(array['admin', 'supervisor', 'cashier', 'seller', 'service']) r
on conflict do nothing;

insert into public.role_permissions (tenant_id, role, permission)
select t.id, d.role, d.permission
from public.tenants t
cross join public.default_role_permissions d
where d.permission = 'appointments.manage'
on conflict do nothing;

update public.business_types
set modules = array_append(modules, 'appointments')
where code in ('clinic', 'professional', 'services') and not ('appointments' = any (modules));

-- Las empresas de esos rubros que ya existen lo reciben activado.
update public.tenants
set modules = array_append(modules, 'appointments')
where business_type in ('clinic', 'professional', 'services') and not ('appointments' = any (modules));

update public.plan_settings
set modules = array_append(modules, 'appointments'),
    features = case when 'Agenda de citas' = any (features) then features
                    else array_append(features, 'Agenda de citas') end
where plan = 'pro' and modules is not null and not ('appointments' = any (modules));

-- ── Tabla ───────────────────────────────────────────────────────────────────
create table if not exists public.appointments (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  branch_id     uuid not null,
  customer_id   uuid,
  -- Para quien aún no es cliente registrado (una llamada, un WhatsApp).
  contact_name  text,
  contact_phone text,
  staff_id      uuid references auth.users (id) on delete set null,
  service_id    uuid,
  title         text not null check (btrim(title) <> ''),
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  status        appointment_status not null default 'scheduled',
  notes         text,
  cancel_reason text,
  sale_id       uuid,
  created_by    uuid references auth.users (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id),
  check (ends_at > starts_at),
  check (ends_at - starts_at <= interval '24 hours'),
  check (customer_id is not null or btrim(coalesce(contact_name, '')) <> ''),
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id),
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id),
  foreign key (tenant_id, service_id) references public.products (tenant_id, id),
  foreign key (tenant_id, sale_id) references public.sales (tenant_id, id),
  -- Las canceladas y las que no asistieron liberan el horario.
  constraint appointments_no_overlap exclude using gist (
    staff_id extensions.gist_uuid_ops with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (staff_id is not null and status not in ('canceled', 'no_show'))
);
create index if not exists appointments_day_idx on public.appointments (tenant_id, starts_at);
create index if not exists appointments_customer_idx on public.appointments (tenant_id, customer_id);
create index if not exists appointments_staff_idx on public.appointments (staff_id);
create index if not exists appointments_created_by_idx on public.appointments (created_by);
-- Solo lectura por RLS: se escribe con las RPC appt_*.
select public._setup_tenant_table('appointments', null);

-- ── RPC ─────────────────────────────────────────────────────────────────────
-- Crea o edita. ends_at por defecto = inicio + duración del servicio (o 30 min).
create or replace function public.appt_save(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.auth_tenant_id();
  v_id      uuid := nullif(p_payload ->> 'id', '')::uuid;
  v_a       appointments;
  v_branch  uuid := (p_payload ->> 'branch_id')::uuid;
  v_staff   uuid := nullif(p_payload ->> 'staff_id', '')::uuid;
  v_service uuid := nullif(p_payload ->> 'service_id', '')::uuid;
  v_cust    uuid := nullif(p_payload ->> 'customer_id', '')::uuid;
  v_start   timestamptz := (p_payload ->> 'starts_at')::timestamptz;
  v_end     timestamptz := nullif(p_payload ->> 'ends_at', '')::timestamptz;
  v_title   text := nullif(btrim(coalesce(p_payload ->> 'title', '')), '');
  v_p       products;
begin
  perform public.require_perm('appointments.manage');
  perform public.require_module('appointments');
  perform public.assert_tenant_operational();
  if not public.can_access_branch(v_branch) then
    raise exception 'FORBIDDEN: No tienes acceso a esa sucursal.';
  end if;
  if v_start is null then
    raise exception 'Indica la fecha y hora de la cita';
  end if;
  if v_staff is not null and not exists (
      select 1 from tenant_members where tenant_id = v_tenant and user_id = v_staff and is_active) then
    raise exception 'El profesional no pertenece a esta empresa';
  end if;
  if v_service is not null then
    select * into v_p from products where id = v_service and tenant_id = v_tenant and is_active;
    if not found then
      raise exception 'Servicio no encontrado';
    end if;
  end if;
  v_end := coalesce(v_end, v_start + make_interval(mins => coalesce(v_p.duration_minutes, 30)));
  v_title := coalesce(v_title, v_p.name);
  if v_title is null then
    raise exception 'Indica el motivo o el servicio de la cita';
  end if;

  if v_id is not null then
    select * into v_a from appointments where id = v_id and tenant_id = v_tenant for update;
    if not found then
      raise exception 'Cita no encontrada';
    end if;
    if v_a.status in ('done', 'canceled', 'no_show') or v_a.sale_id is not null then
      raise exception 'La cita ya está cerrada';
    end if;
  end if;

  begin
    if v_id is null then
      insert into appointments (tenant_id, branch_id, customer_id, contact_name, contact_phone, staff_id,
                                service_id, title, starts_at, ends_at, notes)
      values (v_tenant, v_branch, v_cust, nullif(btrim(p_payload ->> 'contact_name'), ''),
              nullif(btrim(p_payload ->> 'contact_phone'), ''), v_staff, v_service, v_title, v_start, v_end,
              nullif(btrim(p_payload ->> 'notes'), ''))
      returning id into v_id;
      perform public.log_audit('appointment.created', 'appointment', v_id,
                               jsonb_build_object('starts_at', v_start, 'staff_id', v_staff));
    else
      update appointments set
        branch_id = v_branch, customer_id = v_cust,
        contact_name = nullif(btrim(p_payload ->> 'contact_name'), ''),
        contact_phone = nullif(btrim(p_payload ->> 'contact_phone'), ''),
        staff_id = v_staff, service_id = v_service, title = v_title,
        starts_at = v_start, ends_at = v_end, notes = nullif(btrim(p_payload ->> 'notes'), '')
      where id = v_id;
    end if;
  exception
    when exclusion_violation then
      raise exception 'APPOINTMENT_OVERLAP: Ese profesional ya tiene una cita en ese horario.';
    when check_violation then
      raise exception 'Revisa la cita: la hora de fin debe ser posterior al inicio (máx. 24 h) y debe tener cliente o nombre de contacto.';
  end;
  return v_id;
end;
$$;

create or replace function public.appt_set_status(p_id uuid, p_status appointment_status, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_a appointments;
begin
  perform public.require_perm('appointments.manage');
  perform public.assert_tenant_operational();
  select * into v_a from appointments where id = p_id and tenant_id = public.auth_tenant_id() for update;
  if not found then
    raise exception 'Cita no encontrada';
  end if;
  if v_a.status in ('done', 'canceled', 'no_show') then
    raise exception 'La cita ya está cerrada';
  end if;
  if p_status = 'scheduled' or (p_status = 'confirmed' and v_a.status = 'in_progress') then
    raise exception 'Una cita no vuelve a un estado anterior';
  end if;
  if p_status = 'canceled' and btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Indica el motivo de la cancelación';
  end if;
  if p_status = 'no_show' and v_a.status = 'in_progress' then
    raise exception 'La cita ya empezó';
  end if;
  update appointments set status = p_status,
         cancel_reason = case when p_status = 'canceled' then btrim(p_reason) end
  where id = p_id;
  perform public.log_audit('appointment.status', 'appointment', p_id,
                           jsonb_build_object('from', v_a.status, 'to', p_status, 'reason', p_reason));
end;
$$;

-- Cobro: el servicio de la cita (o las líneas que mande la pantalla) por
-- create_sale. Idempotente por client_uid como cualquier venta.
create or replace function public.appt_checkout(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_uid    uuid := (p_payload ->> 'client_uid')::uuid;
  v_a      appointments;
  v_items  jsonb := p_payload -> 'items';
  v_res    jsonb;
begin
  perform public.require_perm('sales.create');
  if exists (select 1 from sales where tenant_id = v_tenant and client_uid = v_uid) then
    return public.create_sale(jsonb_build_object('client_uid', v_uid));
  end if;
  select * into v_a from appointments
  where id = (p_payload ->> 'appointment_id')::uuid and tenant_id = v_tenant for update;
  if not found then
    raise exception 'Cita no encontrada';
  end if;
  if v_a.sale_id is not null then
    raise exception 'Esta cita ya se cobró';
  end if;
  if v_a.status in ('canceled', 'no_show') then
    raise exception 'La cita está cerrada sin atención';
  end if;
  if v_items is null or jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then
    if v_a.service_id is null then
      raise exception 'La cita no tiene servicio: indica qué se cobra';
    end if;
    v_items := jsonb_build_array(jsonb_build_object('product_id', v_a.service_id, 'quantity', 1));
  end if;

  v_res := public.create_sale(jsonb_build_object(
    'client_uid', v_uid, 'register_id', p_payload -> 'register_id',
    'customer_id', coalesce(p_payload -> 'customer_id', to_jsonb(v_a.customer_id)),
    'seller_id', to_jsonb(coalesce(v_a.staff_id, auth.uid())), 'ecf_type', p_payload -> 'ecf_type',
    'global_discount', p_payload -> 'global_discount',
    'notes', 'Cita: ' || v_a.title,
    'items', v_items, 'payments', coalesce(p_payload -> 'payments', '[]'::jsonb)));
  update appointments set sale_id = (v_res ->> 'sale_id')::uuid, status = 'done' where id = v_a.id;
  return v_res;
end;
$$;

-- ── Purga ───────────────────────────────────────────────────────────────────
create or replace function public.tenant_tables_purge_order()
returns text[]
language sql
immutable
as $$
  select array[
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

do $$
declare
  f   text;
  fns text[] := array[
    'public.appt_save(jsonb)',
    'public.appt_set_status(uuid, appointment_status, text)',
    'public.appt_checkout(jsonb)'
  ];
begin
  foreach f in array fns loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
