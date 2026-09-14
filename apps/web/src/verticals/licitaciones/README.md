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

## Explícitamente fuera de esta fase (huecos honestos, no fingidos)

- **`POST .../checklist/run` no tiene UI.** Exige `FileArtifact[]` reales
  (nombre/extensión/tamaño/páginas de los documentos YA SUBIDOS al
  expediente), `FormatLimitsConfig`, `SignatureRequirement[]` y
  `presentAnnexRefs` — este panel no construye ninguna pantalla de carga de
  documentos todavía (tampoco existe en ningún vertical un pipeline de
  extracción de texto de PDF, ver el README de `apps/api/.../licitaciones`).
  `ConvocatoriaDetalle.tsx` SÍ muestra, de solo lectura, el último resultado
  ya corrido (por el agente o por una corrida previa vía API) — mostrar un
  dato real sin poder generarlo desde aquí es honesto; fingir un botón
  "ejecutar" que no tiene datos reales que mandar no lo sería.
- **Propuesta técnica/económica y cierre del expediente** (Flujos 2/3,
  `proposalEconomic.ts`/`technicalProposal.ts`/`cierre.ts`) — sin pantalla
  todavía. Es la porción más grande de trabajo restante del panel completo
  (requisitos extraídos, secciones de propuesta, aprobaciones, ensamblado del
  paquete ZIP, contratos/cobranza/inconformidades/autopsia/renovación de Fase
  6) — trabajo genuino de varias fases más, no construido aquí. El perfil de
  matching (antes en esta lista) ya tiene pantalla real desde Fase 8, ver
  arriba. Esta fase deliberadamente completó el tramo
  MÁS IMPORTANTE (convocatorias + matching + go/no-go, el punto de entrada de
  todo el flujo) de forma honesta y con datos reales de punta a punta, en vez
  de dejar 5 pantallas a medias.
- **Selector de organización con 2+.** `decideLicitacionesLandingPath` ya
  contempla 2+ organizaciones (`/seleccionar-organizacion`), pero esa ruta no
  existe en `App.tsx` para NINGÚN vertical de este monorepo todavía — mismo
  hueco preexistente que citas/restaurantes, no nuevo de esta fase.
