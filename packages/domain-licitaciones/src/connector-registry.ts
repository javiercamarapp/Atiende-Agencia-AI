// Fase 5 pieza 1 — andamiaje de ingesta (REQ-004/REQ-005/REQ-146..150).
// Fase 8 agrega el primer conector automatizado REAL (`compras_mx_historico`,
// ver import de abajo e `import type` circular documentado en
// `connectors/compras-mx-historico.ts` -- seguro en ESM porque ningún módulo
// de la cadena usa el valor circular a nivel de módulo, solo dentro de
// funciones que se invocan después de que todo el grafo terminó de cargar).
import { createComprasMxHistoricoConnector } from "./connectors/compras-mx-historico.ts";
import { createAggregatorConnector } from "./connectors/aggregator.ts";
import { createCdmxOcdsConnector } from "./connectors/ocds/cdmx-ocds-connector.ts";
import { createNlOcdsConnector } from "./connectors/ocds/nl-ocds-connector.ts";
import type { LicitacionesSourceConnector } from "./connectors/types.ts";
//
// Port ADAPTADO (no literal) de `licitaciones/packages/sources/src/connectors/
// registry.ts` + `connectors/types.ts` + `http/response-classifier.ts` +
// `pipeline/source-health.ts`. El origen construyó un `ConnectorRegistry`
// real contra 5 fuentes (ComprasMX/DOF/OCDS-SHCP/PDN-S6/portales estatales),
// todas bloqueadas por reCAPTCHA/bot-detection (B-02, ver docs/BLOQUEOS.md del
// repo origen) -- nunca resolvió el CAPTCHA, así que TODA su ingesta real
// terminó corriendo sobre fixtures/CSV histórico, nunca contra las fuentes en
// vivo.
//
// Fusion hoy solo tiene un camino de escritura para `licitaciones.tender`:
// alta MANUAL vía `tenders.ts` (`licitacionesTendersRoutes`). Este módulo NO
// reintroduce el intento de resolver B-02 (fuera de alcance, sigue bloqueado)
// -- construye el andamiaje INTERNO que el origen ya diseñó para que, el día
// que un conector real se autorice/verifique, sea "enchufarlo" al registro en
// vez de inventar un mecanismo nuevo desde cero:
//
//  - Registro ÚNICO de conectores (REQ-004): cualquier lugar del código que
//    necesite comportarse distinto por fuente debe consultar este registro,
//    nunca ramificar con `if (sourceId === "...")`. `no-provider-branching`
//    (ver tests/connector-registry.spec.ts) falla si aparece ese patrón fuera
//    de este archivo/`source-run.ts`.
//  - Estados explícitos de salud (REQ-148): nunca se interpreta el silencio
//    de una fuente caída/CAPTCHA/cambio-de-interfaz como "cero
//    oportunidades" -- ver `source-run.ts::classifySourceFailure`.
//  - Cadencia declarada y auditable por fuente (REQ-146): `SourceCadence`
//    documenta el intervalo real medido/recomendado contra cada portal (los
//    mismos valores que `apps/worker/src/scheduler/schedule-config.ts` del
//    origen documentaba, portados tal cual como referencia -- ver `note` de
//    cada descriptor) en vez de una cadencia fija universal.
//  - Verificación puntual documentada (REQ-150, tolerancia cero): ningún
//    conector automatizado se declara `verified: true` sin evidencia real.
//    5 de los 6 conectores automatizados de abajo siguen siendo PLACEHOLDERS
//    deliberados (`SourceNotConfiguredError` si algo intentara invocarlos)
//    -- reservan su lugar en el registro único sin fingir una integración
//    que no existe. El sexto (`compras_mx_historico`, Fase 8) YA es una
//    implementación real (ver `connectors/compras-mx-historico.ts`): hace
//    una petición HTTP real contra el CSV histórico abierto de ComprasMX
//    (`datos.gob.mx`) y parsea el resultado -- pero un intento real desde
//    este entorno (2026-09-14) fue bloqueado (403 Access Denied, evidencia
//    en `tests/fixtures/compras-mx-historico-access-denied.html`), así que
//    también se registra `verified: false` (REQ-150 exige evidencia PROPIA
//    de que la fuente responde, no solo código real). "Real pero no
//    verificado todavía" es un estado válido y distinto de "placeholder sin
//    implementación" -- por eso `SourceConnectorDescriptor.connector` (más
//    abajo) está presente ÚNICAMENTE en este descriptor, ausente en los
//    otros 5.

export const SOURCE_CONNECTOR_IDS = ["manual", "comprasmx", "dof", "ocds_shcp", "pdn_s6", "state_portal", "compras_mx_historico", "nl_ocds", "cdmx_ocds", "aggregator"] as const;
export type SourceConnectorId = (typeof SOURCE_CONNECTOR_IDS)[number];

export function isSourceConnectorId(value: string): value is SourceConnectorId {
  return (SOURCE_CONNECTOR_IDS as readonly string[]).includes(value);
}

/**
 * Estados explícitos de salud de una fuente (REQ-148, port de
 * `SourceHealthState` del origen). El pipeline/repositorio NUNCA debe
 * interpretar el silencio de una fuente caída como "cero oportunidades":
 * cuando `state !== "ok"`, los contadores de la corrida se leen como "no
 * evaluado", nunca como "no hay nada nuevo".
 */
export const SOURCE_HEALTH_STATES = ["ok", "down", "captcha_detected", "interface_changed", "permission_missing", "rate_limited", "not_configured"] as const;
export type SourceHealthState = (typeof SOURCE_HEALTH_STATES)[number];

// Fase 8: `SourceNotConfiguredError`/`CaptchaDetectedError`/`InterfaceChangedError`
// viven ahora en `connector-errors.ts` (sin imports propios, para romper un
// ciclo real con `connectors/compras-mx-historico.ts` -- ver el comentario
// de cabecera de ese archivo para el detalle completo). Se re-exportan aquí
// tal cual para no romper ningún import existente (`source-run.ts`, tests,
// `index.ts`).
export { SourceNotConfiguredError, CaptchaDetectedError, InterfaceChangedError, RateLimitedError } from "./connector-errors.ts";

/** Cadencia declarada de una fuente (REQ-146): nunca una cifra universal, siempre documentada contra el límite real observado/recomendado de ESA fuente. */
export interface SourceCadence {
  /** `0` = sin cadencia automática (a demanda, caso de "manual"). */
  readonly minIntervalMinutes: number;
  readonly note: string;
}

export interface SourceLiveVerification {
  /** `true` únicamente si esta fuente fue probada con una petición real de solo lectura contra el servicio en producción, con evidencia documentada (REQ-150). */
  readonly verified: boolean;
  readonly note: string;
}

export type SourceConnectorKind = "manual" | "automated";

/**
 * Descriptor de un conector registrado. Hasta Fase 8, deliberadamente SIN
 * `discover()`/`fetchDetail()` (a diferencia del origen): Fusion no tenía
 * todavía un worker de ingesta programada (ver `apps/worker`) ni acceso
 * autorizado a ningún portal real -- el registro documentaba solo la
 * IDENTIDAD, cadencia y estado de verificación de cada fuente (lo que
 * REQ-004/146/150 exigen ya).
 *
 * Fase 8 (`compras_mx_historico`) es el momento que este comentario
 * anticipaba: "el día que exista una implementación real, su función de
 * ingesta se añade a este mismo descriptor sin tocar el resto del registro
 * ni ningún llamador". `connector` es ese campo -- OPCIONAL a nivel de tipo
 * (los 5 placeholders restantes no lo traen) y presente únicamente en
 * conectores con una implementación real de `discover()`/`fetchDetail()`
 * (independientemente de si ya están `liveVerification.verified`, ver
 * comentario más arriba). Cualquier llamador (el worker de ingesta,
 * `apps/worker/src/jobs/licitaciones/discover-tenders.ts`) itera
 * `.all().filter((d) => d.connector)` de forma GENÉRICA -- nunca compara
 * `id === "compras_mx_historico"` a mano (eso violaría el mismo
 * `no-provider-branching` que ya protege este archivo, ver
 * `tests/connector-registry.spec.ts`).
 */
export interface SourceConnectorDescriptor {
  readonly id: SourceConnectorId;
  readonly kind: SourceConnectorKind;
  readonly label: string;
  readonly termsNote: string;
  readonly cadence: SourceCadence;
  readonly liveVerification: SourceLiveVerification;
  readonly connector?: LicitacionesSourceConnector;
}

/**
 * Registro único de conectores (REQ-004). Única estructura autorizada a
 * asociar un `SourceConnectorId` con su descriptor -- ningún otro módulo debe
 * comparar `source === "manual"` (o similar) para decidir comportamiento;
 * debe pedirle el descriptor a este registro.
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<SourceConnectorId, SourceConnectorDescriptor>();

  register(descriptor: SourceConnectorDescriptor): this {
    if (this.connectors.has(descriptor.id)) {
      throw new Error(`Ya existe un conector registrado con id "${descriptor.id}".`);
    }
    this.connectors.set(descriptor.id, descriptor);
    return this;
  }

  get(id: SourceConnectorId): SourceConnectorDescriptor | undefined {
    return this.connectors.get(id);
  }

  requireById(id: SourceConnectorId): SourceConnectorDescriptor {
    const descriptor = this.get(id);
    if (!descriptor) throw new Error(`No hay conector registrado para "${id}".`);
    return descriptor;
  }

  all(): SourceConnectorDescriptor[] {
    return [...this.connectors.values()];
  }
}

/**
 * Instancia única del registro de conectores de licitaciones. Cadencias
 * portadas tal cual de `apps/worker/src/scheduler/schedule-config.ts` del
 * repo origen (`DEFAULT_SCHEDULES`) -- mismos valores, misma justificación
 * documentada ahí (límites reales observados de cada portal), aunque aquí
 * ningún conector automatizado esté conectado todavía.
 */
export const LICITACIONES_CONNECTOR_REGISTRY = new ConnectorRegistry()
  .register({
    id: "manual",
    kind: "manual",
    label: "Alta manual",
    termsNote: "Captura directa por el staff de la organización (incluye transcripción manual de un CSV/PDF exportado del portal oficial) -- no automatiza ninguna petición contra un portal externo, así que no hay ToS/robots.txt que observar.",
    cadence: { minIntervalMinutes: 0, note: "A demanda: cada alta/actualización ocurre cuando un usuario la captura, sin cadencia programada." },
    liveVerification: { verified: true, note: "No depende de un portal externo -- verificado por los tests de integración HTTP de tenders.ts (POST real contra la ruta, no una simulación)." },
  })
  .register({
    id: "comprasmx",
    kind: "automated",
    label: "ComprasMX (sucesor de CompraNet)",
    termsNote: "Portal oficial de compras públicas federales; exige reCAPTCHA para consultas automatizadas (bloqueo documentado por el repo origen, nunca resuelto).",
    cadence: { minIntervalMinutes: 30, note: "30 min: no tiene sentido reintentar más seguido contra un endpoint que responde 401/reCAPTCHA de forma consistente." },
    liveVerification: { verified: false, note: "No verificado: sin acceso/permiso autorizado para superar el reCAPTCHA. Placeholder registrado (REQ-150) hasta que se autorice un acceso real -- NUNCA se declara verificado sin esa evidencia." },
  })
  .register({
    id: "dof",
    kind: "automated",
    label: "Diario Oficial de la Federación",
    termsNote: "Publicación oficial de convocatorias vía notas del DOF; formato HTML por nota, sin API estable documentada.",
    cadence: { minIntervalMinutes: 60, note: "60 min: el DOF publica cuando mucho dos ediciones al día (matutina/vespertina), no hay ganancia en consultar más seguido." },
    liveVerification: { verified: false, note: "No verificado en este monorepo: ningún parser real de notas del DOF está implementado todavía." },
  })
  .register({
    id: "ocds_shcp",
    kind: "automated",
    label: "OCDS-SHCP",
    termsNote: "API estándar Open Contracting Data Standard publicada por SHCP.",
    cadence: { minIntervalMinutes: 15, note: "15 min: API OCDS estándar, cadencia moderada apropiada para una API (no un portal con anti-bot)." },
    liveVerification: { verified: false, note: "No verificado: el repo origen documentó este endpoint como inalcanzable en sus intentos; sin verificación puntual propia todavía." },
  })
  .register({
    id: "pdn_s6",
    kind: "automated",
    label: "Plataforma Digital Nacional, sistema 6",
    termsNote: "API OCDS de la Plataforma Digital Nacional; con bot-detection documentado por el repo origen.",
    cadence: { minIntervalMinutes: 15, note: "15 min: misma cadencia que OCDS-SHCP por ser también una API OCDS estándar." },
    liveVerification: { verified: false, note: "No verificado: bot-detection bloqueó los intentos del repo origen; sin acceso autorizado propio todavía." },
  })
  .register({
    id: "state_portal",
    kind: "automated",
    label: "Portales estatales (genérico)",
    termsNote: "Cobertura de portales de compras estatales; sin URL/API única (cada estado publica distinto).",
    cadence: { minIntervalMinutes: 60, note: "60 min: se mantiene registrado con cadencia conservadora para que, en cuanto se identifique una URL real verificable, ya tenga cadencia declarada." },
    liveVerification: { verified: false, note: "No verificado: ningún portal estatal específico tiene todavía una URL/API localizada y confirmada." },
  })
  // Fase 8 — primer conector automatizado con una implementación REAL (ver
  // `connectors/compras-mx-historico.ts` para el detalle completo, incluidas
  // las desviaciones deliberadas respecto del repo origen). Distinto de
  // "comprasmx" (arriba): ese sigue siendo el conector de convocatorias EN
  // VIVO, bloqueado por reCAPTCHA; este es el dataset HISTÓRICO de contratos
  // YA CONCLUIDOS, con su propio SourceId para que ningún consumidor los
  // confunda (mismo criterio que el repo origen).
  .register({
    id: "compras_mx_historico",
    kind: "automated",
    label: "ComprasMX — histórico de contratos (CSV, datos.gob.mx)",
    termsNote: "Dataset abierto CKAN de datos.gob.mx (SABG), documentado por el repo origen como sin reCAPTCHA/auth. Contratos YA CONCLUIDOS (no convocatorias abiertas) -- solo lectura (GET).",
    cadence: {
      minIntervalMinutes: 24 * 60,
      note: "24 h: es un volcado histórico masivo (~950 MB documentados por el repo origen), no una fuente que publique convocatorias nuevas minuto a minuto -- correr más seguido no aporta nada y solo insiste contra un endpoint que hoy bloquea la petición (ver liveVerification).",
    },
    liveVerification: {
      verified: false,
      note:
        "No verificado desde este entorno: intento real (HEAD y GET, con y sin User-Agent de navegador) el 2026-09-14 contra la URL del CSV histórico recibió 403 Access Denied (bloqueo de borde tipo Akamai) en ambos casos -- evidencia real capturada en " +
        "packages/domain-licitaciones/tests/fixtures/compras-mx-historico-access-denied.html. El repo origen documentó `verified: true` con un HEAD real del 2026-09-05, pero REQ-150 exige evidencia PROPIA repetida en este entorno, no heredar la ajena -- " +
        "el conector (`connectors/compras-mx-historico.ts`) SÍ es una implementación real y completa, y su propio `response-classifier.ts` detecta exactamente este tipo de bloqueo y lo reporta como corrida fallida (`state: 'captcha_detected'`), nunca como '0 registros'.",
    },
    connector: createComprasMxHistoricoConnector(),
  })
  // Fase 9 — cobertura de licitaciones VIGENTES (a diferencia de los 403/sin-API
  // de ComprasMX/DOF/OCDS-SHCP/PDN-S6 de arriba, y del histórico ya concluido de
  // `compras_mx_historico`): dos fuentes estatales/CDMX en OCDS, elegidas tras
  // investigar fuentes reales (decisión ya tomada, ver brief de esta fase) por
  // NO requerir evadir ninguna medida anti-bot. Ver README de la vertical para
  // la cobertura honesta (qué SÍ/NO cubren).
  .register({
    id: "nl_ocds",
    kind: "automated",
    label: "Nuevo León — Contrataciones Abiertas (API OCDS)",
    termsNote:
      "API OCDS pública de la Dirección General de Adquisiciones y Servicios de Nuevo León (https://api-ocds.nl.gob.mx, ficha en catalogodatos.nl.gob.mx, licencia CC-BY). Sin reCAPTCHA/auth documentado -- solo lectura (GET).",
    cadence: {
      minIntervalMinutes: 24 * 60,
      note: "24 h: la ficha del dataset declara actualización SEMANAL de la fuente -- un poll diario (alineado al cron diario existente del vertical, ver apps/worker/src/jobs/licitaciones/README.md) ya es más frecuente de lo necesario; no hay ganancia real en consultar más seguido, y así se evita insistir contra la fuente sin motivo.",
    },
    liveVerification: {
      verified: true,
      note:
        "Verificado 2026-09-19 con peticiones GET reales: `GET https://api-ocds.nl.gob.mx/api/releases?page=1` respondió 200 con JSON real (paginación Laravel, 88 grupos de publicación / 9 páginas totales, ~10 MB/página). Se leyeron 2 páginas reales completas (1938 ocids únicos tras deduplicar por release más reciente) -- 333 convocatorias resultaron VIGENTES bajo el criterio de `isVigenteTender` (ver `connectors/ocds/map-ocds-release.ts`), todas por `tender.status === \"active\"` (ninguna de las 2 páginas leídas traía además un `tenderPeriod.endDate` futuro -- gap real documentado: hoy este conector alimenta convocatorias vigentes SIN fecha límite conocida con más frecuencia que CON ella, ver README de la vertical). Endpoints alternativos probados y descartados con evidencia real: `/`, `/api/v1/releases`, `/releases`, `/release_package`, `/record_package` -> 404; `?per_page=`/`?status=` no tuvieron efecto (paginación fija en 10, sin filtro server-side).",
    },
    connector: createNlOcdsConnector(),
  })
  .register({
    id: "cdmx_ocds",
    kind: "automated",
    label: "Ciudad de México — Convocatorias de licitaciones (datos abiertos CDMX)",
    termsNote:
      "Recurso CSV público del portal de datos abiertos de la Ciudad de México (datos.cdmx.gob.mx, dataset `concursos-compras-publicas`, licencia CC-BY-4.0-ESP), mismo dato de origen que Tianguis Digital. Sin reCAPTCHA/auth -- solo lectura (GET). NO es el endpoint OCDS del dashboard de Tianguis Digital (ver desviación deliberada documentada en `connectors/ocds/cdmx-ocds-connector.ts`: ese endpoint es una acción Livewire gateada por sesión, sin contrato público estable, verificado con un intento real que devolvió 500).",
    cadence: {
      minIntervalMinutes: 24 * 60,
      note: "24 h: mismo criterio que nl_ocds (alineado al cron diario existente) -- en la práctica el recurso real verificado no ha cambiado en casi 2 años (ver liveVerification), así que ni siquiera esta cadencia aporta datos nuevos hoy, pero se deja lista para cuando el recurso se vuelva a actualizar.",
    },
    liveVerification: {
      verified: false,
      note:
        "No verificado como fuente ÚTIL de vigentes pese a responder correctamente: `GET` real 2026-09-19 contra la URL del CSV -> 200, 13 764 578 bytes, CSV real y bien formado (46 columnas, encabezado documentado en `connectors/ocds/map-cdmx-csv-row.ts`), 6917 filas parseadas sin error. Pero el archivo está ESTANCADO -- distribución real por año de `post_date`: 2019=1589, 2020=1160, 2021=1085, 2022=1562, 2023=1521, CERO filas 2024/2025/2026 (la fecha más reciente real es 2023-11-29), pese a que el catálogo reporta 'modificado 2026-08-28' (un refresco de metadatos, no de contenido, verificado comparando el contenido descargado). REQ-150: una fuente que responde pero no aporta ningún dato UTILIZABLE para el propósito (convocatorias vigentes) se registra `verified: false` con esta evidencia del fallo, igual que se haría ante un bloqueo -- el conector (`connectors/ocds/cdmx-ocds-connector.ts`) SÍ es una implementación real y completa (streaming, detección de bloqueo SR-14, filtro de vigencia), lista para producir resultados reales en cuanto la fuente publique datos recientes en este recurso.",
    },
    connector: createCdmxOcdsConnector(),
  })
  .register({
    id: "aggregator",
    kind: "automated",
    label: "Agregador comercial de licitaciones (API por pegar)",
    termsNote:
      "Sin proveedor elegido todavía -- la cobertura nacional amplia de licitaciones mexicanas (más allá de las fuentes estatales OCDS de arriba) solo existe hoy vía agregadores comerciales de pago (ver README de la vertical). Este conector define el contrato de entrada mínimo (`connectors/aggregator.ts::AggregatorTenderItem`) y el mapeador aislado, gateado por `LICITACIONES_AGGREGATOR_API_KEY`/`LICITACIONES_AGGREGATOR_BASE_URL` -- sin ambas, lanza `SourceNotConfiguredError` (nunca intenta una petición real sin credenciales).",
    cadence: {
      minIntervalMinutes: 60,
      note: "60 min: cadencia conservadora de resguardo mientras no hay proveedor elegido -- se ajustará al límite real del proveedor que se contrate (mismo criterio que 'state_portal', el otro placeholder con cadencia provisional).",
    },
    liveVerification: {
      verified: false,
      note: "No verificado: sin proveedor elegido, sin credenciales configuradas -- no hay ninguna fuente real contra la cual hacer una petición todavía (REQ-150: nunca se declara verificado sin evidencia real).",
    },
    connector: createAggregatorConnector(),
  });
