// Fase 8 — licitacionesDiscoverRoutes: expone por HTTP el job de ingesta
// automática real (`@atiende/worker::runDiscoverTendersSweep`) y el de
// recordatorios de plazo (`runDeadlineReminderSweep`). Rutas INTERNAS,
// gateadas por secreto compartido (`x-atiende-internal-secret` o
// `Authorization: Bearer`, ver `internalOrCronSecretMatches`, análogo a
// CRON_SECRET), pensadas para ser invocadas por un scheduler externo (Vercel
// Cron/Supabase Cron) — MISMO patrón EXACTO que
// `citasRemindersRoutes`/`hotelesNightAuditRoutes` (leídos primero como
// plantilla): sin `authMiddleware`/`dbSession`, abren su propia sesión de
// sistema (`userId: null`) para todo el barrido.
//
// Fase 12 (cierre del hallazgo ALTA "sin cron configurado") — `vercel.json`
// (raíz del repo) ya declara `crons` reales apuntando a estas 2 rutas. Vercel
// Cron dispara SIEMPRE con GET (no permite headers custom en la config), por
// eso cada ruta se registra con `app.on(["GET", "POST"], ...)`: GET es lo que
// el cron real usa, POST sigue funcionando igual que antes para curl/tests
// manuales — misma lógica, mismo gate de secreto, sin duplicar el handler.
//
// r4-fix-crons-transaccion-por-unidad (corrección de PR #163, bloqueante #2): YA NO
// se abre una única `withAppSession` para todo el barrido en ninguna de las 2 rutas
// -- `runDiscoverTendersSweep`/`runDeadlineReminderSweep` reciben un runner
// (`withRepo`) que abre UNA transacción por fuente/organización (ver su comentario de
// cabecera en @atiende/worker). Mismo patrón EXACTO que
// `../licitaciones/alertNotifications.ts` (leído primero como plantilla) --
// incluido el latido: antes, `ok:false` en el body nunca se reflejaba en el latido
// (`CronPartialFailureError` faltaba en estas 2 rutas, a diferencia de sus hermanas).
import { Hono } from "hono";
import { runDeadlineReminderSweep, runDiscoverTendersSweep, runJuntaQuestionReminderSweep } from "@atiende/worker";
import type { LicitacionesRepository, SalaGuerraRepository } from "@atiende/domain-licitaciones";
import { emitirNotificacion } from "@atiende/db";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { CronPartialFailureError, withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

type SweepResult = Awaited<ReturnType<typeof runDiscoverTendersSweep>>;

async function escalarFuentesNoDisponibles(deps: AppDeps, withRepo: <T>(fn: (repo: LicitacionesRepository) => Promise<T>) => Promise<T>, sweep: SweepResult): Promise<string[]> {
  const escaladas = new Set<string>();
  try {
    for (const orgResult of sweep) {
      const noDisponibles = orgResult.results.filter((r) => r.unavailable);
      if (noDisponibles.length === 0) continue;
      const frescura = await withRepo((repo) => repo.sourceFreshness(orgResult.organizationId));
      for (const r of noDisponibles) {
        if (escaladas.has(r.source) || !frescura.find((f) => f.source === r.source)?.stale) continue;
        escaladas.add(r.source);
        await deps.alertas
          ?.notificar({
            tipo: `licitaciones_fuente_no_disponible:${r.source}`,
            severidad: "alta",
            titulo: `Fuente de licitaciones "${r.source}" no disponible mas alla de su umbral de obsolescencia`,
            detalle: r.message.slice(0, 500),
            href: "/superadmin/salud/licitaciones-fuentes",
            contexto: { fuente: r.source },
          })
          .catch(() => undefined);
        await deps.engine
          .withAppSession({ userId: null }, (db) =>
            emitirNotificacion(db, { evento: "superadmin.cron.fallo", organizationId: null, clave: `licitaciones.discover-tenders.${r.source}:${new Date().toISOString().slice(0, 10)}`.slice(0, 120), parametros: { ruta: `discover-tenders.${r.source}`.slice(0, 40) } }),
          )
          .catch(() => undefined);
      }
    }
  } catch {
    // best-effort
  }
  return [...escaladas];
}

export function licitacionesDiscoverRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/licitaciones/discover-tenders", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/licitaciones/discover-tenders", async () => {
      const withRepo = <T>(fn: (repo: LicitacionesRepository) => Promise<T>) => deps.engine.withAppSession({ userId: null }, (db) => fn(deps.licitacionesRepo(db)));
      const sweep = await runDiscoverTendersSweep(withRepo);
      // Aviso in-app (campana) a analistas: una por organizacion por dia cuando la ingesta creo registros NUEVOS (suma de las fuentes
      // de ESA organizacion). UNA transaccion por organizacion; una emision fallida (o la base sin 0039) nunca cambia el barrido ni
      // la respuesta. Sin PII ni titulos de convocatorias: solo el conteo.
      const hoyDiscover = new Date().toISOString().slice(0, 10);
      for (const orgResult of sweep) {
        const nuevas = orgResult.results.reduce((n, r) => n + r.created, 0);
        if (nuevas === 0) continue;
        await deps.engine
          .withAppSession({ userId: null }, (db) =>
            emitirNotificacion(db, { evento: "licitaciones.convocatoria.nueva", organizationId: orgResult.organizationId, clave: `${orgResult.organizationId}:${hoyDiscover}`, parametros: { cantidad: nuevas } }),
          )
          .catch(() => undefined);
      }
      const failures: { organization_id: string; source: string | null; error: string; no_disponible?: true }[] = [];
      // r4-fix-crons-transaccion-por-unidad (re-revisión, bloqueante único): `failures[]`
      // de arriba sigue reportando CUALQUIER fuente con `state !== "ok"` (incluida
      // `not_configured`, para que el body/`ok` no cambien de comportamiento). Pero
      // `not_configured` (p. ej. el conector `aggregator` mientras no exista
      // LICITACIONES_AGGREGATOR_API_KEY/BASE_URL -- ver connector-errors.ts) NO es un
      // fallo del cron: es el camino feliz esperado mientras no se elija proveedor
      // (documentado en el propio spec de esta ruta), y esa fuente ya tiene su
      // propio canal de salud (no el latido de ESTE cron). Sin este filtro, el
      // latido quedaba en "error" TODOS los días aunque la corrida fuera perfecta
      // -- una alerta crítica falsa y permanente que además tapaba fallos reales.
      // `realFailures` es el subconjunto que sí dispara `CronPartialFailureError`.
      const realFailures: typeof failures = [];
      for (const orgResult of sweep) {
        if (orgResult.error) {
          const item = { organization_id: orgResult.organizationId, source: null, error: orgResult.error };
          failures.push(item);
          realFailures.push(item);
          continue;
        }
        for (const r of orgResult.results) {
          if (r.state === "ok") continue;
          // `unavailable`: fuente externa bloqueada/retirada/con TLS inválido o inalcanzable. Se reporta con su aviso (body, `source_run`
          // y obsolescencia), pero no es un fallo real de la corrida: no hay nada corregible en este repo y el latido rojo diario taparía fallos reales.
          const item = { organization_id: orgResult.organizationId, source: r.source, error: r.message, ...(r.unavailable ? { no_disponible: true as const } : {}) };
          failures.push(item);
          if (r.state !== "not_configured" && !r.unavailable) realFailures.push(item);
        }
      }
      // Escalado de fuentes no disponibles: una fuente "no disponible" (WAF/TLS/red) no pone el latido en rojo, pero si lleva mas que su
      // umbral de obsolescencia sin una corrida exitosa deja de ser pasiva: alerta alta + aviso de campana (superadmin.cron.fallo), una por
      // fuente por dia. Best-effort: nunca altera la respuesta ni el latido.
      const fuentesEscaladas = await escalarFuentesNoDisponibles(deps, withRepo, sweep);
      const response = c.json(
        {
          ok: failures.length === 0,
          organizations_checked: sweep.length,
          fuentes_escaladas: fuentesEscaladas,
          corridas: sweep.map((orgResult) => ({
            organization_id: orgResult.organizationId,
            error: orgResult.error ?? null,
            fuentes: orgResult.results.map((r) => ({ source: r.source, estado: r.state, descubiertos: r.discovered, creados: r.created, actualizados: r.updated, filas_descartadas: r.droppedRows, mensaje: r.message, no_disponible: r.unavailable === true })),
          })),
          failures,
        },
        200,
      );
      // (5) el latido no debe registrar "ok" limpio si alguna fuente/organización
      // falló DE VERDAD -- ver CronPartialFailureError (with-heartbeat.ts) y el
      // comentario de `realFailures` arriba. `ok`/`failures[]` del body no cambian.
      if (realFailures.length > 0) {
        const fuentes = realFailures.map((f) => f.source ?? `organización ${f.organization_id}`).join(", ");
        throw new CronPartialFailureError(`discover-tenders: ${realFailures.length} fallo(s) real(es) de ${sweep.length} organizaciones (${fuentes})`, response);
      }
      return response;
    })();
  });

  app.on(["GET", "POST"], "/internal/licitaciones/deadline-reminders", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/licitaciones/deadline-reminders", async () => {
      const withRepo = <T>(fn: (repo: LicitacionesRepository) => Promise<T>) => deps.engine.withAppSession({ userId: null }, (db) => fn(deps.licitacionesRepo(db)));
      const sweep = await runDeadlineReminderSweep(withRepo);
      // Aviso in-app (campana): una por organizacion por dia cuando el barrido creo recordatorios NUEVOS (el
      // dedupe real de los recordatorios ya evita repetirlos). UNA transaccion por organizacion; una emision
      // fallida (o la base sin 0039) nunca cambia el barrido ni la respuesta.
      const hoy = new Date().toISOString().slice(0, 10);
      for (const r of sweep) {
        if (r.created === 0) continue;
        await deps.engine
          .withAppSession({ userId: null }, (db) =>
            emitirNotificacion(db, { evento: "licitaciones.plazo.por_vencer", organizationId: r.organizationId, clave: `${r.organizationId}:${hoy}`, parametros: { cantidad: r.created } }),
          )
          .catch(() => undefined);
      }
      const failures = sweep.filter((r) => r.error != null).map((r) => ({ organization_id: r.organizationId, error: r.error }));
      const scanned = sweep.reduce((sum, r) => sum + r.scanned, 0);
      const created = sweep.reduce((sum, r) => sum + r.created, 0);
      // L-04 -- segundo plazo vigilado por el mismo cron: limite de envio de preguntas a la junta de
      // aclaraciones. Corre DESPUES del barrido existente y en transacciones propias: nunca afecta a los
      // recordatorios de plazo de presentacion ya procesados. Base sin migrar -> `unavailable`, no fallo.
      const salaFactory = deps.licitacionesSalaGuerraRepo;
      const withSalaRepo = <T>(fn: (repo: SalaGuerraRepository) => Promise<T>) => deps.engine.withAppSession({ userId: null }, (db) => fn(salaFactory!(db)));
      const juntaSweep = salaFactory
        ? await runJuntaQuestionReminderSweep(
            sweep.map((r) => r.organizationId),
            withSalaRepo,
          )
        : [];
      const juntaFailures = juntaSweep.filter((r) => r.error != null).map((r) => ({ organization_id: r.organizationId, error: r.error }));
      const juntaCreated = juntaSweep.reduce((sum, r) => sum + r.created, 0);
      const allFailures = [...failures, ...juntaFailures];
      const response = c.json(
        {
          ok: allFailures.length === 0,
          organizations_checked: sweep.length,
          scanned,
          created,
          failures: allFailures,
          junta_question_reminders: { created: juntaCreated, unavailable: juntaSweep.filter((r) => r.unavailable).length },
        },
        200,
      );
      if (allFailures.length > 0) {
        throw new CronPartialFailureError(`deadline-reminders: ${allFailures.length} fallo(s) en ${sweep.length} organizaciones`, response);
      }
      return response;
    })();
  });

  return app;
}
