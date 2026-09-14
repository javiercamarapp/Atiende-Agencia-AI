# Vertical: licitaciones (api)

Rutas Hono de la vertical licitaciones, portadas de `licitaciones/apps/api/src/routes` — ver `docs/REQUISITOS.md` para el catálogo formal de requisitos (REQ-001..131).

## Fase 6 — seguimiento post-adjudicación (REQ-051..055)

Archivos: `contracts.ts` (REQ-050/051, máquina de estados del contrato + metadatos), `contractDocuments.ts` (REQ-052, extracción determinista del contrato firmado), `contractBilling.ts` (REQ-051, cobranza/facturas), `inconformidad.ts` (REQ-053, redactor de inconformidades), `falloAutopsy.ts` (REQ-054, autopsia del fallo + lecciones aprendidas) y `renewalRadar.ts` (REQ-055, radar de renovaciones). Lógica de dominio en `@atiende/domain-licitaciones` (`contract-lifecycle.ts`, `contract-extraction.ts`, `contract-billing.ts`, `business-days.ts`, `inconformidad.ts`, `fallo-autopsy.ts`, `renewal-radar.ts`).

**Explícitamente fuera de esta fase (huecos honestos, no fingidos):**

- **REQ-056** (calendario oficial de días inhábiles SABG): no construido -- requiere una fuente externa oficial. `business-days.ts` solo excluye sábados/domingos, más feriados que el llamador declare explícitamente (`holidays: string[]`); expuesto en cada respuesta como `calendarNote`/`CALENDAR_LIMITATION_NOTE` para que ningún cliente asuma un calendario oficial completo.
- **OCR/texto-desde-PDF real**: este monorepo NO tiene, en NINGÚN vertical, un pipeline que convierta bytes de un PDF (nativo o escaneado) en texto -- ni para bases de licitación (`requirements/extract`, Fase 2) ni para el contrato firmado (`contract/documents`, Fase 6). Ambas rutas reciben el texto YA EXTRAÍDO por página en el cuerpo del request (`{pages:[{page,text}]}`); construir ese pipeline compartido (Docling/PyMuPDF + OCR por excepción, como en el repo original) es trabajo pendiente genuino, no inventado aquí.
- **Step-up/2FA real**: el repo original protegía las transiciones sensibles del contrato (rescindir/penalizar/marcar en inconformidad/modificar) y "marcar revisado" de una inconformidad con verificación en dos pasos (`lib/step-up.ts`). Este monorepo fusionado no tiene esa infraestructura para ningún vertical todavía -- el equivalente de esta fase es exigir `DECISION_ROLES`/`INCONFORMIDAD_REVIEW_ROLES` (más estrictos que `WRITE_ROLES`) en su lugar, documentado como un control más débil que 2FA real.
- **REQ-054 "ronda 7" del origen** (análisis automatizado de causas de no adjudicación contra la matriz de requisitos, y el enlace automático autopsia→inconformidad vía `sourceAutopsyId`): no portado -- es valor agregado sobre el REQ-054 base (registrar la autopsia + lecciones aprendidas), no el requisito mismo.
- **REQ-055 "convocatorias históricas de la misma entidad"**: el repo original enriquecía cada alerta de renovación con hasta 5 convocatorias previas de la misma `contracting_body` como contexto de apoyo. Esta fase detecta alertas únicamente a partir de `contracts.end_date` propio, sin ese enriquecimiento.
- **Sin cola de trabajos (`jobs`)**: a diferencia del repo original, este monorepo no tiene un sistema de colas genérico para ningún vertical -- las "alertas" de cobranza (facturas vencidas) se calculan en vivo en cada lectura (`GET .../contract/receivables`), y las alertas de renovación se persisten directamente como filas consultables (`GET .../renewals/alerts`), nunca como un job encolado para un worker que no existe.

## Fase 7 — endpoints nuevos para el backoffice web (gap: "el panel casi no existe")

El panel web (`apps/web/src/verticals/licitaciones/`, ver su propio README)
llegaba a Fase 6 con solo una pantalla de login SIN MONTAR en `App.tsx` -- ni
siquiera el login era alcanzable, y todo lo de abajo (checklist/matching/
go-no-go/contratos/...) solo era operable vía API cruda. Esta fase agrega los
endpoints de LECTURA que faltaban para que el panel pudiera existir de verdad,
sin inventar ninguna regla de negocio nueva -- solo exponer lo que
`domain-licitaciones` ya calculaba:

- **`admin.ts`** (archivo nuevo): `GET /v1/licitaciones/:orgSlug/admin/branches`
  -- resuelve propertyId(s) desde el slug de la organización, mismo patrón
  exacto que `GET /v1/citas/:orgSlug/admin/branches`. Requirió agregar
  `findOrganizationBySlug`/`listPropertiesForOrganization` a
  `LicitacionesRepository` (interfaz en `repository.ts`, implementación real
  en `in-memory-repository.ts` y `postgres-repository.ts` -- esta última lee
  directo de `core.organization`/`core.property`, sin tabla propia de
  licitaciones y sin migración SQL nueva, esas tablas del núcleo ya existían
  desde `0001_core_schema.sql`).
- **`tenders.ts`** (2 rutas nuevas, mismo archivo ya existente): `GET
  /licitaciones/:propertyId/tenders` (lista TODAS las convocatorias de la
  organización con su `TenderRecord` completo) y `GET
  /licitaciones/:propertyId/tenders/:tenderId` (detalle de una). Antes de esta
  fase, `GET .../tenders/matching` (Fase 3, matching.ts) era el ÚNICO
  endpoint de lectura de convocatorias y solo trae `MatchResult`
  (score/elegibilidad), sin título ni fecha límite -- insuficiente para
  pintar cualquier lista o ficha real en un panel. El segmento `:tenderId` de
  la ruta de detalle está restringido a forma de UUID
  (`:tenderId{[0-9a-fA-F-]{36}}`) porque, sin esa restricción, esta ruta
  también capturaba `GET .../tenders/matching` tratando "matching" como un
  tenderId literal -- dos sub-apps Hono montadas en "/" resuelven ambigüedades
  de ruta por orden de registro, no por especificidad, en este proyecto.
  Ambas rutas son de solo lectura, sin restricción de rol más allá de
  membership (mismo criterio que matching.ts: ver el listado no es una
  decisión).

Ningún endpoint de escritura nuevo en esta fase. El resto del panel visual
(propuesta técnica/económica, cierre, ejecución del checklist con carga real
de documentos, contratos/cobranza/inconformidades/autopsia/renovación) sigue
sin pantalla -- ver la sección "Explícitamente fuera de esta fase" del README
del lado web.
