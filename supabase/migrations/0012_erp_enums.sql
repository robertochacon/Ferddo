-- ═══ Ferddo · 0012 · Enums del ERP ═══
--
-- Por qué va sola: `alter type … add value` no se puede USAR en la misma
-- transacción que lo crea (Postgres lo rechaza con "unsafe use of new value").
-- El CLI aplica cada archivo en su propia transacción, así que los valores
-- nuevos de member_role y plan_code se declaran aquí y se usan desde la 0013.

-- Roles por empresa. 'owner' y 'admin' ya existían; el resto son los roles
-- operativos del POS/ERP. El super-admin de la plataforma NO es un rol de
-- empresa: vive en platform_admins y no puede pertenecer a negocios.
alter type member_role add value if not exists 'supervisor';
alter type member_role add value if not exists 'cashier';
alter type member_role add value if not exists 'seller';
alter type member_role add value if not exists 'inventory';
alter type member_role add value if not exists 'purchasing';
alter type member_role add value if not exists 'accounting';
alter type member_role add value if not exists 'kitchen';
alter type member_role add value if not exists 'service';

-- Planes comerciales: basic = Básico, pro = Negocio, enterprise = Empresa.
-- Los códigos viejos se conservan para no reescribir lo que ya los usa; el
-- nombre visible sale de plan_settings.name.
alter type plan_code add value if not exists 'enterprise';

do $$ begin
  create type product_kind as enum ('product', 'service');
exception when duplicate_object then null; end $$;

-- Tipos de movimiento de inventario. El signo de la cantidad lo da el tipo
-- (lo comprueba un check en la tabla), así un "sale" positivo no puede colarse.
do $$ begin
  create type inventory_movement_kind as enum (
    'initial', 'purchase', 'sale', 'sale_void', 'sale_return',
    'adjustment_in', 'adjustment_out', 'transfer_in', 'transfer_out', 'count'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_method as enum ('cash', 'card', 'transfer', 'credit', 'credit_note', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type sale_status as enum ('completed', 'voided', 'partially_returned', 'returned');
exception when duplicate_object then null; end $$;

do $$ begin
  create type cash_session_status as enum ('open', 'closed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type cash_movement_kind as enum (
    'sale', 'sale_void', 'refund', 'cash_in', 'cash_out',
    'receivable_payment', 'payable_payment', 'expense'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type document_status as enum ('open', 'paid', 'canceled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type purchase_status as enum ('draft', 'ordered', 'received', 'canceled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type expense_status as enum ('paid', 'pending', 'voided');
exception when duplicate_object then null; end $$;

do $$ begin
  create type quotation_status as enum ('draft', 'sent', 'accepted', 'rejected', 'expired', 'converted');
exception when duplicate_object then null; end $$;

-- Estado del DOCUMENTO FISCAL, separado a propósito del estado comercial de la
-- venta (sale_status): una venta guardada no es una factura aceptada.
--   pending   → creado con e-NCF asignado, aún no enviado
--   sending   → reclamado por el procesador (evita doble envío)
--   sent      → recibido por el proveedor/DGII, con trackId, sin veredicto ("En proceso")
--   accepted / accepted_conditional / rejected → veredicto de la DGII
--   error     → fallo técnico (red, credenciales); se reintenta
--   voided    → anulado (secuencia reportada como no utilizada)
do $$ begin
  create type ecf_status as enum (
    'pending', 'sending', 'sent', 'accepted', 'accepted_conditional', 'rejected', 'error', 'voided'
  );
exception when duplicate_object then null; end $$;
