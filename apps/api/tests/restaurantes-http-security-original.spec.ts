// Port de `http-security.test.ts` y `observability.test.ts` del original atiende-restaurantes (ver
// packages/domain-restaurantes/tests/regresiones-original/README.md). El resto de la seguridad HTTP (origen/CORS,
// secretos internos, actor de rate limit) ya tiene pruebas propias: origin-guard, http-security-internal-cron,
// http-security-request-actor.
import { afterEach, describe, expect, it, vi } from "vitest";
import { actorHash } from "@atiende/domain-restaurantes";
import { requestId } from "@atiende/core-auth";
import { Hono } from "hono";
import { constantTimeEqual, originAllowed, readJsonCapped, requestActor, secretMatches } from "../src/http-security.ts";
import { logEvent } from "../src/logger.ts";

afterEach(() => vi.restoreAllMocks());

const post = (body: string, headers: Record<string, string> = {}) => new Request("https://edge.test/x", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
const statusDe = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as { status?: number }).status;

describe("http-security.test.ts:16 / :22 -- secretos y origen", () => {
  it("X58 / original :16: la comparacion de secretos rechaza faltantes, vacios y distintos", () => {
    expect(constantTimeEqual(null, "secreto")).toBe(false);
    expect(constantTimeEqual("secreto", undefined)).toBe(false);
    expect(constantTimeEqual("", "")).toBe(false);
    expect(constantTimeEqual("secret0", "secreto")).toBe(false);
    expect(constantTimeEqual("secreto-largo", "secreto")).toBe(false);
    expect(constantTimeEqual("secreto", "secreto")).toBe(true);
    expect(secretMatches(new Request("https://edge.test", { headers: { "x-secret": "abc" } }), "x-secret", "abc")).toBe(true);
    expect(secretMatches(new Request("https://edge.test"), "x-secret", "abc")).toBe(false);
  });

  it("original :22: la lista de origenes es exacta y una llamada servidor a servidor (sin Origin) sigue siendo valida", () => {
    const permitidos = ["https://panel.atiende.test"];
    expect(originAllowed(null, permitidos)).toBe(true);
    expect(originAllowed("https://panel.atiende.test", permitidos)).toBe(true);
    expect(originAllowed("https://panel.atiende.test.evil.example", permitidos)).toBe(false);
    expect(originAllowed("http://panel.atiende.test", permitidos)).toBe(false);
  });
});

describe("http-security.test.ts:82 / :96 -- lectura de JSON acotada", () => {
  it("original :82: un JSON invalido o null es un 400 limpio, no un 500", async () => {
    expect(await statusDe(readJsonCapped(post("{no es json")))).toBe(400);
    expect(await statusDe(readJsonCapped(post("null")))).toBe(400);
    expect(await readJsonCapped(post('{"a":1}'))).toEqual({ a: 1 });
  });

  it("original :96: el limite de bytes se aplica al content-length declarado y al tamano real (413)", async () => {
    expect(await statusDe(readJsonCapped(post(JSON.stringify({ value: "123456" })), 4))).toBe(413);
    expect(await statusDe(readJsonCapped(post("x".repeat(100), { "content-length": "1" }), 4))).toBe(413);
  });
});

describe("http-security.test.ts:114 / :123 -- actor de rate limit", () => {
  it("original :114: el hash del actor es determinista, de 64 hex y no contiene el telefono", () => {
    const actor = "203.0.113.4:+529999999999";
    expect(actorHash(actor)).toBe(actorHash(actor));
    expect(actorHash(actor)).toMatch(/^[0-9a-f]{64}$/);
    expect(actorHash(actor)).not.toContain("999999");
  });

  it("X58 / original :123: un prefijo de X-Forwarded-For fabricado por el cliente no elige el actor (ultimo salto)", () => {
    const req = new Request("https://edge.test", { headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.9" } });
    expect(requestActor(req)).toBe("203.0.113.9:");
  });
});

describe("observability.test.ts -- correlation id y metadatos sin PII", () => {
  async function ecoDeRequestId(header: string | undefined) {
    const app = new Hono();
    app.use("*", requestId());
    app.get("/ping", (c) => c.json({ ok: true }));
    const res = await app.request("/ping", { headers: header === undefined ? {} : { "x-request-id": header } });
    return res.headers.get("x-request-id") ?? "";
  }

  it("X57 / original :7: un id de traza acotado y bien formado se conserva; sin header se genera uno nuevo", async () => {
    expect(await ecoDeRequestId("trace-12345678")).toBe("trace-12345678");
    expect(await ecoDeRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await ecoDeRequestId("x".repeat(101))).toMatch(/^[0-9a-f-]{36}$/);
  });

  // QA seguridad-12 (lote A): el middleware confia en cualquier id de <= 100 caracteres, aunque lleve espacios, un
  // correo, una tarjeta o saltos de linea, y ese valor se repite en cada linea de log.
  it.fails("X57 / original :7 [lote A, seguridad-12]: un correlation id hostil (espacios, PII, caracteres de control) se descarta y se genera uno nuevo", async () => {
    for (const hostil of ["bad trace value", "ana@example.com", "4111 1111 1111 1111", "a\tb"]) {
      expect(await ecoDeRequestId(hostil), hostil).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("X57 / original :18: los campos con PII o secretos no llegan a la linea de log", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logEvent({ get: () => "00000000-0000-0000-0000-0000000000a1" }, "info", "whatsapp_turno", { status: 503, message: "provider timeout", telefono: "cel +52 999 123 4567", tarjeta: "4111 1111 1111 1111", correo: "ana@example.com" });
    const linea = String(spy.mock.calls[0]![0]);
    for (const secreto of ["4111", "ana@example.com", "123 4567"]) expect(linea).not.toContain(secreto);
    expect(JSON.parse(linea)).toMatchObject({ status: 503, message: "provider timeout" });
  });
});
