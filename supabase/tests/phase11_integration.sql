-- ═══════════════════════════════════════════════════════════════════════════
-- Ferddo · Prueba de integración: catálogo de proveedores de e-CF y cambio de
-- proveedor (0031)
--
--   supabase db query --linked -f supabase/tests/phase11_integration.sql
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
  ua uuid := gen_random_uuid();   -- dueño del negocio en pruebas
  ub uuid := gen_random_uuid();   -- dueño del negocio en producción
  ud uuid := gen_random_uuid();   -- super-admin
  t uuid; t2 uuid; r jsonb;
  acme constant jsonb := '{"code":"acme_test","name":"Acme Prueba","is_enabled":true,"allows_production":true,
    "description":"Proveedor de prueba","config_fields":[{"key":"issuer_id","label":"ID de emisor","required":true}],
    "credential_fields":[{"key":"api_key","label":"API key"}]}';
  datos constant text := '"rnc":"131234567","legal_name":"Colmado e-CF","fiscal_address":"C/ Primera 1","ecf_enabled":true';
begin
  insert into auth.users (id, email, aud, role) values
    (ua, ua || '@t.ferddo', 'authenticated', 'authenticated'),
    (ub, ub || '@t.ferddo', 'authenticated', 'authenticated'),
    (ud, ud || '@t.ferddo', 'authenticated', 'authenticated');
  insert into platform_admins (user_id, note) values (ud, 'test');

  -- ── Catálogo ─────────────────────────────────────────────────────────────
  perform pg_temp.ok((select is_enabled and is_simulated and not allows_production from ecf_providers where code = 'simulator'),
                     'el simulador viene en el catálogo, activo y sin producción');
  perform pg_temp.act_as(ua);
  t := public.setup_business('Colmado e-CF', 'colmado');
  perform pg_temp.ok((select count(*) from ecf_providers where code = 'simulator') = 1, 'el negocio lee el catálogo');
  perform pg_temp.expect_error($q$insert into ecf_providers (code, name) values ('x_x', 'X')$q$, 'permission denied');
  perform pg_temp.expect_error($q$select public.admin_save_ecf_provider('{"code":"y_y","name":"Y"}')$q$, 'No autorizado');
  perform pg_temp.expect_error($q$select public.admin_list_ecf_providers()$q$, 'No autorizado');

  perform pg_temp.act_as(ud);
  perform public.admin_save_ecf_provider(acme);
  perform pg_temp.ok((select name = 'Acme Prueba' and is_enabled and jsonb_array_length(config_fields) = 1
                      from ecf_providers where code = 'acme_test'), 'alta de proveedor con sus campos');
  perform public.admin_save_ecf_provider('{"code":"acme_test","sort_order":5}');
  perform pg_temp.ok((select description = 'Proveedor de prueba' and sort_order = 5 from ecf_providers where code = 'acme_test'),
                     'una edición parcial no borra lo que no manda');
  perform pg_temp.expect_error($q$select public.admin_save_ecf_provider('{"code":"Mal Código","name":"X"}')$q$, 'minúsculas');
  perform pg_temp.expect_error($q$select public.admin_save_ecf_provider('{"code":"dup","name":"Dup","config_fields":[{"key":"a","label":"A"},{"key":"a","label":"B"}]}')$q$,
                               'Revisa los campos');
  perform pg_temp.expect_error($q$select public.admin_save_ecf_provider('{"code":"sim_dos","name":"Sim 2","is_simulated":true,"allows_production":true}')$q$,
                               'simulado');
  perform public.admin_save_ecf_provider('{"code":"apagado","name":"Proveedor apagado","is_enabled":false}');
  perform pg_temp.ok(exists (select 1 from platform_audit_logs where action = 'ecf_provider.create' and meta ->> 'code' = 'acme_test'),
                     'el alta queda en la bitácora');

  -- ── El negocio elige ─────────────────────────────────────────────────────
  perform pg_temp.act_as(ua);
  perform pg_temp.expect_error($q$select public.save_fiscal_settings('{"provider":"apagado"}')$q$, 'ECF_PROVIDER_DISABLED');
  perform pg_temp.expect_error($q$select public.save_fiscal_settings('{"provider":"no_existe"}')$q$, 'ECF_PROVIDER_UNKNOWN');
  perform pg_temp.expect_error(format($q$select public.save_fiscal_settings('{%s,"provider":"acme_test"}')$q$, datos), 'ECF_PROVIDER_CONFIG');
  perform pg_temp.expect_error($q$select public.save_fiscal_settings('{"provider":"simulator","environment":"production"}')$q$,
                               'ECF_PROVIDER_NOT_PRODUCTION');

  -- Dos comprobantes sin salir y uno ya enviado, todos con el simulador.
  perform set_config('role', 'postgres', true);
  insert into electronic_invoices (tenant_id, source_type, source_id, ecf_type, encf, environment, provider, simulated,
                                   subtotal, tax_total, total, status, track_id) values
    (t, 'sale', gen_random_uuid(), '32', 'E320000000001', 'test', 'simulator', true, 100, 18, 118, 'pending', null),
    (t, 'sale', gen_random_uuid(), '32', 'E320000000002', 'test', 'simulator', true, 100, 18, 118, 'error', null),
    (t, 'sale', gen_random_uuid(), '32', 'E320000000003', 'test', 'simulator', true, 100, 18, 118, 'sent', 'TRK-1');
  perform pg_temp.act_as(ua);

  perform public.save_fiscal_settings(format('{%s,"provider":"acme_test","provider_config":{"issuer_id":"EM-1"}}', datos)::jsonb);
  perform pg_temp.ok((select provider = 'acme_test' and provider_config ->> 'issuer_id' = 'EM-1' from fiscal_settings where tenant_id = t),
                     'el negocio cambia a un proveedor ofrecido con su configuración');
  perform pg_temp.ok((select count(*) from electronic_invoices where tenant_id = t and provider = 'acme_test' and not simulated) = 2,
                     'los comprobantes que no salieron pasan al proveedor nuevo (y dejan de ser simulados)');
  perform pg_temp.ok((select provider from electronic_invoices where tenant_id = t and track_id = 'TRK-1') = 'simulator',
                     'el ya enviado se queda con su proveedor: solo él puede consultarlo');
  perform pg_temp.ok((select count(*) from electronic_invoice_events where tenant_id = t and event = 'provider_changed'
                      and detail ->> 'from' = 'simulator' and detail ->> 'to' = 'acme_test') = 2,
                     'cada reasignación queda en la bitácora del comprobante');
  perform public.save_fiscal_settings('{"phone":"809-555-0000"}');
  perform pg_temp.ok((select provider_config ->> 'issuer_id' from fiscal_settings where tenant_id = t) = 'EM-1',
                     'guardar otra cosa no borra la configuración del proveedor');

  -- ── El panel cambia el proveedor de un negocio ───────────────────────────
  perform pg_temp.act_as(ud);
  perform pg_temp.expect_error(format($q$select public.admin_set_tenant_ecf_provider('%s', 'simulator', 'ab')$q$, t), 'ECF_REASON_REQUIRED');
  perform pg_temp.expect_error(format($q$select public.admin_set_tenant_ecf_provider('%s', 'apagado', 'Motivo válido')$q$, t), 'ECF_PROVIDER_DISABLED');
  r := public.admin_set_tenant_ecf_provider(t, 'simulator', 'Proveedor caído, vuelta a pruebas');
  perform pg_temp.ok((r ->> 'repointed')::int = 2 and r ->> 'from' = 'acme_test', 'el panel cambia el proveedor y reasigna lo pendiente');
  perform pg_temp.ok((select count(*) from fiscal_settings where tenant_id = t) = 0,
                     'el super-admin no lee los datos fiscales del negocio (RLS), aunque pueda cambiarle el proveedor');
  perform set_config('role', 'postgres', true);
  perform pg_temp.ok((select provider_config from fiscal_settings where tenant_id = t) = '{}'::jsonb,
                     'la configuración del proveedor anterior se descarta');
  perform pg_temp.act_as(ud);
  perform pg_temp.ok(exists (select 1 from audit_logs where tenant_id = t and action = 'fiscal.provider_changed_by_platform'
                             and meta ->> 'reason' = 'Proveedor caído, vuelta a pruebas'), 'queda en la bitácora del negocio con su motivo');
  perform pg_temp.ok(exists (select 1 from platform_audit_logs where tenant_id = t and action = 'ecf.provider_change'),
                     'y en la del panel');

  -- ── Migración masiva ─────────────────────────────────────────────────────
  perform pg_temp.act_as(ub);
  t2 := public.setup_business('Colmado en producción', 'colmado');
  perform set_config('role', 'postgres', true);
  -- setup_business ya crea la fila fiscal; se pasa a producción a mano (sin la regla de credenciales).
  update fiscal_settings set provider = 'acme_test', environment = 'production' where tenant_id = t2;
  perform pg_temp.act_as(ud);
  perform public.admin_set_tenant_ecf_provider(t, 'acme_test', 'Volvemos a Acme');
  r := public.admin_migrate_ecf_provider('acme_test', 'simulator', 'Prueba de migración');
  perform pg_temp.ok((r ->> 'moved')::int = 1 and (r ->> 'skipped_production')::int = 1,
                     'la migración mueve a quien puede y omite a quien está en producción');
  perform set_config('role', 'postgres', true);
  perform pg_temp.ok((select provider from fiscal_settings where tenant_id = t) = 'simulator'
                     and (select provider from fiscal_settings where tenant_id = t2) = 'acme_test',
                     'el negocio en producción sigue con su proveedor');
  perform pg_temp.act_as(ud);
  perform pg_temp.ok(exists (select 1 from platform_audit_logs where action = 'ecf.provider_migrate'), 'la migración queda registrada');

  -- ── Uso y borrado ────────────────────────────────────────────────────────
  perform pg_temp.ok(exists (select 1 from jsonb_array_elements(public.admin_list_ecf_providers()) e
                             where e ->> 'code' = 'acme_test' and (e ->> 'production_tenants')::int = 1),
                     'el listado del panel trae el uso de cada proveedor');
  perform pg_temp.expect_error($q$select public.admin_delete_ecf_provider('acme_test')$q$, 'ECF_PROVIDER_IN_USE');
  perform pg_temp.expect_error($q$select public.admin_save_ecf_provider('{"code":"acme_test","allows_production":false}')$q$,
                               'ECF_PROVIDER_IN_USE');
  perform public.admin_delete_ecf_provider('apagado');
  perform pg_temp.ok(not exists (select 1 from ecf_providers where code = 'apagado'), 'un proveedor sin uso se puede borrar');

  raise exception 'FERDDO_TESTS_OK: % aserciones', current_setting('ferddo_test.count', true);
end $$;
