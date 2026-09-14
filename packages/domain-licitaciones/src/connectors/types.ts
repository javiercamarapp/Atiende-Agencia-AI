// Fase 8 — tipos compartidos de un conector de ingesta AUTOMÁTICA real (a
// diferencia de `connector-registry.ts`, que declara únicamente la
// IDENTIDAD/cadencia/verificación de cada fuente, ver su comentario de
// cabecera: "Deliberadamente SIN discover()/fetchDetail()... el día que
// exista una implementación real, su función de ingesta se añade a este
// mismo descriptor"). Este archivo es esa pieza que faltaba — puerto
// ADAPTADO (no literal) de `licitaciones/packages/sources/src/connectors/
// types.ts` del repo origen, recortado a lo que Fusion necesita hoy: un solo
// conector real (`compras-mx-historico.ts`), sin el resto del transporte
// HTTP genérico del origen (rate limiting, robots.txt, etc. — fuera de
// alcance de esta fase, ver README del vertical para el gap declarado).
import type { SourceConnectorId } from "../connector-registry.ts";

/**
 * Forma MÍNIMA que necesita `LicitacionesRepository.ingestTendersFromSource`
 * para dar de alta/actualizar una convocatoria vía un conector automatizado
 * — subconjunto de `TenderUpsertInput` (repository.ts) sin `actorId` (una
 * ingesta automática no tiene un actor humano detrás, ver comentario de
 * `ingestTendersFromSource`) y sin `externalId` nullable (un conector
 * automatizado SIEMPRE declara una clave natural de dedupe; a diferencia del
 * alta manual, aquí no hay un humano que "sea responsable de no duplicar a
 * mano" si la omite).
 */
export interface TenderSourceIngestCandidate {
  readonly externalId: string;
  readonly title: string;
  /** ISO 8601 con offset explícito, o `null` si esta fuente no expone una fecha límite real (p. ej. un dataset de contratos YA CONCLUIDOS — ver `compras-mx-historico.ts`, nunca se fabrica una fecha que la fuente no declaró). */
  readonly submissionDeadline: string | null;
  readonly contractingBody: string | null;
  readonly cpvCodes: readonly string[];
  readonly budgetAmount: number | null;
  readonly currency: string;
  readonly state: string | null;
  readonly procedureTypeRaw: string | null;
}

/** Fila descartada durante el parseo/mapeo (SR-16/17/21 del origen): nunca desaparece en silencio, se reporta con su motivo. */
export interface DroppedRowInfo {
  readonly index: number;
  readonly reason: string;
}

export interface DiscoverParams {
  /** Tope de registros a producir en ESTA corrida (el conector deja de leer la fuente en cuanto lo alcanza — importante para una fuente de volcado masivo como el CSV histórico, ver `compras-mx-historico.ts`). `undefined` = sin tope (no usado por el worker, que SIEMPRE pasa un límite explícito — ver `apps/worker/src/jobs/licitaciones/discover-tenders.ts`). */
  readonly limit?: number;
}

export interface ConnectorLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface ConnectorContext {
  /** Reloj inyectable para pruebas deterministas — default `() => new Date()`. */
  readonly now?: () => Date;
  readonly logger?: ConnectorLogger;
  /** Reporta una fila descartada sin abortar el resto del lote (SR-16/17/21). */
  readonly reportDropped?: (info: DroppedRowInfo) => void;
}

/**
 * Conector de ingesta automática real. A diferencia de
 * `SourceConnectorDescriptor` (connector-registry.ts, que TODOS los
 * conectores registrados tienen), esta interfaz solo la implementan los
 * conectores que de verdad saben hablar con su fuente — hoy, únicamente
 * `compras-mx-historico.ts`.
 */
export interface LicitacionesSourceConnector {
  readonly id: SourceConnectorId;
  discover(params: DiscoverParams, ctx: ConnectorContext): AsyncGenerator<TenderSourceIngestCandidate>;
  /** Puerto de `fetchDetail` del origen — ver `compras-mx-historico.ts` para por qué este conector en particular nunca lo implementa (dataset de volcado masivo, sin endpoint de detalle por expediente). */
  fetchDetail(externalId: string): Promise<never>;
}
