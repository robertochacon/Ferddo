-- ═══ Ferddo · 0014 · Catálogo, clientes, proveedores e inventario ═══
--
-- Por qué así:
--   · Productos y servicios en UN catálogo (`products.kind`): el POS, las
--     cotizaciones y la facturación los tratan igual; solo el inventario los
--     distingue (un servicio nunca mueve existencia).
--   · Las existencias NO son un campo editable. Son el resultado de
--     `inventory_movements`, tabla inmutable; `stock_levels` es su saldo,
--     mantenido por trigger dentro de la misma transacción y sin permisos de
--     escritura para el cliente. Así el kardex siempre cuadra con la existencia.
--   · Claves foráneas COMPUESTAS (tenant_id, id) hacia categorías, impuestos,
--     sucursales y productos: una fila no puede apuntar a un registro de otra
--     empresa aunque alguien adivine su uuid (IDOR a nivel de integridad).

create extension if not exists pg_trgm with schema extensions;

-- ── Impuestos ───────────────────────────────────────────────────────────────
create table if not exists public.taxes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  name       text not null check (btrim(name) <> ''),
  code       text not null,
  -- Fracción (0.18 = 18 %). numeric, nunca float: el ITBIS se cuadra al centavo.
  rate       numeric(7, 4) not null check (rate >= 0 and rate < 1),
  is_default boolean not null default false,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code)
);
create index if not exists taxes_tenant_idx on public.taxes (tenant_id);
create unique index if not exists taxes_one_default_idx on public.taxes (tenant_id) where is_default;
select public._setup_tenant_table('taxes', 'settings.manage');

-- ── Categorías ──────────────────────────────────────────────────────────────
create table if not exists public.categories (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  name       text not null check (btrim(name) <> ''),
  parent_id  uuid,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, parent_id) references public.categories (tenant_id, id) on delete set null (parent_id)
);
create index if not exists categories_tenant_idx on public.categories (tenant_id);
create unique index if not exists categories_name_idx on public.categories (tenant_id, lower(name));
select public._setup_tenant_table('categories', 'products.manage', true);

-- ── Productos y servicios ───────────────────────────────────────────────────
create table if not exists public.products (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  kind          product_kind not null default 'product',
  -- Variantes: cada talla/color es un producto vendible con su SKU, código de
  -- barras y existencia propios, agrupado bajo el "padre" por parent_id.
  parent_id     uuid,
  variant_label text,
  code          text,
  sku           text,
  barcode       text,
  name          text not null check (btrim(name) <> ''),
  description   text,
  category_id   uuid,
  brand         text,
  unit          text not null default 'unidad',
  -- Costo promedio ponderado; lo recalcula la recepción de compras.
  cost          numeric(14, 4) not null default 0 check (cost >= 0),
  price         numeric(14, 2) not null default 0 check (price >= 0),
  tax_id        uuid,
  track_stock   boolean not null default true,
  min_stock     numeric(14, 3) not null default 0 check (min_stock >= 0),
  duration_minutes integer check (duration_minutes is null or duration_minutes > 0),
  image_url     text,
  is_active     boolean not null default true,
  created_by    uuid references auth.users (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, category_id) references public.categories (tenant_id, id) on delete set null (category_id),
  foreign key (tenant_id, tax_id) references public.taxes (tenant_id, id),
  foreign key (tenant_id, parent_id) references public.products (tenant_id, id),
  -- Un servicio no lleva existencia: se fuerza aquí y no en el formulario.
  check (kind = 'product' or not track_stock)
);
create index if not exists products_tenant_idx on public.products (tenant_id, is_active);
create unique index if not exists products_sku_idx on public.products (tenant_id, lower(sku)) where sku is not null;
create unique index if not exists products_barcode_idx on public.products (tenant_id, barcode) where barcode is not null;
create unique index if not exists products_code_idx on public.products (tenant_id, lower(code)) where code is not null;
create index if not exists products_name_trgm_idx on public.products using gin (name extensions.gin_trgm_ops);
create index if not exists products_category_idx on public.products (tenant_id, category_id);
create index if not exists products_created_by_idx on public.products (created_by);
select public._setup_tenant_table('products', 'products.manage');

-- Cambiar el precio de venta es un permiso aparte (prices.manage) y queda en
-- la bitácora con el valor anterior: es la manipulación más típica en un POS.
create or replace function public.products_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.price is distinct from old.price then
    if not public.has_perm('prices.manage') then
      raise exception 'FORBIDDEN: No tienes permiso para modificar precios.';
    end if;
    perform public.log_audit('product.price_changed', 'product', new.id,
                             jsonb_build_object('from', old.price, 'to', new.price));
  end if;
  if tg_op = 'UPDATE' and new.track_stock is distinct from old.track_stock
     and exists (select 1 from stock_levels where product_id = new.id and quantity <> 0) then
    raise exception 'No puedes cambiar el control de inventario de un producto con existencia; ajústala a cero primero.';
  end if;
  return new;
end;
$$;
revoke all on function public.products_guard() from public, anon;
drop trigger if exists trg_products_guard on public.products;
create trigger trg_products_guard before update on public.products
  for each row execute function public.products_guard();

-- ── Clientes ────────────────────────────────────────────────────────────────
create table if not exists public.customers (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  name         text not null check (btrim(name) <> ''),
  kind         text not null default 'person' check (kind in ('person', 'company')),
  doc_type     text not null default 'none' check (doc_type in ('rnc', 'cedula', 'passport', 'none')),
  doc_number   text,
  phone        text,
  email        text,
  address      text,
  -- 0 = no se le vende a crédito. Lo comprueba create_sale().
  credit_limit numeric(14, 2) not null default 0 check (credit_limit >= 0),
  credit_days  integer not null default 30 check (credit_days between 0 and 365),
  notes        text,
  is_active    boolean not null default true,
  created_by   uuid references auth.users (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  -- Formato, no dígito verificador: el algoritmo lo valida la UI como aviso;
  -- la última palabra sobre si un RNC existe la tiene la DGII.
  check (
    (doc_type = 'rnc' and doc_number ~ '^[0-9]{9}$') or
    (doc_type = 'cedula' and doc_number ~ '^[0-9]{11}$') or
    (doc_type = 'passport' and doc_number is not null) or
    (doc_type = 'none' and doc_number is null)
  )
);
create index if not exists customers_tenant_idx on public.customers (tenant_id, is_active);
create unique index if not exists customers_doc_idx on public.customers (tenant_id, doc_number) where doc_number is not null;
create index if not exists customers_name_trgm_idx on public.customers using gin (name extensions.gin_trgm_ops);
create index if not exists customers_created_by_idx on public.customers (created_by);
select public._setup_tenant_table('customers', 'customers.manage');

-- ── Proveedores ─────────────────────────────────────────────────────────────
create table if not exists public.suppliers (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  name          text not null check (btrim(name) <> ''),
  rnc           text check (rnc is null or rnc ~ '^([0-9]{9}|[0-9]{11})$'),
  contact_name  text,
  phone         text,
  email         text,
  address       text,
  payment_terms_days integer not null default 0 check (payment_terms_days between 0 and 365),
  notes         text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id)
);
create index if not exists suppliers_tenant_idx on public.suppliers (tenant_id, is_active);
create unique index if not exists suppliers_rnc_idx on public.suppliers (tenant_id, rnc) where rnc is not null;
select public._setup_tenant_table('suppliers', 'suppliers.manage');

-- ── Existencias ─────────────────────────────────────────────────────────────
create table if not exists public.stock_levels (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  branch_id  uuid not null,
  product_id uuid not null,
  quantity   numeric(14, 3) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (branch_id, product_id),
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id),
  foreign key (tenant_id, product_id) references public.products (tenant_id, id)
);
create index if not exists stock_levels_tenant_idx on public.stock_levels (tenant_id, product_id);
select public._setup_tenant_table('stock_levels', null);

create table if not exists public.inventory_movements (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  branch_id      uuid not null,
  product_id     uuid not null,
  kind           inventory_movement_kind not null,
  quantity       numeric(14, 3) not null check (quantity <> 0),
  unit_cost      numeric(14, 4) not null default 0,
  balance_after  numeric(14, 3) not null default 0,
  reference_type text,
  reference_id   uuid,
  -- Línea del documento origen (sale_item, purchase_item…). Con el índice
  -- único de abajo, reprocesar el mismo documento no duplica movimientos.
  line_ref       uuid,
  reason         text,
  created_by     uuid references auth.users (id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id),
  foreign key (tenant_id, product_id) references public.products (tenant_id, id),
  check (
    (kind in ('initial', 'purchase', 'sale_void', 'sale_return', 'adjustment_in', 'transfer_in') and quantity > 0) or
    (kind in ('sale', 'adjustment_out', 'transfer_out') and quantity < 0) or
    kind = 'count'
  )
);
create index if not exists inventory_movements_kardex_idx
  on public.inventory_movements (tenant_id, product_id, branch_id, created_at);
create index if not exists inventory_movements_ref_idx
  on public.inventory_movements (tenant_id, reference_type, reference_id);
create unique index if not exists inventory_movements_line_once_idx
  on public.inventory_movements (reference_type, reference_id, line_ref, kind)
  where line_ref is not null;
create index if not exists inventory_movements_created_by_idx on public.inventory_movements (created_by);
select public._setup_tenant_table('inventory_movements', null);

drop trigger if exists trg_immutable on public.inventory_movements;
create trigger trg_immutable before update or delete on public.inventory_movements
  for each row execute function public.prevent_mutation();

-- Aplica el movimiento al saldo. El UPSERT toma el candado de la fila de
-- stock_levels: dos ventas simultáneas del mismo producto en la misma
-- sucursal se serializan aquí y ninguna pisa a la otra.
create or replace function public.apply_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_track   boolean;
  v_name    text;
  v_balance numeric(14, 3);
  v_allow   boolean;
begin
  select track_stock, name into v_track, v_name
  from products where id = new.product_id and tenant_id = new.tenant_id;
  if not coalesce(v_track, false) then
    raise exception '"%" no lleva control de inventario', coalesce(v_name, 'El producto');
  end if;

  insert into stock_levels (tenant_id, branch_id, product_id, quantity)
  values (new.tenant_id, new.branch_id, new.product_id, new.quantity)
  on conflict (branch_id, product_id) do update
    set quantity = stock_levels.quantity + excluded.quantity, updated_at = now()
  returning quantity into v_balance;

  if new.quantity < 0 and v_balance < 0 then
    select allow_negative_stock into v_allow from tenants where id = new.tenant_id;
    if not v_allow then
      raise exception 'STOCK_INSUFFICIENT: No hay existencia suficiente de "%" (quedaría en %).', v_name, v_balance;
    end if;
  end if;
  new.balance_after := v_balance;
  return new;
end;
$$;
revoke all on function public.apply_inventory_movement() from public, anon;
drop trigger if exists trg_apply_inventory_movement on public.inventory_movements;
create trigger trg_apply_inventory_movement before insert on public.inventory_movements
  for each row execute function public.apply_inventory_movement();

-- ── Documentos de inventario (cabeceras) ────────────────────────────────────
create table if not exists public.inventory_documents (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  kind        text not null check (kind in ('adjustment', 'transfer', 'count')),
  number      text not null,
  branch_id   uuid not null,
  to_branch_id uuid,
  note        text,
  lines       integer not null default 0,
  created_by  uuid references auth.users (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id),
  foreign key (tenant_id, to_branch_id) references public.branches (tenant_id, id)
);
create index if not exists inventory_documents_tenant_idx on public.inventory_documents (tenant_id, created_at desc);
create index if not exists inventory_documents_created_by_idx on public.inventory_documents (created_by);
select public._setup_tenant_table('inventory_documents', null);

-- Ajuste manual (entrada, salida o existencia inicial) de varias líneas.
-- p_lines: [{ product_id, quantity (con signo), unit_cost? }]
create or replace function public.inventory_adjust(
  p_branch uuid,
  p_lines  jsonb,
  p_reason text,
  p_initial boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_doc    uuid;
  v_num    record;
  v_line   jsonb;
  v_qty    numeric;
  v_cost   numeric;
  v_n      int := 0;
begin
  perform public.require_perm('inventory.adjust');
  perform public.require_module('inventory');
  if not public.can_access_branch(p_branch) then
    raise exception 'FORBIDDEN: No tienes acceso a esa sucursal.';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Indica el motivo del ajuste';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'El ajuste no tiene líneas';
  end if;

  select * into v_num from public.next_doc_number(v_tenant, 'inventory_adjustment');
  insert into inventory_documents (tenant_id, kind, number, branch_id, note, lines)
  values (v_tenant, 'adjustment', 'AJ-' || v_num.label, p_branch, btrim(p_reason), jsonb_array_length(p_lines))
  returning id into v_doc;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty := (v_line ->> 'quantity')::numeric;
    if v_qty is null or v_qty = 0 then
      continue;
    end if;
    if p_initial and v_qty < 0 then
      raise exception 'La existencia inicial no puede ser negativa';
    end if;
    select coalesce((v_line ->> 'unit_cost')::numeric, cost) into v_cost
    from products where id = (v_line ->> 'product_id')::uuid and tenant_id = v_tenant;
    if not found then
      raise exception 'Producto no encontrado';
    end if;
    insert into inventory_movements (tenant_id, branch_id, product_id, kind, quantity, unit_cost,
                                     reference_type, reference_id, line_ref, reason)
    values (v_tenant, p_branch, (v_line ->> 'product_id')::uuid,
            case when p_initial then 'initial'
                 when v_qty > 0 then 'adjustment_in' else 'adjustment_out' end::inventory_movement_kind,
            v_qty, v_cost, 'inventory_document', v_doc, gen_random_uuid(), btrim(p_reason));
    -- Una existencia inicial con costo fija el costo de un producto que no tenía.
    if p_initial and (v_line ? 'unit_cost') then
      update products set cost = v_cost where id = (v_line ->> 'product_id')::uuid and cost = 0;
    end if;
    v_n := v_n + 1;
  end loop;
  update inventory_documents set lines = v_n where id = v_doc;
  perform public.log_audit('inventory.adjusted', 'inventory_document', v_doc,
                           jsonb_build_object('lines', v_n, 'reason', p_reason, 'initial', p_initial));
  return v_doc;
end;
$$;

-- Transferencia: salida en origen y entrada en destino en la MISMA
-- transacción; nunca queda mercancía "en el aire".
create or replace function public.inventory_transfer(
  p_from  uuid,
  p_to    uuid,
  p_lines jsonb,
  p_note  text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_doc    uuid;
  v_num    record;
  v_line   jsonb;
  v_qty    numeric;
  v_cost   numeric;
  v_pid    uuid;
  v_n      int := 0;
begin
  perform public.require_perm('inventory.transfer');
  perform public.require_module('inventory');
  if p_from = p_to then
    raise exception 'El origen y el destino son la misma sucursal';
  end if;
  if not public.can_access_branch(p_from) or not public.can_access_branch(p_to) then
    raise exception 'FORBIDDEN: No tienes acceso a esas sucursales.';
  end if;
  select * into v_num from public.next_doc_number(v_tenant, 'inventory_transfer');
  insert into inventory_documents (tenant_id, kind, number, branch_id, to_branch_id, note, lines)
  values (v_tenant, 'transfer', 'TR-' || v_num.label, p_from, p_to, nullif(btrim(p_note), ''), 0)
  returning id into v_doc;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty := (v_line ->> 'quantity')::numeric;
    v_pid := (v_line ->> 'product_id')::uuid;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Las cantidades a transferir deben ser positivas';
    end if;
    select cost into v_cost from products where id = v_pid and tenant_id = v_tenant;
    if not found then
      raise exception 'Producto no encontrado';
    end if;
    insert into inventory_movements (tenant_id, branch_id, product_id, kind, quantity, unit_cost,
                                     reference_type, reference_id, line_ref, reason)
    values (v_tenant, p_from, v_pid, 'transfer_out', -v_qty, v_cost, 'inventory_document', v_doc,
            gen_random_uuid(), p_note),
           (v_tenant, p_to, v_pid, 'transfer_in', v_qty, v_cost, 'inventory_document', v_doc,
            gen_random_uuid(), p_note);
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then
    raise exception 'La transferencia no tiene líneas';
  end if;
  update inventory_documents set lines = v_n where id = v_doc;
  perform public.log_audit('inventory.transferred', 'inventory_document', v_doc, jsonb_build_object('lines', v_n));
  return v_doc;
end;
$$;

-- Conteo físico: se manda lo CONTADO y la base calcula la diferencia contra
-- el saldo del momento (bloqueado), no contra lo que la pantalla mostraba.
create or replace function public.inventory_count(
  p_branch uuid,
  p_counts jsonb,
  p_note   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.auth_tenant_id();
  v_doc     uuid;
  v_num     record;
  v_line    jsonb;
  v_pid     uuid;
  v_counted numeric;
  v_current numeric;
  v_cost    numeric;
  v_diffs   int := 0;
begin
  perform public.require_perm('inventory.adjust');
  perform public.require_module('inventory');
  if not public.can_access_branch(p_branch) then
    raise exception 'FORBIDDEN: No tienes acceso a esa sucursal.';
  end if;
  select * into v_num from public.next_doc_number(v_tenant, 'inventory_count');
  insert into inventory_documents (tenant_id, kind, number, branch_id, note, lines)
  values (v_tenant, 'count', 'CF-' || v_num.label, p_branch, nullif(btrim(p_note), ''), jsonb_array_length(p_counts))
  returning id into v_doc;

  for v_line in select * from jsonb_array_elements(p_counts) loop
    v_pid := (v_line ->> 'product_id')::uuid;
    v_counted := (v_line ->> 'counted')::numeric;
    if v_counted is null or v_counted < 0 then
      raise exception 'Cantidad contada inválida';
    end if;
    select cost into v_cost from products where id = v_pid and tenant_id = v_tenant and track_stock;
    if not found then
      raise exception 'Producto no encontrado o sin control de inventario';
    end if;
    select quantity into v_current from stock_levels
    where branch_id = p_branch and product_id = v_pid for update;
    v_current := coalesce(v_current, 0);
    if v_counted <> v_current then
      insert into inventory_movements (tenant_id, branch_id, product_id, kind, quantity, unit_cost,
                                       reference_type, reference_id, line_ref, reason)
      values (v_tenant, p_branch, v_pid, 'count', v_counted - v_current, v_cost,
              'inventory_document', v_doc, gen_random_uuid(), coalesce(p_note, 'Conteo físico'));
      v_diffs := v_diffs + 1;
    end if;
  end loop;
  perform public.log_audit('inventory.counted', 'inventory_document', v_doc, jsonb_build_object('differences', v_diffs));
  return jsonb_build_object('document_id', v_doc, 'differences', v_diffs);
end;
$$;

-- Importación masiva (CSV ya parseado en el cliente). Inserta o actualiza por
-- SKU/código de barras y devuelve los errores fila a fila en vez de abortar
-- todo el archivo por una línea mala.
create or replace function public.import_products(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '50s'
as $$
declare
  v_tenant  uuid := public.auth_tenant_id();
  v_branch  uuid;
  v_row     jsonb;
  v_i       int := 0;
  v_cat     uuid;
  v_tax     uuid;
  v_id      uuid;
  v_ins     int := 0;
  v_upd     int := 0;
  v_errors  jsonb := '[]'::jsonb;
  v_stock   numeric;
begin
  perform public.require_perm('products.manage');
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Formato inválido';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'Máximo 5000 filas por importación';
  end if;
  select id into v_branch from branches where tenant_id = v_tenant and is_main;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    begin
      v_cat := null;
      if nullif(btrim(v_row ->> 'category'), '') is not null then
        insert into categories (tenant_id, name) values (v_tenant, btrim(v_row ->> 'category'))
        on conflict (tenant_id, lower(name)) do update set name = categories.name
        returning id into v_cat;
      end if;
      select id into v_tax from taxes
      where tenant_id = v_tenant
        and (code = upper(btrim(coalesce(v_row ->> 'tax_code', ''))) or
             (nullif(btrim(v_row ->> 'tax_code'), '') is null and is_default));

      select id into v_id from products
      where tenant_id = v_tenant
        and ((nullif(v_row ->> 'sku', '') is not null and lower(sku) = lower(v_row ->> 'sku')) or
             (nullif(v_row ->> 'barcode', '') is not null and barcode = v_row ->> 'barcode'))
      limit 1;

      if v_id is null then
        insert into products (tenant_id, kind, name, sku, barcode, code, description, category_id, brand,
                              unit, cost, price, tax_id, track_stock, min_stock)
        values (v_tenant,
                coalesce(nullif(v_row ->> 'kind', ''), 'product')::product_kind,
                btrim(v_row ->> 'name'), nullif(btrim(v_row ->> 'sku'), ''), nullif(btrim(v_row ->> 'barcode'), ''),
                nullif(btrim(v_row ->> 'code'), ''), nullif(v_row ->> 'description', ''), v_cat,
                nullif(v_row ->> 'brand', ''), coalesce(nullif(v_row ->> 'unit', ''), 'unidad'),
                coalesce(nullif(v_row ->> 'cost', '')::numeric, 0), coalesce(nullif(v_row ->> 'price', '')::numeric, 0),
                v_tax,
                coalesce(nullif(v_row ->> 'kind', ''), 'product') = 'product'
                  and coalesce(nullif(v_row ->> 'track_stock', '')::boolean, true),
                coalesce(nullif(v_row ->> 'min_stock', '')::numeric, 0))
        returning id into v_id;
        v_ins := v_ins + 1;
        v_stock := nullif(v_row ->> 'stock', '')::numeric;
        if v_stock is not null and v_stock > 0 and v_branch is not null then
          insert into inventory_movements (tenant_id, branch_id, product_id, kind, quantity, unit_cost,
                                           reference_type, line_ref, reason)
          select v_tenant, v_branch, v_id, 'initial', v_stock, cost, 'import', gen_random_uuid(), 'Importación'
          from products where id = v_id and track_stock;
        end if;
      else
        update products set
          name        = coalesce(nullif(btrim(v_row ->> 'name'), ''), name),
          category_id = coalesce(v_cat, category_id),
          cost        = coalesce(nullif(v_row ->> 'cost', '')::numeric, cost),
          price       = coalesce(nullif(v_row ->> 'price', '')::numeric, price),
          tax_id      = coalesce(v_tax, tax_id),
          min_stock   = coalesce(nullif(v_row ->> 'min_stock', '')::numeric, min_stock)
        where id = v_id;
        v_upd := v_upd + 1;
      end if;
    exception when others then
      v_errors := v_errors || jsonb_build_object('row', v_i, 'error', regexp_replace(sqlerrm, '^[A-Z_]+: ', ''));
    end;
  end loop;
  perform public.log_audit('products.imported', 'product', null,
                           jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'errors', jsonb_array_length(v_errors)));
  return jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'errors', v_errors);
end;
$$;

do $$
declare
  f   text;
  fns text[] := array[
    'public.inventory_adjust(uuid, jsonb, text, boolean)',
    'public.inventory_transfer(uuid, uuid, jsonb, text)',
    'public.inventory_count(uuid, jsonb, text)',
    'public.import_products(jsonb)'
  ];
begin
  foreach f in array fns loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
