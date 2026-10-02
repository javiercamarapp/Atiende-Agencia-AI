// @vitest-environment jsdom
//
// CHAT-06 / CHAT-15 en apps/web: el transporte manda la consulta DIRECTA (tool + args + label, sin `question`) y fija por POST /pins
// con SOLO conversacion + posicion; el cliente de fijados traduce cada respuesta del servidor al estado honesto correcto; y el
// tablero montado en el Resumen de una vertical respeta el rol (sin llamar al servidor si el rol no tiene Copiloto). Sin red: `fetch` inyectado.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopilotoErrorTransporte, FijadosErrorCliente } from "@atiende/ui";
import { crearClienteFijados } from "../src/lib/copiloto/fijados.ts";
import { crearTransporteCopiloto } from "../src/lib/copiloto/transporte.ts";
import { HotelesFijadosCopiloto } from "../src/verticals/hoteles/pages/Copiloto.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

const BASE = "https://api.example.test/hoteles/p1/chat-datos";
const ndjson = (lineas: unknown[]) => new Response(lineas.map((l) => JSON.stringify(l)).join("\n") + "\n", { status: 200, headers: { "content-type": "application/x-ndjson" } });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const FIN = { t: "fin", respuesta: { status: "ok", text: "ok", blocks: [], sources: [], toolsUsed: [] }, conversacionId: "c-1", seq: 2 };

function llamadas(fetchImpl: ReturnType<typeof vi.fn>) {
  return fetchImpl.mock.calls.map(([url, init]) => ({ url: String(url), method: (init as RequestInit | undefined)?.method ?? "GET", body: (init as RequestInit | undefined)?.body ? JSON.parse(String((init as RequestInit).body)) : undefined }));
}

describe("transporte: consulta directa y fijar", () => {
  it("con `directa` el cuerpo lleva tool + args + label y NO la pregunta; sin `directa` sigue siendo solo la pregunta", async () => {
    const fetchImpl = vi.fn(async () => ndjson([FIN]));
    const t = crearTransporteCopiloto({ baseUrl: BASE, fetchImpl: fetchImpl as never, token: "tok" });
    await t.enviar({ pregunta: "¿Cómo va la ocupación esta semana?", directa: { tool: "ocupacion_adr_revpar", args: { periodo: "esta_semana" } }, senal: new AbortController().signal, onEvento: () => undefined });
    await t.enviar({ pregunta: "otra", conversacionId: "c-1", senal: new AbortController().signal, onEvento: () => undefined });
    const [directa, libre] = llamadas(fetchImpl);
    expect(directa!.body).toEqual({ tool: "ocupacion_adr_revpar", args: { periodo: "esta_semana" }, label: "¿Cómo va la ocupación esta semana?", conversationId: "new" });
    expect(libre!.body).toEqual({ question: "otra", conversationId: "c-1" });
  });

  it("una consulta directa sin argumentos (p. ej. tickets) no manda `args`", async () => {
    const fetchImpl = vi.fn(async () => ndjson([FIN]));
    const t = crearTransporteCopiloto({ baseUrl: BASE, fetchImpl: fetchImpl as never, token: "tok" });
    await t.enviar({ pregunta: "q", directa: { tool: "tickets_abiertos_sla" }, senal: new AbortController().signal, onEvento: () => undefined });
    expect(llamadas(fetchImpl)[0]!.body).toEqual({ tool: "tickets_abiertos_sla", label: "q", conversationId: "new" });
  });

  it("fijar hace POST /pins con SOLO conversacion, seq y bloque (el servidor deriva herramienta y argumentos)", async () => {
    const fetchImpl = vi.fn(async () => json(201, { id: "p-1" }));
    const t = crearTransporteCopiloto({ baseUrl: BASE, fetchImpl: fetchImpl as never, token: "tok" });
    await t.fijar!("c-1", 2, 1);
    expect(llamadas(fetchImpl)).toEqual([{ url: `${BASE}/pins`, method: "POST", body: { conversationId: "c-1", seq: 2, bloque: 1 } }]);
  });

  it("fijar traduce los errores del servidor a avisos honestos (403 sin acceso, 409 tope, 503 no disponible)", async () => {
    for (const status of [403, 404, 409, 503]) {
      const t = crearTransporteCopiloto({ baseUrl: BASE, fetchImpl: (async () => json(status, {})) as never, token: "tok" });
      await expect(t.fijar!("c-1", 2, 0)).rejects.toBeInstanceOf(CopilotoErrorTransporte);
    }
  });
});

describe("cliente de fijados", () => {
  const cliente = (fetchImpl: ReturnType<typeof vi.fn>) => crearClienteFijados({ baseUrl: BASE, fetchImpl: fetchImpl as never, token: "tok" });
  const senal = new AbortController().signal;

  it("listar: normaliza la lista y descarta filas invalidas; `disponible:false` se conserva", async () => {
    const f = vi.fn(async () => json(200, { disponible: true, pins: [{ id: "a", titulo: "A", herramienta: "t", compartido: true, propio: false }, { id: 3 }, "x"] }));
    expect(await cliente(f).listar(senal)).toEqual({ disponible: true, fijados: [{ id: "a", titulo: "A", herramienta: "t", compartido: true, propio: false }] });
    expect(llamadas(f)[0]).toMatchObject({ url: `${BASE}/pins`, method: "GET" });
    const g = vi.fn(async () => json(200, { disponible: false, pins: [] }));
    expect(await cliente(g).listar(senal)).toEqual({ disponible: false, fijados: [] });
  });

  it("errores: 403 al leer = sin_acceso, 503 = no_disponible, otro = error; compartir 403 = sin_permiso", async () => {
    await expect(cliente(vi.fn(async () => json(403, {}))).listar(senal)).rejects.toMatchObject({ tipo: "sin_acceso" });
    await expect(cliente(vi.fn(async () => json(503, {}))).listar(senal)).rejects.toMatchObject({ tipo: "no_disponible" });
    await expect(cliente(vi.fn(async () => json(500, {}))).listar(senal)).rejects.toMatchObject({ tipo: "error" });
    await expect(cliente(vi.fn(async () => json(200, { otra: "cosa" }))).listar(senal)).rejects.toBeInstanceOf(FijadosErrorCliente);
    await expect(cliente(vi.fn(async () => json(403, {}))).compartir("a", true)).rejects.toMatchObject({ tipo: "sin_permiso" });
    await expect(cliente(vi.fn(async () => { throw new TypeError("red"); })).listar(senal)).rejects.toMatchObject({ tipo: "error" });
  });

  it("resultado, compartir y quitar pegan a las rutas correctas con el id codificado", async () => {
    const f = vi.fn(async (url: unknown) => (String(url).endsWith("/resultado") ? json(200, { id: "a/b", titulo: "T", status: "ok", text: "x", blocks: [{ tool: "t" }], sources: [] }) : json(200, {})));
    const c = cliente(f);
    const r = await c.resultado("a/b", senal);
    expect(r).toMatchObject({ id: "a/b", titulo: "T", status: "ok", blocks: [{ tool: "t" }] });
    await c.compartir("a/b", true);
    await c.quitar("a/b");
    expect(llamadas(f).map((l) => `${l.method} ${l.url.replace(BASE, "")}`)).toEqual(["GET /pins/a%2Fb/resultado", "PATCH /pins/a%2Fb", "DELETE /pins/a%2Fb"]);
    expect(llamadas(f)[1]!.body).toEqual({ compartido: true });
  });

  it("un status desconocido del servidor se normaliza a 'unavailable' (nunca un estado inventado)", async () => {
    const f = vi.fn(async () => json(200, { id: "a", titulo: "T", status: "inventado", text: "", blocks: "no", sources: null }));
    expect(await cliente(f).resultado("a", senal)).toMatchObject({ status: "unavailable", blocks: [], sources: [] });
  });
});

describe("tablero montado en el Resumen de hoteles", () => {
  let rendered: RenderedComponent | undefined;
  afterEach(() => {
    rendered?.unmount();
    rendered = undefined;
    vi.unstubAllGlobals();
  });
  const CTX = { apiBaseUrl: "https://api.example.test", token: "tok", propertyId: "p1", orgSlug: "demo" };
  async function esperar() {
    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });
  }

  it("un rol SIN Copiloto (recepcion) no llama al servidor ni pinta nada", async () => {
    const f = vi.fn(async () => json(200, { disponible: true, pins: [] }));
    vi.stubGlobal("fetch", f);
    rendered = renderComponent(<MemoryRouter><HotelesFijadosCopiloto {...CTX} role="frontdesk" /></MemoryRouter>);
    await esperar();
    expect(f).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toBe("");
  });

  it("owner: lee los fijados de SU hotel y re-ejecuta cada uno por la ruta de resultado", async () => {
    const f = vi.fn(async (url: unknown) =>
      String(url).endsWith("/resultado")
        ? json(200, { id: "a", titulo: "Ocupación", status: "ok", text: "x", blocks: [{ tool: "ocupacion_adr_revpar", title: "Ocupación, ADR y RevPAR", columns: [{ key: "ocupacion", label: "Ocupación", kind: "percent" }], rows: [{ ocupacion: 35 }], truncated: false }], sources: [{ tool: "ocupacion_adr_revpar", source: "Reservas", periodLabel: "últimos 30 días", scopeLabel: "todos tus hoteles" }] })
        : json(200, { disponible: true, pins: [{ id: "a", titulo: "Ocupación", herramienta: "ocupacion_adr_revpar", compartido: false, propio: true }] }),
    );
    vi.stubGlobal("fetch", f);
    rendered = renderComponent(<MemoryRouter><HotelesFijadosCopiloto {...CTX} role="owner" /></MemoryRouter>);
    await esperar();
    await esperar();
    expect(llamadas(f).map((l) => l.url)).toEqual([`${CTX.apiBaseUrl}/hoteles/p1/chat-datos/pins`, `${CTX.apiBaseUrl}/hoteles/p1/chat-datos/pins/a/resultado`]);
    expect(rendered.container.textContent).toContain("Fijados del Copiloto");
    expect(rendered.container.textContent).toContain("Reservas · últimos 30 días · todos tus hoteles");
  });

  it("el servidor responde 403 (rol sin Copiloto que el cliente no conocia): la seccion no se pinta", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(403, {})));
    rendered = renderComponent(<MemoryRouter><HotelesFijadosCopiloto {...CTX} /></MemoryRouter>);
    await esperar();
    expect(rendered.container.textContent).toBe("");
  });
});
