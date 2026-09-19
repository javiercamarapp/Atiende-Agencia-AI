-- Verificación sistemática de los flujos de STAFF AUTENTICADO (sesión con
-- `auth.uid()` real + membership real, a diferencia de las migraciones
-- `..._sistema_*` recientes, que cerraron los mismos flujos pero para sesión de
-- sistema) contra Postgres real (`scripts/verify-flujos-staff/`) destapó 3 bugs
-- REALES en la máquina de estados de reservas de recepción -- el flujo más básico
-- de esta vertical (crear/confirmar/check-in/check-out/cancelar una reserva) está
-- roto de punta a punta contra Postgres real hoy, aunque los ~4,800 tests
-- unitarios (repositorio en memoria) pasan en verde, porque ninguno ejercita
-- GRANTs/RLS reales. Los 3 tienen la MISMA causa raíz: piezas de esta cadena que
-- se escribieron asumiendo un privilegio que nunca se otorgó, o una semántica
-- SECURITY DEFINER que el comentario del código ya documentaba como intencional
-- pero el `create function` nunca declaró.
--
-- ============================================================================
-- Bug 1 -- hoteles.reservation_log_status_event()/..._on_insert() (triggers AFTER
-- de migrations/005_reservas_estado.sql) corren SECURITY INVOKER, no SECURITY
-- DEFINER, aunque su propio comentario de cabecera en 005 ya afirmaba lo
-- contrario ("las triggers arriba corren como el dueño de la función"). Efecto
-- real: CUALQUIER INSERT o UPDATE de status en hoteles.reservation por un staff
-- autenticado real dispara el trigger AFTER, que intenta escribir en
-- hoteles.reservation_status_event bajo el rol DEL STAFF (invoker) -- esa tabla
-- solo tiene policy de SELECT (bitácora append-only, por diseño nunca debe ser
-- escribible directo por staff), así que el INSERT del trigger viola RLS
-- ("new row violates row-level security policy for table
-- reservation_status_event") y la transacción COMPLETA revierte. Confirmado
-- contra Postgres real: `insert into hoteles.reservation (...)` como staff
-- autenticado con membership real falla siempre -- literalmente no se puede
-- crear una reserva desde recepción hoy. Mismo bloqueo para CUALQUIER
-- transición de status (confirmar, check-in, check-out, cancelar, no-show).
--
-- Arreglo: exactamente el patrón que el propio comentario de 005 ya prometía --
-- `security definer set search_path = hoteles` en ambas funciones (mismo criterio
-- YA establecido por hoteles.attendance_log_set_hash(), migrations/010, para el
-- mismo tipo de bitácora inalterable escrita por un trigger). NUNCA se abre una
-- policy de INSERT/UPDATE/DELETE a `authenticated` sobre
-- hoteles.reservation_status_event -- sigue siendo append-only, solo escribible
-- por el trigger, exactamente como el diseño original pretendía. `create or
-- replace function` preserva la vinculación de los triggers existentes, así que
-- no hace falta recrear `reservation_log_status_event_upd_trg`/
-- `reservation_log_status_event_ins_trg`.
create or replace function hoteles.reservation_log_status_event()
returns trigger language plpgsql security definer set search_path = hoteles as $$
declare
  v_actor uuid;
begin
  begin
    v_actor := nullif(current_setting('hoteles.actor_user_id', true), '')::uuid;
  exception when others then
    v_actor := null;
  end;
  insert into hoteles.reservation_status_event
    (reservation_id, organization_id, property_id, from_status, to_status, actor_user_id)
  values (new.id, new.organization_id, new.property_id, old.status, new.status, v_actor);
  return new;
end;
$$;

create or replace function hoteles.reservation_log_status_event_on_insert()
returns trigger language plpgsql security definer set search_path = hoteles as $$
declare
  v_actor uuid;
begin
  begin
    v_actor := nullif(current_setting('hoteles.actor_user_id', true), '')::uuid;
  exception when others then
    v_actor := null;
  end;
  insert into hoteles.reservation_status_event
    (reservation_id, organization_id, property_id, from_status, to_status, actor_user_id)
  values (new.id, new.organization_id, new.property_id, null, new.status, v_actor);
  return new;
end;
$$;

-- ============================================================================
-- Bug 2 -- hoteles.reservation_status_transition (migrations/005) es una tabla de
-- CATÁLOGO ESTÁTICO (los 8 pares from_status/to_status válidos de la máquina de
-- estados -- sin organization_id/property_id, sin RLS habilitado) que
-- `hoteles.reservation_validate_transition()` (trigger BEFORE UPDATE OF status,
-- SECURITY INVOKER, sin cambio -- valida ANTES de escribir, no necesita
-- SECURITY DEFINER) consulta bajo el rol del caller. Nunca se otorgó GRANT
-- SELECT a `authenticated` sobre esta tabla (solo el dueño `postgres` tiene
-- privilegios). Efecto real: la MISMA transacción bloqueada por el Bug 1 vuelve a
-- fallar aquí en cuanto se corrige el Bug 1 ("permission denied for table
-- reservation_status_transition") -- cualquier UPDATE de status por staff (o por
-- sesión de sistema, que corre bajo el MISMO rol `authenticated`) sigue roto.
--
-- Arreglo: GRANT SELECT a `authenticated` -- sin policy RLS nueva (la tabla nunca
-- tuvo RLS habilitado; no es dato de tenant, es la definición del state machine,
-- mismo perfil de "catálogo compartido, sin secreto" que un enum). No se otorga a
-- `anon` (nunca hay caller sin sesión que necesite validar una transición).
grant select on hoteles.reservation_status_transition to authenticated;

-- ============================================================================
-- Bug 3 -- hoteles.availability (migrations/003_availability.sql) solo tenía
-- GRANT SELECT a `authenticated`, nunca GRANT UPDATE, aunque su única función de
-- escritura -- `hoteles.book_availability()`/`hoteles.release_availability()` --
-- es explícitamente SECURITY INVOKER por diseño ("corre con el rol de quien
-- llama para que las políticas RLS de hoteles.availability sigan aplicando",
-- comentario original de 003). Efecto real: `POST .../reservas` (crear reserva,
-- reservas.ts:270, `repo.bookAvailability`) y la liberación de inventario al
-- cancelar/no-show (reservas.ts:364, `repo.releaseAvailability`) fallan siempre
-- para staff autenticado real -- ya documentado como "hallazgo adyacente, fuera
-- de alcance" por
-- packages/domain-hoteles/migrations/023_night_audit_sistema_escritura.sql (ver
-- también scripts/verify-hoteles-night-audit-sistema/README.md), confirmado aquí
-- contra Postgres real: incluso el `select ... for update` dentro de
-- `book_availability()` ya falla con "permission denied for table availability"
-- (un `for update` exige privilegio UPDATE, no solo SELECT), antes de llegar al
-- `update` explícito de la función.
--
-- Arreglo: GRANT UPDATE + policy de UPDATE con la MISMA regla de acceso que ya
-- usa la policy de SELECT hermana de esta tabla
-- (`core.has_property_access(auth.uid(), property_id)`, migrations/003) -- nunca
-- `using (true)`, nunca GRANT a `anon`. Sin GRANT INSERT: la siembra de
-- inventario (total_rooms inicial) sigue sin ruta expuesta a la app hoy (decisión
-- deliberada de Fase 1, "Disponibilidad como ruta propia queda fuera", comentario
-- original de 003) -- este PR no la agrega, solo corrige el UPDATE que
-- `book_availability`/`release_availability` YA necesitan y YA intentaban usar.
grant update on hoteles.availability to authenticated;
create policy "staff actualiza disponibilidad de su property" on hoteles.availability for update
  using (core.has_property_access(auth.uid(), property_id))
  with check (core.has_property_access(auth.uid(), property_id));
