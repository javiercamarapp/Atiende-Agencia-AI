# verify-flujos-sistema

Verificación contra Postgres **real** de los flujos de sistema (crons, Server
Tools de voz, webhooks) que el PR #141 (`...000136_0015_core_rls_sesion_sistema.sql`)
dejó señalados, sin arreglar: escrituras propias de cada vertical, gobernadas
por policies de staff autenticado, que la sesión de sistema
(`packages/db/src/managed-postgres-engine.ts::withAppSession({ userId: null })`
-- `set local role authenticated` + `auth.uid()` SIEMPRE `NULL`, nunca
`service_role`) no puede alcanzar.

Corre a mano vía `run.sh` y automáticamente en cada PR/push vía
`.github/workflows/postgres-real-gate.yml` (descubierto solo por
`scripts/verify-real-postgres-ci/run-gate.mjs`).

## Inventario completo (Parte 1)

Ver la tabla completa, por vertical, en la descripción del PR. Resumen:

| Vertical | Flujo de sistema | Estado antes | Causa raíz | Este PR |
|---|---|---|---|---|
| licitaciones | `discover-tenders` (cron) → `ingestTendersFromSource` | **bloqueado** | `licitaciones.tender` INSERT/UPDATE exige `licitaciones.can_write_org` (`auth.uid()` real) | **arreglado** |
| licitaciones | `discover-tenders` (cron) → `recordSourceRun` | **bloqueado** | `licitaciones.source_run` INSERT exige `can_write_org` | **arreglado** |
| licitaciones | `deadline-reminders`/`alert-notifications` (cron) → `scanUpcomingDeadlineReminders` (lectura) | **bloqueado (0 filas en silencio)** | `licitaciones.tender` SELECT exige `licitaciones.can_access_org`, nunca recibió el escape hatch que sí recibió `core.organization`/`core.property` en el PR #141 | **arreglado** |
| licitaciones | `deadline-reminders`/`alert-notifications` (cron) → `scanUpcomingDeadlineReminders` (escritura) | **bloqueado** | `licitaciones.tender_deadline_reminder` INSERT/UPDATE exige `can_write_org` | **arreglado** |
| licitaciones | `alert-notifications` (cron) → outbox de correo (`enqueue_messaging_outbox`/`claim_email_outbox_batch`/etc.) | ya arreglado (PR previo, `...000089`) | GRANT solo a `service_role` | sin cambio, verificado que sigue OK |
| licitaciones | `alert-notifications` (cron) → `scanRenewalAlerts`/`listOverdueContractInvoices` (`renewal_alert`/`contract_invoice`) | **bloqueado (probable)** | mismo patrón `can_write_org`/`can_access_org`, sin escape hatch ni función | **pendiente PR2** (ver abajo) |
| hoteles | voice tool F&B (`POST .../voz/tickets-fnb`) → `findVoiceAgentConfig` (lectura del secreto) | **bloqueado (503 siempre)** | `hoteles.voice_agent_config` policy `for all` exige `core.has_property_access(auth.uid(), ...)` | **arreglado** (función `security definer`) |
| hoteles | voice tool F&B → `insertFnbOrder` | **bloqueado** | `hoteles.fnb_order` INSERT exige `core.has_property_access` (hallazgo ya señalado explícitamente por el PR previo) | **arreglado** (escape hatch) |
| hoteles | voice tool F&B → `insertFnbOrder` (RETURNING) | **bloqueado incluso con el fix de INSERT** | `INSERT ... RETURNING` exige TAMBIÉN pasar la policy de SELECT de la fila insertada (verificado empíricamente, mismo hallazgo que `...000094` de rentas) | **arreglado** (escape hatch en SELECT también) |
| hoteles | webhook de WhatsApp entrante → `resolvePropertyByPhoneNumberId` | **bloqueado (200 siempre, sin procesar -- "número no configurado")** | única policy de `hoteles.whatsapp_channel_config` (SELECT) exige `core.has_property_access` | **arreglado** (escape hatch) |
| hoteles | webhook de WhatsApp → `claimWhatsAppMessage`/`claimWhatsAppConversation`/`whatsapp_append_turn`/etc. | ya arreglado (PR previo, `...000105`) | GRANT solo a `service_role` | sin cambio, verificado que sigue OK |
| hoteles | `night-audit`/`no-show` (worker jobs) → `hoteles.reservation`/`folio`/`rate_plan`/`tax_config`/`charge`/`payment` | **bloqueado** | mismo patrón, sin escape hatch — tablas de **DINERO**, requieren su propio diseño cuidadoso | **pendiente PR2** (ver abajo) |
| despachos | `cobranza-reminders` (worker job) → `listReceivables`/`collection_event` | **bloqueado (0 filas en silencio)** | `despachos.receivable`/`collection_event` sin escape hatch | **pendiente PR2** |
| restaurantes | webhook de WhatsApp entrante → `resolveOrganizationByPhoneNumberId` | **bloqueado (GRANT ausente, no solo RLS)** | `restaurantes.whatsapp_channel_config` NUNCA recibió `GRANT` a `authenticated` ni ninguna policy (`RLS enabled`, cero policies = deny-all incluso para el propio staff) — el canal de WhatsApp de restaurantes está inerte desde la Fase 1 | **pendiente PR2 (prioridad más alta)** |
| citas | crons/voz/WhatsApp (`confirmacion-cita`, voice tools, webhook) | **funciona** | ya usa funciones `security definer`/RPC idempotentes de punta a punta (`create_appointment_idempotent`, etc.) — sin gaps encontrados | sin cambio |
| rentas | crons (`checkin-recordatorio`/`checkout-sweep`/`ical-sync`/`ical-feed-publico`) | **funciona** | ya arreglado íntegramente por `...000094_015_cron_publico_rls_escape_hatch.sql` (PR anterior) | sin cambio, verificado que sigue OK |
| dispatchers de outbox (las 6 verticales) | `claim`/`complete` | **funciona** | GRANT + `security definer` ya arreglados en rondas previas (`...000086-091`, `...000116-118`) | sin cambio, verificado que sigue OK (0 funciones `service_role`-only encontradas en introspección completa contra Postgres real) |

Metodología de la Parte 1: (a) `grep -rn "userId: null"` sobre `apps/api/src/routes`
+ `apps/worker/src/jobs` para ubicar cada entrypoint de sesión de sistema; (b)
para cada uno, se siguió la cadena hasta `postgres-repository.ts` y se listó
cada sentencia SQL/función invocada; (c) se aplicaron las 136 migraciones
reales contra un Postgres 17 local efímero y se corrió una introspección
completa (`pg_policies`, `information_schema.role_table_grants`,
`has_function_privilege`) para clasificar cada tabla/función tocada como
funciona/bloqueada, cruzando el resultado contra (a)/(b) -- nunca por
adivinanza.

## Qué demuestra este script (21 escenarios)

Fixtures: 2 organizaciones de licitaciones (A ejercitada de punta a punta, B
para el control cross-tenant) + 2 organizaciones de hoteles (ídem), con su
property y staff real cada una; `hoteles.voice_agent_config`/
`whatsapp_channel_config` para la property A de hoteles.

1. **(1-5) Licitaciones de punta a punta bajo sesión de sistema**: ingerir una
   convocatoria descubierta (`system_ingest_tender`, upsert real -- el
   escenario 2 confirma que re-ingerir el mismo `external_id` actualiza,
   nunca duplica) → registrar la corrida (`system_record_source_run`) →
   encontrar la convocatoria por vencer (`system_list_tenders_with_upcoming_deadline`,
   antes 0 filas SIEMPRE, el mismo síntoma que motivó el PR #141) → crear su
   recordatorio, con dedupe real del mismo día
   (`system_record_deadline_reminder`).
2. **(6-11) Controles de licitaciones**: las 4 funciones nuevas rechazan a un
   staff autenticado real y a `anon` (exclusivas de sesión de sistema); un
   INSERT directo contra `licitaciones.tender`/`matching_profile` bajo sesión
   de sistema SIGUE bloqueado (el alcance del fix es exactamente las 4
   funciones, ninguna policy se tocó); un staff real SIGUE pudiendo dar de
   alta una convocatoria manual para su propia organización y SIGUE sin poder
   hacerlo para una organización ajena (comportamiento de staff sin cambio).
3. **(12-14) Hoteles de punta a punta bajo sesión de sistema**: resolver el
   secreto de voz por-property (`system_find_voice_agent_config` -- antes
   503 siempre) → crear el pedido de F&B (`insertFnbOrder` -- el hallazgo ya
   señalado explícitamente por el PR previo) → resolver la property por
   `phone_number_id` de WhatsApp (antes 200 siempre sin procesar nada).
4. **(15-20) Controles de hoteles**: la función nueva rechaza a staff real y a
   `anon`; un SELECT directo contra `hoteles.voice_agent_config` SIGUE
   devolviendo 0 filas bajo sesión de sistema (la policy `for all` nunca se
   tocó); un staff admin real SIGUE viendo/rotando su propio secreto; un staff
   real de una organización ajena y `anon` SIGUEN sin poder crear un pedido de
   F&B en una property que no es suya.
5. **(21) Límite deliberado**: `hoteles.reservation` (parte de la cadena de
   night-audit, fuera de alcance de este PR) SIGUE bloqueada para sesión de
   sistema -- guard de regresión de alcance explícito.

## Verificado ANTES/DESPUÉS del fix (evidencia real)

`run.sh` acepta `FLUJOS_SISTEMA_SKIP_FIX=1` para reproducir el estado ANTES
del fix (aplica las 136 migraciones reales EXCEPTO las 2 de este PR).
Resultados reales de correr `FLUJOS_SISTEMA_SKIP_FIX=1 ./run.sh` (ANTES) vs
`./run.sh` (DESPUÉS):

| Escenario | ANTES del fix | DESPUÉS del fix |
|---|---|---|
| 1-5 (licitaciones, flujo completo) | `ERROR: function licitaciones.system_ingest_tender(...) does not exist` (o `system_record_source_run`) -- consistente con que el código de producción de este PR llama a esas funciones incondicionalmente; con el código ANTERIOR (INSERT directo) el error real habría sido "new row violates row-level security policy for table tender" | Todos devuelven `1`/`0` según lo esperado |
| 12-13 (hoteles, secreto de voz + pedido F&B) | `ERROR: function hoteles.system_find_voice_agent_config(unknown) does not exist` / `ERROR: new row violates row-level security policy for table "fnb_order"` | Ambos devuelven `1` |
| 14 (hoteles, resolver property por teléfono) | `resuelve_property_por_telefono_deberia_ser_1` = **`0`** (reproduce el bug real: el webhook queda inerte) | `1` |
| 8/10/11 (controles "alcance del fix"/cross-tenant de licitaciones) | Mismo `ERROR` que después (sin cambio -- estas tablas/policies nunca se tocaron) | Sin cambio |
| 9/17/18/21 (controles de staff/alcance sin dependencia del fix) | Idéntico a después (`1`/`0` según corresponda) -- confirma que `FLUJOS_SISTEMA_SKIP_FIX=1` solo quita las 2 piezas relevantes, nada más | Sin cambio |

## Decisión de diseño (resumen -- el detalle completo, caso por caso, vive en
## el header de cada migración)

- **Licitaciones** (`...000137_024_licitaciones_sistema_ingesta_escritura.sql`):
  4 funciones `security definer` de solo-sistema (guard
  `auth.uid() is not null then raise ... using errcode = '42501'`), nunca
  escape hatch de policy -- `licitaciones.tender` es información de negocio
  propia del tenant (convocatorias, presupuesto, entidad convocante), sin
  precedente propio de escape hatch en esta vertical; el patrón YA
  establecido en licitaciones para escritura de sistema es la función
  `security definer` (`...000089_020_email_outbox_authenticated_grants.sql`).
- **Hoteles** (`...000139_022_hoteles_sistema_voz_whatsapp_escritura.sql`):
  mixto, caso por caso --
  - `hoteles.fnb_order` (INSERT + SELECT, esta última por el requisito de
    `RETURNING`): escape hatch `auth.uid() is null or <regla actual>` --
    precedente propio de esta vertical (`hoteles.night_audit_run`), datos sin
    dinero/PII sensible/credenciales.
  - `hoteles.whatsapp_channel_config` (SELECT): escape hatch -- catálogo de
    enrutamiento sin credenciales (mismo perfil que `core.property`).
  - `hoteles.voice_agent_config` (lectura): función `security definer`,
    NUNCA escape hatch -- la tabla trae `tool_webhook_secret`, una
    credencial; la policy `for all` original (que también gobierna
    insert/update/delete del secreto, reservados a staff admin) no se toca
    ni un carácter.
- Verificado en ambas migraciones (escenarios 9-11 y 17-20): un staff de la
  organización A sigue sin leer ni escribir datos de la organización B, y
  `anon` sigue sin acceso a ninguna de las tablas/funciones tocadas.

## Pendiente para un segundo PR (por prioridad)

1. **`restaurantes.whatsapp_channel_config`** -- sin GRANT a `authenticated`
   NI ninguna policy desde la Fase 1 (`...000031_001_restaurantes_schema.sql`);
   el canal de WhatsApp completo de restaurantes está inerte en producción
   real, para CUALQUIER rol (ni siquiera un staff autenticado podría leerla
   hoy). Verificado con introspección completa contra Postgres real
   (`information_schema.role_table_grants` + `pg_policies`, cero filas para
   esta tabla en ambas). Más severo que los 2 hallazgos de este PR --
   candidato a fix inmediato en el siguiente PR.
2. **`despachos.receivable`/`collection_event` (cron `cobranza-reminders`)** --
   mismo patrón que licitaciones (SELECT/INSERT bloqueados, 0 filas/permission
   denied en silencio) -- el cron de recordatorios de cobranza de despachos no
   encuentra ninguna cuenta por cobrar nunca.
3. **`hoteles.reservation`/`folio`/`rate_plan`/`tax_config`/`charge`/`payment`
   (worker jobs `night-audit`/`no-show`)** -- deliberadamente fuera de esta
   migración por tocar tablas de DINERO (cargos/pagos reales) -- requiere su
   propio diseño cuidadoso (¿escape hatch acotado por operación vs. funciones
   `security definer` dedicadas para `postNightlyHospedajeCharge`/
   `insertCharge`?) y su propio script de verificación con escenarios de
   z-report/cross-tenant específicos para dinero.
4. **`licitaciones.renewal_alert`/`contract_invoice`** (parte de
   `alert-notifications`, `scanRenewalAlerts`/`listOverdueContractInvoices`)
   -- mismo patrón `can_write_org`/`can_access_org` sin escape hatch,
   detectado durante esta auditoría pero fuera del alcance ya confirmado
   (tender/source_run/deadline_reminder) de este PR.
