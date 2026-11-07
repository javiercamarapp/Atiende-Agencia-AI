-- Onboarding P0 hoteles: inventario generado desde las habitaciones y configuracion de impuestos por defecto.
--
-- Problema (investigacion A §3.2/§3.5): ningun codigo de producto escribia hoteles.availability (book_availability, unica via de reserva,
-- responde `sin_disponibilidad` si no hay fila por tipo y noche) y sin fila en hoteles.tax_config cotizar o crear una reserva respondia
-- 500 (loadTaxConfig lanza). Un hotel nuevo no podia llegar a su primera reserva sin SQL a mano.
--
-- Numeracion: este archivo es la 050 de hoteles aunque main llega a la 045 porque 044, 046 y 047 ya estan tomadas por PRs abiertos
-- (#401, #452 y #478); 048-049 quedan libres como margen para que esos PRs no tengan que renumerarse.
--
-- Que agrega (aditivo; ninguna tabla ni funcion existente se reemplaza):
--   0) hoteles.tax_config.seeded_default / confirmed_at / confirmed_by (nullable o con default constante: sin reescritura de tabla).
--      Los valores por omision (IVA 16 %, ISH 3 %) quedan POR CONFIRMAR: el ISH depende del estado y del municipio, y 3 % no es una
--      tasa universal. `confirmed_at is null` = el dueño todavia no reviso sus impuestos. El trigger `tax_config_marca_confirmacion`
--      fija confirmed_at/confirmed_by cuando un owner/gm GUARDA la fila con sesion de staff (p. ej. `hoteles.set_tax_config` del PR
--      #478, que hace `insert ... on conflict (property_id) do update`: el UPDATE o el INSERT no sembrado marcan la confirmacion sin
--      que #478 tenga que cambiar su funcion). Las filas que existian antes de este archivo quedan con confirmed_at nulo (nadie las
--      confirmo en el panel); no se hace backfill.
--   A) Trigger AFTER INSERT en hoteles.room_type: al crear el primer tipo de habitacion de una propiedad se siembra su fila de
--      hoteles.tax_config con los DEFAULT de la tabla (IVA 16 %, ISH 3 %, umbral 500; migracion 001) y seeded_default = true.
--      `on conflict (property_id) do nothing`: una configuracion ya capturada o editada nunca se pisa.
--   B) hoteles.generar_inventario(p_property_id, p_desde, p_hasta): crea/actualiza hoteles.availability para cada tipo de habitacion y
--      noche del rango con total_rooms = numero de habitaciones fisicas del tipo (hoteles.room), NUNCA por debajo de booked_rooms.
--      Conserva booked_rooms (solo lo mueve book_availability). Idempotente. Es la recalculacion explicita (boton/endpoint); el alta
--      de una habitacion usa C. Tambien siembra la tax_config por defecto si falta. Rango maximo 400 noches, desde ayer como minimo.
--   C) hoteles.ajustar_inventario_tipo(p_property_id, p_room_type_id, p_delta, p_desde, p_hasta): ajuste INCREMENTAL de un solo tipo
--      tras dar de alta (+1) o de baja (-1) una habitacion. Suma el delta a las noches que ya existen (respeta un total capturado a mano
--      con otro criterio: solo lo desplaza en uno) sin bajar de booked_rooms ni de 0, y crea solo las noches que faltan con el conteo
--      actual de habitaciones. No toca otros tipos ni recalcula toda la propiedad.
--
-- Justificacion de seguridad:
--   * 0: columnas nuevas sin GRANT nuevo (authenticated ya solo tiene SELECT en tax_config, migracion 001). El trigger de confirmacion es
--     security invoker, sin parametros del cliente; marca con auth.uid() solo cuando hay sesion de staff, y las unicas vias de escritura
--     con sesion de staff son funciones definer que ya exigen owner/gm (#478 set_tax_config; las semillas de este archivo marcan
--     seeded_default y el trigger las deja sin confirmar).
--   * A: funcion de trigger security definer (authenticated no tiene INSERT en hoteles.tax_config y el owner/gm que crea el tipo no debe
--     necesitarlo), `set search_path = hoteles, pg_temp`, solo inserta la fila de la MISMA propiedad/organizacion del tipo recien creado
--     (que ya paso la policy de 018: can_manage_catalog). `revoke all ... from public`: no es invocable como RPC.
--   * B y C: security definer, `set search_path = hoteles, core, pg_temp`, `revoke all from public, anon`, execute solo a authenticated.
--     Con sesion de staff exigen hoteles.can_manage_catalog(p_property_id) (owner/gm con acceso a ESA propiedad; 42501 si no): un staff de
--     otra organizacion o sin rol no escribe nada. Sesion de sistema (auth.uid() nulo) permitida para crons. Validan el rango (22023) y que
--     la propiedad sea de hoteles (P0002); C ademas exige que el tipo sea de esa propiedad (P0002) y delta -1 o +1 (22023). Solo escriben
--     filas de la propiedad indicada; la organizacion se toma de core.property, nunca de un parametro. No se crea ningun GRANT de tabla.

-- ═══════════════════════════════════════════════════════════════════════════
-- 0) tax_config: valores por omision marcados como por confirmar
-- ═══════════════════════════════════════════════════════════════════════════
alter table hoteles.tax_config add column if not exists seeded_default boolean not null default false;
alter table hoteles.tax_config add column if not exists confirmed_at timestamptz;
alter table hoteles.tax_config add column if not exists confirmed_by uuid;
comment on column hoteles.tax_config.seeded_default is
  'true = la fila la sembro la migracion 050 con los DEFAULT (IVA 16 %, ISH 3 %, umbral 500), no el hotel.';
comment on column hoteles.tax_config.confirmed_at is
  'Ultima vez que un owner/gm guardo sus impuestos desde el panel. NULL = por confirmar (el ISH depende del estado).';

create or replace function hoteles.tax_config_marca_confirmacion()
returns trigger
language plpgsql
set search_path = hoteles, pg_temp
as $$
begin
  if tg_op = 'INSERT' and new.seeded_default then
    new.confirmed_at := null;
    new.confirmed_by := null;
  elsif auth.uid() is not null then
    -- Guardado con sesion de staff (solo via funciones definer que exigen owner/gm): cuenta como confirmacion, aunque los valores
    -- no cambien (el dueño revisa y acepta el 16 %/3 %).
    new.confirmed_at := now();
    new.confirmed_by := auth.uid();
  end if;
  return new;
end;
$$;
revoke all on function hoteles.tax_config_marca_confirmacion() from public, anon, authenticated;

drop trigger if exists tax_config_marca_confirmacion on hoteles.tax_config;
create trigger tax_config_marca_confirmacion
  before insert or update on hoteles.tax_config
  for each row execute function hoteles.tax_config_marca_confirmacion();

-- ═══════════════════════════════════════════════════════════════════════════
-- A) tax_config por defecto al crear el primer tipo de habitacion
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function hoteles.room_type_tax_config_por_defecto()
returns trigger
language plpgsql
security definer
set search_path = hoteles, pg_temp
as $$
begin
  insert into hoteles.tax_config (property_id, organization_id, seeded_default)
  values (new.property_id, new.organization_id, true)
  on conflict (property_id) do nothing;
  return new;
end;
$$;
revoke all on function hoteles.room_type_tax_config_por_defecto() from public, anon, authenticated;

drop trigger if exists room_type_tax_config_por_defecto on hoteles.room_type;
create trigger room_type_tax_config_por_defecto
  after insert on hoteles.room_type
  for each row execute function hoteles.room_type_tax_config_por_defecto();

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Generar (recalcular) inventario desde las habitaciones
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function hoteles.generar_inventario(p_property_id uuid, p_desde date, p_hasta date)
returns table (out_tipos integer, out_noches integer, out_filas integer)
language plpgsql
security definer
set search_path = hoteles, core, pg_temp
as $$
declare
  v_org uuid;
  v_tipos integer;
  v_filas integer;
begin
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'hoteles';
  if v_org is null then
    raise exception 'generar_inventario: propiedad de hoteles no encontrada' using errcode = 'P0002';
  end if;
  if auth.uid() is not null and not hoteles.can_manage_catalog(p_property_id) then
    raise exception 'generar_inventario: solo owner/gm de la propiedad' using errcode = '42501';
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde then
    raise exception 'generar_inventario: rango invalido' using errcode = '22023';
  end if;
  if p_desde < current_date - 1 then
    raise exception 'generar_inventario: el rango no puede empezar en el pasado' using errcode = '22023';
  end if;
  if p_hasta - p_desde + 1 > 400 then
    raise exception 'generar_inventario: maximo 400 noches por llamada' using errcode = '22023';
  end if;

  insert into hoteles.tax_config (property_id, organization_id, seeded_default) values (p_property_id, v_org, true)
  on conflict (property_id) do nothing;

  select count(*) into v_tipos from hoteles.room_type rt where rt.property_id = p_property_id;

  insert into hoteles.availability (organization_id, property_id, room_type_id, date, total_rooms)
  select v_org, p_property_id, rt.id, d::date,
         (select count(*) from hoteles.room r where r.room_type_id = rt.id and r.property_id = p_property_id)::integer
    from hoteles.room_type rt
   cross join generate_series(p_desde, p_hasta, interval '1 day') d
   where rt.property_id = p_property_id
  on conflict (property_id, room_type_id, date) do update
    set total_rooms = greatest(excluded.total_rooms, hoteles.availability.booked_rooms), updated_at = now()
    where hoteles.availability.total_rooms is distinct from greatest(excluded.total_rooms, hoteles.availability.booked_rooms);
  get diagnostics v_filas = row_count;

  return query select v_tipos, (p_hasta - p_desde + 1)::integer, v_filas;
end;
$$;
revoke all on function hoteles.generar_inventario(uuid, date, date) from public, anon;
grant execute on function hoteles.generar_inventario(uuid, date, date) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Ajuste incremental de un tipo tras el alta/baja de una habitacion
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function hoteles.ajustar_inventario_tipo(p_property_id uuid, p_room_type_id uuid, p_delta integer, p_desde date, p_hasta date)
returns table (out_ajustadas integer, out_creadas integer)
language plpgsql
security definer
set search_path = hoteles, core, pg_temp
as $$
declare
  v_org uuid;
  v_ajustadas integer;
  v_creadas integer;
begin
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'hoteles';
  if v_org is null then
    raise exception 'ajustar_inventario_tipo: propiedad de hoteles no encontrada' using errcode = 'P0002';
  end if;
  if auth.uid() is not null and not hoteles.can_manage_catalog(p_property_id) then
    raise exception 'ajustar_inventario_tipo: solo owner/gm de la propiedad' using errcode = '42501';
  end if;
  if not exists (select 1 from hoteles.room_type rt where rt.id = p_room_type_id and rt.property_id = p_property_id) then
    raise exception 'ajustar_inventario_tipo: tipo de habitacion no encontrado en la propiedad' using errcode = 'P0002';
  end if;
  if p_delta is null or p_delta not in (-1, 1) then
    raise exception 'ajustar_inventario_tipo: delta debe ser -1 o 1' using errcode = '22023';
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_desde < current_date - 1 or p_hasta - p_desde + 1 > 400 then
    raise exception 'ajustar_inventario_tipo: rango invalido' using errcode = '22023';
  end if;

  -- Primero las noches existentes (antes de crear las que faltan: las nuevas ya nacen con el conteo actual).
  update hoteles.availability a
     set total_rooms = greatest(a.total_rooms + p_delta, a.booked_rooms, 0), updated_at = now()
   where a.property_id = p_property_id and a.room_type_id = p_room_type_id and a.date between p_desde and p_hasta
     and a.total_rooms is distinct from greatest(a.total_rooms + p_delta, a.booked_rooms, 0);
  get diagnostics v_ajustadas = row_count;

  insert into hoteles.availability (organization_id, property_id, room_type_id, date, total_rooms)
  select v_org, p_property_id, p_room_type_id, d::date,
         (select count(*) from hoteles.room r where r.room_type_id = p_room_type_id and r.property_id = p_property_id)::integer
    from generate_series(p_desde, p_hasta, interval '1 day') d
  on conflict (property_id, room_type_id, date) do nothing;
  get diagnostics v_creadas = row_count;

  return query select v_ajustadas, v_creadas;
end;
$$;
revoke all on function hoteles.ajustar_inventario_tipo(uuid, uuid, integer, date, date) from public, anon;
grant execute on function hoteles.ajustar_inventario_tipo(uuid, uuid, integer, date, date) to authenticated;
