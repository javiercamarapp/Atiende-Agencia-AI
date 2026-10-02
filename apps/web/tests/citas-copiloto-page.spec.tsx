// @vitest-environment jsdom
//
// CHAT-13: pagina del Copiloto de citas montada con el ChatDatosShell real de @atiende/ui y el transporte real
// (`fetch` falso, sin red): portada con chips y categorias de la config, pregunta -> POST NDJSON -> pasos y respuesta,
// historial lateral contra el backend, rol sin acceso (staff, sin red; y 403), asistente no activado ("Pronto") y cambio de sucursal.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CitasCopilotoPage } from "../src/verticals/citas/pages/Copiloto.tsx";
import { COPILOTO_CITAS } from "../src/lib/copiloto/config/citas.ts";
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
    text: "Esta semana tienes 24 citas (18 completadas, 4 por atender, 2 canceladas).",
    blocks: [],
    sources: [{ tool: "citas_por_dia", source: "Citas de la agenda", periodLabel: "esta semana", scopeLabel: "todas tus sucursales" }],
    toolsUsed: ["citas_por_dia"],
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
      if (init.method === "POST") return ndjson([{ t: "paso", fase: "inicio", herramienta: "citas_por_dia" }, { t: "paso", fase: "fin", herramienta: "citas_por_dia" }, FIN]);
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

const pagina = (propertyId = "prop-1", role = "owner") => (
  <MemoryRouter>
    <CitasCopilotoPage apiBaseUrl={API} token="tok" propertyId={propertyId} orgSlug="demo" orgId="org-1" role={role} staffFullName="Ana" staffEmail="a@b.mx" />
  </MemoryRouter>
);
async function montar(propertyId?: string, role?: string): Promise<HTMLElement> {
  rendered = renderComponent(pagina(propertyId, role));
  await esperar();
  return rendered.container;
}
const botones = (root: ParentNode) => [...root.querySelectorAll("button")];
const porTexto = (root: ParentNode, t: string) => botones(root).find((b) => b.textContent?.trim().includes(t));
const CHIP = "¿Cuántas citas tengo esta semana?";
const TEXTO = "Esta semana tienes 24 citas (18 completadas, 4 por atender, 2 canceladas).";

describe("CitasCopilotoPage", () => {
  it("consulta /estado de la sucursal activa y pinta la portada con el h1, los 5 chips y el uso del dia", async () => {
    instalarFetch(estadoOk);
    const root = await montar();
    expect(llamadas[0]?.url).toBe(`${API}/citas/prop-1/chat-datos/estado`);
    expect(root.querySelector("h1")?.textContent).toBe("Pregunta a tus datos");
    for (const chip of COPILOTO_CITAS.sugerencias) expect(porTexto(root, chip)).toBeDefined();
    expect(COPILOTO_CITAS.sugerencias).toHaveLength(5);
    expect(root.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("12");
  });

  it("'Consulta' despliega las 3 categorias de la config con 2 o 3 preguntas cada una", async () => {
    instalarFetch(estadoOk);
    const root = await montar();
    click(porTexto(root, "Consulta")!);
    for (const c of COPILOTO_CITAS.categorias) {
      expect(root.textContent).toContain(c.titulo);
      expect(c.preguntas.length).toBeGreaterThanOrEqual(2);
      expect(c.preguntas.length).toBeLessThanOrEqual(3);
    }
    expect(COPILOTO_CITAS.categorias.map((c) => c.titulo)).toEqual(["Agenda y ocupación", "Cancelaciones y recordatorios", "Ingresos y clientes"]);
  });

  it("toda herramienta nombrada en la config existe en el catalogo cerrado de citas y tiene ruta fuente interna", () => {
    const catalogo = ["citas_por_dia", "ocupacion", "no_shows_y_cancelaciones", "ingresos_por_periodo", "ingresos_por_servicio", "clientes_nuevos_vs_recurrentes", "huecos_libres", "recordatorios"];
    expect(Object.keys(COPILOTO_CITAS.etiquetasHerramienta).sort()).toEqual([...catalogo].sort());
    expect(Object.keys(COPILOTO_CITAS.rutasFuente).sort()).toEqual([...catalogo].sort());
    for (const ruta of Object.values(COPILOTO_CITAS.rutasFuente)) expect(ruta).toMatch(/^\/citas\/:orgSlug\//);
  });

  it("elegir un chip hace POST NDJSON con SOLO pregunta + conversationId 'new' y pinta la respuesta con su fuente enlazada a la pantalla interna", async () => {
    instalarFetch(estadoOk);
    const root = await montar();
    click(porTexto(root, CHIP)!);
    await esperar();
    const post = llamadas.find((l) => l.method === "POST");
    expect(post?.url).toBe(`${API}/citas/prop-1/chat-datos`);
    expect(post?.accept).toBe("application/x-ndjson");
    expect(post?.body).toEqual({ question: CHIP, conversationId: "new" });
    expect(root.textContent).toContain(TEXTO);
    const fuente = [...root.querySelectorAll("a")].find((a) => a.textContent?.includes("Citas de la agenda"));
    expect(fuente?.getAttribute("href")).toBe("/citas/demo/agenda");
  });

  it("la segunda pregunta continua la conversacion guardada (manda su id, nunca historial)", async () => {
    instalarFetch(estadoOk);
    const root = await montar();
    click(porTexto(root, CHIP)!);
    await esperar();
    changeValue(root.querySelector("textarea")!, "¿y el mes pasado?");
    click(root.querySelector('button[aria-label="Enviar"]')!);
    await esperar();
    const posts = llamadas.filter((l) => l.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).toEqual({ question: "¿y el mes pasado?", conversationId: FIN.conversacionId });
  });

  it("un error del servidor se muestra como aviso honesto, nunca como respuesta inventada", async () => {
    instalarFetch(estadoOk, (_u, init) => (init.method === "POST" ? json(500, { message: "boom" }) : undefined));
    const root = await montar();
    click(porTexto(root, CHIP)!);
    await esperar();
    expect(root.textContent).not.toContain("Esta semana tienes");
    expect(root.textContent).toMatch(/no pude|no está disponible|intenta|inténtalo/i);
  });

  it("el historial lateral lista las conversaciones guardadas contra el backend de citas", async () => {
    const conv = { id: "22222222-2222-4222-8222-222222222222", titulo: "Citas de la semana", actualizadaEn: new Date().toISOString(), mensajes: 2 };
    instalarFetch(estadoOk, (url, init) => (url.endsWith("/conversaciones") && !init.method ? json(200, { disponible: true, conversaciones: [conv] }) : undefined));
    const root = await montar();
    click(root.querySelector('button[aria-label="Historial de chats"]')!);
    await esperar();
    expect(llamadas.some((l) => l.url === `${API}/citas/prop-1/chat-datos/conversaciones` && l.method === "GET")).toBe(true);
    expect(document.body.textContent).toContain("Citas de la semana");
  });

  it("rol sin acceso (403 en /estado): EstadoVacio con el texto de la config y SIN compositor ni chips", async () => {
    instalarFetch(() => json(403, { message: "forbidden" }));
    const root = await montar();
    expect(root.textContent).toContain(COPILOTO_CITAS.textoSinAcceso);
    expect(root.querySelector("textarea")).toBeNull();
    expect(llamadas.filter((l) => l.method === "POST")).toHaveLength(0);
  });

  it("staff: estado 'Sin acceso' SIN ninguna llamada de red ni compositor", async () => {
    instalarFetch(estadoOk);
    const root = await montar("prop-1", "staff");
    expect(root.textContent).toContain("Sin acceso");
    expect(root.textContent).toContain(COPILOTO_CITAS.textoSinAcceso);
    expect(root.querySelector("textarea")).toBeNull();
    expect(llamadas).toHaveLength(0);
  });

  it("el rol admin tiene acceso igual que owner (consulta /estado y muestra el compositor)", async () => {
    instalarFetch(estadoOk);
    const root = await montar("prop-1", "admin");
    expect(llamadas[0]?.url).toBe(`${API}/citas/prop-1/chat-datos/estado`);
    expect(root.querySelector("textarea")).not.toBeNull();
  });

  it("abortar: 'Detener' cancela la peticion en vuelo, no deja respuesta inventada y permite preguntar de nuevo", async () => {
    let senal: AbortSignal | undefined;
    instalarFetch(estadoOk, (_u, init) => {
      if (init.method !== "POST") return undefined;
      senal = init.signal ?? undefined;
      // NDJSON que nunca termina: solo el abort lo corta.
      return new Response(new ReadableStream({ start: (c) => c.enqueue(enc.encode(`${JSON.stringify({ t: "paso", fase: "inicio", herramienta: "citas_por_dia" })}\n`)) }), { status: 200, headers: { "content-type": "application/x-ndjson" } });
    });
    const root = await montar();
    click(porTexto(root, CHIP)!);
    await esperar();
    expect(root.textContent).toContain("Contando las citas por día");
    click(root.querySelector('button[aria-label="Detener"]')!);
    await esperar();
    expect(senal?.aborted).toBe(true);
    expect(root.querySelector('button[aria-label="Detener"]')).toBeNull();
    expect(root.textContent).not.toContain("Esta semana tienes");
    expect(root.querySelector('button[aria-label="Enviar"]')).not.toBeNull();
  });

  it("Escape en el compositor con texto nunca envia una pregunta", async () => {
    instalarFetch(estadoOk);
    const root = await montar();
    const entrada = root.querySelector("textarea")!;
    changeValue(entrada, "¿y los cancelados?");
    await act(async () => {
      entrada.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await esperar();
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
    click(porTexto(root, "Reintentar")!);
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
      `${API}/citas/prop-1/chat-datos/estado`,
      `${API}/citas/prop-2/chat-datos/estado`,
    ]);
    click(porTexto(root, CHIP)!);
    await esperar();
    expect(llamadas.find((l) => l.method === "POST")?.url).toBe(`${API}/citas/prop-2/chat-datos`);
  });
});
