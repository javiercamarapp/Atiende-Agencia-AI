import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  ImpersonationWriteBlockedError,
  blockWritesWhileImpersonating,
  isMutatingMethod,
  isWriteAllowedWhileImpersonating,
} from "../../src/index.ts";

describe("isMutatingMethod", () => {
  it("clasifica los 4 verbos mutantes y deja pasar el resto", () => {
    expect(isMutatingMethod("POST")).toBe(true);
    expect(isMutatingMethod("put")).toBe(true);
    expect(isMutatingMethod("PATCH")).toBe(true);
    expect(isMutatingMethod("DELETE")).toBe(true);
    expect(isMutatingMethod("GET")).toBe(false);
    expect(isMutatingMethod("HEAD")).toBe(false);
    expect(isMutatingMethod("OPTIONS")).toBe(false);
  });
});

describe("isWriteAllowedWhileImpersonating (regla pura)", () => {
  it("permite lecturas siempre, esté o no impersonando", () => {
    expect(isWriteAllowedWhileImpersonating({ method: "GET", path: "/x", isImpersonating: true })).toBe(true);
    expect(isWriteAllowedWhileImpersonating({ method: "GET", path: "/x", isImpersonating: false })).toBe(true);
  });

  it("permite escrituras cuando NO hay impersonación activa", () => {
    expect(isWriteAllowedWhileImpersonating({ method: "POST", path: "/x", isImpersonating: false })).toBe(true);
  });

  it("bloquea escrituras por default mientras hay impersonación activa (sin exemptPaths)", () => {
    expect(isWriteAllowedWhileImpersonating({ method: "POST", path: "/x", isImpersonating: true })).toBe(false);
    expect(isWriteAllowedWhileImpersonating({ method: "DELETE", path: "/x", isImpersonating: true })).toBe(false);
  });

  it("permite una escritura EXENTA explícitamente aunque haya impersonación activa", () => {
    expect(
      isWriteAllowedWhileImpersonating({
        method: "POST",
        path: "/superadmin/impersonacion/s1/terminar",
        isImpersonating: true,
        exemptPaths: new Set(["/superadmin/impersonacion/s1/terminar"]),
      }),
    ).toBe(true);
  });

  it("una ruta NO listada en exemptPaths sigue bloqueada aunque exista el set", () => {
    expect(
      isWriteAllowedWhileImpersonating({
        method: "POST",
        path: "/otra-ruta",
        isImpersonating: true,
        exemptPaths: new Set(["/superadmin/impersonacion/s1/terminar"]),
      }),
    ).toBe(false);
  });
});

interface TestEnv {
  Variables: { userId?: string };
}

function buildApp(opts: { isImpersonating: boolean; exemptPaths?: ReadonlySet<string> }) {
  const app = new Hono<TestEnv>();
  app.onError((err, c) => {
    if (err instanceof ImpersonationWriteBlockedError) {
      return c.json({ code: err.code, message: err.message }, 403);
    }
    throw err;
  });
  app.use(
    "*",
    blockWritesWhileImpersonating<TestEnv>({
      isImpersonating: () => opts.isImpersonating,
      exemptPaths: opts.exemptPaths,
    }),
  );
  app.get("/recurso", (c) => c.json({ leido: true }));
  app.post("/recurso", (c) => c.json({ escrito: true }));
  app.post("/superadmin/impersonacion/s1/terminar", (c) => c.json({ terminado: true }));
  return app;
}

describe("blockWritesWhileImpersonating (middleware Hono)", () => {
  it("deja pasar GET siempre", async () => {
    const app = buildApp({ isImpersonating: true });
    const res = await app.request("/recurso", { method: "GET" });
    expect(res.status).toBe(200);
  });

  it("deja pasar POST cuando no hay impersonación activa", async () => {
    const app = buildApp({ isImpersonating: false });
    const res = await app.request("/recurso", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ escrito: true });
  });

  it("bloquea POST con 403 tipado mientras hay impersonación activa", async () => {
    const app = buildApp({ isImpersonating: true });
    const res = await app.request("/recurso", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("impersonation_write_blocked");
  });

  it("deja pasar una ruta EXENTA (terminar sesión) aunque haya impersonación activa", async () => {
    const app = buildApp({
      isImpersonating: true,
      exemptPaths: new Set(["/superadmin/impersonacion/s1/terminar"]),
    });
    const res = await app.request("/superadmin/impersonacion/s1/terminar", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
