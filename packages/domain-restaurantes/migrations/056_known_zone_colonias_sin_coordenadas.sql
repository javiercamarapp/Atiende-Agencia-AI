-- Colonias del piloto original en known_zone: coordenadas opcionales, procedencia de la asignacion y emparejamiento exacto primero.
-- Prefijo de supabase/migrations: 20240101000326 (interno restaurantes 056).
-- Requiere: 005 (known_zone y nearest_branch_by_colonia), 016 (grant y policy de lectura), 021 (policies de escritura), 023 (branch_delivery_zone).
--
-- Problema: el piloto original traia ~190 colonias de Merida con su sucursal mas cercana, pero SIN coordenadas (el export solo trae km). known_zone
-- exige lat/lng not null, asi que no se podian cargar y el agente no reconoce ninguna colonia real. Inventar coordenadas esta prohibido (un punto
-- falso manda un pedido a la sucursal equivocada): la colonia entra SIN coordenadas y la sucursal que la atiende sale de branch_delivery_zone.
--
-- Que cambia (todo es relajar o agregar; ninguna fila existente cambia):
--   1. known_zone.lat y lng admiten null, ambas o ninguna (check). Las filas de hoy conservan sus coordenadas.
--   2. Columnas de procedencia de solo lectura para el reporte de colonias ambiguas: fuente, asignacion_fuente y la referencia que dio el piloto
--      (sucursal mas cercana y segunda con sus km). Son datos del seed, no coordenadas.
--   3. restaurantes.nearest_branch_by_colonia (misma firma): ignora las zonas sin coordenadas (no hay punto para medir) y prefiere la zona cuyo
--      nombre normalizado ES la colonia dicha antes que la mas larga que la contiene (sin esto "Centro" caia en "Centro Chichi Suarez").
--
-- Justificacion de seguridad (una por una):
--   * ALTER COLUMN ... DROP NOT NULL + check (lat is null) = (lng is null): no abre acceso a nadie; la tabla conserva RLS y las policies de 016/021
--     (lectura: sistema o staff de la organizacion; insert/delete: owner/admin de la organizacion). Una colonia sin coordenadas no se puede usar como
--     punto de distancia: la funcion de abajo y assignBranch la ignoran, asi que nunca se asigna una sucursal por una coordenada inexistente.
--   * Columnas nuevas: legibles con el SELECT de 016 (la misma policy; no guardan PII ni secretos, son nombres de sucursal y km del piloto).
--     GRANT por COLUMNA en INSERT: se revoca el insert de tabla completa de 021 y se concede solo (organization_id, name, lat, lng), que es lo unico que
--     escribe createKnownZone; las columnas de procedencia las escribe unicamente el seed (rol dueño de la tabla). `authenticated` no tiene UPDATE
--     sobre known_zone ni lo gana aqui. Sin GRANT a anon.
--   * nearest_branch_by_colonia: create or replace con la MISMA firma (uuid, text), sigue siendo SECURITY INVOKER (corre con RLS del llamador, igual
--     que 005/016) y conserva el search_path fijo de 0027 (restaurantes, public, extensions, pg_temp: unaccent vive en public o en extensions).
--     Los grants existentes sobre la funcion se conservan (create or replace no los toca).
--   * Sin cross-tenant nuevo: todo sigue acotado por organization_id.

alter table restaurantes.known_zone alter column lat drop not null;
alter table restaurantes.known_zone alter column lng drop not null;
alter table restaurantes.known_zone add constraint known_zone_lat_lng_ambas_o_ninguna check ((lat is null) = (lng is null));

alter table restaurantes.known_zone add column fuente text;
alter table restaurantes.known_zone add column asignacion_fuente text;
alter table restaurantes.known_zone add column ref_sucursal_slug text;
alter table restaurantes.known_zone add column ref_km numeric(6, 1);
alter table restaurantes.known_zone add column ref2_sucursal_slug text;
alter table restaurantes.known_zone add column ref2_km numeric(6, 1);
alter table restaurantes.known_zone add constraint known_zone_fuente_len check (fuente is null or char_length(fuente) between 1 and 80);
alter table restaurantes.known_zone add constraint known_zone_asignacion_fuente_len check (asignacion_fuente is null or char_length(asignacion_fuente) between 1 and 80);
alter table restaurantes.known_zone add constraint known_zone_ref_slug_len check (
  (ref_sucursal_slug is null or char_length(ref_sucursal_slug) between 1 and 80) and (ref2_sucursal_slug is null or char_length(ref2_sucursal_slug) between 1 and 80)
);
alter table restaurantes.known_zone add constraint known_zone_ref_km_no_negativo check ((ref_km is null or ref_km >= 0) and (ref2_km is null or ref2_km >= 0));

revoke insert on restaurantes.known_zone from authenticated;
grant insert (organization_id, name, lat, lng) on restaurantes.known_zone to authenticated;

create or replace function restaurantes.nearest_branch_by_colonia(p_organization_id uuid, p_colonia text)
 returns table(
   property_id uuid,
   organization_id uuid,
   name text,
   slug text,
   status text,
   phone text,
   address text,
   lat numeric,
   lng numeric,
   distance_km numeric,
   recognized_zone_name text
 )
 language plpgsql
 stable
 set search_path = restaurantes, public, extensions, pg_temp
as $function$
declare
  v_zone_lat numeric;
  v_zone_lng numeric;
  v_zone_name text;
  v_input_norm text := regexp_replace(unaccent(lower(p_colonia)), '[^a-z0-9]', '', 'g');
begin
  -- Solo zonas CON coordenadas: una colonia sin coordenadas (056) no sirve de punto para medir distancia. Entre las que empatan, la zona cuyo
  -- nombre normalizado es EXACTAMENTE lo dicho gana; si no, la de nombre mas largo/especifico (como antes).
  select z.name, z.lat, z.lng into v_zone_name, v_zone_lat, v_zone_lng
  from restaurantes.known_zone z
  where z.organization_id = p_organization_id
    and z.lat is not null and z.lng is not null
    and (
      v_input_norm ilike '%' || regexp_replace(unaccent(lower(z.name)), '[^a-z0-9]', '', 'g') || '%'
      or regexp_replace(unaccent(lower(z.name)), '[^a-z0-9]', '', 'g') ilike '%' || v_input_norm || '%'
    )
  order by (regexp_replace(unaccent(lower(z.name)), '[^a-z0-9]', '', 'g') = v_input_norm) desc, length(z.name) desc
  limit 1;

  -- Cero-match real: ninguna zona conocida con coordenadas se parece a lo que dijo el cliente: cero filas, nunca una sucursal adivinada.
  if v_zone_lat is null then
    return;
  end if;

  return query
  select
    bd.property_id,
    p.organization_id,
    p.name,
    bd.slug,
    p.status,
    bd.phone,
    bd.address,
    bd.lat,
    bd.lng,
    round((
      6371 * acos(
        least(1, greatest(-1,
          cos(radians(v_zone_lat)) * cos(radians(bd.lat)) * cos(radians(bd.lng) - radians(v_zone_lng))
          + sin(radians(v_zone_lat)) * sin(radians(bd.lat))
        ))
      )
    )::numeric, 1) as distance_km,
    v_zone_name
  from restaurantes.branch_detail bd
  join core.property p on p.id = bd.property_id
  where bd.organization_id = p_organization_id
    and p.status = 'active'
    and bd.lat is not null and bd.lng is not null
  order by distance_km asc
  limit 1;
end;
$function$;
