-- ═══════════════════════════════════════════════════════════════════════════
-- Ferddo · 0001 · Esquema base (modelo de datos multi-tenant)
-- ═══════════════════════════════════════════════════════════════════════════
-- Cada "tenant" es un negocio / espacio de trabajo. TODO dato operativo lleva
-- tenant_id y queda aislado por RLS (0003_rls.sql): el aislamiento no se confía
-- al cliente, se demuestra en la base. Si mañana la app filtra mal una consulta,
-- la fila sigue sin salir.
--
-- Un usuario de auth pertenece como mucho a UN tenant, a través de profiles.
-- El plan decide cuántos usuarios y cuántos items caben (los topes se aplican
-- en 0002 y desde 0009 salen de plan_settings).
--
-- `items` es la ENTIDAD DE EJEMPLO del starter: el molde que se copia para
-- crear la entidad real del producto. Lleva a propósito el patrón completo
-- (tenant_id + RLS + tope de plan + guard de consistencia + updated_at) para
-- que clonarla no deje huecos de seguridad.
-- ═══════════════════════════════════════════════════════════════════════════

-- gen_random_uuid() para las llaves y gen_random_bytes() para los códigos de
-- invitación de 0006. Se pide aquí para no depender del orden de extensiones.
create extension if not exists pgcrypto;

-- ──────────────────────────────────────────────────────────────────────────
-- Tipos (enums)
-- ──────────────────────────────────────────────────────────────────────────
-- `create type` no admite `if not exists`; el bloque do/exception hace que la
-- migración se pueda reejecutar sin romper (supabase db push, entornos nuevos).
do $$ begin
  create type member_role as enum ('owner', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type subscription_status as enum ('trial', 'active', 'past_due', 'canceled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type plan_code as enum ('basic', 'pro');
exception when duplicate_object then null; end $$;

do $$ begin
  create type item_status as enum ('draft', 'active', 'archived');
exception when duplicate_object then null; end $$;

-- Lo consume plan_requests (0010). Vive aquí para que todos los enums del
-- proyecto se declaren en un solo sitio y sea fácil auditarlos.
do $$ begin
  create type plan_request_status as enum ('pending', 'approved', 'rejected');
exception when duplicate_object then null; end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- tenants — el negocio / espacio de trabajo
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.tenants (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  logo_url     text,
  phone        text,
  whatsapp     text,
  email        text,
  address      text,
  currency     text not null default 'DOP',
  locale       text not null default 'es-DO',
  -- Suspensión comercial: mientras esté puesta, el tenant queda en solo lectura.
  -- La mueve ÚNICAMENTE el super-admin (lo obliga tenants_guard en 0008).
  suspended_at timestamptz,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ──────────────────────────────────────────────────────────────────────────
-- profiles — 1 por usuario de auth; lo enlaza a su tenant
-- ──────────────────────────────────────────────────────────────────────────
-- tenant_id NULL significa "todavía sin negocio": o acaba de registrarse y le
-- toca el onboarding, o es una cuenta de plataforma (super-admin, 0007), que
-- por diseño no pertenece a ningún tenant.
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  tenant_id  uuid references public.tenants (id) on delete cascade,
  full_name  text,
  avatar_url text,
  role       member_role not null default 'owner',
  created_at timestamptz not null default now()
);
create index if not exists profiles_tenant_idx on public.profiles (tenant_id);

-- ──────────────────────────────────────────────────────────────────────────
-- subscriptions — 1 por tenant (el unique lo garantiza, no la aplicación)
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.subscriptions (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null unique references public.tenants (id) on delete cascade,
  plan               plan_code not null default 'basic',
  status             subscription_status not null default 'trial',
  started_at         timestamptz not null default now(),
  trial_ends_at      timestamptz,
  current_period_end timestamptz,
  updated_at         timestamptz not null default now()
);

-- ──────────────────────────────────────────────────────────────────────────
-- items — ENTIDAD DE EJEMPLO (el molde a copiar)
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  name        text not null,
  description text,
  -- El check vive en la base porque el formulario se puede saltar (API directa).
  amount      numeric(12, 2) not null default 0 check (amount >= 0),
  status      item_status not null default 'draft',
  due_date    date,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists items_tenant_idx on public.items (tenant_id);
-- Compuesto: el listado casi siempre filtra por estado dentro del tenant.
create index if not exists items_status_idx on public.items (tenant_id, status);

-- ──────────────────────────────────────────────────────────────────────────
-- notifications — avisos in-app
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  title      text not null,
  body       text,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);
-- Incluye `read` porque la consulta caliente es "no leídas de este tenant".
create index if not exists notifications_tenant_idx on public.notifications (tenant_id, read);

-- ──────────────────────────────────────────────────────────────────────────
-- audit_logs — bitácora de acciones sensibles
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.audit_logs (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  user_id    uuid references auth.users (id) on delete set null,
  action     text not null,
  entity     text,
  entity_id  uuid,
  meta       jsonb,
  created_at timestamptz not null default now()
);
-- Se lee siempre "lo último de este tenant": el desc va en el índice.
create index if not exists audit_logs_tenant_idx on public.audit_logs (tenant_id, created_at desc);
