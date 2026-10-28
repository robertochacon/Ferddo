-- ═══════════════════════════════════════════════════════════════════════════
-- Ferddo · Prueba de integración del núcleo ERP/POS
--
-- Recorre los flujos críticos contra una base real (aislamiento entre
-- empresas, permisos, ventas idempotentes, inventario, caja, crédito,
-- devoluciones, e-CF, compras, cotizaciones, límites de plan, purga).
--
-- NO deja rastro: todo ocurre dentro de un bloque DO que termina lanzando
-- 'FERDDO_TESTS_OK', lo que revierte la transacción completa (usuarios de
-- prueba incluidos). Si algo falla, el error dice qué aserción rompió.
--
--   supabase db query --linked -f supabase/tests/erp_integration.sql
--
-- Resultado esperado: ERROR … FERDDO_TESTS_OK (n aserciones)
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

-- Ejecuta p_sql y exige que falle con un mensaje que contenga p_pattern.
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
  ua uuid := gen_random_uuid();  -- dueño empresa A
  ub uuid := gen_random_uuid();  -- dueño empresa B
  uc uuid := gen_random_uuid();  -- cajero invitado a A
  ud uuid := gen_random_uuid();  -- super-admin
  ta uuid; tb uuid;
  v_branch uuid; v_reg uuid; v_sess uuid; v_tax18 uuid; v_exento uuid;
  p1 uuid; p2 uuid; v_cust uuid; v_cust_rnc uuid; v_sup uuid; v_pur uuid; v_q uuid;
  r jsonb; r2 jsonb; v_sale uuid; v_sale2 uuid; v_sale3 uuid; v_item uuid;
  v_code text; v_num numeric; v_n int; v_txt text;
  cu1 uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  values (ua, ua || '@test.ferddo', '{"full_name":"Ana Dueña"}', 'authenticated', 'authenticated'),
         (ub, ub || '@test.ferddo', '{"full_name":"Beto Dueño"}', 'authenticated', 'authenticated'),
         (uc, uc || '@test.ferddo', '{"full_name":"Carla Cajera"}', 'authenticated', 'authenticated'),
         (ud, ud || '@test.ferddo', '{"full_name":"Soporte"}', 'authenticated', 'authenticated');

  -- ── Alta de empresas ─────────────────────────────────────────────────────
  perform pg_temp.act_as(ua);
  ta := public.setup_business('Colmado Ana', 'colmado', 'Ana Dueña', '8095550000', '131234567');
  perform pg_temp.ok(public.auth_tenant_id() = ta, 'A queda con su empresa activa');
  perform pg_temp.ok(public.setup_business('Otro', 'colmado') = ta, 'setup_business es idempotente para el primer negocio');
  select id into v_branch from branches where tenant_id = ta and is_main;
  select id into v_reg from cash_registers where tenant_id = ta;
  select id into v_tax18 from taxes where tenant_id = ta and code = 'ITBIS18';
  select id into v_exento from taxes where tenant_id = ta and code = 'EXENTO';
  perform pg_temp.ok(v_branch is not null and v_reg is not null and v_tax18 is not null, 'siembra: sucursal, caja e ITBIS');
  perform pg_temp.ok((select count(*) from fiscal_settings where tenant_id = ta) = 1, 'siembra: configuración fiscal');
  perform pg_temp.ok(public.has_perm('fiscal.manage'), 'el dueño tiene todos los permisos');
  perform pg_temp.ok(public.tenant_has_module('pos') and not public.tenant_has_module('restaurant'), 'módulos por tipo de negocio');

  perform pg_temp.act_as(ub);
  tb := public.setup_business('Ferretería Beto', 'hardware');
  perform pg_temp.ok(tb <> ta, 'B tiene su propia empresa');

  -- ── Catálogo e inventario ────────────────────────────────────────────────
  perform pg_temp.act_as(ua);
  insert into products (tenant_id, name, sku, barcode, price, cost, tax_id, min_stock)
  values (ta, 'Arroz 5 lb', 'ARR5', '7460000000011', 118, 70, v_tax18, 5) returning id into p1;
  insert into products (tenant_id, kind, name, price, tax_id, track_stock)
  values (ta, 'service', 'Entrega a domicilio', 500, v_exento, false) returning id into p2;
  perform public.inventory_adjust(v_branch, jsonb_build_array(jsonb_build_object('product_id', p1, 'quantity', 10)), 'Inicial', true);
  perform pg_temp.ok((select quantity from stock_levels where product_id = p1) = 10, 'existencia inicial 10');
  perform pg_temp.expect_error(format('update stock_levels set quantity = 999 where product_id = %L', p1), 'permission denied');
  perform pg_temp.expect_error(format('delete from inventory_movements where product_id = %L', p1), 'permission denied');
  perform pg_temp.expect_error(format(
    'select public.inventory_adjust(%L, ''[{"product_id":"%s","quantity":1}]'', ''x'')', v_branch, p2), 'no lleva control de inventario');

  -- ── Aislamiento entre empresas ───────────────────────────────────────────
  perform pg_temp.act_as(ub);
  perform pg_temp.ok((select count(*) from products where tenant_id = ta) = 0, 'B no ve productos de A');
  perform pg_temp.ok((select count(*) from stock_levels where tenant_id = ta) = 0, 'B no ve existencias de A');
  update products set price = 1 where id = p1;
  get diagnostics v_n = row_count;
  perform pg_temp.ok(v_n = 0, 'B no puede modificar productos de A');
  perform pg_temp.expect_error(format('insert into products (tenant_id, name) values (%L, ''intruso'')', ta), 'row-level security');
  perform pg_temp.expect_error(format(
    'select public.create_sale(''{"client_uid":"%s","register_id":"%s","items":[{"product_id":"%s","quantity":1}],"payments":[{"method":"cash","amount":200}]}'')',
    gen_random_uuid(), v_reg, p1), 'Selecciona una caja válida');
  perform pg_temp.expect_error(format('select public.switch_tenant(%L)', ta), 'No perteneces');
  perform pg_temp.expect_error(format('update profiles set tenant_id = %L where id = %L', ta, ub), 'No perteneces');

  -- ── Caja y venta ─────────────────────────────────────────────────────────
  perform pg_temp.act_as(ua);
  perform pg_temp.expect_error(format(
    'select public.create_sale(''{"client_uid":"%s","register_id":"%s","items":[{"product_id":"%s","quantity":1}],"payments":[{"method":"cash","amount":200}]}'')',
    gen_random_uuid(), v_reg, p1), 'CASH_SESSION_REQUIRED');
  v_sess := public.open_cash_session(v_reg, 1000);
  perform pg_temp.expect_error(format('select public.open_cash_session(%L, 0)', v_reg), 'ya está abierta');

  r := public.create_sale(jsonb_build_object(
    'client_uid', cu1, 'register_id', v_reg,
    'items', jsonb_build_array(jsonb_build_object('product_id', p1, 'quantity', 2),
                               jsonb_build_object('product_id', p2, 'quantity', 1)),
    'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 1000))));
  v_sale := (r ->> 'sale_id')::uuid;
  perform pg_temp.ok((r ->> 'total')::numeric = 736, 'total 2×118 + 500 = 736');
  perform pg_temp.ok((r ->> 'change_due')::numeric = 264, 'devuelta 264');
  perform pg_temp.ok((select tax_total from sales where id = v_sale) = 36, 'ITBIS incluido: 236 − 236/1.18 = 36');
  perform pg_temp.ok((select quantity from stock_levels where product_id = p1) = 8, 'la venta descuenta inventario');
  perform pg_temp.ok((select sum(amount) from cash_movements where reference_id = v_sale) = 736, 'caja registra lo aplicado, no lo entregado');

  r2 := public.create_sale(jsonb_build_object(
    'client_uid', cu1, 'register_id', v_reg,
    'items', jsonb_build_array(jsonb_build_object('product_id', p1, 'quantity', 5)),
    'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 1000))));
  perform pg_temp.ok((r2 ->> 'replayed')::boolean and (r2 ->> 'sale_id')::uuid = v_sale, 'reintento idempotente devuelve la misma venta');
  perform pg_temp.ok((select quantity from stock_levels where product_id = p1) = 8, 'el reintento no descuenta dos veces');

  perform pg_temp.expect_error(format(
    'select public.create_sale(''{"client_uid":"%s","register_id":"%s","items":[{"product_id":"%s","quantity":1}],"payments":[{"method":"card","amount":200}]}'')',
    gen_random_uuid(), v_reg, p1), 'no puede superar el total');
  perform pg_temp.expect_error(format(
    'select public.create_sale(''{"client_uid":"%s","register_id":"%s","items":[{"product_id":"%s","quantity":1}],"payments":[{"method":"cash","amount":100}]}'')',
    gen_random_uuid(), v_reg, p1), 'no cubre el total');

  -- Pago mixto con descuento global
  r := public.create_sale(jsonb_build_object(
    'client_uid', gen_random_uuid(), 'register_id', v_reg, 'global_discount', 18,
    'items', jsonb_build_array(jsonb_build_object('product_id', p1, 'quantity', 1)),
    'payments', jsonb_build_array(jsonb_build_object('method', 'card', 'amount', 50),
                                  jsonb_build_object('method', 'cash', 'amount', 100))));
  perform pg_temp.ok((r ->> 'total')::numeric = 100 and (r ->> 'change_due')::numeric = 50, 'mixto: 118−18 = 100, tarjeta 50 + efectivo 100 → devuelta 50');
  v_sale3 := (r ->> 'sale_id')::uuid;

  -- ── Crédito y cobros ─────────────────────────────────────────────────────
  insert into customers (tenant_id, name, credit_limit) values (ta, 'Doña Rosa', 500) returning id into v_cust;
  r := public.create_sale(jsonb_build_object(
    'client_uid', gen_random_uuid(), 'register_id', v_reg, 'customer_id', v_cust,
    'items', jsonb_build_array(jsonb_build_object('product_id', p1, 'quantity', 1)),
    'payments', jsonb_build_array(jsonb_build_object('method', 'credit', 'amount', 118))));
  v_sale2 := (r ->> 'sale_id')::uuid;
  perform pg_temp.ok((select balance from customer_balances where customer_id = v_cust) = 118, 'saldo del cliente 118');
  perform pg_temp.expect_error(format(
    'select public.create_sale(''{"client_uid":"%s","register_id":"%s","customer_id":"%s","items":[{"product_id":"%s","quantity":4}],"payments":[{"method":"credit","amount":472}]}'')',
    gen_random_uuid(), v_reg, v_cust, p1), 'CREDIT_LIMIT');
  perform public.receive_customer_payment(jsonb_build_object(
    'client_uid', gen_random_uuid(), 'customer_id', v_cust, 'amount', 50, 'method', 'cash', 'register_id', v_reg));
  perform pg_temp.ok((select balance from customer_balances where customer_id = v_cust) = 68, 'abono parcial deja 68');
  perform pg_temp.ok(public.reconcile_receivables() = '[]'::jsonb, 'caché de abonos cuadra con los abonos');
  perform pg_temp.expect_error(format('select public.void_sale(%L, ''error'')', v_sale2), 'ya tiene abonos');

  -- ── Devolución y anulación ───────────────────────────────────────────────
  select id into v_item from sale_items where sale_id = v_sale and product_id = p1;
  r := public.return_sale(jsonb_build_object(
    'client_uid', gen_random_uuid(), 'sale_id', v_sale, 'register_id', v_reg, 'refund_method', 'cash',
    'reason', 'Dañado', 'items', jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity', 1))));
  perform pg_temp.ok((r ->> 'total')::numeric = 118, 'devolución de 1 unidad = 118');
  perform pg_temp.ok((select status from sales where id = v_sale) = 'partially_returned', 'venta parcialmente devuelta');
  perform pg_temp.expect_error(format(
    'select public.return_sale(''{"client_uid":"%s","sale_id":"%s","register_id":"%s","refund_method":"cash","reason":"x","items":[{"sale_item_id":"%s","quantity":2}]}'')',
    gen_random_uuid(), v_sale, v_reg, v_item), 'solo quedan');

  perform public.void_sale(v_sale3, 'Cliente se arrepintió');
  perform pg_temp.ok((select status from sales where id = v_sale3) = 'voided', 'venta anulada');
  -- 10 − 2 − 1 (mixta) − 1 (crédito) + 1 (devolución) + 1 (anulación) = 8
  perform pg_temp.ok((select quantity from stock_levels where product_id = p1) = 8, 'existencia tras devolución y anulación');
  perform pg_temp.ok(
    (select quantity from stock_levels where product_id = p1)
    = (select sum(quantity) from inventory_movements where product_id = p1), 'existencia = suma del kardex');

  -- ── Empleados y permisos ─────────────────────────────────────────────────
  v_code := public.create_invite('cashier');
  perform pg_temp.act_as(uc);
  perform pg_temp.ok(public.accept_invite(v_code) = ta, 'cajera entra a la empresa A');
  perform pg_temp.ok(public.auth_member_role() = 'cashier', 'rol cajera');
  perform pg_temp.ok(public.has_perm('sales.create') and not public.has_perm('prices.manage'), 'permisos de cajera');
  -- Sin products.manage la RLS no le deja ver la fila para actualizarla: 0 filas.
  update products set price = 1 where id = p1;
  get diagnostics v_n = row_count;
  perform pg_temp.ok(v_n = 0 and (select price from products where id = p1) = 118, 'la cajera no cambia precios');
  perform pg_temp.expect_error(format(
    'select public.inventory_adjust(%L, ''[{"product_id":"%s","quantity":-3}]'', ''robo'')', v_branch, p1), 'FORBIDDEN');
  perform pg_temp.expect_error(format(
    'select public.create_sale(''{"client_uid":"%s","register_id":"%s","items":[{"product_id":"%s","quantity":1,"unit_price":1}],"payments":[{"method":"cash","amount":1}]}'')',
    gen_random_uuid(), v_reg, p1), 'FORBIDDEN');
  perform pg_temp.ok((select count(*) from audit_logs) = 0, 'la cajera no lee la bitácora');
  perform pg_temp.expect_error(format('select public.void_sale(%L, ''x'')', v_sale), 'FORBIDDEN');

  -- Multiempresa: B entra también a A como vendedor y alterna.
  perform pg_temp.act_as(ua);
  v_code := public.create_invite('seller');
  perform pg_temp.act_as(ub);
  perform public.accept_invite(v_code);
  perform pg_temp.ok(public.auth_tenant_id() = ta and public.auth_member_role() = 'seller', 'B activo en A como vendedor');
  perform pg_temp.ok(jsonb_array_length(public.my_tenants()) = 2, 'B ve sus dos empresas');
  perform public.switch_tenant(tb);
  perform pg_temp.ok(public.auth_tenant_id() = tb and public.auth_is_owner(), 'B vuelve a su empresa como dueño');
  perform pg_temp.act_as(ua);
  perform public.set_member_active(ub, false);
  perform pg_temp.act_as(ub);
  perform pg_temp.expect_error(format('select public.switch_tenant(%L)', ta), 'No perteneces');

  -- ── Facturación electrónica ──────────────────────────────────────────────
  perform pg_temp.act_as(ua);
  perform pg_temp.expect_error(format(
    'select public.create_sale(''{"client_uid":"%s","register_id":"%s","ecf_type":"32","items":[{"product_id":"%s","quantity":1}],"payments":[{"method":"cash","amount":118}]}'')',
    gen_random_uuid(), v_reg, p1), 'ECF_DISABLED');
  perform public.save_fiscal_settings('{"ecf_enabled": true, "fiscal_address": "Calle 1, Santo Domingo", "legal_name": "Ana SRL"}');
  perform pg_temp.expect_error('select public.save_fiscal_settings(''{"environment":"production"}'')', 'simulador');
  perform public.add_fiscal_sequence('32', 1, 100);
  perform pg_temp.expect_error('select public.add_fiscal_sequence(''32'', 50, 150)', 'solapa');
  r := public.create_sale(jsonb_build_object(
    'client_uid', gen_random_uuid(), 'register_id', v_reg, 'ecf_type', '32',
    'items', jsonb_build_array(jsonb_build_object('product_id', p1, 'quantity', 1)),
    'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 118))));
  perform pg_temp.ok(r -> 'ecf' ->> 'encf' = 'E320000000001', 'e-NCF E32 + 10 dígitos');
  perform pg_temp.ok((select status from electronic_invoices where encf = 'E320000000001' and tenant_id = ta) = 'pending',
                     'el e-CF nace pendiente: venta guardada ≠ factura aceptada');
  perform pg_temp.expect_error(format(
    'select public.create_sale(''{"client_uid":"%s","register_id":"%s","ecf_type":"31","items":[{"product_id":"%s","quantity":1}],"payments":[{"method":"cash","amount":118}]}'')',
    gen_random_uuid(), v_reg, p1), 'ECF_BUYER');
  -- Devolución de una venta con e-CF: exige nota de crédito y su secuencia.
  v_sale := (r ->> 'sale_id')::uuid;
  select id into v_item from sale_items where sale_id = v_sale;
  perform pg_temp.expect_error(format('select public.void_sale(%L, ''x'')', v_sale), 'comprobante fiscal');
  perform pg_temp.expect_error(format(
    'select public.return_sale(''{"client_uid":"%s","sale_id":"%s","register_id":"%s","refund_method":"cash","reason":"x","items":[{"sale_item_id":"%s","quantity":1}]}'')',
    gen_random_uuid(), v_sale, v_reg, v_item), 'ECF_SEQUENCE');
  perform public.add_fiscal_sequence('34', 1, 100);
  r := public.return_sale(jsonb_build_object(
    'client_uid', gen_random_uuid(), 'sale_id', v_sale, 'register_id', v_reg, 'refund_method', 'cash',
    'reason', 'Devuelto', 'items', jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity', 1))));
  perform pg_temp.ok(r -> 'ecf' ->> 'encf' = 'E340000000001', 'nota de crédito E34');
  perform pg_temp.ok((select reference_encf from electronic_invoices where encf = 'E340000000001' and tenant_id = ta) = 'E320000000001',
                     'la nota de crédito referencia el e-CF original');
  -- La cola del procesador es solo para service_role.
  perform pg_temp.expect_error('select public.ecf_claim(null, 5)', 'permission denied');
  perform pg_temp.act_as(null);
  r := public.ecf_claim(ta, 10);
  perform pg_temp.ok(jsonb_array_length(r) = 2, 'el procesador reclama los 2 pendientes');
  perform pg_temp.ok(jsonb_array_length(public.ecf_claim(ta, 10)) = 0, 'un documento reclamado no se reclama dos veces');
  select id into v_sale from electronic_invoices where encf = 'E320000000001' and tenant_id = ta;
  perform public.ecf_record_result(v_sale, '{"status":"accepted","track_id":"T1","security_code":"ABC123"}');
  perform public.ecf_record_result(v_sale, '{"status":"rejected"}');
  perform pg_temp.ok((select status from electronic_invoices where id = v_sale) = 'accepted', 'un veredicto final no se pisa');
  perform pg_temp.ok((select count(*) from electronic_invoice_events where invoice_id = v_sale) >= 2, 'bitácora fiscal');

  -- ── Compras y cuentas por pagar ──────────────────────────────────────────
  perform pg_temp.act_as(ua);
  insert into suppliers (tenant_id, name, rnc, payment_terms_days) values (ta, 'Distribuidora X', '101000001', 30) returning id into v_sup;
  v_pur := public.save_purchase(jsonb_build_object('branch_id', v_branch, 'supplier_id', v_sup,
           'items', jsonb_build_array(jsonb_build_object('product_id', p1, 'quantity', 8, 'unit_cost', 80))));
  perform pg_temp.ok((select total from purchases where id = v_pur) = 755.20, 'compra 8×80 + ITBIS = 755.20');
  v_num := (select quantity from stock_levels where product_id = p1);
  perform public.receive_purchase(v_pur);
  perform pg_temp.ok((select quantity from stock_levels where product_id = p1) = v_num + 8, 'la recepción suma inventario');
  perform pg_temp.ok((select cost from products where id = p1) = round((v_num * 70 + 8 * 80) / (v_num + 8), 4), 'costo promedio ponderado');
  perform pg_temp.expect_error(format('select public.receive_purchase(%L)', v_pur), 'ya fue recibida');
  perform public.pay_payables(jsonb_build_object('client_uid', gen_random_uuid(), 'supplier_id', v_sup,
                                                 'amount', 755.20, 'method', 'transfer'));
  perform pg_temp.ok((select status from payables where source_id = v_pur) = 'paid', 'cuenta por pagar saldada');

  -- ── Cotización → venta ───────────────────────────────────────────────────
  -- El colmado no trae cotizaciones por defecto: el dueño activa el módulo.
  update tenants set modules = modules || array['quotations'] where id = ta;
  v_q := public.save_quotation(jsonb_build_object('branch_id', v_branch,
         'items', jsonb_build_array(jsonb_build_object('product_id', p1, 'quantity', 3))));
  perform pg_temp.ok((select total from quotations where id = v_q) = 354, 'cotización 3×118');
  r := public.create_sale(jsonb_build_object(
    'client_uid', gen_random_uuid(), 'register_id', v_reg, 'quotation_id', v_q,
    'items', jsonb_build_array(jsonb_build_object('product_id', p1, 'quantity', 3)),
    'payments', jsonb_build_array(jsonb_build_object('method', 'transfer', 'amount', 354))));
  perform pg_temp.ok((select status from quotations where id = v_q) = 'converted', 'cotización convertida');
  perform pg_temp.expect_error(format(
    'select public.create_sale(''{"client_uid":"%s","register_id":"%s","quotation_id":"%s","items":[{"product_id":"%s","quantity":3}],"payments":[{"method":"transfer","amount":354}]}'')',
    gen_random_uuid(), v_reg, v_q, p1), 'ya fue convertida');

  -- ── Gastos ───────────────────────────────────────────────────────────────
  perform public.create_expense(jsonb_build_object('client_uid', gen_random_uuid(), 'branch_id', v_branch,
    'category_id', (select id from expense_categories where tenant_id = ta and name = 'Electricidad'),
    'description', 'Factura luz', 'amount', 2500, 'paid', true, 'method', 'cash', 'register_id', v_reg));

  -- Gasto a crédito: al saldar su cuenta por pagar el gasto pasa a pagado.
  v_sale := public.create_expense(jsonb_build_object('client_uid', gen_random_uuid(), 'branch_id', v_branch,
    'category_id', (select id from expense_categories where tenant_id = ta and name = 'Internet y teléfono'),
    'description', 'Internet octubre', 'amount', 1500, 'paid', false));
  perform pg_temp.ok((select status from expenses where id = v_sale) = 'pending', 'gasto por pagar');
  perform public.pay_payables(jsonb_build_object('client_uid', gen_random_uuid(),
    'payable_id', (select payable_id from expenses where id = v_sale), 'amount', 1500, 'method', 'transfer'));
  perform pg_temp.ok((select status from expenses where id = v_sale) = 'paid', 'pagar la cuenta salda el gasto');

  -- ── Cierre de caja ───────────────────────────────────────────────────────
  -- 1000 + 736 + 100(mixta efectivo) − 100(anulada) + 50(abono) − 118(devolución)
  -- + 118(venta e-CF) − 118(devolución e-CF) − 2500(gasto) = −832
  r := public.close_cash_session(v_sess, 0);
  perform pg_temp.ok((r ->> 'expected_cash')::numeric = -832, 'esperado de caja = ' || (r ->> 'expected_cash'));
  perform pg_temp.ok((select difference from cash_sessions where id = v_sess) = 832, 'diferencia del arqueo');

  -- ── Tablero y reportes ───────────────────────────────────────────────────
  r := public.dashboard_summary();
  perform pg_temp.ok((r ->> 'count_today')::int = 4, 'ventas no anuladas de hoy (4: anulada fuera): ' || (r ->> 'count_today'));
  perform pg_temp.ok(jsonb_array_length(public.report_sales(current_date - 1, current_date + 1, 'product')) >= 1, 'reporte por producto');
  r := public.report_taxes(current_date - 1, current_date + 1);
  perform pg_temp.ok((r ->> 'itbis_purchases')::numeric = 115.20, 'ITBIS pagado en compras');

  -- ── Límites de plan y suscripción ────────────────────────────────────────
  perform pg_temp.act_as(null);
  update subscriptions set plan = 'basic' where tenant_id = ta;
  perform pg_temp.act_as(ua);
  perform pg_temp.expect_error(format('insert into branches (tenant_id, name) values (%L, ''Sucursal 2'')', ta), 'PLAN_LIMIT_BRANCHES');
  perform pg_temp.expect_error('select public.save_quotation(''{}'')', 'PLAN_LIMIT_MODULE');
  perform pg_temp.act_as(null);
  update subscriptions set status = 'canceled' where tenant_id = ta;
  perform pg_temp.act_as(ua);
  perform pg_temp.expect_error(format('select public.open_cash_session(%L, 0)', v_reg), 'SUBSCRIPTION_EXPIRED');
  perform pg_temp.ok((select count(*) from sales where tenant_id = ta) > 0, 'vencida la suscripción los datos siguen legibles');
  perform pg_temp.ok((select count(*) from subscription_events where tenant_id = ta) >= 3, 'historial de suscripción');

  -- ── Super-admin: agregados, sin datos comerciales; purga completa ───────
  perform pg_temp.act_as(null);
  insert into platform_admins (user_id, note) values (ud, 'test');
  perform pg_temp.act_as(ud);
  perform pg_temp.ok((public.admin_overview() ->> 'tenants')::int >= 2, 'overview global');
  perform pg_temp.ok((select count(*) from sales) = 0, 'el super-admin no lee ventas de los negocios');
  perform pg_temp.ok((select count(*) from customers) = 0, 'el super-admin no lee clientes');
  r := public.admin_delete_tenant(ta, 'Colmado Ana', false);
  perform pg_temp.ok((r -> 'counts' ->> 'tenants')::int = 1, 'purga de la empresa A con todo su ERP');
  perform pg_temp.act_as(null);
  perform pg_temp.ok((select tenant_id from profiles where id = uc) is null, 'la cajera queda sin empresa activa');
  perform pg_temp.ok((select tenant_id from profiles where id = ub) = tb, 'B conserva su otra empresa');

  raise exception 'FERDDO_TESTS_OK (% aserciones)', current_setting('ferddo_test.count', true);
end $$;
