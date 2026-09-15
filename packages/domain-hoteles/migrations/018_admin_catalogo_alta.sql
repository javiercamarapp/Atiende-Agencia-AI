-- Hallazgo de auditoría (CRÍTICO): "Alta de organización/property/tipos-de-
-- habitación/tarifas/huéspedes imposible sin SQL directo -- POST /reservas depende
-- de tarifas sembradas manualmente." Verificado literalmente contra el comentario
-- de la propia migración 001 (`001_hoteles_schema.sql`): "gestión de catálogo
-- (insert/update) queda fuera de Fase 1... INSERT/UPDATE quedan solo para
-- service_role, igual que hoy documenta domain-restaurantes para sus tablas de
-- catálogo administradas fuera de esta fase" -- sin una sola fila de
-- `hoteles.rate_plan` sembrada por SQL directo (`service_role`, que este monorepo
-- NO aprovisiona, ver `packages/domain-rentas/src/onboarding/repository.ts`),
-- `POST .../reservas` SIEMPRE falla con `sin_tarifa` (quote.ts) -- el panel nunca
-- tuvo ninguna forma de sembrarla.
--
-- MISMO patrón/mismo criterio EXACTO que
-- `packages/domain-restaurantes/migrations/007_admin_backoffice_grants_and_policies.sql`
-- (leída primero como plantilla, "back-office CORE: GRANTs + policies de staff para
-- catálogo... que antes eran de solo lectura") y
-- `packages/domain-citas/migrations/011_citas_admin_backoffice_grants_and_policies.sql`:
-- puramente ADITIVA (ningún GRANT/policy existente se toca ni se reduce), y su
-- mismo criterio de alcance explícito ("Deliberadamente NO se toca `core.property`...
-- ese schema es compartido por TODAS las verticales y hoy solo `service_role` tiene
-- GRANT de escritura sobre él... Ampliar esa policy es una decisión de PLATAFORMA
-- completa, fuera del alcance de una fase de un solo vertical") aplica IDÉNTICO
-- aquí: esta migración NO toca `core.organization`/`core.property` -- alta de
-- ORGANIZACIÓN nueva y alta de PROPERTY nueva siguen requiriendo el mismo alta
-- manual que ya requerían antes de este cambio (ver el comentario de cabecera de
-- types.ts::NewRoomTypeInput para la referencia cruzada completa). Lo que SÍ cierra
-- esta migración es la parte REAL del hallazgo que bloqueaba la operación diaria de
-- una property YA existente: catálogo de tipos de habitación, habitaciones físicas,
-- tarifas y huéspedes.
--
-- ---------------------------------------------------------------------------
-- 1) GRANT insert a `authenticated` sobre las 4 tablas de catálogo -- hasta esta
--    migración solo tenían SELECT (migración 001, línea de grants:
--    "grant select on hoteles.room_type, hoteles.room, hoteles.rate_plan,
--    hoteles.guest, hoteles.reservation, hoteles.tax_config to authenticated;").
--    `rate_plan` además recibe UPDATE (corregir el precio de una temporada ya
--    sembrada sin tener que borrar primero, ver `upsertRatePlanRange`).
-- ---------------------------------------------------------------------------
grant insert on hoteles.room_type, hoteles.room, hoteles.guest to authenticated;
grant insert, update on hoteles.rate_plan to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Policies de INSERT/UPDATE -- gestión de catálogo (tipos de habitación,
--    habitaciones físicas, tarifas) es una decisión ADMINISTRATIVA (mismo criterio
--    que `hoteles.can_access_pl()`/`ATTENDANCE_ADMIN_ROLES`: owner/gm, nunca
--    frontdesk/housekeeping/fnb/accountant) -- reutiliza un helper NUEVO,
--    `hoteles.can_manage_catalog()`, en vez de `hoteles.can_access_money()`
--    (demasiado amplio: incluye frontdesk/reservations/fnb/accountant, que cobran
--    un folio pero no deben poder inventar un tipo de habitación o una tarifa).
--    Alta de HUÉSPED, en cambio, es una acción de FRONT-OF-HOUSE cotidiana (mismo
--    criterio que `MANAGE_RESERVATIONS_ROLES` de la aplicación: owner/gm/frontdesk/
--    reservations) -- reutiliza `hoteles.can_manage_reservations()`, ya existente
--    desde migrations/005_reservas_estado.sql, sin duplicar su lógica.
-- ---------------------------------------------------------------------------
create or replace function hoteles.can_manage_catalog(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role in ('owner', 'gm')
  )
$$;

create policy "catalogo: staff admin crea tipos de habitación" on hoteles.room_type for insert
  with check (hoteles.can_manage_catalog(property_id));
create policy "catalogo: staff admin crea habitaciones" on hoteles.room for insert
  with check (hoteles.can_manage_catalog(property_id));
create policy "catalogo: staff admin crea tarifas" on hoteles.rate_plan for insert
  with check (hoteles.can_manage_catalog(property_id));
create policy "catalogo: staff admin corrige tarifas" on hoteles.rate_plan for update
  using (hoteles.can_manage_catalog(property_id)) with check (hoteles.can_manage_catalog(property_id));
create policy "reservas: staff con acceso da de alta huéspedes" on hoteles.guest for insert
  with check (hoteles.can_manage_reservations(property_id));

-- ---------------------------------------------------------------------------
-- 3) Asignación de habitación FÍSICA al reservar (hallazgo CRÍTICO, quinta pieza:
--    "asignación de habitación al reservar"). Una reserva SIEMPRE se crea contra un
--    `room_type_id` (disponibilidad AGREGADA por tipo, `hoteles.availability`/
--    `book_availability()`, ya existente desde migrations/003) -- el número de
--    cuarto concreto es una decisión operativa POSTERIOR (recepción asigna al
--    check-in, o antes si ya se sabe), igual que en un PMS real. Columna NULLABLE
--    (una reserva puede permanecer sin habitación asignada indefinidamente, p.ej.
--    reservas lejanas en el futuro) con `on delete set null` (dar de baja una
--    habitación física nunca debe cascadear a borrar la reserva que la tenía
--    asignada).
-- ---------------------------------------------------------------------------
alter table hoteles.reservation add column room_id uuid references hoteles.room(id) on delete set null;
create index reservation_room_idx on hoteles.reservation (room_id) where room_id is not null;

-- `grant update (...)` de la migración 005 (`005_reservas_estado.sql`) NO incluye
-- `room_id` (columna nueva, no existía todavía) -- sin este GRANT adicional, un
-- UPDATE que solo toque `room_id` fallaría "permission denied" aunque la policy de
-- UPDATE ya existente (`"reservas: staff con acceso actualiza reservas"`, misma
-- migración 005, `hoteles.can_manage_reservations()`) sí lo autorizaría. Postgres
-- evalúa el GRANT de columna ANTES que cualquier policy RLS.
grant update (room_id) on hoteles.reservation to authenticated;
