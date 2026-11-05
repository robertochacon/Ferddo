-- ═══ Ferddo · 0030 · Editar super-admins (nombre y nota) ═══
--
-- POR QUÉ EXISTE
-- El panel solo sabía dar de alta y quitar super-admins, identificados por su
-- correo. Con varios en el equipo hace falta saber quién es quién: un nombre y
-- una nota de su función («Soporte», «Facturación»). `platform_admins` no
-- tiene políticas de escritura (0007) a propósito, así que el cambio va por
-- RPC con guardia, como todo lo demás del panel, y queda en la bitácora.
--
-- El correo NO se edita aquí: es la credencial de acceso de esa persona, y
-- cambiarlo desde el panel sería tocarle el login sin que se entere.
-- ═══════════════════════════════════════════════════════════════════════════

-- El nombre vive en auth.users (raw_user_meta_data.full_name), que es de donde
-- lo leen el resto de pantallas; el perfil, si existe (soporte, 0028), también.
create or replace function public.admin_update_platform_admin(p_user uuid, p_full_name text, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name     text := nullif(btrim(coalesce(p_full_name, '')), '');
  v_note     text := nullif(btrim(coalesce(p_note, '')), '');
  v_old_name text;
  v_old_note text;
begin
  if not public.auth_is_platform_admin() then
    raise exception 'No autorizado';
  end if;
  select pa.note, u.raw_user_meta_data ->> 'full_name' into v_old_note, v_old_name
  from platform_admins pa join auth.users u on u.id = pa.user_id
  where pa.user_id = p_user;
  if not found then
    raise exception 'Esa cuenta no es super-admin';
  end if;
  if char_length(coalesce(v_name, '')) > 80 then
    raise exception 'El nombre no puede pasar de 80 caracteres';
  end if;
  if char_length(coalesce(v_note, '')) > 200 then
    raise exception 'La nota no puede pasar de 200 caracteres';
  end if;

  update platform_admins set note = v_note where user_id = p_user;
  update auth.users
     set raw_user_meta_data = case
           when v_name is null then coalesce(raw_user_meta_data, '{}'::jsonb) - 'full_name'
           else coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('full_name', v_name)
         end
   where id = p_user;
  update profiles set full_name = v_name where id = p_user;

  perform public._platform_audit('platform_admin.update', null, jsonb_build_object(
    'user_id', p_user, 'email', (select email from auth.users where id = p_user),
    'changes', public._jsonb_diff(
      jsonb_build_object('full_name', v_old_name, 'note', v_old_note),
      jsonb_build_object('full_name', v_name, 'note', v_note))));
end;
$$;

-- Misma lista que 0008, con el nombre y el último acceso (para saber si una
-- cuenta con acceso total sigue en uso).
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

revoke all on function public.admin_update_platform_admin(uuid, text, text) from public, anon;
grant execute on function public.admin_update_platform_admin(uuid, text, text) to authenticated;
revoke all on function public.admin_list_platform_admins() from public, anon;
grant execute on function public.admin_list_platform_admins() to authenticated;

notify pgrst, 'reload schema';
