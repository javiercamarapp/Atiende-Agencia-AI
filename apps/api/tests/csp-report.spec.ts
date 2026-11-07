// POST /v1/csp-report: colector de violaciones de la CSP de la SPA. Solo registra un resumen sin datos
// personales (origen del recurso, ruta del documento sin query), en los dos formatos de navegador.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ApiError } from "@atiende/core-auth";
import { CSP_REPORT_PATH, cspReportRoutes, extraerViolaciones, resumirBloqueado, resumirDocumento } from "../src/routes/csp-report.ts";

afterEach(() => vi.restoreAllMocks());

function app() {
  const a = new Hono();
  a.onError((err, c) => (err instanceof ApiError ? c.json({ code: err.code }, err.status as 400 | 413 | 429) : c.json({ code: "internal_error" }, 500)));
  a.route("/", cspReportRoutes());
  return a;
}

let ip = 0;
function enviar(cuerpo: string, tipo = "application/csp-report") {
  ip += 1;
  return app().request(CSP_REPORT_PATH, { method: "POST", body: cuerpo, headers: { "content-type": tipo, "content-length": String(new TextEncoder().encode(cuerpo).byteLength), "x-forwarded-for": `10.0.0.${ip}` } });
}

describe("resumen sin PII", () => {
  it("el recurso bloqueado se reduce a su origen o palabra clave", () => {
    expect(resumirBloqueado("https://evil.example.com/x.js?token=abc")).toBe("https://evil.example.com");
    expect(resumirBloqueado("inline")).toBe("inline");
    expect(resumirBloqueado("eval")).toBe("eval");
    expect(resumirBloqueado("data:image/png;base64,AAAA")).toBe("data");
    expect(resumirBloqueado("blob:https://app.useatiende.ai/123")).toBe("blob");
    expect(resumirBloqueado("")).toBe("desconocido");
    expect(resumirBloqueado("no es url")).toBe("invalido");
  });
  it("del documento solo queda la ruta, nunca la query ni el fragmento", () => {
    expect(resumirDocumento("https://app.useatiende.ai/auth/magic?token=secreto#x")).toBe("/auth/magic");
    expect(resumirDocumento("basura")).toBe("desconocido");
  });
});

describe("extraerViolaciones", () => {
  it("formato report-uri", () => {
    expect(
      extraerViolaciones({ "csp-report": { "document-uri": "https://app.useatiende.ai/restaurantes/x?y=1", "violated-directive": "script-src-elem", "effective-directive": "script-src-elem", "blocked-uri": "https://cdn.example.com/a.js", disposition: "enforce", "script-sample": "alert(1)" } }),
    ).toEqual([{ directiva: "script-src-elem", bloqueado: "https://cdn.example.com", documento: "/restaurantes/x", disposicion: "enforce" }]);
  });
  it("formato Reporting API (lista), ignora otros tipos y topa a 10", () => {
    const uno = { type: "csp-violation", body: { documentURL: "https://app.useatiende.ai/superadmin", effectiveDirective: "connect-src", blockedURL: "wss://otro.example.com/ws", disposition: "enforce", sample: "x" } };
    expect(extraerViolaciones([uno, { type: "deprecation", body: {} }])).toEqual([{ directiva: "connect-src", bloqueado: "wss://otro.example.com", documento: "/superadmin", disposicion: "enforce" }]);
    expect(extraerViolaciones(Array.from({ length: 30 }, () => uno))).toHaveLength(10);
  });
  it("cuerpos desconocidos no producen nada", () => {
    expect(extraerViolaciones({ hola: 1 })).toEqual([]);
    expect(extraerViolaciones("x")).toEqual([]);
  });
});

describe("POST /v1/csp-report", () => {
  it("204 y una linea de log por violacion, sin la query ni el sample", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await enviar(JSON.stringify({ "csp-report": { "document-uri": "https://app.useatiende.ai/a?token=secreto", "effective-directive": "img-src", "blocked-uri": "http://x.example/p.png", "script-sample": "secreto" } }));
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    const linea = String(warn.mock.calls[0]?.[0]);
    expect(linea).toContain('"evento":"csp_violacion"');
    expect(linea).toContain('"documento":"/a"');
    expect(linea).not.toContain("secreto");
  });
  it("JSON invalido -> 400; cuerpo demasiado grande -> 413", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await enviar("{no json")).status).toBe(400);
    expect((await enviar(JSON.stringify({ "csp-report": { x: "a".repeat(20_000) } }))).status).toBe(413);
  });
  it("rate limit por IP: pasada la rafaga responde 429", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = app();
    const cuerpo = JSON.stringify([]);
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++) {
      const res = await a.request(CSP_REPORT_PATH, { method: "POST", body: cuerpo, headers: { "content-type": "application/reports+json", "content-length": String(cuerpo.length), "x-forwarded-for": "10.9.9.9" } });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 204)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
