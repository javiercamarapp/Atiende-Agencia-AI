import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { esProduccion, loadApiEnv, REMITENTE_DESARROLLO, resolveAppBaseUrl, resolveResend } from "../src/env.ts";
import { missingStartupVars } from "../src/integrations-status.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe("esProduccion", () => {
  it("VERCEL_ENV manda; sin VERCEL_ENV decide NODE_ENV", () => {
    expect(esProduccion({ VERCEL_ENV: "production" })).toBe(true);
    expect(esProduccion({ VERCEL_ENV: "preview", NODE_ENV: "production" })).toBe(false);
    expect(esProduccion({ NODE_ENV: "production" })).toBe(true);
    expect(esProduccion({ NODE_ENV: "development" })).toBe(false);
    expect(esProduccion({})).toBe(false);
  });
});

describe("resolveAppBaseUrl", () => {
  it("produccion sin APP_BASE_URL: lanza con mensaje claro", () => {
    expect(() => resolveAppBaseUrl({ VERCEL_ENV: "production" })).toThrow(/APP_BASE_URL/);
    expect(() => resolveAppBaseUrl({ NODE_ENV: "production", APP_BASE_URL: "   " })).toThrow(/APP_BASE_URL/);
  });
  it("produccion con http:// o sin esquema: lanza", () => {
    expect(() => resolveAppBaseUrl({ VERCEL_ENV: "production", APP_BASE_URL: "http://app.ejemplo.mx" })).toThrow(/https/);
    expect(() => resolveAppBaseUrl({ VERCEL_ENV: "production", APP_BASE_URL: "app.ejemplo.mx" })).toThrow(/https/);
  });
  it("produccion con https://: la usa sin barra final", () => {
    expect(resolveAppBaseUrl({ VERCEL_ENV: "production", APP_BASE_URL: "https://app.ejemplo.mx//" })).toBe("https://app.ejemplo.mx");
  });
  it("desarrollo sin ella: https://VERCEL_URL y, si no hay, localhost", () => {
    expect(resolveAppBaseUrl({ VERCEL_ENV: "preview", VERCEL_URL: "mi-app-git-x.vercel.app" })).toBe("https://mi-app-git-x.vercel.app");
    expect(resolveAppBaseUrl({ VERCEL_URL: "https://x.vercel.app/" })).toBe("https://x.vercel.app");
    expect(resolveAppBaseUrl({})).toBe("http://localhost:5173");
  });
  it("desarrollo con ella: la respeta aunque sea http", () => {
    expect(resolveAppBaseUrl({ APP_BASE_URL: "http://localhost:3000/", VERCEL_URL: "x.vercel.app" })).toBe("http://localhost:3000");
  });
  it("nunca devuelve un dominio por omision", () => {
    for (const env of [{}, { VERCEL_ENV: "preview" }, { VERCEL_URL: "x.vercel.app" }]) {
      expect(resolveAppBaseUrl(env)).not.toContain("atiende.ai");
    }
  });
});

describe("resolveResend", () => {
  it("produccion con llave y sin remitente: integracion no configurada (apiKey null, sin remitente inventado)", () => {
    expect(resolveResend({ VERCEL_ENV: "production", RESEND_API_KEY: "re_x" })).toEqual({ apiKey: null, from: "" });
  });
  it("produccion con llave y remitente: configurada", () => {
    expect(resolveResend({ VERCEL_ENV: "production", RESEND_API_KEY: "re_x", RESEND_FROM_EMAIL: "Taquitos <hola@taquitos.mx>" })).toEqual({
      apiKey: "re_x",
      from: "Taquitos <hola@taquitos.mx>",
    });
  });
  it("produccion sin llave: apiKey null", () => {
    expect(resolveResend({ VERCEL_ENV: "production", RESEND_FROM_EMAIL: "a@b.mx" }).apiKey).toBeNull();
  });
  it("desarrollo sin remitente: remitente de pruebas de Resend, nunca un dominio sin verificar", () => {
    expect(resolveResend({ RESEND_API_KEY: "re_x" })).toEqual({ apiKey: "re_x", from: REMITENTE_DESARROLLO });
    expect(REMITENTE_DESARROLLO).not.toContain("atiende.ai");
  });
});

describe("loadApiEnv (lee process.env)", () => {
  const BASE: Record<string, string> = {
    JWT_SECRET: "j",
    VOICE_TOOL_SECRET: "v",
    WHATSAPP_VERIFY_TOKEN: "w",
    WHATSAPP_APP_SECRET: "a",
    INTERNAL_SECRET: "i",
    RENTAS_OWNER_JWT_SECRET: "r",
  };
  const original = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in original)) delete process.env[k];
    Object.assign(process.env, original);
  });
  function setEnv(extra: Record<string, string | undefined>): void {
    for (const k of ["APP_BASE_URL", "VERCEL_ENV", "VERCEL_URL", "NODE_ENV", "RESEND_API_KEY", "RESEND_FROM_EMAIL"]) delete process.env[k];
    for (const [k, v] of Object.entries({ ...BASE, ...extra })) if (v !== undefined) process.env[k] = v;
  }

  it("produccion sin APP_BASE_URL: la API no arranca", () => {
    setEnv({ VERCEL_ENV: "production" });
    expect(() => loadApiEnv()).toThrow(/APP_BASE_URL/);
  });
  it("produccion con http://: no arranca", () => {
    setEnv({ VERCEL_ENV: "production", APP_BASE_URL: "http://app.ejemplo.mx" });
    expect(() => loadApiEnv()).toThrow(/https/);
  });
  it("produccion correcta: arranca con el origen indicado", () => {
    setEnv({ VERCEL_ENV: "production", APP_BASE_URL: "https://app.ejemplo.mx/", RESEND_API_KEY: "re_x", RESEND_FROM_EMAIL: "a@ejemplo.mx" });
    const env = loadApiEnv();
    expect(env.appBaseUrl).toBe("https://app.ejemplo.mx");
    expect(env.resend).toEqual({ apiKey: "re_x", from: "a@ejemplo.mx" });
  });
  it("desarrollo sin APP_BASE_URL: localhost, o VERCEL_URL si existe", () => {
    setEnv({});
    expect(loadApiEnv().appBaseUrl).toBe("http://localhost:5173");
    setEnv({ VERCEL_ENV: "preview", VERCEL_URL: "x.vercel.app" });
    expect(loadApiEnv().appBaseUrl).toBe("https://x.vercel.app");
  });
});

describe("missingStartupVars en produccion", () => {
  const OBLIG = { JWT_SECRET: "x", VOICE_TOOL_SECRET: "x", WHATSAPP_VERIFY_TOKEN: "x", WHATSAPP_APP_SECRET: "x", INTERNAL_SECRET: "x", RENTAS_OWNER_JWT_SECRET: "x", DATABASE_URL: "x" };
  it("incluye APP_BASE_URL solo en produccion", () => {
    expect(missingStartupVars({ ...OBLIG, VERCEL_ENV: "production" })).toEqual(["APP_BASE_URL"]);
    expect(missingStartupVars({ ...OBLIG, VERCEL_ENV: "production", APP_BASE_URL: "https://a.mx" })).toEqual([]);
    expect(missingStartupVars({ ...OBLIG })).toEqual([]);
  });
});

describe("ninguna ruta del codigo conserva el dominio por omision ajeno", () => {
  function walk(dir: string, out: string[]): void {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
  }
  it("apps/api/src no contiene app.atiende.ai ni notificaciones@atiende.ai", () => {
    const files: string[] = [];
    walk(path.resolve(HERE, "..", "src"), files);
    const ofensores = files.filter((f) => /app\.atiende\.ai|notificaciones@atiende\.ai/.test(readFileSync(f, "utf8")));
    expect(ofensores.map((f) => path.relative(HERE, f))).toEqual([]);
  });
});
