-- R-38 (storefront publico a nivel de marca): datos de marca por organizacion. Prefijo de supabase/migrations asignado
-- para esta tarea: 20240101000311 (interno 042).
--
-- Que agrega (solo ADITIVO; nada existente se modifica):
--   * `restaurantes.storefront_marca` -- UNA fila por organizacion con lo que la pagina publica muestra en su portada:
--     titular, eslogan, descripcion corta ("about"), imagen de portada, logo y tres redes sociales (Instagram, Facebook,
--     TikTok). Las imagenes y las redes son URL https (columna con CHECK); las redes ademas se validan contra el dominio
--     de la red para que el enlace publico no pueda apuntar a un sitio arbitrario.
--   * El WhatsApp de contacto del boton flotante NO es columna nueva: reutiliza `branch_detail.phone` (la misma
--     informacion de contacto que el storefront ya publica por sucursal, 001/023). Cero datos nuevos que filtrar.
--
--   * `restaurantes.callback_registrar` (R-43 + hallazgo de verificacion contra Postgres real): la funcion SOLO-SISTEMA con la que
--     la API registra una solicitud de contacto. HALLAZGO: `restaurantes.callback_requests` solo concede SELECT a `authenticated`
--     (001; ninguna migracion posterior concede INSERT ni crea policy de INSERT) y TODA sesion de la API, incluida la de sistema
--     (`auth.uid()` nulo), corre como `authenticated`. Resultado: el INSERT directo de `createCallbackRequest` (agente de voz,
--     agente de WhatsApp y, ahora, el formulario publico de eventos) falla con "permission denied for table callback_requests"
--     contra una base migrada; el repositorio en memoria de las pruebas nunca lo reveló. Reproducido en
--     scripts/verify-restaurantes-storefront (escenario 32). La solicitud de evento usa reason = 'evento' (texto libre en 001, sin
--     CHECK que ampliar) y source = 'web' (ya permitido).
--
-- Justificacion de seguridad (uno por uno):
--  * RLS habilitado. SELECT: `auth.uid() is null` (la sesion de sistema del storefront publico, que consulta siempre
--    por organization_id) o staff con membership de la organizacion duena de la fila -- mismo patron que
--    014_catalogo_publico_scoped (nunca `using (true)`: un staff de OTRA organizacion no lee la marca ajena).
--  * `anon` NO recibe ningun GRANT (el storefront publico entra por la sesion de sistema de la API, no por anon).
--  * GRANT SELECT a `authenticated` a nivel COLUMNA, sin `updated_by` (quien edito no es un dato publico).
--  * INSERT/UPDATE: solo owner/admin de la organizacion (policy con vertical_role in ('owner','admin'), mismo umbral
--    que la configuracion de canal en 021) y GRANT a nivel COLUMNA solo de las columnas de contenido; las columnas de
--    sello (`updated_at`, `updated_by`) y la llave (`organization_id` en UPDATE) no son escribibles por el cliente.
--    `with check` impide mover una fila a otra organizacion.
--  * Trigger `storefront_marca_sello` (BEFORE INSERT OR UPDATE, NO security definer, `set search_path` fijo): fija
--    `updated_at = now()` y `updated_by = auth.uid()` sin que el cliente pueda falsificarlos. No concede nada.
--  * Sin DELETE: quitar la marca es dejar los campos en null (UPDATE); no hay caso de uso real para borrar la fila.
--  * `restaurantes.callback_registrar` -- `security definer`, `set search_path` fijo, `revoke ... from public, anon`, EXECUTE solo
--    a `authenticated` y `service_role`. Exige `auth.uid() is null` (42501 si no): SOLO la sesion de sistema de la API (webhook de
--    WhatsApp, herramientas de voz, storefront publico) puede registrar; un usuario con sesion no la usa, y `anon` no tiene
--    EXECUTE. Elegida en lugar de abrir INSERT + una policy para la sesion de sistema porque un INSERT ... RETURNING exigiria
--    ademas una policy de SELECT para el sistema (leeria TODAS las solicitudes, con telefonos). La funcion no devuelve mas que
--    id, resolved y created_at de la fila que acaba de crear. Valida: organizacion existente; sucursal (si viene) perteneciente a
--    ESA organizacion (una sucursal ajena = 42501, sin sondeo); source solo voice/whatsapp/web (admin es del staff); longitudes
--    acotadas (defensa de disponibilidad: nombre 160, telefono 64, motivo 200, mensaje 2000). No concede nada mas.
--
-- COMPATIBILIDAD: el codigo TypeScript lee y escribe esta tabla dentro de SAVEPOINT y degrada contra la base SIN migrar
-- (SQLSTATE 42P01/42703): la lectura publica responde sin marca (portada generica con el nombre del restaurante) y la
-- escritura del panel responde 503 "no disponible aun", nunca 500. `createCallbackRequest` prueba primero `callback_registrar` y, si
-- la funcion aun no existe (42883), cae al INSERT directo anterior dentro de un SAVEPOINT (conducta de hoy, sin empeorarla).

create table restaurantes.storefront_marca (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  titular text check (titular is null or char_length(titular) between 1 and 120),
  eslogan text check (eslogan is null or char_length(eslogan) between 1 and 160),
  about text check (about is null or char_length(about) between 1 and 1200),
  portada_url text check (portada_url is null or (char_length(portada_url) <= 500 and portada_url ~ '^https://[^[:space:]<>"'']+$')),
  logo_url text check (logo_url is null or (char_length(logo_url) <= 500 and logo_url ~ '^https://[^[:space:]<>"'']+$')),
  instagram_url text check (instagram_url is null or (char_length(instagram_url) <= 300 and instagram_url ~ '^https://(www\.)?instagram\.com/[^[:space:]<>"'']+$')),
  facebook_url text check (facebook_url is null or (char_length(facebook_url) <= 300 and facebook_url ~ '^https://(www\.|m\.)?facebook\.com/[^[:space:]<>"'']+$')),
  tiktok_url text check (tiktok_url is null or (char_length(tiktok_url) <= 300 and tiktok_url ~ '^https://(www\.)?tiktok\.com/[^[:space:]<>"'']+$')),
  updated_at timestamptz not null default now(),
  updated_by uuid references core.staff_user(id) on delete set null
);

alter table restaurantes.storefront_marca enable row level security;

create policy "publico o su organizacion ve la marca del storefront" on restaurantes.storefront_marca for select
  using (
    auth.uid() is null
    or exists (select 1 from core.membership m where m.organization_id = storefront_marca.organization_id and m.user_id = auth.uid())
  );

create policy "owner/admin crea la marca del storefront" on restaurantes.storefront_marca for insert
  with check (exists (
    select 1 from core.membership m
    where m.organization_id = storefront_marca.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
  ));

create policy "owner/admin edita la marca del storefront" on restaurantes.storefront_marca for update
  using (exists (
    select 1 from core.membership m
    where m.organization_id = storefront_marca.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
  ))
  with check (exists (
    select 1 from core.membership m
    where m.organization_id = storefront_marca.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
  ));

create or replace function restaurantes.storefront_marca_sello() returns trigger
language plpgsql
set search_path = pg_temp
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

create trigger storefront_marca_sello before insert or update on restaurantes.storefront_marca
  for each row execute function restaurantes.storefront_marca_sello();

grant select (organization_id, titular, eslogan, about, portada_url, logo_url, instagram_url, facebook_url, tiktok_url, updated_at)
  on restaurantes.storefront_marca to authenticated;
grant insert (organization_id, titular, eslogan, about, portada_url, logo_url, instagram_url, facebook_url, tiktok_url)
  on restaurantes.storefront_marca to authenticated;
grant update (titular, eslogan, about, portada_url, logo_url, instagram_url, facebook_url, tiktok_url)
  on restaurantes.storefront_marca to authenticated;

create or replace function restaurantes.callback_registrar(
  p_organization_id uuid,
  p_property_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_reason text,
  p_message text,
  p_source text
) returns table (id uuid, resolved boolean, created_at timestamptz)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'callback_registrar es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_organization_id is null or not exists (select 1 from core.organization o where o.id = p_organization_id) then
    raise exception 'callback_registrar: organización inválida' using errcode = '22023';
  end if;
  if p_property_id is not null
     and not exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id) then
    raise exception 'callback_registrar: sucursal fuera de la organización' using errcode = '42501';
  end if;
  if p_source is null or p_source not in ('voice', 'whatsapp', 'web') then
    raise exception 'callback_registrar: canal inválido' using errcode = '22023';
  end if;
  if coalesce(char_length(btrim(p_customer_name)), 0) not between 1 and 160
     or coalesce(char_length(btrim(p_customer_phone)), 0) not between 1 and 64
     or char_length(coalesce(p_reason, '')) > 200
     or char_length(coalesce(p_message, '')) > 2000 then
    raise exception 'callback_registrar: datos fuera de rango' using errcode = '22023';
  end if;
  return query
  insert into restaurantes.callback_requests as cb (organization_id, property_id, customer_name, customer_phone, reason, message, source)
  values (p_organization_id, p_property_id, p_customer_name, p_customer_phone, p_reason, p_message, p_source)
  returning cb.id, cb.resolved, cb.created_at;
end;
$$;

revoke all on function restaurantes.callback_registrar(uuid, uuid, text, text, text, text, text) from public, anon;
grant execute on function restaurantes.callback_registrar(uuid, uuid, text, text, text, text, text) to authenticated, service_role;
