import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CUENTA_NO_DISPONIBLE,
  SESIONES_NO_DISPONIBLES,
  VERTICALES_CUENTA,
  claveSesion,
  clienteCuenta,
  confirmarRestablecerContrasena,
  confirmarVerificacionCorreo,
  describirDispositivo,
  esVerticalCuenta,
  solicitarRestablecerContrasena,
  validarNuevaContrasena,
} from "../src/shell/cuenta/cuenta-client.ts";

const API = "http://api.local";
const cuenta = clienteCuenta("licitaciones");
const { fetchCuentaEstado, fetchSesiones, cerrarSesion, desvincularGoogle, cambiarContrasena, enviarVerificacionCorreo, iniciarVinculoGoogle } = cuenta;

// Credenciales y tokens de prueba generados en cada corrida: ningun literal con forma de secreto en el repo.
const u = (p: string) => `${p}-${randomUUID()}`;
const TOKEN = u("t");
const ENLACE = u("e");
const PW_ACTUAL = u("a");
const PW_NUEVA = u("n");
const PW_OTRA = u("o");


function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("fetchCuentaEstado / fetchSesiones (compatibilidad base sin migrar)", () => {
  it("devuelve el estado del servidor", async () => {
    const f = vi.fn(async () => json({ email: "a@x.mx", emailVerified: false, hasPassword: true, google: { configured: true, available: true, identities: [{ id: "g1", email: "g@gmail.com", linkedAt: "2026-01-01T00:00:00Z" }] } })) as unknown as typeof fetch;
    const s = await fetchCuentaEstado(f, API, TOKEN);
    expect(s).toMatchObject({ available: true, emailVerified: false, hasPassword: true });
    expect(s.google.identities).toHaveLength(1);
  });

  it("error de red o 5xx NUNCA lanza: cae a 'no disponible' (y no ofrece verificar un correo que no se sabe)", async () => {
    const boom = vi.fn(async () => {
      throw new Error("red caida");
    }) as unknown as typeof fetch;
    expect(await fetchCuentaEstado(boom, API, TOKEN)).toEqual(CUENTA_NO_DISPONIBLE);
    expect(CUENTA_NO_DISPONIBLE.emailVerified).toBe(true);
    expect(await fetchCuentaEstado(vi.fn(async () => json({ message: "x" }, 500)) as unknown as typeof fetch, API, TOKEN)).toEqual(CUENTA_NO_DISPONIBLE);
    expect(await fetchSesiones(boom, API, TOKEN)).toEqual(SESIONES_NO_DISPONIBLES);
  });

  it("sesiones: available:false del servidor se respeta", async () => {
    const f = vi.fn(async () => json({ available: false, sessions: [] })) as unknown as typeof fetch;
    expect(await fetchSesiones(f, API, TOKEN)).toEqual({ available: false, sessions: [] });
  });
});

describe("acciones", () => {
  it("cerrar sesion / desvincular Google envian el id y NUNCA un id de cuenta", async () => {
    const f = vi.fn(async () => json({ ok: true })) as unknown as typeof fetch;
    await cerrarSesion(f, API, TOKEN, "sid-1");
    await desvincularGoogle(f, API, TOKEN, "gid-1", PW_ACTUAL);
    const calls = (f as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    expect(calls[0]![0]).toBe(`${API}/auth/sessions/cerrar`);
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ sessionId: "sid-1" });
    expect(calls[1]![0]).toBe(`${API}/auth/google/desvincular`);
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ identityId: "gid-1", password: PW_ACTUAL });
  });

  it("cambiar contrasena y errores del servidor llegan con su mensaje real", async () => {
    const f = vi.fn(async () => json({ code: "current_password_invalid", message: "La contraseña actual no es correcta." }, 422)) as unknown as typeof fetch;
    await expect(cambiarContrasena(f, API, TOKEN, PW_ACTUAL, PW_NUEVA)).rejects.toThrow("La contraseña actual no es correcta.");
  });

  it("restablecer: solicitar y confirmar son POST sin Authorization; el error del servidor se propaga", async () => {
    const f = vi.fn(async () => json({ ok: true })) as unknown as typeof fetch;
    await solicitarRestablecerContrasena(f, API, "a@x.mx", "licitaciones");
    await confirmarRestablecerContrasena(f, API, ENLACE, PW_NUEVA);
    const calls = (f as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ email: "a@x.mx", vertical: "licitaciones" });
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ token: ENLACE, newPassword: PW_NUEVA });
    expect(JSON.stringify(calls[1]![1].headers)).not.toMatch(/authorization/i);
    const malo = vi.fn(async () => json({ message: "El enlace es inválido, ya se usó o expiró." }, 400)) as unknown as typeof fetch;
    await expect(confirmarRestablecerContrasena(malo, API, TOKEN, PW_NUEVA)).rejects.toThrow("ya se usó o expiró");
    await expect(confirmarVerificacionCorreo(malo, API, TOKEN)).rejects.toThrow("ya se usó o expiró");
  });

  it("enviar verificacion: sent es honesto", async () => {
    const f = vi.fn(async () => json({ ok: true, alreadyVerified: false, sent: false })) as unknown as typeof fetch;
    expect(await enviarVerificacionCorreo(f, API, TOKEN)).toEqual({ alreadyVerified: false, sent: false });
    const ya = vi.fn(async () => json({ ok: true, alreadyVerified: true })) as unknown as typeof fetch;
    expect(await enviarVerificacionCorreo(ya, API, TOKEN)).toEqual({ alreadyVerified: true, sent: false });
  });

  it("vincular Google devuelve la URL del servidor", async () => {
    const f = vi.fn(async () => json({ url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" })) as unknown as typeof fetch;
    expect(await iniciarVinculoGoogle(f, API, TOKEN, "demo")).toContain("accounts.google.com");
    expect(JSON.parse((f as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]![1].body as string)).toEqual({ orgSlug: "demo", vertical: "licitaciones" });
  });
});

describe("validarNuevaContrasena", () => {
  it.each([
    ["corta", "abc", "abc", undefined, "al menos 8"],
    ["no coincide", PW_NUEVA, PW_OTRA, undefined, "no coinciden"],
    ["igual a la actual", PW_NUEVA, PW_NUEVA, PW_NUEVA, "distinta"],
    ["demasiado larga", "x".repeat(201), "x".repeat(201), undefined, "200"],
  ])("%s -> error", (_n, nueva, conf, actual, texto) => {
    expect(validarNuevaContrasena(nueva, conf, actual)).toContain(texto);
  });
  it("valida una contrasena correcta", () => {
    expect(validarNuevaContrasena(PW_NUEVA, PW_NUEVA, PW_ACTUAL)).toBeNull();
  });
});

describe("describirDispositivo", () => {
  it.each([
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", "Chrome en macOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", "Safari en iOS"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36 Edg/124.0", "Edge en Windows"],
    ["curl/8.0", "Dispositivo desconocido"],
  ])("%s", (ua, esperado) => {
    expect(describirDispositivo(ua)).toBe(esperado);
  });
  it("null -> desconocido", () => {
    expect(describirDispositivo(null)).toBe("Dispositivo desconocido");
  });
});

describe("compartido por las 6 verticales (PL-21)", () => {
  it("la lista cerrada de verticales coincide con las 6 del servidor y esVerticalCuenta rechaza el resto", () => {
    expect([...VERTICALES_CUENTA].sort()).toEqual(["citas", "despachos", "hoteles", "licitaciones", "rentas", "restaurantes"]);
    for (const v of VERTICALES_CUENTA) expect(esVerticalCuenta(v)).toBe(true);
    for (const malo of ["", "superadmin", "../x", "Citas"]) expect(esVerticalCuenta(malo)).toBe(false);
  });

  it.each(VERTICALES_CUENTA)("%s: la llave de sesion es la misma que usa el auth-client de la vertical", (v) => {
    expect(claveSesion(v)).toBe(`atiende.${v}.session`);
  });

  it.each(VERTICALES_CUENTA)("%s: 'olvide mi contrasena', verificar correo y vincular Google mandan SU vertical al servidor", async (v) => {
    const f = vi.fn(async (url: string) => json(url.endsWith("/vincular/iniciar") ? { url: "https://accounts.google.com/x" } : { ok: true, sent: true })) as unknown as typeof fetch;
    await solicitarRestablecerContrasena(f, API, "a@x.mx", v);
    const c = clienteCuenta(v);
    await c.enviarVerificacionCorreo(f, API, TOKEN);
    await c.iniciarVinculoGoogle(f, API, TOKEN, "demo");
    const bodies = (f as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls.map(([, init]) => JSON.parse(init.body as string));
    expect(bodies[0]).toEqual({ email: "a@x.mx", vertical: v });
    expect(bodies[1]).toEqual({ vertical: v });
    expect(bodies[2]).toEqual({ orgSlug: "demo", vertical: v });
  });

  it("solicitar el restablecimiento: un error del servidor (p. ej. demasiados intentos) SI llega, nunca se traga", async () => {
    const f = vi.fn(async () => json({ message: "Demasiados intentos. Intenta de nuevo en unos minutos." }, 429)) as unknown as typeof fetch;
    await expect(solicitarRestablecerContrasena(f, API, "a@x.mx", "citas")).rejects.toThrow("Demasiados intentos");
  });

  it("cerrar las demas por corte (base sin migrar) llama a /auth/revoke-sessions y falla con el estado real", async () => {
    const f = vi.fn(async () => json({}, 500)) as unknown as typeof fetch;
    await expect(cuenta.cerrarOtrasSesionesPorCorte(f, API, TOKEN)).rejects.toThrow("(500)");
    expect((f as unknown as { mock: { calls: Array<[string]> } }).mock.calls[0]![0]).toBe(`${API}/auth/revoke-sessions`);
  });
});
