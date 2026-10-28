-- ═══ Ferddo · 0023 · Listas de precios y recepción parcial de compras ═══
--
-- Por qué existe:
--   · Listas de precios: el mayorista, el cliente fijo o la empresa con
--     acuerdo compran a otro precio. Se asigna una lista al CLIENTE y el motor
--     único de cálculo (price_lines) toma de ahí el precio base; el permiso de
--     "cambiar precio" se mide contra ese precio de lista, no contra el de
--     catálogo, para que vender a precio de lista no exija permisos especiales.
--   · Recepción parcial: el proveedor manda la mitad hoy y el resto la semana
--     próxima. Cada recepción es un documento (purchase_receipts) con su propia
--     entrada de inventario y su propia cuenta por pagar, por el valor recibido.
--     La compra se marca 'received' solo cuando llegó todo.

-- ── Listas de precios ───────────────────────────────────────────────────────
create table if not exists public.price_lists (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  name       text not null check (btrim(name) <> ''),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create index if not exists price_lists_tenant_idx on public.price_lists (tenant_id);
create unique index if not exists price_lists_name_idx on public.price_lists (tenant_id, lower(name));
select public._setup_tenant_table('price_lists', 'prices.manage');

create table if not exists public.price_list_items (
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  price_list_id uuid not null,
  product_id    uuid not null,
  price         numeric(14, 2) not null check (price >= 0),
  updated_at    timestamptz not null default now(),
  primary key (price_list_id, product_id),
  foreign key (tenant_id, price_list_id) references public.price_lists (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references public.products (tenant_id, id)
);
create index if not exists price_list_items_tenant_idx on public.price_list_items (tenant_id, product_id);
select public._setup_tenant_table('price_list_items', 'prices.manage', true);

alter table public.customers add column if not exists price_list_id uuid;
do $$ begin
  alter table public.customers add constraint customers_price_list_fk
    foreign key (tenant_id, price_list_id) references public.price_lists (tenant_id, id);
exception when duplicate_object then null; end $$;
create index if not exists customers_price_list_idx on public.customers (price_list_id);

-- Asignar lista a un cliente es dar descuento: exige prices.manage aunque
-- quien edite el cliente solo tenga customers.manage.
create or replace function public.customers_price_list_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null
     and new.price_list_id is distinct from (case when tg_op = 'UPDATE' then old.price_list_id end)
     and new.price_list_id is not null
     and not public.has_perm('prices.manage') then
    raise exception 'FORBIDDEN: No tienes permiso para asignar listas de precios.';
  end if;
  return new;
end;
$$;
revoke all on function public.customers_price_list_guard() from public, anon;
drop trigger if exists trg_customers_price_list on public.customers;
create trigger trg_customers_price_list before insert or update of price_list_id on public.customers
  for each row execute function public.customers_price_list_guard();

-- price_lines gana un 5.º parámetro; se borra la firma vieja para que una
-- llamada con 4 argumentos no sea ambigua entre las dos versiones.
drop function if exists public.price_lines(uuid, jsonb, numeric, boolean);
create or replace function public.price_lines(
  p_tenant          uuid,
  p_items           jsonb,
  p_global_discount numeric default 0,
  p_enforce_perms   boolean default true,
  p_price_list      uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_incl     boolean;
  v_item     jsonb;
  v_p        products;
  v_rate     numeric;
  v_qty      numeric;
  v_price    numeric;
  v_disc     numeric;
  v_gross    numeric;
  v_lines    jsonb := '[]'::jsonb;
  v_net_sum  numeric := 0;
  v_gd       numeric := round(coalesce(p_global_discount, 0), 2);
  v_alloc    numeric;
  v_alloc_left numeric;
  v_i        int := 0;
  v_n        int;
  v_line     jsonb;
  v_net      numeric;
  v_base     numeric;
  v_tax      numeric;
  v_total    numeric;
  v_out      jsonb := '[]'::jsonb;
  v_base_price numeric;
  v_sub      numeric := 0;
  v_taxsum   numeric := 0;
  v_dsum     numeric := 0;
  v_tsum     numeric := 0;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Agrega al menos un producto';
  end if;
  if jsonb_array_length(p_items) > 500 then
    raise exception 'Demasiadas líneas en un solo documento';
  end if;
  select prices_include_tax into v_incl from tenants where id = p_tenant;

  -- Pasada 1: validar y calcular el neto de cada línea.
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_p from products
    where id = (v_item ->> 'product_id')::uuid and tenant_id = p_tenant;
    if not found then
      raise exception 'Producto no encontrado';
    end if;
    if not v_p.is_active then
      raise exception '"%" está inactivo', v_p.name;
    end if;
    v_qty := round((v_item ->> 'quantity')::numeric, 3);
    if v_qty is null or v_qty <= 0 then
      raise exception 'Cantidad inválida para "%"', v_p.name;
    end if;
    -- Precio base: el de la lista del cliente si el producto está en ella; si
    -- no, el del catálogo. El permiso de cambiar precio se mide contra ESTE.
    v_base_price := coalesce((select pli.price from price_list_items pli
                              join price_lists pl on pl.id = pli.price_list_id and pl.is_active
                              where pli.price_list_id = p_price_list and pli.product_id = v_p.id), v_p.price);
    v_price := round(coalesce((v_item ->> 'unit_price')::numeric, v_base_price), 2);
    if v_price < 0 then
      raise exception 'Precio inválido para "%"', v_p.name;
    end if;
    if p_enforce_perms and v_price <> v_base_price and not public.has_perm('sales.price_override') then
      raise exception 'FORBIDDEN: No tienes permiso para cambiar el precio de "%".', v_p.name;
    end if;
    v_disc := round(coalesce((v_item ->> 'discount')::numeric, 0), 2);
    v_gross := round(v_qty * v_price, 2);
    if v_disc < 0 or v_disc > v_gross then
      raise exception 'Descuento inválido para "%"', v_p.name;
    end if;
    select coalesce(rate, 0) into v_rate from taxes where id = v_p.tax_id and tenant_id = p_tenant;
    v_rate := coalesce(v_rate, 0);
    v_lines := v_lines || jsonb_build_object(
      'product_id', v_p.id, 'description', coalesce(nullif(btrim(v_item ->> 'description'), ''),
                                                    v_p.name || coalesce(' ' || v_p.variant_label, '')),
      'quantity', v_qty, 'unit_price', v_price, 'line_discount', v_disc, 'gross', v_gross,
      'tax_id', v_p.tax_id, 'tax_rate', v_rate, 'unit_cost', v_p.cost,
      'track_stock', v_p.track_stock, 'kind', v_p.kind);
    v_net_sum := v_net_sum + (v_gross - v_disc);
  end loop;

  if v_gd < 0 or v_gd > v_net_sum then
    raise exception 'El descuento general no puede superar el total';
  end if;
  if p_enforce_perms and (v_gd > 0 or exists (
        select 1 from jsonb_array_elements(v_lines) l where (l ->> 'line_discount')::numeric > 0))
     and not public.has_perm('sales.discount') then
    raise exception 'FORBIDDEN: No tienes permiso para aplicar descuentos.';
  end if;

  -- Pasada 2: repartir el descuento global en proporción al neto de cada
  -- línea (la última se lleva el residuo del redondeo) y calcular el ITBIS.
  v_n := jsonb_array_length(v_lines);
  v_alloc_left := v_gd;
  for v_line in select * from jsonb_array_elements(v_lines) loop
    v_i := v_i + 1;
    v_net := (v_line ->> 'gross')::numeric - (v_line ->> 'line_discount')::numeric;
    if v_gd = 0 or v_net_sum = 0 then
      v_alloc := 0;
    elsif v_i = v_n then
      v_alloc := v_alloc_left;
    else
      v_alloc := round(v_gd * v_net / v_net_sum, 2);
    end if;
    v_alloc_left := v_alloc_left - v_alloc;
    v_net := v_net - v_alloc;
    v_rate := (v_line ->> 'tax_rate')::numeric;
    if v_incl then
      v_total := v_net;
      v_base := round(v_total / (1 + v_rate), 2);
      v_tax := v_total - v_base;
    else
      v_base := v_net;
      v_tax := round(v_base * v_rate, 2);
      v_total := v_base + v_tax;
    end if;
    v_out := v_out || (v_line - 'gross' - 'line_discount' || jsonb_build_object(
      'line_no', v_i,
      'discount', (v_line ->> 'line_discount')::numeric + v_alloc,
      'subtotal', v_base, 'tax_amount', v_tax, 'total', v_total));
    v_sub := v_sub + v_base;
    v_taxsum := v_taxsum + v_tax;
    v_dsum := v_dsum + (v_line ->> 'line_discount')::numeric + v_alloc;
    v_tsum := v_tsum + v_total;
  end loop;

  return jsonb_build_object('lines', v_out, 'subtotal', v_sub, 'discount_total', v_dsum,
                            'tax_total', v_taxsum, 'total', v_tsum, 'prices_include_tax', v_incl);
end;
$$;

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

  -- Precio de lista del cliente (si tiene una asignada) como precio base.
  v_calc := public.price_lines(v_tenant, p_payload -> 'items', coalesce((p_payload ->> 'global_discount')::numeric, 0), true,
                               v_customer.price_list_id);
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

create or replace function public.save_quotation(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_id     uuid := (p_payload ->> 'id')::uuid;
  v_calc   jsonb;
  v_num    record;
  v_cur    quotations;
  v_line   jsonb;
  v_item   jsonb;
  v_i      int := 0;
begin
  perform public.require_perm('quotations.manage');
  perform public.require_module('quotations');
  perform public.assert_tenant_operational();
  if not public.can_access_branch((p_payload ->> 'branch_id')::uuid) then
    raise exception 'FORBIDDEN: No tienes acceso a esa sucursal.';
  end if;
  v_calc := public.price_lines(v_tenant, p_payload -> 'items', coalesce((p_payload ->> 'global_discount')::numeric, 0), true,
                               (select price_list_id from customers
                                where id = (p_payload ->> 'customer_id')::uuid and tenant_id = v_tenant));

  if v_id is null then
    select * into v_num from public.next_doc_number(v_tenant, 'quotation');
    insert into quotations (tenant_id, branch_id, seq, number, valid_until)
    values (v_tenant, (p_payload ->> 'branch_id')::uuid, v_num.seq, 'CT-' || v_num.label,
            coalesce((p_payload ->> 'valid_until')::date, current_date + 15))
    returning id into v_id;
  else
    select * into v_cur from quotations where id = v_id and tenant_id = v_tenant for update;
    if not found then
      raise exception 'Cotización no encontrada';
    end if;
    if v_cur.status not in ('draft', 'sent') then
      raise exception 'Solo se editan cotizaciones en borrador o enviadas';
    end if;
    delete from quotation_items where quotation_id = v_id;
  end if;

  update quotations set
    branch_id = (p_payload ->> 'branch_id')::uuid,
    customer_id = (p_payload ->> 'customer_id')::uuid,
    valid_until = coalesce((p_payload ->> 'valid_until')::date, valid_until),
    notes = nullif(btrim(p_payload ->> 'notes'), ''),
    terms = nullif(btrim(p_payload ->> 'terms'), ''),
    global_discount = round(coalesce((p_payload ->> 'global_discount')::numeric, 0), 2),
    subtotal = (v_calc ->> 'subtotal')::numeric,
    discount_total = (v_calc ->> 'discount_total')::numeric,
    tax_total = (v_calc ->> 'tax_total')::numeric,
    total = (v_calc ->> 'total')::numeric
  where id = v_id;

  for v_line in select * from jsonb_array_elements(v_calc -> 'lines') loop
    v_i := v_i + 1;
    v_item := (p_payload -> 'items') -> (v_i - 1);
    insert into quotation_items (tenant_id, quotation_id, line_no, product_id, description, quantity, unit_price,
                                 discount, line_discount, tax_id, tax_rate, subtotal, tax_amount, total)
    values (v_tenant, v_id, v_i, (v_line ->> 'product_id')::uuid, v_line ->> 'description',
            (v_line ->> 'quantity')::numeric, (v_line ->> 'unit_price')::numeric, (v_line ->> 'discount')::numeric,
            round(coalesce((v_item ->> 'discount')::numeric, 0), 2),
            (v_line ->> 'tax_id')::uuid, (v_line ->> 'tax_rate')::numeric, (v_line ->> 'subtotal')::numeric,
            (v_line ->> 'tax_amount')::numeric, (v_line ->> 'total')::numeric);
  end loop;
  perform public.log_audit('quotation.saved', 'quotation', v_id);
  return v_id;
end;
$$;
revoke all on function public.price_lines(uuid, jsonb, numeric, boolean, uuid) from public, anon, authenticated;

-- Vista previa con el precio del cliente (p_customer opcional).
drop function if exists public.preview_totals(jsonb, numeric);
create or replace function public.preview_totals(p_items jsonb, p_global_discount numeric default 0, p_customer uuid default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.price_lines(public.auth_tenant_id(), p_items, p_global_discount, false,
                            (select price_list_id from customers where id = p_customer and tenant_id = public.auth_tenant_id()))
  where public.auth_tenant_id() is not null
$$;

-- ── Recepción parcial ───────────────────────────────────────────────────────
alter table public.purchase_items add column if not exists received_qty numeric(14, 3) not null default 0;
do $$ begin
  alter table public.purchase_items add constraint purchase_items_received_chk
    check (received_qty >= 0 and received_qty <= quantity);
exception when duplicate_object then null; end $$;

-- Las compras recibidas por el camino anterior (todo de una vez) quedan
-- coherentes con el nuevo modelo.
update public.purchase_items pi set received_qty = pi.quantity
from public.purchases p where p.id = pi.purchase_id and p.status = 'received' and pi.received_qty = 0;

create table if not exists public.purchase_receipts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  purchase_id uuid not null,
  number      text not null,
  total       numeric(14, 2) not null,
  payable_id  uuid,
  created_by  uuid references auth.users (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, purchase_id) references public.purchases (tenant_id, id),
  foreign key (tenant_id, payable_id) references public.payables (tenant_id, id)
);
create index if not exists purchase_receipts_purchase_idx on public.purchase_receipts (purchase_id);
create index if not exists purchase_receipts_payable_idx on public.purchase_receipts (payable_id);
create index if not exists purchase_receipts_created_by_idx on public.purchase_receipts (created_by);
select public._setup_tenant_table('purchase_receipts', null);

-- Una línea con mercancía ya recibida no se borra (save_purchase reemplaza
-- las líneas al editar): sería perder la trazabilidad de lo que entró.
create or replace function public.purchase_items_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.received_qty > 0 and not public.is_purging_tenant(old.tenant_id) then
    raise exception 'Esta compra ya tiene mercancía recibida; no se puede editar. Recibe el resto o cancélalo.';
  end if;
  return old;
end;
$$;
revoke all on function public.purchase_items_guard() from public, anon;
drop trigger if exists trg_purchase_items_guard on public.purchase_items;
create trigger trg_purchase_items_guard before delete on public.purchase_items
  for each row execute function public.purchase_items_guard();

-- p_lines: [{purchase_item_id, quantity}] — sin p_lines se recibe todo lo pendiente.
drop function if exists public.receive_purchase(uuid, jsonb);
create or replace function public.receive_purchase(p_id uuid, p_payment jsonb default null, p_lines jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.auth_tenant_id();
  v_p       purchases;
  v_it      purchase_items;
  v_qty     numeric;
  v_val     numeric;
  v_total   numeric := 0;
  v_track   boolean;
  v_onhand  numeric;
  v_oldcost numeric;
  v_ucost   numeric;
  v_paid    numeric := round(coalesce((p_payment ->> 'amount')::numeric, 0), 2);
  v_rcpt    uuid;
  v_num     record;
  v_payable uuid;
  v_terms   integer;
  v_pay     uuid;
  v_done    boolean;
  v_n       int := 0;
begin
  perform public.require_perm('purchases.manage');
  perform public.require_module('purchases');
  perform public.assert_tenant_operational();
  select * into v_p from purchases where id = p_id and tenant_id = v_tenant for update;
  if not found then
    raise exception 'Compra no encontrada';
  end if;
  if v_p.status not in ('draft', 'ordered') then
    raise exception 'Esta compra ya fue recibida o cancelada';
  end if;

  select * into v_num from public.next_doc_number(v_tenant, 'purchase_receipt');
  insert into purchase_receipts (tenant_id, purchase_id, number, total)
  values (v_tenant, p_id, 'RE-' || v_num.label, 0)
  returning id into v_rcpt;

  for v_it in select * from purchase_items where purchase_id = p_id order by line_no for update loop
    if p_lines is null then
      v_qty := v_it.quantity - v_it.received_qty;
    else
      select round((l ->> 'quantity')::numeric, 3) into v_qty
      from jsonb_array_elements(p_lines) l where (l ->> 'purchase_item_id')::uuid = v_it.id;
      v_qty := coalesce(v_qty, 0);
    end if;
    continue when v_qty <= 0;
    if v_it.received_qty + v_qty > v_it.quantity then
      raise exception 'De "%" solo faltan % por recibir', v_it.description, v_it.quantity - v_it.received_qty;
    end if;
    -- Valor de lo recibido (con ITBIS), proporcional; la última entrega se
    -- lleva el residuo para que la suma de recepciones cuadre con la compra.
    if v_it.received_qty + v_qty = v_it.quantity then
      v_val := v_it.total - round(v_it.total * v_it.received_qty / v_it.quantity, 2);
    else
      v_val := round(v_it.total * v_qty / v_it.quantity, 2);
    end if;
    v_ucost := round(v_it.subtotal / v_it.quantity, 4);
    select track_stock, cost into v_track, v_oldcost from products where id = v_it.product_id for update;
    if v_track then
      select coalesce(sum(quantity), 0) into v_onhand from stock_levels where product_id = v_it.product_id;
      update products set cost = case
          when v_onhand <= 0 then v_ucost
          else round((v_onhand * v_oldcost + v_qty * v_ucost) / (v_onhand + v_qty), 4) end
      where id = v_it.product_id;
      insert into inventory_movements (tenant_id, branch_id, product_id, kind, quantity, unit_cost,
                                       reference_type, reference_id, line_ref, reason)
      values (v_tenant, v_p.branch_id, v_it.product_id, 'purchase', v_qty, v_ucost,
              'purchase_receipt', v_rcpt, v_it.id, 'Compra ' || v_p.number);
    else
      update products set cost = v_ucost where id = v_it.product_id;
    end if;
    update purchase_items set received_qty = received_qty + v_qty where id = v_it.id;
    v_total := v_total + v_val;
    v_n := v_n + 1;
  end loop;

  if v_n = 0 then
    raise exception 'No hay nada que recibir';
  end if;
  if v_paid < 0 or v_paid > v_total then
    raise exception 'El pago no puede superar el valor recibido (%)', v_total;
  end if;

  if v_total > 0 then
    select payment_terms_days into v_terms from suppliers where id = v_p.supplier_id;
    insert into payables (tenant_id, supplier_id, source_type, source_id, description, amount, due_date)
    values (v_tenant, v_p.supplier_id, 'purchase', p_id, 'Compra ' || v_p.number || ' · ' || 'RE-' || v_num.label, v_total,
            coalesce(v_p.due_date, current_date + coalesce(v_terms, 0)))
    returning id into v_payable;
    if v_paid > 0 then
      perform public.require_perm('payables.manage');
      v_pay := public._pay_payables(v_tenant, coalesce((p_payment ->> 'client_uid')::uuid, gen_random_uuid()),
                                    v_p.supplier_id, v_payable, v_paid,
                                    coalesce(p_payment ->> 'method', 'cash')::payment_method,
                                    (p_payment ->> 'register_id')::uuid, p_payment ->> 'reference', null);
    end if;
  end if;
  update purchase_receipts set total = v_total, payable_id = v_payable where id = v_rcpt;

  select bool_and(received_qty = quantity) into v_done from purchase_items where purchase_id = p_id;
  update purchases set
    status = case when v_done then 'received' else 'ordered' end::purchase_status,
    received_at = case when v_done then now() else received_at end,
    received_by = case when v_done then auth.uid() else received_by end
  where id = p_id;
  perform public.log_audit('purchase.received', 'purchase', p_id,
                           jsonb_build_object('receipt', 'RE-' || v_num.label, 'value', v_total, 'complete', v_done));
  return jsonb_build_object('purchase_id', p_id, 'receipt_id', v_rcpt, 'receipt_number', 'RE-' || v_num.label,
                            'value', v_total, 'payable_id', v_payable, 'payment_id', v_pay, 'completed', v_done);
end;
$$;

create or replace function public.cancel_purchase(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_perm('purchases.manage');
  if exists (select 1 from purchase_items where purchase_id = p_id and received_qty > 0) then
    raise exception 'Esta compra ya tiene mercancía recibida; no se puede cancelar';
  end if;
  update purchases set status = 'canceled', canceled_reason = nullif(btrim(p_reason), '')
  where id = p_id and tenant_id = public.auth_tenant_id() and status in ('draft', 'ordered');
  if not found then
    raise exception 'Solo se cancelan compras en borrador u ordenadas';
  end if;
  perform public.log_audit('purchase.canceled', 'purchase', p_id, jsonb_build_object('reason', p_reason));
end;
$$;

-- Purga: tablas nuevas en su sitio (hijo → padre).
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
    'purchase_receipts', 'receivables', 'payables', 'sale_return_items', 'sale_returns', 'sale_payments', 'sale_items', 'sales',
    'quotation_items', 'quotations', 'cash_movements', 'cash_sessions', 'cash_registers',
    'inventory_movements', 'inventory_documents', 'stock_levels', 'purchase_items', 'purchases',
    'price_list_items', 'customers', 'price_lists',
    'products', 'categories', 'taxes', 'suppliers', 'expense_categories',
    'document_sequences', 'role_permissions', 'tenant_members', 'branches', 'subscription_events',
    'notifications', 'audit_logs', 'tenant_invites', 'plan_requests', 'subscriptions'
  ]
$$;
revoke all on function public.tenant_tables_purge_order() from public, anon, authenticated;

do $$
declare
  f   text;
  fns text[] := array[
    'public.preview_totals(jsonb, numeric, uuid)',
    'public.receive_purchase(uuid, jsonb, jsonb)',
    'public.cancel_purchase(uuid, text)',
    'public.create_sale(jsonb)',
    'public.save_quotation(jsonb)'
  ];
begin
  foreach f in array fns loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
