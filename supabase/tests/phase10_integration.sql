-- ═══════════════════════════════════════════════════════════════════════════
-- Ferddo · Prueba de integración: acceso de soporte, bitácora del panel y
-- notas internas (0028)
--
--   supabase db query --linked -f supabase/tests/phase10_integration.sql
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
  uc uuid := gen_random_uuid();   -- cajero
  ud uuid := gen_random_uuid();   -- super-admin
  t uuid; t2 uuid; v_until timestamptz; v_members int; v_team jsonb; v_prod uuid; v_code text;
begin
  insert into auth.users (id, email, aud, role) values
    (ua, ua || '@t.ferddo', 'authenticated', 'authenticated'),
    (uc, uc || '@t.ferddo', 'authenticated', 'authenticated'),
    (ud, ud || '@t.ferddo', 'authenticated', 'authenticated');
  insert into platform_admins (user_id, note) values (ud, 'test');

  perform pg_temp.act_as(ua);
  t := public.setup_business('Colmado Soporte', 'colmado');
  v_code := public.create_invite('cashier');
  perform pg_temp.act_as(uc); perform public.accept_invite(v_code);
  perform pg_temp.act_as(ua);
  insert into products (tenant_id, name, price) values (t, 'Producto del negocio', 100) returning id into v_prod;
  v_members := (public.my_plan_usage() ->> 'members')::int;

  -- ── Entrar ───────────────────────────────────────────────────────────────
  perform pg_temp.expect_error($q$select public.admin_enter_tenant('$q$ || t || $q$', 'mirar algo')$q$, 'FORBIDDEN');

  perform pg_temp.act_as(ud);
  perform pg_temp.ok(public.auth_tenant_id() is null, 'el super-admin empieza sin negocio');
  perform pg_temp.ok((select count(*) from products where id = v_prod) = 0,
                     'sin entrar, el super-admin NO lee datos comerciales');
  perform pg_temp.expect_error($q$select public.admin_enter_tenant('$q$ || t || $q$', ' ab ')$q$, 'SUPPORT_REASON_REQUIRED');

  -- Equipo lleno: el soporte no ocupa plaza, así que entra igual.
  perform set_config('role', 'postgres', true);
  update plan_settings set max_members = v_members
  where plan = (select plan from subscriptions where tenant_id = t);
  perform pg_temp.act_as(ud);

  v_until := public.admin_enter_tenant(t, 'El dueño no encuentra un producto');
  perform pg_temp.ok(v_until between now() + interval '119 minutes' and now() + interval '121 minutes', 'el acceso dura 2 horas');
  perform pg_temp.ok(public.auth_tenant_id() = t, 'dentro, el negocio activo es el del soporte');
  perform pg_temp.ok(public.auth_member_role() = 'admin', 'entra como administrador');
  perform pg_temp.ok(public.has_perm('products.manage'), 'con los permisos del rol administrador');
  perform pg_temp.ok(not public.has_perm('subscription.manage'), 'sin los reservados al dueño');
  perform pg_temp.ok((select count(*) from products where id = v_prod) = 1, 'dentro, lee los datos del negocio');
  update products set price = 120 where id = v_prod;
  perform pg_temp.ok((select price from products where id = v_prod) = 120, 'y puede operar');
  perform pg_temp.ok((public.my_plan_usage() ->> 'members')::int = v_members, 'el soporte no cuenta en el tope de miembros');

  -- ── Lo que ve el negocio ─────────────────────────────────────────────────
  perform pg_temp.act_as(ua);
  v_team := public.list_team_members();
  perform pg_temp.ok(exists (select 1 from jsonb_array_elements(v_team) e
                             where (e ->> 'user_id')::uuid = ud and e ->> 'support_until' is not null
                               and e ->> 'support_reason' = 'El dueño no encuentra un producto'),
                     'el dueño ve el acceso de soporte, su caducidad y su motivo');
  perform pg_temp.ok(exists (select 1 from audit_logs where tenant_id = t and action = 'support.enter' and user_id = ud),
                     'la entrada queda en la bitácora del negocio');
  perform pg_temp.expect_error($q$select public.set_member_role('$q$ || ud || $q$', 'owner')$q$, 'FORBIDDEN');
  perform pg_temp.ok((select count(*) from platform_audit_logs) = 0, 'el negocio no lee la bitácora de plataforma');

  -- El dueño corta el acceso: el super-admin queda fuera al instante.
  perform public.set_member_active(ud, false);
  perform pg_temp.ok(not exists (select 1 from jsonb_array_elements(public.list_team_members()) e
                                 where (e ->> 'user_id')::uuid = ud), 'cortado, el soporte desaparece del equipo (0029)');
  perform pg_temp.ok(exists (select 1 from audit_logs where tenant_id = t and action = 'support.revoke' and user_id = ua),
                     'el corte queda en la bitácora del negocio, a nombre del dueño');
  perform pg_temp.act_as(ud);
  perform pg_temp.ok(public.auth_tenant_id() is null, 'cortado por el dueño, el soporte ya no entra');
  perform pg_temp.ok(not exists (select 1 from tenant_members where user_id = ud), 'cortar el acceso no deja la fila colgada');
  perform pg_temp.ok(exists (select 1 from platform_audit_logs where tenant_id = t and action = 'support.revoke' and actor_id = ua),
                     'y llega a la bitácora de plataforma');

  -- ── Caducidad ────────────────────────────────────────────────────────────
  perform public.admin_enter_tenant(t, 'Segundo intento de soporte');
  perform pg_temp.ok(public.auth_tenant_id() = t, 'volver a entrar reactiva el acceso (y se registra)');
  perform set_config('role', 'postgres', true);
  update tenant_members set support_until = now() - interval '1 second' where tenant_id = t and user_id = ud;
  perform pg_temp.act_as(ud);
  perform pg_temp.ok(public.auth_tenant_id() is null, 'caducado, la base lo deja fuera sin que nadie borre nada');
  perform pg_temp.ok((select count(*) from products where id = v_prod) = 0, 'caducado, vuelve a no leer datos comerciales');
  perform pg_temp.act_as(ua);
  perform pg_temp.ok(not exists (select 1 from jsonb_array_elements(public.list_team_members()) e
                                 where (e ->> 'user_id')::uuid = ud), 'caducado, desaparece del equipo');

  -- ── Salir ────────────────────────────────────────────────────────────────
  perform pg_temp.act_as(ud);
  perform public.admin_exit_tenant();
  perform pg_temp.ok(not exists (select 1 from tenant_members where user_id = ud), 'al salir no queda membresía');
  perform pg_temp.ok((select tenant_id from profiles where id = ud) is null, 'y vuelve a ser un principal sin negocio');
  perform pg_temp.ok((select (meta ->> 'expired')::boolean from platform_audit_logs
                      where action = 'support.exit' and tenant_id = t order by created_at desc limit 1),
                     'la salida registra que el acceso había caducado');
  perform pg_temp.ok((select count(*) from platform_audit_logs where action = 'support.enter' and tenant_id = t) = 2,
                     'cada entrada queda en la bitácora de plataforma');

  -- Un acceso a la vez: entrar a otro negocio cierra el anterior.
  perform pg_temp.act_as(ua);
  t2 := public.setup_business('Segundo negocio', 'other', null, null, null, null, null, null, null, null, true);
  perform pg_temp.act_as(ud);
  perform public.admin_enter_tenant(t, 'Revisión A');
  perform public.admin_enter_tenant(t2, 'Revisión B');
  perform pg_temp.ok((select count(*) from tenant_members where user_id = ud) = 1, 'solo un acceso de soporte abierto');
  perform pg_temp.ok(public.auth_tenant_id() = t2, 'el último es el activo');
  perform public.admin_exit_tenant();

  -- ── Bitácora de acciones del panel (triggers) ────────────────────────────
  perform public.admin_set_tenant_suspended(t, true);
  perform public.admin_set_tenant_suspended(t, false);
  perform public.admin_set_member_role(t, uc, 'supervisor');
  perform pg_temp.ok((select count(*) from platform_audit_logs where tenant_id = t
                      and action in ('tenant.suspend', 'tenant.reactivate')) = 2, 'suspender y reactivar quedan registrados');
  perform pg_temp.ok(exists (select 1 from platform_audit_logs where tenant_id = t and action = 'member.role'
                             and meta ->> 'from' = 'cashier' and meta ->> 'to' = 'supervisor' and actor_id = ud),
                     'el cambio de rol queda con autor, antes y después');
  perform pg_temp.ok((select tenant_name from platform_audit_logs where tenant_id = t limit 1) = 'Colmado Soporte',
                     'la bitácora guarda el nombre del negocio');
  perform pg_temp.act_as(ua);
  perform public.switch_tenant(t);  -- al crear el segundo negocio quedó activo ese
  perform public.set_member_role(uc, 'cashier');
  perform pg_temp.act_as(ud);
  perform pg_temp.ok(not exists (select 1 from platform_audit_logs where tenant_id = t and action = 'member.role'
                                 and actor_id = ua), 'lo que hace el propio dueño no va a la bitácora de plataforma');

  -- ── Notas internas ───────────────────────────────────────────────────────
  insert into tenant_admin_notes (tenant_id, body) values (t, 'Llamó por la factura de octubre');
  perform pg_temp.ok((select author_id from tenant_admin_notes where tenant_id = t) = ud, 'la nota queda firmada');
  perform pg_temp.act_as(ua);
  perform pg_temp.ok((select count(*) from tenant_admin_notes) = 0, 'el negocio no ve las notas internas');
  perform pg_temp.expect_error($q$insert into tenant_admin_notes (tenant_id, body) values ('$q$ || t || $q$', 'x')$q$,
                               'row-level security');

  -- ── La purga se lleva notas y membresías; la bitácora sobrevive ──────────
  perform pg_temp.act_as(ud);
  perform public.admin_delete_tenant(t, 'Colmado Soporte', false);
  perform pg_temp.ok(not exists (select 1 from tenant_admin_notes where tenant_id = t), 'la purga borra las notas');
  perform pg_temp.ok(exists (select 1 from platform_audit_logs where tenant_id = t and action = 'tenant.delete'),
                     'el borrado queda en la bitácora');
  perform pg_temp.ok(not exists (select 1 from platform_audit_logs where tenant_id = t and action = 'member.remove'),
                     'la purga no deja una línea por cada miembro');
  perform pg_temp.ok((select count(*) from platform_audit_logs where tenant_id = t) > 3, 'y la bitácora del negocio sobrevive');

  raise exception 'FERDDO_TESTS_OK: % aserciones', current_setting('ferddo_test.count', true);
end $$;
