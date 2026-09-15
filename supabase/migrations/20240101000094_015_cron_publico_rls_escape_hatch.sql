-- Cierra el segundo hallazgo que la migración 014 (`014_email_outbox_authenticated_
-- grants.sql`) dejó pendiente, documentado ahí mismo y en supabase/migrations/
-- README.md #90: "las LECTURAS de checkout-sweep-cron.ts/ical-sync-cron.ts/
-- checkin-recordatorio.ts bloqueadas por RLS normal (core.has_property_access(auth.uid(),
-- property_id) con auth.uid() NULL) y el feed público de ical-feed-publico.ts se
-- documentan/resuelven por separado". `ManagedPostgresEngine.withAppSession({userId:
-- null})` (ver packages/db/src/managed-postgres-engine.ts) SIEMPRE conecta como
-- `set local role authenticated` con `auth.uid()` NULL, nunca `service_role` -- así que
-- contra Postgres real, TODA policy que exige `core.has_property_access(auth.uid(), ...)`
-- es SIEMPRE `false` para estas 4 rutas (ningún `core.membership.user_id` es NULL),
-- recorriendo la plataforma completa y encontrando SIEMPRE 0 filas EN SILENCIO (nunca un
-- error explícito -- a diferencia del hallazgo de la migración 014, donde faltaba el
-- GRANT EXECUTE y por eso SÍ lanzaba "permission denied").
--
-- Mismo patrón YA probado en este repo -- packages/domain-hoteles/migrations/
-- 008_night_audit.sql, policies de hoteles.night_audit_run: `with check (auth.uid() is
-- null or hoteles.can_access_money(property_id))` -- se agrega el mismo escape hatch
-- `auth.uid() is null or <check existente>` a las policies RLS de las tablas concretas
-- que cada cron/ruta pública toca, auditadas UNA POR UNA por lectura y escritura
-- siguiendo la cadena de llamadas TypeScript real (packages/domain-rentas/src/), nunca
-- por adivinanza. El escape hatch `auth.uid() is null` nunca es alcanzable desde un
-- request de staff autenticado real (ver `packages/db/src/managed-postgres-engine.ts`:
-- `auth.uid()` sale de `request.jwt.claim.sub`, y todo JWT de usuario real trae un `sub`
-- no vacío) -- solo lo produce la sesión de sistema interna, ya gateada por
-- `internalOrCronSecretMatches` en las 3 rutas de cron (`checkout-sweep-cron.ts`/
-- `ical-sync-cron.ts`/`checkin-recordatorio.ts`), o el propio handler público sin
-- secreto de `ical-feed-publico.ts` (una URL de disponibilidad SIN datos de negocio
-- sensibles -- ver el comentario de cabecera de ese archivo y de
-- `src/ical/exportador.ts`).
--
-- Tablas tocadas (verificado leyendo la cadena de llamadas real, no la documentación de
-- fase):
--   * rentas.ocupacion (select/insert/update) -- `checkout-sweep-cron.ts` ->
--     `procesarCheckoutsPendientes`/`crearTareaLimpiezaPorCheckout`/`crearBloqueo`
--     (limpieza/aplicacion/tareas.ts, aplicacion/reservas.ts); `ical-sync-cron.ts` ->
--     `ejecutarCicloImportacion` -> `crearReservaConfirmada`/`modificarFechasReserva`/
--     `cancelarOcupacion` (sync/motor.ts, aplicacion/reservas.ts) + varias lecturas de
--     `sync/postgres-repository.ts`; `checkin-recordatorio.ts` ->
--     `listReservasProximasACheckIn`/`marcarRecordatorioCheckInEnviado`; `ical-feed-
--     publico.ts` -> `exportarFeedParaUnidad` -> `listOcupacionesActivasBloqueantes`.
--   * rentas.tarea_operativa (select/insert/update) -- `crearTareaLimpiezaPorCheckout`
--     (poll idempotente + INSERT + UPDATE de `buffer_ocupacion_id`).
--   * rentas.checklist_item_tarea (insert únicamente -- nunca se lee ni actualiza desde
--     estas 4 rutas, `insertarChecklistPlantilla` solo hace INSERT sin RETURNING) --
--     `crearTareaLimpiezaPorCheckout`.
--   * rentas.unidad (select únicamente) -- `obtenerConfiguracion`/`crearReservaConfirmada`
--     (duración mínima)/`findUnidad` (ical-feed-publico.ts).
--   * rentas.property_config (select únicamente) -- `obtenerConfiguracion`/
--     `findZonaHorariaPropiedad`.
--   * rentas.conflicto_calendario (select + insert) -- alcanzable desde `crearBloqueo`
--     (buffer de limpieza que solapa otra ocupación) y desde
--     `crearReservaConfirmada`/`modificarFechasReserva`/
--     `detectarYRegistrarConflictosCapaCruzada` (import de canal en conflicto). El
--     SELECT hace falta incluso donde el código nunca hace un SELECT directo: todo
--     `INSERT ... RETURNING` (los 3 INSERT de esta tabla lo usan) exige TAMBIÉN pasar la
--     policy de SELECT de la fila insertada -- verificado empíricamente contra Postgres
--     real antes de escribir esta migración (RETURNING sin policy de SELECT que aplique
--     responde "new row violates row-level security policy", incluso con WITH CHECK ya
--     satisfecho).
--   * rentas.canal_feed_externo (select + update, NUNCA insert) -- `listFeedsActivos`/
--     `persistFeedSyncState`. `connectFeed` (INSERT) solo lo llama la ruta de staff
--     autenticado (`ical-sync.ts`, gestión manual del feed) -- nunca estas 4 rutas, así
--     que su policy de INSERT se deja intacta a propósito.
--   * rentas.evento_canal_importado (select + insert + update) -- `findVersionPrevia`/
--     `listUidsActivosInternos`/`upsertEventoImportado`.
--   * rentas.bloqueo_exportado (select + insert + update) -- `listHashesExportadosRecientes`/
--     `findBloqueoExportadoPrevio`/`upsertBloqueoExportado` (alcanzable tanto desde
--     `ical-sync-cron.ts` como desde `ical-feed-publico.ts`).
--
-- HALLAZGO ADICIONAL, fuera de lo que anticipaba el reporte de la ronda anterior:
-- `rentas.evento_canal_importado`/`rentas.bloqueo_exportado` no solo les faltaba el
-- escape hatch -- NUNCA tuvieron policy de INSERT/UPDATE (solo SELECT, ver
-- 008_ical_sync_schema.sql líneas 117-121/123-125) ni GRANT de insert/update a
-- `authenticated`. El comentario de cabecera de 008 lo documentaba como decisión
-- consciente ("el motor de sync corre como service_role... el staff... nunca escritura
-- directa del bookkeeping") pero esa premisa (un `service_role` real) nunca fue cierta
-- contra Postgres real (mismo hallazgo raíz que la migración 014) -- sin este cambio,
-- arreglar SOLO las lecturas habría cambiado el síntoma de "0 feeds en silencio" a
-- "permission denied for table rentas.evento_canal_importado" en cuanto el cron
-- encontrara un feed real que importar. Como ningún caller de staff real llama
-- `upsertEventoImportado`/`upsertBloqueoExportado` (verificado con `grep -rn` --
-- ambas solo se alcanzan desde `ejecutarCicloImportacion`/`exportarFeedParaUnidad`,
-- ambas rutas de sesión de sistema), sus policies de escritura nuevas exigen
-- `auth.uid() is null` a secas (mismo criterio que
-- `claim_email_outbox_batch`/`complete_email_outbox_job` de la migración 014/README
-- #86-91 -- funciones/tablas de solo-sistema), sin el `or has_property_access(...)` que
-- sí llevan las tablas que un staff autenticado también puede tocar.
--
-- PENDIENTE, documentado honestamente (fuera de esta migración por alcance/riesgo, igual
-- que la 014 documentó lo que esta migración sí resuelve): `checkin-recordatorio.ts` ->
-- `runRecordatorioCheckInCore` -> `tryEnqueueReservaEmail` ->
-- `repo.findOcupacionParaCorreo` hace `JOIN core.organization` para el nombre del
-- tenant en el correo. `core.organization` (packages/db/migrations/0001_core_schema.sql)
-- es una tabla CORE compartida por las 6 verticales, con policy de SELECT
-- `exists(select 1 from core.membership m where ... and m.user_id = auth.uid())` --
-- también siempre `false` con `auth.uid()` NULL. Este mismo gap YA está documentado y
-- aceptado en el repo (ver packages/domain-hoteles/migrations/008_night_audit.sql,
-- comentario de la policy de INSERT: "el mismo gap ya aceptado por
-- citasRepo.listActiveOrganizations() ... ninguna vertical de fusion resuelve todavía
-- un rol service_role-like para jobs de sistema con RLS real") -- ensancharlo aquí sería
-- una decisión de plataforma que afecta a las 6 verticales por igual (cualquier lectura
-- de sistema que haga JOIN contra `core.organization`), no algo que una migración
-- acotada a `rentas.*` deba decidir por su cuenta. Efecto observable después de esta
-- migración: `checkin-recordatorio.ts` SÍ encuentra candidatas reales
-- (`listReservasProximasACheckIn` ya no devuelve 0 en silencio) y SÍ marca
-- `recordatorio_checkin_enviado_en` cuando corresponde, pero el correo real todavía no
-- sale -- `tryEnqueueReservaEmail` sigue devolviendo `reserva_no_encontrada` por el JOIN
-- bloqueado, contado como `fallos` en el resumen (visible/honesto) en vez de `enviados`.
-- Requiere su propia investigación de plataforma (mismo alcance que el gap de
-- `service_role` que la migración 014 ya documentó), no un parche puntual aquí.

-- ---------------------------------------------------------------------------
-- 001_rentas_schema.sql -- rentas.unidad / rentas.property_config / rentas.ocupacion /
-- rentas.conflicto_calendario
-- ---------------------------------------------------------------------------
alter policy "staff ve unidades de su property" on rentas.unidad
  using (auth.uid() is null or core.has_property_access(auth.uid(), property_id));

alter policy "staff ve la configuración de su property" on rentas.property_config
  using (auth.uid() is null or core.has_property_access(auth.uid(), property_id));

alter policy "staff ve ocupaciones de su property" on rentas.ocupacion
  using (auth.uid() is null or core.has_property_access(auth.uid(), property_id));
alter policy "staff inserta ocupaciones de su property" on rentas.ocupacion
  with check (auth.uid() is null or core.has_property_access(auth.uid(), property_id));
alter policy "staff actualiza ocupaciones de su property" on rentas.ocupacion
  using (auth.uid() is null or core.has_property_access(auth.uid(), property_id))
  with check (auth.uid() is null or core.has_property_access(auth.uid(), property_id));

alter policy "staff ve conflictos de su property" on rentas.conflicto_calendario
  using (auth.uid() is null or core.has_property_access(auth.uid(), property_id));
alter policy "staff inserta conflictos de su property" on rentas.conflicto_calendario
  with check (auth.uid() is null or core.has_property_access(auth.uid(), property_id));

-- ---------------------------------------------------------------------------
-- 010_rentas_limpieza_schema.sql -- rentas.tarea_operativa / rentas.checklist_item_tarea
-- ---------------------------------------------------------------------------
alter policy "staff ve tareas de su property" on rentas.tarea_operativa
  using (auth.uid() is null or core.has_property_access(auth.uid(), property_id));
alter policy "staff inserta tareas de su property" on rentas.tarea_operativa
  with check (auth.uid() is null or core.has_property_access(auth.uid(), property_id));
alter policy "staff actualiza tareas de su property" on rentas.tarea_operativa
  using (auth.uid() is null or core.has_property_access(auth.uid(), property_id))
  with check (auth.uid() is null or core.has_property_access(auth.uid(), property_id));

-- Solo INSERT: `insertarChecklistPlantilla` nunca hace SELECT/UPDATE de esta tabla
-- desde estas 4 rutas -- la policy de SELECT/UPDATE de checklist_item_tarea (lectura y
-- edición desde "Mis tareas", staff real) se deja intacta a propósito.
alter policy "staff inserta checklist de tareas de su property" on rentas.checklist_item_tarea
  with check (
    auth.uid() is null
    or exists (select 1 from rentas.tarea_operativa t where t.id = checklist_item_tarea.tarea_id and core.has_property_access(auth.uid(), t.property_id))
  );

-- ---------------------------------------------------------------------------
-- 008_ical_sync_schema.sql -- rentas.canal_feed_externo / rentas.evento_canal_importado /
-- rentas.bloqueo_exportado
-- ---------------------------------------------------------------------------
alter policy "staff ve feeds de su property" on rentas.canal_feed_externo
  using (auth.uid() is null or core.has_property_access(auth.uid(), property_id));
-- INSERT ("staff conecta feeds de su property") se deja intacta: solo la conecta
-- `connectFeed`, llamada exclusivamente desde la ruta de staff autenticado.
alter policy "staff actualiza feeds de su property" on rentas.canal_feed_externo
  using (auth.uid() is null or core.has_property_access(auth.uid(), property_id))
  with check (auth.uid() is null or core.has_property_access(auth.uid(), property_id));

alter policy "staff ve bookkeeping de eventos importados de su property" on rentas.evento_canal_importado
  using (auth.uid() is null or core.has_property_access(auth.uid(), property_id));

-- Nuevas -- nunca existieron antes de esta migración (ver hallazgo adicional arriba).
-- Solo sesión de sistema: ningún caller de staff real llama `upsertEventoImportado`.
create policy "sistema escribe bookkeeping de eventos importados" on rentas.evento_canal_importado for insert
  with check (auth.uid() is null);
create policy "sistema actualiza bookkeeping de eventos importados" on rentas.evento_canal_importado for update
  using (auth.uid() is null) with check (auth.uid() is null);

alter policy "staff ve bookkeeping de bloqueos exportados de su property" on rentas.bloqueo_exportado
  using (auth.uid() is null or core.has_property_access(auth.uid(), property_id));

-- Nuevas -- mismo criterio que evento_canal_importado arriba: solo `upsertBloqueoExportado`
-- (sesión de sistema, `ical-sync-cron.ts`/`ical-feed-publico.ts`) escribe esta tabla.
create policy "sistema escribe bloqueos exportados (anti-eco)" on rentas.bloqueo_exportado for insert
  with check (auth.uid() is null);
create policy "sistema actualiza bloqueos exportados (anti-eco)" on rentas.bloqueo_exportado for update
  using (auth.uid() is null) with check (auth.uid() is null);

-- El GRANT de tabla es una capa PREVIA e independiente de RLS -- sin esto, Postgres
-- responde "permission denied for table ..." antes de evaluar ninguna policy nueva de
-- arriba (mismo criterio ya documentado en README #93 para
-- licitaciones.company_capability/experience/signer).
grant insert, update on rentas.evento_canal_importado, rentas.bloqueo_exportado to authenticated;
