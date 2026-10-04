-- H-P3-01 (P0, dinero) -- FOLIO CERRADO QUE ADMITE CARGOS Y CIERRE SIN GUARDA DE ESTADO (hoteles).
--
-- Defecto de integridad (disponibilidad/consistencia de saldos): "cargar" y "cerrar" un folio eran dos pasos de
-- "leer estado -> decidir -> escribir" sin ningun lock entre ambos. Dos peticiones simultaneas (cargo + cierre
-- 'saldo_cero', pago + cierre) terminaban con exito las dos y el folio quedaba 'cerrado' con un cargo o un pago nuevo
-- que el cierre nunca vio. Ninguna policy RLS ni CHECK miraba `folio.status` al insertar en charge/payment. El cierre
-- tampoco comprobaba en la base que el saldo fuera cero: lo decidia la app con una lectura previa. Port de la
-- correccion ya probada en el suelto (auditoria-2, reproducida 10/10 con Promise.all), adaptada a los esquemas y
-- tablas de este monorepo (`hoteles.*`).
--
-- Que hace (todo en la base, idempotente):
--   1. `hoteles.charge_payment_reject_on_closed_folio()` + un trigger BEFORE INSERT en `hoteles.charge` y otro en
--      `hoteles.payment`: toma `select ... for update` sobre la fila de `hoteles.folio` y, si esta 'cerrado', rechaza
--      el INSERT con SQLSTATE P0001 y mensaje `folio_cerrado: ...`.
--   2. `hoteles.folio_reject_inconsistent_close()` + un trigger BEFORE UPDATE OF status en `hoteles.folio`: cuando el
--      UPDATE cierra el folio con close_reason = 'saldo_cero', recalcula el saldo REAL (misma formula que
--      `computeBalance` de apps/api: cargos con impuesto menos pagos capturados) y lo rechaza si no es cero con
--      `cierre_saldo_distinto_de_cero: ...` (P0001).
--   3. `hoteles.system_list_in_house_reservations_for_night_audit` ya no devuelve como "folio primario" uno cerrado
--      (el cargo de hospedaje de la noche se omite como anomalia en vez de abortar la auditoria nocturna entera contra
--      el trigger del punto 1; antes se posteaba silenciosamente un cargo en un folio cerrado).
--
-- Por que cierra la carrera sin importar el orden de llegada: ambos triggers comparten el MISMO recurso de lock (la
-- fila del folio). Si el INSERT gana, el UPDATE de cierre espera a que comprometa, y su trigger recalcula el saldo YA
-- con el cargo visible (READ COMMITTED: cada sentencia ve lo comprometido) y lo rechaza. Si el UPDATE de cierre gana,
-- el INSERT espera en el `for update`, releyendo `status` ya 'cerrado', y se rechaza. Ninguna secuencia deja un folio
-- cerrado con movimientos posteriores al cierre ni cerrado como 'saldo_cero' con saldo distinto de cero. Los dos
-- triggers toman locks en el mismo orden (folio primero), asi que no hay ciclo de deadlock entre ellos.
--
-- ---------------------------------------------------------------------------------------------------------------------
-- JUSTIFICACION DE SEGURIDAD (cada funcion / trigger nuevo)
-- ---------------------------------------------------------------------------------------------------------------------
--  * `charge_payment_reject_on_closed_folio` y `folio_reject_inconsistent_close` son funciones de TRIGGER, no RPC:
--    `security definer` con `search_path` fijo (`hoteles, pg_temp`) porque `select ... for update` sobre `hoteles.folio`
--    exige privilegio UPDATE y RLS sobre la fila, y el rol `authenticated` que inserta el cargo no debe necesitar mas
--    permisos que los que ya tiene (GRANT select+insert en charge/payment, sin cambios). Solo LEEN folio/charge/payment
--    y toman el lock; no escriben nada y no reciben parametros del cliente (usan solo `new`). `revoke execute ... from
--    public`: no son invocables como funcion (un trigger no necesita EXECUTE del rol que dispara).
--  * Ningun GRANT nuevo, ninguna policy nueva, nada para `anon`. Las tablas conservan sus GRANT y RLS actuales.
--  * `system_list_in_house_reservations_for_night_audit`: se redefine con el mismo cuerpo, mismo `security definer`,
--    mismo `search_path`, mismo guard `auth.uid() is not null -> 42501` (solo sesion de sistema) y los mismos
--    grants/revokes; unico cambio: el join de folio exige `status = 'abierto'`.
--
-- Compatibilidad con la base sin migrar: el codigo TypeScript traduce el error de estos triggers a 409; contra una base
-- vieja (sin triggers) el camino anterior sigue funcionando (la guarda de la app + el `where status = 'abierto'` del
-- UPDATE de cierre, que no depende de la migracion).

create or replace function hoteles.charge_payment_reject_on_closed_folio()
returns trigger
language plpgsql
security definer
set search_path = hoteles, pg_temp
as $$
declare
  v_status text;
begin
  select status into v_status from hoteles.folio where id = new.folio_id for update;
  if not found then
    raise exception 'folio_no_encontrado: el folio % no existe', new.folio_id using errcode = 'P0001';
  end if;
  if v_status = 'cerrado' then
    raise exception 'folio_cerrado: el folio % esta cerrado y no admite nuevos movimientos', new.folio_id using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke execute on function hoteles.charge_payment_reject_on_closed_folio() from public;

drop trigger if exists charge_reject_on_closed_folio_trg on hoteles.charge;
create trigger charge_reject_on_closed_folio_trg
  before insert on hoteles.charge
  for each row execute function hoteles.charge_payment_reject_on_closed_folio();

drop trigger if exists payment_reject_on_closed_folio_trg on hoteles.payment;
create trigger payment_reject_on_closed_folio_trg
  before insert on hoteles.payment
  for each row execute function hoteles.charge_payment_reject_on_closed_folio();

create or replace function hoteles.folio_reject_inconsistent_close()
returns trigger
language plpgsql
security definer
set search_path = hoteles, pg_temp
as $$
declare
  v_charges numeric(14, 2);
  v_payments numeric(14, 2);
  v_balance numeric(14, 2);
begin
  if new.status = 'cerrado' and old.status is distinct from 'cerrado' and new.close_reason = 'saldo_cero' then
    select coalesce(sum(amount + tax_amount), 0) into v_charges from hoteles.charge where folio_id = new.id;
    select coalesce(sum(amount), 0) into v_payments from hoteles.payment where folio_id = new.id and status = 'capturado';
    v_balance := round(v_charges - v_payments, 2);
    if v_balance <> 0 then
      raise exception 'cierre_saldo_distinto_de_cero: el folio % tiene saldo % y no puede cerrarse como saldo_cero', new.id, v_balance
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function hoteles.folio_reject_inconsistent_close() from public;

drop trigger if exists folio_reject_inconsistent_close_trg on hoteles.folio;
create trigger folio_reject_inconsistent_close_trg
  before update of status on hoteles.folio
  for each row execute function hoteles.folio_reject_inconsistent_close();

-- Night audit: un folio primario cerrado ya no es destino de cargos (ver punto 3 de la cabecera).
create or replace function hoteles.system_list_in_house_reservations_for_night_audit(
  p_property_id uuid,
  p_business_date date
)
returns table (out_reservation_id uuid, out_folio_id uuid, out_nightly_price numeric)
language plpgsql security definer set search_path = hoteles as $$
begin
  if auth.uid() is not null then
    raise exception 'system_list_in_house_reservations_for_night_audit es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    select r.id, f.id, rp.price
    from hoteles.reservation r
    left join hoteles.folio f on f.reservation_id = r.id and f.is_primary and f.status = 'abierto'
    left join hoteles.rate_plan rp on rp.room_type_id = r.room_type_id and rp.property_id = r.property_id and rp.date = p_business_date
    where r.property_id = p_property_id
      and r.status in ('check_in', 'en_estancia')
      and r.check_in_date <= p_business_date
      and r.check_out_date > p_business_date;
end;
$$;

revoke execute on function hoteles.system_list_in_house_reservations_for_night_audit(uuid, date) from public;
grant execute on function hoteles.system_list_in_house_reservations_for_night_audit(uuid, date) to authenticated;
