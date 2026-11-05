-- ═══ Ferddo · 0029 · Cortar el acceso de soporte lo cierra del todo ═══
--
-- POR QUÉ EXISTE
-- En 0028 el dueño corta el acceso de soporte con `set_member_active(…, false)`.
-- Esa RPC desactiva la membresía y, de paso, quita el negocio del perfil de la
-- persona desactivada. Con el soporte eso dejaba dos problemas (vistos en la
-- prueba E2E):
--   • la fila quedaba INACTIVA hasta caducar: el dueño la seguía viendo en su
--     Equipo como «Inactivo» y con la opción de devolverla;
--   • el corte no llegaba a la bitácora de plataforma, y el super-admin, ya sin
--     negocio en el perfil, no tenía nada que cerrar al volver al panel.
-- No había fuga (una fila inactiva no da acceso), pero sí basura y un rastro
-- incompleto. Ahora desactivar un acceso de soporte lo BORRA y lo registra como
-- `support.revoke` en las dos bitácoras, con el dueño como autor. Para volver,
-- el super-admin entra de nuevo (con motivo nuevo, que queda registrado).
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public._support_revoked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.support_until is null or not old.is_active or new.is_active then
    return null;
  end if;
  delete from tenant_members where tenant_id = new.tenant_id and user_id = new.user_id;
  insert into audit_logs (tenant_id, user_id, action, entity, entity_id, meta)
  values (new.tenant_id, auth.uid(), 'support.revoke', 'member', new.user_id,
          jsonb_build_object('support_user', new.user_id));
  perform public._platform_audit('support.revoke', new.tenant_id, jsonb_build_object(
    'user_id', new.user_id, 'email', (select email from auth.users where id = new.user_id)));
  return null;
end;
$$;
revoke all on function public._support_revoked() from public, anon, authenticated;

drop trigger if exists trg_tenant_members_support_revoke on public.tenant_members;
create trigger trg_tenant_members_support_revoke
  after update of is_active on public.tenant_members
  for each row execute function public._support_revoked();

-- Accesos de soporte cortados antes de esta migración: se cierran igual.
with gone as (
  delete from public.tenant_members
  where support_until is not null and not is_active
  returning tenant_id, user_id
)
insert into public.audit_logs (tenant_id, user_id, action, entity, entity_id, meta)
select tenant_id, null, 'support.revoke', 'member', user_id, jsonb_build_object('support_user', user_id, 'cleanup', true)
from gone;
