// Fase 9 licitaciones — adaptador de un AGREGADOR COMERCIAL de licitaciones
// ("API por pegar"). No hay proveedor elegido todavía (la cobertura nacional
// amplia de licitaciones mexicanas solo existe vía agregadores de pago, ver
// README de la vertical) -- este archivo define un contrato de ENTRADA
// mínimo y documentado (JSON paginado con los campos que
// `TenderSourceIngestCandidate` necesita) + un mapeador AISLADO
// (`mapAggregatorItem`, puro, fácil de sustituir el día que se elija un
// proveedor real sin tocar el resto del conector: paginación, gateo por
// credenciales, clasificación de bloqueo). Gateado por
// `LICITACIONES_AGGREGATOR_API_KEY`/`LICITACIONES_AGGREGATOR_BASE_URL` (ver
// `apps/api/src/integrations-status.ts`, `.env.example`,
// `docs/CREDENCIALES.md`) -- sin AMBAS, `discover()` lanza
// `SourceNotConfiguredError` (nunca "0 resultados" silencioso, REQ-150).
//
// Mismo criterio de resolución PEREZOSA que `fetch` en
// `compras-mx-historico.ts`: `apiKey`/`baseUrl` se leen de `process.env` EN
// CADA LLAMADA a `discover()` (nunca capturados en la construcción del
// conector, que ocurre una sola vez a nivel de módulo en
// `connector-registry.ts`) -- así, configurar las variables de entorno en
// producción (o inyectarlas explícitamente en una prueba vía `config.apiKey`/
// `config.baseUrl`, que siempre gana sobre el env real) tiene efecto de
// inmediato, sin reiniciar el proceso de construcción del registro.
import type { SourceConnectorId } from "../connector-registry.ts";
import { SourceNotConfiguredError } from "../connector-errors.ts";
import { assertLegitimateJsonBody } from "./response-classifier.ts";
import type { ConnectorContext, DiscoverParams, DroppedRowInfo, LicitacionesSourceConnector, TenderSourceIngestCandidate } from "./types.ts";

export const AGGREGATOR_ID: SourceConnectorId = "aggregator";

const USER_AGENT = "AtiendeAgenciaAI-LicitacionesConnector/1.0 (+https://github.com/javiercamarapp/Atiende-Agencia-AI)";
const DEFAULT_MAX_PAGES = 20;

/**
 * Contrato de ENTRADA mínimo esperado del proveedor (documentado, no
 * inventado como "el" contrato real de ningún agregador concreto -- el día
 * que se elija uno, este tipo y `mapAggregatorItem` son el único lugar que
 * cambia). Un ítem sin `externalId`/`title` se descarta vía `reportDropped`,
 * igual que cualquier otro conector.
 */
export interface AggregatorTenderItem {
  readonly externalId?: string | null;
  readonly title?: string | null;
  /** ISO 8601 con offset explícito -- un valor sin offset se descarta (mismo criterio que `map-ocds-release.ts`), nunca se asume una zona. */
  readonly submissionDeadline?: string | null;
  readonly contractingBody?: string | null;
  readonly classifierCodes?: readonly string[] | null;
  readonly budgetAmount?: number | null;
  readonly currency?: string | null;
  readonly state?: string | null;
  readonly procedureType?: string | null;
}

export interface AggregatorPageResponse {
  readonly items?: readonly AggregatorTenderItem[] | null;
  /** Cursor opaco de la página siguiente; `null`/ausente = última página. */
  readonly nextCursor?: string | null;
}

export interface MapAggregatorItemResult {
  readonly candidate: TenderSourceIngestCandidate | null;
  readonly droppedReason: string | null;
}

function isIsoWithOffset(value: string): boolean {
  return /T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value);
}

/** Mapeador AISLADO (REQ del brief: "fácil de sustituir cuando se elija proveedor") -- puro, sin IO. */
export function mapAggregatorItem(item: AggregatorTenderItem): MapAggregatorItemResult {
  const externalId = item.externalId?.trim();
  const title = item.title?.trim();
  if (!externalId || !title) {
    return { candidate: null, droppedReason: !externalId ? "Ítem del agregador sin externalId." : "Ítem del agregador sin title." };
  }

  let submissionDeadline: string | null = null;
  if (item.submissionDeadline) {
    if (!isIsoWithOffset(item.submissionDeadline)) {
      return { candidate: null, droppedReason: `externalId ${externalId}: submissionDeadline ("${item.submissionDeadline}") sin offset de zona explícito.` };
    }
    submissionDeadline = item.submissionDeadline;
  }

  return {
    candidate: {
      externalId,
      title,
      submissionDeadline,
      contractingBody: item.contractingBody?.trim() || null,
      cpvCodes: [...(item.classifierCodes ?? [])],
      budgetAmount: typeof item.budgetAmount === "number" && Number.isFinite(item.budgetAmount) ? item.budgetAmount : null,
      currency: item.currency?.trim() || "MXN",
      state: item.state?.trim() || null,
      procedureTypeRaw: item.procedureType?.trim() || null,
    },
    droppedReason: null,
  };
}

export interface AggregatorConnectorConfig {
  /** Default: `process.env.LICITACIONES_AGGREGATOR_API_KEY`, leído a tiempo de llamada. */
  readonly apiKey?: string;
  /** Default: `process.env.LICITACIONES_AGGREGATOR_BASE_URL`, leído a tiempo de llamada. Se le agrega `/tenders?cursor=...`. */
  readonly baseUrl?: string;
  readonly maxPages?: number;
  readonly fetchImpl?: typeof fetch;
}

export function createAggregatorConnector(config: AggregatorConnectorConfig = {}): LicitacionesSourceConnector {
  const maxPages = config.maxPages ?? DEFAULT_MAX_PAGES;
  const fetchImpl: typeof fetch = config.fetchImpl ?? ((...args) => fetch(...args));

  return {
    id: AGGREGATOR_ID,

    async *discover(params: DiscoverParams, ctx: ConnectorContext): AsyncGenerator<TenderSourceIngestCandidate> {
      const apiKey = config.apiKey ?? process.env.LICITACIONES_AGGREGATOR_API_KEY;
      const baseUrl = config.baseUrl ?? process.env.LICITACIONES_AGGREGATOR_BASE_URL;
      if (!apiKey || !baseUrl) {
        throw new SourceNotConfiguredError(
          "AggregatorConnector: faltan LICITACIONES_AGGREGATOR_API_KEY/LICITACIONES_AGGREGATOR_BASE_URL -- sin proveedor de agregación elegido todavía (ver docs/CREDENCIALES.md). No se intenta ninguna petición sin ambas.",
        );
      }

      let cursor: string | null = null;
      let page = 0;
      let yielded = 0;

      do {
        page += 1;
        if (page > maxPages) return;
        const url = new URL("/tenders", baseUrl);
        if (cursor) url.searchParams.set("cursor", cursor);

        const response = await fetchImpl(url.toString(), {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json", Authorization: `Bearer ${apiKey}` },
        });
        if (!response.ok) {
          throw new Error(`Agregador de licitaciones respondió ${response.status} en ${url.toString()}.`);
        }
        const text = await response.text();
        assertLegitimateJsonBody(text, { url: url.toString() });

        let parsed: AggregatorPageResponse;
        try {
          parsed = JSON.parse(text) as AggregatorPageResponse;
        } catch {
          throw new Error(`Agregador de licitaciones: cuerpo de ${url.toString()} no es JSON válido.`);
        }

        let index = 0;
        for (const item of parsed.items ?? []) {
          index += 1;
          const { candidate, droppedReason } = mapAggregatorItem(item);
          if (!candidate) {
            const info: DroppedRowInfo = { index, reason: droppedReason ?? "Ítem del agregador descartado." };
            ctx.logger?.warn(`Agregador de licitaciones: ítem descartado -- ${info.reason}`, { source: AGGREGATOR_ID, page });
            ctx.reportDropped?.(info);
            continue;
          }
          if (params.limit !== undefined && yielded >= params.limit) return;
          yield candidate;
          yielded += 1;
        }

        cursor = parsed.nextCursor ?? null;
      } while (cursor);
    },

    async fetchDetail(externalId: string): Promise<never> {
      throw new Error(`AggregatorConnector.fetchDetail("${externalId}") no está implementado: sin proveedor elegido todavía, no hay un contrato de detalle por expediente que portar.`);
    },
  };
}
