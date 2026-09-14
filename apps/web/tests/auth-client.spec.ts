import { describe, expect, it, vi } from "vitest";
import { clearSession, decideLandingPath, login, logout, LoginError, persistSession, readPersistedSession, validateLoginForm } from "../src/lib/auth-client.ts";
import type { LoginSession, SessionStorageLike } from "../src/lib/auth-client.ts";

function fakeStorage(): SessionStorageLike {
  const map = new Map<string, string>();
  return {
    setItem: (k, v) => void map.set(k, v),
    getItem: (k) => map.get(k) ?? null,
    removeItem: (k) => void map.delete(k),
  };
}

function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("validateLoginForm", () => {
  it("exige correo y contraseña no vacíos, y un correo con forma válida", () => {
    expect(validateLoginForm("", "x")).toMatch(/correo/i);
    expect(validateLoginForm("no-es-email", "x")).toMatch(/válido/i);
    expect(validateLoginForm("a@b.com", "")).toMatch(/contraseña/i);
    expect(validateLoginForm("a@b.com", "x")).toBeNull();
  });
});

describe("login", () => {
  it("llama POST /auth/login con el body correcto y devuelve la sesión", async () => {
    const session: LoginSession = { token: "t", refreshToken: "r", email: "a@b.com", organizations: [] };
    const fetchImpl = fakeFetch(200, session);
    const result = await login(fetchImpl, "http://api.local", "A@B.com", "secreta");
    expect(result).toEqual(session);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://api.local/auth/login",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ email: "a@b.com", password: "secreta" }) }),
    );
  });

  it("401 se traduce a un mensaje claro, sin filtrar si fue el correo o la contraseña", async () => {
    const fetchImpl = fakeFetch(401, { code: "unauthorized", message: "Correo o contraseña incorrectos." });
    await expect(login(fetchImpl, "http://api.local", "a@b.com", "mala")).rejects.toThrow(LoginError);
  });

  it("403 (correo sin verificar) propaga el mensaje real del servidor", async () => {
    const fetchImpl = fakeFetch(403, { code: "forbidden", message: "Todavía no confirmas tu correo." });
    await expect(login(fetchImpl, "http://api.local", "a@b.com", "x")).rejects.toThrow("Todavía no confirmas tu correo.");
  });

  it("nunca llama a fetch si la validación local ya falla (correo vacío)", async () => {
    const fetchImpl = fakeFetch(200, {});
    await expect(login(fetchImpl, "http://api.local", "", "x")).rejects.toThrow(LoginError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// Hallazgo de auditoría (severidad ALTA, "sin logout explícito en el panel de
// hoteles") — ver POST /auth/logout en apps/api/src/routes/auth.ts.
describe("logout", () => {
  it("llama POST /auth/logout con el refreshToken en el body", async () => {
    const fetchImpl = fakeFetch(200, { ok: true });
    await logout(fetchImpl, "http://api.local", "un-refresh-token");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://api.local/auth/logout",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ refreshToken: "un-refresh-token" }) }),
    );
  });

  it("best-effort: nunca lanza aunque la red falle (el logout local no puede depender de este POST)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(logout(fetchImpl, "http://api.local", "un-refresh-token")).resolves.toBeUndefined();
  });

  it("best-effort: nunca lanza aunque el servidor responda con error", async () => {
    const fetchImpl = fakeFetch(500, { code: "internal_error" });
    await expect(logout(fetchImpl, "http://api.local", "un-refresh-token")).resolves.toBeUndefined();
  });
});

describe("decideLandingPath", () => {
  const base: LoginSession = { token: "t", refreshToken: "r", email: "a@b.com", organizations: [] };
  it("sin organizaciones -> /sin-organizacion", () => {
    expect(decideLandingPath(base)).toBe("/sin-organizacion");
  });
  it("con exactamente una organización -> entra directo a su slug", () => {
    const session = { ...base, organizations: [{ id: "1", slug: "los-taquitos-de-pm", nombre: "Los Taquitos de PM", vertical: "restaurantes", rol: "owner" }] };
    expect(decideLandingPath(session)).toBe("/restaurantes/los-taquitos-de-pm");
  });
  it("con 2+ organizaciones -> selector (igual que hoteles con multi-hotel)", () => {
    const org = { id: "1", slug: "a", nombre: "A", vertical: "restaurantes", rol: "owner" };
    expect(decideLandingPath({ ...base, organizations: [org, { ...org, id: "2", slug: "b" }] })).toBe("/seleccionar-organizacion");
  });
});

describe("persistSession / readPersistedSession / clearSession", () => {
  it("guarda y relee la sesión real (round-trip)", () => {
    const storage = fakeStorage();
    const session: LoginSession = { token: "t", refreshToken: "r", email: "a@b.com", organizations: [] };
    persistSession(storage, session);
    expect(readPersistedSession(storage)).toEqual(session);
  });

  it("null si no hay sesión guardada o el valor guardado está corrupto", () => {
    const storage = fakeStorage();
    expect(readPersistedSession(storage)).toBeNull();
    storage.setItem("atiende.restaurantes.session", "{no es json valido");
    expect(readPersistedSession(storage)).toBeNull();
  });

  it("clearSession borra la sesión guardada", () => {
    const storage = fakeStorage();
    persistSession(storage, { token: "t", refreshToken: "r", email: "a@b.com", organizations: [] });
    clearSession(storage);
    expect(readPersistedSession(storage)).toBeNull();
  });
});
