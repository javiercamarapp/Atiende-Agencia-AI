// Rn-01 -- compatibilidad con la base SIN migrar (migración 024 pendiente) del repositorio
// Postgres de sync: cada operación nueva corre protegida por SAVEPOINT y, ante SQLSTATE
// 42883/42P01/42703, degrada sin lanzar y deja la transacción COMPARTIDA utilizable
// (sin 25P02). AbortAwareFakeSession reproduce el estado abortado real de Postgres: una
// sesión falsa plana NO sirve para demostrarlo.
import { describe, expect, it } from "vitest";
import { PostgresRentasCalendarSyncRepository } from "../src/sync/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
const sinFuncion = (nombre: string) => pgError("42883", `function ${nombre}() does not exist`);
const sinTabla = () => pgError("42P01", 'relation "rentas.ical_sync_bitacora" does not exist');
const sinColumna = () => pgError("42703", 'column cfe.ultimo_intento_en does not exist');

const SIGUIENTE = { match: /select 1 as siguiente_query_del_request/i, respond: () => [{ ok: true }] };

async function sesionSigueUsable(session: AbortAwareFakeSession): Promise<void> {
  await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
}

describe("PostgresRentasCalendarSyncRepository -- base sin la migración 024", () => {
  it("reclamarFeeds: 42883 -> { disponible: false } y la transacción compartida queda utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /claim_ical_feeds/i, respond: () => sinFuncion("rentas.claim_ical_feeds") }, SIGUIENTE]);
    const repo = new PostgresRentasCalendarSyncRepository(session);
    await expect(repo.reclamarFeeds({ limite: 5, leaseSegundos: 120, intervaloMinimoSegundos: 600 })).resolves.toEqual({ disponible: false });
    expect(session.calls).toContain("savepoint sp_rentas_ical_claim");
    expect(session.calls).toContain("rollback to savepoint sp_rentas_ical_claim");
    await sesionSigueUsable(session);
  });

  it("liberarFeed y registrarEventoBitacora: 42883 -> false sin lanzar, transacción utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /liberar_ical_feed/i, respond: () => sinFuncion("rentas.liberar_ical_feed") },
      { match: /registrar_ical_sync_evento/i, respond: () => sinFuncion("rentas.registrar_ical_sync_evento") },
      SIGUIENTE,
    ]);
    const repo = new PostgresRentasCalendarSyncRepository(session);
    await expect(repo.liberarFeed("f", "t", true)).resolves.toBe(false);
    await sesionSigueUsable(session);
    await expect(repo.registrarEventoBitacora("f", { tipo: "sync_fallido", severidad: "info", detalle: "x", eventosAplicados: 0, conflictos: 0 })).resolves.toBe(false);
    await sesionSigueUsable(session);
  });

  it("reiniciarBackoffFeed: 42703 (columna inexistente) es un no-op y no aborta la transacción", async () => {
    const session = new AbortAwareFakeSession([{ match: /update rentas\.canal_feed_externo set proximo_intento_en/i, respond: () => sinColumna() }, SIGUIENTE]);
    await expect(new PostgresRentasCalendarSyncRepository(session).reiniciarBackoffFeed("f")).resolves.toBeUndefined();
    await sesionSigueUsable(session);
  });

  it("listarBitacora: 42P01 -> vacío honesto (disponible: false)", async () => {
    const session = new AbortAwareFakeSession([{ match: /from rentas\.ical_sync_bitacora/i, respond: () => sinTabla() }, SIGUIENTE]);
    await expect(new PostgresRentasCalendarSyncRepository(session).listarBitacora("p", { soloAlertasAbiertas: true, limite: 10 })).resolves.toEqual({ disponible: false, alertas: [] });
    await sesionSigueUsable(session);
  });

  it("atenderAlerta: 42P01 -> no_disponible; decidirConflicto: sin la 026 y sin GRANT de UPDATE de 024 (42883 y luego 42501) -> no_disponible", async () => {
    const session = new AbortAwareFakeSession([
      { match: /update rentas\.ical_sync_bitacora/i, respond: () => sinTabla() },
      { match: /resolver_conflicto_calendario/i, respond: () => sinFuncion("rentas.resolver_conflicto_calendario") },
      { match: /update rentas\.conflicto_calendario/i, respond: () => pgError("42501", "permission denied for table conflicto_calendario") },
      SIGUIENTE,
    ]);
    const repo = new PostgresRentasCalendarSyncRepository(session);
    await expect(repo.atenderAlerta("p", "a", "u")).resolves.toBe("no_disponible");
    await sesionSigueUsable(session);
    await expect(repo.decidirConflicto("p", "c", "u", { accion: "resuelto", motivo: null })).resolves.toBe("no_disponible");
    await sesionSigueUsable(session);
  });

  it("listarFeedsMonitor: 42703 en las columnas de lease/backoff cae a la consulta anterior (columnas en null) sin 25P02", async () => {
    const fila = {
      id: "f1", unidad_id: "u1", unidad_nombre: "Casa", canal_codigo: "airbnb", activo: true, ultima_sincronizacion_exitosa_en: null, en_cuarentena_desde: null,
      intentos_fallidos_consecutivos: 0, motivo_cuarentena: null, ultimo_intento_en: null, proximo_intento_en: null, lease_hasta: null,
    };
    const session = new AbortAwareFakeSession([
      { match: /cfe\.ultimo_intento_en::text/i, respond: () => sinColumna() },
      { match: /null::text as ultimo_intento_en/i, respond: () => [fila] },
    ]);
    const feeds = await new PostgresRentasCalendarSyncRepository(session).listarFeedsMonitor("p");
    expect(feeds).toHaveLength(1);
    expect(feeds[0]).toMatchObject({ id: "f1", proximoIntentoEn: null, leaseHasta: null, ultimoIntentoEn: null });
  });

  it("un error de Postgres que NO es de migración pendiente se repropaga (nunca se enmascara)", async () => {
    const session = new AbortAwareFakeSession([{ match: /claim_ical_feeds/i, respond: () => pgError("57014", "canceling statement due to statement timeout") }, SIGUIENTE]);
    await expect(new PostgresRentasCalendarSyncRepository(session).reclamarFeeds({ limite: 5, leaseSegundos: 120, intervaloMinimoSegundos: 600 })).rejects.toMatchObject({ code: "57014" });
    // El SAVEPOINT se recuperó igual: la sesión del lote sigue siendo utilizable.
    await sesionSigueUsable(session);
  });

  it("camino feliz de reclamarFeeds: devuelve cada feed con su token de lease", async () => {
    const filaFeed = {
      id: "f1", organization_id: "o", property_id: "p", unidad_id: "u", canal_id: "c", canal_codigo: "airbnb", url_importacion: "https://x/y.ics", activo: true,
      ultima_sincronizacion_exitosa_en: null, en_cuarentena_desde: null, intentos_fallidos_consecutivos: 0, motivo_cuarentena: null, etag_import: null,
      ultima_modificacion_http_import: null, drift_ultima_reconciliacion_completa: 0, ultimo_resumen: null,
    };
    const session = new AbortAwareFakeSession([
      { match: /claim_ical_feeds/i, respond: () => [{ feed_id: "f1", lease_token: "tok-1" }] },
      { match: /from rentas\.canal_feed_externo cfe/i, respond: () => [filaFeed] },
    ]);
    const r = await new PostgresRentasCalendarSyncRepository(session).reclamarFeeds({ limite: 5, leaseSegundos: 120, intervaloMinimoSegundos: 600 });
    expect(r.disponible && r.feeds.map((x) => [x.feed.id, x.leaseToken])).toEqual([["f1", "tok-1"]]);
  });
});
