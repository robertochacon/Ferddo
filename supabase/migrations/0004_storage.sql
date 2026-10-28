-- ═══════════════════════════════════════════════════════════════════════════
-- Ferddo · 0004 · Storage (buckets + políticas por carpeta)
-- ═══════════════════════════════════════════════════════════════════════════
-- Storage tiene su propia RLS sobre storage.objects, así que el aislamiento por
-- tenant hay que declararlo otra vez aquí: la RLS de public.* no protege ni un
-- byte de un archivo subido.
--
-- Convención de rutas: TODO se guarda bajo "<tenant_id>/...". Es lo que permite
-- que la política sea una comparación de la primera carpeta del nombre y no una
-- consulta a una tabla de metadatos que habría que mantener sincronizada.
--
--   logos → PÚBLICO. Se muestran en la landing y en enlaces compartidos, donde
--           no hay sesión con la que firmar una URL. "Público" significa que
--           cualquiera con la URL lo ve: nunca subas ahí nada personal.
--   files → PRIVADO. Adjuntos del negocio; se sirven con URL firmada.
--
-- SUSPENSIÓN (0008): la escritura lleva además `not exists (... suspended_at)`.
-- La suspensión de un negocio se aplica con triggers sobre las tablas de
-- public, y storage.objects no es una de ellas: sin esta condición, una cuenta
-- suspendida por impago o por abuso seguía pudiendo BORRAR o REEMPLAZAR todos
-- sus archivos —el único original que existe— justo antes de que el super-admin
-- los mirara. El SELECT se deja intacto a propósito: suspendido = solo lectura,
-- y el negocio tiene que poder seguir descargando lo suyo.
-- `tenants.suspended_at` existe desde 0001, así que la condición se puede
-- escribir ya aquí y no hace falta redefinir las políticas más adelante.
-- El super-admin no necesita excepción: su auth_tenant_id() es NULL, así que
-- nunca casa con estas políticas (las suyas llegan en 0011).
--
-- La política del super-admin sobre estas carpetas NO está aquí: llega en 0011
-- y solo alcanza a negocios que ya pasaron por la purga (aparecen en
-- tenant_purges). Darle acceso a las carpetas de negocios VIVOS sería una vía
-- de lectura y borrado cross-tenant sin confirmación, sin bitácora y sin copia
-- de seguridad: el archivo es el único original que existe.
-- ═══════════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public)
values
  ('logos', 'logos', true),
  ('files', 'files', false)
on conflict (id) do nothing;

-- ──────────────────────────────────────────────────────────────────────────
-- logos — lectura pública, escritura solo del tenant dueño de la carpeta
-- ──────────────────────────────────────────────────────────────────────────
-- La lectura va sin `to authenticated`: es justamente el caso de un visitante
-- sin sesión mirando la landing o un enlace compartido.
drop policy if exists "logos public read" on storage.objects;
create policy "logos public read" on storage.objects
  for select using (bucket_id = 'logos');

-- La comparación se hace en TEXTO, no casteando a uuid: `(storage.foldername
-- (name))[1]` es una cadena arbitraria (alguien sube "tmp/x.png") y el cast
-- reventaría la política entera con un error de tipo en vez de devolver false.
drop policy if exists "logos tenant insert" on storage.objects;
create policy "logos tenant insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'logos'
    and (storage.foldername(name))[1] = auth_tenant_id()::text
    and not exists (select 1 from public.tenants t
                    where t.id = auth_tenant_id() and t.suspended_at is not null)
  );

-- El UPDATE lleva `using` y `with check`: sin el segundo, un rename podría
-- mover el archivo a la carpeta de otro negocio (o traerse el suyo a la tuya).
drop policy if exists "logos tenant update" on storage.objects;
create policy "logos tenant update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'logos'
    and (storage.foldername(name))[1] = auth_tenant_id()::text
    and not exists (select 1 from public.tenants t
                    where t.id = auth_tenant_id() and t.suspended_at is not null)
  )
  with check (
    bucket_id = 'logos'
    and (storage.foldername(name))[1] = auth_tenant_id()::text
    and not exists (select 1 from public.tenants t
                    where t.id = auth_tenant_id() and t.suspended_at is not null)
  );

drop policy if exists "logos tenant delete" on storage.objects;
create policy "logos tenant delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'logos'
    and (storage.foldername(name))[1] = auth_tenant_id()::text
    and not exists (select 1 from public.tenants t
                    where t.id = auth_tenant_id() and t.suspended_at is not null)
  );

-- ──────────────────────────────────────────────────────────────────────────
-- files — bucket privado: acceso completo, pero encerrado en tu carpeta
-- ──────────────────────────────────────────────────────────────────────────
-- Aquí no hay ninguna operación pública que separar, así que esto era un solo
-- `for all`. Se parte en cuatro porque la suspensión trata al SELECT distinto
-- que a la escritura: con `for all`, la condición de suspensión iría también en
-- el `using` de la lectura y le cerraría al negocio suspendido el acceso a sus
-- propios archivos, que es justo lo que NO se quiere (tiene que poder
-- exportarlos). Para añadir otro bucket privado, copia este bloque cambiando el
-- literal del bucket_id (y añádelo al array del 0011 que limpia tras una purga).
drop policy if exists "files tenant all" on storage.objects;

drop policy if exists "files tenant read" on storage.objects;
create policy "files tenant read" on storage.objects
  for select to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth_tenant_id()::text);

drop policy if exists "files tenant insert" on storage.objects;
create policy "files tenant insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'files'
    and (storage.foldername(name))[1] = auth_tenant_id()::text
    and not exists (select 1 from public.tenants t
                    where t.id = auth_tenant_id() and t.suspended_at is not null)
  );

-- `using` y `with check`, por el mismo motivo que en logos: sin el segundo, un
-- rename mueve el archivo a la carpeta de otro negocio.
drop policy if exists "files tenant update" on storage.objects;
create policy "files tenant update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'files'
    and (storage.foldername(name))[1] = auth_tenant_id()::text
    and not exists (select 1 from public.tenants t
                    where t.id = auth_tenant_id() and t.suspended_at is not null)
  )
  with check (
    bucket_id = 'files'
    and (storage.foldername(name))[1] = auth_tenant_id()::text
    and not exists (select 1 from public.tenants t
                    where t.id = auth_tenant_id() and t.suspended_at is not null)
  );

drop policy if exists "files tenant delete" on storage.objects;
create policy "files tenant delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'files'
    and (storage.foldername(name))[1] = auth_tenant_id()::text
    and not exists (select 1 from public.tenants t
                    where t.id = auth_tenant_id() and t.suspended_at is not null)
  );
