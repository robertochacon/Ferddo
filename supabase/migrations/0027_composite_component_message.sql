-- ═══ Ferddo · 0027 · Mensaje de componente compuesto ═══
--
-- Por qué: un compuesto tiene track_stock = false, así que al usarlo como
-- componente save_product_components() decía "no controla existencia" en vez
-- de "ya es compuesto". Se comprueba primero lo compuesto.

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
    if exists (select 1 from product_components where product_id = v_c.id) then
      raise exception '"%" ya es compuesto: no se anidan compuestos.', v_c.name;
    end if;
    if v_c.kind <> 'product' or not v_c.track_stock then
      raise exception '"%" no controla existencia: solo se usan como componentes productos con inventario.', v_c.name;
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

notify pgrst, 'reload schema';
