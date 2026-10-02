// Transporte del Copiloto: parser NDJSON (lineas partidas, corruptas, estados desconocidos), abort, errores HTTP honestos,
// cuerpo sin identidad, hilo local cuando el servidor no guarda, CRUD de conversaciones y /estado. `fetch` inyectado: sin red.
import { describe, expect, it } from "vitest";
import { CopilotoErrorTransporte, type CopilotoEvento } from "@atiende/ui";
import { consultarEstadoCopiloto, crearTransporteCopiloto, leerNdjson, normalizarRespuesta, parsearLinea, TEXTO_SIN_ACCESO } from "../src/lib/copiloto/transporte.ts";

const BASE = "https://api.example.test/v1/restaurantes/p1/admin/chat-datos";
const enc = new TextEncoder();

function flujo(trozos: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const t of trozos) c.enqueue(enc.encode(t));
      c.close();
    },
  });
}
const ndjson = (trozos: readonly string[], status = 200) => new Response(flujo(trozos), { status, headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const PASO_I = JSON.stringify({ t: "paso", fase: "inicio", herramienta: "ventas_por_dia" });
const PASO_F = JSON.stringify({ t: "paso", fase: "fin", herramienta: "ventas_por_dia" });
const bloque = { kind: "table", tool: "ventas_por_dia", title: "Ventas", columns: [{ key: "dia", label: "Día", kind: "text" }], rows: [{ dia: "lun" }], truncated: false };
const FIN = JSON.stringify({ t: "fin", respuesta: { status: "ok", text: "Vendiste 10", blocks: [bloque], sources: [{ tool: "ventas_por_dia", source: "Pedidos", scopeLabel: "todas tus sucursales" }], toolsUsed: ["ventas_por_dia"] }, conversacionId: "c-1", seq: 2 });

function crear(fetchImpl: typeof fetch, conAuth?: (h: (t: string) => Promise<Response>) => Promise<Response>) {
  return crearTransporteCopiloto({ baseUrl: BASE, fetchImpl, token: "tok", ...(conAuth ? { conAuth } : {}) });
}

describe("parsearLinea", () => {
  it("acepta paso, fin y error; ignora lineas vacias, corruptas o de otro tipo", () => {
    expect(parsearLinea(PASO_I)).toEqual({ t: "paso", fase: "inicio", herramienta: "ventas_por_dia" });
    expect(parsearLinea("")).toBeNull();
    expect(parsearLinea("{no es json")).toBeNull();
    expect(parsearLinea('{"t":"otro"}')).toBeNull();
    expect(parsearLinea('{"t":"paso","fase":"medio","herramienta":"x"}')).toBeNull();
    expect(parsearLinea('{"t":"fin"}')).toBeNull();
  });

  it("el status 'error' del servidor y cualquier desconocido se muestran como 'unavailable'", () => {
    const e = parsearLinea('{"t":"error","status":"error","mensaje":"Falló"}');
    expect(e).toEqual({ t: "error", status: "unavailable", mensaje: "Falló" });
    expect(normalizarRespuesta({ status: "inventado", text: "x" }).status).toBe("unavailable");
  });

  it("noAi.kill_switch se traduce al aviso de 'apagado'", () => {
    expect(normalizarRespuesta({ status: "unavailable", text: "x", noAi: { reason: "kill_switch", options: [] } }).status).toBe("apagado");
  });
});

describe("leerNdjson", () => {
  it("reensambla lineas partidas entre trozos y respeta el orden", async () => {
    const eventos: CopilotoEvento[] = [];
    const mitad = Math.floor(FIN.length / 2);
    await leerNdjson(flujo([`${PASO_I}\n${PASO_F.slice(0, 10)}`, `${PASO_F.slice(10)}\n${FIN.slice(0, mitad)}`, `${FIN.slice(mitad)}\n`]), (e) => eventos.push(e), new AbortController().signal);
    expect(eventos.map((e) => e.t)).toEqual(["paso", "paso", "fin"]);
  });

  it("procesa la ultima linea aunque no termine en salto de linea y salta lineas corruptas", async () => {
    const eventos: CopilotoEvento[] = [];
    await leerNdjson(flujo([`basura\n${PASO_I}\n`, FIN]), (e) => eventos.push(e), new AbortController().signal);
    expect(eventos.map((e) => e.t)).toEqual(["paso", "fin"]);
  });

  it("abortar la senal corta la lectura con AbortError", async () => {
    const ctl = new AbortController();
    const abierto = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(enc.encode(`${PASO_I}\n`)) });
    const vistos: string[] = [];
    const p = leerNdjson(abierto, (e) => { vistos.push(e.t); ctl.abort(); }, ctl.signal);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(vistos).toEqual(["paso"]);
  });
});

describe("enviar", () => {
  it("POST NDJSON: Accept correcto, cuerpo con SOLO pregunta y conversationId 'new', reporta pasos y devuelve el fin", async () => {
    const llamadas: { url: string; init: RequestInit }[] = [];
    const t = crear((async (url: string, init: RequestInit) => {
      llamadas.push({ url, init });
      return ndjson([`${PASO_I}\n${PASO_F}\n${FIN}\n`]);
    }) as unknown as typeof fetch);
    const eventos: CopilotoEvento[] = [];
    const r = await t.enviar({ pregunta: "¿Cuánto vendí?", senal: new AbortController().signal, onEvento: (e) => eventos.push(e) });
    expect(llamadas[0]?.url).toBe(BASE);
    expect(llamadas[0]?.init.method).toBe("POST");
    const h = llamadas[0]?.init.headers as Record<string, string>;
    expect(h["accept"]).toBe("application/x-ndjson");
    expect(h["authorization"]).toBe("Bearer tok");
    expect(JSON.parse(String(llamadas[0]?.init.body))).toEqual({ question: "¿Cuánto vendí?", conversationId: "new" });
    expect(eventos.map((e) => e.t)).toEqual(["paso", "paso", "fin"]);
    expect(r.status).toBe("ok");
    expect(r.text).toBe("Vendiste 10");
    expect(r.seq).toBe(2);
    expect(r.blocks).toHaveLength(1);
  });

  it("con conversacion abierta manda su id (y nunca historial)", async () => {
    let cuerpo = "";
    const t = crear((async (_u: string, init: RequestInit) => {
      cuerpo = String(init.body);
      return ndjson([`${FIN}\n`]);
    }) as unknown as typeof fetch);
    await t.enviar({ pregunta: "¿y ayer?", conversacionId: "c-1", senal: new AbortController().signal, onEvento: () => undefined });
    expect(JSON.parse(cuerpo)).toEqual({ question: "¿y ayer?", conversationId: "c-1" });
  });

  it("si el servidor no guarda la conversacion, la siguiente pregunta lleva el hilo local (sin conversationId); reiniciar() lo borra", async () => {
    const sinGuardar = JSON.stringify({ t: "fin", respuesta: { status: "ok", text: "R1", blocks: [], sources: [], toolsUsed: [], guardado: false } });
    const cuerpos: Record<string, unknown>[] = [];
    const t = crear((async (_u: string, init: RequestInit) => {
      cuerpos.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return ndjson([`${sinGuardar}\n`]);
    }) as unknown as typeof fetch);
    const senal = new AbortController().signal;
    await t.enviar({ pregunta: "P1", senal, onEvento: () => undefined });
    await t.enviar({ pregunta: "P2", senal, onEvento: () => undefined });
    expect(cuerpos[0]).toEqual({ question: "P1", conversationId: "new" });
    expect(cuerpos[1]).toEqual({ question: "P2", history: [{ role: "user", text: "P1" }, { role: "assistant", text: "R1" }] });
    t.reiniciar();
    await t.enviar({ pregunta: "P3", senal, onEvento: () => undefined });
    expect(cuerpos[2]).toEqual({ question: "P3", conversationId: "new" });
  });

  it("abort: el AbortError de fetch se propaga tal cual (el shell lo muestra como 'Cancelado')", async () => {
    const ctl = new AbortController();
    const t = crear(((_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal?.addEventListener("abort", () => rej(new DOMException("abortado", "AbortError")));
    })) as unknown as typeof fetch);
    const p = t.enviar({ pregunta: "x", senal: ctl.signal, onEvento: () => undefined });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("errores HTTP: 403 rol sin acceso, 429 con espera, 400 entrada invalida, 500 no disponible", async () => {
    const casos: [number, string, Record<string, string>][] = [[403, "forbidden", {}], [429, "rate_limited", { "retry-after": "30" }], [400, "invalid_input", {}], [500, "unavailable", {}]];
    for (const [status, esperado, cab] of casos) {
      const t = crear((async () => json(status, { message: "x" }, cab)) as unknown as typeof fetch);
      const err = await t.enviar({ pregunta: "x", senal: new AbortController().signal, onEvento: () => undefined }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CopilotoErrorTransporte);
      expect((err as CopilotoErrorTransporte).status).toBe(esperado);
      if (status === 403) expect((err as Error).message).toBe(TEXTO_SIN_ACCESO);
      if (status === 429) expect((err as CopilotoErrorTransporte).reintentarEnSeg).toBe(30);
    }
  });

  it("fallo de red = 'unavailable' honesto, nunca una excepcion cruda", async () => {
    const t = crear((async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch);
    const err = await t.enviar({ pregunta: "x", senal: new AbortController().signal, onEvento: () => undefined }).catch((e: unknown) => e);
    expect((err as CopilotoErrorTransporte).status).toBe("unavailable");
  });

  it("evento 'error' del flujo y flujo cortado sin 'fin' se reportan como errores, no como respuesta vacia", async () => {
    const t1 = crear((async () => ndjson([`${PASO_I}\n{"t":"error","status":"error","mensaje":"Falló la consulta"}\n`])) as unknown as typeof fetch);
    const e1 = await t1.enviar({ pregunta: "x", senal: new AbortController().signal, onEvento: () => undefined }).catch((e: unknown) => e);
    expect(e1).toMatchObject({ status: "unavailable", message: "Falló la consulta" });
    const t2 = crear((async () => ndjson([`${PASO_I}\n`])) as unknown as typeof fetch);
    const e2 = await t2.enviar({ pregunta: "x", senal: new AbortController().signal, onEvento: () => undefined }).catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(CopilotoErrorTransporte);
    expect((e2 as CopilotoErrorTransporte).status).toBe("unavailable");
  });

  it("servidor sin NDJSON (JSON clasico): lo traduce a un fin", async () => {
    const t = crear((async () => json(200, { status: "unavailable", text: "El asistente de datos todavía no está activado", blocks: [], sources: [], toolsUsed: [] })) as unknown as typeof fetch);
    const eventos: CopilotoEvento[] = [];
    const r = await t.enviar({ pregunta: "x", senal: new AbortController().signal, onEvento: (e) => eventos.push(e) });
    expect(r.status).toBe("unavailable");
    expect(eventos.map((e) => e.t)).toEqual(["fin"]);
  });

  it("usa el envoltorio de refresh de sesion cuando se inyecta (reintenta con el token nuevo)", async () => {
    const tokens: string[] = [];
    const t = crear(
      (async (_u: string, init: RequestInit) => {
        tokens.push((init.headers as Record<string, string>)["authorization"] ?? "");
        return ndjson([`${FIN}\n`]);
      }) as unknown as typeof fetch,
      (hacer) => hacer("nuevo"),
    );
    await t.enviar({ pregunta: "x", senal: new AbortController().signal, onEvento: () => undefined });
    expect(tokens).toEqual(["Bearer nuevo"]);
  });
});

describe("conversaciones", () => {
  it("listar: mapea resumenes y descarta filas invalidas; 'disponible:false' = lista vacia honesta", async () => {
    const t = crear((async () => json(200, { disponible: true, conversaciones: [{ id: "a", titulo: "Ventas", actualizadaEn: "2026-10-01T10:00:00Z", mensajes: 2 }, { id: 5 }, null] })) as unknown as typeof fetch);
    expect(await t.listar?.(new AbortController().signal)).toEqual([{ id: "a", titulo: "Ventas", actualizadaEn: "2026-10-01T10:00:00Z" }]);
    const t2 = crear((async () => json(200, { disponible: false, conversaciones: [] })) as unknown as typeof fetch);
    expect(await t2.listar?.(new AbortController().signal)).toEqual([]);
  });

  it("abrir: mapea mensajes guardados (estado, bloques, seq) y escapa el id en la URL", async () => {
    let url = "";
    const t = crear((async (u: string) => {
      url = u;
      return json(200, { id: "a/b", titulo: "T", actualizadaEn: "x", mensajes: [{ id: "m1", role: "user", text: "hola", seq: 1 }, { id: "m2", role: "assistant", text: "R", status: "ok", blocks: [bloque], sources: [], seq: 2 }, { role: "x", text: "y" }] });
    }) as unknown as typeof fetch);
    const c = await t.abrir?.("a/b", new AbortController().signal);
    expect(url).toBe(`${BASE}/conversaciones/a%2Fb`);
    expect(c?.mensajes).toHaveLength(2);
    expect(c?.mensajes[1]).toMatchObject({ role: "assistant", status: "ok", seq: 2 });
    expect(c?.mensajes[1]?.blocks).toHaveLength(1);
    expect(c?.mensajes[0]).not.toHaveProperty("status");
  });

  it("renombrar (PATCH {titulo}) y borrar (DELETE) llaman a la ruta real; un error HTTP se propaga", async () => {
    const llamadas: { url: string; method: string; body?: string }[] = [];
    const t = crear((async (url: string, init: RequestInit) => {
      llamadas.push({ url, method: String(init.method), ...(init.body ? { body: String(init.body) } : {}) });
      return init.method === "DELETE" ? new Response(null, { status: 204 }) : json(200, { id: "a", titulo: "Nuevo" });
    }) as unknown as typeof fetch);
    await t.renombrar?.("a", "Nuevo");
    await t.borrar?.("a");
    expect(llamadas).toEqual([{ url: `${BASE}/conversaciones/a`, method: "PATCH", body: '{"titulo":"Nuevo"}' }, { url: `${BASE}/conversaciones/a`, method: "DELETE" }]);
    const roto = crear((async () => json(404, { message: "no" })) as unknown as typeof fetch);
    await expect(roto.borrar?.("a")).rejects.toBeInstanceOf(CopilotoErrorTransporte);
  });
});

describe("consultarEstadoCopiloto", () => {
  const cfg = (f: typeof fetch) => ({ baseUrl: BASE, fetchImpl: f, token: "tok" });
  it("ok con uso y motivo", async () => {
    const e = await consultarEstadoCopiloto(cfg((async () => json(200, { available: true, permitido: false, motivo: "tope_diario", usoHoyPct: 100 })) as unknown as typeof fetch));
    expect(e).toEqual({ tipo: "ok", available: true, permitido: false, motivo: "tope_diario", usoHoyPct: 100 });
  });
  it("403 = sin_acceso; 500, red caida o cuerpo raro = error (nunca disponible)", async () => {
    expect(await consultarEstadoCopiloto(cfg((async () => json(403, {})) as unknown as typeof fetch))).toEqual({ tipo: "sin_acceso" });
    expect(await consultarEstadoCopiloto(cfg((async () => json(500, {})) as unknown as typeof fetch))).toEqual({ tipo: "error" });
    expect(await consultarEstadoCopiloto(cfg((async () => { throw new Error("red"); }) as unknown as typeof fetch))).toEqual({ tipo: "error" });
    expect(await consultarEstadoCopiloto(cfg((async () => json(200, { hola: 1 })) as unknown as typeof fetch))).toEqual({ tipo: "error" });
  });
  it("servidor viejo sin 'permitido': hereda de available; usoHoyPct fuera de rango se acota", async () => {
    expect(await consultarEstadoCopiloto(cfg((async () => json(200, { available: true })) as unknown as typeof fetch))).toMatchObject({ permitido: true, usoHoyPct: null });
    expect(await consultarEstadoCopiloto(cfg((async () => json(200, { available: true, usoHoyPct: 250 })) as unknown as typeof fetch))).toMatchObject({ usoHoyPct: 100 });
  });
});
