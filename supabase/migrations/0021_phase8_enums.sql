-- ═══ Ferddo · 0021 · Enums de restaurante y taller ═══
--
-- Va sola por la misma razón que la 0012: un valor nuevo de enum no se puede
-- usar en la transacción que lo crea, y la 0022 los usa.

-- Anticipo de una orden de trabajo: se cobra antes (entra a caja como
-- 'advance') y se aplica después como forma de pago de la venta final.
alter type payment_method add value if not exists 'advance';
alter type cash_movement_kind add value if not exists 'advance';

do $$ begin
  create type restaurant_order_status as enum ('open', 'closed', 'canceled');
exception when duplicate_object then null; end $$;

-- pending = anotado pero aún no enviado a cocina (se puede editar libremente).
do $$ begin
  create type kitchen_status as enum ('pending', 'sent', 'preparing', 'ready', 'served', 'canceled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type work_order_status as enum (
    'received', 'diagnosing', 'quoted', 'approved', 'in_progress', 'done', 'delivered', 'canceled'
  );
exception when duplicate_object then null; end $$;
