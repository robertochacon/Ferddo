-- ═══ Ferddo · 0015 · POS: cajas, ventas, devoluciones y cuentas por cobrar ═══
--
-- Por qué así:
--   · TODA venta entra por create_sale(): una sola transacción que calcula los
--     importes definitivos en la base (el cliente solo manda productos,
--     cantidades y pagos), descuenta inventario, registra pagos y movimientos
--     de caja, abre la cuenta por cobrar del crédito y, si se pidió, crea el
--     comprobante fiscal. O pasa todo o no pasa nada.
--   · Idempotencia por `client_uid` (uuid generado en el navegador): si la red
--     se cae después del commit y el POS reintenta, se devuelve la misma venta
--     en vez de cobrar dos veces.
--   · La caja es un libro de movimientos inmutable; el "esperado" del cierre se
--     calcula de esos movimientos, nunca de un contador editable.
--   · Imprimir NO es parte de guardar: la venta existe cuando create_sale()
--     hace commit; el ticket se puede reimprimir cuantas veces haga falta.

-- ── Suscripción operativa ───────────────────────────────────────────────────
-- Vencida la suscripción, los datos se conservan y se pueden consultar, pero
-- no se registran operaciones nuevas (suspensión controlada, sin borrar nada).
create or replace function public.assert_tenant_operational(p_tenant uuid default null)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_s subscriptions;
begin
  select * into v_s from subscriptions where tenant_id = coalesce(p_tenant, public.auth_tenant_id());
  if not found then
    return;
  end if;
  if v_s.status = 'canceled'
     or (v_s.status = 'trial' and v_s.trial_ends_at is not null and v_s.trial_ends_at < now())
     or (v_s.status in ('active', 'past_due') and v_s.current_period_end is not null
         and v_s.current_period_end < now() - interval '7 days') then
    raise exception 'SUBSCRIPTION_EXPIRED: Tu suscripción venció. Tus datos están a salvo; renueva tu plan para seguir registrando operaciones.';
  end if;
end;
$$;

-- ── Cajas ───────────────────────────────────────────────────────────────────
create table if not exists public.cash_registers (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  branch_id  uuid not null,
  name       text not null check (btrim(name) <> ''),
  -- Preferencias del puesto: ancho del papel (58/80), impresora, cajón…
  settings   jsonb not null default '{"paper_width": 80}'::jsonb,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id)
);
create index if not exists cash_registers_tenant_idx on public.cash_registers (tenant_id, branch_id);
select public._setup_tenant_table('cash_registers', 'branches.manage');

create table if not exists public.cash_sessions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  branch_id      uuid not null,
  register_id    uuid not null,
  number         text not null,
  status         cash_session_status not null default 'open',
  opened_by      uuid references auth.users (id) on delete set null default auth.uid(),
  opened_at      timestamptz not null default now(),
  opening_amount numeric(14, 2) not null default 0 check (opening_amount >= 0),
  closed_by      uuid references auth.users (id) on delete set null,
  closed_at      timestamptz,
  expected_cash  numeric(14, 2),
  counted_cash   numeric(14, 2),
  difference     numeric(14, 2),
  totals         jsonb,
  notes          text,
  unique (tenant_id, id),
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id),
  foreign key (tenant_id, register_id) references public.cash_registers (tenant_id, id)
);
create index if not exists cash_sessions_tenant_idx on public.cash_sessions (tenant_id, opened_at desc);
create unique index if not exists cash_sessions_one_open_idx on public.cash_sessions (register_id) where status = 'open';
create index if not exists cash_sessions_opened_by_idx on public.cash_sessions (opened_by);
create index if not exists cash_sessions_closed_by_idx on public.cash_sessions (closed_by);
select public._setup_tenant_table('cash_sessions', null);

create table if not exists public.cash_movements (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  session_id     uuid not null,
  kind           cash_movement_kind not null,
  method         payment_method not null check (method not in ('credit', 'credit_note')),
  amount         numeric(14, 2) not null check (amount <> 0),
  reference_type text,
  reference_id   uuid,
  note           text,
  created_by     uuid references auth.users (id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  foreign key (tenant_id, session_id) references public.cash_sessions (tenant_id, id)
);
create index if not exists cash_movements_session_idx on public.cash_movements (session_id, created_at);
create index if not exists cash_movements_tenant_idx on public.cash_movements (tenant_id, created_at desc);
create index if not exists cash_movements_created_by_idx on public.cash_movements (created_by);
select public._setup_tenant_table('cash_movements', null);
drop trigger if exists trg_immutable on public.cash_movements;
create trigger trg_immutable before update or delete on public.cash_movements
  for each row execute function public.prevent_mutation();

-- Sesión abierta de una caja. `for share`: muchas ventas a la vez pueden
-- leerla, pero el cierre (`for update`) espera a que terminen y ninguna venta
-- se cuela después de calcular el esperado.
create or replace function public.open_session_for(p_register uuid)
returns cash_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s cash_sessions;
begin
  select * into v_s from cash_sessions
  where register_id = p_register and tenant_id = public.auth_tenant_id() and status = 'open'
  for share;
  if not found then
    raise exception 'CASH_SESSION_REQUIRED: La caja está cerrada. Ábrela antes de registrar operaciones.';
  end if;
  return v_s;
end;
$$;
revoke all on function public.open_session_for(uuid) from public, anon, authenticated;

create or replace function public.open_cash_session(p_register uuid, p_opening_amount numeric, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_reg    cash_registers;
  v_num    record;
  v_id     uuid;
begin
  perform public.require_perm('cash.open');
  perform public.assert_tenant_operational();
  select * into v_reg from cash_registers where id = p_register and tenant_id = v_tenant and is_active;
  if not found then
    raise exception 'Caja no encontrada o inactiva';
  end if;
  if not public.can_access_branch(v_reg.branch_id) then
    raise exception 'FORBIDDEN: No tienes acceso a esa sucursal.';
  end if;
  if coalesce(p_opening_amount, 0) < 0 then
    raise exception 'El monto inicial no puede ser negativo';
  end if;
  select * into v_num from public.next_doc_number(v_tenant, 'cash_session');
  begin
    insert into cash_sessions (tenant_id, branch_id, register_id, number, opening_amount, notes)
    values (v_tenant, v_reg.branch_id, p_register, 'CJ-' || v_num.label, coalesce(p_opening_amount, 0),
            nullif(btrim(p_note), ''))
    returning id into v_id;
  exception when unique_violation then
    raise exception 'Esta caja ya está abierta';
  end;
  perform public.log_audit('cash.opened', 'cash_session', v_id, jsonb_build_object('opening', p_opening_amount));
  return v_id;
end;
$$;

create or replace function public.cash_move(p_session uuid, p_kind cash_movement_kind, p_amount numeric, p_note text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_id     uuid;
begin
  perform public.require_perm('cash.move');
  if p_kind not in ('cash_in', 'cash_out') then
    raise exception 'Tipo de movimiento inválido';
  end if;
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;
  if nullif(btrim(p_note), '') is null then
    raise exception 'Indica el motivo del movimiento';
  end if;
  perform 1 from cash_sessions where id = p_session and tenant_id = v_tenant and status = 'open' for share;
  if not found then
    raise exception 'CASH_SESSION_REQUIRED: La caja está cerrada.';
  end if;
  insert into cash_movements (tenant_id, session_id, kind, method, amount, note)
  values (v_tenant, p_session, p_kind, 'cash', case when p_kind = 'cash_out' then -p_amount else p_amount end,
          btrim(p_note))
  returning id into v_id;
  perform public.log_audit('cash.' || p_kind::text, 'cash_session', p_session, jsonb_build_object('amount', p_amount));
  return v_id;
end;
$$;

-- Resumen de una sesión (lo usan el cierre y la reimpresión del arqueo).
create or replace function public.cash_session_report(p_session uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_s      cash_sessions;
  v_cash   numeric;
begin
  select * into v_s from cash_sessions where id = p_session and tenant_id = v_tenant;
  if not found then
    raise exception 'Sesión de caja no encontrada';
  end if;
  if v_s.opened_by is distinct from auth.uid() and not public.has_perm('cash.view_all') then
    raise exception 'FORBIDDEN: Solo puedes ver tus propias cajas.';
  end if;
  select coalesce(sum(amount), 0) into v_cash from cash_movements where session_id = p_session and method = 'cash';
  return jsonb_build_object(
    'session', to_jsonb(v_s),
    'register_name', (select name from cash_registers where id = v_s.register_id),
    'opened_by_name', (select full_name from profiles where id = v_s.opened_by),
    'expected_cash', v_s.opening_amount + v_cash,
    'by_method', (select coalesce(jsonb_object_agg(method, total), '{}'::jsonb) from (
        select method::text, sum(amount) total from cash_movements where session_id = p_session group by method) q),
    'by_kind', (select coalesce(jsonb_object_agg(kind, total), '{}'::jsonb) from (
        select kind::text, sum(amount) total from cash_movements where session_id = p_session group by kind) q),
    'sales_count', (select count(*) from sales where session_id = p_session and status <> 'voided'),
    'sales_total', (select coalesce(sum(total), 0) from sales where session_id = p_session and status <> 'voided'),
    'credit_total', (select coalesce(sum(sp.amount), 0) from sale_payments sp join sales s on s.id = sp.sale_id
                     where s.session_id = p_session and s.status <> 'voided' and sp.method = 'credit')
  );
end;
$$;

create or replace function public.close_cash_session(p_session uuid, p_counted_cash numeric, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_s      cash_sessions;
  v_cash   numeric;
  v_report jsonb;
begin
  perform public.require_perm('cash.close');
  select * into v_s from cash_sessions where id = p_session and tenant_id = v_tenant for update;
  if not found then
    raise exception 'Sesión de caja no encontrada';
  end if;
  if v_s.status <> 'open' then
    raise exception 'Esta caja ya fue cerrada';
  end if;
  if v_s.opened_by is distinct from auth.uid() and not public.has_perm('cash.view_all') then
    raise exception 'FORBIDDEN: Solo puedes cerrar tu propia caja.';
  end if;
  if p_counted_cash is null or p_counted_cash < 0 then
    raise exception 'Indica el efectivo contado';
  end if;
  select coalesce(sum(amount), 0) into v_cash from cash_movements where session_id = p_session and method = 'cash';
  update cash_sessions set
    status        = 'closed',
    closed_by     = auth.uid(),
    closed_at     = now(),
    expected_cash = v_s.opening_amount + v_cash,
    counted_cash  = p_counted_cash,
    difference    = p_counted_cash - (v_s.opening_amount + v_cash),
    totals        = (select coalesce(jsonb_object_agg(method, total), '{}'::jsonb) from (
                      select method::text, sum(amount) total from cash_movements
                      where session_id = p_session group by method) q),
    notes         = coalesce(nullif(btrim(p_notes), ''), notes)
  where id = p_session;
  v_report := public.cash_session_report(p_session);
  perform public.log_audit('cash.closed', 'cash_session', p_session,
                           jsonb_build_object('expected', v_s.opening_amount + v_cash, 'counted', p_counted_cash));
  return v_report;
end;
$$;

-- ── Ventas ──────────────────────────────────────────────────────────────────
create table if not exists public.sales (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  client_uid     uuid not null,
  branch_id      uuid not null,
  register_id    uuid not null,
  session_id     uuid not null,
  seq            bigint not null,
  number         text not null,
  status         sale_status not null default 'completed',
  customer_id    uuid,
  seller_id      uuid references auth.users (id) on delete set null,
  quotation_id   uuid,
  subtotal       numeric(14, 2) not null,
  discount_total numeric(14, 2) not null default 0,
  tax_total      numeric(14, 2) not null default 0,
  total          numeric(14, 2) not null check (total >= 0),
  paid_total     numeric(14, 2) not null default 0,
  change_due     numeric(14, 2) not null default 0,
  credit_amount  numeric(14, 2) not null default 0,
  returned_total numeric(14, 2) not null default 0,
  -- Tipo de e-CF solicitado (31, 32…). NULL = comprobante interno sin valor fiscal.
  ecf_type       text,
  notes          text,
  created_by     uuid references auth.users (id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  voided_at      timestamptz,
  voided_by      uuid references auth.users (id) on delete set null,
  void_reason    text,
  unique (tenant_id, id),
  unique (tenant_id, client_uid),
  unique (tenant_id, seq),
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id),
  foreign key (tenant_id, register_id) references public.cash_registers (tenant_id, id),
  foreign key (tenant_id, session_id) references public.cash_sessions (tenant_id, id),
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id)
);
create index if not exists sales_tenant_date_idx on public.sales (tenant_id, created_at desc);
create index if not exists sales_branch_date_idx on public.sales (tenant_id, branch_id, created_at desc);
create index if not exists sales_customer_idx on public.sales (tenant_id, customer_id);
create index if not exists sales_session_idx on public.sales (session_id);
create index if not exists sales_seller_idx on public.sales (seller_id);
create index if not exists sales_created_by_idx on public.sales (created_by);
create index if not exists sales_voided_by_idx on public.sales (voided_by);
select public._setup_tenant_table('sales', null);
-- Un vendedor ve sus ventas; el resto de la empresa, quien tenga sales.view_all.
drop policy if exists sales_select on public.sales;
create policy sales_select on public.sales for select to authenticated
  using (tenant_id = (select public.auth_tenant_id())
         and ((select public.has_perm('sales.view_all')) or created_by = auth.uid() or seller_id = auth.uid()));

create table if not exists public.sale_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  sale_id     uuid not null,
  line_no     integer not null,
  product_id  uuid not null,
  description text not null,
  quantity    numeric(14, 3) not null check (quantity > 0),
  unit_price  numeric(14, 2) not null check (unit_price >= 0),
  discount    numeric(14, 2) not null default 0 check (discount >= 0),
  tax_id      uuid,
  tax_rate    numeric(7, 4) not null default 0,
  subtotal    numeric(14, 2) not null,
  tax_amount  numeric(14, 2) not null default 0,
  total       numeric(14, 2) not null,
  unit_cost   numeric(14, 4) not null default 0,
  returned_qty numeric(14, 3) not null default 0 check (returned_qty >= 0 and returned_qty <= quantity),
  unique (tenant_id, id),
  foreign key (tenant_id, sale_id) references public.sales (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references public.products (tenant_id, id)
);
create index if not exists sale_items_sale_idx on public.sale_items (sale_id);
create index if not exists sale_items_product_idx on public.sale_items (tenant_id, product_id);
select public._setup_tenant_table('sale_items', null);

create table if not exists public.sale_payments (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  sale_id    uuid not null,
  method     payment_method not null check (method <> 'credit_note'),
  -- Monto APLICADO a la venta. En efectivo, `tendered` es lo que entregó el
  -- cliente y la diferencia es la devuelta.
  amount     numeric(14, 2) not null check (amount > 0),
  tendered   numeric(14, 2),
  reference  text,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, sale_id) references public.sales (tenant_id, id) on delete cascade
);
create index if not exists sale_payments_sale_idx on public.sale_payments (sale_id);
create index if not exists sale_payments_tenant_idx on public.sale_payments (tenant_id, method);
select public._setup_tenant_table('sale_payments', null);

-- ── Cuentas por cobrar ──────────────────────────────────────────────────────
create table if not exists public.receivables (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  customer_id uuid not null,
  sale_id     uuid,
  description text,
  amount      numeric(14, 2) not null check (amount > 0),
  -- Caché de la suma de receivable_payments, mantenida por trigger en la
  -- misma transacción. La función reconcile_receivables() la verifica.
  paid_amount numeric(14, 2) not null default 0,
  due_date    date not null,
  status      document_status not null default 'open',
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  check (paid_amount >= 0 and paid_amount <= amount),
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id),
  foreign key (tenant_id, sale_id) references public.sales (tenant_id, id)
);
create index if not exists receivables_customer_idx on public.receivables (tenant_id, customer_id, status);
create index if not exists receivables_due_idx on public.receivables (tenant_id, status, due_date);
create index if not exists receivables_sale_idx on public.receivables (sale_id);
select public._setup_tenant_table('receivables', null);

create table if not exists public.customer_payments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  client_uid  uuid not null,
  number      text not null,
  customer_id uuid not null,
  amount      numeric(14, 2) not null check (amount > 0),
  method      payment_method not null check (method not in ('credit', 'credit_note')),
  session_id  uuid,
  reference   text,
  note        text,
  created_by  uuid references auth.users (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, client_uid),
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id),
  foreign key (tenant_id, session_id) references public.cash_sessions (tenant_id, id)
);
create index if not exists customer_payments_customer_idx on public.customer_payments (tenant_id, customer_id, created_at desc);
create index if not exists customer_payments_created_by_idx on public.customer_payments (created_by);
select public._setup_tenant_table('customer_payments', null);

create table if not exists public.receivable_payments (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete cascade,
  receivable_id       uuid not null,
  customer_payment_id uuid,
  sale_return_id      uuid,
  method              payment_method not null,
  amount              numeric(14, 2) not null check (amount > 0),
  created_at          timestamptz not null default now(),
  foreign key (tenant_id, receivable_id) references public.receivables (tenant_id, id),
  foreign key (tenant_id, customer_payment_id) references public.customer_payments (tenant_id, id)
);
create index if not exists receivable_payments_receivable_idx on public.receivable_payments (receivable_id);
create index if not exists receivable_payments_cp_idx on public.receivable_payments (customer_payment_id);
select public._setup_tenant_table('receivable_payments', null);
drop trigger if exists trg_immutable on public.receivable_payments;
create trigger trg_immutable before update or delete on public.receivable_payments
  for each row execute function public.prevent_mutation();

create or replace function public.apply_receivable_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- El check (paid_amount <= amount) de la tabla rechaza un sobrepago aquí,
  -- aunque la RPC que lo origine tuviera un bug.
  update receivables
     set paid_amount = paid_amount + new.amount,
         status = case when paid_amount + new.amount >= amount then 'paid' else 'open' end::document_status
   where id = new.receivable_id and tenant_id = new.tenant_id;
  return new;
end;
$$;
revoke all on function public.apply_receivable_payment() from public, anon;
drop trigger if exists trg_apply_receivable_payment on public.receivable_payments;
create trigger trg_apply_receivable_payment after insert on public.receivable_payments
  for each row execute function public.apply_receivable_payment();

-- Saldo por cliente, DERIVADO de las cuentas abiertas. security_invoker: la
-- vista respeta la RLS de quien consulta, no la del dueño de la vista.
create or replace view public.customer_balances with (security_invoker = true) as
select tenant_id, customer_id,
       sum(amount - paid_amount)::numeric(14, 2) as balance,
       min(due_date) as oldest_due,
       count(*) as open_documents
from public.receivables
where status = 'open'
group by tenant_id, customer_id;
grant select on public.customer_balances to authenticated;
revoke all on public.customer_balances from anon;

-- ── Motor de cálculo (fuente única de los importes) ────────────────────────
-- Recibe líneas [{product_id, quantity, unit_price?, discount?}] y un
-- descuento global; devuelve las líneas con base, ITBIS y total redondeados
-- al centavo, y los totales. Lo usan ventas Y cotizaciones: un solo sitio
-- donde vive la regla del impuesto incluido/excluido. src/lib/pricing.ts es
-- un espejo SOLO para la vista previa del carrito; el importe que vale es este.
create or replace function public.price_lines(
  p_tenant          uuid,
  p_items           jsonb,
  p_global_discount numeric default 0,
  p_enforce_perms   boolean default true
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_incl     boolean;
  v_item     jsonb;
  v_p        products;
  v_rate     numeric;
  v_qty      numeric;
  v_price    numeric;
  v_disc     numeric;
  v_gross    numeric;
  v_lines    jsonb := '[]'::jsonb;
  v_net_sum  numeric := 0;
  v_gd       numeric := round(coalesce(p_global_discount, 0), 2);
  v_alloc    numeric;
  v_alloc_left numeric;
  v_i        int := 0;
  v_n        int;
  v_line     jsonb;
  v_net      numeric;
  v_base     numeric;
  v_tax      numeric;
  v_total    numeric;
  v_out      jsonb := '[]'::jsonb;
  v_sub      numeric := 0;
  v_taxsum   numeric := 0;
  v_dsum     numeric := 0;
  v_tsum     numeric := 0;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Agrega al menos un producto';
  end if;
  if jsonb_array_length(p_items) > 500 then
    raise exception 'Demasiadas líneas en un solo documento';
  end if;
  select prices_include_tax into v_incl from tenants where id = p_tenant;

  -- Pasada 1: validar y calcular el neto de cada línea.
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_p from products
    where id = (v_item ->> 'product_id')::uuid and tenant_id = p_tenant;
    if not found then
      raise exception 'Producto no encontrado';
    end if;
    if not v_p.is_active then
      raise exception '"%" está inactivo', v_p.name;
    end if;
    v_qty := round((v_item ->> 'quantity')::numeric, 3);
    if v_qty is null or v_qty <= 0 then
      raise exception 'Cantidad inválida para "%"', v_p.name;
    end if;
    v_price := round(coalesce((v_item ->> 'unit_price')::numeric, v_p.price), 2);
    if v_price < 0 then
      raise exception 'Precio inválido para "%"', v_p.name;
    end if;
    if p_enforce_perms and v_price <> v_p.price and not public.has_perm('sales.price_override') then
      raise exception 'FORBIDDEN: No tienes permiso para cambiar el precio de "%".', v_p.name;
    end if;
    v_disc := round(coalesce((v_item ->> 'discount')::numeric, 0), 2);
    v_gross := round(v_qty * v_price, 2);
    if v_disc < 0 or v_disc > v_gross then
      raise exception 'Descuento inválido para "%"', v_p.name;
    end if;
    select coalesce(rate, 0) into v_rate from taxes where id = v_p.tax_id and tenant_id = p_tenant;
    v_rate := coalesce(v_rate, 0);
    v_lines := v_lines || jsonb_build_object(
      'product_id', v_p.id, 'description', coalesce(nullif(btrim(v_item ->> 'description'), ''),
                                                    v_p.name || coalesce(' ' || v_p.variant_label, '')),
      'quantity', v_qty, 'unit_price', v_price, 'line_discount', v_disc, 'gross', v_gross,
      'tax_id', v_p.tax_id, 'tax_rate', v_rate, 'unit_cost', v_p.cost,
      'track_stock', v_p.track_stock, 'kind', v_p.kind);
    v_net_sum := v_net_sum + (v_gross - v_disc);
  end loop;

  if v_gd < 0 or v_gd > v_net_sum then
    raise exception 'El descuento general no puede superar el total';
  end if;
  if p_enforce_perms and (v_gd > 0 or exists (
        select 1 from jsonb_array_elements(v_lines) l where (l ->> 'line_discount')::numeric > 0))
     and not public.has_perm('sales.discount') then
    raise exception 'FORBIDDEN: No tienes permiso para aplicar descuentos.';
  end if;

  -- Pasada 2: repartir el descuento global en proporción al neto de cada
  -- línea (la última se lleva el residuo del redondeo) y calcular el ITBIS.
  v_n := jsonb_array_length(v_lines);
  v_alloc_left := v_gd;
  for v_line in select * from jsonb_array_elements(v_lines) loop
    v_i := v_i + 1;
    v_net := (v_line ->> 'gross')::numeric - (v_line ->> 'line_discount')::numeric;
    if v_gd = 0 or v_net_sum = 0 then
      v_alloc := 0;
    elsif v_i = v_n then
      v_alloc := v_alloc_left;
    else
      v_alloc := round(v_gd * v_net / v_net_sum, 2);
    end if;
    v_alloc_left := v_alloc_left - v_alloc;
    v_net := v_net - v_alloc;
    v_rate := (v_line ->> 'tax_rate')::numeric;
    if v_incl then
      v_total := v_net;
      v_base := round(v_total / (1 + v_rate), 2);
      v_tax := v_total - v_base;
    else
      v_base := v_net;
      v_tax := round(v_base * v_rate, 2);
      v_total := v_base + v_tax;
    end if;
    v_out := v_out || (v_line - 'gross' - 'line_discount' || jsonb_build_object(
      'line_no', v_i,
      'discount', (v_line ->> 'line_discount')::numeric + v_alloc,
      'subtotal', v_base, 'tax_amount', v_tax, 'total', v_total));
    v_sub := v_sub + v_base;
    v_taxsum := v_taxsum + v_tax;
    v_dsum := v_dsum + (v_line ->> 'line_discount')::numeric + v_alloc;
    v_tsum := v_tsum + v_total;
  end loop;

  return jsonb_build_object('lines', v_out, 'subtotal', v_sub, 'discount_total', v_dsum,
                            'tax_total', v_taxsum, 'total', v_tsum, 'prices_include_tax', v_incl);
end;
$$;
revoke all on function public.price_lines(uuid, jsonb, numeric, boolean) from public, anon, authenticated;

-- Vista previa autoritativa (la misma función que usará la venta).
create or replace function public.preview_totals(p_items jsonb, p_global_discount numeric default 0)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.price_lines(public.auth_tenant_id(), p_items, p_global_discount, false)
  where public.auth_tenant_id() is not null
$$;

-- ── create_sale ─────────────────────────────────────────────────────────────
-- p_payload:
-- { client_uid, register_id, customer_id?, seller_id?, quotation_id?, notes?,
--   items: [{product_id, quantity, unit_price?, discount?, description?}],
--   global_discount?, ecf_type?,
--   payments: [{method, amount, reference?}] }   ← en efectivo, amount = lo entregado
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

  v_calc := public.price_lines(v_tenant, p_payload -> 'items', coalesce((p_payload ->> 'global_discount')::numeric, 0), true);
  v_total := (v_calc ->> 'total')::numeric;

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
      else v_noncash := v_noncash + v_amt;
    end case;
  end loop;

  v_paid := v_cash_in + v_noncash + v_credit;
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
                     change_due, credit_amount, ecf_type, notes)
  values (v_tenant, v_uid, v_reg.branch_id, v_reg.id, v_session.id, v_num.seq, v_num.label, v_customer.id,
          v_seller, v_quote, (v_calc ->> 'subtotal')::numeric, (v_calc ->> 'discount_total')::numeric,
          (v_calc ->> 'tax_total')::numeric, v_total, v_total, v_change, v_credit, v_ecf,
          nullif(btrim(p_payload ->> 'notes'), ''))
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
    if v_method <> 'credit' then
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

  if v_ecf is not null then
    v_ecf_res := public.ecf_create_for_sale(v_sale_id, v_ecf);
  end if;

  return jsonb_build_object('sale_id', v_sale_id, 'number', v_num.label, 'total', v_total,
                            'change_due', (select change_due from sales where id = v_sale_id),
                            'ecf', v_ecf_res, 'replayed', false);
end;
$$;

-- ── Anulación ──────────────────────────────────────────────────────────────
-- Solo mientras su caja siga abierta y sin comprobante fiscal emitido: una
-- vez cerrada la caja o enviado el e-CF, lo que corresponde es una
-- devolución (y su nota de crédito), que deja rastro en otro documento.
create or replace function public.void_sale(p_sale uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_s      sales;
  v_mv     record;
begin
  perform public.require_perm('sales.void');
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Indica el motivo de la anulación';
  end if;
  select * into v_s from sales where id = p_sale and tenant_id = v_tenant for update;
  if not found then
    raise exception 'Venta no encontrada';
  end if;
  if v_s.status <> 'completed' then
    raise exception 'Solo se anulan ventas completadas sin devoluciones';
  end if;
  perform 1 from cash_sessions where id = v_s.session_id and status = 'open' for share;
  if not found then
    raise exception 'La caja de esta venta ya cerró: registra una devolución en su lugar.';
  end if;
  if exists (select 1 from electronic_invoices where source_type = 'sale' and source_id = p_sale
             and status not in ('error', 'voided')) then
    raise exception 'Esta venta tiene comprobante fiscal: registra una devolución para emitir la nota de crédito.';
  end if;
  if exists (select 1 from receivables r where r.sale_id = p_sale and r.paid_amount > 0) then
    raise exception 'Esta venta a crédito ya tiene abonos: registra una devolución.';
  end if;

  for v_mv in select * from inventory_movements where reference_type = 'sale' and reference_id = p_sale and kind = 'sale' loop
    insert into inventory_movements (tenant_id, branch_id, product_id, kind, quantity, unit_cost,
                                     reference_type, reference_id, line_ref, reason)
    values (v_tenant, v_mv.branch_id, v_mv.product_id, 'sale_void', -v_mv.quantity, v_mv.unit_cost,
            'sale', p_sale, v_mv.line_ref, 'Anulación ' || v_s.number);
  end loop;

  insert into cash_movements (tenant_id, session_id, kind, method, amount, reference_type, reference_id, note)
  select v_tenant, session_id, 'sale_void', method, -amount, 'sale', p_sale, btrim(p_reason)
  from cash_movements where reference_type = 'sale' and reference_id = p_sale and kind = 'sale';

  update receivables set status = 'canceled' where sale_id = p_sale and status = 'open';
  update electronic_invoices set status = 'voided' where source_type = 'sale' and source_id = p_sale and status = 'error';
  update sales set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason)
  where id = p_sale;
  perform public.log_audit('sale.voided', 'sale', p_sale, jsonb_build_object('reason', p_reason, 'total', v_s.total));
end;
$$;

-- ── Devoluciones ────────────────────────────────────────────────────────────
create table if not exists public.sale_returns (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  client_uid    uuid not null,
  sale_id       uuid not null,
  number        text not null,
  session_id    uuid,
  refund_method payment_method not null,
  restock       boolean not null default true,
  subtotal      numeric(14, 2) not null,
  tax_total     numeric(14, 2) not null,
  total         numeric(14, 2) not null check (total > 0),
  reason        text not null,
  created_by    uuid references auth.users (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, client_uid),
  foreign key (tenant_id, sale_id) references public.sales (tenant_id, id),
  foreign key (tenant_id, session_id) references public.cash_sessions (tenant_id, id)
);
create index if not exists sale_returns_sale_idx on public.sale_returns (sale_id);
create index if not exists sale_returns_tenant_idx on public.sale_returns (tenant_id, created_at desc);
create index if not exists sale_returns_created_by_idx on public.sale_returns (created_by);
select public._setup_tenant_table('sale_returns', null);

create table if not exists public.sale_return_items (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  return_id    uuid not null,
  sale_item_id uuid not null,
  quantity     numeric(14, 3) not null check (quantity > 0),
  subtotal     numeric(14, 2) not null,
  tax_amount   numeric(14, 2) not null,
  total        numeric(14, 2) not null,
  foreign key (tenant_id, return_id) references public.sale_returns (tenant_id, id) on delete cascade,
  foreign key (tenant_id, sale_item_id) references public.sale_items (tenant_id, id)
);
create index if not exists sale_return_items_return_idx on public.sale_return_items (return_id);
create index if not exists sale_return_items_item_idx on public.sale_return_items (sale_item_id);
select public._setup_tenant_table('sale_return_items', null);

-- p_payload: { client_uid, sale_id, register_id?, refund_method, reason, restock?,
--              items: [{sale_item_id, quantity}] }
create or replace function public.return_sale(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.auth_tenant_id();
  v_uid     uuid := (p_payload ->> 'client_uid')::uuid;
  v_s       sales;
  v_ret     uuid;
  v_num     record;
  v_line    jsonb;
  v_si      sale_items;
  v_qty     numeric;
  v_total   numeric;
  v_tax     numeric;
  v_sum     numeric := 0;
  v_taxsum  numeric := 0;
  v_method  payment_method := (p_payload ->> 'refund_method')::payment_method;
  v_restock boolean := coalesce((p_payload ->> 'restock')::boolean, true);
  v_session cash_sessions;
  v_rcv     receivables;
  v_track   boolean;
  v_ecf_id  uuid;
  v_ecf_res jsonb;
begin
  perform public.require_perm('sales.return');
  if v_uid is null then
    raise exception 'Falta el identificador de la operación (client_uid)';
  end if;
  select id into v_ret from sale_returns where tenant_id = v_tenant and client_uid = v_uid;
  if v_ret is not null then
    return jsonb_build_object('return_id', v_ret, 'replayed', true);
  end if;
  perform public.assert_tenant_operational();
  if nullif(btrim(p_payload ->> 'reason'), '') is null then
    raise exception 'Indica el motivo de la devolución';
  end if;
  if v_method in ('credit') then
    raise exception 'Método de reembolso inválido';
  end if;

  select * into v_s from sales where id = (p_payload ->> 'sale_id')::uuid and tenant_id = v_tenant for update;
  if not found then
    raise exception 'Venta no encontrada';
  end if;
  if v_s.status in ('voided', 'returned') then
    raise exception 'Esta venta ya fue anulada o devuelta por completo';
  end if;

  if v_method in ('cash', 'card', 'transfer', 'other') then
    select * into v_session from cash_sessions
    where register_id = (p_payload ->> 'register_id')::uuid and tenant_id = v_tenant and status = 'open'
    for share;
    if not found then
      raise exception 'CASH_SESSION_REQUIRED: Abre una caja para devolver dinero.';
    end if;
  end if;

  select * into v_num from public.next_doc_number(v_tenant, 'sale_return');
  insert into sale_returns (tenant_id, client_uid, sale_id, number, session_id, refund_method, restock,
                            subtotal, tax_total, total, reason)
  values (v_tenant, v_uid, v_s.id, 'DV-' || v_num.label, v_session.id, v_method, v_restock, 0, 0, 0.01,
          btrim(p_payload ->> 'reason'))
  returning id into v_ret;

  for v_line in select * from jsonb_array_elements(p_payload -> 'items') loop
    v_qty := round((v_line ->> 'quantity')::numeric, 3);
    if v_qty is null or v_qty <= 0 then
      continue;
    end if;
    select * into v_si from sale_items
    where id = (v_line ->> 'sale_item_id')::uuid and sale_id = v_s.id for update;
    if not found then
      raise exception 'La línea no pertenece a esta venta';
    end if;
    if v_si.returned_qty + v_qty > v_si.quantity then
      raise exception 'De "%" solo quedan % por devolver', v_si.description, v_si.quantity - v_si.returned_qty;
    end if;
    -- Proporcional a lo cobrado en la línea (ya con descuentos e impuesto).
    if v_si.returned_qty + v_qty = v_si.quantity then
      -- Última unidad: se lleva el residuo para que la suma cuadre al centavo.
      v_total := v_si.total - coalesce((select sum(total) from sale_return_items where sale_item_id = v_si.id), 0);
      v_tax := v_si.tax_amount - coalesce((select sum(tax_amount) from sale_return_items where sale_item_id = v_si.id), 0);
    else
      v_total := round(v_si.total * v_qty / v_si.quantity, 2);
      v_tax := round(v_si.tax_amount * v_qty / v_si.quantity, 2);
    end if;
    insert into sale_return_items (tenant_id, return_id, sale_item_id, quantity, subtotal, tax_amount, total)
    values (v_tenant, v_ret, v_si.id, v_qty, v_total - v_tax, v_tax, v_total);
    update sale_items set returned_qty = returned_qty + v_qty where id = v_si.id;

    select track_stock into v_track from products where id = v_si.product_id;
    if v_restock and v_track and exists (
        select 1 from inventory_movements where reference_type = 'sale' and reference_id = v_s.id and line_ref = v_si.id) then
      insert into inventory_movements (tenant_id, branch_id, product_id, kind, quantity, unit_cost,
                                       reference_type, reference_id, line_ref, reason)
      values (v_tenant, v_s.branch_id, v_si.product_id, 'sale_return', v_qty, v_si.unit_cost,
              'sale_return', v_ret, v_si.id, 'Devolución ' || v_num.label);
    end if;
    v_sum := v_sum + v_total;
    v_taxsum := v_taxsum + v_tax;
  end loop;

  if v_sum <= 0 then
    raise exception 'La devolución no tiene líneas';
  end if;
  update sale_returns set subtotal = v_sum - v_taxsum, tax_total = v_taxsum, total = v_sum where id = v_ret;

  if v_method = 'credit_note' then
    -- Se descuenta de lo que el cliente aún debe por esta venta.
    select * into v_rcv from receivables where sale_id = v_s.id and status = 'open' for update;
    if not found or v_rcv.amount - v_rcv.paid_amount < v_sum then
      raise exception 'El saldo pendiente de esta venta no cubre la devolución; reembolsa por otro método.';
    end if;
    insert into receivable_payments (tenant_id, receivable_id, sale_return_id, method, amount)
    values (v_tenant, v_rcv.id, v_ret, 'credit_note', v_sum);
  else
    insert into cash_movements (tenant_id, session_id, kind, method, amount, reference_type, reference_id, note)
    values (v_tenant, v_session.id, 'refund', v_method, -v_sum, 'sale_return', v_ret, 'Devolución ' || v_num.label);
  end if;

  update sales set
    returned_total = returned_total + v_sum,
    status = case when (select bool_and(returned_qty = quantity) from sale_items where sale_id = v_s.id)
                  then 'returned' else 'partially_returned' end::sale_status
  where id = v_s.id;

  -- Si la venta tenía e-CF válido, la devolución exige su nota de crédito (34).
  -- (electronic_invoices se crea en la 0016: aquí solo se usa su id).
  select id into v_ecf_id from electronic_invoices
  where source_type = 'sale' and source_id = v_s.id and status not in ('error', 'voided', 'rejected')
  order by created_at limit 1;
  if v_ecf_id is not null then
    v_ecf_res := public.ecf_create_credit_note(v_ret, v_ecf_id);
  end if;

  perform public.log_audit('sale.returned', 'sale_return', v_ret,
                           jsonb_build_object('sale', v_s.number, 'total', v_sum, 'method', v_method));
  return jsonb_build_object('return_id', v_ret, 'number', 'DV-' || v_num.label, 'total', v_sum,
                            'ecf', v_ecf_res, 'replayed', false);
end;
$$;

-- ── Cobros a clientes ───────────────────────────────────────────────────────
-- p_payload: { client_uid, customer_id, amount, method, register_id?, receivable_id?, reference?, note? }
-- Sin receivable_id el abono se aplica a las cuentas más antiguas primero.
create or replace function public.receive_customer_payment(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.auth_tenant_id();
  v_uid     uuid := (p_payload ->> 'client_uid')::uuid;
  v_amount  numeric := round((p_payload ->> 'amount')::numeric, 2);
  v_method  payment_method := (p_payload ->> 'method')::payment_method;
  v_cust    customers;
  v_session cash_sessions;
  v_pay     uuid;
  v_num     record;
  v_left    numeric;
  v_r       receivables;
  v_apply   numeric;
  v_open    numeric;
begin
  perform public.require_perm('receivables.manage');
  perform public.require_module('credit');
  if v_uid is null then
    raise exception 'Falta el identificador de la operación (client_uid)';
  end if;
  select id into v_pay from customer_payments where tenant_id = v_tenant and client_uid = v_uid;
  if v_pay is not null then
    return jsonb_build_object('payment_id', v_pay, 'replayed', true);
  end if;
  perform public.assert_tenant_operational();
  if v_amount is null or v_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;
  if v_method in ('credit', 'credit_note') then
    raise exception 'Método de pago inválido';
  end if;
  select * into v_cust from customers where id = (p_payload ->> 'customer_id')::uuid and tenant_id = v_tenant for update;
  if not found then
    raise exception 'Cliente no encontrado';
  end if;
  select coalesce(sum(amount - paid_amount), 0) into v_open
  from receivables
  where tenant_id = v_tenant and customer_id = v_cust.id and status = 'open'
    and ((p_payload ->> 'receivable_id') is null or id = (p_payload ->> 'receivable_id')::uuid);
  if v_amount > v_open then
    raise exception 'El abono (%) supera lo que debe el cliente (%)', v_amount, v_open;
  end if;

  if (p_payload ->> 'register_id') is not null then
    v_session := public.open_session_for((p_payload ->> 'register_id')::uuid);
  elsif v_method = 'cash' then
    raise exception 'CASH_SESSION_REQUIRED: Para cobrar en efectivo selecciona una caja abierta.';
  end if;

  select * into v_num from public.next_doc_number(v_tenant, 'customer_payment');
  insert into customer_payments (tenant_id, client_uid, number, customer_id, amount, method, session_id, reference, note)
  values (v_tenant, v_uid, 'RC-' || v_num.label, v_cust.id, v_amount, v_method, v_session.id,
          nullif(p_payload ->> 'reference', ''), nullif(p_payload ->> 'note', ''))
  returning id into v_pay;

  v_left := v_amount;
  for v_r in
    select * from receivables
    where tenant_id = v_tenant and customer_id = v_cust.id and status = 'open'
      and ((p_payload ->> 'receivable_id') is null or id = (p_payload ->> 'receivable_id')::uuid)
    order by due_date, created_at
    for update
  loop
    exit when v_left <= 0;
    v_apply := least(v_left, v_r.amount - v_r.paid_amount);
    insert into receivable_payments (tenant_id, receivable_id, customer_payment_id, method, amount)
    values (v_tenant, v_r.id, v_pay, v_method, v_apply);
    v_left := v_left - v_apply;
  end loop;

  if v_session.id is not null then
    insert into cash_movements (tenant_id, session_id, kind, method, amount, reference_type, reference_id)
    values (v_tenant, v_session.id, 'receivable_payment', v_method, v_amount, 'customer_payment', v_pay);
  end if;
  perform public.log_audit('receivable.payment', 'customer_payment', v_pay,
                           jsonb_build_object('customer', v_cust.name, 'amount', v_amount));
  return jsonb_build_object('payment_id', v_pay, 'number', 'RC-' || v_num.label, 'replayed', false);
end;
$$;

-- Antigüedad de saldos (0-30, 31-60, 61-90, +90 días vencidos).
create or replace function public.receivables_aging()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(row_to_json(q) order by q.total desc), '[]'::jsonb)
  from (
    select r.customer_id, c.name as customer_name,
           sum(r.amount - r.paid_amount) as total,
           sum(r.amount - r.paid_amount) filter (where r.due_date >= current_date) as current,
           sum(r.amount - r.paid_amount) filter (where current_date - r.due_date between 1 and 30) as d1_30,
           sum(r.amount - r.paid_amount) filter (where current_date - r.due_date between 31 and 60) as d31_60,
           sum(r.amount - r.paid_amount) filter (where current_date - r.due_date between 61 and 90) as d61_90,
           sum(r.amount - r.paid_amount) filter (where current_date - r.due_date > 90) as d90_plus
    from receivables r join customers c on c.id = r.customer_id
    where r.tenant_id = public.auth_tenant_id() and r.status = 'open'
    group by r.customer_id, c.name
  ) q
  where public.has_perm('receivables.manage') or public.has_perm('reports.view')
$$;

-- Verificación de consistencia: la caché paid_amount contra los abonos.
-- Debe devolver una lista vacía; se usa en las pruebas y en soporte.
create or replace function public.reconcile_receivables()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('receivable_id', r.id, 'cached', r.paid_amount, 'actual', coalesce(p.s, 0))), '[]'::jsonb)
  from receivables r
  left join (select receivable_id, sum(amount) s from receivable_payments group by receivable_id) p on p.receivable_id = r.id
  where r.tenant_id = public.auth_tenant_id() and r.paid_amount <> coalesce(p.s, 0)
$$;

do $$
declare
  f   text;
  fns text[] := array[
    'public.open_cash_session(uuid, numeric, text)',
    'public.cash_move(uuid, cash_movement_kind, numeric, text)',
    'public.cash_session_report(uuid)',
    'public.close_cash_session(uuid, numeric, text)',
    'public.preview_totals(jsonb, numeric)',
    'public.create_sale(jsonb)',
    'public.void_sale(uuid, text)',
    'public.return_sale(jsonb)',
    'public.receive_customer_payment(jsonb)',
    'public.receivables_aging()',
    'public.reconcile_receivables()',
    'public.assert_tenant_operational(uuid)'
  ];
begin
  foreach f in array fns loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
