// Fase 8 licitaciones — PRIMER job de ingesta automática real de todo el
// vertical (hasta esta fase, `apps/worker/src` no tenía NINGUNA referencia a
// licitaciones -- solo `jobs/hoteles/*`, ver gap identificado por la
// auditoría). Invoca, para una organización, TODOS los conectores del
// registro único que ya traen una implementación real
// (`LICITACIONES_CONNECTOR_REGISTRY.all().filter((d) => d.connector)`) --
// genéricamente, sin comparar ningún `id` a mano (mismo `no-provider-
// branching` que protege `connector-registry.ts`/`source-run.ts`, ver sus
// tests). Hoy eso significa exactamente UN conector
// (`compras_mx_historico`), pero el día que se autorice un segundo, este job
// lo invoca automáticamente sin tocar una sola línea de este archivo.
//
// MISMO patrón de invocación que `jobs/hoteles/night-audit.ts` (leído
// primero como plantilla, ver su comentario de cabecera para la decisión
// completa): apps/worker no corre como proceso propio (sin `setInterval`
// propio) -- este archivo expone solo la lógica de orquestación como
// funciones puras-de-efectos, invocables desde una ruta interna de
// apps/api gateada por `x-atiende-internal-secret`
// (`apps/api/src/routes/verticals/licitaciones/discover.ts`), pensada para
// un cron EXTERNO (Vercel Cron/Supabase Cron) -- y también invocables
// directamente en pruebas unitarias, sin levantar HTTP.
//
// r4-fix-crons-transaccion-por-unidad (corrección de PR #163, bloqueante #2): ANTES,
// tanto `runDiscoverTendersForOrganization` como `runDiscoverTendersSweep` recibían
// un `LicitacionesRepository` YA ligado a una única transacción abierta por la ruta
// para TODO el barrido (todas las organizaciones, TODAS las fuentes de cada una).
// Además del defecto ya conocido de "una organización rara revierte a las demás en
// silencio" (ver `WithHotelesRepo` en `../hoteles/night-audit.ts`), este archivo tenía
// uno PEOR: el `catch` por fuente de abajo llama `repo.recordSourceRun` para dejar
// registrada la corrida FALLIDA -- sobre la MISMA transacción que acaba de fallar
// (p. ej. un error SQL real de `ingestTendersFromSource`), ese INSERT de "corrida
// fallida" también fallaba con 25P02 (transacción abortada) y se tragaba en el
// `catch (recordErr)` interno, dejando la fuente SIN NINGÚN registro de corrida --
// ni éxito ni fallo. Fix: transacción POR fuente (la unidad natural de este loop,
// más granular que por organización porque cada fuente ya hace su propio
// `recordSourceRun`, tanto en el camino ok como en el de error) -- mismo patrón
// `withRepo` ya introducido en `../hoteles/night-audit.ts`/`./alert-notifications.ts`.
import {
  LICITACIONES_CONNECTOR_REGISTRY,
  classifySourceFailure,
  newCorrelationId,
} from "@atiende/domain-licitaciones";
import type {
  ConnectorLogger,
  LicitacionesRepository,
  SourceConnectorId,
  SourceHealthState,
  TenderSourceIngestCandidate,
} from "@atiende/domain-licitaciones";

export type WithLicitacionesRepo = <T>(fn: (repo: LicitacionesRepository) => Promise<T>) => Promise<T>;

/**
 * Tope de registros por (organización, conector, corrida). El dataset
 * histórico de ComprasMX es del orden de ~950 MB documentados por el repo
 * origen -- descargarlo/ingestarlo completo en cada corrida programada no es
 * razonable. Este límite hace que cada corrida SIEMPRE termine en tiempo
 * acotado, a costa de un gap declarado y pendiente: no hay cursor/offset
 * persistido entre corridas, así que cada corrida vuelve a leer desde el
 * inicio del archivo (los registros ya ingeridos se actualizan vía el mismo
 * upsert por `externalId`, nunca se duplican -- pero tampoco se avanza más
 * allá de este límite sin una corrida manual con `options.limit` mayor). Ver
 * `apps/worker/src/jobs/licitaciones/README.md` para el detalle completo.
 */
export const DEFAULT_DISCOVER_TENDERS_LIMIT = 200;

export interface DiscoverTendersSourceResult {
  readonly source: SourceConnectorId;
  readonly state: SourceHealthState;
  readonly discovered: number;
  readonly created: number;
  readonly updated: number;
  readonly droppedRows: number;
  readonly message: string;
  /** `true` cuando la fuente externa no está disponible por causas ajenas (WAF/retirada/TLS/red): queda `down` con su aviso, pero no es un fallo real de la corrida (ver `SourceUnavailableError`). */
  readonly unavailable?: boolean;
}

export interface RunDiscoverTendersOptions {
  /** Tope de registros por conector en esta corrida -- default `DEFAULT_DISCOVER_TENDERS_LIMIT`. */
  readonly limit?: number;
  /** Reloj inyectable para pruebas deterministas -- default `() => new Date()`. */
  readonly now?: () => Date;
  readonly logger?: ConnectorLogger;
}

/**
 * Corre TODOS los conectores con implementación real contra UNA
 * organización. Un fallo en un conector nunca detiene a los demás (mismo
 * criterio que `runNightAuditSweep`/`citasRemindersRoutes`: se captura, se
 * clasifica (`classifySourceFailure`, REQ-148 -- nunca se reporta como "ok"
 * ni como "0 registros" en silencio) y se registra como corrida fallida vía
 * `recordSourceRun`, y el barrido de los demás conectores continúa).
 *
 * r4-fix-crons-transaccion-por-unidad: `withRepo` abre UNA transacción POR fuente --
 * el ingest (camino ok) y el `recordSourceRun` de la rama de error corren SIEMPRE en
 * una transacción fresca, nunca en la que acaba de fallar (ver comentario de cabecera
 * del archivo para el detalle completo: antes, `recordSourceRun` de la rama de error
 * reutilizaba la MISMA sesión recién abortada y también fallaba con 25P02, en
 * silencio).
 */
export async function runDiscoverTendersForOrganization(
  withRepo: WithLicitacionesRepo,
  organizationId: string,
  options: RunDiscoverTendersOptions = {},
): Promise<readonly DiscoverTendersSourceResult[]> {
  const now = options.now ?? (() => new Date());
  const limit = options.limit ?? DEFAULT_DISCOVER_TENDERS_LIMIT;
  const connectors = LICITACIONES_CONNECTOR_REGISTRY.all().filter((descriptor) => descriptor.connector !== undefined);
  const results: DiscoverTendersSourceResult[] = [];

  for (const descriptor of connectors) {
    const startedAt = now().toISOString();
    let droppedCount = 0;
    // L-P3-17: `correlation_id` de la corrida (organizacion + fuente) para el `source_run`. Cada convocatoria NUEVA recibe ademas SU PROPIA correlacion
    // (version, aprobaciones y manifiesto la heredan): compartir una sola entre todas las altas de la corrida mezclaba sus trazas.
    const correlationId = newCorrelationId();

    try {
      const candidates: TenderSourceIngestCandidate[] = [];
      for await (const record of descriptor.connector!.discover(
        { limit },
        { now, logger: options.logger, reportDropped: () => (droppedCount += 1) },
      )) {
        candidates.push(record);
      }

      const { ingest: ingestResult, runNotPersistedReason } = await withRepo(async (repo) => {
        const ingest = await repo.ingestTendersFromSource(organizationId, descriptor.id, candidates);
        // Bitacora (038, sesion de sistema: sin actor). Solo el alta; con la 038 pendiente `appendAuditoria` devuelve false sin abortar la transaccion.
        for (const tender of ingest.tenders) {
          if (!(ingest.createdIds ?? []).includes(tender.id)) continue;
          await repo.appendAuditoria(organizationId, {
            entity: "convocatoria",
            entityId: tender.id,
            action: "convocatoria.ingerida",
            before: null,
            after: { externalId: tender.externalId ?? null, source: descriptor.id, title: tender.title, submissionDeadline: tender.submissionDeadline, runCorrelationId: correlationId },
            actorId: null,
            correlationId: newCorrelationId(),
          });
        }
        const run = await repo.recordSourceRun(organizationId, {
          source: descriptor.id,
          state: "ok",
          startedAt,
          finishedAt: now().toISOString(),
          evidence: {
            message: `Ingesta automática: ${ingest.created} nueva(s), ${ingest.updated} actualizada(s)${droppedCount > 0 ? `, ${droppedCount} fila(s) descartada(s)` : ""}.`,
            coverage: { expected: candidates.length, obtained: ingest.created + ingest.updated },
          },
          correlationId,
        });
        return { ingest, runNotPersistedReason: run.notPersistedReason };
      });
      // a5-fix-licitaciones-source-run-check-yucatan-guadalajara: los tenders YA quedaron
      // persistidos; si la base aún no admite esta fuente en `source_run` (migración 028
      // pendiente), el repositorio degradó con SAVEPOINT en vez de revertirlos. Se hace
      // visible en el resultado del cron y en el log -- nunca en silencio.
      if (runNotPersistedReason !== undefined) {
        options.logger?.warn(`discover-tenders: ${runNotPersistedReason}`, { organizationId, source: descriptor.id });
      }
      results.push({
        source: descriptor.id,
        state: "ok",
        discovered: candidates.length,
        created: ingestResult.created,
        updated: ingestResult.updated,
        droppedRows: droppedCount,
        message: `${ingestResult.created} nueva(s), ${ingestResult.updated} actualizada(s).${runNotPersistedReason !== undefined ? ` [AVISO: ${runNotPersistedReason}]` : ""}`,
      });
    } catch (err) {
      const { state, message, unavailable } = classifySourceFailure(err);
      const finishedAt = now().toISOString();
      // a5-fix-licitaciones-source-run-check-yucatan-guadalajara (defensa en profundidad):
      // `resultMessage` arranca como el mensaje del fallo ORIGINAL (el que ya viaja a
      // `results`/al body de la ruta/al latido vía `CronPartialFailureError`, ver
      // discover.ts). Si además el intento de REGISTRAR esa corrida fallida (abajo)
      // también falla -- el caso real que motivó esta migración, antes de que
      // 028_source_run_check_yucatan_guadalajara.sql extendiera el CHECK para
      // yucatan_ocds/guadalajara_ocds -- ese segundo fallo se anexa aquí en vez de
      // tragarse SOLO en el logger: así, un caso futuro similar (una fuente nueva
      // agregada al registro sin su migración de CHECK) sigue siendo visible en el
      // latido/heartbeat del cron (que ya marca "error" ante cualquier `state !==
      // "ok"`, ver with-heartbeat.ts::CronPartialFailureError) en vez de quedar
      // documentado SOLO en logs de proceso que nadie audita.
      let resultMessage = message;
      try {
        // Transacción NUEVA -- nunca la que acaba de fallar arriba (ver comentario de
        // cabecera del archivo).
        await withRepo((repo) => repo.recordSourceRun(organizationId, { source: descriptor.id, state, startedAt, finishedAt, evidence: { message }, correlationId: null }));
      } catch (recordErr) {
        // Nunca deja que un fallo al REGISTRAR la corrida fallida oculte el fallo original de la fuente.
        const recordErrMessage = recordErr instanceof Error ? recordErr.message : String(recordErr);
        options.logger?.warn(`discover-tenders: no se pudo registrar la corrida fallida de "${descriptor.id}"`, {
          organizationId,
          err: recordErrMessage,
        });
        resultMessage = `${message} [ADEMÁS no se pudo registrar la corrida fallida en source_run: ${recordErrMessage}]`;
      }
      results.push({ source: descriptor.id, state, discovered: 0, created: 0, updated: 0, droppedRows: droppedCount, message: resultMessage, ...(unavailable ? { unavailable: true } : {}) });
    }
  }

  return results;
}

export interface DiscoverTendersSweepResult {
  readonly organizationId: string;
  readonly results: readonly DiscoverTendersSourceResult[];
  readonly error?: string;
}

/**
 * Barrido de TODAS las organizaciones activas del vertical -- invocado por
 * la ruta interna gateada por secreto (mismo patrón EXACTO que
 * `runNightAuditSweep`/`citasRemindersRoutes`: un tenant con datos raros
 * nunca tumba el barrido completo de los demás).
 *
 * r4-fix-crons-transaccion-por-unidad: `listActiveOrganizations()` corre en su propia
 * transacción corta (vía `withRepo`), y cada FUENTE de cada organización corre la
 * suya -- ver `runDiscoverTendersForOrganization` arriba.
 */
export async function runDiscoverTendersSweep(withRepo: WithLicitacionesRepo, options: RunDiscoverTendersOptions = {}): Promise<readonly DiscoverTendersSweepResult[]> {
  const organizations = await withRepo((repo) => repo.listActiveOrganizations());
  const results: DiscoverTendersSweepResult[] = [];
  for (const org of organizations) {
    try {
      results.push({ organizationId: org.id, results: await runDiscoverTendersForOrganization(withRepo, org.id, options) });
    } catch (err) {
      results.push({ organizationId: org.id, results: [], error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
