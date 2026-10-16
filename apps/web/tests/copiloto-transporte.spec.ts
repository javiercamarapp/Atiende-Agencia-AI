// Transporte del Copiloto: parser NDJSON (lineas partidas, corruptas, estados desconocidos), abort, errores HTTP honestos,
// cuerpo sin identidad, hilo local cuando el servidor no guarda, CRUD de conversaciones y /estado. `fetch` inyectado: sin red.
import { describe, expect, it } from "vitest";
import { CopilotoErrorTransporte, type CopilotoEvento } from "@atiende/ui";
import { consultarEstadoCopiloto, crearTransporteCopiloto, leerNdjson, nombreArchivoPdf, normalizarRespuesta, parsearLinea, TEXTO_SIN_ACCESO } from "../src/lib/copiloto/transporte.ts";

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

describe("descargarPdf (reporte PDF del mensaje)", () => {
  const pdf = (nombre = "reporte-hoteles-2026-10-02.pdf") =>
    new Response(new Blob(["%PDF-1.7 prueba"]), { status: 200, headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${nombre}"` } });

  it("hace POST autenticado a .../conversaciones/:id/reporte?seq=N y entrega el PDF con el nombre del servidor", async () => {
    const llamadas: { url: string; method: string; auth: string | null }[] = [];
    const guardados: { nombre: string; tipo: string; tamano: number }[] = [];
    const t = crearTransporteCopiloto({
      baseUrl: BASE,
      token: "tok",
      fetchImpl: (async (url: string, init: RequestInit) => {
        llamadas.push({ url, method: String(init.method), auth: new Headers(init.headers).get("authorization") });
        return pdf();
      }) as unknown as typeof fetch,
      guardarArchivo: (blob, nombre) => guardados.push({ nombre, tipo: blob.type, tamano: blob.size }),
    });
    await t.descargarPdf?.("conv/1", 2);
    expect(llamadas).toEqual([{ url: `${BASE}/conversaciones/conv%2F1/reporte?seq=2`, method: "POST", auth: "Bearer tok" }]);
    expect(guardados).toHaveLength(1);
    expect(guardados[0]).toMatchObject({ nombre: "reporte-hoteles-2026-10-02.pdf" });
    expect(guardados[0]!.tamano).toBeGreaterThan(0);
  });

  it("usa el envoltorio de refresh de sesion (reintenta con el token nuevo)", async () => {
    const tokens: (string | null)[] = [];
    const t = crear((async (_u: string, init: RequestInit) => {
      tokens.push(new Headers(init.headers).get("authorization"));
      return tokens.length === 1 ? json(401, {}) : pdf();
    }) as unknown as typeof fetch, async (hacer) => {
      const primero = await hacer("viejo");
      return primero.status === 401 ? hacer("nuevo") : primero;
    });
    await expect(t.descargarPdf?.("c", 2)).rejects.toBeInstanceOf(Error); // sin guardarArchivo inyectado usa el DOM (no hay en node)
    expect(tokens).toEqual(["Bearer viejo", "Bearer nuevo"]);
  });

  it("errores honestos y legibles: 403, 404, 429, 422 con el mensaje del servidor, 503 y 500 (nunca el cuerpo crudo)", async () => {
    const intento = async (res: Response) => {
      const t = crear((async () => res) as unknown as typeof fetch);
      return t.descargarPdf?.("c", 2).then(() => "no fallo", (e: Error) => e.message);
    };
    expect(await intento(json(403, {}))).toBe(TEXTO_SIN_ACCESO);
    expect(await intento(json(404, {}))).toContain("No encontré esa conversación");
    expect(await intento(json(429, {}))).toContain("muchos reportes");
    expect(await intento(json(422, { code: "report_no_data", message: "No hay cifras para armar el reporte con tu alcance actual." }))).toBe("No hay cifras para armar el reporte con tu alcance actual.");
    expect(await intento(new Response("<html>", { status: 422 }))).toContain("no tiene cifras");
    expect(await intento(json(503, {}))).toContain("todavía no están disponibles");
    expect(await intento(json(500, { stack: "secreto" }))).toContain("No pude generar el reporte");
    expect(await intento(json(500, { stack: "secreto" }))).not.toContain("secreto");
  });

  it("una respuesta 200 que no es PDF se rechaza; un fallo de red es un error legible", async () => {
    const noPdf = crear((async () => json(200, { ok: true })) as unknown as typeof fetch);
    await expect(noPdf.descargarPdf?.("c", 2)).rejects.toThrow(/no es un PDF/);
    const caido = crear((async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    await expect(caido.descargarPdf?.("c", 2)).rejects.toThrow(/No pude conectar/);
  });

  it("nombreArchivoPdf solo acepta nombres .pdf simples; cualquier otra cosa cae a reporte.pdf", () => {
    const con = (cd: string | null) => ({ headers: new Headers(cd ? { "content-disposition": cd } : {}) });
    expect(nombreArchivoPdf(con('attachment; filename="reporte-citas-2026-10-02.pdf"'))).toBe("reporte-citas-2026-10-02.pdf");
    expect(nombreArchivoPdf(con('attachment; filename="../../etc/passwd"'))).toBe("reporte.pdf");
    expect(nombreArchivoPdf(con('attachment; filename="x.exe"'))).toBe("reporte.pdf");
    expect(nombreArchivoPdf(con(null))).toBe("reporte.pdf");
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

describe("adjuntar archivo (POST <base>/adjuntos)", () => {
  const archivo = (nombre = "ventas.csv", contenido = "a,b\n1,2"): File => new File([contenido], nombre, { type: "text/csv" });
  const RESPUESTA = { status: "ok", text: "«ventas.csv» tiene 1 fila de datos", blocks: [{ kind: "table", tool: "archivo_adjunto", title: "Perfil del archivo", columns: [{ key: "columna", label: "Columna", kind: "text" }], rows: [{ columna: "a" }], truncated: false }], sources: [{ tool: "archivo_adjunto", source: "Archivo adjunto", scopeLabel: "Solo este archivo" }], toolsUsed: ["archivo_adjunto"] };

  it("declara `adjuntos` y manda SOLO nombre + contenido en base64 al servidor (sin conversacion ni pregunta), con el token", async () => {
    const llamadas: { url: string; init: RequestInit }[] = [];
    const t = crear((async (url: string, init: RequestInit) => {
      llamadas.push({ url, init });
      return json(200, RESPUESTA);
    }) as unknown as typeof fetch);
    expect(t.adjuntos).toEqual({ accept: ".csv,.tsv,.txt,.xlsx,.pdf", maxBytes: 5 * 1024 * 1024 });
    const eventos: CopilotoEvento[] = [];
    const r = await t.enviar({ pregunta: "Adjunté «ventas.csv»", conversacionId: "c-1", adjunto: archivo(), senal: new AbortController().signal, onEvento: (e) => eventos.push(e) });
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.url).toBe(`${BASE}/adjuntos`);
    expect(llamadas[0]!.init.method).toBe("POST");
    expect((llamadas[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
    expect(JSON.parse(String(llamadas[0]!.init.body))).toEqual({ nombre: "ventas.csv", contenidoBase64: btoa("a,b\n1,2") });
    expect(r.status).toBe("ok");
    expect(r.blocks?.[0]?.tool).toBe("archivo_adjunto");
    expect(eventos.at(-1)).toMatchObject({ t: "fin" });
  });

  it("el archivo no entra al hilo local: la siguiente pregunta sigue abriendo una conversacion nueva", async () => {
    const cuerpos: Record<string, unknown>[] = [];
    const t = crear((async (url: string, init: RequestInit) => {
      if (url.endsWith("/adjuntos")) return json(200, RESPUESTA);
      cuerpos.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return ndjson([JSON.stringify({ t: "fin", respuesta: { status: "ok", text: "hola" } })]);
    }) as unknown as typeof fetch);
    await t.enviar({ pregunta: "Adjunté «a.csv»", adjunto: archivo(), senal: new AbortController().signal, onEvento: () => undefined });
    await t.enviar({ pregunta: "hola", senal: new AbortController().signal, onEvento: () => undefined });
    expect(cuerpos[0]).toEqual({ question: "hola", conversationId: "new" });
  });

  it("mas de 5 MB se rechaza sin subir; 413, 404/503, 429 y 403 del servidor se traducen a avisos honestos", async () => {
    let llamadas = 0;
    const con = (status: number, headers: Record<string, string> = {}) =>
      crear((async () => {
        llamadas++;
        return json(status, { code: "x" }, headers);
      }) as unknown as typeof fetch);
    const enviar = (t: ReturnType<typeof crear>, f: File = archivo()) => t.enviar({ pregunta: "x", adjunto: f, senal: new AbortController().signal, onEvento: () => undefined });
    const grande = { size: 6 * 1024 * 1024, name: "g.csv", arrayBuffer: async () => new ArrayBuffer(0) } as unknown as File;
    await expect(enviar(con(200), grande)).rejects.toMatchObject({ status: "invalid_input", message: "El archivo supera los 5 MB." });
    expect(llamadas).toBe(0);
    await expect(enviar(con(413))).rejects.toMatchObject({ status: "invalid_input" });
    for (const s of [404, 503]) await expect(enviar(con(s))).rejects.toMatchObject({ status: "invalid_input", message: expect.stringContaining("todavía no está disponible") });
    await expect(enviar(con(429, { "retry-after": "90" }))).rejects.toMatchObject({ status: "invalid_input", message: expect.stringContaining("muchos archivos") });
    await expect(enviar(con(403))).rejects.toMatchObject({ status: "forbidden" });
  });

  it("un motivo de rechazo del servidor (200 con status invalid_input) llega tal cual al chat", async () => {
    const t = crear((async () => json(200, { status: "invalid_input", text: "Solo puedo leer archivos CSV, Excel (.xlsx) y PDF.", blocks: [], sources: [], toolsUsed: [] })) as unknown as typeof fetch);
    const r = await t.enviar({ pregunta: "x", adjunto: archivo("a.exe"), senal: new AbortController().signal, onEvento: () => undefined });
    expect(r).toMatchObject({ status: "invalid_input", text: "Solo puedo leer archivos CSV, Excel (.xlsx) y PDF." });
  });

  it("`adjuntos: false` quita la capacidad (la ruta de chat no tiene /adjuntos)", () => {
    const t = crearTransporteCopiloto({ baseUrl: BASE, fetchImpl: (async () => json(200, {})) as unknown as typeof fetch, token: "tok", adjuntos: false });
    expect(t.adjuntos).toBeUndefined();
    expect(crearTransporteCopiloto({ baseUrl: BASE, fetchImpl: (async () => json(200, {})) as unknown as typeof fetch, token: "tok", adjuntos: false, fijados: false }).fijar).toBeUndefined();
  });
});
