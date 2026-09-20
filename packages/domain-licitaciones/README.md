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
