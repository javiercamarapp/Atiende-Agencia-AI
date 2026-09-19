// Fase 9 licitaciones — primer conector OCDS REAL de una fuente EN VIVO
// (a diferencia de `compras-mx-historico.ts`, un dataset histórico). Contrato
// real descubierto con peticiones GET reales contra
// `https://api-ocds.nl.gob.mx` (2026-09-19, ver evidencia completa en
// `connector-registry.ts`):
//
//   - `GET /api/releases?page=N` -- ÚNICO endpoint real (la raíz `/` y
//     `/api/v1/*`/`/releases`/`/record_package`/`/release_package` devuelven
//     404 o una página HTML de bienvenida, verificado con GETs reales). Responde
//     `200` con JSON, forma `{current_page, data: [...], last_page, per_page,
//     total, ...}` (paginación Laravel estándar).
//   - `per_page` está FIJO en 10 (un `?per_page=2` real no lo cambió, verificado) --
//     no hay parámro de tamaño de página configurable.
//   - `data[i]` NO es un release individual: es `{numberPublication, releases:
//     OcdsRelease[]}` -- un LOTE de publicación que agrupa el historial
//     COMPLETO de releases (incrementales, tag `planning`/`tender`/`award`/...)
//     tocados en esa publicación, observado con hasta 1190 releases en un
//     solo grupo en una corrida real. Total real observado: 88 grupos / 9
//     páginas el 2026-09-19.
//   - Sin filtro server-side por estado/fecha (`?status=active` real no tuvo
//     efecto, verificado) -- el filtro de "vigente" se aplica del lado del
//     cliente (`isVigenteTender`, `map-ocds-release.ts`).
//   - Sin `record_package`/`compiledRelease` -- son releases SUELTOS; el
//     mismo `ocid` reaparece muchas veces a través del historial (evidencia
//     real: 156/1585 ocids únicos con >1 release en la página 1). Este
//     conector reduce por `ocid` tomando el release con `date` MÁS RECIENTE
//     ANTES de mapear -- es la única forma honesta de saber "el estado actual
//     conocido" sin un `record_package` ya compilado por la fuente.
//   - `classification` de cada `tender.items[]` NO trae `id`/`scheme` (solo
//     `description`, texto libre) -- el código real (numérico, tipo partida
//     CUCoP) vive en `additionalClassifications[].id` (ver decisión CPV/CUCOP
//     documentada en `map-ocds-release.ts`).
//   - Evidencia de vigencia real: de 615 releases reales con
//     `tender.status === "active"` verificados en dos páginas reales, NINGUNO
//     traía `tenderPeriod` -- confirma que `isVigenteTender` no puede exigir
//     AMBOS campos (ver su comentario).
import type { SourceConnectorId } from "../../connector-registry.ts";
import { RateLimitedError } from "../../connector-errors.ts";
import { assertLegitimateJsonBody } from "../response-classifier.ts";
import type { ConnectorContext, DiscoverParams, LicitacionesSourceConnector, TenderSourceIngestCandidate } from "../types.ts";
import { isDroppedResult, isVigenteTender, mapOcdsReleaseToCandidate } from "./map-ocds-release.ts";
import type { OcdsRelease } from "./types.ts";

export const NL_OCDS_ID: SourceConnectorId = "nl_ocds";

const DEFAULT_BASE_URL = "https://api-ocds.nl.gob.mx/api/releases";
const DEFAULT_STATE = "Nuevo León";
/**
 * Cada página real trae ~10 MB / hasta ~1800 releases (ver evidencia arriba)
 * -- 9 páginas reales existen hoy. Un tope de 3 páginas por corrida cubre las
 * publicaciones más recientes (donde vive todo lo realmente vigente, dado que
 * `numberPublication` más alto = más reciente) sin descargar ~90 MB en cada
 * corrida programada (misma filosofía que el tope de `params.limit` de
 * `compras-mx-historico.ts` frente a su CSV de ~950 MB) -- gap declarado:
 * una convocatoria vigente cuya ÚNICA mención cayera en una publicación más
 * antigua que las 3 más recientes no se vería hasta que ese lote alcance las
 * primeras 3 posiciones o hasta subir `maxPages` explícitamente.
 */
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_TIMEOUT_MS = 20_000;
/** Identificable, con URL real del repositorio (REQ del brief: "User-Agent identificable, respeto a la fuente"). */
const USER_AGENT = "AtiendeAgenciaAI-LicitacionesConnector/1.0 (+https://github.com/javiercamarapp/Atiende-Agencia-AI)";

interface NlReleasesPage {
  readonly data?: readonly { readonly numberPublication?: number; readonly releases?: readonly OcdsRelease[] }[];
  readonly last_page?: number;
}

export interface NlOcdsConnectorConfig {
  /** URL base SIN `?page=` (se le agrega). Default: el endpoint real verificado. */
  readonly baseUrl?: string;
  /** Tope de páginas a leer por corrida -- default `DEFAULT_MAX_PAGES`. */
  readonly maxPages?: number;
  readonly timeoutMs?: number;
  /** Inyectable para pruebas -- mismo patrón que `compras-mx-historico.ts`, resuelto a tiempo de LLAMADA (no de construcción). */
  readonly fetchImpl?: typeof fetch;
}

export function createNlOcdsConnector(config: NlOcdsConnectorConfig = {}): LicitacionesSourceConnector {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const maxPages = config.maxPages ?? DEFAULT_MAX_PAGES;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl: typeof fetch = config.fetchImpl ?? ((...args) => fetch(...args));

  return {
    id: NL_OCDS_ID,

    async *discover(params: DiscoverParams, ctx: ConnectorContext): AsyncGenerator<TenderSourceIngestCandidate> {
      const now = (ctx.now ?? (() => new Date()))();
      // Reduce por ocid -> release más reciente (por `date`) visto en las páginas leídas esta corrida (ver comentario de cabecera: la fuente no compila un estado único por ocid).
      const latestByOcid = new Map<string, OcdsRelease>();

      let page = 1;
      let lastPage = maxPages;
      while (page <= Math.min(maxPages, lastPage)) {
        const url = `${baseUrl}?page=${page}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
          response = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: controller.signal });
        } finally {
          clearTimeout(timeout);
        }

        if (response.status === 429) {
          // Respeto a la fuente (ver RateLimitedError): se detiene la corrida entera de inmediato, nunca reintenta agresivamente en el mismo proceso.
          throw new RateLimitedError(`API OCDS de Nuevo León respondió 429 (Too Many Requests) en ${url} -- corrida detenida, el backoff real ocurre en la próxima corrida programada.`);
        }
        if (!response.ok) {
          throw new Error(`API OCDS de Nuevo León respondió ${response.status} en ${url}.`);
        }

        const text = await response.text();
        // SR-14: un 200 con cuerpo de bloqueo (HTML) no se interpreta como "0 releases".
        assertLegitimateJsonBody(text, { url });

        let parsed: NlReleasesPage;
        try {
          parsed = JSON.parse(text) as NlReleasesPage;
        } catch {
          throw new Error(`API OCDS de Nuevo León: cuerpo de ${url} no es JSON válido (posible cambio de formato de la API).`);
        }

        for (const group of parsed.data ?? []) {
          for (const release of group.releases ?? []) {
            if (!release?.ocid) continue;
            const existing = latestByOcid.get(release.ocid);
            if (!existing || (release.date ?? "") > (existing.date ?? "")) {
              latestByOcid.set(release.ocid, release);
            }
          }
        }

        lastPage = parsed.last_page ?? page;
        page += 1;
      }

      let yielded = 0;
      let index = 0;
      for (const release of latestByOcid.values()) {
        index += 1;
        // Filtro de vigencia (decisión de negocio, no un problema de calidad de dato): no se reporta como `reportDropped` -- un release histórico/cerrado real no es una "fila mal formada", es una fila fuera del alcance declarado de este conector (mismo criterio que `compras-mx-historico.ts` nunca reporta "descartado" un contrato ya concluido; aquí es al revés, pero el principio es el mismo: alcance != calidad).
        if (!isVigenteTender(release.tender, now)) continue;

        const result = mapOcdsReleaseToCandidate(release, { fixedState: DEFAULT_STATE });
        if (isDroppedResult(result)) {
          ctx.logger?.warn(`API OCDS de Nuevo León: release descartado -- ${result.droppedReason}`, { source: NL_OCDS_ID, index });
          ctx.reportDropped?.({ index, reason: result.droppedReason });
          continue;
        }
        if (params.limit !== undefined && yielded >= params.limit) return;
        yield result.candidate;
        yielded += 1;
      }
    },

    async fetchDetail(externalId: string): Promise<never> {
      throw new Error(`NlOcdsConnector.fetchDetail("${externalId}") no está implementado: la API real de Nuevo León no documenta un endpoint de detalle por ocid separado de \`/api/releases\` (mismo límite que \`compras-mx-historico.ts\`).`);
    },
  };
}
