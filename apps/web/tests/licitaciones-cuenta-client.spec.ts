import { describe, expect, it, vi } from "vitest";
import {
  CUENTA_NO_DISPONIBLE,
  SESIONES_NO_DISPONIBLES,
  cambiarContrasena,
  cerrarSesion,
  confirmarRestablecerContrasena,
  confirmarVerificacionCorreo,
  describirDispositivo,
  desvincularGoogle,
  enviarVerificacionCorreo,
  fetchCuentaEstado,
  fetchSesiones,
  iniciarVinculoGoogle,
  solicitarRestablecerContrasena,
  validarNuevaContrasena,
} from "../src/verticals/licitaciones/lib/cuenta-client.ts";

const API = "http://api.local";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("fetchCuentaEstado / fetchSesiones (compatibilidad base sin migrar)", () => {
  it("devuelve el estado del servidor", async () => {
    const f = vi.fn(async () => json({ email: "a@x.mx", emailVerified: false, hasPassword: true, google: { configured: true, available: true, identities: [{ id: "g1", email: "g@gmail.com", linkedAt: "2026-01-01T00:00:00Z" }] } })) as unknown as typeof fetch;
    const s = await fetchCuentaEstado(f, API, "tok");
    expect(s).toMatchObject({ available: true, emailVerified: false, hasPassword: true });
    expect(s.google.identities).toHaveLength(1);
  });

  it("error de red o 5xx NUNCA lanza: cae a 'no disponible' (y no ofrece verificar un correo que no se sabe)", async () => {
    const boom = vi.fn(async () => {
      throw new Error("red caida");
    }) as unknown as typeof fetch;
    expect(await fetchCuentaEstado(boom, API, "tok")).toEqual(CUENTA_NO_DISPONIBLE);
    expect(CUENTA_NO_DISPONIBLE.emailVerified).toBe(true);
    expect(await fetchCuentaEstado(vi.fn(async () => json({ message: "x" }, 500)) as unknown as typeof fetch, API, "tok")).toEqual(CUENTA_NO_DISPONIBLE);
    expect(await fetchSesiones(boom, API, "tok")).toEqual(SESIONES_NO_DISPONIBLES);
  });

  it("sesiones: available:false del servidor se respeta", async () => {
    const f = vi.fn(async () => json({ available: false, sessions: [] })) as unknown as typeof fetch;
    expect(await fetchSesiones(f, API, "tok")).toEqual({ available: false, sessions: [] });
  });
});

describe("acciones", () => {
  it("cerrar sesion / desvincular Google envian el id y NUNCA un id de cuenta", async () => {
    const f = vi.fn(async () => json({ ok: true })) as unknown as typeof fetch;
    await cerrarSesion(f, API, "tok", "sid-1");
    await desvincularGoogle(f, API, "tok", "gid-1", "mi-clave");
    const calls = (f as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    expect(calls[0]![0]).toBe(`${API}/auth/sessions/cerrar`);
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ sessionId: "sid-1" });
    expect(calls[1]![0]).toBe(`${API}/auth/google/desvincular`);
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ identityId: "gid-1", password: "mi-clave" });
  });

  it("cambiar contrasena y errores del servidor llegan con su mensaje real", async () => {
    const f = vi.fn(async () => json({ code: "current_password_invalid", message: "La contraseña actual no es correcta." }, 422)) as unknown as typeof fetch;
    await expect(cambiarContrasena(f, API, "tok", "x", "nueva-clave-1")).rejects.toThrow("La contraseña actual no es correcta.");
  });

  it("restablecer: solicitar y confirmar son POST sin Authorization; el error del servidor se propaga", async () => {
    const f = vi.fn(async () => json({ ok: true })) as unknown as typeof fetch;
    await solicitarRestablecerContrasena(f, API, "a@x.mx");
    await confirmarRestablecerContrasena(f, API, "tok-enlace", "clave-nueva-1");
    const calls = (f as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ email: "a@x.mx", vertical: "licitaciones" });
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ token: "tok-enlace", newPassword: "clave-nueva-1" });
    expect(JSON.stringify(calls[1]![1].headers)).not.toMatch(/authorization/i);
    const malo = vi.fn(async () => json({ message: "El enlace es inválido, ya se usó o expiró." }, 400)) as unknown as typeof fetch;
    await expect(confirmarRestablecerContrasena(malo, API, "t", "clave-nueva-1")).rejects.toThrow("ya se usó o expiró");
    await expect(confirmarVerificacionCorreo(malo, API, "t")).rejects.toThrow("ya se usó o expiró");
  });

  it("enviar verificacion: sent es honesto", async () => {
    const f = vi.fn(async () => json({ ok: true, alreadyVerified: false, sent: false })) as unknown as typeof fetch;
    expect(await enviarVerificacionCorreo(f, API, "tok")).toEqual({ alreadyVerified: false, sent: false });
    const ya = vi.fn(async () => json({ ok: true, alreadyVerified: true })) as unknown as typeof fetch;
    expect(await enviarVerificacionCorreo(ya, API, "tok")).toEqual({ alreadyVerified: true, sent: false });
  });

  it("vincular Google devuelve la URL del servidor", async () => {
    const f = vi.fn(async () => json({ url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" })) as unknown as typeof fetch;
    expect(await iniciarVinculoGoogle(f, API, "tok", "demo")).toContain("accounts.google.com");
    expect(JSON.parse((f as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]![1].body as string)).toEqual({ orgSlug: "demo" });
  });
});

describe("validarNuevaContrasena", () => {
  it.each([
    ["corta", "abc", "abc", undefined, "al menos 8"],
    ["no coincide", "clave-larga-1", "clave-larga-2", undefined, "no coinciden"],
    ["igual a la actual", "clave-larga-1", "clave-larga-1", "clave-larga-1", "distinta"],
    ["demasiado larga", "x".repeat(201), "x".repeat(201), undefined, "200"],
  ])("%s -> error", (_n, nueva, conf, actual, texto) => {
    expect(validarNuevaContrasena(nueva, conf, actual)).toContain(texto);
  });
  it("valida una contrasena correcta", () => {
    expect(validarNuevaContrasena("clave-larga-1", "clave-larga-1", "otra")).toBeNull();
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
