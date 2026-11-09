// Ola 2 (seguridad), arreglo F.5 — cuando Resend rechaza un envío, el cuerpo de su respuesta puede repetir lo que
// se le mandó (destinatarios, parte del asunto o del contenido). Los logs solo pueden llevar el estado HTTP y el
// código de error de Resend (`name`, un identificador fijo como `validation_error`), nunca el cuerpo crudo ni su
// `message`. Cubre los dos envíos reales por Resend de la API: el correo del resumen diario
// (resumen-diario/correo.ts) y el enlace de acceso sin contraseña (routes/auth-magic-link.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryResumenDiarioRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { generarYPersistirResumenDiario } from "../src/resumen-diario/agregador.ts";
import { enviarCorreoResumenDiarioSiCorresponde } from "../src/resumen-diario/correo.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const CORREO_DESTINO = "superadmin-privado@example.com";
const MENSAJE_PROVEEDOR = `Invalid \`to\` field. The email address needs to follow the \`email@example.com\` format: ${CORREO_DESTINO} (asunto: Resumen diario)`;

function conResend(deps: AppDeps): AppDeps {
  return { ...deps, env: { ...deps.env, resend: { apiKey: "re_test_key", from: deps.env.resend.from } } };
}

function respuestaResend(status: number, cuerpo: string): Response {
  return new Response(cuerpo, { status, headers: { "content-type": "application/json" } });
}

function lineasDe(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((args: unknown[]) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")).join("\n");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resumen diario: error de Resend en logs sin PII ni cuerpo crudo", () => {
  async function enviarConRespuesta(respuesta: Response) {
    const base = await buildTestDeps();
    (base.deps.resumenDiarioRepo as InMemoryResumenDiarioRepository).seedPlatformSuperadminEmails([CORREO_DESTINO]);
    const deps = conResend(base.deps);
    const fecha = "2026-11-09";
    const generado = await generarYPersistirResumenDiario(deps, fecha);
    if (!generado.ok) throw new Error(`no se generó el resumen: ${generado.motivo}`);
    vi.stubGlobal("fetch", vi.fn(async () => respuesta));
    const errores = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const resultado = await enviarCorreoResumenDiarioSiCorresponde(deps, fecha, generado.agregados, generado.narrativa);
    return { resultado, logs: lineasDe(errores) };
  }

  it("422 JSON de Resend: registra estado y código, nunca el correo ni el mensaje del proveedor", async () => {
    const { resultado, logs } = await enviarConRespuesta(
      respuestaResend(422, JSON.stringify({ statusCode: 422, name: "validation_error", message: MENSAJE_PROVEEDOR })),
    );
    expect(resultado).toEqual({ enviado: false, motivo: "error_envio" });
    expect(logs).toContain("422");
    expect(logs).toContain("validation_error");
    expect(logs).not.toContain(CORREO_DESTINO);
    expect(logs).not.toContain("Invalid");
    expect(logs).not.toContain("Resumen diario");
  });

  it("cuerpo que no es JSON (p. ej. HTML de un proxy): solo el estado, sin el cuerpo", async () => {
    const { resultado, logs } = await enviarConRespuesta(respuestaResend(502, `<html><body>upstream error para ${CORREO_DESTINO}</body></html>`));
    expect(resultado.motivo).toBe("error_envio");
    expect(logs).toContain("502");
    expect(logs).not.toContain(CORREO_DESTINO);
    expect(logs).not.toContain("upstream");
  });

  it("un `name` que no es un identificador (texto libre) no se registra", async () => {
    const { logs } = await enviarConRespuesta(respuestaResend(400, JSON.stringify({ name: `fallo para ${CORREO_DESTINO}`, message: "x" })));
    expect(logs).toContain("400");
    expect(logs).not.toContain(CORREO_DESTINO);
    expect(logs).not.toContain("fallo para");
  });
});

describe("magic link: error de Resend en logs sin cuerpo crudo", () => {
  it("422 de Resend: el log lleva estado y código, nunca el mensaje del proveedor", async () => {
    const base = await buildTestDeps();
    const deps = conResend(base.deps);
    const app = buildApp(deps);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respuestaResend(422, JSON.stringify({ statusCode: 422, name: "validation_error", message: MENSAJE_PROVEEDOR }))),
    );
    const errores = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await app.request("/auth/magic-link/iniciar", jsonRequestInit({ email: base.ownerEmail, vertical: "restaurantes" }));
    expect(res.status).toBe(200);

    const logs = lineasDe(errores);
    expect(logs).toContain("magic_link_resend_fallo");
    expect(logs).toContain("422");
    expect(logs).toContain("validation_error");
    expect(logs).not.toContain("Invalid");
    expect(logs).not.toContain(base.ownerEmail);
  });
});
