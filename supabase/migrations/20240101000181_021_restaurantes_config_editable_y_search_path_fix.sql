-- FASE 3 (producto) + 1 hallazgo de FASE 2 -- ver el cuerpo del PR para el
-- alcance completo. Esta migración junta tres piezas independientes que
-- comparten el mismo prefijo asignado para esta tanda (20240101000181):
--
--   1. Fix de `search_path` -- `restaurantes.audit_log_block_mutation`
--      (migrations/019_restaurantes_audit_log.sql) salió en `get_advisors` sin
--      `set search_path` fijo. La función no resuelve NINGÚN objeto por nombre
--      sin calificar (solo hace `raise exception`), así que hoy no es explotable
--      -- pero es defensa en profundidad barata y consistente con el resto de
--      funciones `security definer`/trigger de este archivo (ver
--      `record_audit_log`, que sí lo trae desde el día uno). `create or replace`
--      preserva la lógica EXACTA, solo agrega la cláusula.
--
--   2. `restaurantes.whatsapp_channel_config` (migrations/001/017) -- la tabla
--      YA EXISTE desde Fase 1 y ya tiene policy de SELECT (017, "staff ve la
--      config de whatsapp de su organización") pero NUNCA recibió policy de
--      INSERT/UPDATE: hoy NINGUNA ruta del panel puede conectar o rotar el
--      número de WhatsApp de una organización, ni siquiera un owner. Este
--      commit conecta lo que ya está construido (mandato explícito de esta
--      fase: "el objetivo por defecto es CONECTAR, no rediseñar el modelo de
--      datos") -- nunca agrega columnas nuevas.
--
--   3. `restaurantes.known_zone` (migrations/005/016) -- mismo hueco: SELECT
--      sí existe (016), INSERT/UPDATE/DELETE nunca se agregaron. Es la única
--      pieza de datos real relacionada con "zonas de entrega" que existe hoy
--      en el schema (nombre + lat/lng por organización, usado por
--      `nearest_branch_by_colonia` para emparejar la colonia que da el cliente
--      contra la sucursal más cercana) -- NO existe ningún concepto de tarifa/
--      radio de entrega en este schema; investigado antes de escribir esta
--      migración, no se inventa aquí (ver knownGaps del PR). Exponer edición de
--      "zonas conocidas" es la interpretación honesta de "zonas de entrega
--      editables" que esta fase permite construir sin rediseñar el modelo.
--
-- Autorización elegida para (2) y (3) -- mandato explícito de esta fase ("una
-- ruta y pantalla de edición para owner/admin"): MÁS ANGOSTA que
-- MANAGER_ROLES (que sí incluye "staff", ver `restaurantes.categories`/
-- `products` -- catálogo del día a día). Config de canal/zonas es más
-- sensible y menos frecuente que precios/disponibilidad -- mismo umbral que
-- `STAFF_INVITE_ROLES` (gestión de staff). La policy RLS de abajo, sin
-- embargo, NO puede leer `vertical_role` de un string opaco a `core` con la
-- misma granularidad que la capa TS (`assertVerticalRole(STAFF_INVITE_
-- ROLES)`, ver `admin-config.ts`) -- se acota con el patrón YA usado por
-- `categories`/`products` (`exists (... core.membership ...)`, sin filtro de
-- rol) como defensa en profundidad de "solo staff de ESTA organización",
-- dejando el filtro fino owner/admin a la capa TS (igual que
-- `restaurantes.record_audit_log` deja el filtro closed-set de
-- `entity_type` a la tabla, y la capa TS decide CUÁNDO se llama con cada
-- uno) -- documentado explícitamente para que quede claro que NO es un
-- descuido: replicar el filtro exacto owner/admin en SQL exigiría leer
-- `vertical_role` (string libre de cada vertical, `core` es opaco a su
-- significado) contra una lista cerrada que solo la capa TS conoce.

create or replace function restaurantes.audit_log_block_mutation()
returns trigger
language plpgsql
set search_path = restaurantes, pg_temp
as $$
begin
  raise exception 'restaurantes_audit_log_append_only: % no está permitido sobre restaurantes.audit_log', tg_op
    using errcode = '0A000';
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) whatsapp_channel_config -- INSERT/UPDATE para staff de la organización
--    (owner/admin real vía TS, ver punto de arriba). Nunca DELETE: desconectar
--    un número de WhatsApp no tiene caller real hoy (mismo criterio "no
--    inventar superficie sin caller" que ya aplica migrations/001 al resto del
--    esquema) -- si se necesita después, es una migración propia con su propio
--    caso de uso.
-- ---------------------------------------------------------------------------
drop policy if exists "staff conecta whatsapp de su organización" on restaurantes.whatsapp_channel_config;
create policy "staff conecta whatsapp de su organización" on restaurantes.whatsapp_channel_config for insert
  with check (exists (
    select 1 from core.membership m
    where m.organization_id = whatsapp_channel_config.organization_id and m.user_id = auth.uid()
  ));

drop policy if exists "staff actualiza whatsapp de su organización" on restaurantes.whatsapp_channel_config;
create policy "staff actualiza whatsapp de su organización" on restaurantes.whatsapp_channel_config for update
  using (exists (
    select 1 from core.membership m
    where m.organization_id = whatsapp_channel_config.organization_id and m.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from core.membership m
    where m.organization_id = whatsapp_channel_config.organization_id and m.user_id = auth.uid()
  ));

grant insert, update on restaurantes.whatsapp_channel_config to authenticated;

-- ---------------------------------------------------------------------------
-- 3) known_zone -- INSERT/UPDATE/DELETE para staff de la organización (owner/
--    admin real vía TS). Sin policy de UPDATE dedicada -- el CRUD real
--    (`admin-config.ts`) es alta/baja (nombre+lat+lng se define una vez al
--    sembrar la zona; corregir una coordenada es "borrar y volver a crear",
--    consistente con no exponer un PATCH sin caller real todavía).
-- ---------------------------------------------------------------------------
drop policy if exists "staff agrega zonas conocidas de su organización" on restaurantes.known_zone;
create policy "staff agrega zonas conocidas de su organización" on restaurantes.known_zone for insert
  with check (exists (
    select 1 from core.membership m
    where m.organization_id = known_zone.organization_id and m.user_id = auth.uid()
  ));

drop policy if exists "staff borra zonas conocidas de su organización" on restaurantes.known_zone;
create policy "staff borra zonas conocidas de su organización" on restaurantes.known_zone for delete
  using (exists (
    select 1 from core.membership m
    where m.organization_id = known_zone.organization_id and m.user_id = auth.uid()
  ));

grant insert, delete on restaurantes.known_zone to authenticated;
