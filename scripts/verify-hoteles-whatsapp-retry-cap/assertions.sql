-- Fixtures + assertions que verifican, contra Postgres REAL (nunca el repositorio en
-- memoria de domain-hoteles, que nunca aplica RLS/GRANT/`auth.uid()` reales), que
-- packages/domain-hoteles/migrations/027_whatsapp_retry_cap.sql cierra exactamente
-- lo que dice cerrar: "los reintentos de WhatsApp entrante no tienen tope, y cada
-- reintento de Meta vuelve a gastar un turno de LLM".
--
--   1. Sesión de sistema real: un caller con `auth.uid()` NO nulo (staff
--      autenticado real) es rechazado -- este RPC es solo para el webhook.
--   2-3. Intentos DENTRO del tope (`attempts < 5`, MAX=5) SIGUEN reclamando --
--      comportamiento IDÉNTICO al de hoy, nunca una regresión que bloquee un
--      reintento legítimo temprano.
--   4. El intento que llevaría `attempts` a 6 (YA en el tope) NO reclama --
--      `false`, sin lanzar -- nunca vuelve a correr `turnHandler.
--      handleInboundMessage` del lado de TypeScript (`handleInboundWhatsAppMessage`
--      corta ahí mismo con `claimed = false`, antes de tocar el turn handler; ver
--      su propio test con `AbortAwareFakeSession` en
--      `packages/domain-hoteles/tests/whatsapp-retry-cap.spec.ts`).
--   5. Ese mensaje queda en un estado TERMINAL explícito, `attempts_exhausted`
--      (agregado al CHECK de `status` en esta misma migración) -- nunca
--      "silenciosamente" en 'failed', indistinguible de "todavía reintentable".
--   6. El estado terminal es real: un intento posterior NUNCA vuelve a reclamarlo,
--      por más reintentos de Meta que lleguen.
--   7. Un mensaje 'processed' (turno exitoso) nunca se toca -- ni se reclama de
--      nuevo, ni se transiciona a `attempts_exhausted` (esa transición exige
--      `status = 'failed'`).
--   8. Aislamiento cross-tenant: un caller con la property_id de OTRA property
--      para un `message_id` que ya pertenece a la primera NO lo reclama y TAMPOCO
--      transiciona la fila real (la transición exige `property_id = p_property_id`
--      del CALLER, no solo del mensaje).
--   9. Esquema de PRODUCCIÓN a medio migrar (027 NO aplicada): la versión
--      ANTERIOR real de la función -- byte-idéntica a
--      `017_rpc_anti_duplicado_authenticated_grants.sql`, recreada aquí DENTRO de
--      una transacción (DDL transaccional, revertida al final -- mismo patrón que
--      `scripts/verify-restaurantes-audit-log/assertions.sql` escenario 11) --
--      reclama SIEMPRE un mensaje 'failed' sin importar `attempts`: la prueba
--      reproducible de que el bug era real, y de que
--      `PostgresHotelesRepository.claimWhatsAppMessage` (misma firma exacta,
--      `(uuid, text, text) returns boolean`) sigue funcionando contra ESE esquema
--      viejo sin ningún error de "función no existe" -- nunca hizo falta ningún
--      catch de SQLSTATE 42883 en TypeScript para este fix, justo porque la firma
--      nunca cambió.
--
-- Run vía ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs (CI) --
-- ver esos archivos para cómo se levanta el Postgres efímero. Cada escenario vive
-- en su propio `begin; ... rollback;`, AUTOCONTENIDO -- siembra directo (INSERT
-- como el superusuario que corre el script, bypass de `claim_whatsapp_message`) el
-- estado `attempts`/`status` que necesita, en vez de encadenar `commit`s entre
-- escenarios (el gate automático de run-gate.mjs solo reconoce bloques que
-- terminan en `rollback;`, y solo audita el PRIMER alias `..._deberia_ser_N`/
-- `should_fail` de cada bloque -- ver el comentario de cabecera de
-- `parseAssertions` en scripts/verify-real-postgres-ci/run-gate.mjs).
\set ON_ERROR_STOP off
\pset pager off

-- ---------------------------------------------------------------------------
-- Fixtures (persisten — corren como postgres, bypass RLS)
-- ---------------------------------------------------------------------------
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000c001', 'hoteles', 'Hotel Retry Cap', 'hotel-retry-cap')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000c1c01', '00000000-0000-0000-0000-00000000c001', 'hoteles', 'Hotel Retry Cap - Property 1'),
  ('00000000-0000-0000-0000-0000000c1c02', '00000000-0000-0000-0000-00000000c001', 'hoteles', 'Hotel Retry Cap - Property 2')
on conflict do nothing;

-- Todo lo de abajo corre como el superusuario que aplicó las migraciones (nunca
-- `set role authenticated`): `whatsapp_inbound_events` tiene RLS habilitada SIN
-- ninguna policy (deny-by-default real para cualquier rol no-owner) -- la única vía
-- de acceso real es `claim_whatsapp_message` (`security definer`, corre con los
-- privilegios de su dueño). Sin `set_config`, `auth.uid()` ya es NULL por defecto
-- -- mismo caller que `deps.engine.withAppSession({ userId: null }, ...)` produce
-- en producción para el webhook de WhatsApp (nunca `authMiddleware`).

\echo '=== 1. auth.uid() NO nulo (staff real autenticado) es RECHAZADO -- este webhook es solo para la sesion de sistema ==='
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.claim_whatsapp_message('00000000-0000-0000-0000-0000000c1c01', 'wamid-cap-01', md5('cap01-a') || md5('cap01-b')) as should_fail;
rollback;

\echo '=== 2. intento con attempts=1 (bien dentro del tope, MAX=5), status=failed: SI reclama ==='
begin;
insert into hoteles.whatsapp_inbound_events(message_id, property_id, phone_hash, status, attempts, claimed_at)
  values ('wamid-cap-02', '00000000-0000-0000-0000-0000000c1c01', md5('cap02-a') || md5('cap02-b'), 'failed', 1, now() - interval '10 minutes');
select hoteles.claim_whatsapp_message('00000000-0000-0000-0000-0000000c1c01', 'wamid-cap-02', md5('cap02-a') || md5('cap02-b'))::int as intento_dentro_del_tope_deberia_ser_1;
rollback;

\echo '=== 3. intento con attempts=4 (el ULTIMO permitido, MAX=5), status=failed: SI reclama y sube attempts a 5 ==='
begin;
insert into hoteles.whatsapp_inbound_events(message_id, property_id, phone_hash, status, attempts, claimed_at)
  values ('wamid-cap-03', '00000000-0000-0000-0000-0000000c1c01', md5('cap03-a') || md5('cap03-b'), 'failed', 4, now() - interval '10 minutes');
select hoteles.claim_whatsapp_message('00000000-0000-0000-0000-0000000c1c01', 'wamid-cap-03', md5('cap03-a') || md5('cap03-b'));
select attempts::int as attempts_tras_ultimo_intento_permitido_deberia_ser_5 from hoteles.whatsapp_inbound_events where message_id = 'wamid-cap-03';
rollback;

\echo '=== 4. intento con attempts=5 (YA en el tope), status=failed: YA NO reclama ==='
begin;
insert into hoteles.whatsapp_inbound_events(message_id, property_id, phone_hash, status, attempts, claimed_at)
  values ('wamid-cap-04', '00000000-0000-0000-0000-0000000c1c01', md5('cap04-a') || md5('cap04-b'), 'failed', 5, now() - interval '10 minutes');
select hoteles.claim_whatsapp_message('00000000-0000-0000-0000-0000000c1c01', 'wamid-cap-04', md5('cap04-a') || md5('cap04-b'))::int as intento_agotado_deberia_ser_0;
rollback;

\echo '=== 5. tras agotar el tope, el mensaje queda en el estado TERMINAL explicito attempts_exhausted (nunca silenciosamente en failed) ==='
begin;
insert into hoteles.whatsapp_inbound_events(message_id, property_id, phone_hash, status, attempts, claimed_at)
  values ('wamid-cap-05', '00000000-0000-0000-0000-0000000c1c01', md5('cap05-a') || md5('cap05-b'), 'failed', 5, now() - interval '10 minutes');
select hoteles.claim_whatsapp_message('00000000-0000-0000-0000-0000000c1c01', 'wamid-cap-05', md5('cap05-a') || md5('cap05-b'));
select (status = 'attempts_exhausted')::int as transicion_a_estado_terminal_deberia_ser_1 from hoteles.whatsapp_inbound_events where message_id = 'wamid-cap-05';
rollback;

\echo '=== 6. un mensaje YA attempts_exhausted sigue sin reclamarse, para siempre (idempotente) ==='
begin;
insert into hoteles.whatsapp_inbound_events(message_id, property_id, phone_hash, status, attempts, claimed_at)
  values ('wamid-cap-06', '00000000-0000-0000-0000-0000000c1c01', md5('cap06-a') || md5('cap06-b'), 'attempts_exhausted', 5, now() - interval '10 minutes');
select hoteles.claim_whatsapp_message('00000000-0000-0000-0000-0000000c1c01', 'wamid-cap-06', md5('cap06-a') || md5('cap06-b'))::int as reintento_sobre_agotado_deberia_ser_0;
rollback;

\echo '=== 7. un mensaje PROCESADO con exito nunca se reclama de nuevo, ni se transiciona a attempts_exhausted ==='
begin;
insert into hoteles.whatsapp_inbound_events(message_id, property_id, phone_hash, status, attempts, claimed_at)
  values ('wamid-cap-07', '00000000-0000-0000-0000-0000000c1c01', md5('cap07-a') || md5('cap07-b'), 'processed', 5, now() - interval '10 minutes');
select hoteles.claim_whatsapp_message('00000000-0000-0000-0000-0000000c1c01', 'wamid-cap-07', md5('cap07-a') || md5('cap07-b'));
select (status = 'processed')::int as mensaje_procesado_intacto_deberia_ser_1 from hoteles.whatsapp_inbound_events where message_id = 'wamid-cap-07';
rollback;

\echo '=== 8. property_id ajena (de OTRA property) para un message_id ya agotado en la property real: no reclama Y NO transiciona la fila real (la transicion exige la property_id del CALLER, no solo la del mensaje) ==='
begin;
insert into hoteles.whatsapp_inbound_events(message_id, property_id, phone_hash, status, attempts, claimed_at)
  values ('wamid-cap-08', '00000000-0000-0000-0000-0000000c1c01', md5('cap08-a') || md5('cap08-b'), 'failed', 5, now() - interval '10 minutes');
select hoteles.claim_whatsapp_message('00000000-0000-0000-0000-0000000c1c02', 'wamid-cap-08', md5('cap08-a') || md5('cap08-b'));
select (property_id = '00000000-0000-0000-0000-0000000c1c01' and status = 'failed' and attempts = 5)::int
  as fila_ajena_intacta_deberia_ser_1
  from hoteles.whatsapp_inbound_events where message_id = 'wamid-cap-08';
rollback;

\echo '=== 9. esquema de produccion A MEDIO MIGRAR (027 NO aplicada): la version ANTERIOR real de la funcion (017, sin tope) SIEMPRE reclama un mensaje failed sin importar attempts -- prueba de que el bug era real, y de que la firma nunca cambio ==='
begin;
-- Recrea, DENTRO de esta transacción (revertida al final), la versión real
-- anterior de la función -- byte-idéntica a
-- packages/domain-hoteles/migrations/017_rpc_anti_duplicado_authenticated_grants.sql
-- (mismo nombre/parámetros/tipo de retorno -- CREATE OR REPLACE nunca rompe el
-- GRANT ya existente, ni requiere ningún fallback de SQLSTATE en TypeScript).
create or replace function hoteles.claim_whatsapp_message(
  p_property_id uuid,
  p_message_id text,
  p_phone_hash text
) returns boolean
language plpgsql
security definer
set search_path = hoteles
as $BODY$
declare
  v_count integer;
begin
  if auth.uid() is not null then
    raise exception 'claim_whatsapp_message es solo para la sesión de sistema' using errcode = '42501';
  end if;

  if p_message_id is null or length(p_message_id) not between 1 and 255 or p_phone_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  insert into hoteles.whatsapp_inbound_events(message_id, property_id, phone_hash)
  values (p_message_id, p_property_id, p_phone_hash)
  on conflict (message_id) do update
    set status = 'processing',
        attempts = whatsapp_inbound_events.attempts + 1,
        claimed_at = now(),
        last_error_class = null
  where whatsapp_inbound_events.property_id = excluded.property_id
    and (
      whatsapp_inbound_events.status = 'failed'
      or (whatsapp_inbound_events.status = 'processing' and whatsapp_inbound_events.claimed_at < now() - interval '5 minutes')
    );
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$BODY$;

insert into hoteles.whatsapp_inbound_events(message_id, property_id, phone_hash, status, attempts, claimed_at)
  values ('wamid-cap-09', '00000000-0000-0000-0000-0000000c1c01', md5('cap09-a') || md5('cap09-b'), 'failed', 5, now() - interval '10 minutes');
select hoteles.claim_whatsapp_message('00000000-0000-0000-0000-0000000c1c01', 'wamid-cap-09', md5('cap09-a') || md5('cap09-b'))::int
  as esquema_viejo_sin_tope_reclama_igual_deberia_ser_1_bug_real;
rollback;
