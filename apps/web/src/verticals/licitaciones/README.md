# Vertical: licitaciones (web)

Fase 1 construyó: `pages/Login.tsx` — pantalla real de login (email+password
contra `POST /auth/login` de `@atiende/core-auth`, mismo mecanismo que
`verticals/hoteles/pages/Login.tsx`/`verticals/restaurantes/pages/Login.tsx`).
`lib/auth-client.ts` reutiliza las funciones genéricas de red del vertical
restaurantes y solo redefine lo específico de licitaciones: la llave de
sesión (`atiende.licitaciones.session`) y el landing path
(`/licitaciones/:slug`).

Explícitamente fuera de Fase 1 (ver diseño Fase 1 licitaciones §5/§6): 2FA
TOTP, Google OAuth, verificación de email, rotación de refresh token,
invitaciones de staff — backend/dominio ante todo en esa fase.

## Fase 7 — el backoffice visual real (gap: "el panel casi no existe")

Hasta Fase 6, `Login.tsx` ni siquiera estaba montado en `apps/web/src/App.tsx`
(el login del vertical era inalcanzable en tiempo de ejecución, no solo el
resto del panel) y todo el motor de dominio ya construido en
`packages/domain-licitaciones` (checklist de integridad, matching/go-no-go,
contratos, cobranza, inconformidades, autopsia, renovación) solo era operable
vía API cruda. Esta fase construye el primer tramo REAL y navegable del panel,
con datos reales de principio a fin (sin mocks fuera de los tests):

- `LicitacionesShell.tsx` — resuelve sesión + propertyId una sola vez (vía
  `GET /v1/licitaciones/:orgSlug/admin/branches`, endpoint NUEVO de esta fase —
  ver `apps/api/src/routes/verticals/licitaciones/admin.ts` — la vertical no
  tenía NINGÚN camino real para resolver ese propertyId; ni siquiera el login
  llegaba a ninguna pantalla). Mismo patrón exacto que `CitasShell.tsx`.
- `pages/Convocatorias.tsx` — lista TODAS las convocatorias de la organización
  (título/entidad/fecha límite reales, `GET .../tenders`, endpoint NUEVO de
  esta fase — ver nota abajo) ordenadas por score de matching en vivo
  (`GET .../tenders/matching`, Fase 3), con alta manual
  (`POST .../tenders`, Fase 3 pieza 1) para quien tenga rol de escritura.
- `pages/ConvocatoriaDetalle.tsx` — ficha de una convocatoria: desglose de
  matching/elegibilidad por criterio (`GET .../tenders/:id/matching`, Fase 3),
  historial COMPLETO de decisiones go/no-go + formulario para tomar una nueva
  (`GET`/`POST .../go-no-go`, Fase 3 pieza 3, solo visible para
  `GO_NO_GO_ROLES`) y un resumen de **solo lectura** del checklist de
  integridad (`GET .../checklist`, L1 · Flujo 1).
- `lib/*.ts` — un cliente HTTP tipado por dominio (`admin-client.ts` con los
  helpers compartidos + resolución de property, `tenders-client.ts`,
  `matching-client.ts`, `matching-profile-client.ts`, `go-no-go-client.ts`,
  `checklist-client.ts`, `format.ts`), todos con `fetchImpl` inyectado (nunca
  `globalThis.fetch` directo) para poder probarlos con vitest en entorno
  "node" — mismo criterio que `citas/lib/*.ts`.

## Fase 8 — perfil de matching (gap ALTA de auditoría: "la columna Score/elegibilidad es inservible hasta hacer un PUT por curl")

- `pages/PerfilMatching.tsx` — formulario de los 7 campos del perfil
  (keywords, excludedKeywords, classifierCodes, entities, states, budgetMin,
  budgetMax; `GET`/`PUT .../matching-profile`, Fase 3 pieza 2,
  `matchingProfile.ts`). Antes de esta fase, `GET`/`PUT` ya existían en el
  backend (el `PUT` ya restringido a `WRITE_ROLES`) pero eran alcanzables
  SOLO por curl -- `MatchingEngine.score` (matching-engine.ts) depende de
  este perfil como única fuente de esos criterios, así que sin esta pantalla
  la columna "Score" de `Convocatorias.tsx` mostraba "No evaluable" para
  TODAS las convocatorias de cualquier organización que no supiera hacer el
  PUT a mano. Mismo criterio de gating cosmético que el resto del panel
  (`WRITE_ROLES`, `Convocatorias.tsx`): el formulario se oculta (solo lectura)
  para roles sin permiso, pero el servidor ya rechazaba el `PUT` igual.
- `lib/matching-profile-client.ts` — `fetchMatchingProfile`/
  `saveMatchingProfile`, y `putJson` nuevo en `admin-client.ts` (primer `PUT`
  del panel; hasta esta fase solo existían `fetchJson`/`postJson`).
- Ruta nueva `/licitaciones/:orgSlug/perfil-matching` en `App.tsx` + entrada
  de nav en `LicitacionesShell.tsx`.

**Backend nuevo que esta fase tuvo que agregar** (no existía ningún camino de
lectura para esto, no es capricho de la UI):

- `GET /v1/licitaciones/:orgSlug/admin/branches` (`admin.ts`, nuevo) —
  resuelve propertyId(s) desde el slug, mismo patrón que
  `GET /v1/citas/:orgSlug/admin/branches`. Requirió agregar
  `findOrganizationBySlug`/`listPropertiesForOrganization` a
  `LicitacionesRepository` (interfaz + `InMemoryLicitacionesRepository` +
  `PostgresLicitacionesRepository`), leyendo directo de
  `core.organization`/`core.property` — mismo patrón exacto que
  `CitasRepository`. Sin migración SQL nueva: esas tablas ya existían
  (`0001_core_schema.sql`).
- `GET /licitaciones/:propertyId/tenders` y
  `GET /licitaciones/:propertyId/tenders/:tenderId` (`tenders.ts`, nuevos) —
  el `TenderRecord` completo (título, fecha límite, entidad). Antes de esta
  fase, `GET .../tenders/matching` (Fase 3) era el único endpoint de lectura
  de convocatorias y solo expone el `MatchResult` (score/elegibilidad), sin
  título — insuficiente para pintar cualquier lista o ficha real. El segmento
  `:tenderId` de esta ruta está restringido por regex a forma de UUID
  (`{[0-9a-fA-F-]{36}}`) para no chocar con la ruta estática
  `.../tenders/matching` de matching.ts (dos sub-apps Hono montadas en "/", el
  registro de rutas es sensible a orden — ver comentario en tenders.ts).

## Fase 11 — carga de bases + requisitos extraídos (gap ALTA: "el flujo central del producto sin ninguna pantalla")

Pieza DELIBERADAMENTE acotada al prerrequisito compartido que todo el resto
del Flujo 2 necesita — NO el flujo completo de propuesta
técnica/económica/aprobaciones/ZIP (eso sigue en la lista de "fuera de esta
fase" abajo, sin cambios):

- `pages/RequisitosConvocatoria.tsx` (ruta
  `/licitaciones/:orgSlug/convocatorias/:tenderId/requisitos`, enlazada desde
  `ConvocatoriaDetalle.tsx`) — el staff sube uno o más PDF (o texto plano) de
  las bases de una convocatoria, convertidos a base64 en el propio navegador
  (`lib/requirements-client.ts::fileToBase64`, sin backend intermedio), y ve
  la matriz de requisitos que `RuleBasedExtractor` [+ `LlmRequirementExtractor`
  si hay LLM configurado] sacó de su texto REAL — extraído server-side por
  `@atiende/domain-licitaciones::extractDocumentText` (motor `pdfjs-dist`,
  Fase 11 del backend, ver `apps/api/.../technicalProposal.ts`). Un documento
  sin texto extraíble (PDF escaneado sin capa de texto, formato no soportado o
  corrupto) se reporta explícito como excluido (`skippedDocuments`) — nunca se
  inventa contenido. Gating cosmético por `WRITE_ROLES` (mismo set que
  `Convocatorias.tsx`); el servidor (`assertVerticalRole` en
  `technicalProposal.ts`) es siempre la barrera real.
- `lib/requirements-client.ts` — `fetchRequirementItems` (`GET .../requirements`,
  forma persistida `RequirementItemRecord`), `extractRequirements`
  (`POST .../requirements/extract`, con `idempotency-key` generado por
  intento — un reintento manual del usuario SIEMPRE genera una key nueva) y
  `fileToBase64`/`MAX_UPLOAD_FILE_BYTES` para la conversión y el límite
  cliente-side (~22MB, mismo tope que `storage.ts::decodeBase64Content`
  server-side).

**Fuera de esta pieza, a propósito:** el resto del Flujo 2 (propuesta
técnica/económica, aprobaciones y el ensamblado del ZIP de cierre) seguía sin
pantalla en esta fase — la propuesta técnica y la mapeo de cumplimiento se
construyeron en Fase 12, y la propuesta económica en Fase 13 (ver arriba);
aprobaciones y el ZIP de cierre siguen en la lista de "fuera de esta fase" más
abajo.

## Fase 12 — propuesta técnica + mapeo de cumplimiento (gap ALTA: "siguiente paso natural tras RequisitosConvocatoria.tsx")

- `pages/PropuestaTecnica.tsx` (ruta
  `/licitaciones/:orgSlug/convocatorias/:tenderId/propuesta-tecnica`,
  enlazada desde `RequisitosConvocatoria.tsx`) — a partir de los requisitos
  ya extraídos, declara si cada requisito CONDICIONAL aplica al caso
  concreto, genera la propuesta técnica
  (`POST .../proposal/technical/generate`, `TechnicalProposalBuilder`,
  persiste `licitaciones.proposal_section`) y ve el resumen (secciones
  generadas, bloqueos, requisitos marcados "no aplica"), y mapea/edita cada
  `topicKey` a su dato de empresa (`PUT .../requirement-mappings/:topicKey`,
  DECISION_ROLES — más estricto que `WRITE_ROLES`: decisión editorial/de
  riesgo sobre qué se afirma ante un ente público). Gating cosmético por rol
  (`WRITE_ROLES`/`DECISION_ROLES` según la acción); el servidor
  (`assertVerticalRole` en `technicalProposal.ts`) es siempre la barrera
  real. El backend no expone todavía `GET .../requirement-mappings` — la
  pantalla no puede precargar un mapeo guardado en una sesión anterior, solo
  confirma el que el usuario acaba de enviar en la sesión actual.
- `lib/technical-proposal-client.ts` — `fetchOrCreateProposal`
  (`GET .../proposal`, `proposalEconomic.ts`, lazy-crea el `ProposalRecord`
  — prerrequisito compartido de la generación técnica Y económica, ver Fase
  13), `generateTechnicalProposal`, `upsertRequirementMapping`.

**Fuera de esta pieza, a propósito:** la propuesta ECONÓMICA
(`proposalEconomic.ts::POST .../economic/generate`), el checklist ejecutable,
aprobaciones y el ZIP de cierre seguían sin pantalla — ver Fase 13 abajo y
"Explícitamente fuera de esta fase" más adelante.

## Fase 13 — propuesta económica (gap ALTA: "siguiente paso natural tras la propuesta técnica")

- `pages/PropuestaTecnica.tsx` — sección nueva "Propuesta económica": el
  staff captura a mano una lista de `{concepto, cantidad}` y genera el
  cálculo (`POST .../proposal/economic/generate`, `EconomicProposalBuilder`)
  sobre las tarifas APROBADAS y vigentes a la fecha del acto
  (`resolveExpedienteAsOfIso`). Regla dura del dominio (REQ-LIC-006/A8),
  reflejada tal cual en la UI: un solo concepto sin tarifa resoluble bloquea
  el TOTAL COMPLETO (se listan los conceptos bloqueados con su detalle,
  nunca un total parcial silencioso). Gating cosmético por `WRITE_ROLES`
  (mismo set que el resto del panel); el servidor (`assertVerticalRole` en
  `proposalEconomic.ts`) es siempre la barrera real. Sin dependencia de
  orden con la propuesta técnica (Fase 12): son dominios independientes
  (requisitos vs. tarifas de empresa) — la sección económica es visible y
  operable aunque la técnica no se haya generado todavía.
- `lib/technical-proposal-client.ts` — `generateEconomicProposal`
  (`POST .../economic/generate`, con `idempotency-key` nueva por intento —
  mismo criterio que `generateTechnicalProposal`: un reintento manual nunca
  reutiliza la key del intento anterior); reutiliza `fetchOrCreateProposal`
  ya existente (mismo `GET .../proposal` sirve como prerrequisito de ambos
  flujos, no se duplicó).

**Fuera de esta pieza, a propósito:** checklist/aprobaciones ejecutables, el
ZIP de cierre del expediente y todo lo post-adjudicación — alcance de rondas
futuras, ver el punto siguiente.

## Fase 14 — cierre del expediente: checklist ejecutable + aprobaciones + paquete final (gap ALTA: "cierre del flujo central tras propuesta técnica+económica")

- `pages/Cierre.tsx` (ruta
  `/licitaciones/:orgSlug/convocatorias/:tenderId/cierre`, enlazada desde
  `PropuestaTecnica.tsx` y `ConvocatoriaDetalle.tsx`) — cierra el ciclo
  central de la convocatoria antes de la presentación:
  - **Checklist de integridad EJECUTABLE** (`POST .../checklist/run`,
    `checklist.ts`, L1 · Flujo 1): el staff declara metadatos REALES (nunca
    inventados) del paquete que va a subir al portal oficial —
    filename/extensión/tamaño reales de cada `File` elegido vía
    `<input type="file">` (sin subir contenido: el checklist solo valida
    metadatos, no revisa el archivo), páginas opcionales, los límites del
    portal destino (`FormatLimitsConfig`, varían por convocatoria/plataforma,
    por eso se declaran aquí en vez de asumirse), las firmas requeridas
    (`SignatureRequirement[]` — el sistema NUNCA firma ni simula firma, solo
    registra que el staff confirma que ya se firmó fuera del sistema) y qué
    anexos obligatorios ya extraídos (`requirements-client.ts`, filtro
    `requirementKind === "anexo" && obligatoriedad === "obligatorio"`, mismo
    criterio que `listRequiredAnnexes` server-side) están efectivamente
    presentes. `ConvocatoriaDetalle.tsx` sigue mostrando el resumen de solo
    lectura; esta pantalla es la que lo VUELVE A CORRER.
  - **Aprobación del expediente** (`POST .../expediente/approval`,
    DECISION_ROLES — owner/admin/analyst, más estricto que `WRITE_ROLES`):
    el único gate real hacia "listo" (`PackageAssembler` lo deriva, nunca se
    declara desde el cliente). Y **aprobación granular por sección**
    (`POST .../proposal/sections/:sectionKey/approval`, mismas
    DECISION_ROLES) sobre los 6 `sectionKey` que el servidor puede generar
    (`technical:tecnica/legal/administrativa/anexos`,
    `economic:carta/anexo`) — revisión incremental que NO gatea "listo" por
    sí sola (`buildManifest` solo consume aprobaciones de alcance
    "expediente", ver comentario de cabecera de `cierre-client.ts`); sin
    `GET` que liste qué secciones existen realmente para esta convocatoria en
    particular, así que se ofrecen los 6 alcances posibles tal cual el
    servidor los nombra.
  - **Ensamblado y descarga del paquete final** (`POST .../package/assemble`,
    `GET .../package/latest`, `GET .../package/download`): el estado
    "borrador"/"listo" mostrado SIEMPRE es el que el servidor acaba de
    recalcular contra el expediente vivo (AE-14) — un 409 al descargar (el
    último "listo" guardado dejó de serlo) se muestra explícito con los
    motivos, nunca se descarga un ZIP potencialmente obsoleto
    (REQ-LIC-009). La descarga real dispara el `Blob` recibido como archivo
    del navegador (`URL.createObjectURL` + `<a download>` sintético).
- `lib/checklist-client.ts` — `runChecklist` nuevo junto al `fetchChecklist`
  ya existente desde Fase 7 (mismo archivo, mismo contrato de tipos que
  `IntegrityChecklist` en `domain-licitaciones`).
- `lib/cierre-client.ts` (nuevo) — `approveExpediente`,
  `approveProposalSection`, `assemblePackage`, `fetchLatestPackage` (trata un
  404 "nunca se ensambló nada" como `null`, no como error) y
  `downloadPackage` (respuesta binaria — el único cliente HTTP del panel que
  no puede reusar `fetchJson`/`postJson`, arma su propio `withAuthRefresh`
  reexportando `defaultAuthCtx` de `admin-client.ts`).

**Fuera de esta pieza, a propósito** (post-adjudicación, alcance de rondas
futuras): declarar que el expediente YA se presentó ante el portal
(`GET`/`POST .../submission[/declare]`), contratos, cobranza e
inconformidades.

## Explícitamente fuera de esta fase (huecos honestos, no fingidos)

- **Selector de organización con 2+.** `decideLicitacionesLandingPath` ya
  contempla 2+ organizaciones (`/seleccionar-organizacion`), pero esa ruta no
  existe en `App.tsx` para NINGÚN vertical de este monorepo todavía — mismo
  hueco preexistente que citas/restaurantes, no nuevo de esta fase.
