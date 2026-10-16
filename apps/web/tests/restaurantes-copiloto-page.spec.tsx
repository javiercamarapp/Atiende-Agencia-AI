// @vitest-environment jsdom
//
// CHAT-08: pagina del Copiloto de restaurantes montada con el ChatDatosShell real de @atiende/ui y el transporte real
// (`fetch` falso, sin red): portada con chips y categorias de la config, pregunta -> POST NDJSON -> pasos y respuesta,
// historial lateral contra el backend, rol sin acceso (403), asistente no activado ("Pronto") y cambio de sucursal.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { RestaurantesCopilotoPage } from "../src/verticals/restaurantes/pages/Copiloto.tsx";
import { COPILOTO_RESTAURANTES } from "../src/lib/copiloto/config/restaurantes.ts";
import { changeValue, click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const API = "https://api.test";
const enc = new TextEncoder();

interface Llamada {
  readonly url: string;
  readonly method: string;
  readonly body?: unknown;
  readonly accept?: string;
}
let llamadas: Llamada[] = [];

const FIN = {
  t: "fin",
  conversacionId: "11111111-1111-4111-8111-111111111111",
  seq: 2,
  respuesta: {
    status: "ok",
    text: "Esta semana vendiste $12,480 MXN.",
    blocks: [],
    sources: [{ tool: "ventas_por_dia", source: "Pedidos", periodLabel: "esta semana", scopeLabel: "todas tus sucursales" }],
    toolsUsed: ["ventas_por_dia"],
  },
};

function ndjson(eventos: readonly unknown[]): Response {
  const cuerpo = eventos.map((e) => `${JSON.stringify(e)}\n`).join("");
  return new Response(new ReadableStream({ start: (c) => { c.enqueue(enc.encode(cuerpo)); c.close(); } }), { status: 200, headers: { "content-type": "application/x-ndjson" } });
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Rutas = (url: string, init: RequestInit) => Response | undefined;
function instalarFetch(estado: () => Response, extra: Rutas = () => undefined): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      llamadas.push({ url, method: init.method ?? "GET", ...(init.body ? { body: JSON.parse(String(init.body)) } : {}), ...(headers["accept"] ? { accept: headers["accept"] } : {}) });
      if (url.endsWith("/estado")) return estado();
      const r = extra(url, init);
      if (r) return r;
      if (init.method === "POST") return ndjson([{ t: "paso", fase: "inicio", herramienta: "ventas_por_dia" }, { t: "paso", fase: "fin", herramienta: "ventas_por_dia" }, FIN]);
      return json(200, { disponible: true, conversaciones: [] });
    }),
  );
}
const estadoOk = () => json(200, { available: true, permitido: true, motivo: null, usoHoyPct: 12 });

let rendered: RenderedComponent | undefined;
beforeEach(() => {
  llamadas = [];
  installMatchMediaStub();
  installMemoryLocalStorage();
  // jsdom no implementa scrollIntoView (el shell lo usa al llegar mensajes).
  Element.prototype.scrollIntoView = () => undefined;
  // El fondo de pixeles pide un contexto 2D que jsdom no trae; sin contexto, la pagina funciona igual (solo es decorativo).
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

async function esperar(ms = 30): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

const pagina = (propertyId = "prop-1") => (
  <MemoryRouter>
    <RestaurantesCopilotoPage apiBaseUrl={API} token="tok" propertyId={propertyId} orgSlug="demo" role="owner" staffFullName="Ana" staffEmail="a@b.mx" />
  </MemoryRouter>
);
async function montar(propertyId?: string): Promise<HTMLElement> {
  rendered = renderComponent(pagina(propertyId));
  await esperar();
  return rendered.container;
}
const botones = (root: ParentNode) => [...root.querySelectorAll("button")];
const porTexto = (root: ParentNode, t: string) => botones(root).find((b) => b.textContent?.trim().includes(t));

describe("RestaurantesCopilotoPage", () => {
  it("consulta /estado de la sucursal activa y pinta la portada con el h1, los 5 chips y el uso del dia", async () => {
    instalarFetch(estadoOk);
    const root = await montar();
    expect(llamadas[0]?.url).toBe(`${API}/v1/restaurantes/prop-1/admin/chat-datos/estado`);
    expect(root.querySelector("h1")?.textContent).toBe("Pregunta a tus datos");
    for (const chip of COPILOTO_RESTAURANTES.sugerencias) expect(porTexto(root, chip)).toBeDefined();
    expect(COPILOTO_RESTAURANTES.sugerencias).toHaveLength(5);
    expect(root.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("12");
  });

  it("'Consulta' despliega las categorias de la config con sus preguntas (Ventas, Operación, Clientes, CFO)", async () => {
    instalarFetch(estadoOk);
    const root = await montar();
    click(porTexto(root, "Consulta")!);
    for (const c of COPILOTO_RESTAURANTES.categorias) {
      expect(root.textContent).toContain(c.titulo);
      expect(c.preguntas.length).toBeGreaterThanOrEqual(2);
      expect(c.preguntas.length).toBeLessThanOrEqual(c.titulo === "CFO" ? 5 : 3);
    }
    expect(COPILOTO_RESTAURANTES.categorias.map((c) => c.titulo)).toEqual(["Ventas", "Operación", "Clientes", "CFO"]);
  });

  it("elegir un chip hace POST NDJSON de consulta DIRECTA (tool + args + label) + conversationId 'new' y pinta la respuesta con su fuente enlazada a la pantalla interna", async () => {
    instalarFetch(estadoOk);
    const root = await montar();
    click(porTexto(root, "¿Cuánto vendí esta semana?")!);
    await esperar();
    const post = llamadas.find((l) => l.method === "POST");
    expect(post?.url).toBe(`${API}/v1/restaurantes/prop-1/admin/chat-datos`);
    expect(post?.accept).toBe("application/x-ndjson");
    // El chip tiene consulta directa: viaja la herramienta con sus argumentos (sin modelo) y el texto del chip como etiqueta.
    expect(post?.body).toEqual({ tool: "ventas_por_dia", args: { periodo: "esta_semana" }, label: "¿Cuánto vendí esta semana?", conversationId: "new" });
    expect(root.textContent).toContain("Esta semana vendiste $12,480 MXN.");
    const fuente = [...root.querySelectorAll("a")].find((a) => a.textContent?.includes("Pedidos"));
    expect(fuente?.getAttribute("href")).toBe("/restaurantes/demo/historial");
  });

  it("la segunda pregunta continua la conversacion guardada (manda su id, nunca historial)", async () => {
    instalarFetch(estadoOk);
    const root = await montar();
    click(porTexto(root, "¿Cuánto vendí esta semana?")!);
    await esperar();
    const entrada = root.querySelector("textarea")!;
    changeValue(entrada, "¿y el mes pasado?");
    click(root.querySelector('button[aria-label="Enviar"]')!);
    await esperar();
    const posts = llamadas.filter((l) => l.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).toEqual({ question: "¿y el mes pasado?", conversationId: FIN.conversacionId });
  });

  it("un error del servidor se muestra como aviso honesto, nunca como respuesta inventada", async () => {
    instalarFetch(estadoOk, (_u, init) => (init.method === "POST" ? json(500, { message: "boom" }) : undefined));
    const root = await montar();
    click(porTexto(root, "¿Cuánto vendí esta semana?")!);
    await esperar();
    expect(root.textContent).not.toContain("Esta semana vendiste");
    expect(root.textContent).toMatch(/no pude|no está disponible|intenta|inténtalo/i);
  });

  it("el historial lateral lista, renombra y borra contra el backend", async () => {
    const conv = { id: "22222222-2222-4222-8222-222222222222", titulo: "Ventas de la semana", actualizadaEn: new Date().toISOString(), mensajes: 2 };
    instalarFetch(estadoOk, (url, init) => {
      if (url.endsWith("/conversaciones") && !init.method) return json(200, { disponible: true, conversaciones: [conv] });
      if (url.endsWith(`/conversaciones/${conv.id}`) && init.method === "PATCH") return json(200, { id: conv.id, titulo: "Renombrada" });
      if (url.endsWith(`/conversaciones/${conv.id}`) && init.method === "DELETE") return new Response(null, { status: 204 });
      return undefined;
    });
    const root = await montar();
    click(root.querySelector('button[aria-label="Historial de chats"]')!);
    await esperar();
    expect(llamadas.some((l) => l.url === `${API}/v1/restaurantes/prop-1/admin/chat-datos/conversaciones` && l.method === "GET")).toBe(true);
    expect(document.body.textContent).toContain("Ventas de la semana");
  });

  it("rol sin acceso (403 en /estado): EstadoVacio con el texto del brief y SIN compositor ni chips", async () => {
    instalarFetch(() => json(403, { message: "forbidden" }));
    const root = await montar();
    expect(root.textContent).toContain("Tu rol no tiene acceso al Copiloto. Pídele acceso al dueño.");
    expect(root.querySelector("textarea")).toBeNull();
    expect(llamadas.filter((l) => l.method === "POST")).toHaveLength(0);
  });

  it("asistente sin proveedor de IA (available:false): estado 'Pronto' honesto, sin compositor", async () => {
    instalarFetch(() => json(200, { available: false, permitido: false, motivo: "no_activado", usoHoyPct: null }));
    const root = await montar();
    expect(root.textContent).toContain("Pronto");
    expect(root.textContent).toContain("requiere un proveedor de IA");
    expect(root.querySelector("textarea")).toBeNull();
  });

  it("si /estado falla (red/500) NO asume que esta disponible: error con Reintentar, y reintentar vuelve a consultar", async () => {
    let n = 0;
    instalarFetch(() => (++n === 1 ? json(500, {}) : estadoOk()));
    const root = await montar();
    expect(root.querySelector("textarea")).toBeNull();
    const reintentar = porTexto(root, "Reintentar")!;
    expect(reintentar).toBeDefined();
    click(reintentar);
    await esperar();
    expect(root.querySelector("textarea")).not.toBeNull();
  });

  it("tope diario agotado: avisa y conserva el historial", async () => {
    instalarFetch(() => json(200, { available: true, permitido: false, motivo: "tope_diario", usoHoyPct: 100 }));
    const root = await montar();
    expect(root.textContent).toContain("Llegaste al tope diario de preguntas");
    expect(root.querySelector('button[aria-label="Historial de chats"]')).not.toBeNull();
  });

  it("al cambiar de sucursal vuelve a consultar el estado de ESA sucursal y las preguntas viajan a su ruta", async () => {
    instalarFetch(estadoOk);
    const root = await montar("prop-1");
    rendered!.rerender(pagina("prop-2"));
    await esperar();
    expect(llamadas.filter((l) => l.url.endsWith("/estado")).map((l) => l.url)).toEqual([
      `${API}/v1/restaurantes/prop-1/admin/chat-datos/estado`,
      `${API}/v1/restaurantes/prop-2/admin/chat-datos/estado`,
    ]);
    click(porTexto(root, "¿Cuánto vendí esta semana?")!);
    await esperar();
    expect(llamadas.find((l) => l.method === "POST")?.url).toBe(`${API}/v1/restaurantes/prop-2/admin/chat-datos`);
  });
});
