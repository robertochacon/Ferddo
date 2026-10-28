-- ═══ Ferddo · 0025 · Plan Negocio con restaurante/taller · productos compuestos ═══
-- 1) El plan Negocio (pro) incluye los módulos de restaurante y taller. Se
--    AÑADEN a lo que tenga hoy la fila (pudo editarse en /admin), no se pisa.
-- 2) Productos compuestos (recetas y kits): un producto o servicio con
--    componentes no lleva existencia propia; al venderse descuenta sus
--    componentes. Se resuelve con triggers sobre sale_items y
--    sale_return_items, así que POS, restaurante, taller y cotizaciones
--    convertidas lo heredan sin tocar create_sale. La anulación ya revierte
--    todos los movimientos 'sale' de la venta, componentes incluidos.

-- ── 1) Plan Negocio ─────────────────────────────────────────────────────────
update public.plan_settings
set modules = (select array_agg(distinct m) from unnest(modules || array['restaurant', 'workshop']) m),
    features = case when 'Módulos de restaurante y taller' = any (features) then features
                    else array_append(features, 'Módulos de restaurante y taller') end
where plan = 'pro' and modules is not null;

update public.plan_settings
set features = array_remove(features, 'Módulos de restaurante y taller')
where plan = 'enterprise';

-- ── 2) Componentes ──────────────────────────────────────────────────────────
create table if not exists public.product_components (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  product_id   uuid not null,
  component_id uuid not null,
  -- Cantidad del componente por UNA unidad vendida del compuesto.
  quantity     numeric(14, 4) not null check (quantity > 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  unique (product_id, component_id),
  check (product_id <> component_id),
  foreign key (tenant_id, product_id) references public.products (tenant_id, id) on delete cascade,
  foreign key (tenant_id, component_id) references public.products (tenant_id, id)
);
create index if not exists product_components_component_idx on public.product_components (component_id);
-- Solo lectura por RLS: se escribe con save_product_components().
select public._setup_tenant_table('product_components', null);

-- Una línea de venta de un compuesto genera un movimiento POR componente con
-- el mismo line_ref: el índice de "una vez por línea" pasa a incluir producto.
drop index if exists public.inventory_movements_line_once_idx;
create unique index if not exists inventory_movements_line_once_idx
  on public.inventory_movements (reference_type, reference_id, line_ref, kind, product_id)
  where line_ref is not null;

-- Reemplaza TODOS los componentes de un producto. Lista vacía = deja de ser
-- compuesto (no reactiva el control de existencia: eso se decide en el
-- formulario del producto).
create or replace function public.save_product_components(p_product uuid, p_components jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_p      products;
  v_c      products;
  v_row    jsonb;
  v_qty    numeric;
  v_cost   numeric := 0;
begin
  perform public.require_perm('products.manage');
  perform public.assert_tenant_operational();
  select * into v_p from products where id = p_product and tenant_id = v_tenant for update;
  if not found then
    raise exception 'Producto no encontrado';
  end if;
  if jsonb_typeof(coalesce(p_components, '[]'::jsonb)) <> 'array' then
    raise exception 'Componentes inválidos';
  end if;
  if exists (select 1 from product_components where component_id = p_product)
     and jsonb_array_length(coalesce(p_components, '[]'::jsonb)) > 0 then
    raise exception '"%" ya es componente de otro producto: un componente no puede ser compuesto.', v_p.name;
  end if;
  if exists (select 1 from products where tenant_id = v_tenant and parent_id = p_product) then
    raise exception 'Un producto con variantes no puede ser compuesto; usa la variante.';
  end if;

  delete from product_components where product_id = p_product;

  for v_row in select * from jsonb_array_elements(coalesce(p_components, '[]'::jsonb)) loop
    v_qty := (v_row ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'La cantidad de cada componente debe ser mayor que cero';
    end if;
    select * into v_c from products where id = (v_row ->> 'component_id')::uuid and tenant_id = v_tenant;
    if not found then
      raise exception 'Componente no encontrado';
    end if;
    if v_c.id = p_product then
      raise exception 'Un producto no puede ser componente de sí mismo';
    end if;
    if v_c.kind <> 'product' or not v_c.track_stock then
      raise exception '"%" no controla existencia: solo se usan como componentes productos con inventario.', v_c.name;
    end if;
    if exists (select 1 from product_components where product_id = v_c.id) then
      raise exception '"%" ya es compuesto: no se anidan compuestos.', v_c.name;
    end if;
    insert into product_components (tenant_id, product_id, component_id, quantity)
    values (v_tenant, p_product, v_c.id, v_qty)
    on conflict (product_id, component_id) do update set quantity = product_components.quantity + excluded.quantity;
    v_cost := v_cost + v_qty * v_c.cost;
  end loop;

  if exists (select 1 from product_components where product_id = p_product) then
    -- products_guard rechaza el cambio si el producto aún tiene existencia.
    update products set track_stock = false, cost = round(v_cost, 4) where id = p_product;
  end if;
  perform public.log_audit('product.components_saved', 'product', p_product,
                           jsonb_build_object('components', coalesce(p_components, '[]'::jsonb)));
end;
$$;

-- Costo de una línea de compuesto = suma de componentes al momento de vender.
create or replace function public.sale_items_composite_cost()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cost numeric;
begin
  select sum(pc.quantity * p.cost) into v_cost
  from product_components pc join products p on p.id = pc.component_id
  where pc.product_id = new.product_id;
  if v_cost is not null then
    new.unit_cost := round(v_cost, 4);
  end if;
  return new;
end;
$$;

create or replace function public.sale_items_consume_components()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale sales;
  v_c    record;
begin
  if not exists (select 1 from product_components where product_id = new.product_id) then
    return null;
  end if;
  if not public.tenant_has_module('inventory', new.tenant_id) then
    return null;
  end if;
  select * into v_sale from sales where id = new.sale_id;
  for v_c in
    select pc.component_id, pc.quantity, p.cost
    from product_components pc join products p on p.id = pc.component_id
    where pc.product_id = new.product_id and p.track_stock
  loop
    insert into inventory_movements (tenant_id, branch_id, product_id, kind, quantity, unit_cost,
                                     reference_type, reference_id, line_ref, reason)
    values (new.tenant_id, v_sale.branch_id, v_c.component_id, 'sale',
            -round(new.quantity * v_c.quantity, 3), v_c.cost,
            'sale', new.sale_id, new.id, 'Venta ' || v_sale.number || ' · ' || new.description);
  end loop;
  return null;
end;
$$;

drop trigger if exists trg_sale_items_composite_cost on public.sale_items;
create trigger trg_sale_items_composite_cost before insert on public.sale_items
  for each row execute function public.sale_items_composite_cost();
drop trigger if exists trg_sale_items_consume_components on public.sale_items;
create trigger trg_sale_items_consume_components after insert on public.sale_items
  for each row execute function public.sale_items_consume_components();

-- Devolución con reingreso: repone lo que REALMENTE salió por esa línea
-- (los movimientos originales), proporcional a lo devuelto, aunque la receta
-- haya cambiado después de la venta.
create or replace function public.sale_return_items_restock_components()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ret  sale_returns;
  v_si   sale_items;
  v_br   uuid;
  v_mv   record;
begin
  select * into v_ret from sale_returns where id = new.return_id;
  if not v_ret.restock then
    return null;
  end if;
  select * into v_si from sale_items where id = new.sale_item_id;
  select branch_id into v_br from sales where id = v_si.sale_id;
  for v_mv in
    select product_id, quantity, unit_cost from inventory_movements
    where reference_type = 'sale' and reference_id = v_si.sale_id and line_ref = v_si.id
      and kind = 'sale' and product_id <> v_si.product_id
  loop
    insert into inventory_movements (tenant_id, branch_id, product_id, kind, quantity, unit_cost,
                                     reference_type, reference_id, line_ref, reason)
    values (new.tenant_id, v_br, v_mv.product_id, 'sale_return',
            round(-v_mv.quantity * new.quantity / v_si.quantity, 3), v_mv.unit_cost,
            'sale_return', new.return_id, v_si.id, 'Devolución ' || v_ret.number || ' · ' || v_si.description);
  end loop;
  return null;
end;
$$;

drop trigger if exists trg_sale_return_items_restock_components on public.sale_return_items;
create trigger trg_sale_return_items_restock_components after insert on public.sale_return_items
  for each row execute function public.sale_return_items_restock_components();

-- Purga de empresas: los componentes van antes que los productos.
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
    'product_components', 'products', 'categories', 'taxes', 'suppliers', 'expense_categories',
    'document_sequences', 'role_permissions', 'tenant_members', 'branches', 'subscription_events',
    'notifications', 'audit_logs', 'tenant_invites', 'plan_requests', 'subscriptions'
  ]
$$;
revoke all on function public.tenant_tables_purge_order() from public, anon, authenticated;

revoke all on function public.sale_items_composite_cost() from public, anon, authenticated;
revoke all on function public.sale_items_consume_components() from public, anon, authenticated;
revoke all on function public.sale_return_items_restock_components() from public, anon, authenticated;
revoke all on function public.save_product_components(uuid, jsonb) from public, anon;
grant execute on function public.save_product_components(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
