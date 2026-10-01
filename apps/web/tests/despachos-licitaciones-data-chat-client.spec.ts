// Clientes de "Chatea con tus datos" de despachos y licitaciones: rutas correctas, token en el encabezado,
// refresh de sesion ante 401 (mismo mecanismo que el resto de cada panel) y sugerencias dentro del catalogo.
// `fetch` inyectado: nada toca la red.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conexionChatDatosDespachos, despachosChatBaseUrl, SUGERENCIAS_DESPACHOS } from "../src/verticals/despachos/lib/chat-datos-client.ts";
import { conexionChatDatosLicitaciones, licitacionesChatBaseUrl, SUGERENCIAS_LICITACIONES } from "../src/verticals/licitaciones/lib/chat-datos-client.ts";
import { persistDespachosSession, readPersistedDespachosSession } from "../src/verticals/despachos/lib/auth-client.ts";
import { persistLicitacionesSession, readPersistedLicitacionesSession } from "../src/verticals/licitaciones/lib/auth-client.ts";
import type { LoginSession, SessionStorageLike } from "../src/lib/auth-client.ts";

function fakeLocalStorage(): SessionStorageLike {
  const map = new Map<string, string>();
  return { setItem: (k, v) => void map.set(k, v), getItem: (k) => map.get(k) ?? null, removeItem: (k) => void map.delete(k) };
}
const SESSION: LoginSession = { token: "tok", refreshToken: "refresh", email: "a@b.mx", organizations: [] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const API = "https://api.example.test";
const OK = { status: "ok", text: "hola", blocks: [], sources: [], toolsUsed: [] };

describe.each([
  {
    nombre: "despachos",
    ruta: "despachos",
    base: despachosChatBaseUrl,
    conexion: conexionChatDatosDespachos,
    sugerencias: SUGERENCIAS_DESPACHOS,
    persist: persistDespachosSession,
    read: readPersistedDespachosSession,
  },
  {
    nombre: "licitaciones",
    ruta: "licitaciones",
    base: licitacionesChatBaseUrl,
    conexion: conexionChatDatosLicitaciones,
    sugerencias: SUGERENCIAS_LICITACIONES,
    persist: persistLicitacionesSession,
    read: readPersistedLicitacionesSession,
  },
])("cliente de chat de $nombre", ({ ruta, base, conexion, sugerencias, persist, read }) => {
  const original = (globalThis as { localStorage?: unknown }).localStorage;
  beforeEach(() => {
    const storage = fakeLocalStorage();
    (globalThis as { localStorage?: unknown }).localStorage = storage;
    persist(storage, SESSION);
  });
  afterEach(() => {
    if (original === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else (globalThis as { localStorage?: unknown }).localStorage = original;
  });

  it("la URL es /{vertical}/:propertyId/chat-datos y el id se codifica", () => {
    expect(base(API, "prop-1")).toBe(`${API}/${ruta}/prop-1/chat-datos`);
    expect(base(API, "a/b?c")).toBe(`${API}/${ruta}/a%2Fb%3Fc/chat-datos`);
  });

  it("enviar: POST con Bearer y SOLO pregunta e historial", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => (calls.push({ url, init }), json(200, OK))) as typeof fetch;
    const c = conexion(fetchImpl, API, "tok", "prop-1");
    expect(c.clave).toBe("prop-1");
    const r = await c.enviar("¿qué hay?", [{ role: "user", text: "antes" }]);
    expect(r.text).toBe("hola");
    expect(calls[0]!.url).toBe(`${API}/${ruta}/prop-1/chat-datos`);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(Object.keys(JSON.parse(calls[0]!.init.body as string) as object).sort()).toEqual(["history", "question"]);
  });

  it("disponible: GET /estado; true solo con available=true, y 403/500/red -> false (boton sigue en 'Pronto')", async () => {
    const mk = (res: () => Promise<Response>) => (async () => res()) as unknown as typeof fetch;
    expect(await conexion(mk(async () => json(200, { available: true })), API, "tok", "p").disponible()).toBe(true);
    expect(await conexion(mk(async () => json(200, { available: false })), API, "tok", "p").disponible()).toBe(false);
    expect(await conexion(mk(async () => json(403, {})), API, "tok", "p").disponible()).toBe(false);
    expect(await conexion(mk(async () => json(500, {})), API, "tok", "p").disponible()).toBe(false);
    expect(await conexion(mk(async () => { throw new TypeError("offline"); }), API, "tok", "p").disponible()).toBe(false);
  });

  it("un 401 refresca la sesion UNA vez y reintenta", async () => {
    let n = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith("/auth/refresh")) return json(200, { token: "tok-nuevo", refreshToken: "refresh-nuevo", email: "a@b.mx", organizations: [] });
      n += 1;
      return n === 1 ? json(401, {}) : json(200, OK);
    }) as typeof fetch;
    const r = await conexion(fetchImpl, API, "tok", "p").enviar("q", []);
    expect(r.status).toBe("ok");
    expect(read((globalThis as { localStorage: SessionStorageLike }).localStorage)?.token).toBe("tok-nuevo");
  });

  it("las sugerencias son preguntas completas, sin duplicados y de longitud razonable para el cuadro de texto", () => {
    expect(new Set(sugerencias).size).toBe(sugerencias.length);
    for (const s of sugerencias) {
      expect(s).toMatch(/^¿.+\?$/);
      expect(s.length).toBeLessThanOrEqual(120);
    }
  });
});

describe("sugerencias dentro del catalogo (terminologia MX)", () => {
  it("despachos: cobranza, CFDI, obligaciones fiscales y lista 69-B del SAT", () => {
    const todo = SUGERENCIAS_DESPACHOS.join(" ");
    expect(todo).toMatch(/cobranza/i);
    expect(todo).toMatch(/CFDI/);
    expect(todo).toMatch(/obligaciones fiscales/i);
    expect(todo).toMatch(/69-B del SAT/);
  });

  it("licitaciones: plazos/semaforo, go/no-go, propuestas y contratos; cada una dice su horizonte o periodo cuando lo necesita", () => {
    const todo = SUGERENCIAS_LICITACIONES.join(" ");
    expect(todo).toMatch(/semáforo/i);
    expect(todo).toMatch(/go\/no-go/i);
    expect(todo).toMatch(/propuestas/i);
    expect(todo).toMatch(/contratos/i);
    expect(todo).toMatch(/junta de aclaraciones/i);
    for (const s of SUGERENCIAS_LICITACIONES.filter((x) => /go\/no-go|vencen|terminan/.test(x))) expect(s).toMatch(/días|mes|semana/i);
  });
});
