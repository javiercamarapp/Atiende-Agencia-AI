// Avisos de fin de prueba a 7 / 3 / 1 dias (PL-16): cron `/internal/plataforma/prueba-avisos`. El reclamo "exactamente una vez" y el
// calculo del dia en la zona del negocio viven en SQL y se prueban contra Postgres real (scripts/verify-planes-topes-prueba); aqui:
// autenticacion del cron, notificacion in-app + correo por cada aviso reclamado, marcado del estado del correo, reintentos y
// compatibilidad con la base sin migrar (AbortAwareFakeSession reproduce el 25P02 real).
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildTestDeps } from "./fixtures.ts";
import { AbortAwareFakeSession } from "../../../packages/db/tests/support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-00000000a103";
const ENDS = "2026-11-10T18:00:00.000Z";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const claim = /trial_notice_claim/;
const emit = /core\.emit_notification/;
const recipients = /trial_notice_recipients/;
const mark = /trial_notice_mark/;

function fila(dias: number, extra: Record<string, unknown> = {}) {
  return { organization_id: ORG, organization_name: "Hotel C", vertical: "hoteles", slug: "hotel-c", dias_antes: dias, trial_ends_at: new Date(ENDS), es_reintento: false, ...extra };
}

async function ejecutar(opts: { sesion: AbortAwareFakeSession; apiKey?: string | null; fetchImpl?: typeof fetch; headers?: Record<string, string> }) {
  const base = await buildTestDeps();
  const llamadas: Array<{ sql: string; params: unknown[] }> = [];
  const original = opts.sesion.query.bind(opts.sesion);
  opts.sesion.query = (async (sql: string, p?: unknown[]) => {
    llamadas.push({ sql, params: p ?? [] });
    return original(sql, p);
  }) as typeof opts.sesion.query;
  const deps = {
    ...base.deps,
    env: { ...base.deps.env, resend: { apiKey: opts.apiKey === undefined ? "re_test" : opts.apiKey, from: "atiende <notificaciones@atiende.ai>" } },
    engine: { withAppSession: async (_c: unknown, fn: (s: AbortAwareFakeSession) => Promise<unknown>) => fn(opts.sesion) },
  } as unknown as typeof base.deps;
  if (opts.fetchImpl) vi.stubGlobal("fetch", opts.fetchImpl);
  const app = buildApp(deps);
  const res = await app.request("/internal/plataforma/prueba-avisos", { method: "POST", headers: opts.headers ?? { "x-atiende-internal-secret": base.deps.env.internalSecret } });
  return { res, llamadas, secret: base.deps.env.internalSecret };
}

afterEach(() => vi.unstubAllGlobals());

describe("POST /internal/plataforma/prueba-avisos", () => {
  it("sin el secreto interno responde 401 y no toca la base", async () => {
    const sesion = new AbortAwareFakeSession([]);
    const { res, llamadas } = await ejecutar({ sesion, headers: {} });
    expect(res.status).toBe(401);
    expect(llamadas).toHaveLength(0);
  });

  it("un aviso reclamado emite la notificacion in-app (dedupe por organizacion, umbral y fecha), envia el correo con clave de idempotencia y marca el estado", async () => {
    const sesion = new AbortAwareFakeSession([
      { match: claim, respond: () => [fila(7)] },
      { match: emit, respond: () => [{ emit_notification: 2 }] },
      { match: recipients, respond: () => [{ email: "owner@example.com" }] },
      { match: mark, respond: () => [{ trial_notice_mark: true }] },
    ]);
    const enviados: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      enviados.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const { res, llamadas } = await ejecutar({ sesion, fetchImpl });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, disponible: true, reclamados: 1, notificados: 1, correos: { enviado: 1 }, errores: 0 });

    const e = llamadas.find((l) => emit.test(l.sql))!;
    expect(e.params[0]).toBe(ORG);
    expect(e.params[2]).toBe("hoteles.plan.prueba_por_vencer");
    expect(e.params[5]).toBe("Su prueba está por terminar");
    expect(e.params[6]).toBe("Días restantes: 7. Revise Plan y uso para ver el estado de su cuenta.");
    expect(e.params[10]).toBe(`hoteles.plan.prueba_por_vencer:${ORG}:7:2026-11-10`);

    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.url).toBe("https://api.resend.com/emails");
    const headers = enviados[0]!.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe(`prueba/${ORG}/7/2026-11-10`);
    const cuerpo = JSON.parse(String(enviados[0]!.init.body)) as { to: string[]; subject: string; text: string };
    expect(cuerpo.to).toEqual(["owner@example.com"]);
    expect(cuerpo.subject).toBe("Su prueba de atiende termina en 7 días");
    expect(cuerpo.text).toContain("/hoteles/hotel-c/plan");

    const m = llamadas.find((l) => mark.test(l.sql))!;
    expect(m.params).toEqual([ORG, 7, ENDS, "enviado"]);
  });

  it("a 1 dia la notificacion no cae en el plural incorrecto ('1 dias'): el titulo no lleva el numero", async () => {
    const sesion = new AbortAwareFakeSession([
      { match: claim, respond: () => [fila(1)] },
      { match: emit, respond: () => [{ emit_notification: 1 }] },
      { match: recipients, respond: () => [] },
      { match: mark, respond: () => [{}] },
    ]);
    const { llamadas } = await ejecutar({ sesion });
    const e = llamadas.find((l) => emit.test(l.sql))!;
    expect(e.params[5]).toBe("Su prueba está por terminar");
    expect(e.params[6]).toBe("Días restantes: 1. Revise Plan y uso para ver el estado de su cuenta.");
  });

  it("sin RESEND_API_KEY el aviso in-app sale igual y el correo queda 'no_configurado' (se reintenta despues), nunca como enviado", async () => {
    const sesion = new AbortAwareFakeSession([
      { match: claim, respond: () => [fila(3)] },
      { match: emit, respond: () => [{ emit_notification: 1 }] },
      { match: recipients, respond: () => [{ email: "owner@example.com" }] },
      { match: mark, respond: () => [{}] },
    ]);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { res, llamadas } = await ejecutar({ sesion, apiKey: null, fetchImpl });
    expect(await res.json()).toMatchObject({ notificados: 1, correos: { no_configurado: 1, enviado: 0 } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(llamadas.find((l) => mark.test(l.sql))!.params[3]).toBe("no_configurado");
  });

  it("sin destinatarios (organizacion sin owner/admin) queda 'sin_destinatarios' y no llama a Resend", async () => {
    const sesion = new AbortAwareFakeSession([
      { match: claim, respond: () => [fila(3)] },
      { match: emit, respond: () => [{ emit_notification: 0 }] },
      { match: recipients, respond: () => [] },
      { match: mark, respond: () => [{}] },
    ]);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { llamadas } = await ejecutar({ sesion, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(llamadas.find((l) => mark.test(l.sql))!.params[3]).toBe("sin_destinatarios");
  });

  it("Resend responde error: el correo queda 'error' (el reclamo lo reintenta) y la corrida sigue con 200", async () => {
    const sesion = new AbortAwareFakeSession([
      { match: claim, respond: () => [fila(7)] },
      { match: emit, respond: () => [{ emit_notification: 1 }] },
      { match: recipients, respond: () => [{ email: "owner@example.com" }] },
      { match: mark, respond: () => [{}] },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchImpl = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const { res, llamadas } = await ejecutar({ sesion, fetchImpl });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ correos: { error: 1 } });
    expect(llamadas.find((l) => mark.test(l.sql))!.params[3]).toBe("error");
    error.mockRestore();
  });

  it("no hay avisos hoy: 200 sin enviar nada", async () => {
    const sesion = new AbortAwareFakeSession([{ match: claim, respond: () => [] }]);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { res } = await ejecutar({ sesion, fetchImpl });
    expect(await res.json()).toMatchObject({ ok: true, disponible: true, reclamados: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("base sin migrar: 200 con disponible:false (nunca 500) y sin tocar nada mas", async () => {
    const sesion = new AbortAwareFakeSession([
      { match: claim, respond: () => pgError("42883", "function core.trial_notice_claim(timestamp with time zone) does not exist") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const { res, llamadas } = await ejecutar({ sesion });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, disponible: false, reclamados: 0 });
    expect(llamadas.filter((l) => emit.test(l.sql) || recipients.test(l.sql))).toHaveLength(0);
    await expect(sesion.query("select 1;")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });
});
