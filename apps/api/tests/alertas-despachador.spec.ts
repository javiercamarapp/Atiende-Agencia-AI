// Despachador de alertas salientes: SIN envio real -- todo fetch es un doble inyectado.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DistributedRateLimiter } from "@atiende/core-ratelimit";
import { configAlertasDesdeEnv, crearDespachadorAlertas, type ConfigAlertas } from "../src/alertas/despachador.ts";
import { crearLimitadorAlertas } from "../src/alertas/limite-horario.ts";
import { motivoUrlWebhookInvalida, parsearDsnSentry } from "../src/alertas/canales.ts";

const RESEND = { apiKey: "re_test_key_123456789012345", from: "atiende <n@atiende.ai>" };
const ALERTA = { tipo: "cron_error:/internal/x", severidad: "alta" as const, titulo: "Cron con error: /internal/x", detalle: "fallo con password=hunter2 para cliente@correo.com", href: "/superadmin/salud/crons", contexto: { token: "abc", cron: "/internal/x" } };
const DSN = "https://publickey123@o1.ingest.sentry.io/4501";

function fetchOk() {
  return vi.fn(async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }));
}
function limitador(n: number) {
  return crearLimitadorAlertas({ limitePorHora: n, limiter: new DistributedRateLimiter({ redisUrl: "", redisToken: "" }) });
}
function config(parcial: Partial<ConfigAlertas>): ConfigAlertas {
  return { correo: null, webhook: null, sentry: null, limitePorHora: 2, ...parcial };
}

describe("configAlertasDesdeEnv", () => {
  it("sin variables, todos los canales apagados", () => {
    const c = configAlertasDesdeEnv({}, RESEND);
    expect(c).toMatchObject({ correo: null, webhook: null, sentry: null });
  });
  it("correo exige Resend Y destinatarios validos; descarta correos invalidos", () => {
    expect(configAlertasDesdeEnv({ ALERTAS_EMAIL_DESTINATARIOS: "a@b.com" }, { apiKey: null, from: "x" }).correo).toBeNull();
    expect(configAlertasDesdeEnv({ ALERTAS_EMAIL_DESTINATARIOS: "basura" }, RESEND).correo).toBeNull();
    expect(configAlertasDesdeEnv({ ALERTAS_EMAIL_DESTINATARIOS: " a@b.com , nope, c@d.mx " }, RESEND).correo?.destinatarios).toEqual(["a@b.com", "c@d.mx"]);
  });
  it("webhook http o hacia host privado queda apagado; Sentry solo con DSN valido", () => {
    expect(configAlertasDesdeEnv({ ALERTAS_WEBHOOK_URL: "http://hooks.example.com/x" }, RESEND).webhook).toBeNull();
    expect(configAlertasDesdeEnv({ ALERTAS_WEBHOOK_URL: "https://hooks.example.com/x", ALERTAS_WEBHOOK_SECRETO: "s" }, RESEND).webhook).toEqual({ url: "https://hooks.example.com/x", secreto: "s" });
    expect(configAlertasDesdeEnv({ SENTRY_DSN: "no-es-dsn" }, RESEND).sentry).toBeNull();
    expect(configAlertasDesdeEnv({ SENTRY_DSN: DSN }, RESEND).sentry?.endpoint).toBe("https://o1.ingest.sentry.io/api/4501/envelope/");
  });
});

describe("validacion de destinos", () => {
  it("el webhook solo acepta https hacia hosts publicos", () => {
    expect(motivoUrlWebhookInvalida("https://hooks.example.com/a")).toBeNull();
    expect(motivoUrlWebhookInvalida("http://hooks.example.com/a")).toBe("solo_https");
    expect(motivoUrlWebhookInvalida("https://localhost/a")).toBe("host_privado");
    expect(motivoUrlWebhookInvalida("https://127.0.0.1/a")).toBe("host_privado");
    expect(motivoUrlWebhookInvalida("https://10.1.2.3/a")).toBe("host_privado");
    expect(motivoUrlWebhookInvalida("https://192.168.0.5/a")).toBe("host_privado");
    expect(motivoUrlWebhookInvalida("https://169.254.169.254/latest")).toBe("host_privado");
    expect(motivoUrlWebhookInvalida("https://u:p@hooks.example.com/a")).toBe("credenciales_en_url");
    expect(motivoUrlWebhookInvalida("no-url")).toBe("url_invalida");
  });
  it("parsearDsnSentry rechaza http, sin clave o sin proyecto numerico", () => {
    expect(parsearDsnSentry("http://k@h.io/1")).toBeNull();
    expect(parsearDsnSentry("https://h.io/1")).toBeNull();
    expect(parsearDsnSentry("https://k@h.io/abc")).toBeNull();
    expect(parsearDsnSentry(undefined)).toBeNull();
  });
});

describe("crearDespachadorAlertas", () => {
  it("sin canales configurados no hace ninguna peticion", async () => {
    const f = fetchOk();
    const r = await crearDespachadorAlertas(config({}), { fetchImpl: f, limitador: limitador(2) }).notificar(ALERTA);
    expect(r.resultados).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it("correo: un envio por destinatario via Resend, redactado, con Idempotency-Key estable por hora", async () => {
    const f = fetchOk();
    const d = crearDespachadorAlertas(config({ correo: { ...RESEND, destinatarios: ["a@b.com", "c@d.mx"] } }), { fetchImpl: f, limitador: limitador(5), ahora: () => new Date("2026-09-30T10:15:00Z") });
    const r = await d.notificar(ALERTA);
    expect(r.resultados.map((x) => x.estado)).toEqual(["enviado", "enviado"]);
    expect(r.resultados[0]?.destino).toBe("***@b.com"); // nunca el correo completo
    expect(f).toHaveBeenCalledTimes(2);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(String(init.body)) as { to: string[]; text: string; html: string; subject: string };
    expect(body.to).toEqual(["a@b.com"]);
    for (const campo of [body.text, body.html, body.subject]) {
      expect(campo).not.toContain("hunter2");
      expect(campo).not.toContain("cliente@correo.com");
    }
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${RESEND.apiKey}`);
    expect(headers["Idempotency-Key"]).toMatch(/^alerta-[0-9a-f]{24}-2026093010$/);
    const k2 = (f.mock.calls[1]![1].headers as Record<string, string>)["Idempotency-Key"];
    expect(k2).not.toBe(headers["Idempotency-Key"]);
  });

  it("piso por hora: la 3a alerta del mismo tipo a los mismos destinos se suprime SIN llamar a la red", async () => {
    const f = fetchOk();
    const d = crearDespachadorAlertas(config({ correo: { ...RESEND, destinatarios: ["a@b.com"] }, webhook: { url: "https://hooks.example.com/x", secreto: null } }), { fetchImpl: f, limitador: limitador(2) });
    await d.notificar(ALERTA);
    await d.notificar(ALERTA);
    expect(f).toHaveBeenCalledTimes(4);
    const r = await d.notificar(ALERTA);
    expect(r.resultados.map((x) => x.estado)).toEqual(["suprimido_por_limite", "suprimido_por_limite"]);
    expect(f).toHaveBeenCalledTimes(4);
    // otro tipo de alerta sigue saliendo
    const otra = await d.notificar({ ...ALERTA, tipo: "cron_error:/internal/otro" });
    expect(otra.resultados.map((x) => x.estado)).toEqual(["enviado", "enviado"]);
  });

  it("webhook: JSON redactado y firmado con HMAC sobre timestamp.cuerpo; no sigue redirecciones", async () => {
    const f = fetchOk();
    const ahora = new Date("2026-09-30T10:00:00Z");
    const d = crearDespachadorAlertas(config({ webhook: { url: "https://hooks.example.com/x", secreto: "secreto-compartido" } }), { fetchImpl: f, limitador: limitador(2), ahora: () => ahora });
    const r = await d.notificar(ALERTA);
    expect(r.resultados[0]).toMatchObject({ canal: "webhook", destino: "hooks.example.com", estado: "enviado" });
    const [, init] = f.mock.calls[0]!;
    const cuerpo = String(init.body);
    expect(cuerpo).not.toContain("hunter2");
    expect(cuerpo).not.toContain("cliente@correo.com");
    expect(JSON.parse(cuerpo)).toMatchObject({ tipo: ALERTA.tipo, severidad: "alta", contexto: { token: "[redactado]", cron: "/internal/x" } });
    const h = init.headers as Record<string, string>;
    const ts = String(Math.floor(ahora.getTime() / 1000));
    expect(h["X-Atiende-Timestamp"]).toBe(ts);
    expect(h["X-Atiende-Signature"]).toBe(`sha256=${createHmac("sha256", "secreto-compartido").update(`${ts}.${cuerpo}`).digest("hex")}`);
    expect(init.redirect).toBe("error");
  });

  it("webhook sin secreto no manda firma; webhook invalido no hace peticion", async () => {
    const f = fetchOk();
    await crearDespachadorAlertas(config({ webhook: { url: "https://hooks.example.com/x", secreto: null } }), { fetchImpl: f, limitador: limitador(2) }).notificar(ALERTA);
    expect((f.mock.calls[0]![1].headers as Record<string, string>)["X-Atiende-Signature"]).toBeUndefined();
    const f2 = fetchOk();
    const r = await crearDespachadorAlertas(config({ webhook: { url: "https://127.0.0.1/x", secreto: null } }), { fetchImpl: f2, limitador: limitador(2) }).notificar(ALERTA);
    expect(r.resultados[0]).toMatchObject({ estado: "error", detalle: "host_privado" });
    expect(f2).not.toHaveBeenCalled();
  });

  it("Sentry: solo con DSN; envelope con huella por tipo, nivel y mensaje redactado", async () => {
    const f = fetchOk();
    const sentry = parsearDsnSentry(DSN);
    const r = await crearDespachadorAlertas(config({ sentry }), { fetchImpl: f, limitador: limitador(2) }).notificar({ ...ALERTA, severidad: "critica" });
    expect(r.resultados[0]).toMatchObject({ canal: "sentry", estado: "enviado" });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://o1.ingest.sentry.io/api/4501/envelope/");
    expect((init.headers as Record<string, string>)["X-Sentry-Auth"]).toContain("sentry_key=publickey123");
    const lineas = String(init.body).trim().split("\n");
    expect(lineas).toHaveLength(3);
    const evento = JSON.parse(lineas[2]!) as { level: string; fingerprint: string[]; message: string };
    expect(evento.level).toBe("fatal");
    expect(evento.fingerprint).toEqual([ALERTA.tipo]);
    expect(evento.message).not.toContain("hunter2");
  });

  it("un canal que falla (HTTP 500 o excepcion de red) no impide a los demas ni lanza", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes("resend")) throw new Error("red caida");
      return new Response("x", { status: 500 });
    });
    const d = crearDespachadorAlertas(config({ correo: { ...RESEND, destinatarios: ["a@b.com"] }, webhook: { url: "https://hooks.example.com/x", secreto: null } }), { fetchImpl: f, limitador: limitador(2) });
    const r = await d.notificar(ALERTA);
    expect(r.resultados).toEqual([
      { canal: "correo", destino: "***@b.com", estado: "error", detalle: "error_red" },
      { canal: "webhook", destino: "hooks.example.com", estado: "error", detalle: "http_500" },
    ]);
  });

  it("el detalle devuelto nunca contiene la API key ni el secreto", async () => {
    const f = vi.fn(async () => new Response("no", { status: 401 }));
    const d = crearDespachadorAlertas(config({ correo: { ...RESEND, destinatarios: ["a@b.com"] }, webhook: { url: "https://hooks.example.com/x", secreto: "secreto-compartido" } }), { fetchImpl: f, limitador: limitador(2) });
    expect(JSON.stringify(await d.notificar(ALERTA))).not.toMatch(/re_test_key|secreto-compartido/);
  });
});
