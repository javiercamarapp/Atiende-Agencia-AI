// C-16 -- centro de avisos de citas contra una sesion que reproduce el estado ABORTADO de Postgres (AbortAwareFakeSession; una sesion
// falsa plana no sirve): con la base SIN migrar (029 / 0039) cada lectura/escritura cae a un estado honesto DENTRO de un SAVEPOINT y la
// MISMA sesion sigue utilizable para lo que siga en el request (nunca 25P02 ni COMMIT que devuelva ROLLBACK).
import { describe, expect, it } from "vitest";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const ESC = "00000000-0000-4000-8000-0000000000e1";
const EMITIR = /core\.emit_notification/i;
const INSERTAR = /insert into citas\.emergency_escalations/i;
const LISTA_NUEVA = /follow_up_status, follow_up_at/i;
const LISTA_BASE = /from citas\.emergency_escalations where organization_id = \$1 order by created_at desc/i;
const SEGUIR = /citas\.set_escalation_follow_up/i;
const RESUMEN = /citas\.system_avisos_resumen/i;
const ENTREGA = /citas\.data_chat_reminder_delivery/i;
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente/i, respond: () => [{ ok: 1 }] };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const FILA_INSERTADA = { id: ESC, organization_id: ORG, customer_phone: "+5219981234567", channel: "whatsapp", keyword_matched: "no quiero vivir", message_excerpt: "texto sensible del cliente", created_at: "2026-10-01T10:00:00.000Z" };

async function sesionSigueViva(session: AbortAwareFakeSession): Promise<void> {
  await expect(session.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: 1 }] });
}

describe("insertEmergencyEscalation -> notificacion in-app citas.escalacion.crisis", () => {
  it("emite UNA notificacion critica con la clave de la escalacion y sin PII (ni telefono ni mensaje)", async () => {
    const session = new AbortAwareFakeSession([{ match: INSERTAR, respond: () => [FILA_INSERTADA] }, { match: EMITIR, respond: () => [{ emit_notification: 1 }] }]);
    const vistos: unknown[][] = [];
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      if (EMITIR.test(sql)) vistos.push(params ?? []);
      return original(sql, params);
    }) as typeof session.query;
    const rec = await new PostgresCitasRepository(session).insertEmergencyEscalation({ organizationId: ORG, customerPhone: "+5219981234567", channel: "whatsapp", keywordMatched: "no quiero vivir", messageExcerpt: "texto sensible del cliente" });
    expect(rec.id).toBe(ESC);
    expect(vistos).toHaveLength(1);
    expect(vistos[0]![0]).toBe(ORG);
    expect(vistos[0]![1]).toBeNull();
    expect(vistos[0]![2]).toBe("citas.escalacion.crisis");
    expect(vistos[0]![4]).toBe("critica");
    expect(vistos[0]![7]).toBe("/citas/{orgSlug}/avisos");
    expect(vistos[0]![10]).toBe(`citas.escalacion.crisis:${ESC}`);
    expect(vistos[0]![11]).toBeNull();
    expect(JSON.stringify(vistos[0])).not.toMatch(/5219981234567|vivir|sensible/);
  });

  it("base sin la migracion de notificaciones (42883): la escalacion queda registrada y la MISMA sesion sigue viva (SAVEPOINT)", async () => {
    const session = new AbortAwareFakeSession([{ match: INSERTAR, respond: () => [FILA_INSERTADA] }, { match: EMITIR, respond: () => pgError("42883", "function core.emit_notification does not exist") }, SIGUIENTE]);
    const rec = await new PostgresCitasRepository(session).insertEmergencyEscalation({ organizationId: ORG, customerPhone: "+5219981234567", channel: "whatsapp", keywordMatched: "k", messageExcerpt: "m" });
    expect(rec.id).toBe(ESC);
    await sesionSigueViva(session);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });
});

describe("listEscalaciones", () => {
  const FILA = { id: ESC, channel: "whatsapp", keyword_matched: "k", customer_phone: "+5219981234567", created_at: "2026-10-01T10:00:00.000Z" };

  it("con la migracion 029: devuelve el estado de seguimiento", async () => {
    const session = new AbortAwareFakeSession([{ match: LISTA_NUEVA, respond: () => [{ ...FILA, follow_up_status: "in_progress", follow_up_at: "2026-10-01T11:00:00.000Z", follow_up_note: "se llamo" }] }]);
    const r = await new PostgresCitasRepository(session).listEscalaciones(ORG, 50);
    expect(r).toMatchObject({ disponible: true, seguimientoDisponible: true });
    expect(r.items[0]).toMatchObject({ seguimiento: "in_progress", seguimientoNota: "se llamo" });
  });

  it("base SIN 029 (42703 en las columnas nuevas): la lista sale SIN estado (seguimiento null) y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: LISTA_NUEVA, respond: () => pgError("42703", 'column "follow_up_status" does not exist') },
      { match: LISTA_BASE, respond: () => [FILA] },
      SIGUIENTE,
    ]);
    const r = await new PostgresCitasRepository(session).listEscalaciones(ORG, 50);
    expect(r).toMatchObject({ disponible: true, seguimientoDisponible: false });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.seguimiento).toBeNull();
    await sesionSigueViva(session);
  });

  it("si ni la tabla existe (42P01): disponible false, sin lanzar y con la sesion viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: LISTA_NUEVA, respond: () => pgError("42703", "column does not exist") },
      { match: LISTA_BASE, respond: () => pgError("42P01", "relation does not exist") },
      SIGUIENTE,
    ]);
    const r = await new PostgresCitasRepository(session).listEscalaciones(ORG, 50);
    expect(r).toEqual({ disponible: false, seguimientoDisponible: false, items: [] });
    await sesionSigueViva(session);
  });
});

describe("setEscalacionSeguimiento", () => {
  it("actualiza y devuelve el estado y el instante", async () => {
    const session = new AbortAwareFakeSession([{ match: SEGUIR, respond: () => [{ out_id: ESC, out_status: "resolved", out_at: "2026-10-01T12:00:00.000Z" }] }]);
    expect(await new PostgresCitasRepository(session).setEscalacionSeguimiento(ORG, ESC, "resolved", "ok")).toEqual({ outcome: "updated", id: ESC, estado: "resolved", en: "2026-10-01T12:00:00.000Z" });
  });

  it.each([
    ["P0002", "not_found", "escalacion no encontrada"],
    ["22023", "invalid_input", "estado de seguimiento invalido"],
    ["42501", "forbidden", "solo owner/admin"],
    ["42883", "unavailable", "function citas.set_escalation_follow_up(uuid, uuid, text, text) does not exist"],
    ["42P01", "unavailable", 'relation "citas.emergency_escalations" does not exist'],
  ])("SQLSTATE %s -> %s sin abortar la transaccion", async (code, outcome, mensaje) => {
    const session = new AbortAwareFakeSession([{ match: SEGUIR, respond: () => pgError(code, mensaje) }, SIGUIENTE]);
    expect(await new PostgresCitasRepository(session).setEscalacionSeguimiento(ORG, ESC, "in_progress", null)).toEqual({ outcome });
    await sesionSigueViva(session);
  });

  it("un error inesperado (timeout) NO se traga: se propaga", async () => {
    const session = new AbortAwareFakeSession([{ match: SEGUIR, respond: () => pgError("57014", "statement timeout") }]);
    await expect(new PostgresCitasRepository(session).setEscalacionSeguimiento(ORG, ESC, "resolved", null)).rejects.toThrow(/timeout/);
  });
});

describe("systemAvisosResumen y recordatoriosPorEstado", () => {
  it("convierte los conteos y la clave epoch", async () => {
    const session = new AbortAwareFakeSession([{ match: RESUMEN, respond: () => [{ por_confirmar: "3", recordatorios_agotados: "2", ultimo_agotado_epoch: "1790000000", escalaciones_sin_seguimiento: "1" }] }]);
    expect(await new PostgresCitasRepository(session).systemAvisosResumen(ORG)).toEqual({ porConfirmar: 3, recordatoriosAgotados: 2, ultimoAgotadoEpoch: 1790000000, escalacionesSinSeguimiento: 1 });
  });

  it("base sin migrar (42883): null y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: RESUMEN, respond: () => pgError("42883", "function citas.system_avisos_resumen(uuid) does not exist") }, SIGUIENTE]);
    expect(await new PostgresCitasRepository(session).systemAvisosResumen(ORG)).toBeNull();
    await sesionSigueViva(session);
  });

  it("recordatoriosPorEstado: filas convertidas; sin la 027 (42883) null con la sesion viva", async () => {
    const ok = new AbortAwareFakeSession([{ match: ENTREGA, respond: () => [{ channel: "whatsapp", status: "dead", total: "4" }] }]);
    expect(await new PostgresCitasRepository(ok).recordatoriosPorEstado(ORG, "2026-09-24T00:00:00Z", "2026-10-04T00:00:00Z")).toEqual([{ channel: "whatsapp", status: "dead", total: 4 }]);
    const roto = new AbortAwareFakeSession([{ match: ENTREGA, respond: () => pgError("42883", "function citas.data_chat_reminder_delivery(uuid, uuid[], timestamp with time zone, timestamp with time zone) does not exist") }, SIGUIENTE]);
    expect(await new PostgresCitasRepository(roto).recordatoriosPorEstado(ORG, "2026-09-24T00:00:00Z", "2026-10-04T00:00:00Z")).toBeNull();
    await sesionSigueViva(roto);
  });
});
