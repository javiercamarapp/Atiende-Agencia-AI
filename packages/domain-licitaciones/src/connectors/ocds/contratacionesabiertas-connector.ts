// Fase 13 licitaciones — conector GENÉRICO y parametrizable para la plataforma
// "contratacionesabiertas" (tipo Kingfisher): `GET /edca/fiscalYears` +
// `GET /edca/contractingprocess/{year}`, OCDS 1.1 real. Dos instancias reales
// verificadas con peticiones GET reales (2026-09-20, evidencia completa
// también en `connector-registry.ts`):
//
//   1. **Yucatán (INAIP)** — `https://captura.contratacionesabiertas.inaipyucatan.org.mx`.
//      Docs: https://contratacionesabiertas.inaipyucatan.org.mx/contratacionesabiertas/datosabiertos.
//      CAVEAT REAL DE ALCANCE (no exagerar en ningún consumidor de este
//      conector): son ÚNICAMENTE las compras propias del INSTITUTO INAIP
//      (organismo autónomo pequeño, ~5 contratos/año observados en 2025 —
//      arrendamiento de oficina, CFE, leasing, dos expedientes DAJP), NO las
//      licitaciones del gobierno estatal de Yucatán en general. `verified:
//      true` en `connector-registry.ts` describe "esta API responde datos
//      reales", nunca "cobertura completa del estado".
//   2. **Guadalajara (municipio)** — `https://contratacionesabiertas.guadalajara.gob.mx:3000`
//      (puerto 3000 para datos; puerto 4000 para los docs interactivos,
//      `.../contratacionesabiertas/datosabiertos`). DISTINTA de
//      `miradapublica.guadalajara.gob.mx` (el portal ya conocido y estancado
//      de fases previas) — esta es la API real tipo Kingfisher del municipio,
//      2.28 MB / 48 release packages reales verificados para 2025
//      (audiovisuales, despensas, música, licitaciones `LCCC-GDL-XXX`).
//
// Forma real verificada de ambos endpoints (idéntica en las dos instancias —
// por eso UN SOLO conector parametrizado, no dos implementaciones):
//
//   - `GET /edca/fiscalYears` -> `200` con
//     `{"fiscalYears": [{"id", "year", "status": true, "createdAt", "updatedAt"}, ...]}`
//     (verificado real: Yucatán devuelve 2020-2025, Guadalajara SOLO 2025 —
//     un municipio con la plataforma recién adoptada, evidencia real de por
//     qué este conector NUNCA asume qué años existen).
//   - `GET /edca/contractingprocess/{year}` -> `200` con
//     `{"arrayReleasePackage": [OcdsReleasePackage, ...]}` -- una LISTA de
//     release packages OCDS 1.1 completos (cada uno con su propio `releases[]`,
//     `uri`, `version`, `extensions`, `publishedDate`), NO un único paquete
//     con todos los releases juntos. Verificado real: Yucatán/2025 -> 5
//     release packages (tags `contract`/`tender`/`implementation`, todos
//     `tender.status: "complete"` -- ninguno vigente hoy, consistente con el
//     caveat de alcance de arriba); Guadalajara/2025 -> 48 release packages,
//     2 281 921 bytes, tags `planning`/`tender`/`award`/`contract`/
//     `contractAmendment`/`contractUpdate`/`contractTermination` reales.
//   - Un año fiscal NO activado responde `404` con cuerpo JSON real
//     `{"status":404,"message":"No se encontrarón resultados con el
//     parámetro seleccionado."}` (verificado real: `contractingprocess/2026`
//     en AMBAS instancias, 2026-09-20) -- JSON legítimo, no HTML de bloqueo,
//     así que `assertLegitimateJsonBody` no lo confunde con SR-14; este
//     conector lo trata explícitamente como "sin datos ese año todavía"
//     (`ctx.logger?.warn` + se sigue con el resto de años candidatos), NUNCA
//     como error de la fuente ni como "cero convocatorias" silencioso.
//
// Decisión de qué años pedir (REQ del brief: "nunca hardcodear '2025'"): se
// lee `/edca/fiscalYears` primero y se toman los `maxYears` (default 2) años
// más recientes con `status !== false` de esa respuesta real, MÁS el año
// actual por reloj (`ctx.now()`, inyectable en pruebas) que SIEMPRE se
// intenta aunque la fuente todavía no lo haya listado -- ver
// `buildCandidateYears`. Con el reloj real de esta fase (2026-09-20) y la
// evidencia de arriba, esto produce exactamente `[2026, 2025]` para ambas
// instancias: 2026 -> 404 manejado como "sin datos", 2025 -> release
// packages reales. Nunca se pide más de `maxYears` peticiones por corrida
// (tope real documentado, mismo espíritu que `DEFAULT_MAX_PAGES` de
// `nl-ocds-connector.ts` frente a su paginación) -- gap declarado: una
// convocatoria cuya única mención cayera en un año fiscal más antiguo que los
// `maxYears` más recientes no se vería hasta subir ese parámetro.
//
// Reusa EXACTAMENTE los mismos helpers que `nl-ocds-connector.ts`
// (`assertLegitimateJsonBody`, `RateLimitedError`, `mapOcdsReleaseToCandidate`,
// `isVigenteTender`) -- nunca reinventados. La deduplicación por `ocid`
// tomando el release con `date` más reciente (varios releases por `ocid` a
// través de `planning`/`tender`/`award`/.../`contractTermination`, evidencia
// real en Guadalajara/2025) sigue el mismo criterio que `nl-ocds-connector.ts`
// documenta en su cabecera, por la misma razón: la fuente no compila un
// estado único por ocid en este endpoint (son release packages sueltos, sin
// `record_package`/`compiledRelease`).
//
// `fixedState` (una instancia por fuente, mismo patrón que
// `MapOcdsReleaseOptions.fixedState`): Yucatán es una entidad federativa
// -> `"Yucatán"`. Guadalajara es un MUNICIPIO, no una entidad federativa --
// `TenderSourceIngestCandidate.state`/`matching-engine.ts::scoreStates`
// solo modelan "estado" (comparación de texto exacto normalizado contra
// `profile.states`), sin campo de municipio (verificado: ningún tipo del
// dominio lo declara). Evidencia real del propio release package de
// Guadalajara confirma `parties[].address.region: "Jalisco"` -- por eso esta
// instancia se registra con `fixedState: "Jalisco"` (la entidad federativa
// real, para que una empresa con cobertura configurada en "Jalisco" SÍ vea
// estas convocatorias), documentando aquí el costo honesto: se pierde el
// nivel de granularidad municipal (una empresa no puede filtrar "solo
// Guadalajara, no el resto de Jalisco" con el esquema actual) -- gap
// declarado, no oculto.
import type { SourceConnectorId } from "../../connector-registry.ts";
import { RateLimitedError } from "../../connector-errors.ts";
import { assertLegitimateJsonBody } from "../response-classifier.ts";
import type { ConnectorContext, DiscoverParams, LicitacionesSourceConnector, TenderSourceIngestCandidate } from "../types.ts";
import { isDroppedResult, isVigenteTender, mapOcdsReleaseToCandidate } from "./map-ocds-release.ts";
import type { OcdsRelease, OcdsReleasePackage } from "./types.ts";

/** Identificable, con URL real del repositorio (mismo patrón que `nl-ocds-connector.ts`/`cdmx-ocds-connector.ts`). */
const USER_AGENT = "AtiendeAgenciaAI-LicitacionesConnector/1.0 (+https://github.com/javiercamarapp/Atiende-Agencia-AI)";
const DEFAULT_TIMEOUT_MS = 20_000;
/** Tope de años fiscales a leer por corrida -- ver comentario de cabecera para la evidencia real que justifica el default 2 (año actual + el más reciente ya activado). */
const DEFAULT_MAX_YEARS = 2;

interface FiscalYearEntry {
  readonly year?: number | null;
  readonly status?: boolean | null;
}
interface FiscalYearsResponse {
  readonly fiscalYears?: readonly FiscalYearEntry[] | null;
}
interface ContractingProcessResponse {
  readonly arrayReleasePackage?: readonly OcdsReleasePackage[] | null;
}

export interface ContratacionesAbiertasConnectorConfig {
  /** Id único de ESTA instancia (una por estado/municipio) -- ver `connector-registry.ts`. */
  readonly id: SourceConnectorId;
  /** Nombre legible de la fuente, solo para mensajes de error/log (ej. "Yucatán (INAIP)"). */
  readonly sourceLabel: string;
  /** Host base SIN trailing slash y SIN `/edca/...` (se agrega). Ej. `https://captura.contratacionesabiertas.inaipyucatan.org.mx`. */
  readonly baseUrl: string;
  /** `TenderRecord.state` fijo de esta instancia -- ver comentario de cabecera para la decisión Yucatán vs. Jalisco/Guadalajara. `null` si la fuente no tiene un estado fijo conocido. */
  readonly fixedState: string | null;
  /** Tope de años fiscales a leer por corrida -- default `DEFAULT_MAX_YEARS`. */
  readonly maxYears?: number;
  readonly timeoutMs?: number;
  /** Inyectable para pruebas -- mismo patrón que `nl-ocds-connector.ts`, resuelto a tiempo de LLAMADA (no de construcción). */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Años candidatos a pedir esta corrida: SIEMPRE el año actual (reloj real,
 * nunca hardcodeado -- ver comentario de cabecera para por qué un 404 en ese
 * año es un resultado esperado y no un error), más los `maxYears - 1` años
 * más recientes con `status !== false` que la propia fuente declaró en
 * `/edca/fiscalYears` (nunca un año inventado por este código). Ordenado
 * descendente (año más reciente primero).
 */
export function buildCandidateYears(currentYear: number, activeYearsFromApi: readonly number[], maxYears: number): number[] {
  const years = new Set<number>();
  years.add(currentYear);
  const sortedActive = [...new Set(activeYearsFromApi)].sort((a, b) => b - a);
  for (const year of sortedActive) {
    if (years.size >= maxYears) break;
    years.add(year);
  }
  return [...years].sort((a, b) => b - a);
}

export function createContratacionesAbiertasConnector(config: ContratacionesAbiertasConnectorConfig): LicitacionesSourceConnector {
  const { id, sourceLabel, fixedState } = config;
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const maxYears = config.maxYears ?? DEFAULT_MAX_YEARS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl: typeof fetch = config.fetchImpl ?? ((...args) => fetch(...args));

  async function fetchJson(url: string): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: controller.signal });
      const text = await response.text();
      return { status: response.status, text };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    id,

    async *discover(params: DiscoverParams, ctx: ConnectorContext): AsyncGenerator<TenderSourceIngestCandidate> {
      const now = (ctx.now ?? (() => new Date()))();

      // 1) `/edca/fiscalYears` -- QUÉ años pedir (nunca hardcodeado, ver `buildCandidateYears`).
      const fiscalYearsUrl = `${baseUrl}/edca/fiscalYears`;
      const fiscalYearsResp = await fetchJson(fiscalYearsUrl);
      if (fiscalYearsResp.status === 429) {
        throw new RateLimitedError(`API de contrataciones abiertas de ${sourceLabel} respondió 429 (Too Many Requests) en ${fiscalYearsUrl} -- corrida detenida, el backoff real ocurre en la próxima corrida programada.`);
      }
      if (fiscalYearsResp.status !== 200) {
        throw new Error(`API de contrataciones abiertas de ${sourceLabel} respondió ${fiscalYearsResp.status} en ${fiscalYearsUrl}.`);
      }
      assertLegitimateJsonBody(fiscalYearsResp.text, { url: fiscalYearsUrl }); // SR-14.
      let fiscalYearsParsed: FiscalYearsResponse;
      try {
        fiscalYearsParsed = JSON.parse(fiscalYearsResp.text) as FiscalYearsResponse;
      } catch {
        throw new Error(`API de contrataciones abiertas de ${sourceLabel}: cuerpo de ${fiscalYearsUrl} no es JSON válido (posible cambio de formato de la API).`);
      }
      const activeYears = (fiscalYearsParsed.fiscalYears ?? [])
        .filter((fy): fy is FiscalYearEntry & { year: number } => typeof fy?.year === "number" && fy.status !== false)
        .map((fy) => fy.year);
      const candidateYears = buildCandidateYears(now.getUTCFullYear(), activeYears, maxYears);

      // 2) `/edca/contractingprocess/{year}` por cada año candidato.
      const latestByOcid = new Map<string, OcdsRelease>();
      for (const year of candidateYears) {
        const url = `${baseUrl}/edca/contractingprocess/${year}`;
        const resp = await fetchJson(url);

        if (resp.status === 429) {
          throw new RateLimitedError(`API de contrataciones abiertas de ${sourceLabel} respondió 429 (Too Many Requests) en ${url} -- corrida detenida, el backoff real ocurre en la próxima corrida programada.`);
        }
        if (resp.status === 404) {
          // Año fiscal aún no activado por la fuente -- comportamiento NORMAL de esta plataforma (ver cabecera), nunca un error ni una fuente rota.
          ctx.logger?.warn(`API de contrataciones abiertas de ${sourceLabel}: año fiscal ${year} sin datos todavía (404 en ${url}).`, { source: id, year });
          continue;
        }
        if (resp.status !== 200) {
          throw new Error(`API de contrataciones abiertas de ${sourceLabel} respondió ${resp.status} en ${url}.`);
        }
        assertLegitimateJsonBody(resp.text, { url }); // SR-14: un 200 con cuerpo de bloqueo no se interpreta como "0 release packages".

        let parsed: ContractingProcessResponse;
        try {
          parsed = JSON.parse(resp.text) as ContractingProcessResponse;
        } catch {
          throw new Error(`API de contrataciones abiertas de ${sourceLabel}: cuerpo de ${url} no es JSON válido (posible cambio de formato de la API).`);
        }

        for (const pkg of parsed.arrayReleasePackage ?? []) {
          for (const release of pkg?.releases ?? []) {
            if (!release?.ocid) continue;
            // Dedupe por ocid -> release más reciente por `date` (mismo criterio que `nl-ocds-connector.ts`: sin `record_package`/`compiledRelease`, el mismo ocid reaparece a través de `planning`/`tender`/`award`/.../`contractTermination`, evidencia real en Guadalajara/2025).
            const existing = latestByOcid.get(release.ocid);
            if (!existing || (release.date ?? "") > (existing.date ?? "")) {
              latestByOcid.set(release.ocid, release);
            }
          }
        }
      }

      // 3) Filtro de vigencia + mapeo -- idéntico a `nl-ocds-connector.ts` (mismos helpers, sin reinventar).
      let yielded = 0;
      let index = 0;
      for (const release of latestByOcid.values()) {
        index += 1;
        // Igual que `nl-ocds-connector.ts`: alcance != calidad -- un release no vigente no se reporta como `reportDropped`.
        if (!isVigenteTender(release.tender, now)) continue;

        const result = mapOcdsReleaseToCandidate(release, { fixedState });
        if (isDroppedResult(result)) {
          ctx.logger?.warn(`API de contrataciones abiertas de ${sourceLabel}: release descartado -- ${result.droppedReason}`, { source: id, index });
          ctx.reportDropped?.({ index, reason: result.droppedReason });
          continue;
        }
        if (params.limit !== undefined && yielded >= params.limit) return;
        yield result.candidate;
        yielded += 1;
      }
    },

    async fetchDetail(externalId: string): Promise<never> {
      throw new Error(`ContratacionesAbiertasConnector("${id}").fetchDetail("${externalId}") no está implementado: la API real de ${sourceLabel} no documenta un endpoint de detalle por ocid separado de \`/edca/contractingprocess/{year}\` (mismo límite que \`nl-ocds-connector.ts\`).`);
    },
  };
}

// Las dos instancias reales verificadas (ver cabecera del archivo para la
// evidencia completa) -- registradas en `connector-registry.ts` igual que
// `createNlOcdsConnector()`/`createCdmxOcdsConnector()`, sin exponer los
// detalles de host/estado fijo fuera de este módulo.

export const YUCATAN_OCDS_ID: SourceConnectorId = "yucatan_ocds";

export function createYucatanOcdsConnector(overrides: Partial<Omit<ContratacionesAbiertasConnectorConfig, "id" | "sourceLabel" | "baseUrl" | "fixedState">> = {}): LicitacionesSourceConnector {
  return createContratacionesAbiertasConnector({
    id: YUCATAN_OCDS_ID,
    sourceLabel: "Yucatán (INAIP)",
    baseUrl: "https://captura.contratacionesabiertas.inaipyucatan.org.mx",
    // Entidad federativa real (INAIP es un organismo autónomo estatal, sede en Mérida, Yucatán -- ver cabecera del archivo para el caveat de alcance: SOLO las compras propias del instituto).
    fixedState: "Yucatán",
    ...overrides,
  });
}

export const GUADALAJARA_OCDS_ID: SourceConnectorId = "guadalajara_ocds";

export function createGuadalajaraOcdsConnector(overrides: Partial<Omit<ContratacionesAbiertasConnectorConfig, "id" | "sourceLabel" | "baseUrl" | "fixedState">> = {}): LicitacionesSourceConnector {
  return createContratacionesAbiertasConnector({
    id: GUADALAJARA_OCDS_ID,
    sourceLabel: "Guadalajara (municipio)",
    baseUrl: "https://contratacionesabiertas.guadalajara.gob.mx:3000",
    // Municipio, no entidad federativa -- se registra la entidad federativa real (evidencia: `parties[].address.region: "Jalisco"` en los release packages reales) por el límite de esquema documentado en la cabecera del archivo (sin campo de municipio).
    fixedState: "Jalisco",
    ...overrides,
  });
}
