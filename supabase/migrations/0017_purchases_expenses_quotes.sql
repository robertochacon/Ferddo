-- ═══ Ferddo · 0017 · Compras, cuentas por pagar, gastos y cotizaciones ═══
--
-- Por qué así:
--   · La compra se GUARDA (borrador/orden) y se RECIBE en dos pasos. Solo la
--     recepción mueve inventario y crea la deuda, una única vez: el estado se
--     comprueba bajo candado y el índice único de inventory_movements
--     (documento + línea + tipo) hace imposible duplicar la entrada aunque se
--     reprocese.
--   · Cuentas por pagar con el mismo patrón que las por cobrar: documento +
--     abonos inmutables + caché del pagado mantenida por trigger.
--   · La cotización reutiliza price_lines() (mismo cálculo que la venta) y se
--     convierte pasando su id a create_sale(), que la marca convertida en la
--     misma transacción: no hay forma de convertirla dos veces.

-- ── Cuentas por pagar ───────────────────────────────────────────────────────
create table if not exists public.payables (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  supplier_id uuid,
  source_type text not null check (source_type in ('purchase', 'expense', 'manual')),
  source_id   uuid,
  description text not null,
  amount      numeric(14, 2) not null check (amount > 0),
  paid_amount numeric(14, 2) not null default 0,
  due_date    date not null,
  status      document_status not null default 'open',
  created_by  uuid references auth.users (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  check (paid_amount >= 0 and paid_amount <= amount),
  foreign key (tenant_id, supplier_id) references public.suppliers (tenant_id, id)
);
create index if not exists payables_supplier_idx on public.payables (tenant_id, supplier_id, status);
create index if not exists payables_due_idx on public.payables (tenant_id, status, due_date);
create index if not exists payables_source_idx on public.payables (source_type, source_id);
create index if not exists payables_created_by_idx on public.payables (created_by);
select public._setup_tenant_table('payables', null);

create table if not exists public.supplier_payments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  client_uid  uuid not null,
  number      text not null,
  supplier_id uuid,
  amount      numeric(14, 2) not null check (amount > 0),
  method      payment_method not null check (method not in ('credit', 'credit_note')),
  session_id  uuid,
  reference   text,
  note        text,
  created_by  uuid references auth.users (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, client_uid),
  foreign key (tenant_id, supplier_id) references public.suppliers (tenant_id, id),
  foreign key (tenant_id, session_id) references public.cash_sessions (tenant_id, id)
);
create index if not exists supplier_payments_supplier_idx on public.supplier_payments (tenant_id, supplier_id, created_at desc);
create index if not exists supplier_payments_created_by_idx on public.supplier_payments (created_by);
select public._setup_tenant_table('supplier_payments', null);

create table if not exists public.payable_payments (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete cascade,
  payable_id          uuid not null,
  supplier_payment_id uuid not null,
  amount              numeric(14, 2) not null check (amount > 0),
  created_at          timestamptz not null default now(),
  foreign key (tenant_id, payable_id) references public.payables (tenant_id, id),
  foreign key (tenant_id, supplier_payment_id) references public.supplier_payments (tenant_id, id)
);
create index if not exists payable_payments_payable_idx on public.payable_payments (payable_id);
create index if not exists payable_payments_sp_idx on public.payable_payments (supplier_payment_id);
select public._setup_tenant_table('payable_payments', null);
drop trigger if exists trg_immutable on public.payable_payments;
create trigger trg_immutable before update or delete on public.payable_payments
  for each row execute function public.prevent_mutation();

create or replace function public.apply_payable_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update payables
     set paid_amount = paid_amount + new.amount,
         status = case when paid_amount + new.amount >= amount then 'paid' else 'open' end::document_status
   where id = new.payable_id and tenant_id = new.tenant_id;
  return new;
end;
$$;
revoke all on function public.apply_payable_payment() from public, anon;
drop trigger if exists trg_apply_payable_payment on public.payable_payments;
create trigger trg_apply_payable_payment after insert on public.payable_payments
  for each row execute function public.apply_payable_payment();

create or replace view public.supplier_balances with (security_invoker = true) as
select tenant_id, supplier_id,
       sum(amount - paid_amount)::numeric(14, 2) as balance,
       min(due_date) as oldest_due,
       count(*) as open_documents
from public.payables
where status = 'open'
group by tenant_id, supplier_id;
grant select on public.supplier_balances to authenticated;
revoke all on public.supplier_balances from anon;

-- Pago a proveedor (interno: lo usan pay_payables, la compra y el gasto).
create or replace function public._pay_payables(
  p_tenant uuid, p_client_uid uuid, p_supplier uuid, p_payable uuid, p_amount numeric,
  p_method payment_method, p_register uuid, p_reference text, p_note text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session cash_sessions;
  v_pay     uuid;
  v_num     record;
  v_left    numeric := round(p_amount, 2);
  v_open    numeric;
  v_p       payables;
  v_apply   numeric;
begin
  if v_left is null or v_left <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;
  if p_method in ('credit', 'credit_note') then
    raise exception 'Método de pago inválido';
  end if;
  select coalesce(sum(amount - paid_amount), 0) into v_open from payables
  where tenant_id = p_tenant and status = 'open'
    and (p_payable is null or id = p_payable)
    and (p_supplier is null or supplier_id = p_supplier);
  if v_left > v_open then
    raise exception 'El pago (%) supera lo pendiente (%)', v_left, v_open;
  end if;
  if p_register is not null then
    v_session := public.open_session_for(p_register);
  end if;

  select * into v_num from public.next_doc_number(p_tenant, 'supplier_payment');
  insert into supplier_payments (tenant_id, client_uid, number, supplier_id, amount, method, session_id, reference, note)
  values (p_tenant, p_client_uid, 'PG-' || v_num.label, p_supplier, v_left, p_method, v_session.id,
          nullif(p_reference, ''), nullif(p_note, ''))
  returning id into v_pay;

  for v_p in
    select * from payables
    where tenant_id = p_tenant and status = 'open'
      and (p_payable is null or id = p_payable)
      and (p_supplier is null or supplier_id = p_supplier)
    order by due_date, created_at
    for update
  loop
    exit when v_left <= 0;
    v_apply := least(v_left, v_p.amount - v_p.paid_amount);
    insert into payable_payments (tenant_id, payable_id, supplier_payment_id, amount)
    values (p_tenant, v_p.id, v_pay, v_apply);
    v_left := v_left - v_apply;
  end loop;

  if v_session.id is not null then
    insert into cash_movements (tenant_id, session_id, kind, method, amount, reference_type, reference_id)
    values (p_tenant, v_session.id, 'payable_payment', p_method, -round(p_amount, 2), 'supplier_payment', v_pay);
  end if;
  return v_pay;
end;
$$;
revoke all on function public._pay_payables(uuid, uuid, uuid, uuid, numeric, payment_method, uuid, text, text)
  from public, anon, authenticated;

-- p_payload: { client_uid, supplier_id?, payable_id?, amount, method, register_id?, reference?, note? }
create or replace function public.pay_payables(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_uid    uuid := (p_payload ->> 'client_uid')::uuid;
  v_pay    uuid;
begin
  perform public.require_perm('payables.manage');
  perform public.require_module('payables');
  if v_uid is null then
    raise exception 'Falta el identificador de la operación (client_uid)';
  end if;
  select id into v_pay from supplier_payments where tenant_id = v_tenant and client_uid = v_uid;
  if v_pay is not null then
    return jsonb_build_object('payment_id', v_pay, 'replayed', true);
  end if;
  perform public.assert_tenant_operational();
  if (p_payload ->> 'supplier_id') is null and (p_payload ->> 'payable_id') is null then
    raise exception 'Indica el proveedor o la cuenta a pagar';
  end if;
  v_pay := public._pay_payables(v_tenant, v_uid, (p_payload ->> 'supplier_id')::uuid, (p_payload ->> 'payable_id')::uuid,
                                (p_payload ->> 'amount')::numeric, (p_payload ->> 'method')::payment_method,
                                (p_payload ->> 'register_id')::uuid, p_payload ->> 'reference', p_payload ->> 'note');
  perform public.log_audit('payable.payment', 'supplier_payment', v_pay, jsonb_build_object('amount', p_payload ->> 'amount'));
  return jsonb_build_object('payment_id', v_pay, 'replayed', false);
end;
$$;

-- ── Compras ─────────────────────────────────────────────────────────────────
create table if not exists public.purchases (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  branch_id        uuid not null,
  supplier_id      uuid not null,
  seq              bigint not null,
  number           text not null,
  status           purchase_status not null default 'draft',
  supplier_invoice text,
  -- NCF / e-NCF del comprobante que entrega el proveedor (para el 606).
  supplier_ncf     text,
  order_date       date not null default current_date,
  due_date         date,
  received_at      timestamptz,
  received_by      uuid references auth.users (id) on delete set null,
  subtotal         numeric(14, 2) not null default 0,
  discount_total   numeric(14, 2) not null default 0,
  tax_total        numeric(14, 2) not null default 0,
  total            numeric(14, 2) not null default 0,
  notes            text,
  attachment_path  text,
  canceled_reason  text,
  created_by       uuid references auth.users (id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, seq),
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id),
  foreign key (tenant_id, supplier_id) references public.suppliers (tenant_id, id)
);
create index if not exists purchases_tenant_idx on public.purchases (tenant_id, order_date desc);
create index if not exists purchases_supplier_idx on public.purchases (tenant_id, supplier_id);
create index if not exists purchases_created_by_idx on public.purchases (created_by);
create index if not exists purchases_received_by_idx on public.purchases (received_by);
select public._setup_tenant_table('purchases', null);

create table if not exists public.purchase_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  purchase_id uuid not null,
  line_no     integer not null,
  product_id  uuid not null,
  description text not null,
  quantity    numeric(14, 3) not null check (quantity > 0),
  unit_cost   numeric(14, 4) not null check (unit_cost >= 0),
  discount    numeric(14, 2) not null default 0 check (discount >= 0),
  tax_rate    numeric(7, 4) not null default 0 check (tax_rate >= 0 and tax_rate < 1),
  subtotal    numeric(14, 2) not null,
  tax_amount  numeric(14, 2) not null,
  total       numeric(14, 2) not null,
  unique (tenant_id, id),
  foreign key (tenant_id, purchase_id) references public.purchases (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references public.products (tenant_id, id)
);
create index if not exists purchase_items_purchase_idx on public.purchase_items (purchase_id);
create index if not exists purchase_items_product_idx on public.purchase_items (tenant_id, product_id);
select public._setup_tenant_table('purchase_items', null);

-- p_payload: { id?, branch_id, supplier_id, status?: draft|ordered, supplier_invoice?, supplier_ncf?,
--              order_date?, due_date?, notes?, attachment_path?,
--              items: [{product_id, quantity, unit_cost, discount?, tax_rate?}] }
create or replace function public.save_purchase(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_id     uuid := (p_payload ->> 'id')::uuid;
  v_status purchase_status := coalesce(nullif(p_payload ->> 'status', ''), 'draft')::purchase_status;
  v_cur    purchases;
  v_num    record;
  v_item   jsonb;
  v_p      products;
  v_qty    numeric;
  v_cost   numeric;
  v_disc   numeric;
  v_rate   numeric;
  v_base   numeric;
  v_tax    numeric;
  v_i      int := 0;
begin
  perform public.require_perm('purchases.manage');
  perform public.require_module('purchases');
  perform public.assert_tenant_operational();
  if v_status not in ('draft', 'ordered') then
    raise exception 'Una compra se guarda como borrador u orden; para recibirla usa "Recibir"';
  end if;
  if not public.can_access_branch((p_payload ->> 'branch_id')::uuid) then
    raise exception 'FORBIDDEN: No tienes acceso a esa sucursal.';
  end if;
  if jsonb_typeof(p_payload -> 'items') <> 'array' or jsonb_array_length(p_payload -> 'items') = 0 then
    raise exception 'La compra no tiene productos';
  end if;

  if v_id is null then
    select * into v_num from public.next_doc_number(v_tenant, 'purchase');
    insert into purchases (tenant_id, branch_id, supplier_id, seq, number, status)
    values (v_tenant, (p_payload ->> 'branch_id')::uuid, (p_payload ->> 'supplier_id')::uuid, v_num.seq,
            'CO-' || v_num.label, v_status)
    returning id into v_id;
  else
    select * into v_cur from purchases where id = v_id and tenant_id = v_tenant for update;
    if not found then
      raise exception 'Compra no encontrada';
    end if;
    if v_cur.status not in ('draft', 'ordered') then
      raise exception 'Una compra recibida o cancelada ya no se edita';
    end if;
    delete from purchase_items where purchase_id = v_id;
  end if;

  update purchases set
    branch_id        = (p_payload ->> 'branch_id')::uuid,
    supplier_id      = (p_payload ->> 'supplier_id')::uuid,
    status           = v_status,
    supplier_invoice = nullif(btrim(p_payload ->> 'supplier_invoice'), ''),
    supplier_ncf     = nullif(upper(btrim(p_payload ->> 'supplier_ncf')), ''),
    order_date       = coalesce((p_payload ->> 'order_date')::date, order_date),
    due_date         = (p_payload ->> 'due_date')::date,
    notes            = nullif(btrim(p_payload ->> 'notes'), ''),
    attachment_path  = nullif(p_payload ->> 'attachment_path', '')
  where id = v_id;

  for v_item in select * from jsonb_array_elements(p_payload -> 'items') loop
    v_i := v_i + 1;
    select * into v_p from products where id = (v_item ->> 'product_id')::uuid and tenant_id = v_tenant;
    if not found then
      raise exception 'Producto no encontrado';
    end if;
    v_qty := round((v_item ->> 'quantity')::numeric, 3);
    v_cost := round((v_item ->> 'unit_cost')::numeric, 4);
    v_disc := round(coalesce((v_item ->> 'discount')::numeric, 0), 2);
    if v_qty is null or v_qty <= 0 or v_cost is null or v_cost < 0 then
      raise exception 'Cantidad o costo inválido para "%"', v_p.name;
    end if;
    v_rate := coalesce((v_item ->> 'tax_rate')::numeric, (select rate from taxes where id = v_p.tax_id), 0);
    v_base := round(v_qty * v_cost, 2) - v_disc;
    if v_base < 0 then
      raise exception 'Descuento inválido para "%"', v_p.name;
    end if;
    v_tax := round(v_base * v_rate, 2);
    insert into purchase_items (tenant_id, purchase_id, line_no, product_id, description, quantity, unit_cost,
                                discount, tax_rate, subtotal, tax_amount, total)
    values (v_tenant, v_id, v_i, v_p.id, v_p.name, v_qty, v_cost, v_disc, v_rate, v_base, v_tax, v_base + v_tax);
  end loop;

  update purchases p set
    subtotal = q.sub, discount_total = q.disc, tax_total = q.tax, total = q.sub + q.tax
  from (select sum(subtotal) sub, sum(discount) disc, sum(tax_amount) tax from purchase_items where purchase_id = v_id) q
  where p.id = v_id;
  perform public.log_audit('purchase.saved', 'purchase', v_id);
  return v_id;
end;
$$;

-- Recepción: entra la mercancía, se recalcula el costo promedio y nace la
-- deuda. p_payment opcional: { client_uid, amount, method, register_id?, reference? }
create or replace function public.receive_purchase(p_id uuid, p_payment jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.auth_tenant_id();
  v_p       purchases;
  v_it      purchase_items;
  v_track   boolean;
  v_onhand  numeric;
  v_oldcost numeric;
  v_ucost   numeric;
  v_paid    numeric := round(coalesce((p_payment ->> 'amount')::numeric, 0), 2);
  v_payable uuid;
  v_terms   integer;
  v_pay     uuid;
begin
  perform public.require_perm('purchases.manage');
  perform public.require_module('purchases');
  perform public.assert_tenant_operational();
  select * into v_p from purchases where id = p_id and tenant_id = v_tenant for update;
  if not found then
    raise exception 'Compra no encontrada';
  end if;
  if v_p.status not in ('draft', 'ordered') then
    raise exception 'Esta compra ya fue recibida o cancelada';
  end if;
  if v_paid < 0 or v_paid > v_p.total then
    raise exception 'El pago no puede superar el total de la compra';
  end if;

  for v_it in select * from purchase_items where purchase_id = p_id order by line_no loop
    select track_stock, cost into v_track, v_oldcost from products where id = v_it.product_id for update;
    -- Costo unitario efectivo: con el descuento repartido, sin ITBIS (el
    -- ITBIS pagado en compras es crédito fiscal, no costo).
    v_ucost := round(v_it.subtotal / v_it.quantity, 4);
    if v_track then
      select coalesce(sum(quantity), 0) into v_onhand from stock_levels where product_id = v_it.product_id;
      update products set cost = case
          when v_onhand <= 0 then v_ucost
          else round((v_onhand * v_oldcost + v_it.quantity * v_ucost) / (v_onhand + v_it.quantity), 4) end
      where id = v_it.product_id;
      insert into inventory_movements (tenant_id, branch_id, product_id, kind, quantity, unit_cost,
                                       reference_type, reference_id, line_ref, reason)
      values (v_tenant, v_p.branch_id, v_it.product_id, 'purchase', v_it.quantity, v_ucost,
              'purchase', p_id, v_it.id, 'Compra ' || v_p.number);
    else
      update products set cost = v_ucost where id = v_it.product_id;
    end if;
  end loop;

  update purchases set status = 'received', received_at = now(), received_by = auth.uid() where id = p_id;

  if v_p.total > 0 then
    select payment_terms_days into v_terms from suppliers where id = v_p.supplier_id;
    insert into payables (tenant_id, supplier_id, source_type, source_id, description, amount, due_date)
    values (v_tenant, v_p.supplier_id, 'purchase', p_id, 'Compra ' || v_p.number, v_p.total,
            coalesce(v_p.due_date, current_date + coalesce(v_terms, 0)))
    returning id into v_payable;
    if v_paid > 0 then
      perform public.require_perm('payables.manage');
      v_pay := public._pay_payables(v_tenant, coalesce((p_payment ->> 'client_uid')::uuid, gen_random_uuid()),
                                    v_p.supplier_id, v_payable, v_paid,
                                    coalesce(p_payment ->> 'method', 'cash')::payment_method,
                                    (p_payment ->> 'register_id')::uuid, p_payment ->> 'reference', null);
    end if;
  end if;
  perform public.log_audit('purchase.received', 'purchase', p_id, jsonb_build_object('total', v_p.total, 'paid', v_paid));
  return jsonb_build_object('purchase_id', p_id, 'payable_id', v_payable, 'payment_id', v_pay);
end;
$$;

create or replace function public.cancel_purchase(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_perm('purchases.manage');
  update purchases set status = 'canceled', canceled_reason = nullif(btrim(p_reason), '')
  where id = p_id and tenant_id = public.auth_tenant_id() and status in ('draft', 'ordered');
  if not found then
    raise exception 'Solo se cancelan compras en borrador u ordenadas';
  end if;
  perform public.log_audit('purchase.canceled', 'purchase', p_id, jsonb_build_object('reason', p_reason));
end;
$$;

-- ── Gastos ──────────────────────────────────────────────────────────────────
create table if not exists public.expense_categories (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  name       text not null check (btrim(name) <> ''),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create index if not exists expense_categories_tenant_idx on public.expense_categories (tenant_id);
create unique index if not exists expense_categories_name_idx on public.expense_categories (tenant_id, lower(name));
select public._setup_tenant_table('expense_categories', 'expenses.manage');

create table if not exists public.expenses (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  client_uid      uuid not null,
  number          text not null,
  branch_id       uuid not null,
  category_id     uuid not null,
  supplier_id     uuid,
  description     text not null check (btrim(description) <> ''),
  amount          numeric(14, 2) not null check (amount > 0),
  -- ITBIS incluido en `amount` (para el reporte de impuestos pagados).
  tax_amount      numeric(14, 2) not null default 0 check (tax_amount >= 0),
  expense_date    date not null,
  method          payment_method,
  status          expense_status not null,
  ncf             text,
  attachment_path text,
  session_id      uuid,
  payable_id      uuid,
  void_reason     text,
  created_by      uuid references auth.users (id) on delete set null default auth.uid(),
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, client_uid),
  check (tax_amount <= amount),
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id),
  foreign key (tenant_id, category_id) references public.expense_categories (tenant_id, id),
  foreign key (tenant_id, supplier_id) references public.suppliers (tenant_id, id),
  foreign key (tenant_id, session_id) references public.cash_sessions (tenant_id, id),
  foreign key (tenant_id, payable_id) references public.payables (tenant_id, id)
);
create index if not exists expenses_tenant_idx on public.expenses (tenant_id, expense_date desc);
create index if not exists expenses_category_idx on public.expenses (tenant_id, category_id);
create index if not exists expenses_created_by_idx on public.expenses (created_by);
create index if not exists expenses_payable_idx on public.expenses (payable_id);
select public._setup_tenant_table('expenses', null);

-- p_payload: { client_uid, branch_id, category_id, supplier_id?, description, amount, tax_amount?,
--              expense_date?, paid: bool, method?, register_id?, ncf?, attachment_path?, due_date? }
create or replace function public.create_expense(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.auth_tenant_id();
  v_uid     uuid := (p_payload ->> 'client_uid')::uuid;
  v_id      uuid;
  v_num     record;
  v_paid    boolean := coalesce((p_payload ->> 'paid')::boolean, true);
  v_method  payment_method := (p_payload ->> 'method')::payment_method;
  v_amount  numeric := round((p_payload ->> 'amount')::numeric, 2);
  v_session cash_sessions;
  v_payable uuid;
begin
  perform public.require_perm('expenses.manage');
  perform public.require_module('expenses');
  if v_uid is null then
    raise exception 'Falta el identificador de la operación (client_uid)';
  end if;
  select id into v_id from expenses where tenant_id = v_tenant and client_uid = v_uid;
  if v_id is not null then
    return v_id;
  end if;
  perform public.assert_tenant_operational();
  if v_amount is null or v_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;
  if not public.can_access_branch((p_payload ->> 'branch_id')::uuid) then
    raise exception 'FORBIDDEN: No tienes acceso a esa sucursal.';
  end if;
  if v_paid and (v_method is null or v_method in ('credit', 'credit_note')) then
    raise exception 'Indica cómo se pagó el gasto';
  end if;
  if v_paid and (p_payload ->> 'register_id') is not null then
    v_session := public.open_session_for((p_payload ->> 'register_id')::uuid);
  end if;

  select * into v_num from public.next_doc_number(v_tenant, 'expense');
  if not v_paid then
    insert into payables (tenant_id, supplier_id, source_type, description, amount, due_date)
    values (v_tenant, (p_payload ->> 'supplier_id')::uuid, 'expense', btrim(p_payload ->> 'description'), v_amount,
            coalesce((p_payload ->> 'due_date')::date, current_date + 30))
    returning id into v_payable;
  end if;
  insert into expenses (tenant_id, client_uid, number, branch_id, category_id, supplier_id, description, amount,
                        tax_amount, expense_date, method, status, ncf, attachment_path, session_id, payable_id)
  values (v_tenant, v_uid, 'GA-' || v_num.label, (p_payload ->> 'branch_id')::uuid, (p_payload ->> 'category_id')::uuid,
          (p_payload ->> 'supplier_id')::uuid, btrim(p_payload ->> 'description'), v_amount,
          round(coalesce((p_payload ->> 'tax_amount')::numeric, 0), 2),
          coalesce((p_payload ->> 'expense_date')::date, current_date),
          case when v_paid then v_method end,
          case when v_paid then 'paid' else 'pending' end::expense_status,
          nullif(upper(btrim(p_payload ->> 'ncf')), ''), nullif(p_payload ->> 'attachment_path', ''),
          v_session.id, v_payable)
  returning id into v_id;
  update payables set source_id = v_id where id = v_payable;
  if v_session.id is not null then
    insert into cash_movements (tenant_id, session_id, kind, method, amount, reference_type, reference_id, note)
    values (v_tenant, v_session.id, 'expense', v_method, -v_amount, 'expense', v_id, btrim(p_payload ->> 'description'));
  end if;
  perform public.log_audit('expense.created', 'expense', v_id, jsonb_build_object('amount', v_amount));
  return v_id;
end;
$$;

create or replace function public.void_expense(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_e      expenses;
begin
  perform public.require_perm('expenses.manage');
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Indica el motivo';
  end if;
  select * into v_e from expenses where id = p_id and tenant_id = v_tenant for update;
  if not found or v_e.status = 'voided' then
    raise exception 'Gasto no encontrado o ya anulado';
  end if;
  if v_e.payable_id is not null then
    if exists (select 1 from payables where id = v_e.payable_id and paid_amount > 0) then
      raise exception 'Este gasto ya tiene pagos registrados; no se puede anular';
    end if;
    update payables set status = 'canceled' where id = v_e.payable_id;
  end if;
  if v_e.session_id is not null then
    perform 1 from cash_sessions where id = v_e.session_id and status = 'open' for share;
    if not found then
      raise exception 'La caja donde se pagó este gasto ya cerró; registra una entrada de efectivo en su lugar.';
    end if;
    insert into cash_movements (tenant_id, session_id, kind, method, amount, reference_type, reference_id, note)
    values (v_tenant, v_e.session_id, 'expense', v_e.method, v_e.amount, 'expense', p_id, 'Anulación: ' || btrim(p_reason));
  end if;
  update expenses set status = 'voided', void_reason = btrim(p_reason) where id = p_id;
  perform public.log_audit('expense.voided', 'expense', p_id, jsonb_build_object('reason', p_reason));
end;
$$;

-- ── Cotizaciones ────────────────────────────────────────────────────────────
create table if not exists public.quotations (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  branch_id         uuid not null,
  seq               bigint not null,
  number            text not null,
  customer_id       uuid,
  status            quotation_status not null default 'draft',
  valid_until       date not null,
  subtotal          numeric(14, 2) not null default 0,
  discount_total    numeric(14, 2) not null default 0,
  tax_total         numeric(14, 2) not null default 0,
  total             numeric(14, 2) not null default 0,
  global_discount   numeric(14, 2) not null default 0,
  notes             text,
  terms             text,
  converted_sale_id uuid unique,
  created_by        uuid references auth.users (id) on delete set null default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, seq),
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id),
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id),
  foreign key (tenant_id, converted_sale_id) references public.sales (tenant_id, id)
);
create index if not exists quotations_tenant_idx on public.quotations (tenant_id, created_at desc);
create index if not exists quotations_customer_idx on public.quotations (tenant_id, customer_id);
create index if not exists quotations_created_by_idx on public.quotations (created_by);
select public._setup_tenant_table('quotations', null);

alter table public.sales drop constraint if exists sales_quotation_fk;
alter table public.sales add constraint sales_quotation_fk
  foreign key (tenant_id, quotation_id) references public.quotations (tenant_id, id);
create index if not exists sales_quotation_idx on public.sales (quotation_id);

create table if not exists public.quotation_items (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  quotation_id uuid not null,
  line_no      integer not null,
  product_id   uuid not null,
  description  text not null,
  quantity     numeric(14, 3) not null check (quantity > 0),
  unit_price   numeric(14, 2) not null,
  discount     numeric(14, 2) not null default 0,
  line_discount numeric(14, 2) not null default 0,
  tax_id       uuid,
  tax_rate     numeric(7, 4) not null default 0,
  subtotal     numeric(14, 2) not null,
  tax_amount   numeric(14, 2) not null,
  total        numeric(14, 2) not null,
  foreign key (tenant_id, quotation_id) references public.quotations (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references public.products (tenant_id, id)
);
create index if not exists quotation_items_quotation_idx on public.quotation_items (quotation_id);
create index if not exists quotation_items_product_idx on public.quotation_items (tenant_id, product_id);
select public._setup_tenant_table('quotation_items', null);

-- p_payload: { id?, branch_id, customer_id?, valid_until?, notes?, terms?, global_discount?,
--              items: [{product_id, quantity, unit_price?, discount?, description?}] }
create or replace function public.save_quotation(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_id     uuid := (p_payload ->> 'id')::uuid;
  v_calc   jsonb;
  v_num    record;
  v_cur    quotations;
  v_line   jsonb;
  v_item   jsonb;
  v_i      int := 0;
begin
  perform public.require_perm('quotations.manage');
  perform public.require_module('quotations');
  perform public.assert_tenant_operational();
  if not public.can_access_branch((p_payload ->> 'branch_id')::uuid) then
    raise exception 'FORBIDDEN: No tienes acceso a esa sucursal.';
  end if;
  v_calc := public.price_lines(v_tenant, p_payload -> 'items', coalesce((p_payload ->> 'global_discount')::numeric, 0), true);

  if v_id is null then
    select * into v_num from public.next_doc_number(v_tenant, 'quotation');
    insert into quotations (tenant_id, branch_id, seq, number, valid_until)
    values (v_tenant, (p_payload ->> 'branch_id')::uuid, v_num.seq, 'CT-' || v_num.label,
            coalesce((p_payload ->> 'valid_until')::date, current_date + 15))
    returning id into v_id;
  else
    select * into v_cur from quotations where id = v_id and tenant_id = v_tenant for update;
    if not found then
      raise exception 'Cotización no encontrada';
    end if;
    if v_cur.status not in ('draft', 'sent') then
      raise exception 'Solo se editan cotizaciones en borrador o enviadas';
    end if;
    delete from quotation_items where quotation_id = v_id;
  end if;

  update quotations set
    branch_id = (p_payload ->> 'branch_id')::uuid,
    customer_id = (p_payload ->> 'customer_id')::uuid,
    valid_until = coalesce((p_payload ->> 'valid_until')::date, valid_until),
    notes = nullif(btrim(p_payload ->> 'notes'), ''),
    terms = nullif(btrim(p_payload ->> 'terms'), ''),
    global_discount = round(coalesce((p_payload ->> 'global_discount')::numeric, 0), 2),
    subtotal = (v_calc ->> 'subtotal')::numeric,
    discount_total = (v_calc ->> 'discount_total')::numeric,
    tax_total = (v_calc ->> 'tax_total')::numeric,
    total = (v_calc ->> 'total')::numeric
  where id = v_id;

  for v_line in select * from jsonb_array_elements(v_calc -> 'lines') loop
    v_i := v_i + 1;
    v_item := (p_payload -> 'items') -> (v_i - 1);
    insert into quotation_items (tenant_id, quotation_id, line_no, product_id, description, quantity, unit_price,
                                 discount, line_discount, tax_id, tax_rate, subtotal, tax_amount, total)
    values (v_tenant, v_id, v_i, (v_line ->> 'product_id')::uuid, v_line ->> 'description',
            (v_line ->> 'quantity')::numeric, (v_line ->> 'unit_price')::numeric, (v_line ->> 'discount')::numeric,
            round(coalesce((v_item ->> 'discount')::numeric, 0), 2),
            (v_line ->> 'tax_id')::uuid, (v_line ->> 'tax_rate')::numeric, (v_line ->> 'subtotal')::numeric,
            (v_line ->> 'tax_amount')::numeric, (v_line ->> 'total')::numeric);
  end loop;
  perform public.log_audit('quotation.saved', 'quotation', v_id);
  return v_id;
end;
$$;

create or replace function public.set_quotation_status(p_id uuid, p_status quotation_status)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cur quotation_status;
begin
  perform public.require_perm('quotations.manage');
  if p_status = 'converted' then
    raise exception 'Una cotización se convierte cobrándola en el punto de venta';
  end if;
  select status into v_cur from quotations where id = p_id and tenant_id = public.auth_tenant_id() for update;
  if v_cur is null then
    raise exception 'Cotización no encontrada';
  end if;
  if v_cur = 'converted' then
    raise exception 'La cotización ya fue convertida en venta';
  end if;
  update quotations set status = p_status where id = p_id;
end;
$$;

do $$
declare
  f   text;
  fns text[] := array[
    'public.pay_payables(jsonb)',
    'public.save_purchase(jsonb)',
    'public.receive_purchase(uuid, jsonb)',
    'public.cancel_purchase(uuid, text)',
    'public.create_expense(jsonb)',
    'public.void_expense(uuid, text)',
    'public.save_quotation(jsonb)',
    'public.set_quotation_status(uuid, quotation_status)'
  ];
begin
  foreach f in array fns loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
