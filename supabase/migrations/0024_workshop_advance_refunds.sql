-- ═══ Ferddo · 0024 · Devolución de anticipos de taller ═══
--
-- Por qué: si un anticipo supera lo que al final cuesta la orden (o la orden
-- se cancela), había que poder devolverlo; sin esto la orden quedaba bloqueada
-- para facturar o cancelar. El anticipo NO se borra (es historia de caja): se
-- marca devuelto y sale de una caja abierta como movimiento negativo. Las tres
-- funciones que suman "anticipos disponibles" pasan a ignorar los devueltos.

alter table public.work_order_advances
  add column if not exists refunded_at timestamptz,
  add column if not exists refund_session_id uuid,
  add column if not exists refund_reason text,
  add column if not exists refunded_by uuid references auth.users (id) on delete set null;
do $$ begin
  alter table public.work_order_advances add constraint work_order_advances_refund_session_fk
    foreign key (tenant_id, refund_session_id) references public.cash_sessions (tenant_id, id);
exception when duplicate_object then null; end $$;
create index if not exists work_order_advances_refund_session_idx on public.work_order_advances (refund_session_id);
create index if not exists work_order_advances_refunded_by_idx on public.work_order_advances (refunded_by);

-- p_payload: { advance_id, register_id, reason }
create or replace function public.wo_refund_advance(p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.auth_tenant_id();
  v_a       work_order_advances;
  v_session cash_sessions;
begin
  perform public.require_perm('workshop.manage');
  perform public.require_perm('cash.move');
  if nullif(btrim(p_payload ->> 'reason'), '') is null then
    raise exception 'Indica el motivo de la devolución';
  end if;
  select * into v_a from work_order_advances
  where id = (p_payload ->> 'advance_id')::uuid and tenant_id = v_tenant for update;
  if not found then
    raise exception 'Anticipo no encontrado';
  end if;
  if v_a.applied_sale_id is not null then
    raise exception 'Ese anticipo ya se aplicó a una venta: registra una devolución de la venta';
  end if;
  if v_a.refunded_at is not null then
    raise exception 'Ese anticipo ya fue devuelto';
  end if;
  v_session := public.open_session_for((p_payload ->> 'register_id')::uuid);
  update work_order_advances set refunded_at = now(), refund_session_id = v_session.id,
         refund_reason = btrim(p_payload ->> 'reason'), refunded_by = auth.uid()
  where id = v_a.id;
  insert into cash_movements (tenant_id, session_id, kind, method, amount, reference_type, reference_id, note)
  values (v_tenant, v_session.id, 'advance', v_a.method, -v_a.amount, 'work_order_advance', v_a.id,
          'Devolución de anticipo ' || v_a.number || ': ' || btrim(p_payload ->> 'reason'));
  perform public.log_audit('work_order.advance_refunded', 'work_order', v_a.order_id,
                           jsonb_build_object('advance', v_a.number, 'amount', v_a.amount, 'reason', p_payload ->> 'reason'));
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
    where order_id = v_wo and tenant_id = v_tenant and applied_sale_id is null and refunded_at is null;
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
    where order_id = v_wo and tenant_id = v_tenant and applied_sale_id is null and refunded_at is null;
  end if;

  if v_ecf is not null then
    v_ecf_res := public.ecf_create_for_sale(v_sale_id, v_ecf);
  end if;

  return jsonb_build_object('sale_id', v_sale_id, 'number', v_num.label, 'total', v_total,
                            'change_due', (select change_due from sales where id = v_sale_id),
                            'ecf', v_ecf_res, 'replayed', false);
end;
$$;

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
  where order_id = v_o.id and applied_sale_id is null and refunded_at is null;
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
    if exists (select 1 from work_order_advances where order_id = p_id and applied_sale_id is null and refunded_at is null) then
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

do $$
declare
  f text;
begin
  foreach f in array array['public.wo_refund_advance(jsonb)', 'public.create_sale(jsonb)', 'public.wo_checkout(jsonb)',
                           'public.wo_set_status(uuid, work_order_status, text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
