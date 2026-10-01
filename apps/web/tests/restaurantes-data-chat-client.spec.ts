// Cliente de "Chatea con tus datos" (restaurantes): rutas, cuerpo sin identidad, tope de historial y
// degradacion honesta ante errores. `fetch` inyectado: nada toca la red.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ejecutarConsultaDirecta, fetchDataChatDisponible, preguntarDatos, SUGERENCIAS_RESTAURANTES } from "../src/verticals/restaurantes/data-chat-client.ts";
import { persistSession, readPersistedSession } from "../src/lib/auth-client.ts";
import type { LoginSession, SessionStorageLike } from "../src/lib/auth-client.ts";

function fakeLocalStorage(): SessionStorageLike {
  const map = new Map<string, string>();
  return { setItem: (k, v) => void map.set(k, v), getItem: (k) => map.get(k) ?? null, removeItem: (k) => void map.delete(k) };
}
const SESSION: LoginSession = { token: "tok", refreshToken: "refresh", email: "a@b.mx", organizations: [] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const API = "https://api.example.test";

describe("data-chat-client", () => {
  const original = (globalThis as { localStorage?: unknown }).localStorage;
  beforeEach(() => {
    const storage = fakeLocalStorage();
    (globalThis as { localStorage?: unknown }).localStorage = storage;
    persistSession(storage, SESSION);
  });
  afterEach(() => {
    if (original === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else (globalThis as { localStorage?: unknown }).localStorage = original;
  });

  it("preguntarDatos: POST a la ruta de la sucursal con SOLO pregunta e historial (sin ids ni organizacion), historial acotado a 12 turnos de 600 caracteres", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return json(200, { status: "ok", text: "hola", blocks: [], sources: [], toolsUsed: [] });
    }) as typeof fetch;
    const history = Array.from({ length: 20 }, (_, i) => ({ role: "user" as const, text: `${i}`.repeat(700) }));
    const r = await preguntarDatos(fetchImpl, API, "tok", "prop-1", "¿ventas?", history);
    expect(r.text).toBe("hola");
    expect(calls[0]!.url).toBe(`${API}/v1/restaurantes/prop-1/admin/chat-datos`);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const body = JSON.parse(calls[0]!.init.body as string) as { question: string; history: { text: string }[] };
    expect(Object.keys(body).sort()).toEqual(["history", "question"]);
    expect(body.history).toHaveLength(12);
    expect(body.history.every((h) => h.text.length === 600)).toBe(true);
  });

  it("403 -> mensaje claro de rol; 500 y fallo de red -> 'no disponible' honesto, nunca una excepcion", async () => {
    const mk = (res: () => Promise<Response>) => (async () => res()) as unknown as typeof fetch;
    expect((await preguntarDatos(mk(async () => json(403, {})), API, "tok", "p", "q", [])).text).toContain("rol");
    expect((await preguntarDatos(mk(async () => json(500, {})), API, "tok", "p", "q", [])).status).toBe("unavailable");
    expect((await preguntarDatos(mk(async () => { throw new Error("offline"); }), API, "tok", "p", "q", [])).text).toContain("conectar");
  });

  it("fetchDataChatDisponible: true solo si el servidor dice available=true; cualquier otra cosa es false", async () => {
    const mk = (res: () => Promise<Response>) => (async () => res()) as unknown as typeof fetch;
    expect(await fetchDataChatDisponible(mk(async () => json(200, { available: true })), API, "tok", "p")).toBe(true);
    expect(await fetchDataChatDisponible(mk(async () => json(200, { available: false })), API, "tok", "p")).toBe(false);
    expect(await fetchDataChatDisponible(mk(async () => json(403, {})), API, "tok", "p")).toBe(false);
    expect(await fetchDataChatDisponible(mk(async () => { throw new Error("x"); }), API, "tok", "p")).toBe(false);
  });

  it("un 401 refresca la sesion UNA vez y reintenta (mismo mecanismo que el resto de restaurantes)", async () => {
    let n = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith("/auth/refresh")) return json(200, { token: "tok-nuevo", refreshToken: "refresh-nuevo", email: "a@b.mx", organizations: [] });
      n += 1;
      return n === 1 ? json(401, {}) : json(200, { status: "ok", text: "ok", blocks: [], sources: [], toolsUsed: [] });
    }) as typeof fetch;
    const r = await preguntarDatos(fetchImpl, API, "tok", "p", "q", []);
    expect(r.status).toBe("ok");
    expect(readPersistedSession((globalThis as { localStorage: SessionStorageLike }).localStorage)?.token).toBe("tok-nuevo");
  });

  it("las sugerencias dicen siempre su periodo (el catalogo no adivina periodos)", () => {
    for (const s of SUGERENCIAS_RESTAURANTES) expect(s).toMatch(/semana|mes|días|hoy/i);
  });

  it("ejecutarConsultaDirecta (modo sin IA): POST con SOLO { tool } a la misma ruta, sin pregunta, ids ni organizacion", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return json(200, { status: "ok", text: "Ventas del periodo", blocks: [], sources: [], toolsUsed: ["ventas_por_dia"] });
    }) as typeof fetch;
    const r = await ejecutarConsultaDirecta(fetchImpl, API, "tok", "prop-1", "ventas_por_dia");
    expect(r.toolsUsed).toEqual(["ventas_por_dia"]);
    expect(calls[0]!.url).toBe(`${API}/v1/restaurantes/prop-1/admin/chat-datos`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ tool: "ventas_por_dia" });
  });

  it("ejecutarConsultaDirecta: 403, 500 y fallo de red degradan a un aviso honesto, nunca una excepcion", async () => {
    const mk = (res: () => Promise<Response>) => (async () => res()) as unknown as typeof fetch;
    expect((await ejecutarConsultaDirecta(mk(async () => json(403, {})), API, "tok", "p", "t")).text).toContain("rol");
    expect((await ejecutarConsultaDirecta(mk(async () => json(500, {})), API, "tok", "p", "t")).status).toBe("unavailable");
    expect((await ejecutarConsultaDirecta(mk(async () => { throw new Error("offline"); }), API, "tok", "p", "t")).text).toContain("conectar");
  });
});
