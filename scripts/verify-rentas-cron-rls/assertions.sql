-- Fixtures + assertions que verifican, contra Postgres REAL (RLS + GRANT reales -- no
-- el repositorio en memoria de domain-rentas, que nunca aplica ninguno de los dos),
-- que packages/domain-rentas/migrations/015_cron_publico_rls_escape_hatch.sql arregla
-- exactamente lo que dice arreglar:
--
--   1. La sesión de sistema (`auth.uid()` NULL, el "set local role authenticated" +
--      "request.jwt.claim.sub = ''" real de `withAppSession({userId: null})`) ahora SÍ
--      puede leer/escribir las tablas que tocan `checkout-sweep-cron.ts`/
--      `ical-sync-cron.ts`/`checkin-recordatorio.ts`/`ical-feed-publico.ts` -- antes de
--      esta migración, cada SELECT bajo esa sesión devolvía 0 filas en silencio (RLS
--      filtra la fila antes de que la query la vea, nunca un error explícito).
--   2. El escape hatch NUNCA se convierte en una fuga cross-tenant: un staff real
--      (`auth.uid()` no nulo) SIN membership/acceso a la property objetivo sigue
--      RECHAZADO exactamente igual que antes de la migración.
--   3. Las policies que la migración NO tocó a propósito siguen exactamente igual:
--      `rentas.canal_feed_externo` INSERT (`connectFeed`, solo staff) y
--      `rentas.checklist_item_tarea` SELECT/UPDATE (lectura/edición desde "Mis
--      tareas", solo staff) -- la sesión de sistema sigue SIN poder tocarlas.
--   4. `rentas.evento_canal_importado`/`rentas.bloqueo_exportado` (el hallazgo
--      adicional: nunca tuvieron policy de insert/update) ahora aceptan escritura de
--      la sesión de sistema, pero siguen rechazando a CUALQUIER staff real (incluso
--      uno con membership real) -- nunca fue parte del diseño que el staff escriba
--      bookkeeping de sync directamente.
--
-- Run vía ./run.sh -- ver ese archivo para cómo se levanta el Postgres efímero + el
-- mock mínimo de plataforma (mismo patrón que scripts/verify-outbox-grants/).
--
-- Cada escenario corre en su propio `begin; ... rollback;` -- nada de esto persiste.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000a1', 'rentas', 'Org A (rentas)', 'org-a-rentas'),
  ('00000000-0000-0000-0000-0000000000a2', 'rentas', 'Org B (rentas, ajena)', 'org-b-rentas')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'rentas', 'Property A1'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', 'rentas', 'Property B1 (ajena)')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000011', 'staff-con-acceso@example.com', 'Staff Con Acceso', 'seed'),
  ('00000000-0000-0000-0000-000000000012', 'staff-sin-acceso@example.com', 'Staff Sin Acceso', 'seed')
on conflict do nothing;

-- staff 11 SÍ pertenece a la org A (con acceso a Property A1); staff 12 NO pertenece a
-- NINGUNA org -- es el "staff real pero sin acceso" de cada escenario negativo.
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-0000000000a1', null, 'admin', 'admin')
on conflict do nothing;

insert into rentas.property_config (property_id, organization_id, zona_horaria) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'America/Mexico_City')
on conflict do nothing;

insert into rentas.unidad (id, organization_id, property_id, name, duracion_minima_noches) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'Unidad A1-1', 1)
on conflict do nothing;

-- Ocupación 'reserva' confirmada con checkout ya vencido -- exactamente la forma de
-- fila que `procesarCheckoutsPendientes` busca (upper(rango) <= current_date).
insert into rentas.ocupacion (id, organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', daterange('2020-01-01', '2020-01-03', '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true)
on conflict do nothing;

\echo ''
\echo '=== checkout-sweep-cron.ts: procesarCheckoutsPendientes ==='
\echo ''

\echo '--- 1. sesion de sistema SI ve rentas.unidad/rentas.property_config (obtenerConfiguracion) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select organization_id, property_id from rentas.unidad where id = '00000000-0000-0000-0000-0000000000c1';
select zona_horaria from rentas.property_config where property_id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo '--- 2. sesion de sistema SI encuentra el checkout pendiente (query real de procesarCheckoutsPendientes) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select o.id as ocupacion_id, o.unidad_id, upper(o.rango)::text as fin
  from rentas.ocupacion o
  where o.capa = 'reserva' and o.estado = 'confirmado' and o.bloqueante
    and upper(o.rango) <= current_date
    and not exists (select 1 from rentas.tarea_operativa t where t.ocupacion_unidad_id = o.id and t.tipo = 'limpieza')
  order by upper(o.rango) limit 50;
rollback;

\echo '--- 3. sesion de sistema SI puede INSERT ... RETURNING en rentas.tarea_operativa (crearTareaLimpiezaPorCheckout) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into rentas.tarea_operativa (organization_id, property_id, unidad_id, ocupacion_unidad_id, tipo, estado, prioridad, programada_para)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', 'limpieza', 'pendiente', 'media', current_date)
  returning id as tarea_id;
rollback;

\echo '--- 4. sesion de sistema SI puede INSERT rentas.checklist_item_tarea + UPDATE rentas.tarea_operativa.buffer_ocupacion_id ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
with t as (
  insert into rentas.tarea_operativa (organization_id, property_id, unidad_id, ocupacion_unidad_id, tipo, estado, prioridad, programada_para)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', 'limpieza', 'pendiente', 'media', current_date)
  returning id
)
insert into rentas.checklist_item_tarea (tarea_id, descripcion, orden) select id, 'Tender camas', 0 from t;
update rentas.tarea_operativa set buffer_ocupacion_id = null where property_id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo '--- 5. sesion de sistema SI puede crear el bloqueo BUFFER_LIMPIEZA (INSERT rentas.ocupacion RETURNING, crearBloqueo) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into rentas.ocupacion (organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', daterange('2020-01-03', '2020-01-04', '[)'), 'bloqueo', 'BUFFER_LIMPIEZA', 'confirmado', true)
  returning id as buffer_ocupacion_id;
rollback;

\echo '--- 6. sesion de sistema SI puede registrar conflicto_calendario (INSERT ... RETURNING, capa cruzada) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into rentas.conflicto_calendario (organization_id, property_id, unidad_id, ocupacion_a_id, ocupacion_b_id, tipo)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1', 'capa_cruzada')
  returning id;
rollback;

\echo ''
\echo '=== controles negativos: el escape hatch NUNCA abre una fuga cross-tenant ==='
\echo ''

\echo '--- 7. staff real SIN acceso a Property A1 sigue RECHAZADO en rentas.ocupacion (SELECT) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000012', true);
select count(*) as filas_visibles_deberia_ser_0 from rentas.ocupacion where property_id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo '--- 8. staff real SIN acceso sigue RECHAZADO insertando rentas.tarea_operativa ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000012', true);
insert into rentas.tarea_operativa (organization_id, property_id, unidad_id, tipo, estado, prioridad, programada_para)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', 'mantenimiento', 'pendiente', 'media', current_date)
  returning id as should_fail;
rollback;

\echo '--- 9. staff real CON acceso real sigue funcionando exactamente igual que antes (regresion) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select count(*) as filas_visibles_deberia_ser_1 from rentas.ocupacion where property_id = '00000000-0000-0000-0000-0000000000b1';
insert into rentas.tarea_operativa (organization_id, property_id, unidad_id, tipo, estado, prioridad, programada_para)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', 'inspeccion', 'pendiente', 'media', current_date)
  returning id as tarea_id;
rollback;

\echo ''
\echo '=== ical-sync-cron.ts: listFeedsActivos + ejecutarCicloImportacion ==='
\echo ''

insert into rentas.canal_feed_externo (id, organization_id, property_id, unidad_id, canal_id, url_importacion, activo)
  select '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', c.id, 'https://example.com/airbnb.ics', true
  from rentas.canal c where c.codigo = 'airbnb'
on conflict do nothing;

\echo '--- 10. sesion de sistema SI ve feeds activos (listFeedsActivos, JOIN rentas.canal) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select cfe.id, c.codigo from rentas.canal_feed_externo cfe join rentas.canal c on c.id = cfe.canal_id where cfe.activo;
rollback;

\echo '--- 11. sesion de sistema SI puede UPDATE rentas.canal_feed_externo (persistFeedSyncState) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
update rentas.canal_feed_externo set ultima_sincronizacion_exitosa_en = now() where id = '00000000-0000-0000-0000-0000000000f1';
rollback;

-- Corrección de auditoría a3 -- ANTES este escenario insertaba organization_id/
-- property_id A MANO, distinto de la forma real de
-- `postgres-repository.ts::upsertEventoImportado` (que los DERIVA con un JOIN a
-- rentas.unidad, ver scripts/verify-rentas-ical-import-postgres-real/) -- eso
-- enmascaraba por completo el hallazgo ALTA de esa auditoría: el INSERT real,
-- durante casi una semana, omitía esas dos columnas NOT NULL y reventaba 23502
-- contra Postgres real en CADA corrida, mientras este escenario (con los valores ya
-- servidos) seguía en verde. Ahora reproduce el SQL real, columna por columna (mismo
-- JOIN, mismo ON CONFLICT). Corrección de revisión de PR #175 (no bloqueante): esto
-- es SQL LITERAL copiado a mano, no el `.ts` compilado en vivo -- si alguien vuelve a
-- quitar organization_id/property_id del INSERT real SIN actualizar este archivo a
-- la par, este escenario NO lo detecta por sí solo (limitación estructural de todo
-- el tier de pruebas `scripts/verify-*/` de este repo, ver el README de
-- verify-rentas-ical-import-postgres-real/, que sí sirve como detector dedicado para
-- ese caso). Lo que este escenario SÍ prueba, de forma real contra Postgres, es que
-- la POLICY/GRANT de la sesión de sistema permite este INSERT/UPDATE columna por
-- columna -- por eso el `select count(*)` de abajo, con alias `..._deberia_ser_N`
-- (el único formato que `run-gate.mjs` valida), en vez del `select` sin alias de
-- antes, que dejaba pasar en verde incluso un INSERT que insertara 0 filas.
\echo '--- 12. sesion de sistema SI puede upsert rentas.evento_canal_importado derivando el tenant de rentas.unidad (SQL real de upsertEventoImportado, hallazgo adicional: nunca tuvo policy de insert/update) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into rentas.evento_canal_importado (organization_id, property_id, unidad_id, canal_id, uid_evento, sequence, dtstamp, hash_contenido, ocupacion_id, ultima_accion)
  select u.organization_id, u.property_id, '00000000-0000-0000-0000-0000000000c1', c.id, 'uid-evento-1', 1, now(), 'hash1', null, 'aplicar'
  from rentas.unidad u, rentas.canal c
  where u.id = '00000000-0000-0000-0000-0000000000c1' and c.codigo = 'airbnb'
  on conflict (unidad_id, canal_id, uid_evento) do update set
    sequence = excluded.sequence, dtstamp = excluded.dtstamp, hash_contenido = excluded.hash_contenido,
    ocupacion_id = excluded.ocupacion_id, ultima_accion = excluded.ultima_accion, updated_at = now();
select count(*) as tenant_correcto_deberia_ser_1 from rentas.evento_canal_importado eci
  where eci.unidad_id = '00000000-0000-0000-0000-0000000000c1' and eci.uid_evento = 'uid-evento-1'
    and eci.organization_id = '00000000-0000-0000-0000-0000000000a1' and eci.property_id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo '--- 13. staff real CON acceso a la property sigue RECHAZADO escribiendo evento_canal_importado (nunca fue parte del diseño) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
insert into rentas.evento_canal_importado (organization_id, property_id, unidad_id, canal_id, uid_evento, dtstamp, hash_contenido, ultima_accion)
  select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', c.id, 'uid-evento-staff', now(), 'hash1', 'aplicar'
  from rentas.canal c where c.codigo = 'airbnb'
  returning id as should_fail;
rollback;

\echo ''
\echo '=== checkin-recordatorio.ts: listReservasProximasACheckIn ==='
\echo ''

insert into rentas.ocupacion (id, organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante) values
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', daterange((current_date + 1)::date, (current_date + 4)::date, '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true)
on conflict do nothing;

\echo '--- 14. sesion de sistema SI encuentra la reserva proxima a check-in y SI puede marcar el recordatorio enviado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select id, organization_id from rentas.ocupacion
  where capa = 'reserva' and estado = 'confirmado' and recordatorio_checkin_enviado_en is null
    and lower(rango) >= (current_date + 1) and lower(rango) <= (current_date + 2)
  order by lower(rango) asc;
update rentas.ocupacion set recordatorio_checkin_enviado_en = now() where id = '00000000-0000-0000-0000-0000000000d2';
rollback;

\echo ''
\echo '=== ical-feed-publico.ts: exportarFeedParaUnidad (feed publico, sin auth) ==='
\echo ''

\echo '--- 15. sesion de sistema SI ve ocupaciones bloqueantes activas de la unidad (listOcupacionesActivasBloqueantes) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select id, lower(rango)::text as inicio, upper(rango)::text as fin, razon from rentas.ocupacion where unidad_id = '00000000-0000-0000-0000-0000000000c1' and estado <> 'cancelado' and bloqueante;
rollback;

\echo '--- 16. sesion de sistema SI puede upsert rentas.bloqueo_exportado (anti-eco) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into rentas.bloqueo_exportado (organization_id, property_id, ocupacion_id, canal_id, uid_exportado, hash_contenido, sequence, exportado_en)
  select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d2', c.id, 'uid-exportado-1', 'hashx', 0, now()
  from rentas.canal c where c.codigo = 'airbnb'
  on conflict (ocupacion_id, canal_id) do update set hash_contenido = excluded.hash_contenido;
select hash_contenido from rentas.bloqueo_exportado where ocupacion_id = '00000000-0000-0000-0000-0000000000d2';
rollback;

\echo ''
\echo '=== controles negativos: lo que la migracion NO tocó a propósito sigue igual ==='
\echo ''

\echo '--- 17. sesion de sistema SIGUE RECHAZADA insertando rentas.canal_feed_externo (connectFeed es solo-staff, policy INSERT intacta) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into rentas.canal_feed_externo (organization_id, property_id, unidad_id, canal_id, url_importacion, activo)
  select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', c.id, 'https://example.com/vrbo.ics', true
  from rentas.canal c where c.codigo = 'vrbo'
  returning id as should_fail;
rollback;

\echo '--- 18. sesion de sistema SIGUE RECHAZADA leyendo rentas.checklist_item_tarea (solo staff, policy SELECT intacta) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_fallar from rentas.checklist_item_tarea ci join rentas.tarea_operativa t on t.id = ci.tarea_id where t.property_id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo ''
\echo '==> listo -- revisa arriba: los escenarios marcados "deberia_ser_0"/"should_fail"/"deberia fallar"/RECHAZADO deben terminar en 0 filas o ERROR (correcto); el resto debe devolver filas/RETURNING reales.'
