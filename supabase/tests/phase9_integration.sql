-- ═══════════════════════════════════════════════════════════════════════════
-- Ferddo · Prueba de integración: productos compuestos y citas (0025–0026)
--
--   supabase db query --linked -f supabase/tests/phase9_integration.sql
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
  us uuid := gen_random_uuid();   -- vendedor (segundo profesional)
  uk uuid := gen_random_uuid();   -- cocina (sin permiso de citas)
  ud uuid := gen_random_uuid();   -- super-admin (purga)
  t uuid; v_branch uuid; v_reg uuid; v_t18 uuid; v_ex uuid; v_code text;
  p_flour uuid; p_cheese uuid; p_pizza uuid; p_combo uuid; p_consult uuid;
  r jsonb; v_sale uuid; v_item uuid; v_uid uuid;
  a1 uuid; a2 uuid; a3 uuid; v_day timestamptz := date_trunc('day', now()) + interval '1 day 10 hours';
begin
  -- ── Plan Negocio ─────────────────────────────────────────────────────────
  perform pg_temp.ok((select modules @> array['restaurant', 'workshop', 'appointments'] from plan_settings where plan = 'pro'),
                     'el plan Negocio incluye restaurante, taller y citas');

  insert into auth.users (id, email, aud, role) values
    (ua, ua || '@t.ferddo', 'authenticated', 'authenticated'), (us, us || '@t.ferddo', 'authenticated', 'authenticated'),
    (uk, uk || '@t.ferddo', 'authenticated', 'authenticated'), (ud, ud || '@t.ferddo', 'authenticated', 'authenticated');

  perform pg_temp.act_as(ua);
  t := public.setup_business('Pizzería y Consultas', 'other');
  perform pg_temp.ok((select plan from subscriptions where tenant_id = t) = 'pro', 'la prueba gratis es del plan Negocio');
  select id into v_branch from branches where tenant_id = t and is_main;
  select id into v_reg from cash_registers where tenant_id = t;
  select id into v_t18 from taxes where tenant_id = t and code = 'ITBIS18';
  select id into v_ex from taxes where tenant_id = t and code = 'EXENTO';
  perform public.open_cash_session(v_reg, 0);

  -- ── Productos compuestos ─────────────────────────────────────────────────
  insert into products (tenant_id, name, price, cost, tax_id) values (t, 'Harina (lb)', 50, 40, v_t18) returning id into p_flour;
  insert into products (tenant_id, name, price, cost, tax_id) values (t, 'Queso (lb)', 150, 100, v_t18) returning id into p_cheese;
  insert into products (tenant_id, name, price, tax_id) values (t, 'Pizza', 300, v_t18) returning id into p_pizza;
  insert into products (tenant_id, name, price, tax_id) values (t, 'Combo', 500, v_t18) returning id into p_combo;
  insert into products (tenant_id, kind, name, price, tax_id, track_stock, duration_minutes)
  values (t, 'service', 'Consulta', 1000, v_ex, false, 45) returning id into p_consult;
  perform public.inventory_adjust(v_branch, jsonb_build_array(
    jsonb_build_object('product_id', p_flour, 'quantity', 10),
    jsonb_build_object('product_id', p_cheese, 'quantity', 10)), 'Inicial', true);

  perform public.save_product_components(p_pizza, jsonb_build_array(
    jsonb_build_object('component_id', p_flour, 'quantity', 0.5),
    jsonb_build_object('component_id', p_cheese, 'quantity', 0.25)));
  perform pg_temp.ok((select not track_stock and cost = 45 from products where id = p_pizza),
                     'el compuesto deja de llevar existencia y su costo es la suma de componentes (0.5×40 + 0.25×100)');
  perform pg_temp.expect_error(format('select public.save_product_components(%L, ''[{"component_id":"%s","quantity":1}]'')',
    p_combo, p_pizza), 'ya es compuesto');
  perform pg_temp.expect_error(format('select public.save_product_components(%L, ''[{"component_id":"%s","quantity":1}]'')',
    p_combo, p_consult), 'no controla existencia');
  perform pg_temp.expect_error(format('select public.save_product_components(%L, ''[{"component_id":"%s","quantity":1}]'')',
    p_flour, p_cheese), 'ya es componente');
  insert into products (tenant_id, name, price, tax_id) values (t, 'Refresco', 60, v_t18) returning id into v_item;
  perform public.inventory_adjust(v_branch, jsonb_build_array(jsonb_build_object('product_id', v_item, 'quantity', 5)), 'Inicial', true);
  perform pg_temp.expect_error(format('select public.save_product_components(%L, ''[{"component_id":"%s","quantity":1}]'')',
    v_item, p_cheese), 'puedes cambiar el control');
  perform pg_temp.expect_error(format('select public.save_product_components(%L, ''[{"component_id":"%s","quantity":0}]'')',
    p_combo, p_flour), 'mayor que cero');
  perform pg_temp.expect_error(format('insert into product_components (tenant_id, product_id, component_id, quantity) values (%L, %L, %L, 1)',
    t, p_combo, p_flour), 'permission denied');

  -- Venta de 4 pizzas: salen 2 lb de harina y 1 lb de queso.
  r := public.create_sale(jsonb_build_object('client_uid', gen_random_uuid(), 'register_id', v_reg,
    'items', jsonb_build_array(jsonb_build_object('product_id', p_pizza, 'quantity', 4)),
    'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 1200))));
  v_sale := (r ->> 'sale_id')::uuid;
  perform pg_temp.ok((r ->> 'total')::numeric = 1200, 'venta de 4 pizzas = 1200');
  perform pg_temp.ok((select quantity from stock_levels where product_id = p_flour) = 8
                     and (select quantity from stock_levels where product_id = p_cheese) = 9, 'la venta descuenta los componentes');
  perform pg_temp.ok(not exists (select 1 from stock_levels where product_id = p_pizza and quantity <> 0), 'el compuesto no tiene existencia');
  select id into v_item from sale_items where sale_id = v_sale;
  perform pg_temp.ok((select unit_cost from sale_items where id = v_item) = 45, 'costo de la línea = receta');

  -- La receta cambia DESPUÉS: la devolución repone lo que salió de verdad.
  perform public.save_product_components(p_pizza, jsonb_build_array(jsonb_build_object('component_id', p_flour, 'quantity', 1)));
  perform pg_temp.ok((select count(*) from product_components where product_id = p_pizza) = 1, 'guardar reemplaza la receta');
  perform public.return_sale(jsonb_build_object('client_uid', gen_random_uuid(), 'sale_id', v_sale, 'register_id', v_reg,
    'refund_method', 'cash', 'reason', 'Fría', 'items', jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity', 2))));
  perform pg_temp.ok((select quantity from stock_levels where product_id = p_flour) = 9
                     and (select quantity from stock_levels where product_id = p_cheese) = 9.5,
                     'devolver 2 de 4 repone la mitad de lo que salió (receta original)');
  perform public.return_sale(jsonb_build_object('client_uid', gen_random_uuid(), 'sale_id', v_sale, 'register_id', v_reg,
    'refund_method', 'cash', 'reason', 'Merma', 'restock', false,
    'items', jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity', 1))));
  perform pg_temp.ok((select quantity from stock_levels where product_id = p_flour) = 9, 'devolución sin reingreso no repone');

  -- Anular una venta de compuesto revierte los componentes.
  r := public.create_sale(jsonb_build_object('client_uid', gen_random_uuid(), 'register_id', v_reg,
    'items', jsonb_build_array(jsonb_build_object('product_id', p_pizza, 'quantity', 3)),
    'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 900))));
  perform pg_temp.ok((select quantity from stock_levels where product_id = p_flour) = 6, 'nueva receta: 3 × 1 lb');
  perform public.void_sale((r ->> 'sale_id')::uuid, 'Error');
  perform pg_temp.ok((select quantity from stock_levels where product_id = p_flour) = 9, 'la anulación devuelve los componentes');

  -- ── Citas ────────────────────────────────────────────────────────────────
  perform pg_temp.expect_error(format('select public.appt_save(''{"branch_id":"%s","starts_at":"%s","contact_name":"x","title":"x"}'')',
    v_branch, v_day), 'PLAN_LIMIT_MODULE');
  perform pg_temp.act_as(null);
  update tenants set modules = array_append(modules, 'appointments') where id = t;
  perform pg_temp.act_as(ua);
  v_code := public.create_invite('seller');
  perform pg_temp.act_as(us); perform public.accept_invite(v_code);
  perform pg_temp.act_as(ua); v_code := public.create_invite('kitchen');
  perform pg_temp.act_as(uk); perform public.accept_invite(v_code);
  perform pg_temp.expect_error(format('select public.appt_save(''{"branch_id":"%s","starts_at":"%s","contact_name":"x","title":"x"}'')',
    v_branch, v_day), 'FORBIDDEN');

  perform pg_temp.act_as(ua);
  a1 := public.appt_save(jsonb_build_object('branch_id', v_branch, 'staff_id', ua, 'service_id', p_consult,
                                            'starts_at', v_day, 'contact_name', 'Ana Pérez', 'contact_phone', '8095551234'));
  perform pg_temp.ok((select ends_at - starts_at = interval '45 minutes' and title = 'Consulta' from appointments where id = a1),
                     'fin y título salen del servicio');
  perform pg_temp.expect_error(format('select public.appt_save(''{"branch_id":"%s","staff_id":"%s","starts_at":"%s","contact_name":"Luis","title":"Control"}'')',
    v_branch, ua, v_day + interval '30 minutes'), 'APPOINTMENT_OVERLAP');
  perform pg_temp.expect_error(format('select public.appt_save(''{"branch_id":"%s","starts_at":"%s","title":"Control"}'')',
    v_branch, v_day), 'Revisa la cita');
  perform pg_temp.expect_error(format('select public.appt_save(''{"branch_id":"%s","starts_at":"%s","ends_at":"%s","contact_name":"x","title":"x"}'')',
    v_branch, v_day, v_day - interval '1 hour'), 'Revisa la cita');

  perform pg_temp.act_as(us);
  a2 := public.appt_save(jsonb_build_object('branch_id', v_branch, 'staff_id', us, 'service_id', p_consult,
                                            'starts_at', v_day + interval '30 minutes', 'contact_name', 'Luis'));
  perform pg_temp.ok(a2 is not null, 'otro profesional sí puede a la misma hora');

  perform pg_temp.act_as(ua);
  perform pg_temp.expect_error(format('select public.appt_set_status(%L, ''canceled'')', a1), 'motivo');
  perform public.appt_set_status(a1, 'canceled', 'Paciente llamó');
  a3 := public.appt_save(jsonb_build_object('branch_id', v_branch, 'staff_id', ua, 'service_id', p_consult,
                                            'starts_at', v_day + interval '30 minutes', 'contact_name', 'Luis'));
  perform pg_temp.ok(a3 is not null, 'una cita cancelada libera el horario');
  perform pg_temp.expect_error(format('select public.appt_save(''{"id":"%s","branch_id":"%s","starts_at":"%s","contact_name":"x","title":"x"}'')',
    a1, v_branch, v_day), 'ya está cerrada');

  perform public.appt_set_status(a2, 'confirmed');
  perform public.appt_set_status(a2, 'in_progress');
  perform pg_temp.expect_error(format('select public.appt_set_status(%L, ''confirmed'')', a2), 'estado anterior');
  perform pg_temp.expect_error(format('select public.appt_set_status(%L, ''no_show'')', a2), 'ya empezó');

  v_uid := gen_random_uuid();
  r := public.appt_checkout(jsonb_build_object('appointment_id', a2, 'client_uid', v_uid, 'register_id', v_reg,
    'payments', jsonb_build_array(jsonb_build_object('method', 'card', 'amount', 1000))));
  perform pg_temp.ok((r ->> 'total')::numeric = 1000, 'cobro de la consulta = 1000 (exenta)');
  perform pg_temp.ok((select status = 'done' and sale_id = (r ->> 'sale_id')::uuid from appointments where id = a2),
                     'la cita cobrada queda atendida y enlazada a la venta');
  perform pg_temp.ok((select seller_id from sales where id = (r ->> 'sale_id')::uuid) = us, 'la venta se atribuye al profesional');
  r := public.appt_checkout(jsonb_build_object('appointment_id', a2, 'client_uid', v_uid, 'register_id', v_reg, 'payments', '[]'::jsonb));
  perform pg_temp.ok((r ->> 'replayed')::boolean, 'reintento con el mismo client_uid no cobra dos veces');
  perform pg_temp.expect_error(format('select public.appt_checkout(''{"appointment_id":"%s","client_uid":"%s","register_id":"%s","payments":[]}'')',
    a2, gen_random_uuid(), v_reg), 'ya se cobró');
  perform pg_temp.expect_error(format('select public.appt_checkout(''{"appointment_id":"%s","client_uid":"%s","register_id":"%s","payments":[]}'')',
    a1, gen_random_uuid(), v_reg), 'cerrada sin atención');

  -- ── Purga con las tablas nuevas ──────────────────────────────────────────
  perform pg_temp.act_as(null);
  insert into platform_admins (user_id, note) values (ud, 'test');
  perform pg_temp.act_as(ud);
  r := public.admin_delete_tenant(t, 'Pizzería y Consultas', false);
  perform pg_temp.ok((r -> 'counts' ->> 'appointments')::int = 3 and (r -> 'counts' ->> 'product_components')::int = 1,
                     'la purga incluye citas y componentes');

  raise exception 'FERDDO_TESTS_OK (% aserciones)', current_setting('ferddo_test.count', true);
end $$;
