# @atiende/domain-licitaciones

Dominio real y portado — ya NO es una carpeta reservada. Actualizado en el barrido
de documentación de las rondas 13/14/16: este README decía "aún no portado",
desactualizado desde hace muchas fases. El conteo de archivos se pudre rápido con
el ritmo de esta rama (era 46/22 en la ronda 13/14/16, es 52/23 al 19-sep-2026) —
verifica con `find packages/domain-licitaciones/src -type f | wc -l` /
`find packages/domain-licitaciones/migrations -type f | wc -l` en vez de confiar
en cualquier número escrito aquí. Portado de `licitaciones/packages/agents` (lo
específico de negocio; el gateway LLM compartido vive en `@atiende/agent-core`,
nunca duplicado aquí).

Cubre, de punta a punta: descubrimiento de convocatorias (conectores reales, ver
`connectors/`/`connector-registry.ts`), checklist de cumplimiento/integridad,
matching de perfil de empresa, flujo de aprobación granular, ensamblado de
paquete/propuesta económica y técnica (con agente de redacción/revisión asistido
por IA y aprobación humana obligatoria, `llm-requirement-extractor.ts`), ciclo de
vida y facturación de contrato, radar de renovación, autopsia de fallos,
inconformidades, y las alertas/recordatorios de plazo con su propio dispatcher de
correo (`alert-notifications.ts`/`email-dispatch.ts`). Consumido por
`apps/api/src/routes/verticals/licitaciones/` (23 archivos de rutas) y por los jobs
reales de `apps/worker/src/jobs/licitaciones/` (ver ese README para el detalle de
scheduler).

## Cobertura de descubrimiento de convocatorias (honesta, Fase 13)

`connector-registry.ts` registra 12 fuentes; 6 tienen una implementación
REAL (`connector` presente) y 4 están `liveVerification.verified: true`.
Ver el `README.md` de `apps/worker/src/jobs/licitaciones/` para la tabla
completa de estado por fuente, el contrato real descubierto de cada una
(endpoints, paginación, volumen) y los gaps declarados. Resumen:

- **SÍ cubierto (vigentes reales)**: Nuevo León (`nl_ocds`, API OCDS
  pública) sigue siendo la fuente con más cobertura real. Fase 13 agrega
  Yucatán (`yucatan_ocds`, INAIP) y Guadalajara (`guadalajara_ocds`,
  municipio) sobre la MISMA plataforma OCDS tipo Kingfisher
  ("contratacionesabiertas": `/edca/fiscalYears` + `/edca/contractingprocess/{year}`,
  ver `connectors/ocds/contratacionesabiertas-connector.ts` para el conector
  ÚNICO y genérico que sirve ambas instancias) -- CAVEAT REAL: Yucatán
  cubre ÚNICAMENTE las compras propias del instituto INAIP (~5 contratos/año),
  NO el gobierno estatal de Yucatán en general; con la evidencia real
  descargada (2025, ambas fuentes) ninguna convocatoria resultó vigente
  todavía (releases reales pero todos ya `tender.status: "complete"`) --
  `verified: true` describe "la API responde datos reales", no "produce
  vigentes hoy". CDMX (`cdmx_ocds`) tiene una implementación real y completa
  pero el recurso público verificado está estancado desde 2023 (gap de la
  FUENTE, no del código) y `compras_mx_historico` es histórico (contratos ya
  concluidos, nunca vigentes por diseño).
- **NO cubierto**: ComprasMX en vivo / DOF / cobertura nacional amplia --
  ver decisión ya tomada (no se evade reCAPTCHA/Akamai ni se scrapea prosa
  libre sin API) y el conector `aggregator` (API por pegar, sin proveedor
  elegido) como única vía realista a esa cobertura. Investigadas y
  descartadas en Fase 13 (16 fuentes candidatas del registro internacional de
  Open Contracting Partnership, 12 no sirven hoy -- dominios muertos,
  servidores caídos, TLS roto, institución extinta, o bot-detection, nunca
  evadido). Dos casos "reserva" para re-chequear más adelante (no
  registrados, no son placeholders nuevos): **CDMX/INFOCDMX** (ficha viva,
  puerto de datos caído el día de la verificación) y **NL — Secretaría de
  Administración** (dataset con ficha fresca, pero resuelve contra la MISMA
  infraestructura `api-ocds.nl.gob.mx` que `nl_ocds` ya consulta -- lo más
  probable es que ya esté cubierto, no se registró un conector duplicado).
- **Cómo se amplía**: configurar `LICITACIONES_AGGREGATOR_API_KEY` +
  `LICITACIONES_AGGREGATOR_BASE_URL` (ver `docs/CREDENCIALES.md`) contra un
  proveedor de agregación elegido, sustituyendo `connectors/aggregator.ts`
  únicamente en su mapeador (`mapAggregatorItem`) si el contrato real del
  proveedor difiere del documentado en `AggregatorTenderItem`. Para otro
  estado/municipio sobre la MISMA plataforma "contratacionesabiertas",
  agregar una instancia nueva en `contratacionesabiertas-connector.ts`
  (host + `fixedState`) es suficiente -- no se reimplementa el conector.

## L-04 — sala de guerra y preguntas de la junta de aclaraciones

Migración `029_sala_de_guerra_y_junta_aclaraciones.sql` (espejo `20240101000224_...`; verify
`scripts/verify-licitaciones-sala-guerra-junta/`). Código en módulos aparte para no tocar
`repository.ts`/`postgres-repository.ts`:

- `sala-guerra.ts` — tablero de preparación (requisitos, tareas y riesgos con responsable, fecha
  límite con semáforo rojo/amarillo/verde/gris, resumen y avance sin inventar porcentajes). Las
  decisiones go/no-go ya registradas (`go-no-go.ts`) solo se **muestran**; no se decide aquí.
- `junta-aclaraciones.ts` — huella normalizada y similitud para deduplicar, prioridad sugerida con
  razones explicables, máquina de estados `borrador → aprobada → enviada → respondida` (o
  `descartada`) con roles (aprobar exige `DECISION_ROLES`) y el vínculo a la respuesta del acta.
- `junta-question-draft-agent.ts` — borradores asistidos sobre el `LlmGateway` existente. Sin
  inventar datos: toda cifra de una pregunta propuesta debe estar en el contexto de las bases o la
  pregunta se descarta; guardrails anticorrupción/decisión de negocio en entrada y salida. Todo
  nace `borrador`.
- `sala-guerra-repository.ts` — `PostgresSalaGuerraRepository` (cada operación en SAVEPOINT; con la
  migración pendiente lanza `SalaGuerraNotAvailableError`, nunca un 500) e `InMemorySalaGuerraRepository`.

**No envía nada a ningún portal** (ComprasMX u otro): `enviada` y la respuesta del acta las registra
una persona.

## L-05 — WhatsApp (avisos y decisión go/no-go por botón)

Migración `030_whatsapp_avisos_y_decisiones.sql` (espejo `20240101000236_...`) y módulos `whatsapp.ts` (puro: token de un solo uso, id de botón, palabras clave SI/BAJA, redacción), `whatsapp-repository.ts` (Postgres con SAVEPOINT + versión en memoria + puerto del dispatcher de `@atiende/whatsapp-gateway`) y `whatsapp-service.ts` (solicitar decisiones y encolar avisos). Verificación contra Postgres real: `scripts/verify-licitaciones-whatsapp/`.

- **Opt-in verificado**: guardar el teléfono deja el contacto `pendiente`; solo un mensaje ENTRANTE (firmado por Meta) con `SI` desde ese número lo pasa a `activo`. `BAJA` lo desactiva y un `SI` posterior no lo revierte (hay que pedirlo de nuevo desde el panel). Cambiar el teléfono reinicia el consentimiento.
- **Token de decisión**: 32 bytes aleatorios; la base guarda solo el SHA-256. Un solo uso, vigencia de 24 h (tope 7 días), ligado a usuario + organización + convocatoria + acción + teléfono. El consumo lo revalida todo en la base (`whatsapp_consume_action_token`) y se ejecuta en la MISMA transacción que `go_no_go_decision`, con la sesión del usuario del token.
- **Cola**: `whatsapp_outbox` (patrón `hoteles.messaging_outbox`), solo funciones de sistema; al cerrar el mensaje se borran los botones (el token en claro solo vive mientras está pendiente).
- **Fuera de alcance de esta pieza**: aprobar/rechazar PROPUESTAS por botón (la aprobación del expediente exige el hash de insumos sellado y step-up; no se decide por un botón sin una decisión de producto) y los avisos de convocatoria nueva / fallo (hay primitiva `enqueueTenderNotices`, sin disparador cableado). Los avisos de plazo sí están cableados al barrido de alertas.

## L-08 — KYC negativo 69-B

Migración `031_licitaciones_kyc_69b.sql` (espejo `20240101000245_...`) y módulos `kyc-69b.ts` (puro: RFC estricto, lote, semáforo, alerta) y `kyc-69b-repository.ts` (Postgres con SAVEPOINT + versión en memoria). Lee la edición vigente de la lista 69-B que ya ingiere despachos (`despachos.efos_*`) con una función definer de solo lectura; la bitácora de consultas es privada por organización. Verificación contra Postgres real: `scripts/verify-licitaciones-kyc-69b/`. No valida el dígito verificador del RFC (solo su forma).

## L-26 — doble aprobación del expediente (REQ-044)

Migración `033_expediente_doble_aprobacion.sql` (espejo `20240101000280_...`): columna `licitaciones.approval.stage` (`tecnica_legal` | `economica`), índice único parcial (una vigente por etapa), trigger que impide que una misma persona dé las dos etapas y que la económica exista sin la técnico-legal del mismo hash, y policy de insert con `approver_id = auth.uid()` para las etapas. Dominio: `approval-workflow.ts` (`ApprovalWorkflow.approve({ stage })`, `evaluateExpedienteStages`); repositorios: `listExpedienteStageApprovals` (modo `doble` | `legacy` por SAVEPOINT, nunca falla en una base sin migrar). Las aprobaciones únicas previas vigentes se **invalidan** al migrar (con historial): no se convierten en 1/2. Verificación contra Postgres real: `scripts/verify-licitaciones-doble-aprobacion/`.

## L-P3-01/02 — aprobación real de los datos de empresa (REQ-044/064, REQ-162)

Migración `036_licitaciones_aprobacion_datos_empresa.sql` (espejo `20240101000343_...`): `proposed_by`/`approved_by`/`approved_at` en `approved_rate`, `company_document`, `company_capability`, `company_experience` y `company_signer` (esta última gana `approval_status`; los firmantes existentes se respaldan como `aprobado`); triggers que fijan `proposed_by = auth.uid()` y regresan a `pendiente_aprobacion` cualquier dato que cambie (DB-03); GRANT por columna (nadie con rol `authenticated` escribe `approval_status`/autoría); `licitaciones.decide_company_item` (`security definer`: rol de decisión por membresía, autor distinto del aprobador, transición atómica `where approval_status = 'pendiente_aprobacion'`) y bitácora `company_data_audit`. Dominio: `LicitacionesRepository.decideCompanyItem` (resultados `ok | not_found | conflict | autor | rol | no_disponible`) y `computeCompanyProfileHash` (`company-profile-hash.ts`): `companyProfileHash` del expediente ya no es una constante, cubre documentos, capacidades, experiencia, firmantes y su estado de aprobación en orden canónico. Las plantillas (`templates`) siguen en `[]`: no existe tabla de plantillas. Verificación contra Postgres real: `scripts/verify-licitaciones-aprobacion-datos-empresa/`. Orden de despliegue: primero el código, después la migración.

## L-P3-12/17 — step-up de un solo uso y bitácora de escrituras (REQ-083/084/171)

Migración `038_licitaciones_stepup_un_solo_uso_y_bitacora_escrituras.sql` (espejo `20240101000346_...`; la tabla de consumo vive en `core` pero va en el mismo archivo por el prefijo único asignado). **Step-up**: el token lleva `jti`; `core.step_up_consumption` (RLS, sin GRANT a ningún rol de aplicación) y `core.consume_step_up` (`security definer`, `auth.uid() = p_user_id`, membresía en la organización, `insert … on conflict do nothing`) lo consumen en la MISMA transacción de la acción: reuso o carrera → `false` → 403 «vuelve a confirmar»; si la acción falla y se revierte el token no se gasta. `core.purge_step_up_consumption` (solo sistema) la llama el barrido `/internal/superadmin/mantenimiento` (sin cron nuevo). En producción (`env.production`) sin puerto de 2FA o con su migración pendiente el step-up responde 503; con 0026 pero sin 038 conserva el token sin estado. **Bitácora**: `licitaciones.audit_trail` (solo adición: `authenticated` solo tiene SELECT, policy owner/admin) y `licitaciones.append_audit` (`security definer`; staff: `auth.uid() = p_caller_id` y rol de escritura; sistema: `auth.uid() is null` sin actor; valida formato de `correlation_id` y tamaño). Dominio: `appendAuditoria`/`listAuditoria`/`tenderCorrelationId` (`audit-trail.ts`, SAVEPOINT para la base sin migrar), lista cerrada de campos para antes/después (`pickAuditFields`) y `sanitizeCorrelationId` (1–64 caracteres `[A-Za-z0-9._:-]`). El `correlation_id` nace en la ingesta (uno por corrida, también en `source_run`) o en la petición (`X-Correlation-Id` saneado) y la convocatoria, sus versiones, las aprobaciones y el manifiesto lo heredan (`licitaciones.tender_correlation_id`). Verificación contra Postgres real: `scripts/verify-licitaciones-stepup-y-bitacora/` (`assertions.sql` y `concurrencia.sh`). Orden de despliegue: primero el código, después la migración.
