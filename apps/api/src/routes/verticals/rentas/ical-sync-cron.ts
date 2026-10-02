// Fase 5 -- GET/POST /internal/rentas/ical-sync: corrida periódica real del motor
// de sincronización iCal -- mismo patrón/guard EXACTO que
// apps/api/.../hoteles/email-dispatch.ts y .../citas/google-calendar-sync.ts:
// acepta GET (Vercel Cron, que solo dispara GET con
// `Authorization: Bearer <CRON_SECRET>`) y POST (header manual
// `x-atiende-internal-secret`/tests), gateada por `internalOrCronSecretMatches`
// (ver comentario de cabecera de `http-security.ts::internalOrCronSecretMatches`).
// Rn-01 -- lote idempotente con claim/lease por feed (varias instancias del cron no se
// pisan), backoff por feed fallido y bitácora/alertas: toda la orquestación vive en
// `ejecutarLoteSync` (@atiende/domain-rentas, src/sync/lote.ts). No está acotada por
// organización porque cada feed se procesa independientemente y un fallo de uno nunca
// debe detener a los demás. Contra una base sin la migración 024 el lote cae al
// barrido anterior (todos los feeds activos, sin lease).
//
// Wiring real del scheduler: `vercel.json::crons` invoca este mismo path por GET.
import { Hono } from "hono";
import { emitirNotificacion } from "@atiende/db";
import { ejecutarLoteSync } from "@atiende/domain-rentas";
import type { ResultadoFeedLote } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { CronPartialFailureError, withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

const FALLOS_DE_SYNC: readonly ResultadoFeedLote["resultado"][] = ["fallo_red", "fallo_parseo", "error_interno"];

/**
 * Avisos in-app (campana) del lote de sync, UNO por property y por evento (clave = property + dia): feeds con error, reservas nuevas
 * importadas y conflictos de calendario detectados. Cada aviso corre en su PROPIA sesion de sistema y es best-effort: el lote ya
 * termino y sus transacciones ya confirmaron, asi que un fallo al emitir (base sin migrar, tope de volumen) nunca cambia la respuesta
 * del cron ni su latido. Los parametros son solo conteos (sin nombres de huespedes ni URLs de feeds).
 */
export async function emitirAvisosDeSync(deps: AppDeps, feeds: readonly ResultadoFeedLote[], ahora: Date = new Date()): Promise<void> {
  const dia = ahora.toISOString().slice(0, 10);
  const porProperty = new Map<string, { organizationId: string; propertyId: string; fallidos: number; nuevas: number; conflictos: number }>();
  for (const f of feeds) {
    const acum = porProperty.get(f.propertyId) ?? { organizationId: f.organizationId, propertyId: f.propertyId, fallidos: 0, nuevas: 0, conflictos: 0 };
    if (FALLOS_DE_SYNC.includes(f.resultado)) acum.fallidos += 1;
    acum.nuevas += f.reservasNuevas;
    acum.conflictos += f.conflictosDetectados;
    porProperty.set(f.propertyId, acum);
  }
  const avisos = [...porProperty.values()].flatMap((p) => [
    ...(p.fallidos > 0 ? [{ evento: "rentas.ical.sync_fallido", p, cantidad: p.fallidos }] : []),
    ...(p.nuevas > 0 ? [{ evento: "rentas.reserva.nueva_ical", p, cantidad: p.nuevas }] : []),
    ...(p.conflictos > 0 ? [{ evento: "rentas.conflicto.detectado", p, cantidad: p.conflictos }] : []),
  ]);
  for (const a of avisos) {
    try {
      await deps.engine.withAppSession({ userId: null }, (db) =>
        emitirNotificacion(db, { evento: a.evento, organizationId: a.p.organizationId, propertyId: a.p.propertyId, clave: `${a.p.propertyId}:${dia}`, parametros: { cantidad: a.cantidad } }),
      );
    } catch {
      // best-effort: el lote y su latido no dependen del aviso
    }
  }
}

export function rentasIcalSyncCronRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/rentas/ical-sync", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/rentas/ical-sync", async () => {
      // `conSesionSistema` abre UNA transacción por llamada: el claim, cada feed, la
      // bitácora y la liberación del lease corren cada uno en la suya (ver lote.ts).
      const lote = await ejecutarLoteSync({
        conSesionSistema: (fn) => deps.engine.withAppSession({ userId: null }, fn),
        crearSyncRepo: (db) => deps.rentasCalendarSyncRepo(db),
        port: deps.rentasIcalFeedPort,
      });

      await emitirAvisosDeSync(deps, lote.feeds);

      const resultados = lote.feeds.map((f) => ({
        feedId: f.feedId,
        unidadId: f.unidadId,
        canal: f.canal,
        resultado: f.resultado,
        eventosAplicados: f.eventosAplicados,
        conflictosDetectados: f.conflictosDetectados,
        ...(f.error !== undefined ? { error: f.error } : {}),
      }));
      const failures = resultados.filter((r) => "error" in r);
      const conflictos = resultados.reduce((acc, r) => acc + r.conflictosDetectados, 0);
      const response = c.json({ ok: failures.length === 0, modo: lote.modo, procesados: resultados.length, devueltosPorPresupuesto: lote.devueltosPorPresupuesto, conflictosDetectados: conflictos, resultados });
      if (failures.length > 0) {
        throw new CronPartialFailureError(`ical-sync: ${failures.length} de ${resultados.length} feeds fallaron`, response);
      }
      return response;
    })();
  });

  return app;
}
