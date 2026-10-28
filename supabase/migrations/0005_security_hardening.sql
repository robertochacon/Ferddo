-- ═══════════════════════════════════════════════════════════════════════════
-- Ferddo · 0005 · Endurecimiento de seguridad
-- ═══════════════════════════════════════════════════════════════════════════
-- Las tres piezas de esta migración salieron de una revisión adversarial del
-- esquema de 0003, no de un checklist. Cierran una escalada cross-tenant REAL:
--
--   1) El cliente podía INSERTAR su propio profile con el tenant_id de otro
--      negocio. A partir de ahí auth_tenant_id() devolvía el id de la víctima
--      y TODA la RLS de 0003 —que es correcta— le abría la puerta encantada:
--      leer, editar y borrar los datos de un negocio ajeno.
--   2) Aunque cerraras el INSERT, quedaba el UPDATE: un PATCH a tu propia fila
--      cambiando tenant_id lograba exactamente lo mismo, y otro cambiando role
--      te ascendía a 'owner' dentro de tu negocio.
--   3) La escritura con un tenant_id ajeno en las tablas de datos: la RLS la
--      frena mientras la escritura pase POR la RLS, y no toda pasa.
--
-- Moraleja que conviene no reaprender: en multi-tenant, la fila que dice a qué
-- tenant perteneces es la joya. Todo lo demás cuelga de ella.
-- ═══════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────────
-- CRÍTICO #1 — profiles: fuera el INSERT del cliente
-- ──────────────────────────────────────────────────────────────────────────
-- La política de 0003 exigía `id = auth.uid()`, que suena bien y no sirve de
-- nada: comprueba QUIÉN eres, no A QUÉ NEGOCIO te apuntas. El tenant_id de la
-- fila insertada no lo miraba nadie.
--
-- El único camino a un profile pasa ahora por dos funciones SECURITY DEFINER
-- que sí deciden el tenant_id: setup_tenant() (0002, crea tu propio negocio) y
-- accept_invite() (0006, canjea un código emitido por el owner del otro lado).
drop policy if exists profiles_insert on public.profiles;

-- Y el GRANT detrás de la política (trampa conocida: sin esto el POST devuelve
-- 204 con 0 filas y el intento se confunde con un no-op en los registros).
revoke insert on public.profiles from anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- CRÍTICO #2 — profiles: tenant_id y role son INMUTABLES desde el cliente
-- ──────────────────────────────────────────────────────────────────────────
-- La RLS no restringe COLUMNAS: `profiles_update` deja pasar cualquier PATCH a
-- tu propia fila, incluido uno que la mude de negocio o que te ascienda. El
-- UPDATE sigue siendo legítimo para full_name y avatar_url; el guard recorta
-- las dos columnas que son privilegio, no dato.
--
-- Sin `security definer` a propósito: no necesita permisos extra y así no
-- puede convertirse por accidente en una vía de escalada.
create or replace function public.profiles_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'No se permite cambiar el negocio de un perfil';
  end if;
  if new.role is distinct from old.role then
    raise exception 'No se permite cambiar el rol desde el cliente';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_guard on public.profiles;
create trigger trg_profiles_guard
  before update on public.profiles
  for each row execute function public.profiles_guard();
-- La 0008 reemplaza esta función para eximir al super-admin (reasignar dueño,
-- cambiar rol desde el panel). auth.uid() dentro de una función definer sigue
-- siendo el del LLAMADOR, así que esa excepción se puede comprobar de verdad.

-- ──────────────────────────────────────────────────────────────────────────
-- ALTO #3 — items: el tenant_id escrito tiene que ser el TUYO
-- ──────────────────────────────────────────────────────────────────────────
-- ¿Por qué, si `items_all` ya lleva `with check (tenant_id = auth_tenant_id())`?
-- Porque ese `with check` solo se evalúa cuando la escritura pasa por la RLS, y
-- hay caminos legítimos que no pasan: una RPC SECURITY DEFINER, una Edge
-- Function con la clave service_role, un trigger de otra tabla. Un bug en
-- cualquiera de ellos escribe en el negocio equivocado sin que nada chille.
-- Los triggers, en cambio, se disparan SIEMPRE.
--
-- INVOKER (sin `security definer`): el trigger evalúa auth_tenant_id() con el
-- JWT del llamador real, que es justo lo que se quiere comprobar; con definer
-- se ejecutaría con los permisos del dueño de la función y la comprobación
-- perdería sentido.
--
-- Este es el MOLDE de la entidad de ejemplo: al añadir tablas hijas, comprueba
-- aquí también que cada FK apunta a una fila del MISMO tenant, con `perform 1
-- from <tabla> where id = new.<fk> and tenant_id = new.tenant_id; if not found
-- then raise ...`. Es la forma barata de impedir que un id ajeno pescado por la
-- UI corrompa los datos de otro negocio.
create or replace function public.enforce_item_consistency()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Sin JWT no hay nada que comparar: es el dueño de la base, una migración o
  -- la clave service_role, y los tres saltan la RLS de todos modos (exigirles
  -- un tenant solo rompería `db reset` y las semillas). La frontera de
  -- confianza está en quién tiene esa clave, no aquí.
  if auth.uid() is null then
    return new;
  end if;

  if new.tenant_id is distinct from auth_tenant_id() then
    raise exception 'El registro no pertenece a tu cuenta';
  end if;

  return new;
end;
$$;

-- INSERT *y* UPDATE: sin el UPDATE bastaría con crear el registro en casa y
-- luego moverlo con un PATCH al negocio de la víctima.
drop trigger if exists trg_item_consistency on public.items;
create trigger trg_item_consistency
  before insert or update on public.items
  for each row execute function public.enforce_item_consistency();

-- ──────────────────────────────────────────────────────────────────────────
-- Permisos de ejecución (misma convención que 0002)
-- ──────────────────────────────────────────────────────────────────────────
-- Nadie llama estas funciones desde el cliente: se les quita EXECUTE. Los
-- triggers siguen disparando igual, porque el permiso se comprueba al CREAR el
-- trigger, no al ejecutarlo.
-- `, anon` porque el revoke a PUBLIC no retira el EXECUTE nominal que Supabase
-- concede a ese rol (ver el comentario largo en 0002).
revoke all on function public.profiles_guard() from public, anon;
revoke all on function public.enforce_item_consistency() from public, anon;
