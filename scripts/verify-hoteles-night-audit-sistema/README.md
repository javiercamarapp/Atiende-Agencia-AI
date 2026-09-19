# verify-hoteles-night-audit-sistema

Cierra el punto 4 de `scripts/verify-flujos-sistema/README.md` ("pendiente para un
segundo PR"), analizado y dejado deliberadamente fuera por
`scripts/verify-flujos-sistema-2/README.md` (sección "Punto 4 (hoteles
night-audit/no-show) -- NO arreglado, análisis" -- léase primero, ahí vive el
inventario original, la evidencia de qué está bloqueado, y las opciones consideradas
antes de decidir el diseño de este PR).

Verifica contra Postgres **real** que el cron diario `POST /internal/hoteles/night-audit`
(`apps/api/src/routes/verticals/hoteles/night-audit.ts`) y el barrido de no-show
(`apps/worker/src/jobs/hoteles/no-show.ts::runNoShowSweep`) -- ambos bajo sesión de
sistema (`packages/db/src/managed-postgres-engine.ts::withAppSession({ userId: null })`
-- `set local role authenticated` + `auth.uid()` SIEMPRE NULL, nunca `service_role`)
-- SÍ postean el cargo de hospedaje de la noche y SÍ procesan no-shows, cierran el
inventario exacto de escrituras/lecturas que antes estaban bloqueadas, y prueban que
esto ocurre sin abrir ninguna policy de INSERT/UPDATE/DELETE de dinero/PII a la sesión
de sistema.

Corre a mano vía `run.sh` y automáticamente en cada PR/push vía
`.github/workflows/postgres-real-gate.yml` (descubierto solo por
`scripts/verify-real-postgres-ci/run-gate.mjs`, que enumera cualquier
`scripts/verify-*/` con los 3 archivos de este contrato).

## Inventario exacto de sentencias que hoy emite night-audit/no-show bajo sesión de
## sistema (verificado contra Postgres real -- 142 migraciones aplicadas, introspección
## `pg_policies`)

| Tabla | Sentencia | Método (`postgres-repository.ts`) | Policy (sin escape hatch) | Este PR |
|---|---|---|---|---|
| `hoteles.reservation` | SELECT (reservas en casa + candidatas a no-show) | `listInHouseReservationsForNightAudit` / `findDueNoShowReservations` | "staff ve reservas de su property" (`core.has_property_access`) | **arreglado** (función system-only, lectura acotada a 3-4 campos) |
| `hoteles.reservation` | UPDATE (confirmada -> no_show) | `transitionReservation` | "reservas: staff con acceso actualiza reservas" (`hoteles.can_manage_reservations`) | **arreglado** (función system-only, UPDATE guardado) |
| `hoteles.rate_plan` | SELECT (tarifa de la noche) | `listInHouseReservationsForNightAudit` (join) | "staff ve tarifas de su property" (`core.has_property_access`) | **arreglado** (mismo JOIN, dentro de la función de lectura) |
| `hoteles.tax_config` | SELECT (IVA/ISH/umbral) | `loadTaxConfig` | "staff ve configuración fiscal de su property" (`core.has_property_access`) | **arreglado** (función system-only) |
| `hoteles.folio` | SELECT/INSERT (folio primario) | `ensurePrimaryFolio` | "dinero: staff con acceso {ve,crea/actualiza} folios" (`hoteles.can_access_money`) | **arreglado** (INSERT idempotente DENTRO de `system_apply_no_show`; `system_post_night_audit_charge` solo VALIDA que el folio ya exista y sea el primario, nunca lo crea -- mismo comportamiento que hoy: night-audit NUNCA crea un folio, lo reporta como anomalía) |
| `hoteles.charge` | INSERT (hospedaje de la noche + penalización de no-show) | `postNightlyHospedajeCharge` / `insertCharge` | "dinero: staff con acceso inserta cargos" (`hoteles.can_access_money`) | **arreglado** (2 funciones dedicadas, montos SIEMPRE ya calculados por TypeScript) |
| `hoteles.charge` | SELECT (resumen de caja por concepto) | `sumChargesByConceptForBusinessDate` | "dinero: staff con acceso ve cargos" (`hoteles.can_access_money`) | **arreglado** (función system-only) |
| `hoteles.payment` | SELECT (resumen de caja por método) | `sumPaymentsByMethodForBusinessDate` | "dinero: staff con acceso ve pagos" (`hoteles.can_access_money`) | **arreglado** (función system-only) |

`hoteles.night_audit_run` (claim/finish de la corrida en sí) **ya tenía** escape hatch
desde `migrations/008_night_audit.sql` -- no se toca. `core.organization`/
`core.property` (usadas por `listActiveHotelProperties`) **ya tenían** escape hatch
desde el PR #141 (`...000136_0015_core_rls_sesion_sistema.sql`) -- no se tocan.

**Hallazgo adyacente, fuera de alcance (documentado, no arreglado):**
`hoteles.availability` (usada indirectamente por `release_availability()` al liberar
inventario de un no-show) tiene un gap PROPIO, previo a este PR y AJENO a la sesión de
sistema -- ni siquiera tiene `GRANT insert/update` para `authenticated` (solo
`SELECT`), y `release_availability()`/`book_availability()` son `security invoker`, así
que ese gap bloquearía TAMBIÉN a un staff autenticado normal intentando reservar/
liberar disponibilidad, no solo al cron. `system_apply_no_show` lo sortea sin tocarlo:
al ser `security definer`, la llamada interna a `hoteles.release_availability()` corre
con los privilegios del DUEÑO de la función (Postgres conserva el "current user"
efectivo durante TODA la ejecución de una función `security definer`, incluidas las
funciones invoker-rights que llama desde adentro) -- ni el GRANT ni la RLS de
`hoteles.availability` aplican en este camino. Abrir ese GRANT/policy en general para
`authenticated` es una decisión de producto distinta, con su propio análisis -- no se
fuerza aquí.

## Qué demuestra este script (31 escenarios + 1 escenario de concurrencia real)

Fixtures: 2 organizaciones de hoteles (A ejercitada de punta a punta, B para el control
cross-tenant), cada una con su property y staff owner real; en A: tarifa fiscal
(IVA 16%/ISH 3%), 1 tipo de habitación, 1 tarifa real para la noche auditada
(2026-09-10, $1000), 2 reservas "en casa" con folio primario propio (una para el
posteo de hospedaje, otra AJENA para probar el rechazo de folio-cruzado), 2 reservas
`confirmada` vencidas (candidatas a no-show, una se consume de punta a punta, la otra
queda intacta para los controles cross-tenant/monto inválido), y un pago ya capturado
(para el resumen de caja por método).

1. **(1-5) Night-audit de punta a punta bajo sesión de sistema**: lee el lote de
   reservas en casa con folio+tarifa (JOIN completo, antes bloqueado 3 veces:
   `reservation`+`folio`+`rate_plan`) → lee la configuración fiscal → postea el cargo
   de hospedaje con el monto YA CALCULADO (simulando lo que
   `planNightlyHospedajeCharges`/`computeChargeAmounts` -- TypeScript puro -- ya
   calculó antes de llamar) → una segunda corrida de la MISMA noche NUNCA lo duplica
   (verificado contra la tabla real, no solo el booleano de retorno, vía el índice
   único parcial `charge_folio_stay_date_hospedaje_idx` YA existente) → el resumen de
   caja del día (cargos por concepto / pagos por método) SÍ refleja lo posteado.
2. **(6-8) Invariantes validadas por `system_post_night_audit_charge` misma** (nunca
   solo por el llamador): rechaza una reserva que no pertenece a la
   organización/property indicada, rechaza un folio que NO es el primario de esa
   reserva, rechaza un monto negativo.
3. **(9-13) No-show completo bajo sesión de sistema**: lee la candidata (solo 3 campos
   mínimos, `totalAmount`/`checkInDate`/`checkOutDate` -- lo único que
   `evaluateNoShowPenaltyBase` necesita) → `system_apply_no_show` aplica, en UNA sola
   llamada atómica, transición 'confirmada'->'no_show' + liberación de TODAS las
   noches restantes + folio primario + penalización YA CALCULADA (misma fórmula real
   `evaluateNoShowPenaltyBase`/`computeNoShowPenaltyAmounts`: 3000/3 noches = 1000
   neto, IVA 16% = 160, ISH 0) → un reintento (mismo cron 2 veces, o 2 instancias
   concurrentes -- MISMO guard atómico) pierde la carrera, 0 filas, NUNCA una segunda
   penalización (verificado contra la tabla real: exactamente 1 cargo de penalización
   en el folio) → la reserva SÍ queda en `no_show` (transición real, no solo el
   retorno de la función) → la bitácora (`hoteles.reservation_status_event`, YA
   existente desde `migrations/005`, sin bitácora nueva) registra la transición con
   `actor_user_id NULL` ("sistema") -- el MISMO rastro que dejaría el camino de staff
   para esta transición exacta.
4. **(14-16) Invariantes validadas por `system_apply_no_show` misma**: una reserva de
   otra organización/property NUNCA se aplica (0 filas, silencioso -- MISMO criterio
   que `transitionReservation` ya usa hoy: "el caller decide, nunca lanza" -- a
   diferencia de `system_post_night_audit_charge`, que SÍ lanza para el mismo tipo de
   invariante, ver "Decisión de diseño" abajo para el porqué de la asimetría) →
   verificado que la reserva ajena queda intacta → rechaza un monto negativo (esta sí
   lanza, antes de tocar ninguna fila).
5. **(17-23) Las 7 funciones nuevas rechazan a un staff autenticado real** (exclusivas
   de sesión de sistema, `errcode 42501`).
6. **(24-26) 3 funciones representativas rechazan a `anon`** (sin `GRANT execute`).
7. **(27) Control cross-tenant**: staff real de la organización B NO ve el folio de la
   organización A (sin cambio -- ninguna policy de `folio` se tocó).
8. **(28) Control positivo**: staff real de la organización A SIGUE pudiendo cobrar
   directo en su propio folio (front desk, camino YA existente, sin ningún cambio de
   esta migración).
9. **(29-30) Límite deliberado**: un SELECT directo contra `hoteles.reservation` y un
   INSERT directo contra `hoteles.charge`, AMBOS bajo sesión de sistema, SIGUEN
   bloqueados -- esta migración NUNCA abrió ninguna policy de esas tablas, solo agregó
   funciones `security definer` acotadas.
10. **(31) Los totales del folio cuadran tras night-audit + un reverso**: tras postear
    el cargo de hospedaje por el camino de sistema, un reverso real (staff,
    `hoteles.mark_charge_reversed()` -- sin cambio) deja la suma neta de
    hospedaje+reverso en el folio en **$0**.
11. **Concurrencia real (`run.sh`, fuera de `assertions.sql`)**: 2 conexiones **psql
    separadas**, lanzadas en paralelo con `&`/`wait` (nunca secuencial, a diferencia
    del escenario 3/10 que prueban el MISMO guard atómico pero con una sola conexión),
    intentan postear el MISMO cargo de hospedaje (misma property+folio+noche) al mismo
    tiempo -- verificado: exactamente 1 fila en `hoteles.charge`, sin importar cuál de
    las 2 conexiones ganó la carrera (una devuelve `out_is_new=true`, la otra
    `out_is_new=false`, ambas devuelven el MISMO `out_id`). Este paso corre solo vía
    `run.sh` manual (no vía `run-gate.mjs`, que no tiene un mecanismo genérico de "2
    conexiones paralelas" fuera de la gramática `begin;...rollback;` de
    `assertions.sql`) -- la evidencia real queda impresa en la salida de `run.sh` (ver
    abajo).

## Verificado ANTES/DESPUÉS del fix (evidencia real)

`run.sh` acepta `HOTELES_NIGHT_AUDIT_SISTEMA_SKIP_FIX=1` para reproducir el estado
ANTES del fix (aplica las 141 migraciones reales EXCEPTO la de este PR). Resultados
reales de correr `HOTELES_NIGHT_AUDIT_SISTEMA_SKIP_FIX=1 ./run.sh` (ANTES) vs
`./run.sh` (DESPUÉS):

| Escenario | ANTES del fix | DESPUÉS del fix |
|---|---|---|
| 1-5 (night-audit, lecturas + posteo + resumen) | `ERROR: function hoteles.system_list_in_house_reservations_for_night_audit(...) does not exist` (o el `system_*` correspondiente) -- consistente con que el código de producción de este PR llama a esas funciones incondicionalmente bajo `session: "sistema"` | Todos devuelven `1` (o `t`/`f` según corresponda) |
| 9-13 (no-show, lectura + aplicación + bitácora) | mismo `ERROR: function hoteles.system_find_due_no_show_reservations/system_apply_no_show(...) does not exist` | `1`/`0`/`1`/`1`/`1` según corresponde |
| 6-8/14-16 (invariantes de las funciones nuevas) | mismo `ERROR: ... does not exist` (nunca llega a validar nada -- la función ni existe) | `ERROR` con el mensaje de invariante real (`reserva_invalida`/`folio_invalido`/`monto_invalido`) o `0` filas silenciosas según corresponda |
| 17-26 (controles de staff/anon de las funciones nuevas) | mismo `ERROR: ... does not exist` (por la misma razón -- ni staff ni anon pueden invocar algo que no existe) | `ERROR` con el mensaje real de rechazo (`42501`/`permission denied for function`) |
| 27-30 (controles sin dependencia del fix: cross-tenant, control positivo, límite deliberado) | Idéntico a después -- confirma que `HOTELES_NIGHT_AUDIT_SISTEMA_SKIP_FIX=1` solo quita la pieza relevante, nada más | Sin cambio |
| 31 (totales tras reverso) | mismo `ERROR: function hoteles.system_post_night_audit_charge(...) does not exist` -- night-audit nunca postea nada que reversar | `1` (neto cero) |
| Concurrencia real (`run.sh`) | Se omite explícitamente en modo `SKIP_FIX` (las funciones `systemXxx` no existen) | `[PASS]` -- exactamente 1 fila tras 2 conexiones concurrentes |

Corrido también vía el gate real de CI localmente
(`PGHOST=127.0.0.1 PGPORT=<puerto> node scripts/verify-real-postgres-ci/run-gate.mjs`,
Postgres 17 local): **las 14 verificaciones existentes + esta nueva
(`verify-hoteles-night-audit-sistema: 31/31 escenarios OK`) pasan, sin regresión en
ninguna**.

## Decisión de diseño (resumen -- el detalle completo vive en el header de la
## migración)

- **7 funciones `security definer` de solo-sistema nuevas**
  (`hoteles.system_list_in_house_reservations_for_night_audit`,
  `hoteles.system_load_tax_config`,
  `hoteles.system_sum_charges_by_concept_for_business_date`,
  `hoteles.system_sum_payments_by_method_for_business_date`,
  `hoteles.system_post_night_audit_charge`,
  `hoteles.system_find_due_no_show_reservations`, `hoteles.system_apply_no_show`) --
  **NUNCA** un escape hatch de policy: `reservation`/`folio`/`charge`/`payment` son
  tablas de dinero/PII de huéspedes, la restricción de la tarea lo prohíbe
  explícitamente. Guard `auth.uid() is not null then raise ... using errcode =
  '42501'` como primera sentencia, `revoke ... from public`, `grant execute ... to
  authenticated`, `set search_path = hoteles`, sin SQL dinámico -- mismo patrón YA
  establecido por `hoteles.system_find_voice_agent_config`
  (`...000139_022_hoteles_sistema_voz_whatsapp_escritura.sql`) y por
  `despachos.system_record_collection_event`/
  `licitaciones.system_record_renewal_alert` (segunda parte de esta misma serie).
- **TypeScript CALCULA, SQL solo PERSISTE** (mandato explícito de la tarea): NINGUNA de
  las 2 funciones de escritura recibe una tarifa cruda ni un `totalAmount` para
  calcular nada -- ambas reciben `netAmount`/`taxAmount` YA CALCULADOS
  (`planNightlyHospedajeCharges`/`computeChargeAmounts` para hospedaje,
  `evaluateNoShowPenaltyBase`/`computeNoShowPenaltyAmounts` para no-show, TODAS
  TypeScript puro, sin cambio) y SOLO los validan+persisten. La unicidad de "una noche
  de hospedaje por folio" sigue delegada íntegramente al índice único parcial YA
  existente (`charge_folio_stay_date_hospedaje_idx`, `migrations/001`) -- ninguna
  función introduce un mecanismo de dedupe nuevo.
- **`system_apply_no_show` hace "transición + penalización" en UNA sola llamada
  atómica** (a diferencia de `system_post_night_audit_charge`, que recibe un `folioId`
  ya resuelto por otra función) porque `evaluateNoShowPenaltyBase` solo necesita
  `totalAmount`/`checkInDate`/`checkOutDate` -- los 3 YA disponibles en la candidata
  ANTES de reclamarla (nunca cambian por la transición en sí) -- esto permite calcular
  la penalización en TypeScript ANTES de la única llamada de escritura, sin fragmentar
  el reclamo atómico entre 2 llamadas de red separadas.
- **Asimetría deliberada entre las 2 funciones de escritura ante una reserva
  ajena/inválida**: `system_post_night_audit_charge` LANZA (`reserva_invalida`/
  `folio_invalido`) porque no existe un "reclamo atómico" natural para un INSERT --
  pasar una reserva/folio completamente equivocados es un BUG del llamador, no un
  escenario legítimo de reintento. `system_apply_no_show` NO lanza para el mismo tipo
  de invariante (org/property/estado no coinciden) -- devuelve 0 filas silenciosas,
  MISMO criterio que `transitionReservation` ya usa hoy (`UPDATE ... WHERE status =
  ANY(fromStatuses)`, "el caller decide 409 vs no-op idempotente, nunca lanza por
  eso") porque un reclamo perdido (reintento del cron, 2 instancias concurrentes) y
  una reserva ajena producen la MISMA firma de "0 filas actualizadas" en un UPDATE
  guardado -- distinguirlos exigiría una consulta adicional que el propio patrón
  `transitionReservation` nunca hizo.
- **Bitácora**: `hoteles.fraude_audit_log` (`migrations/017`) es EXCLUSIVA de
  hallazgos de fraude, nunca de cargos/folios/reservas en general -- no se reutiliza.
  El único rastro que el camino de STAFF deja hoy más allá de la fila misma de
  `charge`/`folio` (sin columna de actor) es `hoteles.reservation_status_event`
  (`migrations/005`, trigger AFTER UPDATE/INSERT de `reservation`, actor NULL =
  "sistema" para esta transición exacta, YA el criterio documentado desde esa
  migración) -- ese trigger dispara igual sin importar si el UPDATE corrió dentro de
  una función `security definer`. `system_apply_no_show` fija
  `set_config('hoteles.actor_user_id', '', true)` explícito antes del UPDATE -- mismo
  valor NULL resultante que ya usa el camino de staff. No se abre ni se necesita una
  bitácora nueva.
- **Camino de staff SIN CAMBIO** (restricción no negociable): el disparo manual de
  night-audit (`POST /hoteles/:propertyId/night-audit`) y
  `POST /hoteles/:propertyId/reservas/procesar-no-show` siguen invocando
  `loadTaxConfig`/`listInHouseReservationsForNightAudit`/`postNightlyHospedajeCharge`/
  `findDueNoShowReservations`/`transitionReservation`/`releaseAvailability`/
  `ensurePrimaryFolio`/`insertCharge` -- LITERAL, sin tocar una sola línea de esos
  métodos ni de las policies que ya los gobiernan (escenario 28, control positivo, lo
  verifica). `runNightAuditForProperty`/`runNoShowSweep` (`apps/worker`, código
  COMPARTIDO por los 2 caminos) reciben un parámetro nuevo `session: "staff" |
  "sistema"` que decide, en tiempo de ejecución, cuál juego de métodos invocar -- ver
  el comentario de cabecera de `apps/worker/src/jobs/hoteles/night-audit.ts`/
  `no-show.ts` para el detalle completo.
- Verificado (escenarios 17-27): las 7 funciones nuevas rechazan a un staff
  autenticado real y a `anon`, y un staff de la organización B sigue sin ver
  folios/cargos de la organización A.

## Orden de despliegue

1. Aplicar `migrations/023_night_audit_sistema_escritura.sql` (mirror en
   `supabase/migrations/20240101000143_...`).
2. Desplegar el código de `packages/domain-hoteles/src/{repository,postgres-repository,
   in-memory-repository}.ts` + `apps/worker/src/jobs/hoteles/{night-audit,no-show}.ts`
   + `apps/api/src/routes/verticals/hoteles/night-audit.ts`/`reservas.ts` de este mismo
   commit.

Si el código nuevo se desplegara ANTES que la migración, las 7 llamadas `systemXxx`
fallarían con `function hoteles.system_... does not exist` -- capturado por property
por el `try/catch` de `runNightAuditSweep` (igual que hoy), nunca peor que el bug ya
documentado (night-audit corre "ok" pero no postea nada).

## Uso manual

```
scripts/verify-hoteles-night-audit-sistema/run.sh
HOTELES_NIGHT_AUDIT_SISTEMA_SKIP_FIX=1 scripts/verify-hoteles-night-audit-sistema/run.sh
```
