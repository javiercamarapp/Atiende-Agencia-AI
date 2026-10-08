# @atiende/domain-despachos

Nota: este archivo no existía antes de la Fase 10 (auditado al construirla —
`domain-despachos` era el único paquete de dominio del monorepo sin README propio,
a diferencia de `domain-hoteles`/`domain-citas`/`domain-rentas`/`domain-restaurantes`/
`domain-licitaciones`). No se reconstruye aquí el historial completo de las Fases
1-9 (ver `docs/REQUISITOS.md` y el comentario de cabecera de cada migración/archivo
de `src/` para el diseño de cada una); esta entrada arranca documentando la fase que
lo agrega.

## Seguridad de las rutas de staff (D-15, D-30, D-38)

### Toda ruta nueva se declara en la matriz en el MISMO PR (D-15)

`apps/api/tests/despachos-guardas-matriz.ts` es la verdad de diseno de quien puede llamar cada ruta bajo `/despachos/:propertyId/*` y `/v1/despachos/*`.
`apps/api/tests/despachos-guardas-rutas.spec.ts` enumera TODAS las rutas registradas en la app Hono y **falla** si una existe y no esta declarada en la matriz
(o si la matriz declara una que ya no existe). Por ruta comprueba: sin token 401, otra organizacion 403/404 sin filtrar datos, staff acotado a otra property 403,
cada rol fuera de su acceso 403 y cada rol dentro de el no bloqueado, y que `auditor` y `readonly` nunca escriben (salvo las calculadoras puras declaradas).

Al agregar una ruta: (1) escribe su entrada en `MATRIZ_GUARDAS` con los roles a proposito (`TODOS`, `ESCRIBE`, `SOLO_ADMIN` o `ADMIN_Y_AUDITOR`); (2) si solo calcula y no persiste,
anadela a `POST_DE_SOLO_CALCULO`; (3) si exige step-up, a `RUTAS_CON_STEP_UP`. Leccion real del 1-oct: #302 rompio `main` por no declarar sus rutas en la matriz de hoteles.

### Step-up TOTP en acciones sensibles (D-30)

Alcance `despachos_sensitive` (`@atiende/core-auth`), header `x-step-up-token` (5 min, atado a usuario+organizacion+alcance; se emite con `POST /auth/step-up`).
Lo exigen: cerrar un periodo del cierre mensual, crear y revocar enlaces del portal del cliente, exportar el paquete de contabilidad electronica
(`POST .../contabilidad-electronica/paquete` y `GET .../libro/contabilidad-electronica`) e invitar, revocar invitacion y cambiar rol de staff. Se aplica DESPUES del rol
(`apps/api/src/routes/verticals/despachos/step-up.ts`). Sin TOTP dado de alta: 403 `step_up_enrollment_required` (sin bypass); sin token vigente: 403 `step_up_required`.
Compatibilidad con la base sin migrar: sin el puerto de 2FA o con su migracion pendiente la guardia no exige nada (queda el control por rol).

### Bitacora de lecturas, descargas y exportaciones (D-38)

`apps/api/src/routes/verticals/despachos/auditoria-acceso.ts` registra en `despachosAuditSink` (`despachos.audit_log`) cada descarga del portal, PDF/XLSX de reportes, XML de contabilidad
electronica, layout DIOT, export de pagos provisionales y cartera en PDF: accion `despachos.<recurso>:<lectura|descarga|export>`, actor por id (sin correo) y solo identificadores
y parametros de forma en `metadata` (nunca contenido ni nombres de archivo). Se consulta con `GET /v1/despachos/:orgSlug/admin/bitacora?limit=&offset=` (solo `admin` y `auditor` con alcance de toda
la organizacion). Una exportacion o descarga nueva debe llamar a `auditarAccesoDespachos` en el mismo PR.

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

## D-01 — Dashboard gerencial y reportes de cliente

Sin migración: todo se calcula desde tablas que ya existen (CFDI 4.0 en `invoice`,
`receivable` + `collection_event`, `invoice_review`, `fiscal_deadline`,
`periodo_cierre`/`periodo_cierre_tarea`).

- `src/dashboard/kpis.ts` — motor puro (sin I/O ni reloj): `calcularKpisCliente`
  (cartera y cobranza, carga de trabajo, cierres, CFDI del mes, anomalías, nivel de
  atención) y `consolidarKpisDespacho` (suma y ranking de clientes). Cada fuente llega
  como `T | null`: `null` = no disponible aún (base sin migrar) y su bloque sale `null`,
  nunca cero.
- `src/dashboard/lectura.ts` — `leerKpisCliente` lee cada fuente en su propio SAVEPOINT
  (`runWithRowSavepoint`) y degrada a `null` ante SQLSTATE 42P01/42703/42883; cualquier
  otro error se repropaga.
- `src/reportes/` — `construirReporteDiot|Impuestos|Nomina|Balanza` (modelo neutro
  `ReporteCliente`) y `reporteAXlsx` (.xlsx sin dependencias: ZIP "stored" +
  SpreadsheetML). El PDF vive en `apps/api` (`reporte-pdf.ts`, pdf-lib).
- `src/declaraciones/diot-desde-invoices.ts` — la reconstrucción de la DIOT desde CFDI,
  compartida por `GET .../declaraciones/diot/:periodo` y el reporte DIOT.

**Lo que el modelo NO persiste y por lo tanto aparece como «sin datos» (no se inventa):**
asientos/pólizas (la balanza de comprobación solo se ofrece como resumen de CFDI por
categoría, rotulado como insumo), nómina procesada (ISR retenido/IMSS por empleado; solo
los recibos CFDI tipo N ingeridos), CFDI emitidos por el contribuyente (IVA trasladado,
saldo de IVA e ISR del período) y la asignación de trabajo por miembro del staff (la carga
de trabajo es por cliente).

## D-11 — Cola de cobranza (gestiones, reporte de cartera, WhatsApp en cola)

Complementa la cobranza de la Fase 10 sin duplicarla: la cartera sigue siendo `despachos.receivable` + `despachos.invoice`;
lo nuevo vive en `src/cola-cobranza/` y en la migración `017_despachos_cola_cobranza.sql` (espejo `20240101000248`).

- **Gestiones** (`despachos.cobranza_gestion`): promesa de pago, recordatorio, llamada y nota sobre una cuenta por cobrar
  (el cliente es el RFC receptor del CFDI). Montos de promesa en **centavos enteros MXN**; estado `pendiente` →
  `cumplida`/`incumplida`/`cancelada` (nunca se borran). Escritura solo por funciones `security definer` (admin/contador).
- **Cola**: las gestiones pendientes de cuentas vivas, ordenadas por urgencia (`ordenarCola`, puro) contra la fecha de negocio
  de la property (por omisión `America/Mexico_City`).
- **Reporte de cartera y antigüedad** (`construirReporteCartera`): por cliente y por CFDI, cubetas corriente / 1-30 / 31-60 /
  61-90 / +90. Entrega JSON y PDF reutilizando el render de `reporte-pdf.ts` (pdf-lib; no se agregó ninguna dependencia). Solo lee tablas
  ya existentes, así que funciona aunque la migración 017 no esté aplicada.
- **WhatsApp**: consentimiento opt-in/opt-out por cliente (con evidencia obligatoria para el opt-in) y un outbox
  (`cobranza_whatsapp_outbox`) donde los recordatorios quedan en `pendiente`. **Nada los envía**: no existe despachador ni credencial de
  WhatsApp para despachos; conectarlo es trabajo futuro. Un opt-out cancela los pendientes del cliente.
- **Base sin migrar**: el adaptador Postgres corre cada operación bajo `runWithSavepointFallback`; sin la 017 las lecturas devuelven
  `disponible: false` y las escrituras responden 503, nunca un 500.
- **Verificación**: `scripts/verify-despachos-cola-cobranza/` (Postgres real, 79 escenarios, integrado al gate de CI).

## D-21 / D-22 — Cartera de clientes y modelo CFDI completo (migración 018)

- **Cartera (D-21)**: una ficha fiscal por cliente del despacho (`despachos.cliente_ficha`, una fila por
  property de `core`): RFC (12/13 caracteres con fecha válida; los genéricos XAXX/XEXX se rechazan; el
  dígito verificador de la homoclave **no** se verifica), razón social, régimen(es) fiscal(es)
  (c_RegimenFiscal, con la regla régimen ↔ tipo de persona en `src/cartera/ficha.ts`), CP fiscal,
  periodicidad de pagos provisionales (mensual/bimestral) y responsable. Alta y edición pasan por funciones
  `security definer` (`cliente_alta`, `cliente_ficha_guardar`); el RFC de una ficha existente no cambia.
  Repositorio propio (`CarteraRepository`), opcional en `AppDeps.carteraRepo`.
- **CFDI completo (D-22)**: `despachos.invoice` gana `direccion` (emitido/recibido/indeterminado, se resuelve
  comparando el RFC de la ficha con emisor/receptor; sin ficha queda `indeterminado`, nunca se adivina),
  método/forma de pago, uso, moneda, tipo de cambio, montos en **centavos enteros** (bigint) y `estado_sat`
  (pendiente/vigente/cancelado/no_encontrado; lo captura el staff, sin llamadas al SAT). El desglose por
  impuesto vive en `despachos.invoice_impuesto`. Las columnas en pesos `numeric(14,2)` no se tocan.
- **Compatibilidad con la base sin migrar**: `insertInvoice` intenta el insert completo bajo SAVEPOINT y cae
  al insert histórico ante 42703/42P01; la ficha, el desglose y el filtro por sentido degradan a vacío /
  «no disponible» (ver `tests/cartera-postgres-savepoint.spec.ts` y
  `apps/api/tests/despachos-cfdi-ingesta-base-sin-migrar.spec.ts`).
- **D-23**: el análisis de solo lectura del REP ya existe (sección siguiente); falta persistir la liga. `parseCfdiXml` rechaza el CFDI tipo P; lo lee `parseComplementoPagoXml`.

## Calendario fiscal (D-26) y complemento de pago 2.0 (D-23)

- `src/vencimientos/calendario-fiscal.ts`: fechas límite en **día hábil** (art. 12 CFF) por obligación y régimen
  (ISR/IVA/Nómina día 17, DIOT último día del mes siguiente, balanza día 3 PM / 5 PF del segundo mes, anual 31-mar PM /
  30-abr PF). Feriados por regla de la LFT art. 74 (2026-2027 verificados en `tests/calendario-fiscal.spec.ts`); Semana
  Santa, ventanas vacacionales del SAT y los plazos de DIOT y balanza llevan `validarConFiscalista`. **Pendiente de
  confirmar con fiscalista**: la resolución anual de días inhábiles del SAT no está modelada.
- `src/vencimientos/procesos.ts`: persistencia compatible con la base sin migrar (SAVEPOINT ante 23514 en
  `Balanza`/`Anual`) y barrido idempotente de escalamiento (`POST .../vencimientos/barrido`, sesión de staff).
  Migración `019_despachos_calendario_fiscal_tipos.sql` (espejo `20240101000262`); verificación en
  `scripts/verify-despachos-calendario-fiscal/`.
- `src/cfdi/rep.ts`: análisis del REP 2.0 (`POST .../cfdi/rep/analizar`, solo lectura): saldo insoluto e IVA efectivamente
  pagado por mes de pago, en centavos. Verifica MetodoPago = PPD de la factura ligada (columna de D-22). No persiste los pagos ni alimenta DIOT/pagos provisionales todavía.

## D-24 / D-25 — Libro contable persistido y pagos provisionales ISR/IVA (migración 020)

Todo en **centavos enteros** (`bigint` en la base, `number` entero seguro en TypeScript; los factores se aplican con `BigInt`).
Sin llamadas al SAT ni a un PAC.

### D-24 — Libro contable (`src/libro/`)

- **Tablas**: `libro_cuenta` (catálogo por cliente, naturaleza D/A), `libro_poliza` (folio consecutivo por cliente, mes y tipo; origen
  manual / cfdi / reversa) y `libro_movimiento` (partidas, debe XOR haber). Una póliza **no se edita ni se borra**: se corrige con
  `libro_poliza_reversar`, que crea una póliza de diario con las partidas invertidas y marca la original.
- **Escritura solo por funciones `security definer`** (`libro_catalogo_sembrar`, `libro_cuenta_guardar`, `libro_poliza_registrar`,
  `libro_poliza_reversar(property, póliza, fecha, concepto)`): rol admin/contador de la organización de ESA property, cuadre (debe = haber),
  cuentas del catálogo del cliente, periodo cerrado (`periodo_cierre.status = 'closed'` -> 55000) y folio bajo `pg_advisory_xact_lock`. La
  reversa verifica el permiso sobre la property ANTES de bloquear la póliza. El núcleo interno `libro_poliza_insertar` no es ejecutable por
  public, anon ni authenticated (solo lo llaman registrar y reversar) y repite el guard de permisos. Tope de 2000 cuentas por cliente, también
  en la siembra.
- **Balanza derivada** `libro_balanza(property, ejercicio, mes)` (SECURITY INVOKER: respeta RLS). Saldo inicial: cuentas de balance
  (1, 2, 3) acumulan todo lo anterior; cuentas de resultados solo desde enero (no hay póliza de cierre de ejercicio). **A validar con el
  contador**: sin traspaso de resultados al capital, la balanza de un ejercicio posterior no refleja el resultado acumulado del anterior.
- **Póliza de un CFDI** (`construirPolizaDesdeCfdi`): solo arma lo no ambiguo (emitido I, nota de crédito emitida E, recibido I con categoría
  `honorarios` o `gasto_operativo`); el resto (moneda extranjera, nómina, activo fijo, sentido indeterminado) devuelve el motivo para registrar la
  póliza a mano. La póliza es **devengada**; el cobro/pago (Bancos contra Clientes/Proveedores) es otra póliza.
  Desde la migración 028 / D-P3-17 también arma el CFDI **con retenciones de ISR/IVA** (honorarios y arrendamiento de persona física: recibido ->
  abono a «ISR/IVA retenido por pagar»; emitido -> cargo a «ISR/IVA retenido a favor») y **con IEPS** (recibido: al costo por omisión o acreditable si el
  staff lo declara; emitido: abono a «IEPS por pagar»). El total debe ser base + IVA + IEPS - retenciones (centavos) o no sale la póliza
  (`poliza-impuestos.ts`; supuestos marcados «validar con el fiscalista»).
- **Cobro/pago de un REP** (`construirPolizaDesdeRep`, `POST .../libro/polizas/desde-rep`): una póliza vigente por pago de `pago_cfdi`
  (`libro_poliza_rep` + `libro_poliza_registrar_rep`), con el traspaso del IVA no cobrado/no pagado a cobrado/pagado por el IVA proporcional que ya
  guardó el servidor (prorrateo BigInt de `cfdi/rep.ts`). Lista para que el job «pólizas del periodo» (#453) la llame cuando exista en `main`.
- **Contabilidad electrónica** desde el libro (`generarPaqueteDesdeLibro`): catálogo + balanza XML con SHA-1, **conformes al XSD 1.3 del SAT y
  validados en las pruebas contra los XSD oficiales** (`tests/fixtures/contabilidad-electronica-xsd/`, `xmllint-wasm` como dependencia de desarrollo).
  Cada cuenta lleva nivel, cuenta padre (`SubCtaDe`) y código agrupador del SAT (`CodAgrup`, lista cerrada de 1080 valores en
  `normas/anexo-24-codigo-agrupador.yaml`); **el XML se niega a generarse si falta algún código** y lo dice. Balanza N/C (`FechaModBal` solo en C);
  sin `FechaModificacion` ni sellos vacíos (no existen en el XSD / lo llena la e.firma, que no se usa). XML de pólizas del periodo
  (`generarXmlPolizasPeriodo`, PolizasPeriodo 1.3) con tipo de solicitud y número de orden/trámite como entrada, sin nodos de complemento (CFDI,
  cheque, transferencia: opcionales en el XSD; el libro aún no guarda esos datos). Importación del catálogo y la balanza del proveedor anterior
  (`importar-xml.ts`, mismas defensas que el parser de CFDI): vista previa, rechazos con motivo y confirmación con segundo factor; la balanza
  se registra como póliza de apertura fechada el último día del mes anterior. NumCta no numéricos (guiones, letras) NO se importan: el libro
  solo maneja cuentas de 4 a 10 dígitos.

### D-25 — Pagos provisionales (`src/pagos-provisionales/`)

- **Flujo de efectivo**: un CFDI PUE cuenta en el mes de su fecha; un CFDI PPD cuenta solo por los pagos de su complemento de pago (REP) en el
  mes de la **fecha de pago**, por la base e IVA proporcionales (`pago_cfdi`, idempotente por REP + parcialidad + CFDI, sin sobrepagos).
- **REP persistido**: `POST .../pagos-provisionales/rep` parsea el XML (D-23), toma el RFC **de la ficha del cliente** (nunca del cuerpo), liga cada
  documento a un CFDI PPD del mismo cliente y registra un pago a la vez (cada uno en su SAVEPOINT).
- **ISR**: 601 (coeficiente de utilidad del contador x **ingresos nominales** acumulados, 30%: CFDI emitidos del periodo por su fecha, incluidos
  PPD aún no cobrados, LISR 17 -- NO por flujo de efectivo), 612 (utilidad acumulada por flujo con la tarifa del art. 96 del ejercicio escalada al
  periodo; solo ejercicios con tabla verificada, hoy 2025 y 2026, y solo persona física) y 626 RESICO PF (tasa mensual 1.00-2.50% sobre ingresos
  cobrados; RFC de 13 caracteres). Persona moral (RFC de 12) en 612/626, otro ejercicio en 612 y otros regímenes: "no soportado" (honesto, sin
  cifras). Sin coeficiente: "faltan datos".
- **IVA** (por flujo de efectivo en todos los regímenes, LIVA 1-B): trasladado cobrado - acreditable pagado - retenido - saldo a favor anterior (el del papel presentado del mes previo o el capturado).
- **Exclusiones con motivo e importe**: cancelados/no encontrados ante el SAT, moneda extranjera, sentido indeterminado, sin método de pago;
  como deducción/acreditamiento: CFDI inválidos (incluye 69-B definitivo), efectivo > $2,000.00 (LISR 27-III, LIVA 5-I), uso D01-D10/S01/CP01.
  Inversiones (I01-I08): su base NO se deduce de golpe; su IVA sí se acredita.
- **Papel de trabajo** (`pago_provisional`): borrador guardado por el servidor, presentado con monto pagado y fecha (completa el vencimiento
  del calendario fiscal del mismo periodo); un papel presentado ya no se recalcula. Exporta a PDF y XLSX.
- **Aviso in-app** `despachos.pago_provisional.por_vencer` (catálogo de notificaciones): función de solo-sistema + productor invocado por el cron
  diario de cobranza (no se agregó un cron).

### Preguntas para el fiscalista / contador (lo dudoso, sin inventar)

0. **ISR 601 (personas morales)**: se calcula con ingresos nominales (CFDI emitidos del periodo por fecha, LISR 17, incluidos PPD no cobrados) y el
   IVA por flujo (LIVA 1-B). ¿Se confirma? No se incluyen anticipos o cobros sin CFDI ni entregas/servicios aún sin CFDI (el art. 17 acumula lo que
   ocurra primero: expedir CFDI, entregar el bien o servicio, o cobrar). Las retenciones de ISR se acreditan por flujo. Si no se valida, el 601 debe
   tratarse como "no soportado" para ese cliente.
0b. **626 y 612 solo para personas físicas**: se distinguen por la longitud del RFC (12 = moral). RESICO de personas morales no está modelado.
0c. **612 y ejercicio**: la tarifa del art. 96 sale de la tabla mensual del ejercicio (2025 y 2026 verificadas); otro ejercicio responde "no soportado".
0d. **Balanza sin traspaso de resultados**: no hay póliza de cierre/traspaso del resultado del ejercicio al capital (ver D-24).
0e. **Terminología de pólizas**: las pólizas de CFDI son devengadas (cliente/proveedor contra ingreso/gasto) pero se rotulan `ingreso`/`egreso`
   (que en contabilidad electrónica suelen significar cobro/pago) y las notas de crédito van como `diario`. ¿Se confirma el rotulado?
0f. **Cuentas asumidas**: el catálogo base y el mapeo automático de CFDI a cuentas (clientes 1050000, ingresos 4080000, IVA 2600300/2600400,
   devoluciones 4020000, etc.) son supuestos del catálogo agrupador, no una decisión del contador del despacho.
0g. **Nómina deducida**: hoy el CFDI de nómina entra al 612 por su total/base neta del CFDI (subtotal - descuento), no por el bruto (percepciones)
   ni con las retenciones separadas. ¿Neto o bruto?
0h. **Saldo a favor de IVA**: se arrastra solo el saldo del papel PRESENTADO del mes previo (o el capturado a mano); no se compensa ni se acredita
   automáticamente contra otros impuestos ni se pide devolución.
1. 612: ¿se confirma que la tarifa del art. 96 del periodo acumulado equivale a la tarifa mensual x meses transcurridos (cuota fija y límites)?
2. Efectivo > $2,000.00: ¿aplica igual a pagos PPD pagados en efectivo (la forma de pago está en el REP, no en el CFDI; hoy solo se excluye en PUE)?
3. Nómina emitida por el cliente: ¿se deduce por la fecha del CFDI o por la fecha de pago de la nómina?
4. RESICO: tope de $3,500,000.00 acumulado del ejercicio (hoy solo se advierte) y retención de 1.25% por personas morales.
5. IVA acreditable de CFDI con uso I01-I08 y de gastos con IVA parcialmente no acreditable (se acredita el IVA completo).
6. XML de contabilidad electrónica: ya se valida contra el XSD oficial en las pruebas, pero no contra el validador en línea del SAT ni con un envío real.
7. Códigos agrupadores del catálogo base (`CODIGO_AGRUPADOR_BASE`) y cuentas nuevas de retenidos/IEPS/IVA cobrado: son propuestas todas válidas en la
   lista del Anexo 24 pero la correspondencia cuenta -> código la debe validar el fiscalista (ficha `anexo-24-codigo-agrupador`, `por_verificar`).
8. IEPS recibido: ¿al costo (por omisión) o acreditable? Retenciones de IVA en un pago de REP: no se traspasan.
