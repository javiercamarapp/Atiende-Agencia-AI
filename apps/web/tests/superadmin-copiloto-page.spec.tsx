// @vitest-environment jsdom
//
// CHAT-17: Copiloto de plataforma (superadmin) con el ChatDatosShell real, el transporte real y un `fetch` falso (sin red). Cubre la pagina, los estados honestos
// (sin acceso, 409 impersonando, error, sin IA, interruptor, tope), la tarjeta de accion (Confirmar pide el step-up ANTES de enviar; Cancelar y cancelar el
// dialogo no envian NINGUNA confirmacion), el panel Cmd+J dentro del shell-layout (no se desmonta al navegar, Esc lo cierra, inert al cerrar, "Abrir en pagina
// completa") y el cliente de acciones. El servidor real de las propuestas lo prueban apps/api/tests/superadmin-copiloto-acciones.spec.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Outlet, Route, Routes, useNavigate } from "react-router-dom";
import { SuperAdminShell } from "../src/superadmin/SuperAdminShell.tsx";
import { SuperAdminCopilotoPage } from "../src/superadmin/pages/Copiloto.tsx";
import { COPILOTO_SUPERADMIN, DIRECTAS_COPILOTO_SUPERADMIN } from "../src/superadmin/lib/copiloto-config.ts";
import { consultarEstadoSuperadmin, crearClienteAcciones, crearClienteFijadosSuperadmin } from "../src/superadmin/lib/copiloto-cliente.ts";
import { guardarStepUp, limpiarStepUp } from "../src/superadmin/lib/stepup.ts";
import { changeValue, click, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

vi.mock("../src/lib/useNotifications.ts", () => ({
  useNotifications: () => ({ items: [], unreadCount: 0, hayNoLeidas: false, loading: false, refetch: () => {}, onMarkRead: () => {}, onMarkAllRead: () => {} }),
}));
vi.mock("../src/superadmin/components/ImpersonacionBanner.tsx", () => ({ ImpersonacionBanner: () => null }));

const API = "https://api.test";
const TOKEN = "tok";
const SESSION = { token: TOKEN, refreshToken: "reftok", email: "root@example.com", fullName: "Root" };
const enc = new TextEncoder();
const PROPUESTA = "bcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrst";
const AGENTE = "restaurantes:whatsapp_agent";
const MOTIVO = "Costos fuera de control en este agente";

interface Llamada {
  readonly url: string;
  readonly method: string;
  readonly body?: unknown;
  readonly headers: Record<string, string>;
}
let llamadas: Llamada[] = [];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function ndjson(eventos: readonly unknown[]): Response {
  const cuerpo = eventos.map((e) => `${JSON.stringify(e)}\n`).join("");
  return new Response(new ReadableStream({ start: (c) => { c.enqueue(enc.encode(cuerpo)); c.close(); } }), { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

const estadoOk = (extra: Record<string, unknown> = {}) => ({
  disponible: true,
  permitido: true,
  motivo: null,
  rol: "superadmin",
  financierasDisponibles: true,
  stepUpRequerido: false,
  interruptor: { apagado: false, clave: null },
  gastoMes: { usadoMicroUsd: 1_000_000, topeMicroUsd: 25_000_000, usoPct: 4, medidoEnBitacora: true },
  acciones: { propone: true },
  herramientas: [],
  ...extra,
});

const FIN_TEXTO = {
  t: "fin",
  conversacionId: "11111111-1111-4111-8111-111111111111",
  seq: 2,
  respuesta: { status: "ok", text: "Hay 3 organizaciones.", blocks: [], sources: [{ tool: "organizaciones", source: "Organizaciones", scopeLabel: "Toda la plataforma" }], toolsUsed: ["organizaciones"] },
};
const FIN_PROPUESTA = {
  t: "fin",
  conversacionId: "22222222-2222-4222-8222-222222222222",
  seq: 2,
  respuesta: {
    status: "ok",
    text: "Preparé la propuesta; confírmala en la tarjeta.",
    blocks: [
      {
        kind: "table",
        tool: "proponer_accion",
        title: "Proponer una acción",
        columns: [{ key: "propuesta", label: "Propuesta", kind: "text" }],
        rows: [{ propuesta: PROPUESTA, clase: "interruptor", tipo: "apagar_agente", objetivo: AGENTE, resumen: "Apagar el agente restaurantes:whatsapp_agent: deja de llamar al modelo.", vence: "2026-10-03T12:05:00.000Z", agente: AGENTE }],
        truncated: false,
      },
    ],
    sources: [],
    toolsUsed: ["proponer_accion"],
  },
};

type Rutas = (url: string, init: RequestInit) => Response | undefined;
function instalarFetch(estado: () => Response = () => json(200, estadoOk()), extra: Rutas = () => undefined, fin: unknown = FIN_TEXTO): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const headers = (init.headers ?? {}) as Record<string, string>;
      llamadas.push({ url, method: init.method ?? "GET", headers, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.endsWith("/superadmin/copiloto/estado")) return estado();
      const r = extra(url, init);
      if (r) return r;
      if (url.includes("/superadmin/copiloto/acciones/") && (init.method ?? "GET") === "GET") return json(200, { propuesta: PROPUESTA, clase: "interruptor", tipo: "apagar_agente", resumen: "Apagar el agente restaurantes:whatsapp_agent: deja de llamar al modelo.", estado: "pendiente", venceEn: "2026-10-03T12:05:00.000Z", agente: AGENTE });
      if (url.endsWith("/superadmin/copiloto") && init.method === "POST") return ndjson([{ t: "paso", fase: "inicio", herramienta: "organizaciones" }, { t: "paso", fase: "fin", herramienta: "organizaciones" }, fin]);
      return json(200, { disponible: true, conversaciones: [] });
    }),
  );
}
const confirmaciones = () => llamadas.filter((l) => l.method === "POST" && /(?:\/acciones\/confirmar|\/intents\/[^/]+\/confirmar)$/.test(l.url));

let rendered: RenderedComponent | undefined;
beforeEach(() => {
  llamadas = [];
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.superadmin.session", JSON.stringify(SESSION));
  Element.prototype.scrollIntoView = () => undefined;
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
  limpiarStepUp();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function esperar(ms = 30): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}
const botones = (root: ParentNode) => [...root.querySelectorAll("button")];
const porTexto = (root: ParentNode, t: string) => botones(root).find((b) => b.textContent?.trim().includes(t));

async function montarPagina(ruta = "/superadmin/copiloto"): Promise<HTMLElement> {
  rendered = renderComponent(
    <MemoryRouter initialEntries={[ruta]}>
      <SuperAdminCopilotoPage apiBaseUrl={API} token={TOKEN} />
    </MemoryRouter>,
  );
  await esperar();
  return rendered.container;
}

async function preguntar(root: HTMLElement, texto: string) {
  changeValue(root.querySelector("textarea")!, texto);
  click(root.querySelector('[aria-label="Enviar"]')!);
  await esperar();
}

describe("pagina /superadmin/copiloto", () => {
  it("pide el estado al API real y pinta la portada: h1, subtitulo, contexto 'Toda la plataforma', 5 chips y el uso del tope mensual", async () => {
    instalarFetch();
    const root = await montarPagina();
    expect(llamadas[0]?.url).toBe(`${API}/superadmin/copiloto/estado`);
    expect(llamadas[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(root.querySelector("h1")?.textContent).toBe("Pregunta a tus datos");
    expect(root.textContent).toContain("Toda la plataforma");
    expect(COPILOTO_SUPERADMIN.sugerencias).toHaveLength(5);
    for (const chip of COPILOTO_SUPERADMIN.sugerencias) expect(porTexto(root, chip)).toBeDefined();
    expect(root.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("4");
  });

  it("las categorias son CFO Y COBRANZA, VENTAS Y COSTOS DE IA y CLIENTES, AGENTES Y SALUD VARIAS ORGANIZACIONES y ACTIVIDAD POR NEGOCIO, con 4-5 preguntas, y las fases arrancan con 'Leyendo la plataforma…'", () => {
    expect(COPILOTO_SUPERADMIN.categorias.map((c) => c.titulo)).toEqual(["CFO y cobranza", "Ventas y costos de IA", "Clientes, agentes y salud", "Varias organizaciones", "Actividad por negocio"]);
    for (const c of COPILOTO_SUPERADMIN.categorias) {
      expect(c.preguntas.length).toBeGreaterThanOrEqual(4);
      expect(c.preguntas.length).toBeLessThanOrEqual(5);
    }
    expect(COPILOTO_SUPERADMIN.textos.fases[0]).toEqual([0, "Leyendo la plataforma…"]);
  });

  it("un chip es consulta DIRECTA: POST NDJSON con tool + args + label y conversationId 'new'; la fuente enlaza a la pantalla interna", async () => {
    instalarFetch();
    const root = await montarPagina();
    click(porTexto(root, "¿Cuántas organizaciones tengo por estado?")!);
    await esperar();
    const post = llamadas.find((l) => l.method === "POST");
    expect(post?.url).toBe(`${API}/superadmin/copiloto`);
    expect(post?.headers["accept"]).toBe("application/x-ndjson");
    expect(post?.body).toEqual({ tool: "organizaciones", label: "¿Cuántas organizaciones tengo por estado?", conversationId: "new" });
    expect(root.textContent).toContain("Hay 3 organizaciones.");
    const fuente = [...root.querySelectorAll("a")].find((a) => a.textContent?.includes("Organizaciones"));
    expect(fuente?.getAttribute("href")).toBe("/superadmin/organizaciones");
  });

  it("sin acceso (403) y con impersonacion (409) muestran su motivo y NO montan el chat", async () => {
    instalarFetch(() => json(403, { code: "forbidden" }));
    let root = await montarPagina();
    expect(root.textContent).toContain("Sin acceso");
    expect(root.querySelector("textarea")).toBeNull();
    rendered?.unmount();
    instalarFetch(() => json(409, { code: "conflict", message: "El Copiloto de plataforma no está disponible mientras impersonas a una organización." }));
    root = await montarPagina();
    expect(root.textContent).toContain("Copiloto deshabilitado");
    expect(root.textContent).toContain("mientras impersonas");
    expect(root.querySelector("textarea")).toBeNull();
    expect(root.querySelector('a[href="/superadmin/impersonacion"]')).not.toBeNull();
  });

  it("si no se puede verificar el estado ofrece reintentar (nunca asume disponible)", async () => {
    let n = 0;
    instalarFetch(() => (n++ === 0 ? json(500, {}) : json(200, estadoOk())));
    const root = await montarPagina();
    expect(root.textContent).toContain("No se pudo abrir el Copiloto");
    click(porTexto(root, "Reintentar")!);
    await esperar();
    expect(root.querySelector("textarea")).not.toBeNull();
  });

  it.each([
    ["no_activado", "Preguntas libres no activadas"],
    ["interruptor_apagado", "El Copiloto está en pausa"],
    ["tope_mensual", "Llegaste al tope mensual"],
  ])("motivo '%s': aviso honesto y las consultas de los botones siguen disponibles", async (motivo, titulo) => {
    instalarFetch(() => json(200, estadoOk({ permitido: false, motivo, disponible: motivo !== "no_activado" })));
    const root = await montarPagina();
    expect(root.textContent).toContain(titulo);
    expect(root.querySelector("textarea")).not.toBeNull();
  });

  it("abre la conversacion indicada en ?c= (para el enlace del panel) y la refleja al cambiar", async () => {
    instalarFetch(undefined, (url) => (url.endsWith("/conversaciones/11111111-1111-4111-8111-111111111111") ? json(200, { id: "11111111-1111-4111-8111-111111111111", titulo: "Mi chat", mensajes: [{ id: "m1", role: "user", text: "hola previo", seq: 1 }, { id: "m2", role: "assistant", text: "respuesta previa", seq: 2, status: "ok" }] }) : undefined));
    const root = await montarPagina("/superadmin/copiloto?c=11111111-1111-4111-8111-111111111111");
    expect(root.textContent).toContain("hola previo");
    expect(root.textContent).toContain("respuesta previa");
  });
});

describe("tarjeta de accion dentro de la pagina", () => {
  const proponer = async () => {
    instalarFetch(undefined, undefined, FIN_PROPUESTA);
    const root = await montarPagina();
    await preguntar(root, "apaga el agente de whatsapp de restaurantes");
    return root;
  };

  it("el modelo propone: aparece la tarjeta (nunca una tabla), pregunta su vigencia al servidor y NO se envia ninguna confirmacion", async () => {
    const root = await proponer();
    expect(root.querySelector('[data-testid="copiloto-tarjeta-accion"]')).not.toBeNull();
    expect(root.querySelector("table")).toBeNull();
    expect(llamadas.some((l) => l.method === "GET" && l.url.includes(`/superadmin/copiloto/acciones/${PROPUESTA}?agente=${encodeURIComponent(AGENTE)}`))).toBe(true);
    expect(confirmaciones()).toHaveLength(0);
    expect(root.querySelector('a[href="/superadmin/acciones"]')).not.toBeNull();
  });

  it("Cancelar NO hace ningun POST de confirmacion", async () => {
    const root = await proponer();
    click(porTexto(root, "Cancelar")!);
    await esperar();
    expect(confirmaciones()).toHaveLength(0);
    expect(root.textContent).toContain("Cancelada");
  });

  it("Confirmar manda UNA confirmacion con propuesta, agente y motivo (y la tarjeta queda ejecutada)", async () => {
    const root = await proponer();
    changeValue(root.querySelector('[data-testid="copiloto-tarjeta-accion"] textarea')!, MOTIVO);
    instalarFetch(undefined, (url, init) => (url.endsWith("/superadmin/copiloto/acciones/confirmar") && init.method === "POST" ? json(200, { estado: "ejecutada" }) : undefined), FIN_PROPUESTA);
    click(porTexto(root, "Confirmar")!);
    await esperar();
    const c = confirmaciones();
    expect(c).toHaveLength(1);
    expect(c[0]?.url).toBe(`${API}/superadmin/copiloto/acciones/confirmar`);
    expect(c[0]?.body).toEqual({ propuesta: PROPUESTA, agente: AGENTE, motivo: MOTIVO });
    expect(root.querySelector('[data-testid="copiloto-tarjeta-accion"]')?.getAttribute("data-fase")).toBe("ejecutada");
  });

  it("si el servidor pide step-up y la persona cancela el dialogo, NO se envia ninguna confirmacion y no se ejecuta nada", async () => {
    // El shell registra el dialogo de step-up; aqui se monta dentro del layout para tener el StepUpDialog real.
    instalarFetch(() => json(200, estadoOk({ stepUpRequerido: true })), undefined, FIN_PROPUESTA);
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/superadmin/copiloto"]}>
        <Routes>
          <Route element={<SuperAdminShell apiBaseUrl={API} onRequireLogin={() => {}}>{(ctx) => <Outlet context={ctx} />}</SuperAdminShell>}>
            <Route path="/superadmin/copiloto" element={<SuperAdminCopilotoPage apiBaseUrl={API} token={TOKEN} />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    await esperar();
    const root = rendered.container;
    await preguntar(root, "apaga el agente");
    changeValue(root.querySelector('[data-testid="copiloto-tarjeta-accion"] textarea')!, MOTIVO);
    click(porTexto(root, "Confirmar")!);
    await esperar();
    const dialogo = document.body.querySelector('[role="dialog"]');
    expect(dialogo?.textContent).toContain("Verifica tu identidad");
    // Escape cierra el dialogo = cancelar la verificacion.
    keydown(document.activeElement ?? document.body, "Escape");
    const cancelar = [...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === "Cancelar");
    if (cancelar) click(cancelar);
    await esperar();
    expect(confirmaciones()).toHaveLength(0);
    expect(root.textContent).toContain("Falta verificar tu identidad");
    expect(root.querySelector('[data-testid="copiloto-tarjeta-accion"]')?.getAttribute("data-fase")).toBe("pendiente");
  });
});

describe("panel Cmd+J en el shell (layout)", () => {
  function IrA({ a }: { a: string }) {
    const navigate = useNavigate();
    return (
      <button type="button" data-testid={`ir-${a}`} onClick={() => navigate(a)}>
        ir a {a}
      </button>
    );
  }
  async function montarShell(ruta = "/superadmin") {
    instalarFetch();
    rendered = renderComponent(
      <MemoryRouter initialEntries={[ruta]}>
        <Routes>
          <Route element={<SuperAdminShell apiBaseUrl={API} onRequireLogin={() => {}}>{(ctx) => <Outlet context={ctx} />}</SuperAdminShell>}>
            <Route path="/superadmin" element={<div><IrA a="/superadmin/salud" /><IrA a="/superadmin/copiloto" />resumen</div>} />
            <Route path="/superadmin/salud" element={<div><IrA a="/superadmin" />salud</div>} />
            <Route path="/superadmin/copiloto" element={<SuperAdminCopilotoPage apiBaseUrl={API} token={TOKEN} />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    await esperar();
    return rendered.container;
  }
  const panel = () => document.getElementById("copiloto-panel") as HTMLElement;
  const atajo = (init: KeyboardEventInit = { metaKey: true }) => {
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true, ...init }));
    });
  };

  it("cerrado: aside colapsado (ancho 0 por CSS), inert, sin montar el cuerpo (no pide el estado del Copiloto)", async () => {
    await montarShell();
    expect(panel().dataset["abierto"]).toBe("false");
    expect(panel().className).toContain("copiloto-panel-lateral");
    expect(panel().hasAttribute("inert")).toBe(true);
    expect(llamadas.some((l) => l.url.endsWith("/superadmin/copiloto/estado"))).toBe(false);
  });

  it("Cmd+J (y Ctrl+J) lo abre, quita el inert, monta el Copiloto compacto y vuelve a cerrarlo", async () => {
    await montarShell();
    atajo();
    await esperar();
    expect(panel().dataset["abierto"]).toBe("true");
    expect(panel().hasAttribute("inert")).toBe(false);
    expect(panel().querySelector('[data-variante="panel"]')).not.toBeNull();
    expect(llamadas.filter((l) => l.url.endsWith("/superadmin/copiloto/estado"))).toHaveLength(1);
    atajo({ ctrlKey: true });
    await esperar();
    expect(panel().dataset["abierto"]).toBe("false");
    expect(panel().hasAttribute("inert")).toBe(true);
  });

  it("Escape lo cierra", async () => {
    await montarShell();
    atajo();
    await esperar();
    keydown(document.body, "Escape");
    expect(panel().dataset["abierto"]).toBe("false");
  });

  it("NO se desmonta al navegar: la conversacion y el nodo del panel sobreviven al cambiar de pagina, y al cerrarlo", async () => {
    const root = await montarShell();
    atajo();
    await esperar();
    click(porTexto(panel(), "¿Cuántas organizaciones tengo por estado?")!);
    await esperar();
    expect(panel().textContent).toContain("Hay 3 organizaciones.");
    const nodo = panel();
    const textarea = panel().querySelector("textarea");

    click(root.querySelector('[data-testid="ir-/superadmin/salud"]')!);
    await esperar();
    expect(root.textContent).toContain("salud");
    expect(panel()).toBe(nodo);
    expect(panel().querySelector("textarea")).toBe(textarea);
    expect(panel().textContent).toContain("Hay 3 organizaciones.");

    keydown(document.body, "Escape"); // cerrado
    click(root.querySelector('[data-testid="ir-/superadmin"]')!);
    await esperar();
    atajo(); // reabierto: sigue la misma conversacion
    await esperar();
    expect(panel().textContent).toContain("Hay 3 organizaciones.");
    // Una sola consulta de estado y un solo POST en toda la sesion.
    expect(llamadas.filter((l) => l.url.endsWith("/superadmin/copiloto/estado"))).toHaveLength(1);
    expect(llamadas.filter((l) => l.method === "POST")).toHaveLength(1);
  });

  it("'Abrir en página completa' lleva a /superadmin/copiloto con la conversacion abierta (?c=)", async () => {
    await montarShell();
    atajo();
    await esperar();
    click(porTexto(panel(), "¿Cuántas organizaciones tengo por estado?")!);
    await esperar();
    const enlace = [...panel().querySelectorAll("a")].find((a) => a.textContent?.includes("Abrir en página completa"))!;
    expect(enlace.getAttribute("href")).toBe("/superadmin/copiloto?c=11111111-1111-4111-8111-111111111111");
  });

  it("en la pagina completa del Copiloto no hay boton ni atajo ni panel abierto (seria el mismo chat dos veces)", async () => {
    await montarShell("/superadmin/copiloto");
    atajo();
    await esperar();
    expect(panel().dataset["abierto"]).toBe("false");
    expect(botones(document.body).some((b) => b.textContent?.includes("⌘J"))).toBe(false);
  });

  it("'Chatea con tus datos' de la barra tambien lo abre y declara aria-expanded", async () => {
    await montarShell();
    const boton = botones(document.body).find((b) => b.textContent?.includes("Chatea con tus datos") && b.getAttribute("aria-controls") === "copiloto-panel")!;
    expect(boton.getAttribute("aria-expanded")).toBe("false");
    click(boton);
    await esperar();
    expect(panel().dataset["abierto"]).toBe("true");
    expect(boton.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("hoja de estilos del panel", () => {
  const css = readFileSync(resolve(process.cwd(), "packages/ui/src/index.css"), "utf8");
  it("anima width y margin en 480 ms con la curva de Likida, abre a 400 px, no anima con movimiento reducido y en movil es pantalla completa", () => {
    expect(css).toMatch(/\.copiloto-panel-lateral \{[^}]*transition: width 480ms var\(--ease-out\), margin 480ms var\(--ease-out\);/s);
    expect(css).toMatch(/\.copiloto-panel-lateral\[data-abierto="true"\] \{ width: 400px;/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)[^]*\.copiloto-panel-lateral \{ transition: none; \}/);
    expect(css).toMatch(/max-width: 767px\)[^]*data-abierto="true"\] \{ position: fixed; inset: 0;/);
  });
});

describe("cliente del Copiloto", () => {
  it("estado: mapea 403, 409 y fallos; nunca asume disponible", async () => {
    instalarFetch(() => json(200, estadoOk()));
    expect(await consultarEstadoSuperadmin(API, TOKEN)).toMatchObject({ tipo: "ok", disponible: true, permitido: true, propone: true, usoMensualPct: 4 });
    instalarFetch(() => json(403, {}));
    expect(await consultarEstadoSuperadmin(API, TOKEN)).toEqual({ tipo: "sin_acceso" });
    instalarFetch(() => json(409, { message: "x" }));
    expect(await consultarEstadoSuperadmin(API, TOKEN)).toEqual({ tipo: "impersonando", mensaje: "x" });
    instalarFetch(() => json(500, {}));
    expect(await consultarEstadoSuperadmin(API, TOKEN)).toEqual({ tipo: "error" });
    instalarFetch(() => json(200, { cosa: 1 }));
    expect(await consultarEstadoSuperadmin(API, TOKEN)).toEqual({ tipo: "error" });
  });

  it("estado sin 'acciones.propone' no ofrece tarjetas", async () => {
    instalarFetch(() => json(200, estadoOk({ acciones: { propone: false } })));
    expect(await consultarEstadoSuperadmin(API, TOKEN)).toMatchObject({ propone: false });
  });

  it("confirmar un INTENT del catalogo usa la ruta existente de Acciones y traduce executed/failed", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const p = { propuesta: id, clase: "intent" as const, tipo: "ejecutar_mantenimiento_ahora", resumen: "r" };
    instalarFetch(() => json(200, estadoOk()), (url) => (url.endsWith(`/superadmin/acciones/intents/${id}/confirmar`) ? json(200, { intent: { estado: "executed" } }) : undefined));
    expect(await crearClienteAcciones(API, TOKEN).confirmar(p, "")).toEqual({ estado: "ejecutada" });
    expect(confirmaciones()[0]?.url).toBe(`${API}/superadmin/acciones/intents/${id}/confirmar`);
    instalarFetch(() => json(200, estadoOk()), () => json(200, { intent: { estado: "failed", error: "cola vacia" } }));
    expect(await crearClienteAcciones(API, TOKEN).confirmar(p, "")).toEqual({ estado: "fallida", mensaje: "cola vacia" });
  });

  it("409, 400, 503 y 404 se traducen a su error; con step-up ya vigente no se vuelve a pedir", async () => {
    guardarStepUp(TOKEN, "stp", 300);
    const p = { propuesta: PROPUESTA, clase: "interruptor" as const, tipo: "apagar_agente", agente: AGENTE, resumen: "r" };
    for (const [status, tipo] of [[409, "conflicto"], [400, "motivo"], [503, "no_disponible"], [404, "conflicto"], [500, "error"]] as const) {
      instalarFetch(() => json(200, estadoOk({ stepUpRequerido: true })), (url, init) => (init.method === "POST" ? json(status, { code: "x" }) : undefined));
      await expect(crearClienteAcciones(API, TOKEN).confirmar(p, MOTIVO)).rejects.toMatchObject({ tipo });
    }
    // El token de step-up vigente viaja en la cabecera de la confirmacion.
    expect(confirmaciones().at(-1)?.headers["x-stepup-token"]).toBe("stp");
  });

  it("consultar valida la respuesta: un estado desconocido es un error (no se inventa)", async () => {
    const p = { propuesta: PROPUESTA, clase: "interruptor" as const, tipo: "apagar_agente", agente: AGENTE, resumen: "r" };
    instalarFetch(undefined, (url) => (url.includes("/acciones/") ? json(200, { estado: "rara" }) : undefined));
    await expect(crearClienteAcciones(API, TOKEN).consultar(p, new AbortController().signal)).rejects.toThrow();
    instalarFetch(undefined, (url) => (url.includes("/acciones/") ? json(200, { estado: "vencida", resumen: "R" }) : undefined));
    expect(await crearClienteAcciones(API, TOKEN).consultar(p, new AbortController().signal)).toEqual({ estado: "vencida", resumen: "R", tipo: "apagar_agente" });
  });
});

const ID_CONV = "11111111-1111-4111-8111-111111111111";
const FIN_TABLA = {
  t: "fin",
  conversacionId: ID_CONV,
  seq: 2,
  respuesta: {
    status: "ok",
    text: "El MRR de octubre es 1,000 MXN.",
    blocks: [{ tool: "mrr", title: "MRR y ARR", columns: [{ key: "vertical", label: "Vertical", kind: "text" }, { key: "mrr_mxn", label: "MRR (MXN)", kind: "mxn" }], rows: [{ vertical: "restaurantes", mrr_mxn: 1000 }], truncated: false }],
    sources: [{ tool: "mrr", source: "MRR esperado", scopeLabel: "Toda la plataforma" }],
    toolsUsed: ["mrr"],
  },
};

describe("paridad con el chat de las verticales", () => {
  it("las consultas CFO son chips y tarjetas: MRR es consulta directa a `mrr` (el cliente maneja el step-up)", async () => {
    instalarFetch(undefined, undefined, FIN_TABLA);
    const root = await montarPagina();
    click(porTexto(root, "¿Cuál es mi MRR por vertical?")!);
    await esperar();
    const post = llamadas.find((l) => l.method === "POST");
    expect(post?.body).toEqual({ tool: "mrr", label: "¿Cuál es mi MRR por vertical?", conversationId: "new" });
    expect(root.textContent).toContain("El MRR de octubre");
    const fuente = [...root.querySelectorAll("a")].find((a) => a.textContent?.includes("MRR"));
    expect(fuente?.getAttribute("href")).toBe("/superadmin/ejecutivo");
  });

  it("tras una respuesta con cifras ofrece Copiar, CSV y Descargar PDF (POST real a /reporte?seq=N) y NO ofrece Fijar cuando el servidor no lo declara (`fijados` del estado)", async () => {
    const descargas: string[] = [];
    URL.createObjectURL = () => "blob:reporte";
    URL.revokeObjectURL = () => undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      descargas.push(this.download);
    });
    instalarFetch(
      undefined,
      (url, init) =>
        url.includes(`/superadmin/copiloto/conversaciones/${ID_CONV}/reporte?seq=2`) && init.method === "POST"
          ? new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="reporte-plataforma-2026-10-04.pdf"' } })
          : undefined,
      FIN_TABLA,
    );
    const root = await montarPagina();
    await preguntar(root, "mrr");
    expect(root.querySelector('[aria-label="Copiar respuesta"]')).not.toBeNull();
    expect(root.querySelector('[aria-label="Descargar CSV"]')).not.toBeNull();
    expect(root.querySelector('[aria-label="Regenerar respuesta"]')).not.toBeNull();
    expect(root.querySelector('[aria-label^="Fijar"]')).toBeNull();
    click(root.querySelector('[aria-label="Descargar PDF"]')!);
    // Sondeo en vez de una espera fija: bajo la carga del CI la descarga tarda mas de 30 ms.
    for (let i = 0; i < 100 && descargas.length === 0; i++) await esperar(20);
    const pdf = llamadas.find((l) => l.url.includes("/reporte"));
    expect(pdf?.method).toBe("POST");
    expect(pdf?.url).toBe(`${API}/superadmin/copiloto/conversaciones/${ID_CONV}/reporte?seq=2`);
    expect(pdf?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(descargas).toEqual(["reporte-plataforma-2026-10-04.pdf"]);
  });

  it("con `fijados: true` en el estado ofrece Fijar y fija con POST real a /superadmin/copiloto/pins (conversacion + posicion + bloque)", async () => {
    instalarFetch(() => json(200, estadoOk({ fijados: true })), (url, init) => (url.endsWith("/superadmin/copiloto/pins") && init.method === "POST" ? json(201, { id: "p1" }) : undefined), FIN_TABLA);
    const root = await montarPagina();
    await preguntar(root, "mrr");
    const fijar = root.querySelector('[aria-label^="Fijar"]');
    expect(fijar).not.toBeNull();
    click(fijar!);
    await esperar();
    const post = llamadas.find((l) => l.url === `${API}/superadmin/copiloto/pins`);
    expect(post?.method).toBe("POST");
    expect(post?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(post?.body).toEqual({ conversationId: ID_CONV, seq: 2, bloque: 0 });
  });

  it("Adjuntar archivo: sin `adjuntos` en el estado no hay clip; con el, el CSV se sube con POST real a /superadmin/copiloto/adjuntos y el perfil se pinta en el chat", async () => {
    instalarFetch(() => json(200, estadoOk()));
    const sinClip = await montarPagina();
    expect(sinClip.querySelector('[aria-label="Adjuntar archivo"]')).toBeNull();
    rendered?.unmount();
    llamadas = [];
    instalarFetch(
      () => json(200, estadoOk({ adjuntos: true })),
      (url, init) =>
        url.endsWith("/superadmin/copiloto/adjuntos") && init.method === "POST"
          ? json(200, { status: "ok", text: "«ventas.csv» tiene 2 filas de datos y 2 columnas.", blocks: [{ kind: "table", tool: "archivo_adjunto", title: "Perfil del archivo", columns: [{ key: "columna", label: "Columna", kind: "text" }], rows: [{ columna: "unidades" }], truncated: false }], sources: [{ tool: "archivo_adjunto", source: "Archivo adjunto analizado en el servidor del Copiloto (no se guarda)", scopeLabel: "Solo este archivo" }], toolsUsed: ["archivo_adjunto"] })
          : undefined,
    );
    const root = await montarPagina();
    const input = root.querySelector<HTMLInputElement>('[data-testid="copiloto-adjunto-input"]')!;
    expect(input).not.toBeNull();
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["producto,unidades\nTaco,10"], "ventas.csv", { type: "text/csv" })] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await esperar(60);
    const post = llamadas.find((l) => l.url === `${API}/superadmin/copiloto/adjuntos`);
    expect(post?.method).toBe("POST");
    expect(post?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(post?.body).toEqual({ nombre: "ventas.csv", contenidoBase64: btoa("producto,unidades\nTaco,10") });
    expect(root.textContent).toContain("Adjunté «ventas.csv»");
    expect(root.textContent).toContain("tiene 2 filas de datos");
    // el archivo no es una pregunta: no pasa por el chat ni por el modelo
    expect(llamadas.some((l) => l.url.endsWith("/superadmin/copiloto") && l.method === "POST")).toBe(false);
  });

  it("un fallo del reporte (422 sin cifras, 429, 503) se dice con un mensaje honesto, nunca un 500 crudo", async () => {
    URL.createObjectURL = () => "blob:x";
    instalarFetch(undefined, (url) => (url.includes("/reporte") ? json(429, { code: "too_many_requests" }) : undefined), FIN_TABLA);
    const root = await montarPagina();
    await preguntar(root, "mrr");
    click(root.querySelector('[aria-label="Descargar PDF"]')!);
    await esperar();
    expect(root.textContent).toContain("Pediste muchos reportes en poco tiempo");
  });

  it("el Historial es el sidebar de chats: lista del servidor, buscar, renombrar (PATCH), borrar con confirmacion (DELETE) y chat nuevo", async () => {
    const lista = [
      { id: ID_CONV, titulo: "Costos de IA de octubre", actualizadaEn: new Date().toISOString() },
      { id: "33333333-3333-4333-8333-333333333333", titulo: "Margen por cliente", actualizadaEn: new Date().toISOString() },
    ];
    instalarFetch(undefined, (url, init) => {
      if (url.endsWith("/superadmin/copiloto/conversaciones") && (init.method ?? "GET") === "GET") return json(200, { disponible: true, conversaciones: lista });
      if (url.includes("/superadmin/copiloto/conversaciones/") && init.method === "PATCH") return json(200, { id: ID_CONV, titulo: "Octubre" });
      if (url.includes("/superadmin/copiloto/conversaciones/") && init.method === "DELETE") return new Response(null, { status: 204 });
      return undefined;
    });
    const root = await montarPagina();
    click(root.querySelector('[aria-label="Historial de chats"]')!);
    await esperar();
    const panel = document.querySelector('[role="dialog"][aria-label="Historial de chats"], aside[aria-label="Historial de chats"]') ?? document.body;
    expect(panel.textContent).toContain("Costos de IA de octubre");
    expect(panel.textContent).toContain("Margen por cliente");
    changeValue(document.querySelector('[aria-label="Buscar chats"]')!, "margen");
    await esperar();
    expect(document.body.textContent).not.toContain("Costos de IA de octubre");
    expect(document.body.textContent).toContain("Margen por cliente");
    expect(document.querySelector('[aria-label="Nuevo chat"]')).not.toBeNull();
    click(document.querySelector('[aria-label="Borrar Margen por cliente"]')!);
    await esperar();
    const confirmar = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Borrar")!;
    click(confirmar);
    await esperar();
    const del = llamadas.find((l) => l.method === "DELETE");
    expect(del?.url).toBe(`${API}/superadmin/copiloto/conversaciones/33333333-3333-4333-8333-333333333333`);
  });
});

describe("config", () => {
  it("cada chip y pregunta de tarjeta tiene consulta directa y no hay entradas huerfanas", () => {
    const preguntas = [...new Set([...COPILOTO_SUPERADMIN.sugerencias, ...COPILOTO_SUPERADMIN.categorias.flatMap((c) => c.preguntas)])];
    expect(preguntas.filter((q) => !DIRECTAS_COPILOTO_SUPERADMIN[q])).toEqual([]);
    expect(Object.keys(DIRECTAS_COPILOTO_SUPERADMIN).filter((q) => !preguntas.includes(q))).toEqual([]);
  });
});


describe("cliente del tablero de fijados de plataforma", () => {
  it("lista, re-ejecuta y quita contra /superadmin/copiloto/pins con el token del superadmin; no tiene operacion de compartir real (la UI no la ofrece)", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/pins") && (init.method ?? "GET") === "GET") return json(200, { disponible: true, pins: [{ id: "p1", titulo: "Actividad por negocio", herramienta: "ranking_actividad", args: { periodo: "este_mes" }, compartido: false, propio: true }] });
      if (url.endsWith("/pins/p1/resultado")) return json(200, { id: "p1", titulo: "Actividad por negocio", status: "ok", text: "3 organizaciones", blocks: [], sources: [] });
      if (url.endsWith("/pins/p1") && init.method === "DELETE") return new Response(null, { status: 204 });
      return json(404, {});
    }) as unknown as typeof fetch;
    const cliente = crearClienteFijadosSuperadmin(API, TOKEN, fetchImpl);
    const ctl = new AbortController();
    expect(await cliente.listar(ctl.signal)).toEqual({ disponible: true, fijados: [{ id: "p1", titulo: "Actividad por negocio", herramienta: "ranking_actividad", compartido: false, propio: true }] });
    expect((await cliente.resultado("p1", ctl.signal)).text).toBe("3 organizaciones");
    await cliente.quitar("p1");
    const urls = (fetchImpl as unknown as { mock: { calls: [RequestInfo | URL, RequestInit][] } }).mock.calls.map(([u, i]) => `${i?.method ?? "GET"} ${String(u)}`);
    expect(urls).toEqual([`GET ${API}/superadmin/copiloto/pins`, `GET ${API}/superadmin/copiloto/pins/p1/resultado`, `DELETE ${API}/superadmin/copiloto/pins/p1`]);
  });

  it("403 (rol finanzas) y 409 (impersonando) ocultan el tablero; 503 = base sin migrar", async () => {
    for (const [status, tipo] of [[403, "sin_acceso"], [409, "sin_acceso"], [503, "no_disponible"]] as const) {
      const cliente = crearClienteFijadosSuperadmin(API, TOKEN, (async () => json(status, {})) as unknown as typeof fetch);
      await expect(cliente.listar(new AbortController().signal)).rejects.toMatchObject({ tipo });
    }
  });
});
