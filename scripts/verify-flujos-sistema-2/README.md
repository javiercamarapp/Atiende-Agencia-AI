# verify-flujos-sistema-2

Segunda parte de `scripts/verify-flujos-sistema/` (léelo primero -- ahí vive el
inventario completo, por vertical, de los flujos de sistema de las 6
verticales, y la Parte 1/metodología completa que este directorio no repite).
Este script cierra los puntos 1-3 de la lista "Pendiente para un segundo PR"
de ese README:

1. `restaurantes.whatsapp_channel_config` (webhook de WhatsApp entrante).
2. `despachos.receivable`/`collection_event` (cron `cobranza-reminders`).
3. `licitaciones.renewal_alert`/`contract_invoice` (barrido `alert-notifications`).

El punto 4 (`hoteles` night-audit/no-show) se analiza abajo y queda
DELIBERADAMENTE fuera de este PR -- ver la sección dedicada.

Corre a mano vía `run.sh` y automáticamente en cada PR/push vía
`.github/workflows/postgres-real-gate.yml` (descubierto solo por
`scripts/verify-real-postgres-ci/run-gate.mjs`, que enumera cualquier
`scripts/verify-*/` con los 3 archivos de este contrato).

## Qué demuestra este script (22 escenarios)

Fixtures: 2 organizaciones de restaurantes (A ejercitada de punta a punta, B
para el control cross-tenant) + 2 de despachos (con su property y un invoice/
receivable pendiente real de A) + 2 de licitaciones (con un tender/contrato
próximo a vencer y una factura de contrato ya vencida de A), cada una con su
staff real.

1. **(1-5) Restaurantes**: la sesión de sistema resuelve la organización por
   `phone_number_id` (antes: RLS deny-all, `restaurantes.whatsapp_channel_config`
   nunca tuvo ninguna policy -- ni el staff podía leer su propia config); un
   staff real de la organización dueña SÍ ve su config ahora (control
   positivo, antes también bloqueado -- ver evidencia ANTES/DESPUÉS abajo); un
   staff de una organización ajena NO la ve (cross-tenant); `anon` sigue sin
   acceso; un INSERT directo por staff SIGUE bloqueado (límite deliberado --
   esta migración es solo SELECT).
2. **(6-14) Despachos**: `system_list_pending_receivables_with_invoice` SÍ
   lista la cartera pendiente de una property con el folio fiscal/total del
   invoice ya unido (antes: 0 filas, y ni siquiera había forma de resolver el
   invoice bajo sesión de sistema); `system_record_collection_event` SÍ
   registra el evento, con dedupe real (reintento del mismo día/etapa no
   duplica); ambas funciones rechazan a un staff autenticado real y a `anon`
   (exclusivas de sistema); un staff real de la organización dueña SIGUE
   viendo su cartera (`listReceivables`, sin cambio) y SIGUE pudiendo
   registrar un evento manual (`insertCollectionEvent`, camino de
   `POST .../recordatorio`, sin cambio); un staff de una organización ajena NO
   ve la cartera de otra (cross-tenant, sin cambio).
3. **(15-22) Licitaciones**: `system_list_renewal_candidate_contracts` SÍ ve
   el contrato candidato a renovación (antes: bloqueado); `system_record_renewal_alert`
   SÍ crea la alerta con dedupe real (índice único existente, reintentar el
   mismo umbral no duplica); `system_list_overdue_contract_invoices` SÍ ve la
   factura vencida (antes: bloqueado); las 3 funciones rechazan a un staff
   autenticado real y a `anon` (chequeo representativo -- comparten el mismo
   guard/GRANT); un staff real de la organización dueña SIGUE pudiendo
   escanear renovaciones a mano (`scanRenewalAlerts`/`POST .../renewals/scan`,
   sin cambio); límites deliberados: un INSERT directo contra
   `licitaciones.renewal_alert` bajo sesión de sistema SIGUE bloqueado (la
   policy de staff nunca se tocó) y un SELECT directo contra
   `licitaciones.contract` bajo sesión de sistema SIGUE devolviendo 0 filas
   (el acceso es SOLO vía la función nueva).

## Complicación real que distingue este PR del anterior (léase antes de
## replicar el patrón en otra vertical)

En el PR anterior (`scripts/verify-flujos-sistema/`), las funciones/lecturas
bloqueadas eran EXCLUSIVAS del cron/tool de sistema (sin caller de staff
autenticado) -- sustituir la SQL dentro del método existente de
`postgres-repository.ts` bastaba, sin tocar el contrato TypeScript. En este
PR, 2 de los 3 puntos NO lo eran:

- `despachos.listReceivables`/`findInvoice`/`insertCollectionEvent` son código
  COMPARTIDO con el panel de staff Y con `POST .../cuentas/:id/recordatorio`
  (un humano manda un recordatorio a mano, mismo motor de contenido/envío que
  el cron) -- ambos YA funcionaban para staff antes de este PR.
- `licitaciones.scanRenewalAlerts` es código COMPARTIDO con
  `POST .../renewals/scan` (panel de staff) -- YA funcionaba para staff antes
  de este PR.

Convertir esos métodos DIRECTO en funciones `security definer` de solo-sistema
(guard `auth.uid() is not null -> raise`) los habría roto para staff. La
solución, en ambos casos: se agregaron métodos NUEVOS al contrato
`DespachosRepository`/`LicitacionesRepository`
(`systemListPendingReceivablesForReminders`/`systemRecordCollectionEvent`/
`systemScanRenewalAlerts`), respaldados por las funciones `security definer`
nuevas, y se cablearon SOLO en el job de worker correspondiente
(`apps/worker/src/jobs/despachos/cobranza-reminders.ts`/
`apps/worker/src/jobs/licitaciones/alert-notifications.ts`) -- las rutas de
staff (`cobranza.ts`/`renewalRadar.ts`) siguen llamando a los métodos
ORIGINALES, sin ningún cambio. `licitaciones.listOverdueContractInvoices` sí
era exclusiva del barrido (verificado con `grep -rn`), así que ese caso SÍ
siguió el patrón directo del PR anterior (mismo método, SQL interna
sustituida).

`despachos.system_record_collection_event` usa dedupe **best-effort**
(`exists (...) where created_at::date = p_event_date`, sin `unique`/índice
nuevo) en vez de un `on conflict` atómico real -- a propósito: un índice único
real (`receivable_id, etapa, created_at::date`) habría afectado TAMBIÉN las
filas que inserta el staff vía `insertCollectionEvent` (mismo INSERT directo
contra la tabla, sin cambio), bloqueando un reenvío manual legítimo de la
MISMA etapa el MISMO día. Ver el header de la migración 009 para el análisis
completo -- el dedupe real de "no reenviar el correo" sigue viviendo, atómico,
en `despachos.messaging_outbox.dedupe_key`.

## Verificado ANTES/DESPUÉS del fix (evidencia real)

`run.sh` acepta `FLUJOS_SISTEMA_2_SKIP_FIX=1` para reproducir el estado ANTES
del fix (aplica las 139 migraciones reales EXCEPTO las 3 de este PR).
Resultados reales de correr `FLUJOS_SISTEMA_2_SKIP_FIX=1 ./run.sh` (ANTES) vs
`./run.sh` (DESPUÉS):

| Escenario | ANTES del fix | DESPUÉS del fix |
|---|---|---|
| 1 (restaurantes, resolver por teléfono) | `ERROR: permission denied for table whatsapp_channel_config` | `1` |
| 2 (restaurantes, control positivo -- staff ve su propia config) | `ERROR: permission denied for table whatsapp_channel_config` (la tabla nunca tuvo NINGUNA policy -- ni el staff podía leer, severidad confirmada) | `1` |
| 6 (despachos, cartera + invoice) | `ERROR: function despachos.system_list_pending_receivables_with_invoice(unknown) does not exist` | `1` |
| 7-8 (despachos, registro + dedupe) | mismo `ERROR: function ... does not exist` | `1` / `0` |
| 15 (licitaciones, contratos candidatos) | `ERROR: function licitaciones.system_list_renewal_candidate_contracts(unknown) does not exist` | `1` |
| 16-17 (licitaciones, alerta + facturas vencidas) | mismo `ERROR: function ... does not exist` | `1` / `0` / `1` |
| 3/12/13/20/21/22 (controles sin dependencia del fix) | Idéntico a después | Sin cambio -- confirma que `FLUJOS_SISTEMA_2_SKIP_FIX=1` solo quita las 3 piezas relevantes, nada más |

Corrido también vía el gate real de CI localmente
(`node scripts/verify-real-postgres-ci/run-gate.mjs`, Postgres 17 local):
**las 12 verificaciones existentes (incluida `verify-flujos-sistema`, 21/21) +
esta nueva (`verify-flujos-sistema-2: 22/22 escenarios OK`) pasan, sin
regresión en ninguna**.

## Decisión de diseño (resumen -- el detalle completo vive en el header de
## cada migración)

- **Restaurantes** (`.../017_restaurantes_sistema_whatsapp_channel_config.sql`):
  escape hatch `auth.uid() is null or <regla de staff>` en una policy de
  SELECT NUEVA (la tabla nunca tuvo ninguna) -- la tabla no trae
  secreto/token (`organization_id`/`phone_number_id`/`created_at`), mismo
  perfil que `hoteles.whatsapp_channel_config`/`core.property`. Se replica el
  MISMO modelo que `hoteles.whatsapp_channel_config` (SELECT único, escape
  hatch), adaptado a que restaurantes particiona por ORGANIZACIÓN (no por
  property). Alcance deliberado: solo SELECT -- sin policy de
  insert/update/delete (gestión de este catálogo sigue fuera de fase).
- **Despachos** (`.../009_despachos_sistema_cobranza_escritura.sql`): 2
  funciones `security definer` de solo-sistema -- NUNCA escape hatch
  (`despachos.receivable`/`invoice` son datos de DINERO y de clientes del
  despacho). `system_list_pending_receivables_with_invoice` combina, en una
  sola función, la cartera pendiente + el folio fiscal/total del invoice
  (evita necesitar una función/escape hatch aparte para `despachos.invoice`).
  `system_record_collection_event` es idempotente best-effort (ver arriba).
- **Licitaciones** (`.../025_licitaciones_sistema_renovaciones_facturas.sql`):
  3 funciones `security definer` de solo-sistema -- mismo criterio que el PR
  anterior de esta serie (`licitaciones.tender` -- y ahora
  `contract`/`renewal_alert`/`contract_invoice` -- son información de negocio
  propia del tenant, sin precedente de escape hatch en esta vertical). El
  CÓMPUTO de qué umbral de renovación ya se cumplió
  (`computeRenewalAlertCandidates`) NUNCA se duplicó en SQL -- las funciones
  nuevas solo exponen el acceso a datos (leer candidatos / persistir una
  alerta ya calculada) alrededor de esa misma función pura, ya usada por
  `scanRenewalAlerts` (camino de staff).
- Verificado en las 3 migraciones (escenarios 3/9-11/13/18-19): un staff de
  una organización ajena sigue sin leer ni escribir datos de otra, y `anon`
  sigue sin acceso a ninguna de las tablas/funciones tocadas.

## Punto 4 (hoteles night-audit/no-show) -- NO arreglado, análisis

Deliberadamente fuera de este PR, tal como quedó documentado en el reporte
del PR anterior. Se investigó a fondo (contra Postgres real, ver metodología
abajo) para decidir con evidencia, no por default.

### Qué está bloqueado, exactamente (verificado, introspección real)

`apps/worker/src/jobs/hoteles/night-audit.ts::runNightAuditForProperty` +
`apps/worker/src/jobs/hoteles/no-show.ts::runNoShowSweep` (ambos bajo
`withAppSession({ userId: null })`) tocan, sin ninguna excepción, TODAS las
tablas de `hoteles` money/reserva -- introspección real
(`pg_policies`) contra las 139 migraciones aplicadas:

| Tabla | Sentencia bloqueada | Policy (sin escape hatch) |
|---|---|---|
| `hoteles.reservation` | SELECT (`listInHouseReservationsForNightAudit`, `findDueNoShowReservations`) + UPDATE (`transitionReservation`, `no_show`) | `core.has_property_access`/`hoteles.can_manage_reservations` |
| `hoteles.rate_plan` | SELECT (tarifa de la noche, `listInHouseReservationsForNightAudit`) | `core.has_property_access` |
| `hoteles.tax_config` | SELECT (`loadTaxConfig`, IVA/ISH) | `core.has_property_access` |
| `hoteles.folio` | SELECT/INSERT (`ensurePrimaryFolio`) | `hoteles.can_access_money` |
| `hoteles.charge` | INSERT (`postNightlyHospedajeCharge`/`insertCharge`, cargo de hospedaje + penalización de no-show) | `hoteles.can_access_money` |
| `hoteles.payment` | (indirecto, `sumPaymentsByMethodForBusinessDate`) SELECT | `hoteles.can_access_money` |

`hoteles.night_audit_run` (el claim/finish de la corrida en sí) es la ÚNICA
tabla de esta cadena que YA tiene escape hatch
(`...000055_008_night_audit.sql`, precedente citado por el PR anterior) -- el
resto de la cadena NUNCA lo recibió.

### Por qué NO se fuerza un fix en este PR (regla explícita: "no dupliques
### reglas fiscales/de cálculo en SQL nuevo si ya viven en funciones
### existentes", y "no abras policies de INSERT/UPDATE de charge/payment/
### folio a la sesión de sistema")

1. **`runNoShowSweep` es código GENUINAMENTE COMPARTIDO** -- lo invoca tanto
   `night-audit.ts` (sistema) como `POST /hoteles/:propertyId/reservas/
   procesar-no-show` (staff autenticado real, `reservas.ts:410`, YA funciona
   hoy). Sus primitivas (`transitionReservation`, `releaseAvailability`,
   `ensurePrimaryFolio`, `insertCharge`) son, además, primitivas COMPARTIDAS
   del motor de folios completo de hoteles (front desk las usa para cobrar a
   mano, check-in/check-out, etc.) -- no hay un método "de solo night-audit"
   que aislar y envolver en una función, a diferencia de licitaciones/
   despachos de este mismo PR, donde el código compartido era una función
   AISLABLE.
2. **`002_folio_engine_functions.sql` (citado como precedente a reutilizar)
   solo define `mark_charge_reversed`** -- el REVERSO de un cargo, no su
   creación. No existe hoy ninguna función `security definer` real que
   encapsule "crear un cargo"/"crear un pago" -- ese INSERT SIEMPRE vivió como
   SQL parametrizado directo en `postgres-repository.ts`, gobernado por RLS
   de staff. Construir esa función DESDE CERO, con la superficie correcta
   (montos ya calculados por `planNightlyHospedajeCharges`/
   `computeNoShowPenaltyAmounts`, ambos TypeScript puro que NUNCA debe
   moverse a SQL) y sin abrir una puerta más ancha de la necesaria, es un
   diseño propio -- no una réplica de un patrón ya resuelto en este repo.
3. El cálculo fiscal (IVA/ISH, `planNightlyHospedajeCharges`/
   `computeNoShowPenaltyAmounts`) y el anti-doble-captura de negocio
   (`charge_folio_stay_date_hospedaje_idx`, `...000055_008_night_audit.sql`
   -- ya existe y NO se toca) viven en TypeScript/SQL YA correctos -- la
   regla explícita de esta tarea prohíbe duplicarlos en una función nueva. Una
   función `security definer` correcta para night-audit tendría que
   encapsular la operación COMPLETA (posteo de hospedaje + no-show + resumen
   de caja, por property y fecha de negocio) para no fragmentar ese
   anti-doble-captura entre TypeScript y SQL a medias -- eso es exactamente
   el "rediseño mayor" que la tarea autoriza a NO forzar.

### Opciones consideradas (para el siguiente PR dedicado)

- **(A) Una función `security definer` grande por operación** (`hoteles.
  system_run_night_audit_charges(property_id, business_date)`/`hoteles.
  system_run_no_show_sweep(property_id, as_of_date)`) que reciba los montos
  YA calculados en TypeScript (nunca recalculados en SQL) y haga el
  claim/insert/update completo en una sola transacción server-side, con el
  mismo guard de solo-sistema. Requiere portar `transitionReservation`/
  `releaseAvailability`/`ensurePrimaryFolio`/`insertCharge` a variantes
  `_for_night_audit` que NO reemplacen las que usa el staff (mismo patrón de
  este PR para despachos/licitaciones, pero multiplicado por 4-5 primitivas
  en vez de 1-2) -- el trabajo más grande es diseñar la firma exacta de cada
  función para que folio/charge/payment sigan sin ninguna policy de
  INSERT/UPDATE abierta a sesión de sistema fuera de esas funciones.
- **(B) Mover el cálculo fiscal/de penalización a SQL** -- se descarta
  explícitamente (duplicaría reglas ya correctas en TypeScript, divergencia
  de mantenimiento real).
- **(C) Dejarlo como está** (bloqueado) hasta el PR dedicado -- lo que hace
  este PR. Impacto de producto sin cambio: night-audit/no-show corren "ok"
  (200, sin excepción) pero nunca postean ningún cargo/pago real -- mismo
  síntoma documentado por el PR anterior.

**Recomendación**: opción (A), como su propio PR, con su propio script de
verificación con escenarios de z-report/anti-doble-captura/cross-tenant
específicos para dinero (el escenario 21 de `verify-flujos-sistema` ya sirve
de guard de regresión de que sigue bloqueado mientras tanto).
