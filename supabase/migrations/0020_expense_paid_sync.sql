-- ═══ Ferddo · 0020 · El gasto refleja el pago de su cuenta por pagar ═══
--
-- Por qué: un gasto "por pagar" nace con su cuenta por pagar (0017). Cuando
-- esa cuenta se salda desde Cuentas por pagar, el gasto seguía en `pending`
-- para siempre y el listado de gastos mentía. Se sincroniza desde la base,
-- en la misma transacción del pago, y no desde la pantalla.
create or replace function public.sync_expense_on_payable_paid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.source_type = 'expense' and new.status = 'paid' and old.status <> 'paid' then
    update expenses e
       set status = 'paid',
           method = coalesce(e.method, (
             select sp.method from payable_payments pp
             join supplier_payments sp on sp.id = pp.supplier_payment_id
             where pp.payable_id = new.id
             order by pp.created_at desc limit 1))
     where e.payable_id = new.id and e.status = 'pending';
  end if;
  return new;
end;
$$;
revoke all on function public.sync_expense_on_payable_paid() from public, anon, authenticated;

drop trigger if exists trg_sync_expense_paid on public.payables;
create trigger trg_sync_expense_paid after update of status on public.payables
  for each row execute function public.sync_expense_on_payable_paid();
