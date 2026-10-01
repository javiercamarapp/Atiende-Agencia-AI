// Cliente de "Chatea con tus datos" de citas: ruta correcta, token en el encabezado, refresh de sesion ante 401 (mismo
// mecanismo que el resto del panel de citas) y sugerencias dentro del catalogo. `fetch` inyectado: nada toca la red.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { citasChatBaseUrl, conexionChatDatosCitas, SUGERENCIAS_CITAS } from "../src/verticals/citas/lib/chat-datos-client.ts";
import { persistCitasSession, readPersistedCitasSession } from "../src/verticals/citas/lib/auth-client.ts";
import type { LoginSession, SessionStorageLike } from "../src/lib/auth-client.ts";

function fakeLocalStorage(): SessionStorageLike {
  const map = new Map<string, string>();
  return { setItem: (k, v) => void map.set(k, v), getItem: (k) => map.get(k) ?? null, removeItem: (k) => void map.delete(k) };
}
const SESSION: LoginSession = { token: "tok", refreshToken: "refresh", email: "a@b.mx", organizations: [] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const API = "https://api.example.test";
const OK = { status: "ok", text: "hola", blocks: [], sources: [], toolsUsed: [] };

describe("cliente de chat de citas", () => {
  const original = (globalThis as { localStorage?: unknown }).localStorage;
  beforeEach(() => {
    const storage = fakeLocalStorage();
    (globalThis as { localStorage?: unknown }).localStorage = storage;
    persistCitasSession(storage, SESSION);
  });
  afterEach(() => {
    if (original === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else (globalThis as { localStorage?: unknown }).localStorage = original;
  });

  it("la URL es /citas/:propertyId/chat-datos y el id se codifica", () => {
    expect(citasChatBaseUrl(API, "prop-1")).toBe(`${API}/citas/prop-1/chat-datos`);
    expect(citasChatBaseUrl(API, "a/b?c")).toBe(`${API}/citas/a%2Fb%3Fc/chat-datos`);
  });

  it("enviar: POST con Bearer y SOLO pregunta e historial (nunca organizacion, sucursal ni rol)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => (calls.push({ url, init }), json(200, OK))) as typeof fetch;
    const c = conexionChatDatosCitas(fetchImpl, API, "tok", "prop-1");
    expect(c.clave).toBe("prop-1");
    const r = await c.enviar("¿qué hay?", [{ role: "user", text: "antes" }]);
    expect(r.text).toBe("hola");
    expect(calls[0]!.url).toBe(`${API}/citas/prop-1/chat-datos`);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(Object.keys(JSON.parse(calls[0]!.init.body as string) as object).sort()).toEqual(["history", "question"]);
  });

  it("disponible: GET /estado; true solo con available=true, y 403 (rol staff)/500/red -> false (el boton sigue en 'Pronto')", async () => {
    const mk = (res: () => Promise<Response>) => (async () => res()) as unknown as typeof fetch;
    expect(await conexionChatDatosCitas(mk(async () => json(200, { available: true })), API, "tok", "p").disponible()).toBe(true);
    expect(await conexionChatDatosCitas(mk(async () => json(200, { available: false })), API, "tok", "p").disponible()).toBe(false);
    expect(await conexionChatDatosCitas(mk(async () => json(403, {})), API, "tok", "p").disponible()).toBe(false);
    expect(await conexionChatDatosCitas(mk(async () => json(500, {})), API, "tok", "p").disponible()).toBe(false);
    expect(await conexionChatDatosCitas(mk(async () => { throw new TypeError("offline"); }), API, "tok", "p").disponible()).toBe(false);
  });

  it("un 401 refresca la sesion UNA vez y reintenta", async () => {
    let n = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith("/auth/refresh")) return json(200, { token: "tok-nuevo", refreshToken: "refresh-nuevo", email: "a@b.mx", organizations: [] });
      n += 1;
      return n === 1 ? json(401, {}) : json(200, OK);
    }) as typeof fetch;
    const r = await conexionChatDatosCitas(fetchImpl, API, "tok", "p").enviar("q", []);
    expect(r.status).toBe("ok");
    expect(readPersistedCitasSession((globalThis as { localStorage: SessionStorageLike }).localStorage)?.token).toBe("tok-nuevo");
  });

  it("un error de red se muestra como aviso honesto, no como excepcion ni respuesta simulada", async () => {
    const fetchImpl = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    const r = await conexionChatDatosCitas(fetchImpl, API, "tok", "p").enviar("q", []);
    expect(r.status).toBe("unavailable");
    expect(r.blocks).toEqual([]);
  });

  it("las sugerencias son preguntas completas, sin duplicados, de longitud razonable y dentro del catalogo de citas", () => {
    expect(new Set(SUGERENCIAS_CITAS).size).toBe(SUGERENCIAS_CITAS.length);
    for (const s of SUGERENCIAS_CITAS) {
      expect(s).toMatch(/^¿.+\?$/);
      expect(s.length).toBeLessThanOrEqual(120);
      // todas dicen su periodo (esta semana, este mes, mes pasado, mañana)
      expect(s).toMatch(/esta semana|este mes|mes pasado|mañana/i);
    }
    const todo = SUGERENCIAS_CITAS.join(" ");
    for (const tema of [/citas/i, /ocupación/i, /cancel/i, /factur/i, /nuevos y recurrentes/i, /huecos libres/i, /recordatorios/i]) expect(todo).toMatch(tema);
  });
});
