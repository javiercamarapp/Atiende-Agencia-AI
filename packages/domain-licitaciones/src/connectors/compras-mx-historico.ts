// Fase 8 — conector REAL (no un placeholder más) del dataset histórico de
// contratos de CompraNet publicado como CSV abierto en `datos.gob.mx`
// (CKAN/SABG). Puerto ADAPTADO (no literal) de
// `licitaciones/packages/sources/src/connectors/compras-mx/
// compras-mx-historical-csv-connector.ts` + `comprasmx-mapper.ts` del repo
// origen, simplificado a lo que Fusion necesita hoy (ver desviaciones
// deliberadas documentadas abajo) y adaptado a la forma de ingesta de Fusion
// (`TenderSourceIngestCandidate`, ver `connectors/types.ts`) en vez del
// `TenderRecord` propio del origen (que trae muchos más campos de transporte
// que Fusion no modela todavía).
//
// IMPORTANTE — declarado explícitamente como fuente HISTÓRICA, no de
// descubrimiento en vivo (mismo criterio que el origen): es un dataset de
// CONTRATOS YA CONCLUIDOS (2010-2022 en el origen), no de convocatorias
// abiertas. Por eso:
//   - `submissionDeadline` SIEMPRE es `null` -- un contrato ya concluido no
//     tiene una fecha límite de presentación de propuestas real que este
//     dataset exponga (el CSV solo trae fecha de inicio/fin del CONTRATO,
//     que es un concepto distinto). Fabricar una fecha límite a partir de
//     `fecha_fin` sería inventar un dato que la fuente no declaró -- se deja
//     `null` en vez de reinterpretar el campo equivocado.
//   - Se registra con su propio `SourceConnectorId`
//     (`compras_mx_historico`, ver `connector-registry.ts`), distinto de
//     `comprasmx` (el conector de convocatorias EN VIVO, todavía bloqueado
//     por reCAPTCHA) -- para que ningún consumidor confunda un contrato ya
//     concluido con una oportunidad vigente (mismo criterio que el origen).
//
// DESVIACIONES DELIBERADAS respecto del origen (documentadas, no
// silenciadas -- ver instrucciones del proyecto sobre nunca fabricar
// defaults falsos):
//   1. Decodificación: SIEMPRE UTF-8 (`TextDecoder`), sin la detección de
//      charset declarado/BOM/heurística Latin-1/UTF-16 del origen
//      (`util/encoding.ts`, 271 líneas). Justificación: el dataset real
//      (`datos.gob.mx`, portal moderno) publica UTF-8; simplificación
//      documentada, no un dato inventado -- si el portal cambiara de
//      encoding, las filas con tildes mal decodificadas se seguirían
//      procesando (el mapeo no depende de que los acentos sean correctos
//      para extraer `codigo_contrato`/`importe`/fechas), no se perderían en
//      silencio.
//   2. Fechas del CONTRATO (`fecha_inicio`/`fecha_fin`, `ff_fecha_inicio`/
//      `ff_fecha_fin`): el origen SÍ las mapeaba (a `dates.published`/
//      `dates.award` de su `TenderRecord`, mucho más rico). Aquí se
//      DESCARTAN deliberadamente -- `TenderSourceIngestCandidate` no tiene
//      un campo de "fecha de contrato" (solo `submissionDeadline`, que ya
//      se fija en `null` por la razón de arriba) y forzarlas en cualquier
//      otro campo sería inventarles un significado que no tienen. Ninguna
//      fecha del CSV se pierde en silencio: simplemente no hay un campo
//      honesto de Fusion donde mapearlas todavía (gap declarado, no una
//      fabricación).
//   3. Live verification: el origen declaraba este conector
//      `liveVerification.verified: true` (HEAD real 2026-09-05). Esta fase
//      NO copia esa afirmación -- un intento real (HEAD y GET, con y sin
//      User-Agent de navegador) desde ESTE entorno el 2026-09-14 recibió
//      `403 Access Denied` (bloqueo de borde tipo Akamai, ver
//      `tests/fixtures/compras-mx-historico-access-denied.html`, capturado
//      real en ese intento). REQ-150 ("tolerancia cero: ningún conector
//      automatizado se declara verified:true sin evidencia real") exige
//      evidencia PROPIA, no heredar la del origen sin repetir la prueba --
//      se registra `verified: false` con esa evidencia (ver
//      `connector-registry.ts`). El código de este archivo SÍ es una
//      implementación real y completa (no un placeholder): `discover()`
//      hace una petición HTTP real, decodifica en streaming, detecta
//      exactamente este tipo de bloqueo (`response-classifier.ts`) y lo
//      reporta como corrida fallida -- nunca como "0 registros".
//   4. Sin streaming de descarga completo con pausa a mitad de archivo: el
//      origen podía leer un dataset de ~950 MB con memoria acotada
//      indefinidamente. Aquí `discover()` respeta `params.limit` (el worker
//      SIEMPRE pasa uno, ver `apps/worker/src/jobs/licitaciones/
//      discover-tenders.ts`) y CANCELA la lectura del stream HTTP en cuanto
//      lo alcanza (`reader.cancel()`) -- correcto para producción (nunca
//      descarga los 950 MB completos en cada corrida programada), pero sin
//      cursor/offset persistido entre corridas (cada corrida vuelve a leer
//      desde el inicio del archivo) -- gap declarado, pendiente, ver README
//      del vertical.
import type { SourceConnectorId } from "../connector-registry.ts";
import { streamCsvRows } from "./csv.ts";
import { assertLegitimateCsvBody } from "./response-classifier.ts";
import type { ConnectorContext, DiscoverParams, DroppedRowInfo, LicitacionesSourceConnector, TenderSourceIngestCandidate } from "./types.ts";

export const COMPRAS_MX_HISTORICO_ID: SourceConnectorId = "compras_mx_historico";

const DEFAULT_CSV_URL = "https://repodatos.atdt.gob.mx/api_update/sabg/contratos_expedientes_sistema_historico_compranet/compranet_historico.csv";
const DEFAULT_PUBLISHING_ENTITY = "Secretaría Anticorrupción y Buen Gobierno (dataset histórico Compranet, datos.gob.mx)";

export interface ComprasMxHistoricoConnectorConfig {
  /** URL del CSV histórico real (CKAN, `datos.gob.mx`, sin reCAPTCHA/auth documentado). */
  readonly csvUrl?: string;
  /** Nombre a usar como `contractingBody` -- el CSV NO trae columna de dependencia/entidad convocante (limitación del dataset, no de este conector), así que se usa el nombre documentado de la entidad publicadora como mejor aproximación disponible (mismo criterio que el origen). */
  readonly publishingEntity?: string;
  /** Inyectable para pruebas (mismo patrón que `MetaGraphClient.fetchImpl`/proveedores de voice-gateway, ver `packages/whatsapp-gateway/src/providers/meta-graph-client.ts`) -- default `globalThis.fetch` real. */
  readonly fetchImpl?: typeof fetch;
}

function parseAmount(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/[$,]/g, "");
  if (trimmed.length === 0) return null;
  const value = Number.parseFloat(trimmed);
  return Number.isFinite(value) ? value : null;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * Mapea UNA fila ya alineada del CSV histórico a `TenderSourceIngestCandidate`,
 * o `null` si la fila no trae los campos mínimos obligatorios (identificador
 * y título) — el llamador reporta el `null` vía `reportDropped` en vez de
 * descartarlo en silencio (SR-21 del origen).
 */
export function mapComprasMxHistoricoRow(row: Record<string, string>, options: { publishingEntity: string }): TenderSourceIngestCandidate | null {
  const externalId = firstNonEmpty(row.codigo_contrato, row.codigo_expediente);
  const title = firstNonEmpty(row.titulo_contrato);
  if (!externalId || !title) return null;

  return {
    externalId,
    title,
    submissionDeadline: null, // ver desviación deliberada §"IMPORTANTE" arriba -- dataset de contratos YA CONCLUIDOS, sin fecha límite real que exponer.
    contractingBody: options.publishingEntity,
    cpvCodes: [],
    budgetAmount: parseAmount(row.importe),
    currency: firstNonEmpty(row.moneda) ?? "MXN",
    state: null, // el CSV no trae columna de entidad federativa (limitación del dataset).
    procedureTypeRaw: firstNonEmpty(row.tipo_expediente, row.tipo_contratacion) ?? null,
  };
}

function rowRejectionReason(row: Record<string, string>): string {
  const externalId = firstNonEmpty(row.codigo_contrato, row.codigo_expediente);
  if (!externalId) return "Fila sin identificador (codigo_contrato/codigo_expediente ausentes o vacíos).";
  return "Fila sin título (titulo_contrato ausente/vacío).";
}

async function* iterateResponseBodyBytes(response: Response): AsyncGenerator<Uint8Array> {
  if (response.body) {
    yield* response.body as unknown as AsyncIterable<Uint8Array>;
    return;
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > 0) yield new Uint8Array(buffer);
}

/** Decodifica bytes en streaming, SIEMPRE como UTF-8 (ver desviación deliberada #1 en el comentario de cabecera). */
async function* decodeUtf8Stream(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for await (const chunk of chunks) {
    const text = decoder.decode(chunk, { stream: true });
    if (text.length > 0) yield text;
  }
  const tail = decoder.decode();
  if (tail.length > 0) yield tail;
}

export function createComprasMxHistoricoConnector(config: ComprasMxHistoricoConnectorConfig = {}): LicitacionesSourceConnector {
  const csvUrl = config.csvUrl ?? DEFAULT_CSV_URL;
  const publishingEntity = config.publishingEntity ?? DEFAULT_PUBLISHING_ENTITY;
  // Lookup de `fetch` diferido a tiempo de LLAMADA (no capturado aquí en la construcción del conector): el registro
  // único (`connector-registry.ts`) crea este conector UNA sola vez, a nivel de módulo -- si se capturara `fetch`
  // en este punto, `vi.stubGlobal("fetch", ...)` en una prueba (después de que el módulo ya cargó) nunca tomaría
  // efecto. Referenciar el identificador `fetch` DENTRO del cuerpo de la función siempre resuelve el global
  // vigente en ese momento.
  const fetchImpl: typeof fetch = config.fetchImpl ?? ((...args) => fetch(...args));

  return {
    id: COMPRAS_MX_HISTORICO_ID,

    async *discover(params: DiscoverParams, ctx: ConnectorContext): AsyncGenerator<TenderSourceIngestCandidate> {
      const response = await fetchImpl(csvUrl);
      if (!response.ok) {
        throw new Error(`CSV histórico de ComprasMX respondió ${response.status} en ${csvUrl}.`);
      }

      const decodedChunks = decodeUtf8Stream(iterateResponseBodyBytes(response));
      let checkedFirstChunk = false;
      const validatedChunks = (async function* (): AsyncGenerator<string> {
        for await (const textChunk of decodedChunks) {
          if (!checkedFirstChunk) {
            checkedFirstChunk = true;
            // SR-14: un 200 con cuerpo de bloqueo/captcha (o con forma de HTML donde se esperaba CSV) no se interpreta como "0 registros" -- se verifica el primer chunk decodificado.
            assertLegitimateCsvBody(textChunk, { url: csvUrl });
          }
          yield textChunk;
        }
        if (!checkedFirstChunk) {
          assertLegitimateCsvBody("", { url: csvUrl }); // cuerpo vacío: se valida igual, nunca se salta la verificación.
        }
      })();

      let yielded = 0;
      try {
        for await (const event of streamCsvRows(validatedChunks)) {
          if (event.kind === "error") {
            const info: DroppedRowInfo = { index: event.error.row - 1, reason: event.error.message };
            ctx.logger?.warn(`CSV histórico de ComprasMX: fila ${event.error.row} descartada -- ${event.error.message}`, { source: COMPRAS_MX_HISTORICO_ID, row: event.error.row });
            ctx.reportDropped?.(info);
            continue;
          }
          const candidate = mapComprasMxHistoricoRow(event.data.values, { publishingEntity });
          if (!candidate) {
            const reason = rowRejectionReason(event.data.values);
            ctx.logger?.warn(`CSV histórico de ComprasMX: fila ${event.data.row} descartada -- ${reason}`, { source: COMPRAS_MX_HISTORICO_ID, row: event.data.row });
            ctx.reportDropped?.({ index: event.data.row - 1, reason });
            continue;
          }
          if (params.limit !== undefined && yielded >= params.limit) return;
          yield candidate;
          yielded += 1;
        }
      } finally {
        // Nunca deja el stream HTTP corriendo de fondo tras alcanzar `params.limit` o al propagar un error -- importante para un archivo del orden de ~950 MB (ver desviación deliberada #4).
        const body = response.body as (ReadableStream<Uint8Array> & { cancel?: (reason?: unknown) => Promise<void> }) | null;
        await body?.cancel?.().catch(() => {});
      }
    },

    async fetchDetail(externalId: string): Promise<never> {
      throw new Error(
        `ComprasMxHistoricoConnector.fetchDetail("${externalId}") no está implementado: el dataset histórico es un volcado CSV masivo sin endpoint de detalle por contrato/expediente individual (mismo límite documentado que el origen).`,
      );
    },
  };
}
