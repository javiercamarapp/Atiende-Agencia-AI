-- Fase 2 — buscar_sucursal_cercana (voz + WhatsApp) necesita un dato
-- geográfico real de "colonias/zonas conocidas" para emparejar la referencia
-- que da el cliente, y una función que calcule la sucursal más cercana con
-- distancia real (Haversine) sobre las columnas lat/lng que
-- restaurantes.branch_detail ya tenía desde Fase 1 (001_restaurantes_schema.sql)
-- sin ningún caso de negocio que las usara todavía.
--
-- Puerto de restaurantes/supabase/migrations/20260904030000_sucursal_mas_cercana_normaliza_espacios.sql
-- (función `sucursal_mas_cercana`) — el origen era MONO-TENANT
-- (`merida_colonias` global, una sola ciudad real: Mérida). La fusión es
-- multi-tenant desde Fase 1, así que la tabla de zonas conocidas se siembra
-- POR ORGANIZACIÓN — cada restaurante puede operar en una ciudad distinta con
-- sus propias colonias/zonas/plazas reales.
--
-- CONTRATO DE SILENCIO ANTE CERO-MATCH (preservado literal, ver
-- nearest-branch.ts): si la colonia no matchea ninguna zona conocida de esta
-- organización, la función devuelve CERO FILAS — el llamador nunca
-- inventa/adivina una sucursal, pide otra referencia. Bug real que motivó
-- todo este mecanismo: antes, el LLM decidía "a ojo" la sucursal más cercana
-- a partir del nombre de la colonia sin ningún dato geográfico real — 3 de 4
-- colonias reales de prueba fallaron (hasta 2x más lejos en los casos que
-- fallaron).
create extension if not exists unaccent;

create table restaurantes.known_zone (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- Nombre de la colonia/zona/plaza real tal como la reconocería un cliente
  -- (ej. "Altabrisa", "Plaza Las Américas") — sembrado por cada restaurante
  -- según su propia ciudad de operación, nunca compartido entre organizaciones.
  name text not null,
  lat numeric not null,
  lng numeric not null,
  created_at timestamptz not null default now()
);

create index known_zone_organization_id_idx on restaurantes.known_zone (organization_id);

alter table restaurantes.known_zone enable row level security;

-- Bug real confirmado 4-sep-2026 (llamada real, ver migración del origen):
-- "Alta Brisa" (como lo dice cualquier cliente real, dos palabras) nunca
-- encontraba la zona real "altabrisa" (sembrada sin espacio) porque el
-- matching anterior era un ILIKE de substring literal — un espacio de
-- más/de menos rompe el substring aunque el texto sea "el mismo" para un
-- humano. Fix: normaliza quitando todo lo que no sea letra/número (espacios,
-- guiones, acentos, puntuación) de AMBOS lados antes de comparar.
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
as $function$
declare
  v_zone_lat numeric;
  v_zone_lng numeric;
  v_zone_name text;
  v_input_norm text := regexp_replace(unaccent(lower(p_colonia)), '[^a-z0-9]', '', 'g');
begin
  select z.name, z.lat, z.lng into v_zone_name, v_zone_lat, v_zone_lng
  from restaurantes.known_zone z
  where z.organization_id = p_organization_id
    and (
      v_input_norm ilike '%' || regexp_replace(unaccent(lower(z.name)), '[^a-z0-9]', '', 'g') || '%'
      or regexp_replace(unaccent(lower(z.name)), '[^a-z0-9]', '', 'g') ilike '%' || v_input_norm || '%'
    )
  order by length(z.name) desc
  limit 1;

  -- Cero-match real: ninguna zona conocida de esta organización se parece a
  -- lo que dijo el cliente — cero filas, nunca una sucursal adivinada.
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
