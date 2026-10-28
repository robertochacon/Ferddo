-- ═══════════════════════════════════════════════════════════════════════════
-- Ferddo · Prueba de integración de la fase 8 (restaurante y taller)
--
--   supabase db query --linked -f supabase/tests/phase8_integration.sql
--
-- Igual que erp_integration.sql: termina lanzando 'FERDDO_TESTS_OK' para
-- revertir TODO (usuarios incluidos). Resultado esperado: ERROR … FERDDO_TESTS_OK
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function pg_temp.act_as(p_uid uuid)
returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  if p_uid is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
  else
    perform set_config('request.jwt.claims', '', true);
  end if;
end $$;

create or replace function pg_temp.expect_error(p_sql text, p_pattern text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not like '%' || p_pattern || '%' then
      raise exception 'ASSERT: se esperaba error "%" y llegó "%" (sql: %)', p_pattern, sqlerrm, left(p_sql, 120);
    end if;
    return;
  end;
  raise exception 'ASSERT: se esperaba error "%" y no hubo error (sql: %)', p_pattern, left(p_sql, 120);
end $$;

create or replace function pg_temp.ok(p_cond boolean, p_msg text)
returns void language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception 'ASSERT: %', p_msg;
  end if;
  perform set_config('ferddo_test.count', (coalesce(nullif(current_setting('ferddo_test.count', true), ''), '0')::int + 1)::text, true);
end $$;

do $$
declare
  ua uuid := gen_random_uuid();   -- dueño
  uk uuid := gen_random_uuid();   -- cocina
  us uuid := gen_random_uuid();   -- mesero (vendedor)
  ud uuid := gen_random_uuid();   -- super-admin (purga)
  t uuid; v_branch uuid; v_reg uuid; v_t18 uuid; v_ex uuid;
  p_mofongo uuid; p_beer uuid; p_oil uuid; p_filter uuid;
  v_area uuid; m1 uuid; m2 uuid; o1 uuid; o2 uuid; o3 uuid;
  v_it uuid; v_beer_it uuid; r jsonb; v_sale uuid; v_code text; v_n int;
  v_cust uuid; v_car uuid; w1 uuid; w2 uuid; v_q uuid; v_sub numeric;
begin
  insert into auth.users (id, email, aud, role) values
    (ua, ua || '@t.ferddo', 'authenticated', 'authenticated'), (uk, uk || '@t.ferddo', 'authenticated', 'authenticated'),
    (us, us || '@t.ferddo', 'authenticated', 'authenticated'), (ud, ud || '@t.ferddo', 'authenticated', 'authenticated');

  perform pg_temp.act_as(ua);
  t := public.setup_business('La Fonda', 'restaurant');
  perform pg_temp.act_as(null);
  update subscriptions set plan = 'enterprise', status = 'active' where tenant_id = t;
  perform pg_temp.act_as(ua);
  perform pg_temp.ok(public.tenant_has_module('restaurant') and not public.tenant_has_module('workshop'),
                     'restaurante activo por tipo de negocio, taller no');
  perform pg_temp.expect_error(format('select public.wo_save(''{"branch_id":"%s"}'')', gen_random_uuid()), 'PLAN_LIMIT_MODULE');

  select id into v_branch from branches where tenant_id = t and is_main;
  select id into v_reg from cash_registers where tenant_id = t;
  select id into v_t18 from taxes where tenant_id = t and code = 'ITBIS18';
  select id into v_ex from taxes where tenant_id = t and code = 'EXENTO';
  insert into products (tenant_id, name, price, tax_id, track_stock) values (t, 'Mofongo', 450, v_t18, false) returning id into p_mofongo;
  insert into products (tenant_id, name, price, tax_id) values (t, 'Cerveza', 120, v_t18) returning id into p_beer;
  perform public.inventory_adjust(v_branch, jsonb_build_array(jsonb_build_object('product_id', p_beer, 'quantity', 24)), 'Inicial', true);
  insert into restaurant_areas (tenant_id, branch_id, name) values (t, v_branch, 'Terraza') returning id into v_area;
  insert into restaurant_tables (tenant_id, branch_id, area_id, name) values (t, v_branch, v_area, 'Mesa 1') returning id into m1;
  insert into restaurant_tables (tenant_id, branch_id, area_id, name) values (t, v_branch, v_area, 'Mesa 2') returning id into m2;
  perform public.open_cash_session(v_reg, 0);

  -- Personal: cocina y mesero.
  v_code := public.create_invite('kitchen');
  perform pg_temp.act_as(uk); perform public.accept_invite(v_code);
  perform pg_temp.act_as(ua); v_code := public.create_invite('seller');
  perform pg_temp.act_as(us); perform public.accept_invite(v_code);

  -- ── Cuenta, comanda y cocina ─────────────────────────────────────────────
  perform pg_temp.act_as(us);
  o1 := public.rest_open_order(v_branch, m1, 2);
  perform public.rest_add_items(o1, jsonb_build_array(
    jsonb_build_object('product_id', p_mofongo, 'quantity', 2, 'notes', 'uno sin chicharrón'),
    jsonb_build_object('product_id', p_beer, 'quantity', 3)));
  select id into v_beer_it from restaurant_order_items where order_id = o1 and product_id = p_beer;
  perform public.rest_update_item(v_beer_it, 4);
  perform pg_temp.ok((select quantity from restaurant_order_items where id = v_beer_it) = 4, 'editar línea pendiente');
  r := public.rest_send_to_kitchen(o1);
  perform pg_temp.ok((r ->> 'items')::int = 2, 'comanda con 2 líneas');
  perform pg_temp.expect_error(format('select public.rest_send_to_kitchen(%L)', o1), 'nada nuevo');
  perform pg_temp.expect_error(format('select public.rest_update_item(%L, 1)', v_beer_it), 'ya se envió');
  perform pg_temp.expect_error(format('select public.rest_set_kitchen_status(%L, ''ready'')', v_beer_it), 'FORBIDDEN');
  perform pg_temp.expect_error(format('select public.rest_cancel_item(%L, ''error'')', v_beer_it), 'FORBIDDEN');

  perform pg_temp.act_as(uk);
  select id into v_it from restaurant_order_items where order_id = o1 and product_id = p_mofongo;
  perform public.rest_set_kitchen_status(v_it, 'preparing');
  perform public.rest_set_kitchen_status(v_it, 'ready');
  perform pg_temp.expect_error(format('select public.rest_set_kitchen_status(%L, ''sent'')', v_it), 'no permitido');
  perform pg_temp.expect_error(format('select public.rest_add_items(%L, ''[]'')', o1), 'FORBIDDEN');
  perform pg_temp.ok((select count(*) from sales) = 0, 'cocina no ve ventas');

  -- ── Dividir: cobrar 1 de las 4 cervezas ──────────────────────────────────
  perform pg_temp.act_as(us);
  perform public.rest_set_kitchen_status(v_it, 'served');
  r := public.rest_checkout(jsonb_build_object('order_id', o1, 'client_uid', gen_random_uuid(), 'register_id', v_reg,
       'lines', jsonb_build_array(jsonb_build_object('order_item_id', v_beer_it, 'quantity', 1)),
       'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 120))));
  perform pg_temp.ok((r ->> 'total')::numeric = 120 and not (r ->> 'order_closed')::boolean, 'cuenta dividida: 1 cerveza, sigue abierta');
  perform pg_temp.ok((select sum(quantity) from restaurant_order_items where order_id = o1 and product_id = p_beer
                      and billed_sale_id is null) = 3, 'quedan 3 cervezas por cobrar');
  perform pg_temp.ok((select quantity from stock_levels where product_id = p_beer) = 23, 'el cobro descuenta inventario');

  -- ── Resto con 10 % de ley ────────────────────────────────────────────────
  v_sale := gen_random_uuid();
  r := public.rest_checkout(jsonb_build_object('order_id', o1, 'client_uid', v_sale, 'register_id', v_reg,
       'service_charge', true, 'payments', jsonb_build_array(jsonb_build_object('method', 'card', 'amount', 1366.78))));
  select subtotal into v_sub from sales where id = (r ->> 'sale_id')::uuid;
  perform pg_temp.ok((select service_charge from sales where id = (r ->> 'sale_id')::uuid) = round(v_sub * 0.10, 2),
                     '10 % de ley sobre la base sin ITBIS');
  perform pg_temp.ok((r ->> 'total')::numeric = 900 + 360 + round(v_sub * 0.10, 2), 'total = consumo + 10 %: ' || (r ->> 'total'));
  perform pg_temp.ok((r ->> 'order_closed')::boolean, 'cuenta cerrada al cobrar todo');
  r := public.rest_checkout(jsonb_build_object('order_id', o1, 'client_uid', v_sale, 'register_id', v_reg,
       'payments', jsonb_build_array(jsonb_build_object('method', 'card', 'amount', 1))));
  perform pg_temp.ok((r ->> 'replayed')::boolean, 'cobro de cuenta idempotente');
  perform pg_temp.expect_error(format(
    'select public.create_sale(''{"client_uid":"%s","register_id":"%s","service_charge_rate":0.5,"items":[{"product_id":"%s","quantity":1}],"payments":[{"method":"cash","amount":999}]}'')',
    gen_random_uuid(), v_reg, p_beer), 'Cargo por servicio inválido');

  -- ── Unir cuentas ─────────────────────────────────────────────────────────
  o2 := public.rest_open_order(v_branch, m2, 2);
  o3 := public.rest_open_order(v_branch, m2, 1, 'Cuenta aparte');
  perform public.rest_add_items(o2, jsonb_build_array(jsonb_build_object('product_id', p_beer, 'quantity', 1)));
  perform public.rest_add_items(o3, jsonb_build_array(jsonb_build_object('product_id', p_mofongo, 'quantity', 1)));
  perform public.rest_merge_orders(o3, o2);
  perform pg_temp.ok((select count(*) from restaurant_order_items where order_id = o2) = 2, 'unir: las líneas pasan a la otra cuenta');
  perform pg_temp.ok((select status from restaurant_orders where id = o3) = 'closed', 'la cuenta origen se cierra');
  perform public.rest_move_order(o2, m1);
  perform pg_temp.act_as(ua);
  perform public.rest_cancel_order(o2, 'Cliente se fue');
  perform pg_temp.ok((select status from restaurant_orders where id = o2) = 'canceled', 'cancelar cuenta sin cobros');

  -- ── Taller ───────────────────────────────────────────────────────────────
  update tenants set modules = modules || array['workshop', 'quotations'] where id = t;
  insert into customers (tenant_id, name, phone) values (t, 'Juan Taxista', '8095550000') returning id into v_cust;
  insert into assets (tenant_id, customer_id, brand, model, year, plate) values (t, v_cust, 'Toyota', 'Corolla', 2015, 'A123456')
  returning id into v_car;
  perform pg_temp.expect_error(format('insert into assets (tenant_id, customer_id, plate) values (%L, %L, ''a123456'')', t, v_cust), 'duplicate');
  insert into products (tenant_id, kind, name, price, tax_id, track_stock) values (t, 'service', 'Cambio de aceite', 1500, v_ex, false)
  returning id into p_oil;
  insert into products (tenant_id, name, price, tax_id) values (t, 'Filtro de aceite', 354, v_t18) returning id into p_filter;
  perform public.inventory_adjust(v_branch, jsonb_build_array(jsonb_build_object('product_id', p_filter, 'quantity', 5)), 'Inicial', true);

  w1 := public.wo_save(jsonb_build_object('branch_id', v_branch, 'customer_id', v_cust, 'asset_id', v_car,
        'problem', 'Ruido al frenar y toca cambio de aceite', 'mileage_in', 98000,
        'items', jsonb_build_array(jsonb_build_object('product_id', p_oil, 'quantity', 1),
                                   jsonb_build_object('product_id', p_filter, 'quantity', 1))));
  perform pg_temp.ok((select number from work_orders where id = w1) like 'OT-%', 'orden de trabajo numerada');
  perform public.wo_set_status(w1, 'diagnosing');
  v_q := public.wo_create_quotation(w1);
  perform pg_temp.ok((select total from quotations where id = v_q) = 1854 and (select status from work_orders where id = w1) = 'quoted',
                     'cotización generada desde la orden (1500 + 354)');
  perform public.wo_set_status(w1, 'approved');
  perform pg_temp.expect_error(format('select public.wo_set_status(%L, ''received'')', w1), 'no permitido');

  perform public.wo_add_advance(jsonb_build_object('client_uid', gen_random_uuid(), 'order_id', w1, 'amount', 1000,
                                                   'method', 'cash', 'register_id', v_reg));
  perform pg_temp.ok((select sum(amount) from cash_movements where kind = 'advance') = 1000, 'el anticipo entra a caja');
  -- Nadie puede pagar con anticipos que no existen.
  perform pg_temp.expect_error(format(
    'select public.create_sale(''{"client_uid":"%s","register_id":"%s","items":[{"product_id":"%s","quantity":1}],"payments":[{"method":"advance","amount":354}]}'')',
    gen_random_uuid(), v_reg, p_filter), 'Un anticipo solo se aplica');
  perform pg_temp.expect_error(format(
    'select public.create_sale(''{"client_uid":"%s","register_id":"%s","work_order_id":"%s","items":[{"product_id":"%s","quantity":1}],"payments":[{"method":"advance","amount":354}]}'')',
    gen_random_uuid(), v_reg, w1, p_filter), 'no coincide');

  perform public.wo_set_status(w1, 'in_progress');
  r := public.wo_checkout(jsonb_build_object('order_id', w1, 'client_uid', gen_random_uuid(), 'register_id', v_reg,
       'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 854))));
  v_sale := (r ->> 'sale_id')::uuid;
  perform pg_temp.ok((r ->> 'total')::numeric = 1854 and (r ->> 'advance_applied')::numeric = 1000, 'facturada con anticipo aplicado');
  perform pg_temp.ok((select applied_sale_id from work_order_advances where order_id = w1) = v_sale, 'anticipo marcado como aplicado');
  perform pg_temp.ok((select sum(amount) from cash_movements where reference_id = v_sale) = 854,
                     'en caja solo entra el saldo: el anticipo no se cuenta dos veces');
  perform pg_temp.ok((select quantity from stock_levels where product_id = p_filter) = 4, 'el repuesto se descuenta al facturar');
  perform pg_temp.ok((select status from quotations where id = v_q) = 'converted', 'la cotización queda convertida');
  perform pg_temp.ok((select status from work_orders where id = w1) = 'done', 'orden terminada al facturar');
  perform pg_temp.expect_error(format('select public.wo_checkout(''{"order_id":"%s","client_uid":"%s","register_id":"%s","payments":[]}'')',
    w1, gen_random_uuid(), v_reg), 'ya se facturó');
  perform public.wo_set_status(w1, 'delivered');

  w2 := public.wo_save(jsonb_build_object('branch_id', v_branch, 'customer_id', v_cust, 'problem', 'Revisar aire'));
  perform public.wo_add_advance(jsonb_build_object('client_uid', gen_random_uuid(), 'order_id', w2, 'amount', 500,
                                                   'method', 'cash', 'register_id', v_reg));
  perform pg_temp.expect_error(format('select public.wo_set_status(%L, ''canceled'', ''x'')', w2), 'anticipos sin aplicar');
  perform public.wo_refund_advance(jsonb_build_object('advance_id', (select id from work_order_advances where order_id = w2),
                                                      'register_id', v_reg, 'reason', 'Cliente desistió'));
  perform pg_temp.expect_error(format('select public.wo_refund_advance(''{"advance_id":"%s","register_id":"%s","reason":"x"}'')',
    (select id from work_order_advances where order_id = w2), v_reg), 'ya fue devuelto');
  perform public.wo_set_status(w2, 'canceled', 'Cliente desistió');
  perform pg_temp.ok((select status from work_orders where id = w2) = 'canceled', 'devuelto el anticipo, la orden se cancela');

  -- ── Reporte de caja y purga completa con las tablas nuevas ──────────────
  r := public.cash_session_report((select id from cash_sessions where tenant_id = t));
  perform pg_temp.ok((r -> 'by_kind' ->> 'advance')::numeric = 1000, 'arqueo separa anticipos (1500 cobrados − 500 devueltos)');
  perform pg_temp.act_as(null);
  insert into platform_admins (user_id, note) values (ud, 'test');
  perform pg_temp.act_as(ud);
  r := public.admin_delete_tenant(t, 'La Fonda', false);
  perform pg_temp.ok((r -> 'counts' ->> 'tenants')::int = 1 and (r -> 'counts' ->> 'work_orders')::int = 2
                     and (r -> 'counts' ->> 'restaurant_order_items')::int >= 4, 'purga incluye restaurante y taller');

  raise exception 'FERDDO_TESTS_OK (% aserciones)', current_setting('ferddo_test.count', true);
end $$;
