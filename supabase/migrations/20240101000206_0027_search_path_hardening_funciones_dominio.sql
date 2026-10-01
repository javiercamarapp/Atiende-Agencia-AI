-- FASE 2 (integridad) -- endurecimiento de `search_path` para 14 funciones que
-- `get_advisors` (tipo `security`, WARN "Function Search Path Mutable") sigue
-- marcando en la base real tras 0023 (que cubrió las 4 de `core`). Defensa en
-- profundidad: una funcion sin `set search_path` resuelve los objetos SIN
-- calificar de su cuerpo con el `search_path` de SESION de quien la invoque; si
-- un cuerpo futuro referenciara uno sin calificar, un schema controlado por el
-- caller podria sombrear al esperado. Ninguna de las 14 lo hace hoy salvo
-- `restaurantes.nearest_branch_by_colonia` (usa `unaccent()` sin calificar, ver
-- abajo), asi que esto no es un hueco explotado: cierra la superficie y calla
-- el advisor.
--
-- Las 14 funciones (todas YA EXISTEN en la base real y en las migraciones del
-- repo; ninguna es `security definer`, esta migracion NO cambia eso):
--   public.get_conversation_state, public.set_conversation_state_cas
--   citas.touch_provider_calendar_accounts_updated_at, citas.audit_log_block_mutation
--   hoteles.book_availability, hoteles.lock_availability,
--   hoteles.reservation_validate_transition, hoteles.release_availability,
--   hoteles.attendance_log_block_mutation, hoteles.staff_schedule_validate_staff
--   restaurantes.nearest_branch_by_colonia, restaurantes.voice_tool_audit_block_mutation
--   licitaciones.protect_inconformidad_draft_content
--   rentas.break_glass_access_log_block_mutation
--
-- DECISION DE DISEÑO: `alter function ... set search_path` en vez de repetir un
-- `create or replace function` por funcion (el patron de 0023). Es lo MENOS
-- invasivo: no copia ningun cuerpo (no puede introducir deriva respecto de la
-- definicion que la base real tenga hoy), conserva firma, owner, volatilidad,
-- GRANT/REVOKE y triggers asociados -- solo agrega la clausula de
-- configuracion. La firma explicita en cada `alter` evita tocar sobrecargas
-- ajenas. Si una funcion no existiera, el `alter` falla y la migracion entera
-- se revierte (transaccional): no queda a medias.
--
-- Justificacion de seguridad de cada valor de `search_path` (siempre el schema
-- propio + `pg_temp` AL FINAL, para que las tablas temporales del caller nunca
-- sombreen a un objeto real):
--   * Funciones de trigger de bitacora append-only y de validacion
--     (`*_block_mutation`, `reservation_validate_transition`,
--     `touch_provider_calendar_accounts_updated_at`,
--     `protect_inconformidad_draft_content`): sin referencias a objetos de otros
--     schemas fuera de los calificados -> `<schema propio>, pg_temp`.
--   * `hoteles.book_availability` / `lock_availability` / `release_availability`:
--     todo calificado `hoteles.*` + builtins de `pg_catalog` (siempre primero
--     implicitamente) -> `hoteles, pg_temp`.
--   * `hoteles.staff_schedule_validate_staff`: llama `core.has_property_access`
--     YA calificado -> `hoteles, pg_temp`.
--   * `restaurantes.nearest_branch_by_colonia`: usa `unaccent()` SIN calificar.
--     La extension `unaccent` se instalo con `create extension if not exists`
--     (005_known_zones_and_nearest_branch.sql) en el primer schema del
--     `search_path` de ese momento: `public` en una base creada desde estas
--     migraciones, y `extensions` en un proyecto Supabase donde ya estaba
--     instalada. Para que la funcion siga resolviendola en AMBOS casos
--     (comportamiento identico en la base sin migrar y en la nueva) el path es
--     `restaurantes, public, extensions, pg_temp` (un schema inexistente en un
--     `search_path` se ignora, no es error).
--   * `public.get_conversation_state` / `set_conversation_state_cas`: construyen
--     SQL dinamico con `format('%I', p_table)` y el default `'conversations'`,
--     sin calificar -> deben seguir resolviendo `conversations` en `public`:
--     `public, pg_temp`. (Hoy sin consumidor en el codigo: ver el comentario de
--     cabecera de packages/core-conversation/migrations/001_conversation_state_cas.sql.)
--
-- NO se mueven `btree_gist` ni `unaccent` fuera de `public` (el advisor
-- "Extension in Public"): `btree_gist` respalda restricciones de exclusion
-- (clase de operadores usada por indices gist de reservas/citas) y mover una
-- extension con objetos dependientes en una base viva exige una ventana y un
-- plan de rollback propios; `unaccent` lo resuelve sin calificar la funcion
-- de arriba (con este path incluyendo `extensions` el movimiento posterior
-- queda habilitado, pero NO se hace aqui). Es riesgo de produccion sin ganancia
-- de seguridad concreta: se documenta y se deja como seguimiento.
--
-- Compatibilidad con la base sin migrar: son `alter function` sobre funciones
-- existentes -- el codigo TypeScript que las invoca (directo o via trigger)
-- sigue funcionando identico con o sin esta migracion aplicada; no hace falta
-- ningun fallback de SQLSTATE 42883/42P01/42703. Sin GRANT, policy ni funcion
-- nueva: no cambia ningun permiso.

alter function public.get_conversation_state(uuid, text)
  set search_path = public, pg_temp;
alter function public.set_conversation_state_cas(uuid, integer, text, jsonb, text)
  set search_path = public, pg_temp;

alter function citas.touch_provider_calendar_accounts_updated_at()
  set search_path = citas, pg_temp;
alter function citas.audit_log_block_mutation()
  set search_path = citas, pg_temp;

alter function hoteles.book_availability(uuid, uuid, date, integer)
  set search_path = hoteles, pg_temp;
alter function hoteles.lock_availability(uuid, uuid, date)
  set search_path = hoteles, pg_temp;
alter function hoteles.reservation_validate_transition()
  set search_path = hoteles, pg_temp;
alter function hoteles.release_availability(uuid, uuid, date, integer)
  set search_path = hoteles, pg_temp;
alter function hoteles.attendance_log_block_mutation()
  set search_path = hoteles, pg_temp;
alter function hoteles.staff_schedule_validate_staff()
  set search_path = hoteles, pg_temp;

alter function restaurantes.nearest_branch_by_colonia(uuid, text)
  set search_path = restaurantes, public, extensions, pg_temp;
alter function restaurantes.voice_tool_audit_block_mutation()
  set search_path = restaurantes, pg_temp;

alter function licitaciones.protect_inconformidad_draft_content()
  set search_path = licitaciones, pg_temp;

alter function rentas.break_glass_access_log_block_mutation()
  set search_path = rentas, pg_temp;
