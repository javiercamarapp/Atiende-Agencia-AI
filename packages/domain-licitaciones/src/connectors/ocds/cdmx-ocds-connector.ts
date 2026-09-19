// Fase 9 licitaciones — conector real de CDMX. DESVIACIÓN DELIBERADA
// respecto de la premisa inicial del brief ("CDMX Tianguis Digital ofrece
// descargas OCDS CSV/XLS/JSON por año/trimestre") — documentada porque el
// brief pide EXPLÍCITAMENTE verificar con peticiones reales antes de
// escribir el cliente, y verificarlo cambió la conclusión:
//
//   1. El portal `https://datosabiertostianguisdigital.cdmx.gob.mx/
//      contrataciones-abiertas` SÍ existe y SÍ muestra un dashboard con
//      cifras 2026 recientes -- pero es una app Laravel+Livewire v2 (no una
//      API pública): los botones "Descargar" (`wire:click.prevent=
//      "DescargarJSON"/"DescargarCSV"/"DescargarXLSX"`, verificado leyendo el
//      HTML real) disparan una acción de servidor gateada por sesión/CSRF
//      (`POST /livewire/message/open-hiring-component`), sin URL pública
//      estable. Intentos reales (2026-09-19): (a) un GET normal a la página
//      + reproducir esa llamada POST con el fingerprint/serverMemo/CSRF
//      reales extraídos del HTML devolvió `500 Server Error`; (b) el estado
//      por defecto del componente (sin año/trimestre seleccionados) renderiza
//      la tabla VACÍA (`<tbody></tbody>`); (c) un `syncInput` real para fijar
//      `anio_title`/`trim` respondió `200` pero NO cambió el estado del
//      componente (esos nombres de propiedad no son los reales o requieren
//      una cadena de interacción de UI más larga). Automatizar esto de forma
//      confiable exigiría simular la secuencia completa de clics de un
//      humano contra un endpoint interno no documentado y propenso a romperse
//      en cualquier deploy del front -- lo opuesto de "respeto a la fuente"
//      (spam de peticiones especulativas contra un servidor .gob.mx sin
//      contrato estable), así que se descarta como base de este conector.
//   2. El mismo dataset (mismo texto de la ficha: "vinculado a Tianguis
//      Digital") SÍ está publicado en el portal CKAN de datos abiertos de la
//      Ciudad de México (`datos.cdmx.gob.mx`, licencia CC-BY-4.0-ESP) como
//      recurso `concursos-compras-publicas` -- un CSV real, plano (NO
//      OCDS-shaped), con URL ESTABLE, verificado con un GET real:
//      `https://datos.cdmx.gob.mx/dataset/a16471a6-2a7d-4c7d-996e-d804f8ad3772/
//      resource/e20d341a-5558-4a84-be33-31aee566ccbd/download/
//      e20d341a-5558-4a84-be33-31aee566ccbd.csv` -- `200 OK`, 13 764 578
//      bytes, 6917 filas reales, encabezado documentado en
//      `map-cdmx-csv-row.ts::CDMX_CSV_HEADER`. Este conector usa ESTE
//      endpoint -- mismo patrón de infraestructura que
//      `compras-mx-historico.ts` (CSV streaming vía `csv.ts`, detección de
//      bloqueo vía `response-classifier.ts`), no el parser OCDS genérico
//      (`../map-ocds-release.ts`, que sí usa `nl-ocds-connector.ts`).
//
// GAP REAL DESCUBIERTO (declarado, no oculto -- ver también
// `connector-registry.ts` para el `liveVerification` completo): el CSV real
// del punto 2 está ESTANCADO -- la fila con `post_date` más reciente
// verificada es `2023-11-29` (metadata del catálogo dice "modificado
// 2026-08-28", pero eso describe un refresco de METADATOS, no de CONTENIDO:
// el archivo completo se descargó y se revisó fila por fila el 2026-09-19,
// distribución por año 2019-2023, CERO filas 2024/2025/2026). Este conector
// SÍ funciona (petición real, parseo real, filtro de vigencia real), pero
// hoy no puede producir ninguna convocatoria vigente porque la fuente misma
// no publica ninguna reciente en este recurso -- por eso se registra
// `verified: false` en `connector-registry.ts` pese a que el endpoint
// responde `200` con datos reales y bien formados.
import type { SourceConnectorId } from "../../connector-registry.ts";
import { streamCsvRows } from "../csv.ts";
import { assertLegitimateCsvBody } from "../response-classifier.ts";
import type { ConnectorContext, DiscoverParams, DroppedRowInfo, LicitacionesSourceConnector, TenderSourceIngestCandidate } from "../types.ts";
import { mapCdmxCsvRow, rowRejectionReason } from "./map-cdmx-csv-row.ts";

export const CDMX_OCDS_ID: SourceConnectorId = "cdmx_ocds";

const DEFAULT_CSV_URL =
  "https://datos.cdmx.gob.mx/dataset/a16471a6-2a7d-4c7d-996e-d804f8ad3772/resource/e20d341a-5558-4a84-be33-31aee566ccbd/download/e20d341a-5558-4a84-be33-31aee566ccbd.csv";
const DEFAULT_STATE = "Ciudad de México";
const USER_AGENT = "AtiendeAgenciaAI-LicitacionesConnector/1.0 (+https://github.com/javiercamarapp/Atiende-Agencia-AI)";

export interface CdmxOcdsConnectorConfig {
  readonly csvUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

async function* iterateResponseBodyBytes(response: Response): AsyncGenerator<Uint8Array> {
  if (response.body) {
    yield* response.body as unknown as AsyncIterable<Uint8Array>;
    return;
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > 0) yield new Uint8Array(buffer);
}

async function* decodeUtf8Stream(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for await (const chunk of chunks) {
    const text = decoder.decode(chunk, { stream: true });
    if (text.length > 0) yield text;
  }
  const tail = decoder.decode();
  if (tail.length > 0) yield tail;
}

export function createCdmxOcdsConnector(config: CdmxOcdsConnectorConfig = {}): LicitacionesSourceConnector {
  const csvUrl = config.csvUrl ?? DEFAULT_CSV_URL;
  const fetchImpl: typeof fetch = config.fetchImpl ?? ((...args) => fetch(...args));

  return {
    id: CDMX_OCDS_ID,

    async *discover(params: DiscoverParams, ctx: ConnectorContext): AsyncGenerator<TenderSourceIngestCandidate> {
      const now = (ctx.now ?? (() => new Date()))();
      const response = await fetchImpl(csvUrl, { headers: { "User-Agent": USER_AGENT } });
      if (!response.ok) {
        throw new Error(`CSV de convocatorias CDMX respondió ${response.status} en ${csvUrl}.`);
      }

      const decodedChunks = decodeUtf8Stream(iterateResponseBodyBytes(response));
      let checkedFirstChunk = false;
      const validatedChunks = (async function* (): AsyncGenerator<string> {
        for await (const textChunk of decodedChunks) {
          if (!checkedFirstChunk) {
            checkedFirstChunk = true;
            assertLegitimateCsvBody(textChunk, { url: csvUrl }); // SR-14: cuerpo de bloqueo no se confunde con "0 registros".
          }
          yield textChunk;
        }
        if (!checkedFirstChunk) assertLegitimateCsvBody("", { url: csvUrl });
      })();

      let yielded = 0;
      try {
        for await (const event of streamCsvRows(validatedChunks)) {
          if (event.kind === "error") {
            const info: DroppedRowInfo = { index: event.error.row - 1, reason: event.error.message };
            ctx.logger?.warn(`CSV de convocatorias CDMX: fila ${event.error.row} descartada -- ${event.error.message}`, { source: CDMX_OCDS_ID, row: event.error.row });
            ctx.reportDropped?.(info);
            continue;
          }
          const candidate = mapCdmxCsvRow(event.data.values, { fixedState: DEFAULT_STATE });
          if (!candidate) {
            const reason = rowRejectionReason(event.data.values);
            ctx.logger?.warn(`CSV de convocatorias CDMX: fila ${event.data.row} descartada -- ${reason}`, { source: CDMX_OCDS_ID, row: event.data.row });
            ctx.reportDropped?.({ index: event.data.row - 1, reason });
            continue;
          }
          // Filtro de vigencia: solo convocatorias con plazo de propuestas REAL y futuro -- ver `map-cdmx-csv-row.ts` para por qué `submissionDeadline` puede venir `null` (dataset sin ese dato en la fila) y el comentario de cabecera de este archivo para por qué, en la práctica, el recurso real verificado no produce ninguna (dataset estancado en 2023).
          if (candidate.submissionDeadline === null) continue;
          if (new Date(candidate.submissionDeadline).getTime() <= now.getTime()) continue;

          if (params.limit !== undefined && yielded >= params.limit) return;
          yield candidate;
          yielded += 1;
        }
      } finally {
        const body = response.body as (ReadableStream<Uint8Array> & { cancel?: (reason?: unknown) => Promise<void> }) | null;
        await body?.cancel?.().catch(() => {});
      }
    },

    async fetchDetail(externalId: string): Promise<never> {
      throw new Error(`CdmxOcdsConnector.fetchDetail("${externalId}") no está implementado: el recurso CSV real no expone un endpoint de detalle por expediente individual (mismo límite que \`compras-mx-historico.ts\`).`);
    },
  };
}
