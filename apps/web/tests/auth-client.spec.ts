import { describe, expect, it, vi } from "vitest";
import {
  acceptInvite,
  clearSession,
  decideLandingPath,
  login,
  logout,
  LoginError,
  persistSession,
  readPersistedSession,
  validateAcceptInviteForm,
  validateLoginForm,
} from "../src/lib/auth-client.ts";
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
  // Hallazgo de auditoría (severidad ALTA, "el rol repartidor aterriza en un 403
  // tras login y no tiene forma de descubrir su panel"): con exactamente una
  // organización, un repartidor debe ir a su panel real, no al Dashboard de KPIs
  // (protegido por MANAGER_ROLES, donde recibiría 403).
  it("con exactamente una organización y rol repartidor -> entra directo a su panel", () => {
    const session = { ...base, organizations: [{ id: "1", slug: "los-taquitos-de-pm", nombre: "Los Taquitos de PM", vertical: "restaurantes", rol: "repartidor" }] };
    expect(decideLandingPath(session)).toBe("/restaurantes/los-taquitos-de-pm/repartidor");
  });
  // Hallazgo de auditoría (rubro 11/UX, MEDIO, "login cross-vertical manda al slug
  // equivocado"): POST /auth/login es genérico a las 6 verticales (mismo JWT), así
  // que alguien cuya única organización es de OTRA vertical puede autenticarse
  // igual en /restaurantes/login — esta función debe usar el `vertical` real de la
  // organización devuelta por el servidor, no asumir "restaurantes" por ser la
  // única que hoy la llama.
  it("usa el `vertical` real de la organización, no un hardcode de restaurantes", () => {
    const session = { ...base, organizations: [{ id: "1", slug: "hotel-del-mar", nombre: "Hotel del Mar", vertical: "hoteles", rol: "owner" }] };
    expect(decideLandingPath(session)).toBe("/hoteles/hotel-del-mar");
  });
});

// Fase 14 — hallazgo de auditoría (severidad ALTA, "Invitaciones de staff sin
// ninguna UI"): cliente real de POST /auth/accept-invite (routes/auth.ts).
describe("validateAcceptInviteForm", () => {
  it("exige token, fullName y una contraseña de al menos 8 caracteres", () => {
    expect(validateAcceptInviteForm({ token: "", fullName: "X", password: "12345678" })).toMatch(/token/i);
    expect(validateAcceptInviteForm({ token: "tok", fullName: "  ", password: "12345678" })).toMatch(/nombre/i);
    expect(validateAcceptInviteForm({ token: "tok", fullName: "X", password: "corta" })).toMatch(/8 caracteres/i);
    expect(validateAcceptInviteForm({ token: "tok", fullName: "X", password: "12345678" })).toBeNull();
  });
});

describe("acceptInvite", () => {
  it("llama POST /auth/accept-invite con el body correcto y devuelve la sesión ya autenticada", async () => {
    const session: LoginSession = {
      token: "t",
      refreshToken: "r",
      email: "invitado@x.mx",
      organizations: [{ id: "1", slug: "los-taquitos-de-pm", nombre: "Los Taquitos de PM", vertical: "restaurantes", rol: "repartidor" }],
    };
    const fetchImpl = fakeFetch(200, session);
    const result = await acceptInvite(fetchImpl, "http://api.local", { token: "  el-token  ", fullName: "  Invitado Real  ", password: "correcto-caballo-batería" });
    expect(result).toEqual(session);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://api.local/auth/accept-invite",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ token: "el-token", fullName: "Invitado Real", password: "correcto-caballo-batería" }) }),
    );
  });

  it("token inválido/expirado/ya usado (400 del servidor) -> mensaje real propagado", async () => {
    const fetchImpl = fakeFetch(400, { code: "staff_invite_token_invalido", message: "La invitación es inválida, ya fue usada/revocada, o expiró." });
    await expect(acceptInvite(fetchImpl, "http://api.local", { token: "x", fullName: "X", password: "12345678" })).rejects.toThrow(
      "La invitación es inválida, ya fue usada/revocada, o expiró.",
    );
  });

  it("nunca llama a fetch si la validación local ya falla (contraseña corta)", async () => {
    const fetchImpl = fakeFetch(200, {});
    await expect(acceptInvite(fetchImpl, "http://api.local", { token: "x", fullName: "X", password: "corta" })).rejects.toThrow(LoginError);
    expect(fetchImpl).not.toHaveBeenCalled();
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
