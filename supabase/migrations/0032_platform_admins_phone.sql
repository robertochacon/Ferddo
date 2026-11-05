-- ═══ Ferddo · 0032 · Teléfono en la lista de super-admins ═══
--
-- POR QUÉ EXISTE
-- Desde «Mi perfil» cada super-admin guarda su teléfono en su cuenta de acceso
-- (auth.users.raw_user_meta_data.phone). La lista del panel no lo devolvía, así
-- que el equipo no podía localizarse entre sí. Misma función que 0030 con el
-- teléfono añadido; nada más cambia.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.admin_list_platform_admins()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'user_id',         pa.user_id,
             'email',           u.email,
             'full_name',       u.raw_user_meta_data ->> 'full_name',
             'phone',           nullif(u.raw_user_meta_data ->> 'phone', ''),
             'note',            pa.note,
             'created_at',      pa.created_at,
             'last_sign_in_at', u.last_sign_in_at
           )
           order by pa.created_at
         ), '[]'::jsonb)
  into result
  from public.platform_admins pa
  left join auth.users u on u.id = pa.user_id;
  return result;
end;
$$;

revoke all on function public.admin_list_platform_admins() from public, anon;
grant execute on function public.admin_list_platform_admins() to authenticated;

notify pgrst, 'reload schema';
