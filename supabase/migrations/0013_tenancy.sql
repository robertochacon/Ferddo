-- ═══ Ferddo · 0013 · Multiempresa, sucursales, roles y permisos ═══
--
-- Por qué existe: el starter ataba cada usuario a UN negocio (profiles.tenant_id)
-- con dos roles fijos. Un POS/ERP necesita:
--   · que una persona pertenezca a varias empresas con roles distintos
--     (la contable que lleva tres negocios, el dueño con dos colmados);
--   · roles operativos (cajero, vendedor, inventario…) y permisos por acción;
--   · sucursales dentro de cada empresa;
--   · módulos que se encienden según el tipo de negocio.
--
-- Decisión clave: `profiles.tenant_id` pasa a significar "empresa ACTIVA" y la
-- pertenencia real vive en `tenant_members`. Así TODAS las políticas RLS
-- existentes (`tenant_id = auth_tenant_id()`) siguen valiendo sin reescribirse,
-- y cambiar de empresa es mover un puntero que la base solo acepta si existe
-- una membresía activa (profiles_guard). Nunca se confía en un tenant_id que
-- mande el cliente: se deriva siempre de auth.uid().
--
-- También retira la entidad de ejemplo `items` del starter: Ferddo tiene su
-- dominio real (productos, ventas…) desde la 0014.

-- ── 1. Fuera la entidad de ejemplo ─────────────────────────────────────────
drop table if exists public.items cascade;
drop function if exists public.enforce_item_limit() cascade;
drop function if exists public.enforce_item_consistency() cascade;
drop type if exists item_status;

-- ── 2. Tipos de negocio (configuración global) ─────────────────────────────
-- Tabla y no enum: añadir un tipo de negocio o cambiar sus módulos por defecto
-- es configuración, no un despliegue.
create table if not exists public.business_types (
  code       text primary key,
  label      text not null,
  modules    text[] not null default '{}',
  sort_order integer not null default 0
);
alter table public.business_types enable row level security;
drop policy if exists business_types_read on public.business_types;
create policy business_types_read on public.business_types
  for select to anon, authenticated using (true);
revoke insert, update, delete on public.business_types from anon, authenticated;
grant select on public.business_types to anon, authenticated;

-- Módulos: pos, inventory, cash, credit (cuentas por cobrar), invoicing (e-CF),
-- purchases, expenses, payables, quotations, reports, restaurant, workshop.
insert into public.business_types (code, label, modules, sort_order) values
  ('colmado',      'Colmado',                 array['pos','inventory','cash','credit','invoicing','purchases','expenses','reports'], 1),
  ('minimarket',   'Minimarket',              array['pos','inventory','cash','credit','invoicing','purchases','expenses','payables','reports'], 2),
  ('supermarket',  'Supermercado pequeño',    array['pos','inventory','cash','credit','invoicing','purchases','expenses','payables','reports'], 3),
  ('hardware',     'Ferretería',              array['pos','inventory','cash','credit','invoicing','purchases','expenses','payables','quotations','reports'], 4),
  ('clothing',     'Tienda de ropa',          array['pos','inventory','cash','credit','invoicing','purchases','expenses','reports'], 5),
  ('auto_parts',   'Tienda de repuestos',     array['pos','inventory','cash','credit','invoicing','purchases','expenses','payables','quotations','reports'], 6),
  ('cafe',         'Cafetería',               array['pos','inventory','cash','invoicing','purchases','expenses','reports'], 7),
  ('restaurant',   'Restaurante',             array['pos','inventory','cash','invoicing','purchases','expenses','reports','restaurant'], 8),
  ('workshop',     'Taller mecánico',         array['pos','inventory','cash','credit','invoicing','purchases','expenses','quotations','reports','workshop'], 9),
  ('clinic',       'Consultorio',             array['pos','cash','credit','invoicing','expenses','quotations','reports'], 10),
  ('professional', 'Oficina profesional',     array['pos','cash','credit','invoicing','expenses','quotations','reports'], 11),
  ('services',     'Empresa de servicios',    array['pos','cash','credit','invoicing','expenses','payables','quotations','reports'], 12),
  ('other',        'Otro comercio',           array['pos','inventory','cash','credit','invoicing','purchases','expenses','payables','quotations','reports'], 13)
on conflict (code) do nothing;

-- ── 3. Datos de empresa ─────────────────────────────────────────────────────
alter table public.tenants
  add column if not exists legal_name          text,
  add column if not exists rnc                 text,
  add column if not exists business_type       text not null default 'other' references public.business_types (code),
  add column if not exists province            text,
  add column if not exists municipality        text,
  add column if not exists timezone            text not null default 'America/Santo_Domingo',
  add column if not exists modules             text[] not null default '{}',
  -- En RD el precio de góndola suele llevar el ITBIS dentro. Si es así, la
  -- base imponible se despeja del precio; si no, el impuesto se suma encima.
  add column if not exists prices_include_tax  boolean not null default true,
  -- Un colmado vende antes de haber cargado la mercancía: por defecto se
  -- permite stock negativo y el reporte lo marca. La ferretería lo apaga.
  add column if not exists allow_negative_stock boolean not null default true,
  add column if not exists receipt_footer      text,
  add column if not exists settings            jsonb not null default '{}'::jsonb;

do $$ begin
  alter table public.tenants add constraint tenants_rnc_format
    check (rnc is null or rnc ~ '^[0-9]{9}$' or rnc ~ '^[0-9]{11}$');
exception when duplicate_object then null; end $$;

-- El perfil ya no muere con la empresa activa: con varias membresías, borrar
-- una empresa solo debe dejar el puntero vacío (o moverlo, ver la purga).
alter table public.profiles drop constraint if exists profiles_tenant_id_fkey;
alter table public.profiles
  add constraint profiles_tenant_id_fkey
  foreign key (tenant_id) references public.tenants (id) on delete set null;

-- ── 4. Membresías ───────────────────────────────────────────────────────────
create table if not exists public.tenant_members (
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        member_role not null,
  -- NULL = todas las sucursales. Se comprueba en las RPC de operación.
  branch_ids  uuid[],
  is_active   boolean not null default true,
  invited_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index if not exists tenant_members_user_idx on public.tenant_members (user_id);
alter table public.tenant_members enable row level security;
revoke all on public.tenant_members from anon;
revoke insert, update, delete on public.tenant_members from authenticated;
grant select on public.tenant_members to authenticated;

-- Las membresías del starter (una por perfil) se trasladan tal cual.
insert into public.tenant_members (tenant_id, user_id, role, created_at)
select tenant_id, id, role, created_at from public.profiles where tenant_id is not null
on conflict do nothing;

-- ── 5. Predicados base (reescritos) ─────────────────────────────────────────
-- La empresa activa SOLO cuenta si la membresía sigue activa: desactivar a un
-- empleado le corta el acceso en la siguiente consulta, sin esperar a que
-- caduque su JWT.
create or replace function public.auth_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.tenant_id
  from public.profiles p
  where p.id = auth.uid()
    and exists (
      select 1 from public.tenant_members m
      where m.tenant_id = p.tenant_id and m.user_id = p.id and m.is_active
    )
$$;

create or replace function public.auth_member_role()
returns member_role
language sql
stable
security definer
set search_path = public
as $$
  select m.role from public.tenant_members m
  where m.tenant_id = public.auth_tenant_id() and m.user_id = auth.uid() and m.is_active
$$;

create or replace function public.auth_is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.auth_member_role() = 'owner', false)
$$;

revoke all on function public.auth_member_role() from public, anon;
grant execute on function public.auth_member_role() to authenticated;

drop policy if exists tenant_members_select on public.tenant_members;
create policy tenant_members_select on public.tenant_members
  for select to authenticated
  using (tenant_id = (select public.auth_tenant_id()) or user_id = auth.uid());

-- ── 6. Permisos ─────────────────────────────────────────────────────────────
create table if not exists public.permissions (
  code       text primary key,
  module     text not null,
  label      text not null,
  sort_order integer not null default 0
);
alter table public.permissions enable row level security;
drop policy if exists permissions_read on public.permissions;
create policy permissions_read on public.permissions for select to authenticated using (true);
revoke all on public.permissions from anon;
revoke insert, update, delete on public.permissions from authenticated;
grant select on public.permissions to authenticated;

insert into public.permissions (code, module, label, sort_order) values
  ('settings.manage',      'config',     'Configurar la empresa, impuestos y POS', 1),
  ('branches.manage',      'config',     'Administrar sucursales y cajas', 2),
  ('team.manage',          'config',     'Administrar empleados e invitaciones', 3),
  ('roles.manage',         'config',     'Editar permisos de los roles', 4),
  ('subscription.manage',  'config',     'Gestionar la suscripción', 5),
  ('fiscal.manage',        'invoicing',  'Configurar facturación electrónica', 10),
  ('ecf.view',             'invoicing',  'Consultar comprobantes electrónicos', 11),
  ('ecf.manage',           'invoicing',  'Reintentar y anular comprobantes', 12),
  ('products.manage',      'catalog',    'Crear y editar productos y servicios', 20),
  ('prices.manage',        'catalog',    'Modificar precios del catálogo', 21),
  ('inventory.view',       'inventory',  'Consultar existencias y kardex', 30),
  ('inventory.adjust',     'inventory',  'Registrar entradas, salidas y conteos', 31),
  ('inventory.transfer',   'inventory',  'Transferir entre sucursales', 32),
  ('customers.manage',     'sales',      'Crear y editar clientes', 40),
  ('sales.create',         'sales',      'Registrar ventas', 41),
  ('sales.discount',       'sales',      'Aplicar descuentos', 42),
  ('sales.price_override', 'sales',      'Cambiar el precio al vender', 43),
  ('sales.credit',         'sales',      'Vender a crédito', 44),
  ('sales.void',           'sales',      'Anular ventas', 45),
  ('sales.return',         'sales',      'Registrar devoluciones y notas de crédito', 46),
  ('sales.view_all',       'sales',      'Ver ventas de todos los vendedores', 47),
  ('cash.open',            'cash',       'Abrir caja', 50),
  ('cash.close',           'cash',       'Cerrar caja', 51),
  ('cash.move',            'cash',       'Entradas y salidas de efectivo', 52),
  ('cash.view_all',        'cash',       'Ver todas las cajas', 53),
  ('quotations.manage',    'sales',      'Crear cotizaciones', 60),
  ('receivables.manage',   'credit',     'Cobrar cuentas por cobrar', 61),
  ('suppliers.manage',     'purchases',  'Crear y editar proveedores', 70),
  ('purchases.manage',     'purchases',  'Registrar compras', 71),
  ('payables.manage',      'purchases',  'Pagar cuentas por pagar', 72),
  ('expenses.manage',      'expenses',   'Registrar gastos', 73),
  ('reports.view',         'reports',    'Ver reportes y tablero', 80),
  ('audit.view',           'reports',    'Ver la bitácora de auditoría', 81)
on conflict (code) do update set module = excluded.module, label = excluded.label, sort_order = excluded.sort_order;

-- Plantilla global de permisos por rol. Al crear una empresa se COPIA a
-- role_permissions, que es lo que cada empresa puede ajustar a su gusto.
create table if not exists public.default_role_permissions (
  role       member_role not null,
  permission text not null references public.permissions (code) on delete cascade,
  primary key (role, permission)
);
alter table public.default_role_permissions enable row level security;
drop policy if exists default_role_permissions_read on public.default_role_permissions;
create policy default_role_permissions_read on public.default_role_permissions
  for select to authenticated using (true);
revoke all on public.default_role_permissions from anon;
revoke insert, update, delete on public.default_role_permissions from authenticated;
grant select on public.default_role_permissions to authenticated;

insert into public.default_role_permissions (role, permission)
select 'admin'::member_role, code from public.permissions where code <> 'subscription.manage'
on conflict do nothing;

insert into public.default_role_permissions (role, permission)
select r::member_role, p
from (values
  ('supervisor', array['products.manage','prices.manage','inventory.view','inventory.adjust','customers.manage',
                       'sales.create','sales.discount','sales.price_override','sales.credit','sales.void','sales.return',
                       'sales.view_all','cash.open','cash.close','cash.move','cash.view_all','quotations.manage',
                       'receivables.manage','reports.view','ecf.view','ecf.manage']),
  ('cashier',    array['customers.manage','sales.create','sales.credit','cash.open','cash.close','cash.move',
                       'receivables.manage','inventory.view']),
  ('seller',     array['customers.manage','sales.create','quotations.manage','inventory.view']),
  ('inventory',  array['products.manage','inventory.view','inventory.adjust','inventory.transfer','suppliers.manage']),
  ('purchasing', array['products.manage','inventory.view','suppliers.manage','purchases.manage','payables.manage']),
  ('accounting', array['reports.view','audit.view','sales.view_all','cash.view_all','expenses.manage',
                       'purchases.manage','payables.manage','receivables.manage','ecf.view','inventory.view']),
  ('kitchen',    array['inventory.view']),
  ('service',    array['customers.manage','sales.create','quotations.manage','inventory.view'])
) as d(r, perms), unnest(d.perms) as p
on conflict do nothing;

create table if not exists public.role_permissions (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  role       member_role not null,
  permission text not null references public.permissions (code) on delete cascade,
  primary key (tenant_id, role, permission)
);
alter table public.role_permissions enable row level security;
revoke all on public.role_permissions from anon;
revoke insert, update, delete on public.role_permissions from authenticated;
grant select on public.role_permissions to authenticated;
drop policy if exists role_permissions_select on public.role_permissions;
create policy role_permissions_select on public.role_permissions
  for select to authenticated using (tenant_id = (select public.auth_tenant_id()));

-- El dueño tiene TODO, siempre: no se puede quedar fuera de su propia empresa
-- por editar mal una tabla de permisos.
create or replace function public.has_perm(p_perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select m.role = 'owner'
        or exists (
          select 1 from public.role_permissions rp
          where rp.tenant_id = m.tenant_id and rp.role = m.role and rp.permission = p_perm
        )
    from public.tenant_members m
    join public.profiles p on p.id = m.user_id and p.tenant_id = m.tenant_id
    where m.user_id = auth.uid() and m.is_active
  ), false)
$$;

-- Para pintar la UI. La autoridad sigue siendo has_perm() en cada RPC/política.
create or replace function public.my_permissions()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.auth_member_role() = 'owner' then (select array_agg(code order by sort_order) from public.permissions)
    else coalesce((
      select array_agg(rp.permission)
      from public.role_permissions rp
      where rp.tenant_id = public.auth_tenant_id() and rp.role = public.auth_member_role()
    ), '{}')
  end
$$;

-- Lanza el error con prefijo para que la UI lo reconozca (src/lib/errors.ts).
create or replace function public.require_perm(p_perm text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_label text;
begin
  if public.auth_tenant_id() is null then
    raise exception 'No autorizado';
  end if;
  if not public.has_perm(p_perm) then
    select label into v_label from public.permissions where code = p_perm;
    raise exception 'FORBIDDEN: No tienes permiso para: %.', lower(coalesce(v_label, p_perm));
  end if;
end;
$$;

-- ── 7. Sucursales ───────────────────────────────────────────────────────────
create table if not exists public.branches (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  name       text not null check (btrim(name) <> ''),
  code       text,
  address    text,
  province   text,
  municipality text,
  phone      text,
  is_main    boolean not null default false,
  is_active  boolean not null default true,
  settings   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create index if not exists branches_tenant_idx on public.branches (tenant_id);
create unique index if not exists branches_one_main_idx on public.branches (tenant_id) where is_main;

create or replace function public.can_access_branch(p_branch uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tenant_members m
    join public.branches b on b.id = p_branch and b.tenant_id = m.tenant_id
    where m.tenant_id = public.auth_tenant_id()
      and m.user_id = auth.uid()
      and m.is_active
      and (m.role in ('owner', 'admin') or m.branch_ids is null or p_branch = any (m.branch_ids))
  )
$$;

-- ── 8. Módulos efectivos = los de la empresa ∩ los de su plan ───────────────
-- NULL en plan_settings.modules = el plan no limita módulos.
alter table public.plan_settings add column if not exists modules text[];

create or replace function public.tenant_has_module(p_module text, p_tenant uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select p_module = any (t.modules) and (ps.modules is null or p_module = any (ps.modules))
    from tenants t
    left join subscriptions s on s.tenant_id = t.id
    left join plan_settings ps on ps.plan = s.plan
    where t.id = coalesce(p_tenant, public.auth_tenant_id())
  ), false)
$$;

create or replace function public.require_module(p_module text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.tenant_has_module(p_module) then
    raise exception 'PLAN_LIMIT_MODULE: Esta función (%) no está activa en tu empresa o tu plan. Actívala en Configuración o actualiza tu plan.', p_module;
  end if;
end;
$$;

-- ── 9. Bitácora ─────────────────────────────────────────────────────────────
-- Solo la escriben las RPC (security definer). Antes cualquier miembro podía
-- insertar entradas a su nombre o al de otro: una bitácora falsificable no
-- audita nada.
create or replace function public.log_audit(
  p_action    text,
  p_entity    text default null,
  p_entity_id uuid default null,
  p_meta      jsonb default null
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.audit_logs (tenant_id, user_id, action, entity, entity_id, meta)
  select public.auth_tenant_id(), auth.uid(), p_action, p_entity, p_entity_id, p_meta
  where public.auth_tenant_id() is not null
$$;

drop policy if exists audit_logs_all on public.audit_logs;
drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (tenant_id = (select public.auth_tenant_id()) and (select public.has_perm('audit.view')));
revoke insert, update, delete on public.audit_logs from authenticated;

-- ── 10. Molde de tabla de empresa ───────────────────────────────────────────
-- Las cuatro cosas obligatorias de CLAUDE.md (RLS, revoke, política por
-- tenant, bloqueo si está suspendida) en UNA llamada, para que ninguna tabla
-- nueva se quede a medias. `p_write_perm` NULL = solo lectura para el cliente:
-- las escrituras pasan por RPC.
create or replace function public._setup_tenant_table(
  p_table      text,
  p_write_perm text,
  p_delete     boolean default false
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_scope text := 'tenant_id = (select public.auth_tenant_id())';
  v_write text;
begin
  execute format('alter table public.%I enable row level security', p_table);
  execute format('revoke all on public.%I from anon', p_table);
  execute format('revoke insert, update, delete on public.%I from authenticated', p_table);
  execute format('grant select on public.%I to authenticated', p_table);

  execute format('drop policy if exists %I on public.%I', p_table || '_select', p_table);
  execute format('create policy %I on public.%I for select to authenticated using (%s)',
                 p_table || '_select', p_table, v_scope);

  execute format('drop policy if exists %I on public.%I', p_table || '_insert', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_update', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_delete', p_table);

  if p_write_perm is not null then
    v_write := format('%s and (select public.has_perm(%L))', v_scope, p_write_perm);
    execute format('grant insert, update on public.%I to authenticated', p_table);
    execute format('create policy %I on public.%I for insert to authenticated with check (%s)',
                   p_table || '_insert', p_table, v_write);
    execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)',
                   p_table || '_update', p_table, v_write, v_write);
    if p_delete then
      execute format('grant delete on public.%I to authenticated', p_table);
      execute format('create policy %I on public.%I for delete to authenticated using (%s)',
                     p_table || '_delete', p_table, v_write);
    end if;
  end if;

  execute format('drop trigger if exists trg_block_suspended on public.%I', p_table);
  execute format('create trigger trg_block_suspended before insert or update or delete on public.%I '
                 || 'for each row execute function public.block_write_if_tenant_suspended()', p_table);

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = p_table and column_name = 'updated_at') then
    execute format('drop trigger if exists trg_set_updated_at on public.%I', p_table);
    execute format('create trigger trg_set_updated_at before update on public.%I '
                   || 'for each row execute function public.set_updated_at()', p_table);
  end if;
end;
$$;
revoke all on function public._setup_tenant_table(text, text, boolean) from public, anon, authenticated;

select public._setup_tenant_table('branches', 'branches.manage');

-- Tablas que nunca se editan ni se borran (movimientos, eventos fiscales):
-- ni siquiera una RPC con un bug puede reescribir la historia.
create or replace function public.prevent_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and public.is_purging_tenant(old.tenant_id) then
    return old;
  end if;
  raise exception 'IMMUTABLE: Los registros de % no se modifican ni se borran; registra un movimiento compensatorio.', tg_table_name;
end;
$$;
revoke all on function public.prevent_mutation() from public, anon;

-- La tabla de tenants: solo quien tenga settings.manage edita la empresa.
drop policy if exists tenants_update on public.tenants;
create policy tenants_update on public.tenants
  for update to authenticated
  using (id = public.auth_tenant_id() and public.has_perm('settings.manage'))
  with check (id = public.auth_tenant_id() and public.has_perm('settings.manage'));

-- Ya no se crean empresas por INSERT directo: el único camino es
-- setup_business(), que además crea membresía, sucursal y configuración.
drop policy if exists tenants_insert on public.tenants;
revoke insert on public.tenants from authenticated;

-- ── 11. profiles_guard: cambiar de empresa solo hacia una membresía real ────
create or replace function public.profiles_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.auth_is_platform_admin() then
    return new;
  end if;
  if new.tenant_id is distinct from old.tenant_id or new.role is distinct from old.role then
    if new.tenant_id is not null and not exists (
      select 1 from public.tenant_members m
      where m.user_id = new.id and m.tenant_id = new.tenant_id and m.role = new.role and m.is_active
    ) then
      raise exception 'No perteneces a esa empresa con ese rol';
    end if;
  end if;
  return new;
end;
$$;

-- El tope de miembros se cuenta ahora sobre membresías activas, no perfiles.
drop trigger if exists trg_enforce_member_limit on public.profiles;
create or replace function public.enforce_member_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan  plan_code;
  v_max   integer;
  v_name  text;
  v_count int;
begin
  if not new.is_active or (tg_op = 'UPDATE' and old.is_active) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('ferddo_members:' || new.tenant_id::text));
  select plan into v_plan from subscriptions where tenant_id = new.tenant_id;
  v_plan := coalesce(v_plan, 'basic');
  select ps.max_members, ps.name into v_max, v_name from plan_settings ps where ps.plan = v_plan;
  if v_max is not null then
    select count(*) into v_count from tenant_members
    where tenant_id = new.tenant_id and is_active and user_id <> new.user_id;
    if v_count >= v_max then
      raise exception 'PLAN_LIMIT_MEMBERS: El plan % permite % usuario(s) en la empresa. Actualiza tu plan para agregar más personas.', v_name, v_max;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_enforce_member_limit on public.tenant_members;
create trigger trg_enforce_member_limit
  before insert or update of is_active on public.tenant_members
  for each row execute function public.enforce_member_limit();

-- ── 12. Numeración interna de documentos ───────────────────────────────────
-- SEPARADA de la numeración fiscal (e-NCF, ver 0016): esta es la del negocio
-- (venta #123, compra #45) y no tiene ninguna validez ante la DGII.
create table if not exists public.document_sequences (
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  doc_type    text not null,
  prefix      text not null default '',
  next_number bigint not null default 1 check (next_number > 0),
  padding     integer not null default 6 check (padding between 1 and 12),
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, doc_type)
);
select public._setup_tenant_table('document_sequences', 'settings.manage');

-- Reserva atómica: el UPSERT bloquea la fila hasta el commit, así dos cajas
-- que venden a la vez no pueden sacar el mismo número.
create or replace function public.next_doc_number(p_tenant uuid, p_doc_type text, out seq bigint, out label text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefix text;
  v_pad    int;
begin
  insert into document_sequences (tenant_id, doc_type, next_number)
  values (p_tenant, p_doc_type, 2)
  on conflict (tenant_id, doc_type) do update
    set next_number = document_sequences.next_number + 1, updated_at = now()
  returning next_number - 1, prefix, padding into seq, v_prefix, v_pad;
  label := v_prefix || lpad(seq::text, v_pad, '0');
end;
$$;
revoke all on function public.next_doc_number(uuid, text) from public, anon, authenticated;

-- ── 13. Alta de empresa, cambio de empresa, lista de mis empresas ───────────
create or replace function public.setup_business(
  p_name          text,
  p_business_type text default 'other',
  p_full_name     text default null,
  p_phone         text default null,
  p_rnc           text default null,
  p_legal_name    text default null,
  p_address       text default null,
  p_province      text default null,
  p_municipality  text default null,
  p_email         text default null,
  p_additional    boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_tenant  uuid;
  v_type    text := coalesce(nullif(btrim(p_business_type), ''), 'other');
  v_mods    text[];
  v_rnc     text := nullif(regexp_replace(coalesce(p_rnc, ''), '[^0-9]', '', 'g'), '');
begin
  if v_uid is null then
    raise exception 'No autenticado';
  end if;
  if public.auth_is_platform_admin() then
    raise exception 'Un super-admin de plataforma no puede crear ni pertenecer a un negocio';
  end if;
  -- Idempotente para el PRIMER negocio (doble clic en el onboarding). Una
  -- empresa adicional se pide explícitamente con p_additional.
  if not p_additional then
    select tenant_id into v_tenant from profiles where id = v_uid and tenant_id is not null;
    if v_tenant is not null then
      return v_tenant;
    end if;
  end if;
  if v_rnc is not null and v_rnc !~ '^([0-9]{9}|[0-9]{11})$' then
    raise exception 'El RNC debe tener 9 dígitos o la cédula 11';
  end if;
  select modules into v_mods from business_types where code = v_type;
  if not found then
    raise exception 'Tipo de negocio desconocido';
  end if;

  insert into tenants (name, legal_name, rnc, business_type, modules, phone, whatsapp, email,
                       address, province, municipality, created_by)
  values (coalesce(nullif(btrim(p_name), ''), 'Mi negocio'), nullif(btrim(p_legal_name), ''), v_rnc,
          v_type, v_mods, nullif(btrim(p_phone), ''), nullif(btrim(p_phone), ''), nullif(btrim(p_email), ''),
          nullif(btrim(p_address), ''), nullif(btrim(p_province), ''), nullif(btrim(p_municipality), ''), v_uid)
  returning id into v_tenant;

  -- Prueba de 30 días en el plan intermedio: así el negocio prueba la
  -- facturación electrónica antes de decidir. El plan se cambia desde /admin.
  insert into subscriptions (tenant_id, plan, status, trial_ends_at)
  values (v_tenant, 'pro', 'trial', now() + interval '30 days');

  insert into tenant_members (tenant_id, user_id, role) values (v_tenant, v_uid, 'owner');

  insert into profiles (id, tenant_id, full_name, role)
  values (v_uid, v_tenant, nullif(btrim(p_full_name), ''), 'owner')
  on conflict (id) do update
    set tenant_id = excluded.tenant_id,
        role      = 'owner',
        full_name = coalesce(profiles.full_name, excluded.full_name);

  insert into role_permissions (tenant_id, role, permission)
  select v_tenant, role, permission from default_role_permissions;

  insert into branches (tenant_id, name, address, province, municipality, phone, is_main)
  values (v_tenant, 'Principal', nullif(btrim(p_address), ''), nullif(btrim(p_province), ''),
          nullif(btrim(p_municipality), ''), nullif(btrim(p_phone), ''), true);

  -- Impuestos, caja, categorías de gasto y configuración fiscal (0014–0017).
  perform public.seed_tenant_defaults(v_tenant);

  insert into audit_logs (tenant_id, user_id, action, entity, entity_id)
  values (v_tenant, v_uid, 'tenant.created', 'tenant', v_tenant);
  return v_tenant;
end;
$$;

-- Firma del starter, por compatibilidad: delega en setup_business.
create or replace function public.setup_tenant(
  p_name text,
  p_full_name text default null,
  p_whatsapp text default null
)
returns uuid
language sql
security definer
set search_path = public
as $$
  select public.setup_business(p_name, 'other', p_full_name, p_whatsapp)
$$;

create or replace function public.switch_tenant(p_tenant uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role member_role;
begin
  select role into v_role from tenant_members
  where tenant_id = p_tenant and user_id = auth.uid() and is_active;
  if v_role is null then
    raise exception 'No perteneces a esa empresa';
  end if;
  update profiles set tenant_id = p_tenant, role = v_role where id = auth.uid();
  return p_tenant;
end;
$$;

create or replace function public.my_tenants()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'name', t.name, 'logo_url', t.logo_url, 'role', m.role,
           'business_type', t.business_type, 'suspended', t.suspended_at is not null,
           'active', t.id = public.auth_tenant_id()
         ) order by t.name), '[]'::jsonb)
  from tenant_members m
  join tenants t on t.id = m.tenant_id
  where m.user_id = auth.uid() and m.is_active
$$;

-- ── 14. Invitaciones con rol operativo ──────────────────────────────────────
alter table public.tenant_invites
  add column if not exists branch_ids uuid[];

create or replace function public.create_invite(
  p_role member_role default 'admin',
  p_email text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_plan   plan_code;
  v_max    integer;
  v_name   text;
  v_count  int;
  v_code   text;
begin
  perform public.require_perm('team.manage');
  if exists (select 1 from tenants where id = v_tenant and suspended_at is not null) then
    raise exception 'CUENTA_SUSPENDIDA: Este negocio está suspendido. Contacta al administrador de la plataforma.';
  end if;
  -- Solo un dueño crea otro dueño: un admin no puede ascenderse por la puerta
  -- de atrás invitándose a sí mismo con otra cuenta.
  if p_role = 'owner' and not public.auth_is_owner() then
    raise exception 'Solo el dueño puede invitar a otro dueño';
  end if;
  select plan into v_plan from subscriptions where tenant_id = v_tenant;
  v_plan := coalesce(v_plan, 'basic');
  select ps.max_members, ps.name into v_max, v_name from plan_settings ps where ps.plan = v_plan;
  if v_max is not null then
    select count(*) into v_count from tenant_members where tenant_id = v_tenant and is_active;
    if v_count >= v_max then
      raise exception 'PLAN_LIMIT_MEMBERS: El plan % permite % usuario(s). Actualiza tu plan para invitar a más personas.', v_name, v_max;
    end if;
  end if;
  insert into tenant_invites (tenant_id, role, email, created_by)
  values (v_tenant, coalesce(p_role, 'admin'), nullif(trim(p_email), ''), auth.uid())
  returning code into v_code;
  perform public.log_audit('team.invite', 'tenant_invite', null, jsonb_build_object('role', p_role));
  return v_code;
end;
$$;

-- Con multiempresa ya no se rechaza a quien tenga perfil: se le añade la
-- membresía y la empresa invitada pasa a ser la activa.
create or replace function public.accept_invite(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_inv     public.tenant_invites;
  v_name    text;
  v_claimed int;
begin
  if v_uid is null then
    raise exception 'No autenticado';
  end if;
  if public.auth_is_platform_admin() then
    raise exception 'Un super-admin de plataforma no puede canjear invitaciones';
  end if;
  select * into v_inv from tenant_invites where code = trim(p_code);
  if not found then
    raise exception 'Código de invitación inválido';
  end if;
  if v_inv.expires_at < now() then
    raise exception 'Este código de invitación expiró';
  end if;
  if exists (select 1 from tenants where id = v_inv.tenant_id and suspended_at is not null) then
    raise exception 'CUENTA_SUSPENDIDA: Este negocio está suspendido. Contacta al administrador de la plataforma.';
  end if;
  if exists (select 1 from tenant_members where tenant_id = v_inv.tenant_id and user_id = v_uid and is_active) then
    raise exception 'Ya perteneces a esta empresa';
  end if;

  update tenant_invites set accepted_at = now(), accepted_by = v_uid
  where id = v_inv.id and accepted_at is null;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    raise exception 'Este código ya fue utilizado';
  end if;

  insert into tenant_members (tenant_id, user_id, role, branch_ids, invited_by)
  values (v_inv.tenant_id, v_uid, v_inv.role, v_inv.branch_ids, v_inv.created_by)
  on conflict (tenant_id, user_id) do update
    set role = excluded.role, branch_ids = excluded.branch_ids, is_active = true;

  select raw_user_meta_data ->> 'full_name' into v_name from auth.users where id = v_uid;
  insert into profiles (id, tenant_id, full_name, role)
  values (v_uid, v_inv.tenant_id, v_name, v_inv.role)
  on conflict (id) do update set tenant_id = excluded.tenant_id, role = excluded.role;
  return v_inv.tenant_id;
end;
$$;

-- ── 15. Equipo (desde la propia empresa) ────────────────────────────────────
create or replace function public.list_team_members()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
begin
  if v_tenant is null then
    raise exception 'No autorizado';
  end if;
  -- Cualquier miembro ve nombres (los necesita para "vendedor", "cajero"),
  -- pero el correo solo quien administra el equipo.
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'user_id', m.user_id, 'role', m.role, 'is_active', m.is_active,
             'branch_ids', m.branch_ids, 'created_at', m.created_at,
             'full_name', coalesce(p.full_name, u.raw_user_meta_data ->> 'full_name'),
             'email', case when public.has_perm('team.manage') then u.email end
           ) order by (m.role = 'owner') desc, m.created_at), '[]'::jsonb)
    from tenant_members m
    left join profiles p on p.id = m.user_id
    left join auth.users u on u.id = m.user_id
    where m.tenant_id = v_tenant
  );
end;
$$;

create or replace function public.set_member_role(p_user uuid, p_role member_role, p_branch_ids uuid[] default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_old    member_role;
  v_owners int;
begin
  perform public.require_perm('team.manage');
  select role into v_old from tenant_members where tenant_id = v_tenant and user_id = p_user;
  if v_old is null then
    raise exception 'Esa persona no pertenece a tu empresa';
  end if;
  if (v_old = 'owner' or p_role = 'owner') and not public.auth_is_owner() then
    raise exception 'Solo el dueño puede asignar o quitar el rol de dueño';
  end if;
  perform pg_advisory_xact_lock(hashtext('ferddo_owner:' || v_tenant::text));
  update tenant_members set role = p_role, branch_ids = p_branch_ids
  where tenant_id = v_tenant and user_id = p_user;
  update profiles set role = p_role where id = p_user and tenant_id = v_tenant;
  select count(*) into v_owners from tenant_members where tenant_id = v_tenant and role = 'owner' and is_active;
  if v_owners < 1 then
    raise exception 'La empresa no puede quedarse sin dueño';
  end if;
  perform public.log_audit('team.role_changed', 'member', p_user,
                           jsonb_build_object('from', v_old, 'to', p_role, 'branches', p_branch_ids));
end;
$$;

create or replace function public.set_member_active(p_user uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_role   member_role;
  v_owners int;
  v_next   uuid;
begin
  perform public.require_perm('team.manage');
  select role into v_role from tenant_members where tenant_id = v_tenant and user_id = p_user;
  if v_role is null then
    raise exception 'Esa persona no pertenece a tu empresa';
  end if;
  if v_role = 'owner' and not public.auth_is_owner() then
    raise exception 'Solo el dueño puede desactivar a otro dueño';
  end if;
  perform pg_advisory_xact_lock(hashtext('ferddo_owner:' || v_tenant::text));
  update tenant_members set is_active = p_active where tenant_id = v_tenant and user_id = p_user;
  select count(*) into v_owners from tenant_members where tenant_id = v_tenant and role = 'owner' and is_active;
  if v_owners < 1 then
    raise exception 'La empresa no puede quedarse sin dueño activo';
  end if;
  if not p_active then
    -- Su empresa activa deja de valer: se le mueve a otra membresía si tiene.
    select tenant_id into v_next from tenant_members
    where user_id = p_user and is_active and tenant_id <> v_tenant
    order by created_at limit 1;
    update profiles
       set tenant_id = v_next,
           role = coalesce((select role from tenant_members where tenant_id = v_next and user_id = p_user), role)
     where id = p_user and tenant_id = v_tenant;
  end if;
  perform public.log_audit(case when p_active then 'team.activated' else 'team.deactivated' end, 'member', p_user);
end;
$$;

create or replace function public.set_role_permissions(p_role member_role, p_permissions text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
begin
  perform public.require_perm('roles.manage');
  if p_role = 'owner' then
    raise exception 'El dueño siempre tiene todos los permisos';
  end if;
  -- Nadie puede dar un permiso que no tiene (escalada por la tabla de roles).
  if not public.auth_is_owner() and exists (
    select 1 from unnest(p_permissions) x where not public.has_perm(x)
  ) then
    raise exception 'No puedes conceder permisos que tú no tienes';
  end if;
  delete from role_permissions where tenant_id = v_tenant and role = p_role;
  insert into role_permissions (tenant_id, role, permission)
  select v_tenant, p_role, x from unnest(p_permissions) x
  where exists (select 1 from permissions where code = x)
  on conflict do nothing;
  perform public.log_audit('roles.updated', 'role', null, jsonb_build_object('role', p_role, 'permissions', p_permissions));
end;
$$;

-- ── 16. RPCs del super-admin que hablaban de profiles.tenant_id ─────────────
create or replace function public.admin_list_members(p_tenant uuid)
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
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', m.user_id, 'full_name', p.full_name, 'role', m.role, 'is_active', m.is_active,
             'created_at', m.created_at, 'email', u.email,
             'banned', (u.banned_until is not null and u.banned_until > now())
           ) order by (m.role = 'owner') desc, m.created_at), '[]'::jsonb)
    from tenant_members m
    left join profiles p on p.id = m.user_id
    left join auth.users u on u.id = m.user_id
    where m.tenant_id = p_tenant
  );
end;
$$;

create or replace function public.admin_set_member_role(p_tenant uuid, p_user uuid, p_role member_role)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owners int;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  perform pg_advisory_xact_lock(hashtext('ferddo_owner:' || p_tenant::text));
  update tenant_members set role = p_role where tenant_id = p_tenant and user_id = p_user;
  if not found then
    raise exception 'Usuario no encontrado en ese negocio';
  end if;
  update profiles set role = p_role where id = p_user and tenant_id = p_tenant;
  select count(*) into v_owners from tenant_members where tenant_id = p_tenant and role = 'owner' and is_active;
  if v_owners < 1 then
    raise exception 'No puedes dejar al negocio sin dueño; asigna otro dueño primero';
  end if;
end;
$$;

create or replace function public.admin_remove_member(p_tenant uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owners int;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  perform pg_advisory_xact_lock(hashtext('ferddo_owner:' || p_tenant::text));
  delete from tenant_members where tenant_id = p_tenant and user_id = p_user;
  if not found then
    raise exception 'Usuario no encontrado en ese negocio';
  end if;
  select count(*) into v_owners from tenant_members where tenant_id = p_tenant and role = 'owner' and is_active;
  if v_owners < 1 then
    raise exception 'No puedes quitar al único dueño; reasigna el dueño primero';
  end if;
  update profiles set tenant_id = null where id = p_user and tenant_id = p_tenant;
end;
$$;

create or replace function public.admin_grant_platform_admin(p_email text, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email));
  if v_uid is null then
    raise exception 'No existe un usuario con ese correo (créalo primero en Auth)';
  end if;
  if exists (select 1 from tenant_members where user_id = v_uid) then
    raise exception 'Ese usuario pertenece a un negocio; un super-admin debe ser una cuenta sin negocio';
  end if;
  insert into platform_admins (user_id, note)
  values (v_uid, coalesce(nullif(trim(p_note), ''), 'alta desde el panel'))
  on conflict (user_id) do nothing;
  return v_uid;
end;
$$;

-- ── 17. Grants ──────────────────────────────────────────────────────────────
do $$
declare
  f   text;
  fns text[] := array[
    'public.has_perm(text)',
    'public.my_permissions()',
    'public.require_perm(text)',
    'public.can_access_branch(uuid)',
    'public.tenant_has_module(text, uuid)',
    'public.require_module(text)',
    'public.setup_business(text, text, text, text, text, text, text, text, text, text, boolean)',
    'public.setup_tenant(text, text, text)',
    'public.switch_tenant(uuid)',
    'public.my_tenants()',
    'public.create_invite(member_role, text)',
    'public.accept_invite(text)',
    'public.list_team_members()',
    'public.set_member_role(uuid, member_role, uuid[])',
    'public.set_member_active(uuid, boolean)',
    'public.set_role_permissions(member_role, text[])',
    'public.admin_list_members(uuid)',
    'public.admin_set_member_role(uuid, uuid, member_role)',
    'public.admin_remove_member(uuid, uuid)',
    'public.admin_grant_platform_admin(text, text)'
  ];
begin
  foreach f in array fns loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke all on function public.log_audit(text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.profiles_guard() from public, anon;
