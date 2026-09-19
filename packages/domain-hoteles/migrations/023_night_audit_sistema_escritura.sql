-- Hallazgo de auditoría (severidad CRÍTICA, punto 4 del inventario "flujos de
-- sistema bloqueados en escritura" -- ver scripts/verify-flujos-sistema/README.md y,
-- sobre todo, la sección "Punto 4 (hoteles night-audit/no-show) -- NO arreglado,
-- análisis" de scripts/verify-flujos-sistema-2/README.md, que este PR cierra):
--
-- El cron diario `POST /internal/hoteles/night-audit`
-- (`apps/api/src/routes/verticals/hoteles/night-audit.ts`, ruta 1) corre bajo sesión
-- de sistema (`packages/db/src/managed-postgres-engine.ts::withAppSession({ userId:
-- null })` -- `set local role authenticated` + `auth.uid()` SIEMPRE NULL, nunca
-- `service_role`) y ejecuta `apps/worker/src/jobs/hoteles/{night-audit,no-show}.ts`
-- (`runNightAuditForProperty`/`runNoShowSweep`). Verificado contra Postgres real
-- (introspección `pg_policies`, 142 migraciones aplicadas): TODAS las sentencias que
-- ese código emite contra `hoteles.reservation`/`rate_plan`/`tax_config`/`folio`/
-- `charge`/`payment` están bloqueadas para esa sesión -- ninguna de esas 6 tablas
-- recibió nunca un escape hatch (a diferencia de `hoteles.night_audit_run`, que SÍ lo
-- tiene desde migrations/008). Sin este fix, night-audit corre "ok" (200, sin
-- excepción, el `try/catch` por-property de `runNightAuditSweep` se traga el error)
-- pero NUNCA postea un cargo de hospedaje real ni procesa un solo no-show -- el
-- síntoma ya documentado por el PR anterior.
--
-- Inventario exacto de sentencias bloqueadas (verificado contra Postgres real, ver
-- scripts/verify-hoteles-night-audit-sistema/README.md para la evidencia ANTES/
-- DESPUÉS completa):
--
--   | Tabla                  | Sentencia bloqueada                                            | Método (postgres-repository.ts)              | Policy (sin escape hatch)                     |
--   |-------------------------|----------------------------------------------------------------|-----------------------------------------------|------------------------------------------------|
--   | hoteles.reservation     | SELECT (reservas en casa + candidatas a no-show)                | listInHouseReservationsForNightAudit / findDueNoShowReservations | "staff ve reservas de su property" (core.has_property_access) |
--   | hoteles.reservation     | UPDATE (confirmada -> no_show)                                   | transitionReservation                          | "reservas: staff con acceso actualiza reservas" (hoteles.can_manage_reservations) |
--   | hoteles.rate_plan       | SELECT (tarifa de la noche)                                      | listInHouseReservationsForNightAudit (join)    | "staff ve tarifas de su property" (core.has_property_access) |
--   | hoteles.tax_config      | SELECT (IVA/ISH/umbral)                                          | loadTaxConfig                                  | "staff ve configuración fiscal de su property" (core.has_property_access) |
--   | hoteles.folio           | SELECT/INSERT (folio primario)                                   | ensurePrimaryFolio                             | "dinero: staff con acceso {ve,crea/actualiza} folios" (hoteles.can_access_money) |
--   | hoteles.charge          | INSERT (hospedaje de la noche + penalización de no-show)         | postNightlyHospedajeCharge / insertCharge      | "dinero: staff con acceso inserta cargos" (hoteles.can_access_money) |
--   | hoteles.charge          | SELECT (resumen de caja por concepto)                            | sumChargesByConceptForBusinessDate             | "dinero: staff con acceso ve cargos" (hoteles.can_access_money) |
--   | hoteles.payment         | SELECT (resumen de caja por método)                              | sumPaymentsByMethodForBusinessDate             | "dinero: staff con acceso ve pagos" (hoteles.can_access_money) |
--
-- `hoteles.availability` (usada indirectamente por `release_availability()` al
-- liberar inventario de un no-show) tiene un gap PROPIO, previo a este PR y AJENO a la
-- sesión de sistema (ni siquiera tiene GRANT insert/update para `authenticated`, solo
-- SELECT -- `release_availability()`/`book_availability()` son `security invoker`,
-- así que ese gap bloquearía TAMBIÉN al staff autenticado, no solo al cron) -- se
-- documenta aquí como hallazgo adyacente, deliberadamente NO se toca (fuera del
-- alcance de "sesión de sistema", que es lo que pidió esta tarea; abrir GRANT/policy
-- de `hoteles.availability` para `authenticated` en general es una decisión de
-- producto distinta, con su propio análisis). La función `system_apply_no_show` de
-- abajo sortea este gap sin tocarlo: al ser `security definer`, la llamada interna a
-- `hoteles.release_availability()` corre con los privilegios del DUEÑO de la función
-- (Postgres conserva el "current user" efectivo del definer durante TODA la ejecución,
-- incluidas las funciones invoker-rights que llama desde adentro), nunca con los de
-- `authenticated` -- ni GRANT ni RLS de esa tabla aplican en este camino.
--
-- ---------------------------------------------------------------------------------
-- Restricción no negociable (repetida aquí porque es la que decide TODO el diseño de
-- abajo): NO se abren policies de INSERT/UPDATE/DELETE de `charge`/`payment`/`folio`/
-- `reservation` a la sesión de sistema -- son tablas de dinero/PII de huéspedes. Se
-- usan funciones `security definer` de solo-sistema (guard `auth.uid() is not null
-- then raise ... using errcode = '42501'`, `revoke ... from public`, `grant execute
-- ... to authenticated`, `set search_path = hoteles`, sin SQL dinámico) -- mismo
-- patrón YA establecido por `hoteles.system_find_voice_agent_config`
-- (...000139_022_hoteles_sistema_voz_whatsapp_escritura.sql) y por
-- `despachos.system_record_collection_event`/`licitaciones.system_record_renewal_alert`
-- (...000141/142, segunda parte de esta misma serie).
--
-- Por qué NO se recalcula nada fiscal/de penalización en SQL (mandato explícito de
-- esta tarea): el cálculo de la tarifa de la noche + IVA/ISH ya vive en
-- `planNightlyHospedajeCharges`/`computeChargeAmounts` (TypeScript puro,
-- night-audit/engine.ts + folioEngine.ts) y el de la penalización de no-show en
-- `evaluateNoShowPenaltyBase`/`computeNoShowPenaltyAmounts` (folioEngine.ts,
-- TypeScript puro). Ninguna de las 2 funciones de escritura de abajo
-- (`system_post_night_audit_charge`/`system_apply_no_show`) recibe una tarifa cruda ni
-- un `totalAmount` para calcular nada -- ambas reciben `p_net_amount`/`p_tax_amount`
-- YA CALCULADOS por TypeScript y SOLO los persisten, después de validar invariantes
-- baratos (la reserva pertenece a esa property+organización y está en un estado que
-- admite el cargo, el folio es el PRIMARIO de esa reserva, los montos no son
-- negativos) -- SQL nunca decide un monto, solo lo valida y lo guarda. La unicidad de
-- "una sola noche de hospedaje por folio" sigue delegada íntegramente al índice único
-- parcial YA existente (`charge_folio_stay_date_hospedaje_idx`, migrations/001) vía
-- `insert ... on conflict ... do nothing` -- ninguna función de abajo introduce un
-- mecanismo de dedupe nuevo.
--
-- Por qué `system_apply_no_show` SÍ hace "transición + penalización" en una sola
-- llamada atómica (a diferencia de `system_post_night_audit_charge`, que recibe un
-- `folioId` ya resuelto por `system_list_in_house_reservations_for_night_audit`):
-- `evaluateNoShowPenaltyBase(reserva)` solo necesita `totalAmount`/`checkInDate`/
-- `checkOutDate` -- los 3 YA están disponibles en la fila CANDIDATA (antes de
-- reclamarla), nunca cambian por la transición de estado en sí. Esto permite que
-- `apps/worker/src/jobs/hoteles/no-show.ts` calcule la penalización ANTES de llamar a
-- esta función (TypeScript sigue calculando, como siempre) y se la pase YA resuelta a
-- una única llamada que hace TODO el efecto de negocio en una transacción: reclama la
-- reserva (`update ... where status = 'confirmada'`, mismo guard atómico que
-- `transitionReservation` ya usaba -- si perdió la carrera, 0 filas, no-op, SIN
-- inventar ni postear nada), libera todas las noches restantes, asegura el folio
-- primario, y postea la penalización -- exactamente la operación de negocio completa
-- que describe el análisis previo ("aplicar no-show a una reserva: transición +
-- penalización"), sin fragmentar el reclamo atómico entre 2 llamadas de red
-- separadas (más seguro que el camino de staff de 4 pasos, no menos).
--
-- Camino de staff SIN CAMBIO (restricción no negociable): el disparo manual de
-- night-audit (`POST /hoteles/:propertyId/night-audit`) y
-- `POST /hoteles/:propertyId/reservas/procesar-no-show` (ambos autenticados, mismos
-- roles de siempre) siguen invocando `loadTaxConfig`/`listInHouseReservationsForNightAudit`/
-- `postNightlyHospedajeCharge`/`findDueNoShowReservations`/`transitionReservation`/
-- `releaseAvailability`/`ensurePrimaryFolio`/`insertCharge` -- LITERAL, sin tocar una
-- sola línea de esos métodos ni de las policies que ya los gobiernan. `runNightAuditForProperty`/
-- `runNoShowSweep` (apps/worker, código COMPARTIDO por los 2 caminos) reciben un
-- parámetro nuevo `session: "staff" | "sistema"` que decide, en tiempo de ejecución,
-- cuál de los 2 juegos de métodos del repositorio invocar -- el camino "staff" hace
-- EXACTAMENTE las mismas llamadas que hacía antes de este PR, en el mismo orden, sin
-- ninguna rama nueva; el camino "sistema" (cableado SOLO en la ruta interna gateada
-- por secreto, `apps/api/src/routes/verticals/hoteles/night-audit.ts` ruta 1) usa los
-- 7 métodos `systemXxx` nuevos de esta migración.
--
-- Bitácora (restricción: "el camino de sistema debe dejar el mismo rastro que dejaría
-- el de staff, con actor sistema/night-audit"): `hoteles.fraude_audit_log`
-- (migrations/017) es EXCLUSIVA de hallazgos de fraude (escaneos/resoluciones), nunca
-- de cargos/folios/reservas en general -- no aplica aquí, no se reutiliza para no
-- mezclar dominios de auditoría distintos. El único rastro que el camino de STAFF deja
-- hoy más allá de la fila misma de `hoteles.charge`/`hoteles.folio` (que no tienen
-- columna de actor -- ninguna migración anterior la agregó) es
-- `hoteles.reservation_status_event` (migrations/005, append-only, trigger AFTER
-- UPDATE/INSERT de `hoteles.reservation`) -- y ESE trigger sigue disparando
-- exactamente igual sin importar si el UPDATE de `hoteles.reservation` corrió dentro
-- de una función `security definer` o no (los triggers de fila no distinguen el modo
-- de invocación). `system_apply_no_show` fija explícitamente
-- `set_config('hoteles.actor_user_id', '', true)` antes del UPDATE -- se traduce a
-- `actor_user_id = NULL` en la bitácora, el MISMO valor que usa hoy el camino de staff
-- para esta transición exacta (`no-show.ts` ya llama `transitionReservation(...,
-- actorUserId: null)`, documentado en migrations/005 como el actor lógico "system" --
-- nunca el humano que disparó el endpoint, ni con staff ni con cron). No se abre ni se
-- necesita una bitácora nueva.
--
-- Orden de despliegue: esta migración debe aplicarse ANTES de desplegar el código de
-- `packages/domain-hoteles/src/postgres-repository.ts`/`apps/worker/src/jobs/hoteles/*`
-- de este mismo commit -- si el código nuevo se desplegara antes, las 7 funciones
-- `systemXxx` fallarían con "function hoteles.system_... does not exist" (capturado
-- por property por el `try/catch` de `runNightAuditSweep`, igual que hoy -- nunca peor
-- que el bug ya documentado).

-- ---------------------------------------------------------------------------------
-- 1) Lectura -- lote de reservas "en casa" a auditar (reserva + folio primario +
--    tarifa de la noche), espejo EXACTO del JOIN que ya hace
--    `listInHouseReservationsForNightAudit` (postgres-repository.ts).
-- ---------------------------------------------------------------------------------
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
    left join hoteles.folio f on f.reservation_id = r.id and f.is_primary
    left join hoteles.rate_plan rp on rp.room_type_id = r.room_type_id and rp.property_id = r.property_id and rp.date = p_business_date
    where r.property_id = p_property_id
      and r.status in ('check_in', 'en_estancia')
      and r.check_in_date <= p_business_date
      and r.check_out_date > p_business_date;
end;
$$;

revoke execute on function hoteles.system_list_in_house_reservations_for_night_audit(uuid, date) from public;
grant execute on function hoteles.system_list_in_house_reservations_for_night_audit(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------------
-- 2) Lectura -- configuración fiscal de la property (IVA/ISH/umbral de descuento),
--    espejo EXACTO de `loadTaxConfig`. Compartida por night-audit Y no-show (ambos la
--    necesitan para `computeChargeAmounts`/`computeNoShowPenaltyAmounts`).
-- ---------------------------------------------------------------------------------
create or replace function hoteles.system_load_tax_config(p_property_id uuid)
returns table (out_iva_rate numeric, out_ish_rate numeric, out_discount_threshold numeric)
language plpgsql security definer set search_path = hoteles as $$
begin
  if auth.uid() is not null then
    raise exception 'system_load_tax_config es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    select t.iva_rate, t.ish_rate, t.discount_threshold
    from hoteles.tax_config t
    where t.property_id = p_property_id;
end;
$$;

revoke execute on function hoteles.system_load_tax_config(uuid) from public;
grant execute on function hoteles.system_load_tax_config(uuid) to authenticated;

-- ---------------------------------------------------------------------------------
-- 3-4) Lectura -- resumen de caja del día (cargos por concepto / pagos por método),
--    espejo EXACTO de `sumChargesByConceptForBusinessDate`/
--    `sumPaymentsByMethodForBusinessDate` -- insumo de `NightAuditSummary.
--    cargosPorConcepto`/`pagosPorMetodo`.
-- ---------------------------------------------------------------------------------
create or replace function hoteles.system_sum_charges_by_concept_for_business_date(
  p_property_id uuid,
  p_business_date date,
  p_timezone text
)
returns table (out_concept text, out_total numeric)
language plpgsql security definer set search_path = hoteles as $$
begin
  if auth.uid() is not null then
    raise exception 'system_sum_charges_by_concept_for_business_date es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    select c.concept, sum(c.amount + c.tax_amount)
    from hoteles.charge c
    where c.property_id = p_property_id
      and (c.created_at at time zone p_timezone)::date = p_business_date
    group by c.concept;
end;
$$;

revoke execute on function hoteles.system_sum_charges_by_concept_for_business_date(uuid, date, text) from public;
grant execute on function hoteles.system_sum_charges_by_concept_for_business_date(uuid, date, text) to authenticated;

create or replace function hoteles.system_sum_payments_by_method_for_business_date(
  p_property_id uuid,
  p_business_date date,
  p_timezone text
)
returns table (out_method text, out_total numeric)
language plpgsql security definer set search_path = hoteles as $$
begin
  if auth.uid() is not null then
    raise exception 'system_sum_payments_by_method_for_business_date es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    select p.method, sum(p.amount)
    from hoteles.payment p
    where p.property_id = p_property_id
      and (p.created_at at time zone p_timezone)::date = p_business_date
      and p.status = 'capturado'
    group by p.method;
end;
$$;

revoke execute on function hoteles.system_sum_payments_by_method_for_business_date(uuid, date, text) from public;
grant execute on function hoteles.system_sum_payments_by_method_for_business_date(uuid, date, text) to authenticated;

-- ---------------------------------------------------------------------------------
-- 5) Escritura -- postea el cargo de hospedaje de la noche, YA CALCULADO por
--    `planNightlyHospedajeCharges`/`computeChargeAmounts` (TypeScript). Valida (a) la
--    reserva pertenece a esta property+organización y está en un estado que admite el
--    cargo, (b) el folio es el PRIMARIO de esa reserva en esta property+organización,
--    (c) los montos no son negativos -- y delega la unicidad de "una noche por folio"
--    al índice único parcial existente (`on conflict ... do nothing`, idéntico a
--    `postNightlyHospedajeCharge`).
-- ---------------------------------------------------------------------------------
create or replace function hoteles.system_post_night_audit_charge(
  p_organization_id uuid,
  p_property_id uuid,
  p_reservation_id uuid,
  p_folio_id uuid,
  p_business_date date,
  p_net_amount numeric,
  p_tax_amount numeric
)
returns table (out_id uuid, out_created_at timestamptz, out_is_new boolean)
language plpgsql security definer set search_path = hoteles as $$
declare
  v_id uuid;
  v_created_at timestamptz;
begin
  if auth.uid() is not null then
    raise exception 'system_post_night_audit_charge es solo para la sesión de sistema' using errcode = '42501';
  end if;

  if p_net_amount < 0 or p_tax_amount < 0 then
    raise exception 'monto_invalido: el cargo de hospedaje de night-audit no admite montos negativos (reserva=%)', p_reservation_id
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from hoteles.reservation
    where id = p_reservation_id and property_id = p_property_id and organization_id = p_organization_id
      and status in ('check_in', 'en_estancia')
  ) then
    raise exception 'reserva_invalida: % no pertenece a la property/organización indicada o no está en un estado que admita el cargo de hospedaje', p_reservation_id
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from hoteles.folio
    where id = p_folio_id and reservation_id = p_reservation_id and property_id = p_property_id
      and organization_id = p_organization_id and is_primary
  ) then
    raise exception 'folio_invalido: % no es el folio primario de la reserva % en esta property/organización', p_folio_id, p_reservation_id
      using errcode = 'P0001';
  end if;

  insert into hoteles.charge (organization_id, property_id, folio_id, description, amount, tax_amount, concept, stay_date)
  values (p_organization_id, p_property_id, p_folio_id, 'Hospedaje noche del ' || p_business_date::text, p_net_amount, p_tax_amount, 'hospedaje', p_business_date)
  on conflict (folio_id, stay_date) where concept = 'hospedaje' and stay_date is not null and reverses_charge_id is null
  do nothing
  returning id, created_at into v_id, v_created_at;

  if v_id is not null then
    return query select v_id, v_created_at, true;
    return;
  end if;

  -- Perdió la carrera de `on conflict do nothing` (reintento del cron o 2 corridas
  -- concurrentes de la MISMA property+noche) -- recupera la fila que ganó, NUNCA
  -- postea una segunda.
  select id, created_at into v_id, v_created_at
  from hoteles.charge
  where folio_id = p_folio_id and stay_date = p_business_date and concept = 'hospedaje' and reverses_charge_id is null;

  if v_id is null then
    raise exception 'system_post_night_audit_charge: conflicto de indice unico sin fila existente recuperable (folio=%, noche=%)', p_folio_id, p_business_date
      using errcode = 'P0001';
  end if;

  return query select v_id, v_created_at, false;
end;
$$;

revoke execute on function hoteles.system_post_night_audit_charge(uuid, uuid, uuid, uuid, date, numeric, numeric) from public;
grant execute on function hoteles.system_post_night_audit_charge(uuid, uuid, uuid, uuid, date, numeric, numeric) to authenticated;

-- ---------------------------------------------------------------------------------
-- 6) Lectura -- candidatas a no-show, versión MÍNIMA (solo los 3 campos que
--    `evaluateNoShowPenaltyBase` necesita: `totalAmount`/`checkInDate`/
--    `checkOutDate`) -- nunca expone el resto de la fila por esta vía system-only, a
--    diferencia de `findDueNoShowReservations` (camino de staff, sin cambio, sigue
--    devolviendo el `ReservationRecord` completo).
-- ---------------------------------------------------------------------------------
create or replace function hoteles.system_find_due_no_show_reservations(
  p_property_id uuid,
  p_as_of_date date
)
returns table (out_reservation_id uuid, out_check_in_date date, out_check_out_date date, out_total_amount numeric)
language plpgsql security definer set search_path = hoteles as $$
begin
  if auth.uid() is not null then
    raise exception 'system_find_due_no_show_reservations es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    select r.id, r.check_in_date, r.check_out_date, r.total_amount
    from hoteles.reservation r
    where r.property_id = p_property_id and r.status = 'confirmada'
      and r.check_in_date <= coalesce(p_as_of_date, current_date)
    order by r.check_in_date asc;
end;
$$;

revoke execute on function hoteles.system_find_due_no_show_reservations(uuid, date) from public;
grant execute on function hoteles.system_find_due_no_show_reservations(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------------
-- 7) Escritura -- aplica no-show COMPLETO a una reserva: transición atómica
--    'confirmada'->'no_show' (mismo guard que `transitionReservation`: 0 filas si
--    perdió la carrera, NUNCA un error) + libera todas las noches restantes + asegura
--    el folio primario + postea la penalización YA CALCULADA (TypeScript). Ver el
--    comentario de cabecera de esta migración para por qué esto SÍ es una sola llamada
--    atómica (a diferencia de `system_post_night_audit_charge`, que recibe el
--    `folioId` ya resuelto por otra función).
-- ---------------------------------------------------------------------------------
create or replace function hoteles.system_apply_no_show(
  p_organization_id uuid,
  p_property_id uuid,
  p_reservation_id uuid,
  p_net_amount numeric,
  p_tax_amount numeric
)
returns table (out_folio_id uuid, out_charge_id uuid, out_charge_created_at timestamptz)
language plpgsql security definer set search_path = hoteles as $$
declare
  v_check_in date;
  v_check_out date;
  v_room_type_id uuid;
  v_night date;
  v_folio_id uuid;
  v_charge_id uuid;
  v_charge_created_at timestamptz;
begin
  if auth.uid() is not null then
    raise exception 'system_apply_no_show es solo para la sesión de sistema' using errcode = '42501';
  end if;

  if p_net_amount < 0 or p_tax_amount < 0 then
    raise exception 'monto_invalido: la penalización de no-show no admite montos negativos (reserva=%)', p_reservation_id
      using errcode = 'P0001';
  end if;

  -- Actor lógico SIEMPRE "system" -- mismo criterio documentado desde
  -- migrations/005 (NULL = "system" en hoteles.reservation_status_event). Se fija
  -- explícito (en vez de confiar en que nadie haya dejado un actor real puesto en la
  -- sesión) porque esta función es la ÚNICA vía de esta transición bajo sesión de
  -- sistema.
  perform set_config('hoteles.actor_user_id', '', true);

  -- Reclamo atómico -- mismo guard EXACTO que `transitionReservation(propertyId,
  -- reservationId, ['confirmada'], 'no_show', null)`: 0 filas si la reserva ya no está
  -- en 'confirmada' (perdió la carrera contra otra corrida, o pertenece a otra
  -- property/organización) -- nunca un error, nunca una segunda penalización.
  update hoteles.reservation
  set status = 'no_show'
  where id = p_reservation_id and property_id = p_property_id and organization_id = p_organization_id and status = 'confirmada'
  returning check_in_date, check_out_date, room_type_id into v_check_in, v_check_out, v_room_type_id;

  if not found then
    return; -- carrera perdida (o reserva ajena/estado distinto) -- 0 filas, nunca un error.
  end if;

  -- Libera TODAS las noches restantes -- mismo rango que `nightsBetween(checkIn,
  -- checkOut)` en TypeScript ([checkIn, checkOut), por día calendario).
  -- `hoteles.release_availability()` es `security invoker` (migrations/005) pero, al
  -- ejecutarse DESDE una función `security definer`, corre con los privilegios de esta
  -- función (el "current user" efectivo de Postgres no cambia entre una función
  -- definer y las invoker-rights que llama desde adentro, hasta que la definer
  -- retorna) -- ni el GRANT ni la RLS de `hoteles.availability` aplican en este
  -- camino, sin necesitar abrir esa tabla a `authenticated`.
  for v_night in
    select generate_series(v_check_in::timestamp, (v_check_out - 1)::timestamp, interval '1 day')::date
  loop
    perform hoteles.release_availability(p_property_id, v_room_type_id, v_night, 1);
  end loop;

  -- Asegura el folio primario -- mismo INSERT idempotente que `ensurePrimaryFolio`
  -- (`on conflict (reservation_id) where is_primary do nothing`), ninguna regla nueva.
  insert into hoteles.folio (organization_id, property_id, reservation_id, label, is_primary)
  values (p_organization_id, p_property_id, p_reservation_id, 'Principal', true)
  on conflict (reservation_id) where is_primary do nothing
  returning id into v_folio_id;

  if v_folio_id is null then
    select id into v_folio_id from hoteles.folio where reservation_id = p_reservation_id and is_primary limit 1;
  end if;

  if v_folio_id is null then
    raise exception 'system_apply_no_show: no se pudo crear ni encontrar el folio primario de la reserva %', p_reservation_id
      using errcode = 'P0001';
  end if;

  -- Penalización YA CALCULADA por TypeScript (evaluateNoShowPenaltyBase +
  -- computeNoShowPenaltyAmounts, folioEngine.ts) -- sin `stay_date` (mismo criterio
  -- que `insertCharge` en no-show.ts: nunca choca con el índice único parcial de
  -- hospedaje, que solo protege cargos CON noche real posteada). Sin `on conflict`
  -- propio a propósito: el ÚNICO guard anti-doble-captura de esta penalización es el
  -- `update ... where status = 'confirmada'` de arriba (idéntico al camino de staff,
  -- que tampoco tiene un índice único dedicado para esto).
  insert into hoteles.charge (organization_id, property_id, folio_id, description, amount, tax_amount, concept, stay_date)
  values (p_organization_id, p_property_id, v_folio_id, 'Penalización por no-show', p_net_amount, p_tax_amount, 'hospedaje', null)
  returning id, created_at into v_charge_id, v_charge_created_at;

  return query select v_folio_id, v_charge_id, v_charge_created_at;
end;
$$;

revoke execute on function hoteles.system_apply_no_show(uuid, uuid, uuid, numeric, numeric) from public;
grant execute on function hoteles.system_apply_no_show(uuid, uuid, uuid, numeric, numeric) to authenticated;
