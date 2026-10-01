// Cliente de "Chatea con tus datos" de hoteles y rentas: rutas, cuerpo sin identidad, tope de historial, refresh de
// sesion de CADA vertical y degradacion honesta ante errores. `fetch` inyectado: nada toca la red.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hotelesDataChat, SUGERENCIAS_HOTELES } from "../src/verticals/hoteles/lib/data-chat-client.ts";
import { rentasDataChat, SUGERENCIAS_RENTAS } from "../src/verticals/rentas/lib/data-chat-client.ts";
import { persistHotelesSession, readPersistedHotelesSession } from "../src/verticals/hoteles/lib/auth-client.ts";
import { persistRentasSession, readPersistedRentasSession } from "../src/verticals/rentas/lib/auth-client.ts";
import type { SessionStorageLike } from "../src/lib/auth-client.ts";

function fakeLocalStorage(): SessionStorageLike {
  const map = new Map<string, string>();
  return { setItem: (k, v) => void map.set(k, v), getItem: (k) => map.get(k) ?? null, removeItem: (k) => void map.delete(k) };
}
const SESSION = { token: "tok", refreshToken: "refresh", email: "a@b.mx", fullName: "A B", organizations: [] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const API = "https://api.example.test";
const mk = (res: () => Promise<Response>) => (async () => res()) as unknown as typeof fetch;

const CASES = [
  { nombre: "hoteles", cliente: hotelesDataChat, ruta: "hoteles", sugerencias: SUGERENCIAS_HOTELES, persist: persistHotelesSession, read: readPersistedHotelesSession },
  { nombre: "rentas", cliente: rentasDataChat, ruta: "rentas", sugerencias: SUGERENCIAS_RENTAS, persist: persistRentasSession, read: readPersistedRentasSession },
] as const;

describe.each(CASES)("data-chat-client de $nombre", ({ cliente, ruta, sugerencias, persist, read }) => {
  const original = (globalThis as { localStorage?: unknown }).localStorage;
  beforeEach(() => {
    const storage = fakeLocalStorage();
    (globalThis as { localStorage?: unknown }).localStorage = storage;
    persist(storage, SESSION as never);
  });
  afterEach(() => {
    if (original === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else (globalThis as { localStorage?: unknown }).localStorage = original;
  });

  it("preguntar: POST a la ruta de la propiedad con SOLO pregunta e historial (sin ids ni organizacion), historial acotado a 12 turnos de 600 caracteres", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return json(200, { status: "ok", text: "hola", blocks: [], sources: [], toolsUsed: [] });
    }) as typeof fetch;
    const history = Array.from({ length: 20 }, (_, i) => ({ role: "user" as const, text: `${i}`.repeat(700) }));
    const r = await cliente.preguntar(fetchImpl, API, "tok", "prop-1", "¿cómo voy?", history);
    expect(r.text).toBe("hola");
    expect(calls[0]!.url).toBe(`${API}/${ruta}/prop-1/chat-datos`);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const body = JSON.parse(calls[0]!.init.body as string) as { question: string; history: { text: string }[] };
    expect(Object.keys(body).sort()).toEqual(["history", "question"]);
    expect(body.history).toHaveLength(12);
    expect(body.history.every((h) => h.text.length === 600)).toBe(true);
  });

  it("ejecutarConsulta (modo sin IA): POST con SOLO { tool } a la misma ruta; 403/500/red degradan a un aviso honesto", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return json(200, { status: "ok", text: "Ocupación del periodo", blocks: [], sources: [], toolsUsed: ["ocupacion"] });
    }) as typeof fetch;
    const r = await cliente.ejecutarConsulta(fetchImpl, API, "tok", "prop-1", "ocupacion");
    expect(r.toolsUsed).toEqual(["ocupacion"]);
    expect(calls[0]!.url).toBe(`${API}/${ruta}/prop-1/chat-datos`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ tool: "ocupacion" });
    expect((await cliente.ejecutarConsulta(mk(async () => json(403, {})), API, "tok", "p", "t")).text).toContain("rol");
    expect((await cliente.ejecutarConsulta(mk(async () => json(500, {})), API, "tok", "p", "t")).status).toBe("unavailable");
    expect((await cliente.ejecutarConsulta(mk(async () => { throw new Error("offline"); }), API, "tok", "p", "t")).text).toContain("conectar");
  });

  it("el id de propiedad se codifica en la URL (nunca rompe la ruta)", async () => {
    let seen = "";
    await cliente.preguntar((async (url: string) => ((seen = url), json(200, { status: "ok", text: "", blocks: [], sources: [], toolsUsed: [] }))) as typeof fetch, API, "tok", "a/b?c", "q", []);
    expect(seen).toBe(`${API}/${ruta}/a%2Fb%3Fc/chat-datos`);
  });

  it("403 -> mensaje claro de rol; 500 y fallo de red -> 'no disponible' honesto, nunca una excepcion", async () => {
    expect((await cliente.preguntar(mk(async () => json(403, {})), API, "tok", "p", "q", [])).text).toContain("rol");
    expect((await cliente.preguntar(mk(async () => json(500, {})), API, "tok", "p", "q", [])).status).toBe("unavailable");
    expect(
      (
        await cliente.preguntar(
          mk(async () => {
            throw new Error("offline");
          }),
          API,
          "tok",
          "p",
          "q",
          [],
        )
      ).text,
    ).toContain("conectar");
  });

  it("disponible: true solo si el servidor dice available=true; cualquier otra cosa (403 por rol incluido) es false", async () => {
    const urls: string[] = [];
    const spy = (res: () => Response) => (async (url: string) => (urls.push(url), res())) as unknown as typeof fetch;
    expect(await cliente.disponible(spy(() => json(200, { available: true })), API, "tok", "p")).toBe(true);
    expect(urls[0]).toBe(`${API}/${ruta}/p/chat-datos/estado`);
    expect(await cliente.disponible(mk(async () => json(200, { available: false })), API, "tok", "p")).toBe(false);
    expect(await cliente.disponible(mk(async () => json(200, {})), API, "tok", "p")).toBe(false);
    expect(await cliente.disponible(mk(async () => json(403, {})), API, "tok", "p")).toBe(false);
    expect(
      await cliente.disponible(
        mk(async () => {
          throw new Error("x");
        }),
        API,
        "tok",
        "p",
      ),
    ).toBe(false);
  });

  it("un 401 refresca la sesion de ESTA vertical UNA vez y reintenta", async () => {
    let n = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith("/auth/refresh")) return json(200, { token: "tok-nuevo", refreshToken: "refresh-nuevo", email: "a@b.mx", fullName: "A B", organizations: [] });
      n += 1;
      return n === 1 ? json(401, {}) : json(200, { status: "ok", text: "ok", blocks: [], sources: [], toolsUsed: [] });
    }) as typeof fetch;
    const r = await cliente.preguntar(fetchImpl, API, "tok", "p", "q", []);
    expect(r.status).toBe("ok");
    expect(read((globalThis as { localStorage: SessionStorageLike }).localStorage)?.token).toBe("tok-nuevo");
  });

  it("un 401 sin refresh posible no deja una respuesta colgada: 'no disponible' (la sesion se limpia)", async () => {
    const fetchImpl = (async (url: string) => (String(url).endsWith("/auth/refresh") ? json(401, {}) : json(401, {}))) as typeof fetch;
    const r = await cliente.preguntar(fetchImpl, API, "tok", "p", "q", []);
    expect(r.status).toBe("unavailable");
    expect(read((globalThis as { localStorage: SessionStorageLike }).localStorage)).toBeNull();
  });

  it("las sugerencias dicen su periodo o no lo necesitan (el catalogo no adivina periodos)", () => {
    expect(sugerencias.length).toBeGreaterThanOrEqual(3);
    for (const s of sugerencias) expect(s).toMatch(/semana|mes|días|hoy|mañana|abiertos|abiertas|pendientes/i);
  });
});
