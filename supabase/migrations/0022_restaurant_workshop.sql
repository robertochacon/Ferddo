-- ═══ Ferddo · 0022 · Restaurante y taller (fase 8) ═══
--
-- Por qué así:
--   · NO hay un segundo sistema de facturación. Una cuenta de restaurante o
--     una orden de taller acumulan lo consumido; al cobrar se arma el payload
--     de create_sale() y la venta, el inventario, la caja, el crédito y el e-CF
--     salen del mismo motor de siempre.
--   · Restaurante: la cuenta (restaurant_orders) vive abierta en una mesa; los
--     ítems pasan pending → sent (comanda a cocina) → preparing → ready →
--     served. Dividir = cobrar solo algunas líneas (o parte de una); unir =
--     mover las líneas pendientes de cobro a otra cuenta. Se permiten varias
--     cuentas abiertas por mesa (cuentas separadas de una misma mesa).
--   · 10 % de ley: columna sales.service_charge, calculada en create_sale sobre
--     la base sin ITBIS. No es línea de producto: no lleva ITBIS ni inventario.
--   · Taller: orden de trabajo con vehículo/equipo, diagnóstico, servicios y
--     repuestos; puede generar una cotización (save_quotation), recibir
--     anticipos (a caja, kind 'advance') y facturarse aplicando esos anticipos
--     como forma de pago 'advance', que create_sale valida contra la orden.
--   · Los repuestos descuentan inventario AL FACTURAR (como cualquier venta),
--     no al anotarse en la orden: una orden cancelada no deja descuadres.

-- ── Permisos nuevos ─────────────────────────────────────────────────────────
insert into public.permissions (code, module, label, sort_order) values
  ('restaurant.manage', 'restaurant', 'Configurar áreas y mesas', 90),
  ('restaurant.orders', 'restaurant', 'Abrir cuentas y tomar pedidos', 91),
  ('restaurant.kitchen', 'restaurant', 'Pantalla de cocina (estados de preparación)', 92),
  ('restaurant.void', 'restaurant', 'Anular platos ya enviados a cocina', 93),
  ('workshop.manage', 'workshop', 'Crear y gestionar órdenes de trabajo', 95),
  ('workshop.assets', 'workshop', 'Registrar vehículos y equipos', 96)
on conflict (code) do update set module = excluded.module, label = excluded.label, sort_order = excluded.sort_order;

insert into public.default_role_permissions (role, permission)
select r::member_role, p from (values
  ('admin', array['restaurant.manage','restaurant.orders','restaurant.kitchen','restaurant.void','workshop.manage','workshop.assets']),
  ('supervisor', array['restaurant.orders','restaurant.kitchen','restaurant.void','workshop.manage','workshop.assets']),
  ('cashier', array['restaurant.orders']),
  ('seller', array['restaurant.orders']),
  ('kitchen', array['restaurant.kitchen']),
  ('service', array['workshop.manage','workshop.assets'])
) d(r, perms), unnest(d.perms) p
on conflict do nothing;

-- Las empresas que ya existen reciben los mismos permisos por defecto.
insert into public.role_permissions (tenant_id, role, permission)
select t.id, d.role, d.permission
from public.tenants t
cross join public.default_role_permissions d
where d.permission like 'restaurant.%' or d.permission like 'workshop.%'
on conflict do nothing;

-- ── Restaurante ─────────────────────────────────────────────────────────────
create table if not exists public.restaurant_areas (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  branch_id  uuid not null,
  name       text not null check (btrim(name) <> ''),
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id)
);
create index if not exists restaurant_areas_tenant_idx on public.restaurant_areas (tenant_id, branch_id);
select public._setup_tenant_table('restaurant_areas', 'restaurant.manage');

create table if not exists public.restaurant_tables (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  branch_id  uuid not null,
  area_id    uuid,
  name       text not null check (btrim(name) <> ''),
  seats      integer not null default 4 check (seats between 1 and 50),
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id),
  foreign key (tenant_id, area_id) references public.restaurant_areas (tenant_id, id)
);
create index if not exists restaurant_tables_tenant_idx on public.restaurant_tables (tenant_id, branch_id);
create index if not exists restaurant_tables_area_idx on public.restaurant_tables (area_id);
select public._setup_tenant_table('restaurant_tables', 'restaurant.manage');

create table if not exists public.restaurant_orders (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  branch_id   uuid not null,
  table_id    uuid,
  number      text not null,
  label       text,
  status      restaurant_order_status not null default 'open',
  guests      integer not null default 1 check (guests between 1 and 100),
  waiter_id   uuid references auth.users (id) on delete set null default auth.uid(),
  customer_id uuid,
  notes       text,
  opened_at   timestamptz not null default now(),
  closed_at   timestamptz,
  cancel_reason text,
  unique (tenant_id, id),
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id),
  foreign key (tenant_id, table_id) references public.restaurant_tables (tenant_id, id),
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id)
);
create index if not exists restaurant_orders_open_idx on public.restaurant_orders (tenant_id, status, branch_id);
create index if not exists restaurant_orders_table_idx on public.restaurant_orders (table_id) where status = 'open';
create index if not exists restaurant_orders_waiter_idx on public.restaurant_orders (waiter_id);
select public._setup_tenant_table('restaurant_orders', null);

create table if not exists public.kitchen_tickets (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  order_id   uuid not null,
  number     text not null,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, order_id) references public.restaurant_orders (tenant_id, id)
);
create index if not exists kitchen_tickets_order_idx on public.kitchen_tickets (order_id);
create index if not exists kitchen_tickets_tenant_idx on public.kitchen_tickets (tenant_id, created_at desc);
create index if not exists kitchen_tickets_created_by_idx on public.kitchen_tickets (created_by);
select public._setup_tenant_table('kitchen_tickets', null);

create table if not exists public.restaurant_order_items (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  order_id        uuid not null,
  product_id      uuid not null,
  quantity        numeric(14, 3) not null check (quantity > 0),
  notes           text,
  kitchen_status  kitchen_status not null default 'pending',
  ticket_id       uuid,
  billed_sale_id  uuid,
  cancel_reason   text,
  created_by      uuid references auth.users (id) on delete set null default auth.uid(),
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  ready_at        timestamptz,
  served_at       timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, order_id) references public.restaurant_orders (tenant_id, id),
  foreign key (tenant_id, product_id) references public.products (tenant_id, id),
  foreign key (tenant_id, ticket_id) references public.kitchen_tickets (tenant_id, id),
  foreign key (tenant_id, billed_sale_id) references public.sales (tenant_id, id)
);
create index if not exists restaurant_order_items_order_idx on public.restaurant_order_items (order_id);
create index if not exists restaurant_order_items_kitchen_idx on public.restaurant_order_items (tenant_id, kitchen_status)
  where kitchen_status in ('sent', 'preparing', 'ready');
create index if not exists restaurant_order_items_ticket_idx on public.restaurant_order_items (ticket_id);
create index if not exists restaurant_order_items_sale_idx on public.restaurant_order_items (billed_sale_id);
create index if not exists restaurant_order_items_product_idx on public.restaurant_order_items (tenant_id, product_id);
create index if not exists restaurant_order_items_created_by_idx on public.restaurant_order_items (created_by);
select public._setup_tenant_table('restaurant_order_items', null);

-- Cuenta abierta del tenant activo, bloqueada para modificarla.
create or replace function public._rest_order(p_order uuid)
returns restaurant_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_o restaurant_orders;
begin
  select * into v_o from restaurant_orders where id = p_order and tenant_id = public.auth_tenant_id() for update;
  if not found then
    raise exception 'Cuenta no encontrada';
  end if;
  if v_o.status <> 'open' then
    raise exception 'Esta cuenta ya está cerrada';
  end if;
  if not public.can_access_branch(v_o.branch_id) then
    raise exception 'FORBIDDEN: No tienes acceso a esa sucursal.';
  end if;
  return v_o;
end;
$$;
revoke all on function public._rest_order(uuid) from public, anon, authenticated;

create or replace function public.rest_open_order(
  p_branch uuid, p_table uuid default null, p_guests integer default 1, p_label text default null, p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_num    record;
  v_id     uuid;
begin
  perform public.require_perm('restaurant.orders');
  perform public.require_module('restaurant');
  perform public.assert_tenant_operational();
  if not public.can_access_branch(p_branch) then
    raise exception 'FORBIDDEN: No tienes acceso a esa sucursal.';
  end if;
  if p_table is not null and not exists (
      select 1 from restaurant_tables where id = p_table and tenant_id = v_tenant and branch_id = p_branch and is_active) then
    raise exception 'Mesa no encontrada en esa sucursal';
  end if;
  select * into v_num from public.next_doc_number(v_tenant, 'restaurant_order');
  insert into restaurant_orders (tenant_id, branch_id, table_id, number, label, guests, notes)
  values (v_tenant, p_branch, p_table, 'M-' || v_num.label, nullif(btrim(p_label), ''),
          greatest(coalesce(p_guests, 1), 1), nullif(btrim(p_notes), ''))
  returning id into v_id;
  return v_id;
end;
$$;

-- p_items: [{product_id, quantity, notes?}] — quedan `pending` (sin enviar).
create or replace function public.rest_add_items(p_order uuid, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_o    restaurant_orders;
  v_item jsonb;
  v_qty  numeric;
begin
  perform public.require_perm('restaurant.orders');
  v_o := public._rest_order(p_order);
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := round((v_item ->> 'quantity')::numeric, 3);
    if v_qty is null or v_qty <= 0 then
      raise exception 'Cantidad inválida';
    end if;
    if not exists (select 1 from products where id = (v_item ->> 'product_id')::uuid
                   and tenant_id = v_o.tenant_id and is_active) then
      raise exception 'Producto no encontrado o inactivo';
    end if;
    insert into restaurant_order_items (tenant_id, order_id, product_id, quantity, notes)
    values (v_o.tenant_id, v_o.id, (v_item ->> 'product_id')::uuid, v_qty, nullif(btrim(v_item ->> 'notes'), ''));
  end loop;
end;
$$;

-- Cambia cantidad/nota de una línea aún no enviada a cocina.
create or replace function public.rest_update_item(p_item uuid, p_quantity numeric, p_notes text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_it restaurant_order_items;
begin
  perform public.require_perm('restaurant.orders');
  select * into v_it from restaurant_order_items where id = p_item and tenant_id = public.auth_tenant_id() for update;
  if not found then
    raise exception 'Línea no encontrada';
  end if;
  perform public._rest_order(v_it.order_id);
  if v_it.kitchen_status <> 'pending' then
    raise exception 'Esta línea ya se envió a cocina: anúlala y agrega una nueva';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Cantidad inválida';
  end if;
  update restaurant_order_items set quantity = round(p_quantity, 3), notes = nullif(btrim(p_notes), '') where id = p_item;
end;
$$;

-- Quitar una línea. Si ya salió a cocina hace falta restaurant.void y motivo
-- (es comida que quizá ya se preparó: queda en la bitácora).
create or replace function public.rest_cancel_item(p_item uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_it restaurant_order_items;
begin
  perform public.require_perm('restaurant.orders');
  select * into v_it from restaurant_order_items where id = p_item and tenant_id = public.auth_tenant_id() for update;
  if not found then
    raise exception 'Línea no encontrada';
  end if;
  perform public._rest_order(v_it.order_id);
  if v_it.billed_sale_id is not null then
    raise exception 'Esta línea ya se cobró';
  end if;
  if v_it.kitchen_status = 'pending' then
    delete from restaurant_order_items where id = p_item;
    return;
  end if;
  perform public.require_perm('restaurant.void');
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Indica el motivo de la anulación';
  end if;
  update restaurant_order_items set kitchen_status = 'canceled', cancel_reason = btrim(p_reason) where id = p_item;
  perform public.log_audit('restaurant.item_voided', 'restaurant_order_item', p_item,
                           jsonb_build_object('reason', p_reason, 'quantity', v_it.quantity));
end;
$$;

-- Comanda: todo lo pendiente de la cuenta sale a cocina en un ticket.
create or replace function public.rest_send_to_kitchen(p_order uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_o   restaurant_orders;
  v_num record;
  v_tk  uuid;
  v_n   int;
begin
  perform public.require_perm('restaurant.orders');
  v_o := public._rest_order(p_order);
  if not exists (select 1 from restaurant_order_items where order_id = p_order and kitchen_status = 'pending') then
    raise exception 'No hay nada nuevo que enviar a cocina';
  end if;
  select * into v_num from public.next_doc_number(v_o.tenant_id, 'kitchen_ticket');
  insert into kitchen_tickets (tenant_id, order_id, number) values (v_o.tenant_id, p_order, 'C-' || v_num.label)
  returning id into v_tk;
  update restaurant_order_items set kitchen_status = 'sent', ticket_id = v_tk, sent_at = now()
  where order_id = p_order and kitchen_status = 'pending';
  get diagnostics v_n = row_count;
  return jsonb_build_object('ticket_id', v_tk, 'number', 'C-' || v_num.label, 'items', v_n);
end;
$$;

-- Cocina: avanza (o corrige) el estado de un plato. Solo hacia adelante,
-- salvo volver de 'ready' a 'preparing' (se marcó listo por error).
create or replace function public.rest_set_kitchen_status(p_item uuid, p_status kitchen_status)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_it restaurant_order_items;
  v_ok boolean;
begin
  if p_status = 'served' then
    if not (public.has_perm('restaurant.orders') or public.has_perm('restaurant.kitchen')) then
      raise exception 'FORBIDDEN: No tienes permiso para marcar platos servidos.';
    end if;
  else
    perform public.require_perm('restaurant.kitchen');
  end if;
  select * into v_it from restaurant_order_items where id = p_item and tenant_id = public.auth_tenant_id() for update;
  if not found then
    raise exception 'Línea no encontrada';
  end if;
  v_ok := (v_it.kitchen_status, p_status) in (
    ('sent', 'preparing'), ('sent', 'ready'), ('preparing', 'ready'), ('ready', 'preparing'),
    ('ready', 'served'), ('sent', 'served'), ('preparing', 'served'));
  if not v_ok then
    raise exception 'Cambio de estado no permitido';
  end if;
  update restaurant_order_items set
    kitchen_status = p_status,
    ready_at = case when p_status = 'ready' then now() else ready_at end,
    served_at = case when p_status = 'served' then now() else served_at end
  where id = p_item;
end;
$$;

create or replace function public.rest_move_order(p_order uuid, p_table uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_o restaurant_orders;
begin
  perform public.require_perm('restaurant.orders');
  v_o := public._rest_order(p_order);
  if p_table is not null and not exists (
      select 1 from restaurant_tables where id = p_table and tenant_id = v_o.tenant_id and branch_id = v_o.branch_id and is_active) then
    raise exception 'Mesa no encontrada en esa sucursal';
  end if;
  update restaurant_orders set table_id = p_table where id = p_order;
end;
$$;

-- Unir cuentas: lo NO cobrado de p_from pasa a p_into y p_from se cierra.
create or replace function public.rest_merge_orders(p_from uuid, p_into uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_a restaurant_orders;
  v_b restaurant_orders;
begin
  perform public.require_perm('restaurant.orders');
  if p_from = p_into then
    raise exception 'Elige dos cuentas distintas';
  end if;
  -- Orden fijo de bloqueo para que dos uniones cruzadas no se interbloqueen.
  if p_from < p_into then
    v_a := public._rest_order(p_from); v_b := public._rest_order(p_into);
  else
    v_b := public._rest_order(p_into); v_a := public._rest_order(p_from);
  end if;
  if v_a.branch_id <> v_b.branch_id then
    raise exception 'Solo se unen cuentas de la misma sucursal';
  end if;
  update restaurant_order_items set order_id = p_into
  where order_id = p_from and billed_sale_id is null and kitchen_status <> 'canceled';
  update restaurant_orders set guests = v_b.guests + v_a.guests where id = p_into;
  update restaurant_orders set status = 'closed', closed_at = now(),
         cancel_reason = 'Unida a la cuenta ' || v_b.number
  where id = p_from;
  perform public.log_audit('restaurant.orders_merged', 'restaurant_order', p_into, jsonb_build_object('from', v_a.number));
end;
$$;

create or replace function public.rest_cancel_order(p_order uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_o restaurant_orders;
begin
  perform public.require_perm('restaurant.orders');
  v_o := public._rest_order(p_order);
  if exists (select 1 from restaurant_order_items where order_id = p_order and billed_sale_id is not null) then
    raise exception 'La cuenta ya tiene cobros: cóbrala completa o anula los platos pendientes';
  end if;
  if exists (select 1 from restaurant_order_items where order_id = p_order and kitchen_status not in ('pending', 'canceled')) then
    perform public.require_perm('restaurant.void');
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Indica el motivo';
  end if;
  update restaurant_order_items set kitchen_status = 'canceled', cancel_reason = btrim(p_reason)
  where order_id = p_order and kitchen_status <> 'canceled';
  update restaurant_orders set status = 'canceled', closed_at = now(), cancel_reason = btrim(p_reason) where id = p_order;
  perform public.log_audit('restaurant.order_canceled', 'restaurant_order', p_order, jsonb_build_object('reason', p_reason));
end;
$$;

-- Cobro (total o dividido). p_payload:
-- { order_id, client_uid, register_id, customer_id?, ecf_type?, global_discount?,
--   service_charge?: bool (10 % de ley), payments: [...],
--   lines?: [{order_item_id, quantity}]   ← sin `lines` = todo lo pendiente de cobro }
create or replace function public.rest_checkout(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.auth_tenant_id();
  v_uid     uuid := (p_payload ->> 'client_uid')::uuid;
  v_o       restaurant_orders;
  v_existing uuid;
  v_sel     jsonb := '[]'::jsonb;
  v_line    jsonb;
  v_it      restaurant_order_items;
  v_qty     numeric;
  v_items   jsonb := '[]'::jsonb;
  v_ids     uuid[] := '{}';
  v_res     jsonb;
  v_sale    uuid;
  v_new     uuid;
begin
  perform public.require_perm('sales.create');
  -- Reintento: la venta ya entró; devolverla sin tocar más líneas.
  select id into v_existing from sales where tenant_id = v_tenant and client_uid = v_uid;
  if v_existing is not null then
    return public.create_sale(jsonb_build_object('client_uid', v_uid));
  end if;
  v_o := public._rest_order((p_payload ->> 'order_id')::uuid);

  if p_payload ? 'lines' and jsonb_typeof(p_payload -> 'lines') = 'array' then
    v_sel := p_payload -> 'lines';
  else
    select coalesce(jsonb_agg(jsonb_build_object('order_item_id', id, 'quantity', quantity)), '[]'::jsonb) into v_sel
    from restaurant_order_items
    where order_id = v_o.id and billed_sale_id is null and kitchen_status <> 'canceled';
  end if;
  if jsonb_array_length(v_sel) = 0 then
    raise exception 'No hay nada pendiente de cobro en esta cuenta';
  end if;

  for v_line in select * from jsonb_array_elements(v_sel) loop
    select * into v_it from restaurant_order_items
    where id = (v_line ->> 'order_item_id')::uuid and order_id = v_o.id for update;
    if not found or v_it.billed_sale_id is not null or v_it.kitchen_status = 'canceled' then
      raise exception 'Una de las líneas ya se cobró o fue anulada';
    end if;
    v_qty := round(coalesce((v_line ->> 'quantity')::numeric, v_it.quantity), 3);
    if v_qty <= 0 or v_qty > v_it.quantity then
      raise exception 'Cantidad a cobrar inválida';
    end if;
    -- Dividir una línea: lo que no se cobra ahora queda en una línea nueva
    -- idéntica, y la original (la que se cobra) se reduce a lo cobrado.
    if v_qty < v_it.quantity then
      insert into restaurant_order_items (tenant_id, order_id, product_id, quantity, notes, kitchen_status,
                                          ticket_id, created_by, created_at, sent_at, ready_at, served_at)
      values (v_it.tenant_id, v_it.order_id, v_it.product_id, v_it.quantity - v_qty, v_it.notes, v_it.kitchen_status,
              v_it.ticket_id, v_it.created_by, v_it.created_at, v_it.sent_at, v_it.ready_at, v_it.served_at)
      returning id into v_new;
      update restaurant_order_items set quantity = v_qty where id = v_it.id;
    end if;
    v_ids := v_ids || v_it.id;
    v_items := v_items || jsonb_build_object('product_id', v_it.product_id, 'quantity', v_qty,
                                             'description', null);
  end loop;

  v_res := public.create_sale(jsonb_build_object(
    'client_uid', v_uid, 'register_id', p_payload -> 'register_id',
    'customer_id', coalesce(p_payload -> 'customer_id', to_jsonb(v_o.customer_id)),
    'seller_id', to_jsonb(v_o.waiter_id), 'ecf_type', p_payload -> 'ecf_type',
    'global_discount', p_payload -> 'global_discount',
    'service_charge_rate', case when coalesce((p_payload ->> 'service_charge')::boolean, false) then 0.10 else 0 end,
    'notes', 'Cuenta ' || v_o.number || coalesce(' · ' || (select name from restaurant_tables where id = v_o.table_id), ''),
    'items', v_items, 'payments', p_payload -> 'payments'));
  v_sale := (v_res ->> 'sale_id')::uuid;

  update restaurant_order_items set billed_sale_id = v_sale where id = any (v_ids);
  if not exists (select 1 from restaurant_order_items where order_id = v_o.id
                 and billed_sale_id is null and kitchen_status <> 'canceled') then
    update restaurant_orders set status = 'closed', closed_at = now() where id = v_o.id;
  end if;
  return v_res || jsonb_build_object('order_closed',
    (select status = 'closed' from restaurant_orders where id = v_o.id));
end;
$$;

-- ── Taller ──────────────────────────────────────────────────────────────────
create table if not exists public.assets (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  customer_id uuid not null,
  kind        text not null default 'vehicle' check (kind in ('vehicle', 'equipment')),
  brand       text,
  model       text,
  year        integer check (year is null or year between 1900 and 2100),
  plate       text,
  serial      text,
  color       text,
  notes       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id)
);
create index if not exists assets_customer_idx on public.assets (tenant_id, customer_id);
create unique index if not exists assets_plate_idx on public.assets (tenant_id, upper(plate)) where plate is not null;
select public._setup_tenant_table('assets', 'workshop.assets');

create table if not exists public.work_orders (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  branch_id     uuid not null,
  seq           bigint not null,
  number        text not null,
  customer_id   uuid not null,
  asset_id      uuid,
  status        work_order_status not null default 'received',
  problem       text not null check (btrim(problem) <> ''),
  diagnosis     text,
  notes         text,
  mileage_in    integer check (mileage_in is null or mileage_in >= 0),
  technician_id uuid references auth.users (id) on delete set null,
  promised_at   timestamptz,
  quotation_id  uuid,
  sale_id       uuid,
  received_at   timestamptz not null default now(),
  done_at       timestamptz,
  delivered_at  timestamptz,
  cancel_reason text,
  created_by    uuid references auth.users (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, seq),
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id),
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id),
  foreign key (tenant_id, asset_id) references public.assets (tenant_id, id),
  foreign key (tenant_id, quotation_id) references public.quotations (tenant_id, id),
  foreign key (tenant_id, sale_id) references public.sales (tenant_id, id)
);
create index if not exists work_orders_tenant_idx on public.work_orders (tenant_id, status, received_at desc);
create index if not exists work_orders_customer_idx on public.work_orders (tenant_id, customer_id);
create index if not exists work_orders_asset_idx on public.work_orders (asset_id);
create index if not exists work_orders_tech_idx on public.work_orders (technician_id);
create index if not exists work_orders_created_by_idx on public.work_orders (created_by);
create index if not exists work_orders_quotation_idx on public.work_orders (quotation_id);
create index if not exists work_orders_sale_idx on public.work_orders (sale_id);
select public._setup_tenant_table('work_orders', null);

create table if not exists public.work_order_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  order_id    uuid not null,
  line_no     integer not null,
  product_id  uuid not null,
  quantity    numeric(14, 3) not null check (quantity > 0),
  notes       text,
  foreign key (tenant_id, order_id) references public.work_orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references public.products (tenant_id, id)
);
create index if not exists work_order_items_order_idx on public.work_order_items (order_id);
create index if not exists work_order_items_product_idx on public.work_order_items (tenant_id, product_id);
select public._setup_tenant_table('work_order_items', null);

create table if not exists public.work_order_advances (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  order_id        uuid not null,
  client_uid      uuid not null,
  number          text not null,
  amount          numeric(14, 2) not null check (amount > 0),
  method          payment_method not null check (method in ('cash', 'card', 'transfer', 'other')),
  session_id      uuid,
  reference       text,
  applied_sale_id uuid,
  created_by      uuid references auth.users (id) on delete set null default auth.uid(),
  created_at      timestamptz not null default now(),
  unique (tenant_id, client_uid),
  foreign key (tenant_id, order_id) references public.work_orders (tenant_id, id),
  foreign key (tenant_id, session_id) references public.cash_sessions (tenant_id, id),
  foreign key (tenant_id, applied_sale_id) references public.sales (tenant_id, id)
);
create index if not exists work_order_advances_order_idx on public.work_order_advances (order_id);
create index if not exists work_order_advances_sale_idx on public.work_order_advances (applied_sale_id);
create index if not exists work_order_advances_created_by_idx on public.work_order_advances (created_by);
select public._setup_tenant_table('work_order_advances', null);

-- Crear o editar una orden. p_payload:
-- { id?, branch_id, customer_id, asset_id?, problem, diagnosis?, notes?, mileage_in?,
--   technician_id?, promised_at?, items?: [{product_id, quantity, notes?}] }
create or replace function public.wo_save(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_id     uuid := (p_payload ->> 'id')::uuid;
  v_cur    work_orders;
  v_num    record;
  v_item   jsonb;
  v_i      int := 0;
begin
  perform public.require_perm('workshop.manage');
  perform public.require_module('workshop');
  perform public.assert_tenant_operational();
  if not public.can_access_branch((p_payload ->> 'branch_id')::uuid) then
    raise exception 'FORBIDDEN: No tienes acceso a esa sucursal.';
  end if;
  if (p_payload ->> 'asset_id') is not null and not exists (
      select 1 from assets where id = (p_payload ->> 'asset_id')::uuid and tenant_id = v_tenant
      and customer_id = (p_payload ->> 'customer_id')::uuid) then
    raise exception 'El vehículo o equipo no pertenece a ese cliente';
  end if;
  if (p_payload ->> 'technician_id') is not null and not exists (
      select 1 from tenant_members where tenant_id = v_tenant and user_id = (p_payload ->> 'technician_id')::uuid and is_active) then
    raise exception 'El técnico no pertenece a la empresa';
  end if;

  if v_id is null then
    select * into v_num from public.next_doc_number(v_tenant, 'work_order');
    insert into work_orders (tenant_id, branch_id, seq, number, customer_id, problem)
    values (v_tenant, (p_payload ->> 'branch_id')::uuid, v_num.seq, 'OT-' || v_num.label,
            (p_payload ->> 'customer_id')::uuid, coalesce(nullif(btrim(p_payload ->> 'problem'), ''), '—'))
    returning id into v_id;
  else
    select * into v_cur from work_orders where id = v_id and tenant_id = v_tenant for update;
    if not found then
      raise exception 'Orden no encontrada';
    end if;
    if v_cur.status in ('delivered', 'canceled') or v_cur.sale_id is not null then
      raise exception 'Una orden facturada, entregada o cancelada ya no se edita';
    end if;
  end if;

  update work_orders set
    branch_id     = (p_payload ->> 'branch_id')::uuid,
    customer_id   = (p_payload ->> 'customer_id')::uuid,
    asset_id      = (p_payload ->> 'asset_id')::uuid,
    problem       = coalesce(nullif(btrim(p_payload ->> 'problem'), ''), problem),
    diagnosis     = nullif(btrim(p_payload ->> 'diagnosis'), ''),
    notes         = nullif(btrim(p_payload ->> 'notes'), ''),
    mileage_in    = (p_payload ->> 'mileage_in')::integer,
    technician_id = (p_payload ->> 'technician_id')::uuid,
    promised_at   = (p_payload ->> 'promised_at')::timestamptz
  where id = v_id;

  if p_payload ? 'items' then
    delete from work_order_items where order_id = v_id;
    for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'items', '[]'::jsonb)) loop
      v_i := v_i + 1;
      if not exists (select 1 from products where id = (v_item ->> 'product_id')::uuid and tenant_id = v_tenant and is_active) then
        raise exception 'Producto o servicio no encontrado';
      end if;
      if coalesce((v_item ->> 'quantity')::numeric, 0) <= 0 then
        raise exception 'Cantidad inválida';
      end if;
      insert into work_order_items (tenant_id, order_id, line_no, product_id, quantity, notes)
      values (v_tenant, v_id, v_i, (v_item ->> 'product_id')::uuid, round((v_item ->> 'quantity')::numeric, 3),
              nullif(btrim(v_item ->> 'notes'), ''));
    end loop;
  end if;
  perform public.log_audit('work_order.saved', 'work_order', v_id);
  return v_id;
end;
$$;

-- Flujo: recibida → en revisión → cotizada → aprobada → en proceso →
-- terminada → entregada. Se permite saltar pasos hacia adelante (un cambio de
-- aceite no se cotiza) pero no volver atrás salvo cotizada/aprobada → en revisión.
create or replace function public.wo_set_status(p_id uuid, p_status work_order_status, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_o     work_orders;
  v_rank  constant text[] := array['received', 'diagnosing', 'quoted', 'approved', 'in_progress', 'done', 'delivered'];
  v_from  int;
  v_to    int;
begin
  perform public.require_perm('workshop.manage');
  select * into v_o from work_orders where id = p_id and tenant_id = public.auth_tenant_id() for update;
  if not found then
    raise exception 'Orden no encontrada';
  end if;
  if v_o.status in ('delivered', 'canceled') then
    raise exception 'La orden ya está cerrada';
  end if;
  if p_status = 'canceled' then
    if v_o.sale_id is not null then
      raise exception 'La orden ya se facturó: registra una devolución en su lugar';
    end if;
    if exists (select 1 from work_order_advances where order_id = p_id and applied_sale_id is null) then
      raise exception 'La orden tiene anticipos sin aplicar: devuélvelos o factúrala antes de cancelar';
    end if;
    if nullif(btrim(p_reason), '') is null then
      raise exception 'Indica el motivo de la cancelación';
    end if;
    update work_orders set status = 'canceled', cancel_reason = btrim(p_reason) where id = p_id;
  else
    v_from := array_position(v_rank, v_o.status::text);
    v_to := array_position(v_rank, p_status::text);
    if v_to < v_from and not (p_status = 'diagnosing' and v_o.status in ('quoted', 'approved')) then
      raise exception 'Cambio de estado no permitido';
    end if;
    update work_orders set
      status = p_status,
      done_at = case when p_status = 'done' then now() else done_at end,
      delivered_at = case when p_status = 'delivered' then now() else delivered_at end
    where id = p_id;
  end if;
  perform public.log_audit('work_order.status', 'work_order', p_id,
                           jsonb_build_object('from', v_o.status, 'to', p_status, 'reason', p_reason));
end;
$$;

-- Cotización a partir de la orden (mismo motor de precios que la venta).
create or replace function public.wo_create_quotation(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_o  work_orders;
  v_q  uuid;
begin
  perform public.require_perm('workshop.manage');
  select * into v_o from work_orders where id = p_id and tenant_id = public.auth_tenant_id() for update;
  if not found then
    raise exception 'Orden no encontrada';
  end if;
  if not exists (select 1 from work_order_items where order_id = p_id) then
    raise exception 'Agrega servicios o repuestos a la orden antes de cotizar';
  end if;
  v_q := public.save_quotation(jsonb_build_object(
    'id', v_o.quotation_id, 'branch_id', v_o.branch_id, 'customer_id', v_o.customer_id,
    'notes', 'Orden de trabajo ' || v_o.number || coalesce(E'\n' || v_o.diagnosis, ''),
    'items', (select jsonb_agg(jsonb_build_object('product_id', product_id, 'quantity', quantity) order by line_no)
              from work_order_items where order_id = p_id)));
  update work_orders set quotation_id = v_q,
         status = case when status in ('received', 'diagnosing') then 'quoted' else status end
  where id = p_id;
  return v_q;
end;
$$;

-- Anticipo: entra a caja ya (kind 'advance') y se aplica al facturar.
-- p_payload: { client_uid, order_id, amount, method, register_id?, reference? }
create or replace function public.wo_add_advance(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.auth_tenant_id();
  v_uid     uuid := (p_payload ->> 'client_uid')::uuid;
  v_o       work_orders;
  v_id      uuid;
  v_num     record;
  v_session cash_sessions;
  v_amount  numeric := round((p_payload ->> 'amount')::numeric, 2);
  v_method  payment_method := coalesce(p_payload ->> 'method', 'cash')::payment_method;
begin
  perform public.require_perm('sales.create');
  perform public.require_perm('workshop.manage');
  if v_uid is null then
    raise exception 'Falta el identificador de la operación (client_uid)';
  end if;
  select id into v_id from work_order_advances where tenant_id = v_tenant and client_uid = v_uid;
  if v_id is not null then
    return v_id;
  end if;
  perform public.assert_tenant_operational();
  select * into v_o from work_orders where id = (p_payload ->> 'order_id')::uuid and tenant_id = v_tenant for update;
  if not found then
    raise exception 'Orden no encontrada';
  end if;
  if v_o.status in ('delivered', 'canceled') or v_o.sale_id is not null then
    raise exception 'La orden ya está facturada o cerrada';
  end if;
  if v_amount is null or v_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;
  if v_method not in ('cash', 'card', 'transfer', 'other') then
    raise exception 'Método de pago inválido';
  end if;
  -- Todo anticipo pasa por una caja abierta: es dinero que entra hoy.
  v_session := public.open_session_for((p_payload ->> 'register_id')::uuid);
  select * into v_num from public.next_doc_number(v_tenant, 'work_order_advance');
  insert into work_order_advances (tenant_id, order_id, client_uid, number, amount, method, session_id, reference)
  values (v_tenant, v_o.id, v_uid, 'AN-' || v_num.label, v_amount, v_method, v_session.id, nullif(p_payload ->> 'reference', ''))
  returning id into v_id;
  insert into cash_movements (tenant_id, session_id, kind, method, amount, reference_type, reference_id, note)
  values (v_tenant, v_session.id, 'advance', v_method, v_amount, 'work_order_advance', v_id, 'Anticipo ' || v_o.number);
  perform public.log_audit('work_order.advance', 'work_order', v_o.id, jsonb_build_object('amount', v_amount));
  return v_id;
end;
$$;

-- Facturar la orden: arma la venta con sus líneas y aplica los anticipos.
-- p_payload: { order_id, client_uid, register_id, ecf_type?, global_discount?, payments: [...] }
create or replace function public.wo_checkout(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_uid    uuid := (p_payload ->> 'client_uid')::uuid;
  v_o      work_orders;
  v_adv    numeric;
  v_pays   jsonb := coalesce(p_payload -> 'payments', '[]'::jsonb);
  v_res    jsonb;
begin
  perform public.require_perm('sales.create');
  if exists (select 1 from sales where tenant_id = v_tenant and client_uid = v_uid) then
    return public.create_sale(jsonb_build_object('client_uid', v_uid));
  end if;
  select * into v_o from work_orders where id = (p_payload ->> 'order_id')::uuid and tenant_id = v_tenant for update;
  if not found then
    raise exception 'Orden no encontrada';
  end if;
  if v_o.sale_id is not null then
    raise exception 'Esta orden ya se facturó';
  end if;
  if v_o.status = 'canceled' then
    raise exception 'La orden está cancelada';
  end if;
  if not exists (select 1 from work_order_items where order_id = v_o.id) then
    raise exception 'La orden no tiene servicios ni repuestos';
  end if;
  select coalesce(sum(amount), 0) into v_adv from work_order_advances
  where order_id = v_o.id and applied_sale_id is null;
  if v_adv > 0 then
    v_pays := v_pays || jsonb_build_array(jsonb_build_object('method', 'advance', 'amount', v_adv));
  end if;

  v_res := public.create_sale(jsonb_build_object(
    'client_uid', v_uid, 'register_id', p_payload -> 'register_id', 'customer_id', v_o.customer_id,
    'seller_id', to_jsonb(coalesce(v_o.technician_id, auth.uid())), 'ecf_type', p_payload -> 'ecf_type',
    'global_discount', p_payload -> 'global_discount', 'work_order_id', v_o.id,
    'quotation_id', case when exists (select 1 from quotations where id = v_o.quotation_id
                                      and status in ('draft', 'sent', 'accepted')) then to_jsonb(v_o.quotation_id) end,
    'notes', 'Orden de trabajo ' || v_o.number,
    'items', (select jsonb_agg(jsonb_build_object('product_id', product_id, 'quantity', quantity) order by line_no)
              from work_order_items where order_id = v_o.id),
    'payments', v_pays));
  update work_orders set sale_id = (v_res ->> 'sale_id')::uuid,
         status = case when status in ('delivered') then status else 'done' end,
         done_at = coalesce(done_at, now())
  where id = v_o.id;
  return v_res || jsonb_build_object('advance_applied', v_adv);
end;
$$;

-- ── Venta: cargo por servicio y anticipos ───────────────────────────────────
alter table public.sales add column if not exists service_charge numeric(14, 2) not null default 0
  check (service_charge >= 0);

-- ── Purga: tablas nuevas primero (dependen de ventas, clientes, productos) ──
create or replace function public.tenant_tables_purge_order()
returns text[]
language sql
immutable
as $$
  select array[
    'restaurant_order_items', 'kitchen_tickets', 'restaurant_orders', 'restaurant_tables', 'restaurant_areas',
    'work_order_advances', 'work_order_items', 'work_orders', 'assets',
    'electronic_invoice_events', 'electronic_invoices', 'fiscal_sequences', 'fiscal_secrets', 'fiscal_settings',
    'receivable_payments', 'payable_payments', 'expenses', 'customer_payments', 'supplier_payments',
    'receivables', 'payables', 'sale_return_items', 'sale_returns', 'sale_payments', 'sale_items', 'sales',
    'quotation_items', 'quotations', 'cash_movements', 'cash_sessions', 'cash_registers',
    'inventory_movements', 'inventory_documents', 'stock_levels', 'purchase_items', 'purchases',
    'products', 'categories', 'taxes', 'customers', 'suppliers', 'expense_categories',
    'document_sequences', 'role_permissions', 'tenant_members', 'branches', 'subscription_events',
    'notifications', 'audit_logs', 'tenant_invites', 'plan_requests', 'subscriptions'
  ]
$$;
revoke all on function public.tenant_tables_purge_order() from public, anon, authenticated;

do $$
declare
  f   text;
  fns text[] := array[
    'public.rest_open_order(uuid, uuid, integer, text, text)',
    'public.rest_add_items(uuid, jsonb)',
    'public.rest_update_item(uuid, numeric, text)',
    'public.rest_cancel_item(uuid, text)',
    'public.rest_send_to_kitchen(uuid)',
    'public.rest_set_kitchen_status(uuid, kitchen_status)',
    'public.rest_move_order(uuid, uuid)',
    'public.rest_merge_orders(uuid, uuid)',
    'public.rest_cancel_order(uuid, text)',
    'public.rest_checkout(jsonb)',
    'public.wo_save(jsonb)',
    'public.wo_set_status(uuid, work_order_status, text)',
    'public.wo_create_quotation(uuid)',
    'public.wo_add_advance(jsonb)',
    'public.wo_checkout(jsonb)'
  ];
begin
  foreach f in array fns loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- create_sale con anticipos ('advance', validados contra work_order_advances)
-- y cargo por servicio (10 % de ley). Mismo cuerpo que la 0015 salvo esos parches.
create or replace function public.create_sale(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant    uuid := public.auth_tenant_id();
  v_uid       uuid := (p_payload ->> 'client_uid')::uuid;
  v_existing  sales;
  v_reg       cash_registers;
  v_session   cash_sessions;
  v_customer  customers;
  v_calc      jsonb;
  v_total     numeric;
  v_pay       jsonb;
  v_method    payment_method;
  v_amt       numeric;
  v_cash_in   numeric := 0;
  v_noncash   numeric := 0;
  v_credit    numeric := 0;
  v_paid      numeric;
  v_change    numeric;
  v_balance   numeric;
  v_num       record;
  v_sale_id   uuid;
  v_line      jsonb;
  v_item_id   uuid;
  v_seller    uuid := coalesce((p_payload ->> 'seller_id')::uuid, auth.uid());
  v_quote     uuid := (p_payload ->> 'quotation_id')::uuid;
  v_ecf       text := nullif(btrim(p_payload ->> 'ecf_type'), '');
  v_ecf_res   jsonb;
  v_wo        uuid := (p_payload ->> 'work_order_id')::uuid;
  v_advance   numeric := 0;
  v_adv_avail numeric := 0;
  v_svc_rate  numeric := coalesce((p_payload ->> 'service_charge_rate')::numeric, 0);
  v_svc       numeric := 0;
begin
  perform public.require_perm('sales.create');
  perform public.require_module('pos');
  if v_uid is null then
    raise exception 'Falta el identificador de la operación (client_uid)';
  end if;

  -- Reintento de una venta que ya entró: misma respuesta, sin duplicar.
  select * into v_existing from sales where tenant_id = v_tenant and client_uid = v_uid;
  if found then
    return jsonb_build_object('sale_id', v_existing.id, 'number', v_existing.number,
                              'total', v_existing.total, 'change_due', v_existing.change_due, 'replayed', true);
  end if;

  perform public.assert_tenant_operational();

  select * into v_reg from cash_registers
  where id = (p_payload ->> 'register_id')::uuid and tenant_id = v_tenant and is_active;
  if not found then
    raise exception 'Selecciona una caja válida';
  end if;
  if not public.can_access_branch(v_reg.branch_id) then
    raise exception 'FORBIDDEN: No tienes acceso a esa sucursal.';
  end if;
  v_session := public.open_session_for(v_reg.id);

  if (p_payload ->> 'customer_id') is not null then
    -- for update: dos ventas a crédito simultáneas del mismo cliente se
    -- serializan y el límite de crédito no se puede rebasar por carrera.
    select * into v_customer from customers
    where id = (p_payload ->> 'customer_id')::uuid and tenant_id = v_tenant
    for update;
    if not found or not v_customer.is_active then
      raise exception 'Cliente no encontrado o inactivo';
    end if;
  end if;

  if v_seller <> auth.uid() and not exists (
    select 1 from tenant_members where tenant_id = v_tenant and user_id = v_seller and is_active) then
    raise exception 'El vendedor no pertenece a la empresa';
  end if;

  v_calc := public.price_lines(v_tenant, p_payload -> 'items', coalesce((p_payload ->> 'global_discount')::numeric, 0), true);
  v_total := (v_calc ->> 'total')::numeric;

  -- 10 % de ley (restaurantes): cargo por servicio sobre la base SIN ITBIS de
  -- lo consumido. Va en su propia columna y no como línea: no lleva ITBIS ni
  -- mueve inventario, y así el reporte puede separarlo de la venta.
  if v_svc_rate > 0 then
    perform public.require_module('restaurant');
    if v_svc_rate > 0.25 then
      raise exception 'Cargo por servicio inválido';
    end if;
    v_svc := round((v_calc ->> 'subtotal')::numeric * v_svc_rate, 2);
    v_total := v_total + v_svc;
  end if;

  -- Pagos
  if jsonb_typeof(p_payload -> 'payments') <> 'array' then
    raise exception 'Indica cómo se paga la venta';
  end if;
  for v_pay in select * from jsonb_array_elements(p_payload -> 'payments') loop
    v_method := (v_pay ->> 'method')::payment_method;
    v_amt := round((v_pay ->> 'amount')::numeric, 2);
    if v_amt is null or v_amt <= 0 then
      continue;
    end if;
    case v_method
      when 'cash' then v_cash_in := v_cash_in + v_amt;
      when 'credit' then v_credit := v_credit + v_amt;
      when 'credit_note' then raise exception 'Método de pago inválido';
      when 'advance' then v_advance := v_advance + v_amt;
      else v_noncash := v_noncash + v_amt;
    end case;
  end loop;

  -- Anticipo: SOLO el que se cobró de verdad para esta orden de trabajo y aún
  -- no se aplicó. Sin esta comprobación cualquiera podría "pagar" con
  -- anticipos inventados llamando a create_sale directamente.
  if v_advance > 0 then
    if v_wo is null then
      raise exception 'Un anticipo solo se aplica a la venta de su orden de trabajo';
    end if;
    perform 1 from work_orders where id = v_wo and tenant_id = v_tenant for update;
    select coalesce(sum(amount), 0) into v_adv_avail from work_order_advances
    where order_id = v_wo and tenant_id = v_tenant and applied_sale_id is null;
    if v_advance <> v_adv_avail then
      raise exception 'El anticipo aplicado (%) no coincide con el disponible de la orden (%)', v_advance, v_adv_avail;
    end if;
  end if;

  v_paid := v_cash_in + v_noncash + v_credit + v_advance;
  if v_paid < v_total then
    raise exception 'El pago (%) no cubre el total (%)', v_paid, v_total;
  end if;
  v_change := v_paid - v_total;
  -- Solo el efectivo da devuelta: con tarjeta o transferencia no se cobra de más.
  if v_change > v_cash_in then
    raise exception 'El pago con tarjeta, transferencia o crédito no puede superar el total';
  end if;
  if v_credit > 0 and v_change > 0 then
    raise exception 'Una venta a crédito no lleva devuelta: ajusta el monto a crédito';
  end if;

  if v_credit > 0 then
    perform public.require_perm('sales.credit');
    perform public.require_module('credit');
    if v_customer.id is null then
      raise exception 'Para vender a crédito selecciona un cliente';
    end if;
    if v_customer.credit_limit <= 0 then
      raise exception 'CREDIT_LIMIT: % no tiene crédito autorizado.', v_customer.name;
    end if;
    select coalesce(sum(amount - paid_amount), 0) into v_balance
    from receivables where tenant_id = v_tenant and customer_id = v_customer.id and status = 'open';
    if v_balance + v_credit > v_customer.credit_limit then
      raise exception 'CREDIT_LIMIT: El crédito de % quedaría en % y su límite es %.',
        v_customer.name, v_balance + v_credit, v_customer.credit_limit;
    end if;
  end if;

  if v_quote is not null then
    perform 1 from quotations
    where id = v_quote and tenant_id = v_tenant and status in ('draft', 'sent', 'accepted')
    for update;
    if not found then
      raise exception 'La cotización no existe o ya fue convertida';
    end if;
  end if;

  select * into v_num from public.next_doc_number(v_tenant, 'sale');
  insert into sales (tenant_id, client_uid, branch_id, register_id, session_id, seq, number, customer_id,
                     seller_id, quotation_id, subtotal, discount_total, tax_total, total, paid_total,
                     change_due, credit_amount, ecf_type, notes, service_charge)
  values (v_tenant, v_uid, v_reg.branch_id, v_reg.id, v_session.id, v_num.seq, v_num.label, v_customer.id,
          v_seller, v_quote, (v_calc ->> 'subtotal')::numeric, (v_calc ->> 'discount_total')::numeric,
          (v_calc ->> 'tax_total')::numeric, v_total, v_total, v_change, v_credit, v_ecf,
          nullif(btrim(p_payload ->> 'notes'), ''), v_svc)
  on conflict (tenant_id, client_uid) do nothing
  returning id into v_sale_id;

  if v_sale_id is null then
    -- Otra petición con el mismo client_uid ganó la carrera: devolver la suya.
    select * into v_existing from sales where tenant_id = v_tenant and client_uid = v_uid;
    return jsonb_build_object('sale_id', v_existing.id, 'number', v_existing.number,
                              'total', v_existing.total, 'change_due', v_existing.change_due, 'replayed', true);
  end if;

  for v_line in select * from jsonb_array_elements(v_calc -> 'lines') loop
    insert into sale_items (tenant_id, sale_id, line_no, product_id, description, quantity, unit_price,
                            discount, tax_id, tax_rate, subtotal, tax_amount, total, unit_cost)
    values (v_tenant, v_sale_id, (v_line ->> 'line_no')::int, (v_line ->> 'product_id')::uuid,
            v_line ->> 'description', (v_line ->> 'quantity')::numeric, (v_line ->> 'unit_price')::numeric,
            (v_line ->> 'discount')::numeric, (v_line ->> 'tax_id')::uuid, (v_line ->> 'tax_rate')::numeric,
            (v_line ->> 'subtotal')::numeric, (v_line ->> 'tax_amount')::numeric, (v_line ->> 'total')::numeric,
            (v_line ->> 'unit_cost')::numeric)
    returning id into v_item_id;
    if (v_line ->> 'track_stock')::boolean and public.tenant_has_module('inventory') then
      insert into inventory_movements (tenant_id, branch_id, product_id, kind, quantity, unit_cost,
                                       reference_type, reference_id, line_ref, reason)
      values (v_tenant, v_reg.branch_id, (v_line ->> 'product_id')::uuid, 'sale',
              -(v_line ->> 'quantity')::numeric, (v_line ->> 'unit_cost')::numeric,
              'sale', v_sale_id, v_item_id, 'Venta ' || v_num.label);
    end if;
  end loop;

  -- Pagos aplicados y su reflejo en la caja.
  for v_pay in select * from jsonb_array_elements(p_payload -> 'payments') loop
    v_method := (v_pay ->> 'method')::payment_method;
    v_amt := round((v_pay ->> 'amount')::numeric, 2);
    if v_amt is null or v_amt <= 0 then
      continue;
    end if;
    if v_method = 'cash' then
      continue; -- el efectivo se registra agregado, abajo
    end if;
    insert into sale_payments (tenant_id, sale_id, method, amount, reference)
    values (v_tenant, v_sale_id, v_method, v_amt, nullif(v_pay ->> 'reference', ''));
    -- El anticipo ya entró a caja el día que se cobró; aquí no se repite.
    if v_method not in ('credit', 'advance') then
      insert into cash_movements (tenant_id, session_id, kind, method, amount, reference_type, reference_id)
      values (v_tenant, v_session.id, 'sale', v_method, v_amt, 'sale', v_sale_id);
    end if;
  end loop;

  -- Efectivo: UNA fila con lo entregado (tendered) y lo aplicado = entregado
  -- menos la devuelta. Agregarlo evita repartir la devuelta entre varias
  -- entradas de efectivo y que alguna quede negativa.
  if v_cash_in - v_change > 0 then
    insert into sale_payments (tenant_id, sale_id, method, amount, tendered)
    values (v_tenant, v_sale_id, 'cash', v_cash_in - v_change, v_cash_in);
    insert into cash_movements (tenant_id, session_id, kind, method, amount, reference_type, reference_id)
    values (v_tenant, v_session.id, 'sale', 'cash', v_cash_in - v_change, 'sale', v_sale_id);
  end if;

  if v_credit > 0 then
    insert into receivables (tenant_id, customer_id, sale_id, description, amount, due_date)
    values (v_tenant, v_customer.id, v_sale_id, 'Venta ' || v_num.label, v_credit,
            (now() at time zone (select timezone from tenants where id = v_tenant))::date + v_customer.credit_days);
  end if;

  if v_quote is not null then
    update quotations set status = 'converted', converted_sale_id = v_sale_id where id = v_quote;
  end if;

  if v_advance > 0 then
    update work_order_advances set applied_sale_id = v_sale_id
    where order_id = v_wo and tenant_id = v_tenant and applied_sale_id is null;
  end if;

  if v_ecf is not null then
    v_ecf_res := public.ecf_create_for_sale(v_sale_id, v_ecf);
  end if;

  return jsonb_build_object('sale_id', v_sale_id, 'number', v_num.label, 'total', v_total,
                            'change_due', (select change_due from sales where id = v_sale_id),
                            'ecf', v_ecf_res, 'replayed', false);
end;
$$;

revoke all on function public.create_sale(jsonb) from public, anon;
grant execute on function public.create_sale(jsonb) to authenticated;

notify pgrst, 'reload schema';
