// Medidor mensual de mensajes por plan (PL-16): decision antes de enviar, registro despues y avisos in-app. Usa
// AbortAwareFakeSession (reproduce el estado abortado 25P02): una sesion plana NO demostraria que contra la base sin migrar la
// transaccion del request queda utilizable. La aritmetica de umbrales/zona horaria vive en SQL y se prueba contra Postgres real
// en scripts/verify-planes-topes-prueba.
import { describe, expect, it } from "vitest";
import { crearMedidorMensajes } from "../src/plan-topes/medidor.ts";
import { AbortAwareFakeSession } from "../../../packages/db/tests/support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-00000000a101";
const CTX = { label: "citas", itemId: "msg-1", organizationId: ORG, proactivo: false, critico: false } as const;

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const check = /message_quota_check/;
const record = /message_usage_record/;
const emit = /core\.emit_notification/;

function registro(cruce: string, extra: Record<string, unknown> = {}) {
  return [{ r: { registrado: true, periodo: "2026-10-01", cruce, usado: 801, limite: 1000, accion: "avisar", excedente: 0, slug: "hotel-a", ...extra } }];
}

/** Sesion que ademas captura los parametros de cada consulta. */
function sesion(handlers: ConstructorParameters<typeof AbortAwareFakeSession>[0]) {
  const s = new AbortAwareFakeSession(handlers);
  const llamadas: Array<{ sql: string; params: unknown[] }> = [];
  const original = s.query.bind(s);
  s.query = (async (sql: string, p?: unknown[]) => {
    llamadas.push({ sql, params: p ?? [] });
    return original(sql, p);
  }) as typeof s.query;
  return { s, llamadas };
}

describe("medidor de mensajes: despues de enviar", () => {
  it("el mensaje 801 de 1000 emite UN aviso al owner de la organizacion y UNO a superadmin, con dedupe por organizacion y mes y sin PII", async () => {
    const { s, llamadas } = sesion([
      { match: record, respond: () => registro("aviso80") },
      { match: emit, respond: () => [{ emit_notification: 1 }] },
    ]);
    await crearMedidorMensajes(s, "citas").despuesDeEnviar(CTX);

    const emisiones = llamadas.filter((l) => emit.test(l.sql));
    expect(emisiones).toHaveLength(2);
    const [org, sup] = emisiones as [(typeof emisiones)[0], (typeof emisiones)[0]];
    expect(org.params[0]).toBe(ORG);
    expect(org.params[2]).toBe("citas.plan.mensajes_80");
    expect(org.params[5]).toBe("Va en el 80 por ciento del tope de mensajes de su plan");
    expect(org.params[6]).toBe("Mensajes del mes: 801 de 1000.");
    expect(org.params[7]).toBe("/citas/{orgSlug}/plan");
    expect(org.params[10]).toBe(`citas.plan.mensajes_80:${ORG}:2026-10-01`);
    expect(sup.params[0]).toBeNull();
    expect(sup.params[2]).toBe("superadmin.plan.mensajes_80");
    expect(sup.params[6]).toBe("Organización: hotel-a. Mensajes del mes: 801 de 1000.");
    expect(sup.params[10]).toBe(`superadmin.plan.mensajes_80:${ORG}:2026-10-01`);
    for (const e of emisiones) expect(String(e.params[5]) + String(e.params[6])).not.toMatch(/@|\d{7,}/);
  });

  it("el mensaje 1001 (tope superado) emite el aviso critico del tope", async () => {
    const { s, llamadas } = sesion([
      { match: record, respond: () => registro("excedido", { usado: 1001, excedente: 1 }) },
      { match: emit, respond: () => [{ emit_notification: 1 }] },
    ]);
    await crearMedidorMensajes(s, "hoteles").despuesDeEnviar({ ...CTX, label: "hoteles" });
    const ids = llamadas.filter((l) => emit.test(l.sql)).map((l) => l.params[2]);
    expect(ids).toEqual(["hoteles.plan.mensajes_excedido", "superadmin.plan.mensajes_excedido"]);
    expect(llamadas.find((l) => emit.test(l.sql))?.params[4]).toBe("critica");
  });

  it("sin cruce de umbral (o un mensaje ya registrado) no emite nada", async () => {
    for (const r of [registro("ninguno"), registro("aviso80", { registrado: false })]) {
      const { s, llamadas } = sesion([{ match: record, respond: () => r }]);
      await crearMedidorMensajes(s, "citas").despuesDeEnviar(CTX);
      expect(llamadas.filter((l) => emit.test(l.sql))).toHaveLength(0);
    }
  });

  it("registra con la referencia del outbox (idempotente) y el origen proactivo", async () => {
    const { s, llamadas } = sesion([{ match: record, respond: () => registro("ninguno") }]);
    await crearMedidorMensajes(s, "restaurantes").despuesDeEnviar({ ...CTX, label: "restaurantes", itemId: "abc", proactivo: true });
    const q = llamadas.find((l) => record.test(l.sql))!;
    expect(q.params.slice(0, 3)).toEqual([ORG, "wa_restaurantes", "abc"]);
    expect(q.params[4]).toBe(true);
  });

  it("base sin migrar: no cuenta ni avisa, no lanza y la transaccion queda utilizable", async () => {
    const s = new AbortAwareFakeSession([
      { match: record, respond: () => pgError("42883", "function core.message_usage_record(uuid, text, text, timestamp with time zone, boolean, boolean, text) does not exist") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    await expect(crearMedidorMensajes(s, "citas").despuesDeEnviar(CTX)).resolves.toBeUndefined();
    await expect(s.query("select 1;")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("un aviso que no se pudo emitir (base sin migrar de notificaciones) no tumba el registro ni la sesion", async () => {
    const s = new AbortAwareFakeSession([
      { match: record, respond: () => registro("aviso80") },
      { match: emit, respond: () => pgError("42883", "function core.emit_notification(uuid, uuid, text) does not exist") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    await expect(crearMedidorMensajes(s, "citas").despuesDeEnviar(CTX)).resolves.toBeUndefined();
    await expect(s.query("select 1;")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });
});

describe("medidor de mensajes: antes de enviar", () => {
  it("lo transaccional SIEMPRE sale y ni siquiera consulta a la base", async () => {
    const { s, llamadas } = sesion([]);
    expect(await crearMedidorMensajes(s, "citas").antesDeEnviar({ ...CTX, proactivo: false })).toEqual({ permitir: true });
    expect(llamadas).toHaveLength(0);
  });

  it("un proactivo permitido sale", async () => {
    const { s } = sesion([{ match: check, respond: () => [{ r: { permitir: true, motivo: null, usado: 10, limite: 1000 } }] }]);
    expect(await crearMedidorMensajes(s, "citas").antesDeEnviar({ ...CTX, proactivo: true })).toEqual({ permitir: true });
  });

  it("un proactivo que el plan manda omitir NO sale: queda registrado como omitido con su motivo", async () => {
    const { s, llamadas } = sesion([
      { match: check, respond: () => [{ r: { permitir: false, motivo: "tope_mensajes_plan", usado: 1000, limite: 1000 } }] },
      { match: record, respond: () => registro("ninguno") },
    ]);
    const r = await crearMedidorMensajes(s, "citas").antesDeEnviar({ ...CTX, proactivo: true });
    expect(r).toEqual({ permitir: false, motivo: "tope_mensajes_plan" });
    const q = llamadas.find((l) => record.test(l.sql))!;
    expect(q.params[1]).toBe("wa_omitido_citas");
    expect(q.params[2]).toBe("msg-1");
    expect(q.params[5]).toBe(true);
    expect(q.params[6]).toBe("tope_mensajes_plan");
  });

  it("base sin migrar: el proactivo se PERMITE (sin medidor no se bloquea nada) y la sesion sigue viva", async () => {
    const s = new AbortAwareFakeSession([
      { match: check, respond: () => pgError("42883", "function core.message_quota_check(uuid, boolean, boolean, timestamp with time zone) does not exist") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    expect(await crearMedidorMensajes(s, "citas").antesDeEnviar({ ...CTX, proactivo: true })).toEqual({ permitir: true });
    await expect(s.query("select 1;")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });
});
