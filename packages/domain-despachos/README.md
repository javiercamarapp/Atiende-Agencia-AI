# @atiende/domain-despachos

Nota: este archivo no existía antes de la Fase 10 (auditado al construirla —
`domain-despachos` era el único paquete de dominio del monorepo sin README propio,
a diferencia de `domain-hoteles`/`domain-citas`/`domain-rentas`/`domain-restaurantes`/
`domain-licitaciones`). No se reconstruye aquí el historial completo de las Fases
1-9 (ver `docs/REQUISITOS.md` y el comentario de cabecera de cada migración/archivo
de `src/` para el diseño de cada una); esta entrada arranca documentando la fase que
lo agrega.

## Fase 10 — cobranza automatizada (cuentas por cobrar)

Gap real verificado contra el original (`~/Desktop/supabase/despachos/b2b_ai/
services/collections.py` + `collections_report.py` + `collections_templates.py`):
`domain-despachos` no tenía ningún módulo de cobranza — ni seguimiento de estado de
facturas emitidas vs. pagos recibidos, ni aging, ni recordatorios escalonados. El
comentario de cabecera de `despachos.invoice` (migración 001) ya declaraba que
"cobranza" leería de esa tabla; esta fase cierra esa referencia pendiente.

- `src/cobranza/engine.ts` — motor determinista (sin LLM), port literal de
  `CollectionsManager.analyze`/`collectability_score` y de
  `aging_report`/`projection`/`summary`: clasificación por antigüedad (buckets
  0-30/31-60/61-90/90+), score de cobrabilidad (0..1, ponderado por antigüedad +
  historial de respuestas/escalamientos), análisis de cartera, proyección de cobro
  esperado (monto × score) y resumen ejecutivo con alertas. 100% puro/testeable, sin
  acceso a base de datos — mismo criterio que `vencimientos/engine.ts` en este mismo
  paquete.
- `src/cobranza/templates.ts` — las 5 plantillas de recordatorio en español MX
  (`pre_vencimiento`/`vencimiento`/`recordatorio_formal`/`segundo_recordatorio`/
  `escalamiento`), texto traducido 1:1 del origen, para email (subject + body) y
  WhatsApp.
- `despachos.receivable` (migración 004) — arranca el reloj de cobranza sobre un
  invoice tipo 'I' ya ingerido (`fecha_vencimiento` + `pagado_en`/`monto_pagado`
  cuando se liquida). Deliberadamente una tabla aparte del invoice (no una columna
  nueva en `despachos.invoice`): el CFDI en sí no trae una fecha de vencimiento
  utilizable, e ingerir un CFDI (flujo 1, estable desde Fase 1) nunca debía acoplarse
  a si ese invoice también entra a cobranza activa.
- `despachos.collection_event` (migración 004) — auditoría de cada recordatorio
  generado y de las respuestas del deudor (`etapa = 'respuesta'`); alimenta el score
  de cobrabilidad como historial.

**Límite heredado del origen, RESUELTO en la Fase 12 (ver más abajo):** el
`CollectionsManager` original nunca envía mensajes reales — su propio docstring lo
dice: "NO envía mensajes reales: solo genera el contenido y, opcionalmente, lo
registra... El envío real queda a cargo del canal de notificaciones del cliente."
Este port respetó ese límite exacto en esta fase: `construirRecordatorioCobranza`
generaba el contenido (subject/body o texto de WhatsApp) y `insertCollectionEvent`
dejaba el rastro de auditoría, pero **no había integración con un canal de envío
real** (`messaging_outbox`/`whatsapp-gateway`/email). La Fase 12 (hallazgo de
auditoría, severidad ALTA) conecta el contenido generado a `despachos.messaging_
outbox` vía correo real — ver esa sección para el detalle completo.

Migración nueva: `migrations/004_cobranza_schema.sql`.

## Fase 11 — nivel 4 (LLM) de conciliación bancaria

Gap real de auditoría de paridad: el motor de conciliación bancaria de 4 niveles
(puerto de `~/Desktop/supabase/despachos/b2b_ai/services/bank_reconciliation.py`)
ya estaba en `src/conciliacion/` desde Fase 5 — niveles 1 (exacto) y 3 (multi-línea)
byte-exactos, nivel 2 (fuzzy) con `partialRatio` documentado como aproximación
verificada — pero el nivel 4 (asistido por LLM, para los movimientos que ningún
nivel determinista resolvió) quedó explícitamente NO portado (ver el comentario de
cabecera de `matching-engine.ts` de esa fase). Esta fase lo cierra.

- `src/conciliacion/llm-matching-agent.ts` — `sugerirMatchesLLM`/`aprobarSugerenciaLLM`.
  Opera sobre `unmatchedBank`/`unmatchedBooks`, el resultado de `conciliarMovimientos`
  (niveles 1-3) — nunca se mezcla con ese motor determinístico. Usa el mismo
  `@atiende/agent-core::LlmGateway` que las otras 4 escaleras de producción (ver
  `apps/api/src/production/llm-gateway.ts::DESPACHOS_CONCILIACION_LLM_ROLE`), con un
  pre-filtro determinístico (overlap de tokens + proximidad de fecha, reutilizando
  `text-similarity.ts`/`fechas.ts` ya verificados) para acotar la lista de candidatos
  ofrecida al modelo por movimiento — mismo umbral (0.15) que
  `_pass_ai.TOKEN_PRE_FILTER_THRESHOLD` del origen.

**Diferencia de diseño DELIBERADA frente al origen:** `_pass_ai` del origen
auto-aplica un match cuando `confianza >= 50` (`bank_reconciliation.py`, líneas
801-806) — ningún humano lo revisa antes de conciliarse. Aquí **nunca** se
auto-aplica, sin importar la confianza reportada: `sugerirMatchesLLM` solo produce
`SugerenciaMatchLLM` con `status: "pendiente_aprobacion"`, y la única vía a algo con
la forma de un match real (`CoincidenciaConciliacionLLM`, `level: "llm"`) es
`aprobarSugerenciaLLM`, que exige un rol de `CONCILIACION_ROLES` (`admin`/
`contador`). Mismo criterio de guardrails que `domain-rentas/src/agentes/
generadorBorradorIA.ts` y `domain-licitaciones/src/technical-proposal-draft-agent.ts`
(`approveDraft()` como única vía a un resultado definitivo). Además, un índice de
candidato devuelto por el modelo se valida ESTRUCTURALMENTE contra la lista
realmente ofrecida — un índice fuera de rango (alucinado) nunca se traduce en un
`registroIdx` inventado, se registra como `respuesta_invalida` en `sinSugerencia` y
el lote sigue con el siguiente movimiento.

**Límite deliberado de esta fase:** no se agregó endpoint HTTP propio en
`apps/api/src/routes/verticals/despachos/conciliacion.ts` — mismo estado que
`TechnicalProposalDraftAgent` de licitaciones Fase 9 (domain module + rol de gateway
registrado, sin ruta HTTP todavía). Conectarlo (`POST .../conciliacion/sugerir-llm`
+ `POST .../conciliacion/aprobar-llm`, recibiendo `unmatchedBank`/`unmatchedBooks`
del resultado de `/matching`) es un incremento natural futuro, no bloqueante para el
valor del módulo de dominio en sí — ver el comentario actualizado de cabecera de
`conciliacion.ts` para el shape exacto propuesto.

Sin migración nueva (este módulo no persiste nada — las sugerencias/aprobaciones
viajan en memoria dentro de la misma corrida, igual que `conciliarMovimientos`).

## Fase 12 — infraestructura de correo real (hallazgo de auditoría, severidad ALTA)

Gap real verificado antes de esta fase: `grep -rn "email\|outbox\|whatsapp"
packages/domain-despachos/src apps/api/src/routes/verticals/despachos` solo
encontraba `cobranza/templates.ts` (5 plantillas de recordatorio en **texto
plano**, sin HTML ni layout) y el propio README (sección de Fase 10, arriba)
admitiendo "no hay integración con un canal de envío real ... en esta fase".
`packages/domain-despachos/migrations/` no tenía ninguna tabla de outbox
(`004_cobranza_schema.sql` lo difería explícitamente a "fase futura").
`POST /despachos/:propertyId/vencimientos/:deadlineId/escalar`
(`apps/api/src/routes/verticals/despachos/vencimientos.ts`) solo insertaba el
escalamiento en BD y marcaba `estado='escalado'` — nunca notificaba a nadie.
`apps/worker/src/jobs` no tenía ninguna carpeta `despachos/` (a diferencia de
citas/hoteles/licitaciones/rentas/restaurantes). Mientras tanto, citas
(migración 009)/rentas (migración 011)/licitaciones (migración 018) ya tenían
las 3 piezas completas: outbox real, plantilla HTML de marca "atiende", y
dispatcher vía Resend.

Esta fase porta EXACTAMENTE ese mismo patrón, sin inventar uno nuevo:

- `src/emails/layout.ts` — el mismo marco visual HTML (tabla compatible
  Outlook/Gmail/Apple Mail, wordmark de texto "atiende" — **nunca un logo de
  imagen embebido**, ninguna vertical del monorepo lo usa) que
  `domain-citas`/`domain-rentas`/`domain-licitaciones`, sin cambios de
  paleta ni de estructura.
- `migrations/005_email_outbox_and_notificaciones.sql` — `despachos.messaging_
  outbox` (organization-scoped, `channel` acotado a `'email'` únicamente:
  despachos tampoco tiene WhatsApp, mismo caso que licitaciones) +
  `enqueue_messaging_outbox`/`claim_email_outbox_batch`/
  `complete_email_outbox_job` (mismo patrón/nombres que citas/rentas/
  licitaciones) + `despachos.organization_notification_recipients(org_id)`
  (staff `owner`/`admin` vía `core.membership`/`core.staff_user`) + 2 columnas
  NULLABLE nuevas en `despachos.receivable` (`cliente_nombre`/`cliente_email`
  — el CFDI nunca trajo un correo de contacto del deudor utilizable, gap real
  independiente que esta fase también cierra).
- `src/email-dispatch.ts` — `sendEmailOutboxJob`/`dispatchPendingEmailJobs`,
  port literal de `domain-citas/domain-licitaciones` sobre `DespachosRepository`.
  Fail-closed real: sin `RESEND_API_KEY`, nunca finge éxito. Expuesto vía
  `POST /internal/despachos/email-dispatch`
  (`apps/api/src/routes/verticals/despachos/notifications.ts`).
- **Escalamiento de vencimientos** (aviso INTERNO al despacho, nunca al
  contribuyente): `src/emails/vencimiento-templates.ts` +
  `src/vencimientos/email-notifications.ts` — al escalar un vencimiento
  (`POST .../vencimientos/:id/escalar`), ahora se encola un correo real a
  todo el staff owner/admin de la organización
  (`repo.listOrganizationNotificationRecipients`), best-effort: un fallo al
  notificar nunca revierte el escalamiento, que ya quedó registrado.
- **Recordatorios de cobranza** (aviso a un tercero externo, el deudor):
  `src/cobranza/email-templates.ts` (envuelve el MISMO texto ya verificado de
  `cobranza/templates.ts` en el layout HTML compartido, sin cambiar
  redacción) + `src/cobranza/email-notifications.ts`
  (`tryEnqueueCollectionReminderEmail`, encola el correo SI la cuenta por
  cobrar tiene `clienteEmail` capturado, y SIEMPRE deja el registro de
  auditoría en `collection_event` aunque no haya correo) +
  `@atiende/worker::runCobranzaReminderSweep`
  (`apps/worker/src/jobs/despachos/cobranza-reminders.ts`, primer job real de
  este vertical): barrido transversal de toda la cartera pendiente de todas
  las organizaciones/properties activas, decidiendo con el motor puro ya
  existente (`etapaRecordatorioCobranzaHoy`) si hoy toca recordatorio.
  Expuesto vía `POST /internal/despachos/cobranza-reminders`.

**Límite deliberado de esta fase:** no se agregó ningún endpoint HTTP nuevo
para crear/listar/pagar cuentas por cobrar (`registerReceivable`/
`listReceivables`/`markReceivablePaid` seguían sin ruta HTTP propia antes de
esta fase, y siguen sin ella después) — ese es un gap de superficie CRUD
independiente del hallazgo de esta fase (ausencia de infraestructura de
correo), y agregarlo hubiera sido alcance no pedido. `cliente_nombre`/
`cliente_email` se capturan hoy solo vía el repositorio directo (tests /
futura pantalla de captura); sin ellos, el recordatorio de esa cuenta
simplemente no se envía por correo (comportamiento honesto, no un error).
