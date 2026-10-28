-- ═══════════════════════════════════════════════════════════════════════════
-- Ferddo · Alta del PRIMER super-admin de plataforma
-- ═══════════════════════════════════════════════════════════════════════════
-- Ejecútalo en el SQL Editor de Supabase (rol `postgres`) o con la clave
-- `service_role`. Es idempotente: puedes repetirlo sin miedo.
--
-- ¿POR QUÉ HACE FALTA UN SCRIPT?
-- Porque desde el cliente NO hay forma de promoverse. `platform_admins` tiene
-- RLS con SELECT solo para quien ya es super-admin y NINGUNA política de
-- escritura, así que `anon` y `authenticated` no pueden insertar ahí ni aunque
-- lo intenten. La RPC que da de alta a los demás (`admin_grant_platform_admin`)
-- empieza comprobando `auth_is_platform_admin()`, de modo que sirve para el
-- segundo super-admin en adelante, pero no para el primero: alguien tiene que
-- romper el huevo desde fuera, con una credencial que salta la RLS. Eso es este
-- archivo, y es la única vía.
--
-- ANTES DE EJECUTARLO
--   1. Crea la cuenta en Auth → Users → Add user, marcando "Auto Confirm User"
--      (o regístrala desde la app). Aquí solo se consulta `auth.users`: si el
--      correo no existe todavía, el insert no hace nada y no avisa.
--   2. Esa cuenta NO debe tener negocio. Un super-admin con `tenant_id` sería
--      juez y parte: las políticas de lectura cross-tenant exigen
--      `auth_is_platform_admin() and auth_tenant_id() is null`, así que si el
--      usuario tiene negocio el panel de plataforma se queda ciego. Por lo
--      mismo `setup_tenant()` rechaza a los super-admins. Usa una cuenta
--      aparte, distinta de la que uses como cliente.
--
-- Cambia el correo de abajo. Va en minúsculas por `lower()` a los dos lados
-- porque en `auth.users` se guarda tal cual lo escribió quien se registró.
-- ═══════════════════════════════════════════════════════════════════════════

insert into public.platform_admins (user_id, note)
select id, 'super-admin fundador'
from auth.users
where lower(email) = lower('cambia@esto.com')
on conflict (user_id) do nothing;

-- Verificación: debe listar el correo. Si sale vacío, la cuenta de auth no
-- existe todavía (revisa el punto 1 de arriba).
select pa.user_id, u.email, pa.note, pa.created_at
from public.platform_admins pa
join auth.users u on u.id = pa.user_id
order by pa.created_at;

-- Comprobación de ortogonalidad: esto DEBE devolver 0 filas. Si devuelve
-- alguna, ese super-admin tiene negocio y no verá nada en /admin.
select p.id, u.email, p.tenant_id
from public.platform_admins pa
join public.profiles p on p.id = pa.user_id
join auth.users u on u.id = pa.user_id
where p.tenant_id is not null;
