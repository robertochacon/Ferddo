-- ═══ Ferddo · 0018 · Planes, límites, tablero, reportes y panel global ═══
--
-- Por qué existe:
--   · Los planes comerciales (Básico, Negocio, Empresa) con sus límites y
--     módulos como CONFIGURACIÓN en plan_settings, no como código: el
--     super-admin los cambia desde /admin y los triggers los leen en vivo.
--   · Historial de la suscripción (subscription_events) para auditar cambios.
--   · Siembra de cada empresa nueva (impuestos, caja, categorías de gasto,
--     configuración fiscal) que setup_business() invoca.
--   · Tablero y reportes calculados en la base, con criterios explícitos.
--   · Las RPC del super-admin dejan de hablar de `items` y pasan a métricas
--     AGREGADAS: el panel global no lee ventas, clientes ni precios de nadie.

-- ── 1. Planes ───────────────────────────────────────────────────────────────
do $$ begin
  alter table public.plan_settings rename column max_items to max_products;
exception when undefined_column then null; end $$;

alter table public.plan_settings
  add column if not exists max_branches  integer check (max_branches is null or max_branches > 0),
  add column if not exists max_registers integer check (max_registers is null or max_registers > 0);

-- Precios de ARRANQUE: son una decisión comercial y se ajustan en /admin.
insert into public.plan_settings (plan, name, price_monthly, price_usd, max_products, max_members, max_branches,
                                  max_registers, max_ecf_monthly, modules, features, is_offered, is_featured, sort_order)
values
  ('basic', 'Básico', 990, 17, 500, 2, 1, 1, 0,
   array['pos','inventory','cash','credit','reports'],
   array['Punto de venta y caja', 'Productos e inventario', 'Clientes y ventas a crédito',
         'Reportes básicos', '1 sucursal · 2 usuarios'], true, false, 1),
  ('pro', 'Negocio', 2490, 42, null, 5, 2, 3, 1000,
   array['pos','inventory','cash','credit','invoicing','purchases','expenses','payables','quotations','reports'],
   array['Todo lo del Básico', 'Facturación electrónica e-CF (hasta 1,000/mes)', 'Compras, gastos y cuentas por pagar',
         'Cotizaciones', 'Reportes avanzados', '2 sucursales · 5 usuarios'], true, true, 2),
  ('enterprise', 'Empresa', 4990, 85, null, null, null, null, null, null,
   array['Todo lo del plan Negocio', 'Sucursales y usuarios ilimitados', 'e-CF sin tope mensual',
         'Módulos de restaurante y taller', 'Soporte prioritario'], true, false, 3)
on conflict (plan) do update set
  name = excluded.name, price_monthly = excluded.price_monthly, price_usd = excluded.price_usd,
  max_products = excluded.max_products, max_members = excluded.max_members, max_branches = excluded.max_branches,
  max_registers = excluded.max_registers, max_ecf_monthly = excluded.max_ecf_monthly, modules = excluded.modules,
  features = excluded.features, is_offered = excluded.is_offered, is_featured = excluded.is_featured,
  sort_order = excluded.sort_order;

-- Tope genérico: TG_ARGV = (columna de plan_settings, prefijo, nombre en plural).
-- El candado consultivo por empresa+tabla evita que dos altas simultáneas
-- se cuelen ambas por debajo del tope.
create or replace function public.enforce_plan_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_col   text := tg_argv[0];
  v_max   integer;
  v_name  text;
  v_count integer;
begin
  if public.auth_is_platform_admin() then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('ferddo_limit:' || tg_table_name || ':' || new.tenant_id::text));
  execute format('select ps.%I, ps.name from plan_settings ps join subscriptions s on s.plan = ps.plan where s.tenant_id = $1', v_col)
    into v_max, v_name using new.tenant_id;
  if v_max is null then
    return new;
  end if;
  execute format('select count(*) from public.%I where tenant_id = $1', tg_table_name) into v_count using new.tenant_id;
  if v_count >= v_max then
    raise exception '%: El plan % permite máximo % %. Actualiza tu plan para agregar más.', tg_argv[1], v_name, v_max, tg_argv[2];
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_plan_limit() from public, anon;

drop trigger if exists trg_plan_limit on public.products;
create trigger trg_plan_limit before insert on public.products
  for each row execute function public.enforce_plan_limit('max_products', 'PLAN_LIMIT_PRODUCTS', 'productos');
drop trigger if exists trg_plan_limit on public.branches;
create trigger trg_plan_limit before insert on public.branches
  for each row execute function public.enforce_plan_limit('max_branches', 'PLAN_LIMIT_BRANCHES', 'sucursales');
drop trigger if exists trg_plan_limit on public.cash_registers;
create trigger trg_plan_limit before insert on public.cash_registers
  for each row execute function public.enforce_plan_limit('max_registers', 'PLAN_LIMIT_REGISTERS', 'cajas');

drop function if exists public.admin_update_plan(plan_code, text, numeric, numeric, integer, integer, boolean, text[], boolean, boolean, integer);
-- p_patch: cualquier subconjunto de { name, price_monthly, price_usd, features, is_offered,
--   is_featured, sort_order, max_products, max_members, max_branches, max_registers,
--   max_ecf_monthly, modules }. Una clave presente con null = "ilimitado/sin restricción".
create or replace function public.admin_update_plan(p_plan plan_code, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row plan_settings;
  k     text;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  select * into v_row from plan_settings where plan = p_plan for update;
  if not found then
    raise exception 'Plan % no encontrado', p_plan;
  end if;
  if p_patch ? 'name' then
    if nullif(btrim(p_patch ->> 'name'), '') is null then raise exception 'El plan necesita un nombre'; end if;
    v_row.name := btrim(p_patch ->> 'name');
  end if;
  if p_patch ? 'price_monthly' then v_row.price_monthly := (p_patch ->> 'price_monthly')::numeric; end if;
  if p_patch ? 'price_usd' then v_row.price_usd := (p_patch ->> 'price_usd')::numeric; end if;
  if p_patch ? 'features' then
    v_row.features := array(select jsonb_array_elements_text(p_patch -> 'features'));
  end if;
  if p_patch ? 'is_offered' then v_row.is_offered := (p_patch ->> 'is_offered')::boolean; end if;
  if p_patch ? 'is_featured' then v_row.is_featured := (p_patch ->> 'is_featured')::boolean; end if;
  if p_patch ? 'sort_order' then v_row.sort_order := (p_patch ->> 'sort_order')::integer; end if;
  foreach k in array array['max_products', 'max_members', 'max_branches', 'max_registers', 'max_ecf_monthly'] loop
    if p_patch ? k and (p_patch ->> k) is not null and (p_patch ->> k)::integer < (case when k = 'max_ecf_monthly' then 0 else 1 end) then
      raise exception 'Límite inválido para %', k;
    end if;
  end loop;
  if p_patch ? 'max_products' then v_row.max_products := (p_patch ->> 'max_products')::integer; end if;
  if p_patch ? 'max_members' then v_row.max_members := (p_patch ->> 'max_members')::integer; end if;
  if p_patch ? 'max_branches' then v_row.max_branches := (p_patch ->> 'max_branches')::integer; end if;
  if p_patch ? 'max_registers' then v_row.max_registers := (p_patch ->> 'max_registers')::integer; end if;
  if p_patch ? 'max_ecf_monthly' then v_row.max_ecf_monthly := (p_patch ->> 'max_ecf_monthly')::integer; end if;
  if p_patch ? 'modules' then
    v_row.modules := case when jsonb_typeof(p_patch -> 'modules') = 'array'
                          then array(select jsonb_array_elements_text(p_patch -> 'modules')) end;
  end if;
  if v_row.price_monthly < 0 or v_row.price_usd < 0 then
    raise exception 'El precio no puede ser negativo';
  end if;
  if v_row.is_featured then
    update plan_settings set is_featured = false where plan <> p_plan and is_featured;
  end if;
  update plan_settings set
    name = v_row.name, price_monthly = v_row.price_monthly, price_usd = v_row.price_usd, features = v_row.features,
    is_offered = v_row.is_offered, is_featured = v_row.is_featured, sort_order = v_row.sort_order,
    max_products = v_row.max_products, max_members = v_row.max_members, max_branches = v_row.max_branches,
    max_registers = v_row.max_registers, max_ecf_monthly = v_row.max_ecf_monthly, modules = v_row.modules,
    updated_at = now(), updated_by = auth.uid()
  where plan = p_plan
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

-- ── 2. Historial de suscripción ─────────────────────────────────────────────
create table if not exists public.subscription_events (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  plan               plan_code not null,
  status             subscription_status not null,
  trial_ends_at      timestamptz,
  current_period_end timestamptz,
  changed_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now()
);
create index if not exists subscription_events_tenant_idx on public.subscription_events (tenant_id, created_at desc);
create index if not exists subscription_events_changed_by_idx on public.subscription_events (changed_by);
select public._setup_tenant_table('subscription_events', null);
drop policy if exists subscription_events_platform_select on public.subscription_events;
create policy subscription_events_platform_select on public.subscription_events for select to authenticated
  using (public.auth_is_platform_admin() and public.auth_tenant_id() is null);

create or replace function public.log_subscription_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.plan = old.plan and new.status = old.status
     and new.trial_ends_at is not distinct from old.trial_ends_at
     and new.current_period_end is not distinct from old.current_period_end then
    return new;
  end if;
  insert into subscription_events (tenant_id, plan, status, trial_ends_at, current_period_end, changed_by)
  values (new.tenant_id, new.plan, new.status, new.trial_ends_at, new.current_period_end, auth.uid());
  return new;
end;
$$;
revoke all on function public.log_subscription_event() from public, anon;
drop trigger if exists trg_subscription_event on public.subscriptions;
create trigger trg_subscription_event after insert or update on public.subscriptions
  for each row execute function public.log_subscription_event();

create or replace function public.admin_update_subscription(
  p_tenant uuid, p_plan plan_code, p_status subscription_status,
  p_current_period_end timestamptz default null, p_trial_ends_at timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  insert into subscriptions (tenant_id, plan, status, current_period_end, trial_ends_at)
  values (p_tenant, p_plan, p_status, p_current_period_end, p_trial_ends_at)
  on conflict (tenant_id) do update set
    plan = excluded.plan, status = excluded.status,
    current_period_end = coalesce(excluded.current_period_end, subscriptions.current_period_end),
    trial_ends_at = coalesce(excluded.trial_ends_at, subscriptions.trial_ends_at);
end;
$$;

-- ── 3. Siembra de una empresa nueva ─────────────────────────────────────────
create or replace function public.seed_tenant_defaults(p_tenant uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_t      tenants;
  v_branch uuid;
begin
  select * into v_t from tenants where id = p_tenant;
  select id into v_branch from branches where tenant_id = p_tenant and is_main;

  -- Tasas vigentes del ITBIS (18 % general, 16 % para ciertos bienes) y
  -- exento. La empresa puede editarlas o añadir otras en Configuración.
  insert into taxes (tenant_id, name, code, rate, is_default) values
    (p_tenant, 'ITBIS 18%', 'ITBIS18', 0.18, true),
    (p_tenant, 'ITBIS 16%', 'ITBIS16', 0.16, false),
    (p_tenant, 'Exento', 'EXENTO', 0, false)
  on conflict (tenant_id, code) do nothing;

  if v_branch is not null and not exists (select 1 from cash_registers where tenant_id = p_tenant) then
    insert into cash_registers (tenant_id, branch_id, name) values (p_tenant, v_branch, 'Caja 1');
  end if;

  insert into expense_categories (tenant_id, name)
  select p_tenant, x from unnest(array['Alquiler', 'Electricidad', 'Agua', 'Internet y teléfono', 'Transporte',
                                       'Materiales', 'Mantenimiento', 'Nómina', 'Impuestos y tasas', 'Otros gastos']) x
  on conflict (tenant_id, lower(name)) do nothing;

  insert into fiscal_settings (tenant_id, rnc, legal_name, trade_name, fiscal_address, email, phone)
  values (p_tenant, v_t.rnc, v_t.legal_name, v_t.name, v_t.address, v_t.email, v_t.phone)
  on conflict (tenant_id) do nothing;
end;
$$;
revoke all on function public.seed_tenant_defaults(uuid) from public, anon, authenticated;

-- ── 4. Tablero ──────────────────────────────────────────────────────────────
-- Criterios (también en docs/SAAS_IMPLEMENTATION_PLAN.md §Métricas):
--   · Ventas = total cobrado (con ITBIS) de ventas no anuladas, menos devoluciones.
--   · Ticket promedio = ventas del mes / número de ventas no anuladas del mes.
--   · Margen bruto estimado = ventas netas SIN ITBIS − costo de lo vendido
--     (costo promedio al momento de la venta). NO descuenta gastos: no es ganancia.
--   · Días según la zona horaria de la empresa, no la del servidor.
drop function if exists public.dashboard_summary();
create or replace function public.dashboard_summary(p_branch uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  t       uuid := public.auth_tenant_id();
  v_tz    text;
  v_day   timestamptz;
  v_month timestamptz;
  v_30    timestamptz;
begin
  if t is null then
    return '{}'::jsonb;
  end if;
  perform public.require_perm('reports.view');
  select timezone into v_tz from tenants where id = t;
  v_day := date_trunc('day', now() at time zone v_tz) at time zone v_tz;
  v_month := date_trunc('month', now() at time zone v_tz) at time zone v_tz;
  v_30 := v_day - interval '29 days';

  return jsonb_build_object(
    'sales_today', (select coalesce(sum(total - returned_total), 0) from sales
                    where tenant_id = t and status <> 'voided' and created_at >= v_day
                      and (p_branch is null or branch_id = p_branch)),
    'count_today', (select count(*) from sales where tenant_id = t and status <> 'voided' and created_at >= v_day
                      and (p_branch is null or branch_id = p_branch)),
    'sales_month', (select coalesce(sum(total - returned_total), 0) from sales
                    where tenant_id = t and status <> 'voided' and created_at >= v_month
                      and (p_branch is null or branch_id = p_branch)),
    'count_month', (select count(*) from sales where tenant_id = t and status <> 'voided' and created_at >= v_month
                      and (p_branch is null or branch_id = p_branch)),
    'tax_month', (select coalesce(sum(tax_total), 0) from sales where tenant_id = t and status <> 'voided'
                    and created_at >= v_month and (p_branch is null or branch_id = p_branch))
                 - (select coalesce(sum(r.tax_total), 0) from sale_returns r join sales s on s.id = r.sale_id
                    where r.tenant_id = t and r.created_at >= v_month and (p_branch is null or s.branch_id = p_branch)),
    'gross_margin_month', (
      select coalesce(sum(si.subtotal * (si.quantity - si.returned_qty) / si.quantity
                          - si.unit_cost * (si.quantity - si.returned_qty)), 0)
      from sale_items si join sales s on s.id = si.sale_id
      where s.tenant_id = t and s.status <> 'voided' and s.created_at >= v_month
        and (p_branch is null or s.branch_id = p_branch)),
    'payment_methods_month', (
      select coalesce(jsonb_object_agg(method, total), '{}'::jsonb) from (
        select sp.method::text, sum(sp.amount) total
        from sale_payments sp join sales s on s.id = sp.sale_id
        where s.tenant_id = t and s.status <> 'voided' and s.created_at >= v_month
          and (p_branch is null or s.branch_id = p_branch)
        group by sp.method) q),
    'top_products_month', (
      select coalesce(jsonb_agg(row_to_json(q)), '[]'::jsonb) from (
        select si.product_id, max(si.description) as name,
               sum(si.quantity - si.returned_qty) as quantity,
               sum(si.total * (si.quantity - si.returned_qty) / si.quantity)::numeric(14, 2) as amount
        from sale_items si join sales s on s.id = si.sale_id
        where s.tenant_id = t and s.status <> 'voided' and s.created_at >= v_month
          and (p_branch is null or s.branch_id = p_branch)
        group by si.product_id order by amount desc limit 5) q),
    'sales_by_day', (
      select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'total', coalesce(x.total, 0), 'count', coalesce(x.n, 0)) order by d), '[]'::jsonb)
      from generate_series((v_30 at time zone v_tz)::date, (v_day at time zone v_tz)::date, interval '1 day') d
      left join (
        select (created_at at time zone v_tz)::date as day, sum(total - returned_total) total, count(*) n
        from sales where tenant_id = t and status <> 'voided' and created_at >= v_30
          and (p_branch is null or branch_id = p_branch)
        group by 1) x on x.day = d::date),
    'low_stock', (
      select coalesce(jsonb_agg(row_to_json(q)), '[]'::jsonb) from (
        select p.id, p.name, p.min_stock, coalesce(sum(sl.quantity), 0) as stock
        from products p
        left join stock_levels sl on sl.product_id = p.id and (p_branch is null or sl.branch_id = p_branch)
        where p.tenant_id = t and p.is_active and p.track_stock and p.min_stock > 0
        group by p.id having coalesce(sum(sl.quantity), 0) <= p.min_stock
        order by coalesce(sum(sl.quantity), 0) - p.min_stock limit 10) q),
    'low_stock_count', (
      select count(*) from (
        select p.id from products p
        left join stock_levels sl on sl.product_id = p.id and (p_branch is null or sl.branch_id = p_branch)
        where p.tenant_id = t and p.is_active and p.track_stock and p.min_stock > 0
        group by p.id having coalesce(sum(sl.quantity), 0) <= p.min_stock) q),
    'receivables_open', (select coalesce(sum(amount - paid_amount), 0) from receivables where tenant_id = t and status = 'open'),
    'receivables_overdue', (select coalesce(sum(amount - paid_amount), 0) from receivables
                            where tenant_id = t and status = 'open' and due_date < (now() at time zone v_tz)::date),
    'payables_open', (select coalesce(sum(amount - paid_amount), 0) from payables where tenant_id = t and status = 'open'),
    'expenses_month', (select coalesce(sum(amount), 0) from expenses where tenant_id = t and status <> 'voided'
                        and expense_date >= (v_month at time zone v_tz)::date and (p_branch is null or branch_id = p_branch)),
    'ecf_month', (
      select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (
        select status::text, count(*) n from electronic_invoices
        where tenant_id = t and created_at >= v_month group by status) q),
    'open_sessions', (select count(*) from cash_sessions where tenant_id = t and status = 'open'),
    'members', (select count(*) from tenant_members where tenant_id = t and is_active)
  );
end;
$$;

-- ── 5. Reportes ─────────────────────────────────────────────────────────────
-- Fechas en días LOCALES de la empresa: [p_from 00:00, p_to+1 00:00).
create or replace function public.report_sales(p_from date, p_to date, p_group text default 'day', p_branch uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  t    uuid := public.auth_tenant_id();
  v_tz text;
  v_a  timestamptz;
  v_b  timestamptz;
begin
  perform public.require_perm('reports.view');
  if p_to < p_from or p_to - p_from > 370 then
    raise exception 'Rango de fechas inválido (máximo un año)';
  end if;
  select timezone into v_tz from tenants where id = t;
  v_a := p_from::timestamp at time zone v_tz;
  v_b := (p_to + 1)::timestamp at time zone v_tz;

  if p_group = 'day' then
    return (select coalesce(jsonb_agg(row_to_json(q) order by q.key), '[]'::jsonb) from (
      select (created_at at time zone v_tz)::date::text as key, count(*) as count,
             sum(total - returned_total)::numeric(14, 2) as total,
             sum(tax_total)::numeric(14, 2) as tax, sum(discount_total)::numeric(14, 2) as discount
      from sales where tenant_id = t and status <> 'voided' and created_at >= v_a and created_at < v_b
        and (p_branch is null or branch_id = p_branch)
      group by 1) q);
  elsif p_group in ('product', 'category') then
    return (select coalesce(jsonb_agg(row_to_json(q) order by q.total desc), '[]'::jsonb) from (
      select case when p_group = 'product' then max(si.description) else coalesce(max(c.name), 'Sin categoría') end as key,
             sum(si.quantity - si.returned_qty) as quantity,
             sum(si.total * (si.quantity - si.returned_qty) / si.quantity)::numeric(14, 2) as total,
             sum(si.unit_cost * (si.quantity - si.returned_qty))::numeric(14, 2) as cost
      from sale_items si
      join sales s on s.id = si.sale_id
      join products p on p.id = si.product_id
      left join categories c on c.id = p.category_id
      where s.tenant_id = t and s.status <> 'voided' and s.created_at >= v_a and s.created_at < v_b
        and (p_branch is null or s.branch_id = p_branch)
      group by case when p_group = 'product' then si.product_id else p.category_id end) q);
  elsif p_group = 'seller' then
    return (select coalesce(jsonb_agg(row_to_json(q) order by q.total desc), '[]'::jsonb) from (
      select coalesce(max(pr.full_name), 'Sin nombre') as key, count(*) as count,
             sum(s.total - s.returned_total)::numeric(14, 2) as total
      from sales s left join profiles pr on pr.id = s.seller_id
      where s.tenant_id = t and s.status <> 'voided' and s.created_at >= v_a and s.created_at < v_b
        and (p_branch is null or s.branch_id = p_branch)
      group by s.seller_id) q);
  elsif p_group = 'branch' then
    return (select coalesce(jsonb_agg(row_to_json(q) order by q.total desc), '[]'::jsonb) from (
      select max(b.name) as key, count(*) as count, sum(s.total - s.returned_total)::numeric(14, 2) as total
      from sales s join branches b on b.id = s.branch_id
      where s.tenant_id = t and s.status <> 'voided' and s.created_at >= v_a and s.created_at < v_b
      group by s.branch_id) q);
  elsif p_group = 'method' then
    return (select coalesce(jsonb_agg(row_to_json(q) order by q.total desc), '[]'::jsonb) from (
      select sp.method::text as key, count(*) as count, sum(sp.amount)::numeric(14, 2) as total
      from sale_payments sp join sales s on s.id = sp.sale_id
      where s.tenant_id = t and s.status <> 'voided' and s.created_at >= v_a and s.created_at < v_b
        and (p_branch is null or s.branch_id = p_branch)
      group by sp.method) q);
  end if;
  raise exception 'Agrupación desconocida: %', p_group;
end;
$$;

-- ITBIS cobrado en ventas vs. ITBIS pagado en compras y gastos. Es una guía
-- para el contador, no la declaración IT-1.
create or replace function public.report_taxes(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  t    uuid := public.auth_tenant_id();
  v_tz text;
  v_a  timestamptz;
  v_b  timestamptz;
  v_sales numeric; v_returns numeric; v_purch numeric; v_exp numeric;
begin
  perform public.require_perm('reports.view');
  select timezone into v_tz from tenants where id = t;
  v_a := p_from::timestamp at time zone v_tz;
  v_b := (p_to + 1)::timestamp at time zone v_tz;
  select coalesce(sum(tax_total), 0) into v_sales from sales
  where tenant_id = t and status <> 'voided' and created_at >= v_a and created_at < v_b;
  select coalesce(sum(tax_total), 0) into v_returns from sale_returns
  where tenant_id = t and created_at >= v_a and created_at < v_b;
  select coalesce(sum(tax_total), 0) into v_purch from purchases
  where tenant_id = t and status = 'received' and received_at >= v_a and received_at < v_b;
  select coalesce(sum(tax_amount), 0) into v_exp from expenses
  where tenant_id = t and status <> 'voided' and expense_date between p_from and p_to;
  return jsonb_build_object(
    'itbis_sales', v_sales, 'itbis_returns', v_returns, 'itbis_collected', v_sales - v_returns,
    'itbis_purchases', v_purch, 'itbis_expenses', v_exp, 'itbis_paid', v_purch + v_exp,
    'difference', (v_sales - v_returns) - (v_purch + v_exp),
    'by_rate', (select coalesce(jsonb_agg(row_to_json(q)), '[]'::jsonb) from (
      select si.tax_rate, sum(si.subtotal)::numeric(14, 2) as base, sum(si.tax_amount)::numeric(14, 2) as tax
      from sale_items si join sales s on s.id = si.sale_id
      where s.tenant_id = t and s.status <> 'voided' and s.created_at >= v_a and s.created_at < v_b
      group by si.tax_rate order by si.tax_rate desc) q));
end;
$$;

create or replace function public.report_expenses(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(row_to_json(q) order by q.total desc), '[]'::jsonb) from (
    select c.name as key, count(*) as count, sum(e.amount)::numeric(14, 2) as total,
           sum(e.tax_amount)::numeric(14, 2) as tax
    from expenses e join expense_categories c on c.id = e.category_id
    where e.tenant_id = public.auth_tenant_id() and e.status <> 'voided' and e.expense_date between p_from and p_to
      and public.has_perm('reports.view')
    group by c.name) q
$$;

-- Valoración al costo promedio vigente.
create or replace function public.inventory_valuation(p_branch uuid default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'total_cost', coalesce(sum(q.cost_value), 0), 'total_retail', coalesce(sum(q.retail_value), 0),
    'products', count(*),
    'by_category', coalesce((select jsonb_agg(row_to_json(c)) from (
        select category, sum(cost_value)::numeric(14, 2) as cost_value, sum(retail_value)::numeric(14, 2) as retail_value
        from (
          select coalesce(cat.name, 'Sin categoría') as category, sl.quantity * p.cost as cost_value,
                 sl.quantity * p.price as retail_value
          from stock_levels sl join products p on p.id = sl.product_id
          left join categories cat on cat.id = p.category_id
          where sl.tenant_id = public.auth_tenant_id() and sl.quantity > 0
            and (p_branch is null or sl.branch_id = p_branch)) x
        group by category order by 2 desc) c), '[]'::jsonb))
  from (
    select sl.quantity * p.cost as cost_value, sl.quantity * p.price as retail_value
    from stock_levels sl join products p on p.id = sl.product_id
    where sl.tenant_id = public.auth_tenant_id() and sl.quantity > 0
      and (p_branch is null or sl.branch_id = p_branch)
      and (public.has_perm('inventory.view') or public.has_perm('reports.view'))
  ) q
$$;

-- ── 6. Panel global (solo agregados) ────────────────────────────────────────
create or replace function public.admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  return jsonb_build_object(
    'tenants',          (select count(*) from tenants),
    'active_tenants_30d', (select count(distinct tenant_id) from sales where created_at >= now() - interval '30 days'),
    'members',          (select count(*) from tenant_members where is_active),
    'branches',         (select count(*) from branches where is_active),
    'sales_30d',        (select count(*) from sales where created_at >= now() - interval '30 days'),
    'ecf_30d',          (select count(*) from electronic_invoices where created_at >= now() - interval '30 days'),
    'ecf_errors',       (select count(*) from electronic_invoices where status in ('error', 'rejected')),
    'platform_admins',  (select count(*) from platform_admins),
    'by_plan', (select coalesce(jsonb_object_agg(plan_txt, c), '{}'::jsonb)
                from (select plan::text as plan_txt, count(*) c from subscriptions group by plan) q),
    'by_status', (select coalesce(jsonb_object_agg(status_txt, c), '{}'::jsonb)
                  from (select status::text as status_txt, count(*) c from subscriptions group by status) q),
    'by_business_type', (select coalesce(jsonb_object_agg(business_type, c), '{}'::jsonb)
                         from (select business_type, count(*) c from tenants group by business_type) q)
  );
end;
$$;

create or replace function public.admin_list_tenants()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  return (
    select coalesce(jsonb_agg(t_row order by created_at desc), '[]'::jsonb)
    from (
      select t.created_at,
             jsonb_build_object(
               'id', t.id, 'name', t.name, 'rnc', t.rnc, 'business_type', t.business_type,
               'created_at', t.created_at, 'whatsapp', t.whatsapp, 'currency', t.currency,
               'suspended', (t.suspended_at is not null),
               'plan', s.plan, 'sub_status', s.status, 'trial_ends_at', s.trial_ends_at,
               'current_period_end', s.current_period_end,
               'owner_name', o.full_name, 'owner_email', au.email,
               'members', (select count(*) from tenant_members m where m.tenant_id = t.id and m.is_active),
               'branches', (select count(*) from branches b where b.tenant_id = t.id),
               'products', (select count(*) from products p where p.tenant_id = t.id),
               'sales_30d', (select count(*) from sales x where x.tenant_id = t.id and x.created_at >= now() - interval '30 days'),
               'ecf_errors', (select count(*) from electronic_invoices e where e.tenant_id = t.id and e.status in ('error', 'rejected')),
               'last_sale_at', (select max(created_at) from sales x where x.tenant_id = t.id)
             ) as t_row
      from tenants t
      left join subscriptions s on s.tenant_id = t.id
      left join lateral (
        select m.user_id as id, p.full_name from tenant_members m left join profiles p on p.id = m.user_id
        where m.tenant_id = t.id and m.role = 'owner' order by m.created_at limit 1
      ) o on true
      left join auth.users au on au.id = o.id
    ) sub
  );
end;
$$;

create or replace function public.admin_tenant_summary(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  return jsonb_build_object(
    'members',         (select count(*) from tenant_members where tenant_id = p_tenant and is_active),
    'branches',        (select count(*) from branches where tenant_id = p_tenant),
    'registers',       (select count(*) from cash_registers where tenant_id = p_tenant),
    'products',        (select count(*) from products where tenant_id = p_tenant),
    'customers',       (select count(*) from customers where tenant_id = p_tenant),
    'sales_30d',       (select count(*) from sales where tenant_id = p_tenant and created_at >= now() - interval '30 days'),
    'sales_total',     (select count(*) from sales where tenant_id = p_tenant),
    'last_sale_at',    (select max(created_at) from sales where tenant_id = p_tenant),
    'ecf_by_status',   (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (
                          select status::text, count(*) n from electronic_invoices where tenant_id = p_tenant group by status) q),
    'ecf_environment', (select environment from fiscal_settings where tenant_id = p_tenant),
    'ecf_enabled',     (select ecf_enabled from fiscal_settings where tenant_id = p_tenant),
    'pending_invites', (select count(*) from tenant_invites where tenant_id = p_tenant and accepted_at is null and expires_at > now()),
    'subscription_history', (select coalesce(jsonb_agg(jsonb_build_object(
                               'plan', plan, 'status', status, 'created_at', created_at,
                               'current_period_end', current_period_end) order by created_at desc), '[]'::jsonb)
                             from (select * from subscription_events where tenant_id = p_tenant
                                   order by created_at desc limit 20) h)
  );
end;
$$;

-- Tablas de empresa en orden hijo → padre. Una tabla nueva con tenant_id
-- TIENE que entrar aquí o la purga fallará por foreign key.
create or replace function public.tenant_tables_purge_order()
returns text[]
language sql
immutable
as $$
  select array[
    'electronic_invoice_events', 'electronic_invoices', 'fiscal_sequences', 'fiscal_secrets', 'fiscal_settings',
    'receivable_payments', 'payable_payments', 'expenses', 'customer_payments', 'supplier_payments',
    'receivables', 'payables', 'sale_return_items', 'sale_returns', 'sale_payments', 'sale_items', 'sales',
    'quotation_items', 'quotations', 'cash_movements', 'cash_sessions', 'cash_registers',
    'inventory_movements', 'inventory_documents', 'stock_levels', 'purchase_items', 'purchases',
    'products', 'categories', 'taxes', 'customers', 'suppliers', 'expense_categories',
    'document_sequences', 'role_permissions', 'tenant_members', 'branches', 'subscription_events',
    'notifications', 'audit_logs', 'tenant_invites', 'plan_requests', 'subscriptions'
  ]
$$;

create or replace function public.admin_tenant_purge_preview(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set statement_timeout = '20s'
as $$
declare
  v_t      tenants;
  v_tbl    text;
  v_n      bigint;
  v_counts jsonb := '{}'::jsonb;
  v_files  int;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  select * into v_t from tenants where id = p_tenant;
  if not found then
    raise exception 'Negocio no encontrado';
  end if;
  foreach v_tbl in array array['tenant_members', 'branches', 'products', 'customers', 'sales', 'electronic_invoices',
                               'purchases', 'expenses', 'audit_logs'] loop
    execute format('select count(*) from public.%I where tenant_id = $1', v_tbl) into v_n using p_tenant;
    v_counts := v_counts || jsonb_build_object(v_tbl, v_n);
  end loop;
  begin
    select count(*) into v_files from storage.objects
    where bucket_id in ('logos', 'files') and (storage.foldername(name))[1] = p_tenant::text;
  exception when others then
    v_files := null;
  end;
  return jsonb_build_object(
    'tenant_id', v_t.id, 'name', v_t.name, 'suspended', v_t.suspended_at is not null, 'created_at', v_t.created_at,
    'owner_email', (select au.email from tenant_members m join auth.users au on au.id = m.user_id
                    where m.tenant_id = p_tenant and m.role = 'owner' order by m.created_at limit 1),
    'counts', v_counts, 'files', v_files);
end;
$$;

create or replace function public.admin_delete_tenant(p_tenant uuid, p_confirm_name text, p_delete_users boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '50s'
as $$
declare
  v_t      tenants;
  v_tbl    text;
  v_n      bigint;
  v_counts jsonb := '{}'::jsonb;
  v_owner  text;
  v_actor  uuid := auth.uid();
  v_uids   uuid[];
  v_files  bigint := 0;
  v_paths  jsonb := '[]'::jsonb;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  perform pg_advisory_xact_lock(hashtext('ferddo_purge:' || p_tenant::text));
  select * into v_t from tenants where id = p_tenant for update;
  if not found then
    raise exception 'Negocio no encontrado';
  end if;
  if public.norm_name(v_t.name) = '' then
    raise exception 'Este negocio no tiene nombre: ponle uno antes de borrarlo';
  end if;
  if public.norm_name(p_confirm_name) is distinct from public.norm_name(v_t.name) then
    raise exception 'El nombre no coincide: escribe exactamente "%" para confirmar', v_t.name;
  end if;

  select au.email into v_owner from tenant_members m join auth.users au on au.id = m.user_id
  where m.tenant_id = p_tenant and m.role = 'owner' order by m.created_at limit 1;

  -- Solo se ofrecen para borrar las cuentas que NO pertenecen a otra empresa.
  select coalesce(array_agg(m.user_id), '{}'::uuid[]) into v_uids
  from tenant_members m
  where m.tenant_id = p_tenant
    and not exists (select 1 from tenant_members o where o.user_id = m.user_id and o.tenant_id <> p_tenant)
    and not exists (select 1 from platform_admins pa where pa.user_id = m.user_id);

  perform set_config('ferddo.purging_tenant', p_tenant::text, true);

  -- Ciclo cotización ↔ venta: se rompe antes de borrar.
  update quotations set converted_sale_id = null where tenant_id = p_tenant;
  update products set parent_id = null where tenant_id = p_tenant and parent_id is not null;

  foreach v_tbl in array public.tenant_tables_purge_order() loop
    execute format('delete from public.%I where tenant_id = $1', v_tbl) using p_tenant;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object(v_tbl, v_n);
  end loop;

  -- Los perfiles se conservan; su empresa activa pasa a otra membresía o a ninguna.
  update profiles p set
    tenant_id = (select m.tenant_id from tenant_members m where m.user_id = p.id and m.is_active order by m.created_at limit 1),
    role = coalesce((select m.role from tenant_members m where m.user_id = p.id and m.is_active order by m.created_at limit 1), p.role)
  where p.tenant_id = p_tenant;

  begin
    select count(*) into v_files from storage.objects
    where bucket_id in ('logos', 'files') and (storage.foldername(name))[1] = p_tenant::text;
    select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket_id, 'path', name)), '[]'::jsonb) into v_paths
    from (select bucket_id, name from storage.objects
          where bucket_id in ('logos', 'files') and (storage.foldername(name))[1] = p_tenant::text
          order by bucket_id, name limit 20000) f;
  exception when others then
    v_files := -1;
    v_paths := '[]'::jsonb;
  end;
  v_counts := v_counts || jsonb_build_object('files', v_files);

  delete from tenants where id = p_tenant;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('tenants', v_n);

  if p_delete_users and cardinality(v_uids) > 0 then
    begin
      delete from profiles where id = any (v_uids);
      delete from auth.users where id = any (v_uids);
      get diagnostics v_n = row_count;
      v_counts := v_counts || jsonb_build_object('auth_users', v_n);
    exception when insufficient_privilege then
      v_counts := v_counts || jsonb_build_object('auth_users', -1);
    end;
  end if;

  insert into tenant_purges (tenant_id, tenant_name, owner_email, deleted_by, deleted_by_email, deleted_users, counts)
  values (p_tenant, v_t.name, v_owner, v_actor, (select email from auth.users where id = v_actor),
          coalesce(p_delete_users, false), v_counts);
  return jsonb_build_object('tenant_id', p_tenant, 'name', v_t.name, 'counts', v_counts, 'files', v_paths);
end;
$$;

-- request_plan_change exigía ser owner por profiles.role; ahora es un permiso.
create or replace function public.request_plan_change(p_plan plan_code, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.auth_tenant_id();
  v_current plan_code;
  v_offered boolean;
  v_id      uuid;
begin
  perform public.require_perm('subscription.manage');
  select is_offered into v_offered from plan_settings where plan = p_plan;
  if not found then
    raise exception 'Ese plan no existe';
  end if;
  if not v_offered then
    raise exception 'Ese plan ya no se ofrece';
  end if;
  select plan into v_current from subscriptions where tenant_id = v_tenant;
  if v_current = p_plan and (select status from subscriptions where tenant_id = v_tenant) = 'active' then
    raise exception 'Ya tienes el plan solicitado';
  end if;
  perform pg_advisory_xact_lock(hashtext('ferddo_plan_request:' || v_tenant::text));
  select id into v_id from plan_requests where tenant_id = v_tenant and status = 'pending' limit 1;
  if v_id is null then
    insert into plan_requests (tenant_id, requested_plan, note, requested_by)
    values (v_tenant, p_plan, nullif(btrim(p_note), ''), auth.uid())
    returning id into v_id;
  else
    update plan_requests set requested_plan = p_plan, note = coalesce(nullif(btrim(p_note), ''), note),
                             requested_by = auth.uid(), created_at = now()
    where id = v_id;
  end if;
  return v_id;
end;
$$;

-- Consumo de la empresa frente a su plan (pantalla de suscripción).
create or replace function public.my_plan_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  t    uuid := public.auth_tenant_id();
  v_tz text;
begin
  if t is null then
    raise exception 'No autorizado';
  end if;
  select timezone into v_tz from tenants where id = t;
  return jsonb_build_object(
    'products',  (select count(*) from products where tenant_id = t),
    'members',   (select count(*) from tenant_members where tenant_id = t and is_active),
    'branches',  (select count(*) from branches where tenant_id = t),
    'registers', (select count(*) from cash_registers where tenant_id = t),
    'ecf_month', (select count(*) from electronic_invoices where tenant_id = t and status <> 'voided'
                    and created_at >= date_trunc('month', now() at time zone v_tz) at time zone v_tz));
end;
$$;

do $$
declare
  f   text;
  fns text[] := array[
    'public.admin_update_plan(plan_code, jsonb)',
    'public.admin_update_subscription(uuid, plan_code, subscription_status, timestamptz, timestamptz)',
    'public.dashboard_summary(uuid)',
    'public.report_sales(date, date, text, uuid)',
    'public.report_taxes(date, date)',
    'public.report_expenses(date, date)',
    'public.inventory_valuation(uuid)',
    'public.admin_overview()',
    'public.admin_list_tenants()',
    'public.admin_tenant_summary(uuid)',
    'public.admin_tenant_purge_preview(uuid)',
    'public.admin_delete_tenant(uuid, text, boolean)',
    'public.request_plan_change(plan_code, text)',
    'public.my_plan_usage()'
  ];
begin
  foreach f in array fns loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke all on function public.tenant_tables_purge_order() from public, anon, authenticated;

notify pgrst, 'reload schema';
