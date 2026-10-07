-- H-P3-04 (P1) -- CONFIGURACION DEL HOTEL DESDE EL PANEL: impuestos, politica de cancelacion, sobreventa por tipo y edicion de tarifas.
--
-- Hasta ahora `hoteles.tax_config` (IVA/ISH/umbral/DSA), `hoteles.cancellation_policy` y `hoteles.room_type.max_overbook_rooms`
-- solo se podian cambiar con SQL directo (`authenticated` solo tenia SELECT) y no existia ninguna bitacora de esos cambios.
-- Ademas, en una property nueva ni siquiera hay fila en `tax_config`/`cancellation_policy` hasta que alguien la inserta a mano.
-- Esta migracion agrega 4 funciones de escritura (la UNICA via de escritura para esas 3 tablas desde el panel) y una bitacora
-- append-only de cada cambio con valor anterior y nuevo.
--
-- Que hace:
--   1. `hoteles.config_audit_log`: bitacora de cambios de configuracion (impuestos, politica de cancelacion, sobreventa, tarifa).
--   2. `hoteles.cancellation_policy.guest_text`: texto de la politica para el huesped (opcional, hasta 1000 caracteres).
--   3. `hoteles.rate_plan.manual_price_at/manual_price_by` + trigger `rate_plan_manual_lock_trg`: cuando `hoteles.set_rate_price`
--      (edicion puntual de un dia por owner/gm) cambia el precio, la fila queda marcada como "precio manual"; el alta de rango
--      de tarifas del panel NO marca. `hoteles.system_apply_rate_recommendation` (migracion 029) se redefine para que la
--      aplicacion automatica (recomendacion 'pendiente') NO pise una tarifa con precio manual: lanza `tarifa_manual_vigente`
--      (P0001) y la recomendacion queda en su estado; la aprobacion humana explicita ('aprobada') si se aplica y limpia la marca.
--   4. `hoteles.set_tax_config`, `hoteles.set_cancellation_policy`, `hoteles.set_room_type_overbooking`, `hoteles.set_rate_price`.
--   5. `hoteles.record_onboarding_skip`: deja en la bitacora que owner/gm omitio el gate de "Primeros pasos" (H-P3-06).
--
-- ---------------------------------------------------------------------------------------------------------------------
-- JUSTIFICACION DE SEGURIDAD (cada GRANT, policy, trigger y funcion nueva)
-- ---------------------------------------------------------------------------------------------------------------------
--  * Las 4 funciones `set_*` son `security definer` con `search_path` fijo (`core, hoteles, pg_temp`) y `revoke execute ... from
--    public, anon`; GRANT EXECUTE solo a `authenticated`. Son `security definer` porque `authenticated` NO tiene (ni debe tener)
--    UPDATE/INSERT directo sobre tax_config/cancellation_policy/room_type: sin ellas no existe camino de escritura, y asi la
--    bitacora no se puede omitir. TODAS exigen `auth.uid() is not null` y `hoteles.can_manage_catalog(property)` (owner/gm con
--    acceso a ESA property, la misma autoridad que ya gobierna el catalogo y la zona horaria): un staff de otra organizacion, un
--    frontdesk/accountant o una sesion de sistema reciben 42501. La organizacion se deriva de `core.property`, nunca de un
--    parametro del cliente; `set_room_type_overbooking` y `set_rate_price` ademas exigen que el tipo/la tarifa pertenezcan a la
--    property indicada (no se puede tocar un id de otro hotel aunque se conozca). Validan rangos en la propia funcion (22023).
--  * `hoteles.record_onboarding_skip(property)`: misma `security definer` + `search_path` fijo + `revoke ... from public, anon` + guard owner/gm (42501 a cualquier otro) que
--    las `set_*`; solo inserta UNA fila de bitacora (area `onboarding_omitido`, sin datos personales) y devuelve su id. No cambia ninguna configuracion.
--  * `hoteles.config_audit_log`: RLS con SELECT solo para owner/gm de la property (`can_manage_catalog`); SIN GRANT de
--    insert/update/delete a `authenticated` ni a `anon`: solo las funciones `set_*` (security definer) escriben, y solo cuando
--    algo cambio de verdad (una llamada idempotente que no cambia nada no genera ruido). La bitacora guarda valores de
--    configuracion (tasas, horas, precios, cantidades), nunca datos personales.
--  * `rate_plan.manual_price_*`: las fija el trigger `rate_plan_manual_lock` (security invoker, sin parametros del cliente) SOLO
--    cuando `hoteles.set_rate_price` cambia el precio (variable local de transaccion `hoteles.rate_manual_edit`); un INSERT (alta de
--    rango del panel) nunca marca y una sesion de sistema nunca marca. Solo la aplicacion automatica (recomendacion 'pendiente')
--    respeta la marca; la aprobacion humana explicita ('aprobada') se aplica y limpia la marca. Un cliente que fije la variable
--    por su cuenta no obtiene nada: sin ser set_rate_price el UPDATE directo ya conserva el valor anterior salvo el modo 'set',
--    que solo marca al propio actor (auth.uid()) y no concede ningun permiso adicional. El GRANT UPDATE
--    de `rate_plan` ya existente (018, owner/gm por policy) no cambia; el trigger sobreescribe cualquier valor que el cliente
--    intente escribir en estas dos columnas.
--  * `system_apply_rate_recommendation` se redefine con el MISMO cuerpo, `security definer`, `search_path`, guard
--    `auth.uid() is not null -> 42501` y grants que en 029; unico cambio: el rechazo `tarifa_manual_vigente` antes de escribir.
--
-- Compatibilidad con la base sin migrar: el codigo TypeScript que llama estas funciones/tablas captura 42883/42P01/42703 con
-- SAVEPOINT y cae al valor por omision (lectura) o a "no disponible aun" (escritura); el camino anterior no cambia.
--
-- Requiere: 001 (tax_config, room_type, rate_plan), 003 (sobreventa), 005 (cancellation_policy), 006 (dsa_per_night),
-- 018 (`hoteles.can_manage_catalog`), 029 (`system_apply_rate_recommendation`).

-- ---------------------------------------------------------------------------
-- 1) Bitacora de cambios de configuracion.
-- ---------------------------------------------------------------------------
create table hoteles.config_audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  area text not null check (area in ('impuestos', 'politica_cancelacion', 'sobreventa', 'tarifa', 'onboarding_omitido')),
  entity_id uuid,
  actor_user_id uuid references core.staff_user(id) on delete set null,
  valor_anterior jsonb,
  valor_nuevo jsonb not null,
  created_at timestamptz not null default now()
);
create index config_audit_log_property_idx on hoteles.config_audit_log (property_id, created_at desc, id);

alter table hoteles.config_audit_log enable row level security;
create policy "config_audit_log: owner/gm leen la bitacora de su property" on hoteles.config_audit_log for select
  using (hoteles.can_manage_catalog(property_id));
revoke all on hoteles.config_audit_log from public, anon;
grant select on hoteles.config_audit_log to authenticated;
grant select, insert, update, delete on hoteles.config_audit_log to service_role;

-- ---------------------------------------------------------------------------
-- 2) Texto de la politica de cancelacion para el huesped.
-- ---------------------------------------------------------------------------
alter table hoteles.cancellation_policy
  add column guest_text text check (guest_text is null or length(guest_text) <= 1000);

-- ---------------------------------------------------------------------------
-- 3) Precio manual de una tarifa + trigger.
-- ---------------------------------------------------------------------------
alter table hoteles.rate_plan
  add column manual_price_at timestamptz,
  add column manual_price_by uuid references core.staff_user(id) on delete set null;

create or replace function hoteles.rate_plan_manual_lock()
returns trigger
language plpgsql
set search_path = hoteles, pg_temp
as $$
declare
  v_modo text := coalesce(current_setting('hoteles.rate_manual_edit', true), '');
begin
  -- La marca de "precio manual" la pone SOLO una edicion puntual de precio (hoteles.set_rate_price, que activa la variable local de
  -- transaccion `hoteles.rate_manual_edit = 'set'`) o la limpia la aprobacion humana explicita aplicada por el sistema
  -- (system_apply_rate_recommendation, modo 'clear'). Un INSERT (alta de rango de tarifas del panel, siembra) o un UPDATE de
  -- cualquier otro camino NO marca: cargar tarifas no es "fijar a mano" y no debe bloquear al motor. Nunca se acepta el valor
  -- que el cliente escriba en estas columnas: en INSERT quedan nulas y en UPDATE se conserva el valor anterior.
  if tg_op = 'INSERT' then
    new.manual_price_at := null;
    new.manual_price_by := null;
  elsif v_modo = 'set' and auth.uid() is not null and new.price is distinct from old.price then
    new.manual_price_at := now();
    new.manual_price_by := auth.uid();
  elsif v_modo = 'clear' and auth.uid() is null then
    new.manual_price_at := null;
    new.manual_price_by := null;
  else
    new.manual_price_at := old.manual_price_at;
    new.manual_price_by := old.manual_price_by;
  end if;
  return new;
end;
$$;
revoke execute on function hoteles.rate_plan_manual_lock() from public, anon;

create trigger rate_plan_manual_lock_trg
  before insert or update on hoteles.rate_plan
  for each row execute function hoteles.rate_plan_manual_lock();

-- El motor de revenue no pisa una tarifa con precio manual.
create or replace function hoteles.system_apply_rate_recommendation(p_recommendation_id uuid)
returns hoteles.rate_recommendation
language plpgsql security definer set search_path = core, hoteles as $$
declare
  v_rec hoteles.rate_recommendation;
begin
  if auth.uid() is not null then
    raise exception 'system_apply_rate_recommendation es solo para la sesion de sistema' using errcode = '42501';
  end if;

  select * into v_rec from hoteles.rate_recommendation where id = p_recommendation_id for update;
  if v_rec is null then
    raise exception 'recomendacion_invalida: % no existe', p_recommendation_id using errcode = 'P0001';
  end if;
  if v_rec.estado not in ('pendiente', 'aprobada') then
    raise exception 'estado_no_aplicable: la recomendacion % esta en estado "%", no se puede aplicar', p_recommendation_id, v_rec.estado using errcode = 'P0001';
  end if;

  -- Solo la aplicacion AUTOMATICA (estado 'pendiente', autopilot) respeta el precio fijado a mano. Una recomendacion 'aprobada'
  -- la aprobo una persona de forma explicita: se aplica y limpia la marca manual de esa fecha.
  if v_rec.estado = 'pendiente' and exists (
    select 1 from hoteles.rate_plan rp
    where rp.room_type_id = v_rec.room_type_id and rp.date = v_rec.fecha and rp.manual_price_at is not null
  ) then
    raise exception 'tarifa_manual_vigente: la tarifa del % tiene un precio fijado a mano; el motor no la sobreescribe', v_rec.fecha using errcode = 'P0001';
  end if;

  perform set_config('hoteles.rate_manual_edit', 'clear', true);

  insert into hoteles.rate_plan (organization_id, property_id, room_type_id, date, price, min_stay)
  values (v_rec.organization_id, v_rec.property_id, v_rec.room_type_id, v_rec.fecha, v_rec.recommended_price, v_rec.suggested_min_stay)
  on conflict (room_type_id, date) do update
    set price = excluded.price, min_stay = excluded.min_stay, updated_at = now();

  perform set_config('hoteles.rate_manual_edit', '', true);

  update hoteles.rate_recommendation set estado = 'aplicada' where id = p_recommendation_id
    returning * into v_rec;

  return v_rec;
end;
$$;

revoke execute on function hoteles.system_apply_rate_recommendation(uuid) from public;
grant execute on function hoteles.system_apply_rate_recommendation(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Funciones de escritura de configuracion (unica via, con bitacora).
-- ---------------------------------------------------------------------------
create or replace function hoteles.set_tax_config(
  p_property_id uuid,
  p_iva_rate numeric,
  p_ish_rate numeric,
  p_discount_threshold numeric,
  p_dsa_per_night numeric default 0
)
returns hoteles.tax_config
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_old jsonb;
  v_row hoteles.tax_config;
begin
  if auth.uid() is null or not hoteles.can_manage_catalog(p_property_id) then
    raise exception 'configuracion_requiere_owner_gm: solo owner/gm de la property puede cambiar los impuestos' using errcode = '42501';
  end if;
  if p_iva_rate is null or p_iva_rate < 0 or p_iva_rate > 1 or p_ish_rate is null or p_ish_rate < 0 or p_ish_rate > 1 then
    raise exception 'impuestos_invalidos: IVA e ISH deben estar entre 0 y 1' using errcode = '22023';
  end if;
  if p_discount_threshold is null or p_discount_threshold < 0 or coalesce(p_dsa_per_night, 0) < 0 then
    raise exception 'impuestos_invalidos: el umbral de descuento y el DSA no pueden ser negativos' using errcode = '22023';
  end if;
  select organization_id into v_org from core.property where id = p_property_id;
  if v_org is null then
    raise exception 'property_invalida: la property % no existe', p_property_id using errcode = '23503';
  end if;

  select jsonb_build_object('ivaRate', iva_rate, 'ishRate', ish_rate, 'discountThreshold', discount_threshold, 'dsaPerNight', dsa_per_night)
    into v_old from hoteles.tax_config where property_id = p_property_id for update;

  insert into hoteles.tax_config (property_id, organization_id, iva_rate, ish_rate, discount_threshold, dsa_per_night)
  values (p_property_id, v_org, p_iva_rate, p_ish_rate, p_discount_threshold, coalesce(p_dsa_per_night, 0))
  on conflict (property_id) do update
    set iva_rate = excluded.iva_rate, ish_rate = excluded.ish_rate, discount_threshold = excluded.discount_threshold,
        dsa_per_night = excluded.dsa_per_night, updated_at = now()
  returning * into v_row;

  if v_old is distinct from jsonb_build_object('ivaRate', v_row.iva_rate, 'ishRate', v_row.ish_rate, 'discountThreshold', v_row.discount_threshold, 'dsaPerNight', v_row.dsa_per_night) then
    insert into hoteles.config_audit_log (organization_id, property_id, area, entity_id, actor_user_id, valor_anterior, valor_nuevo)
    values (v_org, p_property_id, 'impuestos', p_property_id, auth.uid(), v_old,
      jsonb_build_object('ivaRate', v_row.iva_rate, 'ishRate', v_row.ish_rate, 'discountThreshold', v_row.discount_threshold, 'dsaPerNight', v_row.dsa_per_night));
  end if;
  return v_row;
end;
$$;

create or replace function hoteles.set_cancellation_policy(
  p_property_id uuid,
  p_free_until_hours integer,
  p_penalty_pct numeric,
  p_guest_text text default null
)
returns hoteles.cancellation_policy
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_old jsonb;
  v_new jsonb;
  v_row hoteles.cancellation_policy;
  v_text text := nullif(btrim(coalesce(p_guest_text, '')), '');
begin
  if auth.uid() is null or not hoteles.can_manage_catalog(p_property_id) then
    raise exception 'configuracion_requiere_owner_gm: solo owner/gm de la property puede cambiar la politica de cancelacion' using errcode = '42501';
  end if;
  if p_free_until_hours is null or p_free_until_hours < 0 or p_free_until_hours > 8760 then
    raise exception 'politica_invalida: las horas libres deben estar entre 0 y 8760' using errcode = '22023';
  end if;
  if p_penalty_pct is null or p_penalty_pct < 0 or p_penalty_pct > 1 then
    raise exception 'politica_invalida: la penalidad debe estar entre 0 y 1' using errcode = '22023';
  end if;
  if v_text is not null and length(v_text) > 1000 then
    raise exception 'politica_invalida: el texto para el huesped admite hasta 1000 caracteres' using errcode = '22023';
  end if;
  select organization_id into v_org from core.property where id = p_property_id;
  if v_org is null then
    raise exception 'property_invalida: la property % no existe', p_property_id using errcode = '23503';
  end if;

  select jsonb_build_object('freeUntilHours', free_until_hours, 'penaltyPct', penalty_pct, 'guestText', guest_text)
    into v_old from hoteles.cancellation_policy where property_id = p_property_id for update;

  insert into hoteles.cancellation_policy (property_id, organization_id, free_until_hours, penalty_pct, guest_text)
  values (p_property_id, v_org, p_free_until_hours, p_penalty_pct, v_text)
  on conflict (property_id) do update
    set free_until_hours = excluded.free_until_hours, penalty_pct = excluded.penalty_pct, guest_text = excluded.guest_text, updated_at = now()
  returning * into v_row;

  v_new := jsonb_build_object('freeUntilHours', v_row.free_until_hours, 'penaltyPct', v_row.penalty_pct, 'guestText', v_row.guest_text);
  if v_old is distinct from v_new then
    insert into hoteles.config_audit_log (organization_id, property_id, area, entity_id, actor_user_id, valor_anterior, valor_nuevo)
    values (v_org, p_property_id, 'politica_cancelacion', p_property_id, auth.uid(), v_old, v_new);
  end if;
  return v_row;
end;
$$;

create or replace function hoteles.set_room_type_overbooking(
  p_property_id uuid,
  p_room_type_id uuid,
  p_max_overbook_rooms integer,
  p_threshold_pct numeric default null
)
returns hoteles.room_type
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_old hoteles.room_type;
  v_row hoteles.room_type;
begin
  if auth.uid() is null or not hoteles.can_manage_catalog(p_property_id) then
    raise exception 'configuracion_requiere_owner_gm: solo owner/gm de la property puede cambiar la sobreventa' using errcode = '42501';
  end if;
  if p_max_overbook_rooms is null or p_max_overbook_rooms < 0 or p_max_overbook_rooms > 100 then
    raise exception 'sobreventa_invalida: el maximo de habitaciones de sobreventa debe estar entre 0 y 100' using errcode = '22023';
  end if;
  if p_threshold_pct is not null and (p_threshold_pct < 0 or p_threshold_pct > 100) then
    raise exception 'sobreventa_invalida: el umbral de ocupacion debe estar entre 0 y 100' using errcode = '22023';
  end if;
  select * into v_old from hoteles.room_type where id = p_room_type_id and property_id = p_property_id for update;
  if not found then
    raise exception 'tipo_habitacion_invalido: el tipo % no pertenece a la property %', p_room_type_id, p_property_id using errcode = 'P0002';
  end if;

  update hoteles.room_type
    set max_overbook_rooms = p_max_overbook_rooms,
        overbooking_occupancy_threshold_pct = coalesce(p_threshold_pct, overbooking_occupancy_threshold_pct)
    where id = p_room_type_id
    returning * into v_row;

  if v_old.max_overbook_rooms is distinct from v_row.max_overbook_rooms
     or v_old.overbooking_occupancy_threshold_pct is distinct from v_row.overbooking_occupancy_threshold_pct then
    insert into hoteles.config_audit_log (organization_id, property_id, area, entity_id, actor_user_id, valor_anterior, valor_nuevo)
    values (v_row.organization_id, p_property_id, 'sobreventa', p_room_type_id, auth.uid(),
      jsonb_build_object('maxOverbookRooms', v_old.max_overbook_rooms, 'thresholdPct', v_old.overbooking_occupancy_threshold_pct),
      jsonb_build_object('maxOverbookRooms', v_row.max_overbook_rooms, 'thresholdPct', v_row.overbooking_occupancy_threshold_pct));
  end if;
  return v_row;
end;
$$;

create or replace function hoteles.set_rate_price(
  p_property_id uuid,
  p_rate_id uuid,
  p_price numeric,
  p_min_stay integer default null
)
returns hoteles.rate_plan
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_old hoteles.rate_plan;
  v_row hoteles.rate_plan;
begin
  if auth.uid() is null or not hoteles.can_manage_catalog(p_property_id) then
    raise exception 'configuracion_requiere_owner_gm: solo owner/gm de la property puede editar tarifas' using errcode = '42501';
  end if;
  if p_price is null or p_price < 0 or p_price > 9999999999 then
    raise exception 'tarifa_invalida: el precio debe ser un numero mayor o igual a 0' using errcode = '22023';
  end if;
  if p_min_stay is not null and (p_min_stay < 1 or p_min_stay > 365) then
    raise exception 'tarifa_invalida: la estancia minima debe estar entre 1 y 365' using errcode = '22023';
  end if;
  select * into v_old from hoteles.rate_plan where id = p_rate_id and property_id = p_property_id for update;
  if not found then
    raise exception 'tarifa_no_encontrada: la tarifa % no pertenece a la property %', p_rate_id, p_property_id using errcode = 'P0002';
  end if;

  -- Idempotente: repetir la misma edicion no reescribe la fila (no cambia updated_at ni la marca) ni genera bitacora.
  if v_old.price = p_price and (p_min_stay is null or v_old.min_stay = p_min_stay) then
    return v_old;
  end if;

  perform set_config('hoteles.rate_manual_edit', 'set', true);
  update hoteles.rate_plan
    set price = p_price, min_stay = coalesce(p_min_stay, min_stay), updated_at = now()
    where id = p_rate_id
    returning * into v_row;
  perform set_config('hoteles.rate_manual_edit', '', true);

  insert into hoteles.config_audit_log (organization_id, property_id, area, entity_id, actor_user_id, valor_anterior, valor_nuevo)
  values (v_row.organization_id, p_property_id, 'tarifa', p_rate_id, auth.uid(),
    jsonb_build_object('fecha', v_old.date, 'roomTypeId', v_old.room_type_id, 'price', v_old.price, 'minStay', v_old.min_stay),
    jsonb_build_object('fecha', v_row.date, 'roomTypeId', v_row.room_type_id, 'price', v_row.price, 'minStay', v_row.min_stay));
  return v_row;
end;
$$;

revoke execute on function hoteles.set_tax_config(uuid, numeric, numeric, numeric, numeric) from public, anon;
revoke execute on function hoteles.set_cancellation_policy(uuid, integer, numeric, text) from public, anon;
revoke execute on function hoteles.set_room_type_overbooking(uuid, uuid, integer, numeric) from public, anon;
revoke execute on function hoteles.set_rate_price(uuid, uuid, numeric, integer) from public, anon;
grant execute on function hoteles.set_tax_config(uuid, numeric, numeric, numeric, numeric) to authenticated;
grant execute on function hoteles.set_cancellation_policy(uuid, integer, numeric, text) to authenticated;
grant execute on function hoteles.set_room_type_overbooking(uuid, uuid, integer, numeric) to authenticated;
grant execute on function hoteles.set_rate_price(uuid, uuid, numeric, integer) to authenticated;

create or replace function hoteles.record_onboarding_skip(p_property_id uuid)
returns uuid
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_id uuid;
begin
  if auth.uid() is null or not hoteles.can_manage_catalog(p_property_id) then
    raise exception 'configuracion_requiere_owner_gm: solo owner/gm de la property puede omitir los primeros pasos' using errcode = '42501';
  end if;
  select organization_id into v_org from core.property where id = p_property_id;
  if v_org is null then
    raise exception 'property_invalida: la property % no existe', p_property_id using errcode = '23503';
  end if;
  insert into hoteles.config_audit_log (organization_id, property_id, area, entity_id, actor_user_id, valor_anterior, valor_nuevo)
  values (v_org, p_property_id, 'onboarding_omitido', p_property_id, auth.uid(), null, jsonb_build_object('omitido', true))
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function hoteles.record_onboarding_skip(uuid) from public, anon;
grant execute on function hoteles.record_onboarding_skip(uuid) to authenticated;
