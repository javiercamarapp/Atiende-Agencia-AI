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

    try {
      const candidates: TenderSourceIngestCandidate[] = [];
      for await (const record of descriptor.connector!.discover(
        { limit },
        { now, logger: options.logger, reportDropped: () => (droppedCount += 1) },
      )) {
        candidates.push(record);
      }

      const ingestResult = await withRepo(async (repo) => {
        const ingest = await repo.ingestTendersFromSource(organizationId, descriptor.id, candidates);
        await repo.recordSourceRun(organizationId, {
          source: descriptor.id,
          state: "ok",
          startedAt,
          finishedAt: now().toISOString(),
          evidence: {
            message: `Ingesta automática: ${ingest.created} nueva(s), ${ingest.updated} actualizada(s)${droppedCount > 0 ? `, ${droppedCount} fila(s) descartada(s)` : ""}.`,
            coverage: { expected: candidates.length, obtained: ingest.created + ingest.updated },
          },
          correlationId: null,
        });
        return ingest;
      });
      results.push({
        source: descriptor.id,
        state: "ok",
        discovered: candidates.length,
        created: ingestResult.created,
        updated: ingestResult.updated,
        droppedRows: droppedCount,
        message: `${ingestResult.created} nueva(s), ${ingestResult.updated} actualizada(s).`,
      });
    } catch (err) {
      const { state, message } = classifySourceFailure(err);
      const finishedAt = now().toISOString();
      try {
        // Transacción NUEVA -- nunca la que acaba de fallar arriba (ver comentario de
        // cabecera del archivo).
        await withRepo((repo) => repo.recordSourceRun(organizationId, { source: descriptor.id, state, startedAt, finishedAt, evidence: { message }, correlationId: null }));
      } catch (recordErr) {
        // Nunca deja que un fallo al REGISTRAR la corrida fallida oculte el fallo original de la fuente.
        options.logger?.warn(`discover-tenders: no se pudo registrar la corrida fallida de "${descriptor.id}"`, {
          organizationId,
          err: recordErr instanceof Error ? recordErr.message : String(recordErr),
        });
      }
      results.push({ source: descriptor.id, state, discovered: 0, created: 0, updated: 0, droppedRows: droppedCount, message });
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
