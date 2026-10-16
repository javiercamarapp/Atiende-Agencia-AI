// @vitest-environment jsdom
//
// <AgenteVozPage />: pestañas, selector de voz SIN clonación, guardado, estados
// honestos cuando el backend aún no existe (404/503), herramientas con contador real,
// conversaciones y llamada de prueba real (honesta cuando falta la credencial). `fetch` global mockeado por ruta
// real contra los endpoints que construye la otra tarea (lib/voz-client.ts).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgenteVozPage } from "../src/verticals/restaurantes/pages/AgenteVoz.tsx";
import type { EntornoVoz } from "../src/lib/voz/adaptador-gemini-live.ts";
import type { MuestraAudio } from "../src/verticals/restaurantes/voz/SelectorVoz.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { contarEjecuciones } from "../src/verticals/restaurantes/voz/herramientas-agente.ts";
import { changeValue, click, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Gaby", staffEmail: "g@example.com", nombreSucursal: "Sucursal Centro" };

// Formato REAL de la API (apps/api .../voz-admin.ts): el cliente lo mapea al modelo del panel.
const CONFIG = { disponible: true, configurada: true, habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "Habla en español de México.", mensajeInicial: "Hola, le atiende el asistente virtual de Los Taquitos." };

const LISTA = [
  { id: "c1", iniciadaEn: "2026-09-30T18:00:00Z", duracionS: 125, costoEstimadoMicroUsd: 42500, resultado: "pedido_creado" },
  { id: "c2", iniciadaEn: "2026-09-30T19:00:00Z", duracionS: 30, costoEstimadoMicroUsd: 0, resultado: null },
];
const CONVERSACIONES = { disponible: true, total: 2, nextOffset: null, items: LISTA };
const DETALLE_C1 = {
  ...LISTA[0],
  turnos: [
    { seq: 0, rol: "agente", texto: "Hola, asistente virtual de Los Taquitos", creadoEn: "2026-09-30T18:00:01Z" },
    { seq: 1, rol: "cliente", texto: "Quiero dos de pastor", creadoEn: "2026-09-30T18:00:05Z" },
  ],
};

const SESION_PREVIEW = { sesionId: "s-1", proveedor: "gemini-3.8-live", modelo: "gemini-3.8-live", voiceId: "Kore", websocketUrl: "wss://gemini.test/ws", tokenProveedor: "tok", tokenPreview: "x", expiraEn: "2026-10-01T12:00:00Z" };

type Respuesta = { status: number; body?: unknown };
interface Rutas {
  catalogo?: Respuesta;
  preview?: Respuesta;
  config?: Respuesta;
  conversaciones?: Respuesta;
  detalle?: Respuesta;
  put?: (body: Record<string, unknown>) => Respuesta;
  conocimiento?: Respuesta;
  conocimientoPost?: (body: Record<string, unknown>) => Respuesta;
}

function res(r: Respuesta): Response {
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} } as unknown as Response;
}

function stub(rutas: Rutas) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "https://api.test/v1/restaurantes/prop-1/admin/voz/catalogo") return res(rutas.catalogo ?? { status: 200, body: { proveedor: "gemini-3.8-live", salud: { ok: true, detalle: "Credencial presente." }, voces: [] } });
    if (url === "https://api.test/v1/restaurantes/prop-1/admin/voz/preview/sesion") return res(rutas.preview ?? { status: 201, body: SESION_PREVIEW });
    if (url === "https://api.test/v1/restaurantes/prop-1/admin/voz/config") {
      if (method === "PUT") return res(rutas.put ? rutas.put(JSON.parse(init!.body as string)) : { status: 500 });
      return res(rutas.config ?? { status: 200, body: CONFIG });
    }
    if (url.startsWith("https://api.test/v1/restaurantes/prop-1/admin/voz/conversaciones/")) return res(rutas.detalle ?? { status: 200, body: DETALLE_C1 });
    if (url.startsWith("https://api.test/v1/restaurantes/prop-1/admin/voz/conversaciones")) return res(rutas.conversaciones ?? { status: 200, body: CONVERSACIONES });
    if (url === "https://api.test/v1/restaurantes/prop-1/admin/sucursales") return res({ status: 200, body: { branches: [{ propertyId: "prop-1", name: "Prolongación Montejo", slug: "montejo", status: "active", phone: null, address: null, lat: null, lng: null }] } });
    if (url === "https://api.test/v1/restaurantes/prop-1/admin/conocimiento") {
      if (method === "POST") return res(rutas.conocimientoPost ? rutas.conocimientoPost(JSON.parse(init!.body as string)) : { status: 500 });
      return res(rutas.conocimiento ?? { status: 200, body: { disponible: true, topeCaracteres: 6000, entradas: [] } });
    }
    throw new Error(`fetch inesperado: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function settle() {
  for (let i = 0; i < 12; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function pintar(rutas: Rutas = {}, extra: { crearAudio?: (url: string) => MuestraAudio; entornoVoz?: EntornoVoz } = {}) {
  stub(rutas);
  rendered = renderComponent(<AgenteVozPage {...CTX} {...extra} />);
  await settle();
}

const texto = () => rendered!.container.textContent ?? "";
const pestana = (nombre: string) => Array.from(rendered!.container.querySelectorAll<HTMLElement>('[role="tab"]')).find((t) => t.textContent === nombre)!;
const boton = (etiqueta: string) => Array.from(rendered!.container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.includes(etiqueta) || b.getAttribute("aria-label")?.includes(etiqueta));

async function irA(nombre: string) {
  click(pestana(nombre));
  await settle();
}

describe("<AgenteVozPage /> pestañas", () => {
  it("QA-restaurantes-R1-botones-10: las flechas, Inicio y Fin recorren las pestañas (con vuelta), mueven el foco y solo la activa entra por Tab", async () => {
    await pintar();
    document.body.appendChild(rendered!.container); // el foco real exige el nodo en el documento (renderComponent ya lo agrega)
    const nombre = () => document.activeElement?.textContent;
    pestana("Resumen").focus();
    expect(pestana("Resumen").tabIndex).toBe(0);
    expect(pestana("Voz").tabIndex).toBe(-1);
    keydown(pestana("Resumen"), "ArrowRight");
    expect(nombre()).toBe("Voz");
    expect(pestana("Voz").getAttribute("aria-selected")).toBe("true");
    expect(pestana("Voz").tabIndex).toBe(0);
    expect(pestana("Resumen").tabIndex).toBe(-1);
    keydown(pestana("Voz"), "ArrowLeft");
    expect(nombre()).toBe("Resumen");
    keydown(pestana("Resumen"), "ArrowLeft"); // vuelta al final
    expect(nombre()).toBe("Indicadores");
    keydown(pestana("Indicadores"), "ArrowRight"); // vuelta al inicio
    expect(nombre()).toBe("Resumen");
    keydown(pestana("Resumen"), "End");
    expect(nombre()).toBe("Indicadores");
    keydown(pestana("Indicadores"), "Home");
    expect(nombre()).toBe("Resumen");
    keydown(pestana("Resumen"), "a"); // otra tecla no mueve nada
    expect(nombre()).toBe("Resumen");
  });

  it("tiene las 8 pestañas en orden y abre en Resumen", async () => {
    await pintar();
    const nombres = Array.from(rendered!.container.querySelectorAll('[role="tab"]')).map((t) => t.textContent);
    expect(nombres).toEqual(["Resumen", "Voz", "Conocimiento", "Comportamiento", "Mensaje inicial", "Herramientas", "Conversaciones", "Indicadores"]);
    expect(pestana("Resumen").getAttribute("aria-selected")).toBe("true");
    await irA("Voz");
    expect(pestana("Voz").getAttribute("aria-selected")).toBe("true");
    expect(pestana("Resumen").getAttribute("aria-selected")).toBe("false");
  });

  it("Resumen: voz elegida, servicio disponible, totales reales de llamadas y lista de pendientes", async () => {
    await pintar();
    const t = texto();
    expect(t).toContain("Disponible");
    expect(t).toContain("Kore · Firme");
    const llamadas = rendered!.container.querySelector('[data-testid="resumen-llamadas"]')!.textContent!;
    expect(llamadas).toContain("2"); // conversaciones
    expect(llamadas).toContain("2:35"); // 125 s + 30 s
    expect(llamadas).toContain("US$0.043"); // solo las que tienen costo
    const pasos = Array.from(rendered!.container.querySelectorAll("[data-ok]")).map((li) => li.getAttribute("data-ok"));
    expect(pasos).toEqual(["true", "true", "true"]);
  });
});

describe("pestaña Voz (sin clonación)", () => {
  it("lista las 30 voces de Gemini, con búsqueda, y no ofrece nada de ElevenLabs ni de clonación", async () => {
    await pintar();
    await irA("Voz");
    expect(rendered!.container.querySelectorAll("[data-voz]")).toHaveLength(30);
    expect(texto()).toContain("30/30 voces");
    expect(boton("Clonar")).toBeUndefined();
    expect(texto()).not.toMatch(/Mis voces|Clonar mi voz|Estabilidad|Similitud|Velocidad|ElevenLabs/i);
    expect(rendered!.container.querySelectorAll('input[type="range"]')).toHaveLength(0);

    const buscar = rendered!.container.querySelector<HTMLInputElement>('input[aria-label="Buscar voz"]')!;
    changeValue(buscar, "sulafat");
    expect(Array.from(rendered!.container.querySelectorAll("[data-voz]")).map((x) => x.getAttribute("data-voz"))).toEqual(["Sulafat"]);
    expect(texto()).toContain("1/30 voces");
    changeValue(buscar, "zzzz");
    expect(rendered!.container.querySelectorAll("[data-voz]")).toHaveLength(0);
    expect(texto()).toContain("Sin resultados");
  });

  it("marca la voz guardada, deja elegir otra y guarda con PUT del cuerpo exacto", async () => {
    await pintar({ put: (body) => ({ status: 200, body: { ...CONFIG, ...body } }) });
    await irA("Voz");
    expect(rendered!.container.querySelector('[data-voz="Kore"]')!.getAttribute("aria-selected")).toBe("true");
    const guardar = boton("Guardar cambios") as HTMLButtonElement;
    expect(guardar.disabled).toBe(true); // nada cambió

    click(boton("Elegir la voz Puck")!);
    expect(rendered!.container.querySelector('[data-voz="Puck"]')!.getAttribute("aria-selected")).toBe("true");
    expect(rendered!.container.querySelector('[data-voz="Kore"]')!.getAttribute("aria-selected")).toBe("false");
    expect(texto()).toContain("Hay cambios sin guardar.");
    expect((boton("Guardar cambios") as HTMLButtonElement).disabled).toBe(false);

    click(boton("Guardar cambios")!);
    await settle();
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")!;
    expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({ habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Puck", comportamiento: CONFIG.comportamiento, mensajeInicial: CONFIG.mensajeInicial, mensajeInicialInterrumpible: true });
    expect(texto()).toContain("Cambios guardados.");
    expect((boton("Guardar cambios") as HTMLButtonElement).disabled).toBe(true);
  });

  it("si guardar falla muestra el error real y conserva los cambios", async () => {
    await pintar({ put: () => ({ status: 403, body: { message: "No tienes permiso para realizar esta acción." } }) });
    await irA("Voz");
    click(boton("Elegir la voz Puck")!);
    click(boton("Guardar cambios")!);
    await settle();
    expect(rendered!.container.querySelector('[role="alert"]')!.textContent).toContain("No tienes permiso");
    expect(rendered!.container.querySelector('[data-voz="Puck"]')!.getAttribute("aria-selected")).toBe("true");
  });

  it("el botón de muestra reproduce el archivo de la voz, anima el avatar y se detiene al volver a pulsarlo", async () => {
    const audios: { url: string; pausado: boolean; audio: MuestraAudio }[] = [];
    const crearAudio = (url: string): MuestraAudio => {
      const a = { url, pausado: false, audio: null as unknown as MuestraAudio };
      a.audio = { play: async () => undefined, pause: () => void (a.pausado = true), onended: null, onerror: null };
      audios.push(a);
      return a.audio;
    };
    await pintar({}, { crearAudio });
    await irA("Voz");
    const girando = () => rendered!.container.querySelector('[data-voz="Zephyr"] [data-girando]')!.getAttribute("data-girando");
    expect(girando()).toBe("false");
    click(boton("Escuchar una muestra de Zephyr")!);
    await settle();
    expect(audios[0]!.url).toBe("/media/voces/zephyr.mp3");
    expect(girando()).toBe("true");
    click(boton("Detener la muestra de Zephyr")!);
    expect(audios[0]!.pausado).toBe(true);
    expect(girando()).toBe("false");
  });

  it("si la muestra no existe todavía lo dice, sin inventar audio", async () => {
    const crearAudio = (): MuestraAudio => ({ play: async () => { throw new Error("404"); }, pause: () => undefined, onended: null, onerror: null });
    await pintar({}, { crearAudio });
    await irA("Voz");
    click(boton("Escuchar una muestra de Kore")!);
    await settle();
    expect(texto()).toContain("La muestra de Kore todavía no está disponible.");
    expect(rendered!.container.querySelector('[data-voz="Kore"] [data-girando]')!.getAttribute("data-girando")).toBe("false");
  });
});

describe("Comportamiento, Conocimiento y Mensaje inicial", () => {
  it("edita el comportamiento y el habilitado y los manda en el PUT con los nombres reales de la API", async () => {
    await pintar({ put: (body) => ({ status: 200, body: { ...CONFIG, ...body } }) });
    await irA("Comportamiento");
    changeValue(rendered!.container.querySelector<HTMLTextAreaElement>("#voz-prompt")!, "Sé breve.");
    await irA("Voz");
    click(rendered!.container.querySelector<HTMLInputElement>("#voz-habilitado")!);
    click(boton("Guardar cambios")!);
    await settle();
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")!;
    expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({ habilitado: false, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "Sé breve.", mensajeInicial: CONFIG.mensajeInicial, mensajeInicialInterrumpible: true });
  });

  const ENTRADA = { id: "k1", sucursalId: null, reemplazaId: null, titulo: "Estacionamiento", texto: "Hay estacionamiento gratuito para clientes.", tipo: "faq", prioridad: 50, vigenteDesde: null, vigenteHasta: null, activo: true, estado: "publicado", origen: "manual", version: 1, actualizadoEn: "2026-10-04T12:00:00Z" };

  it("Conocimiento (owner): lista las entradas reales de la API, con su uso del tope y sin el aviso viejo de 'no se guardan'", async () => {
    await pintar({ conocimiento: { status: 200, body: { disponible: true, topeCaracteres: 6000, entradas: [ENTRADA, { ...ENTRADA, id: "k2", titulo: "Borrador de importar", estado: "borrador", origen: "importado" }] } } });
    await irA("Conocimiento");
    expect(rendered!.container.querySelector('[data-testid="aviso-conocimiento"]')).toBeNull();
    expect(rendered!.container.querySelector('[data-entrada="k1"]')!.textContent).toContain("Hay estacionamiento gratuito");
    expect(rendered!.container.querySelector('[data-entrada="k2"]')!.textContent).toContain("Borrador por aprobar");
    expect(rendered!.container.querySelector('[data-testid="conocimiento-uso"]')!.textContent).toContain("de 6,000");
    expect(texto()).toContain("Datos que consulta en vivo");
  });

  it("Conocimiento: crea una entrada con el cuerpo exacto de la API y recarga la lista; el rechazo del servidor (precio) se muestra tal cual", async () => {
    await pintar({ conocimientoPost: () => ({ status: 400, body: { error: "validation_error", message: "No incluya precios: el agente los toma siempre del menú real." } }) });
    await irA("Conocimiento");
    click(boton("Agregar entrada")!);
    await settle();
    const form = rendered!.container.querySelector('section[aria-label="Nueva entrada"]')!;
    changeValue(form.querySelector<HTMLInputElement>('input[placeholder="Estacionamiento"]')!, "Pastor");
    changeValue(form.querySelector<HTMLTextAreaElement>("textarea")!, "El pastor cuesta $10.");
    click(boton("Guardar entrada")!);
    await settle();
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ titulo: "Pastor", texto: "El pastor cuesta $10.", tipo: "faq", prioridad: 50, vigenteDesde: null, vigenteHasta: null, reemplazaId: null, sucursalId: null });
    expect(rendered!.container.querySelector('[role="alert"]')!.textContent).toContain("No incluya precios");
  });

  it("Conocimiento: base sin migrar (disponible: false) dice 'No disponible aún' y no ofrece guardar", async () => {
    await pintar({ conocimiento: { status: 200, body: { disponible: false, topeCaracteres: 6000, entradas: [] } } });
    await irA("Conocimiento");
    expect(rendered!.container.querySelector('[data-testid="conocimiento-no-disponible"]')!.textContent).toContain("migración 053");
    expect(boton("Agregar entrada")).toBeUndefined();
  });

  it("Conocimiento: quien no es owner/admin no ve el editor (el servidor lo rechazaría) y el aviso lo explica", async () => {
    stub({});
    rendered = renderComponent(<AgenteVozPage {...CTX} role="staff" />);
    await settle();
    await irA("Conocimiento");
    expect(rendered!.container.querySelector('[data-testid="conocimiento-negocio"]')).toBeNull();
    expect(rendered!.container.querySelector('[data-testid="aviso-conocimiento"]')!.textContent).toContain("dueño o un administrador");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/admin/conocimiento"))).toBe(false);
  });

  it("sin configuración guardada no se puede guardar hasta elegir una voz", async () => {
    await pintar({ config: { status: 200, body: { ...CONFIG, configurada: false, habilitado: false, voiceId: "", comportamiento: "", mensajeInicial: "" } } });
    await irA("Comportamiento");
    changeValue(rendered!.container.querySelector<HTMLTextAreaElement>("#voz-prompt")!, "Sé breve.");
    expect((boton("Guardar cambios") as HTMLButtonElement).disabled).toBe(true);
    expect(rendered!.container.querySelector('[data-testid="aviso-elegir-voz"]')).not.toBeNull();
  });

  it("base sin migrar (disponible: false) se trata como servicio no disponible, sin falso éxito", async () => {
    await pintar({ config: { status: 200, body: { ...CONFIG, disponible: false, configurada: false } }, conversaciones: { status: 200, body: { ...CONVERSACIONES, disponible: false, items: [] } } });
    expect(rendered!.container.querySelector('[data-testid="aviso-servicio"]')).not.toBeNull();
    expect(texto()).toContain("Sin historial todavía");
  });

  it("Mensaje inicial: la casilla del saludo no interrumpible se lee de la API, se explica y se manda en el PUT", async () => {
    await pintar({ config: { status: 200, body: { ...CONFIG, mensajeInicialInterrumpible: true } }, put: (body) => ({ status: 200, body: { ...CONFIG, ...body } }) });
    await irA("Mensaje inicial");
    const casilla = () => rendered!.container.querySelector<HTMLInputElement>("#voz-saludo-interrumpible")!;
    expect(casilla().checked).toBe(true);
    expect(texto()).toContain("el agente se calla");
    click(casilla());
    expect(casilla().checked).toBe(false);
    expect(texto()).toContain("se escucha completo aunque quien llama hable encima");
    click(boton("Guardar cambios")!);
    await settle();
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")!;
    expect(JSON.parse((put[1] as RequestInit).body as string)).toMatchObject({ mensajeInicialInterrumpible: false });
    expect(casilla().checked).toBe(false);
  });

  it("Mensaje inicial muestra siempre el aviso de asistente virtual y alerta si el texto no lo dice", async () => {
    await pintar();
    await irA("Mensaje inicial");
    expect(rendered!.container.querySelector('[data-testid="aviso-asistente-virtual"]')!.textContent).toMatch(/asistente virtual/i);
    expect(rendered!.container.querySelector('[data-testid="alerta-sin-asistente-virtual"]')).toBeNull(); // el guardado ya lo dice

    const campo = rendered!.container.querySelector<HTMLTextAreaElement>("#voz-mensaje-inicial")!;
    changeValue(campo, "Buenas tardes, le atiende Arturo.");
    expect(rendered!.container.querySelector('[data-testid="alerta-sin-asistente-virtual"]')!.textContent).toContain("no dice que es un asistente virtual");
    changeValue(campo, "Buenas tardes, le atiende Arturo, el Asistente   Virtual de Los Taquitos.");
    expect(rendered!.container.querySelector('[data-testid="alerta-sin-asistente-virtual"]')).toBeNull();
    changeValue(campo, "");
    expect(rendered!.container.querySelector('[data-testid="alerta-sin-asistente-virtual"]')).toBeNull();
  });

  it("el Resumen marca pendiente el primer mensaje que no se presenta como asistente virtual", async () => {
    await pintar({ config: { status: 200, body: { ...CONFIG, mensajeInicial: "Hola, le atiende Arturo." } } });
    const pasos = Array.from(rendered!.container.querySelectorAll("[data-ok]")).map((li) => li.getAttribute("data-ok"));
    expect(pasos).toEqual(["true", "true", "false"]);
  });
});

describe("Herramientas (contador real o estado honesto)", () => {
  it("contarEjecuciones cuenta solo lo que el servicio reporta (hoy la API no lo reporta)", () => {
    const base = { iniciadaEn: "2026-09-30T18:00:00Z", duracionSegundos: 1, costoUsd: null, resultado: null } as const;
    const r = contarEjecuciones([
      { id: "a", ...base, herramientas: ["buscar_producto", "crear_pedido"] },
      { id: "b", ...base, herramientas: ["buscar_producto"] },
    ]);
    expect(r).toEqual({ disponible: true, llamadas: 2, cuentas: { buscar_producto: 2, crear_pedido: 1 } });
    expect(contarEjecuciones([{ id: "c", ...base }])).toMatchObject({ disponible: false });
    expect(contarEjecuciones([])).toMatchObject({ disponible: false });
  });

  it("sin historial disponible no muestra ningún '0 ejecuciones': dice que no hay datos y por qué", async () => {
    await pintar({ conversaciones: { status: 404 } });
    await irA("Herramientas");
    expect(texto()).not.toMatch(/0 ejecuciones/);
    for (const h of rendered!.container.querySelectorAll('[data-testid^="ejecuciones-"]')) expect(h.textContent).toBe("Sin datos de ejecuciones");
    expect(rendered!.container.querySelector('[data-testid="motivo-sin-ejecuciones"]')!.textContent).toContain("todavía no está disponible");
  });

  it("con el formato real de la API (sin herramientas por llamada) lo dice en vez de contar cero", async () => {
    await pintar();
    await irA("Herramientas");
    expect(rendered!.container.querySelector('[data-testid="motivo-sin-ejecuciones"]')!.textContent).toContain("no reporta");
    expect(texto()).not.toMatch(/0 ejecuciones/);
  });
});

describe("Conversaciones", () => {
  it("lista fecha, duración, costo y resultado reales, y abre la transcripción", async () => {
    await pintar();
    await irA("Conversaciones");
    const fila1 = rendered!.container.querySelector('[data-conversacion="c1"]')!.textContent!;
    expect(fila1).toContain("2:05");
    expect(fila1).toContain("US$0.043");
    expect(fila1).toContain("Pedido creado");
    const fila2 = rendered!.container.querySelector('[data-conversacion="c2"]')!.textContent!;
    expect(fila2).toContain("0:30");
    expect(fila2).toContain("Sin clasificar");

    click(boton("Ver transcripción")!);
    await settle();
    expect(fetchMock.mock.calls.some(([u]) => u === "https://api.test/v1/restaurantes/prop-1/admin/voz/conversaciones/c1")).toBe(true);
    expect(texto()).toContain("Quiero dos de pastor");
    expect(texto()).toContain("Hola, asistente virtual de Los Taquitos".slice(0, 6));
    click(boton("Volver a la lista")!);
    expect(rendered!.container.querySelector('[data-conversacion="c1"]')).not.toBeNull();
  });

  it("una conversación sin transcripción lo dice", async () => {
    await pintar({ detalle: { status: 200, body: { ...LISTA[1], turnos: [] } } });
    await irA("Conversaciones");
    const botones = Array.from(rendered!.container.querySelectorAll<HTMLButtonElement>("button")).filter((b) => b.textContent === "Ver transcripción");
    click(botones[1]!);
    await settle();
    expect(texto()).toContain("Esta conversación no incluye transcripción.");
  });

  it("lista vacía: estado vacío honesto", async () => {
    await pintar({ conversaciones: { status: 200, body: { ...CONVERSACIONES, total: 0, items: [] } } });
    await irA("Conversaciones");
    expect(texto()).toContain("Todavía no hay conversaciones de voz registradas");
  });

  it("404/503: explica que el historial aún no está disponible y no inventa llamadas", async () => {
    for (const status of [404, 503]) {
      await pintar({ conversaciones: { status } });
      await irA("Conversaciones");
      expect(texto()).toContain("Historial no disponible todavía");
      expect(rendered!.container.querySelectorAll("[data-conversacion]")).toHaveLength(0);
      rendered!.unmount();
      rendered = undefined;
    }
  });

  it("un error real del servidor se muestra como error con opción de reintentar", async () => {
    await pintar({ conversaciones: { status: 500, body: { message: "Falla interna" } } });
    await irA("Conversaciones");
    expect(texto()).toContain("Falla interna");
    expect(boton("Reintentar")).toBeDefined();
  });
});

describe("servicio de voz no disponible (config 404/503)", () => {
  it("avisa, muestra el estado honesto en Resumen y no deja guardar", async () => {
    await pintar({ config: { status: 503 }, conversaciones: { status: 503 } });
    expect(rendered!.container.querySelector('[data-testid="aviso-servicio"]')!.textContent).toContain("todavía no está disponible");
    expect(texto()).toContain("Todavía no disponible para este negocio.");
    expect(texto()).toContain("Sin historial todavía");
    await irA("Mensaje inicial");
    changeValue(rendered!.container.querySelector<HTMLTextAreaElement>("#voz-mensaje-inicial")!, "Hola, asistente virtual");
    expect((boton("Guardar cambios") as HTMLButtonElement).disabled).toBe(true);
    click(boton("Guardar cambios")!);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(false);
  });

  it("sin configuración guardada todavía (config null) el servicio está disponible y todo arranca vacío", async () => {
    await pintar({ config: { status: 200, body: { config: null } } });
    expect(texto()).toContain("Esta sucursal aún no tiene configuración guardada.");
    expect(texto()).toContain("Sin elegir");
    await irA("Voz");
    expect(rendered!.container.querySelector('[aria-selected="true"][data-voz]')).toBeNull();
  });

  it("un error real al cargar la config se muestra como error, no como 'no disponible'", async () => {
    await pintar({ config: { status: 500, body: { message: "Base de datos caída" } } });
    expect(texto()).toContain("Base de datos caída");
    expect(rendered!.container.querySelector('[data-testid="aviso-servicio"]')).toBeNull();
  });
});

function entornoFalso() {
  const socket = { url: "", enviados: [] as unknown[], cerrado: false, onopen: null as (() => void) | null, onmessage: null as ((ev: { data: unknown }) => void) | null, onclose: null, onerror: null, send(d: string) { this.enviados.push(JSON.parse(d)); }, close() { this.cerrado = true; } };
  const entorno: EntornoVoz = {
    abrirSocket: (url) => {
      socket.url = url;
      queueMicrotask(() => {
        socket.onopen?.();
        socket.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
      });
      return socket as never;
    },
    capturarMicrofono: async () => ({ detener: () => undefined }),
    crearReproductor: () => ({ encolar: () => undefined, cortar: () => undefined, nivel: () => 0, cerrar: () => undefined }),
    esperar: () => () => undefined,
    repetir: () => () => undefined,
    ahora: () => 1000,
  };
  return { entorno, socket };
}

describe("llamada de prueba (vista previa real)", () => {
  it("sin credencial en el servidor dice 'No disponible' con el motivo, bloquea el botón y no simula nada", async () => {
    await pintar({ catalogo: { status: 200, body: { proveedor: "gemini-3.8-live", salud: { ok: false, detalle: "Voz no configurada: falta GEMINI_API_KEY." }, voces: [] } } });
    click(boton("Vista previa")!);
    await settle();
    expect(texto()).toContain("No disponible: Voz no configurada: falta GEMINI_API_KEY.");
    expect(texto()).not.toMatch(/simulaci[oó]n|demostraci[oó]n/i);
    const iniciar = boton("Iniciar llamada de prueba") as HTMLButtonElement | undefined;
    if (iniciar) click(iniciar);
    await settle();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/preview/sesion"))).toBe(false);
    expect(rendered!.container.querySelector('[data-testid="aviso-simulacion"]')).toBeNull();
  });

  it("con credencial pide la sesión efímera con la voz guardada, conecta y queda escuchando; al salir cuelga", async () => {
    const { entorno, socket } = entornoFalso();
    await pintar({}, { entornoVoz: entorno });
    click(boton("Vista previa")!);
    await settle();
    expect(texto()).not.toContain("No disponible");
    expect(rendered!.container.querySelector('[data-testid="aviso-prueba"]')!.textContent).toContain("Llamada de prueba: consulta el menú real y simula el pedido; no se registra ni se avisa a nadie");
    click(boton("Iniciar llamada de prueba")!);
    await settle();
    const llamada = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/preview/sesion"))!;
    expect(JSON.parse((llamada[1] as RequestInit).body as string)).toEqual({ voiceId: "Kore" });
    expect(socket.url).toBe(`${SESION_PREVIEW.websocketUrl}?access_token=${SESION_PREVIEW.tokenProveedor}`);
    // Como el original: «Vista previa» en reposo y «● Llamada en curso» mientras dura la llamada (el modo real sigue en data-modo y en el orbe).
    expect(rendered!.container.querySelector('[data-testid="chip-estado"]')!.textContent).toBe("● Llamada en curso");
    expect(rendered!.container.querySelector('[role="dialog"]')!.getAttribute("data-modo")).toBe("escuchando");
    expect(rendered!.container.querySelector(".voz-orbe")!.getAttribute("data-video")).toBe("visible");
    expect(Array.from(rendered!.container.querySelectorAll("button")).find((b) => b.textContent === "Terminar llamada")!.className).toContain("bg-destructive");
    click(boton("Atrás")!);
    await settle();
    expect(socket.cerrado).toBe(true);
    expect(rendered!.container.querySelector('[role="tablist"]')).not.toBeNull();
  });

  it("el globo flotante «Iniciar llamada» abre la vista previa y se oculta mientras está abierta", async () => {
    await pintar({}, { entornoVoz: entornoFalso().entorno });
    const globo = () => document.body.querySelector<HTMLButtonElement>('[data-testid="globo-llamada"]');
    expect(globo()?.textContent).toContain("Iniciar llamada");
    click(globo()!);
    await settle();
    expect(rendered!.container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(globo()).toBeNull();
    click(boton("Atrás")!);
    await settle();
    expect(globo()).not.toBeNull();
  });

  it("el globo de llamada no se muestra a quien no es owner/admin", async () => {
    stub({});
    rendered = renderComponent(<AgenteVozPage {...CTX} role="staff" />);
    await settle();
    expect(document.body.querySelector('[data-testid="globo-llamada"]')).toBeNull();
  });

  it("el encabezado de la vista previa lleva el nombre de la sucursal activa (como el original) y el chip arranca en «Vista previa»", async () => {
    await pintar({}, { entornoVoz: entornoFalso().entorno });
    click(boton("Vista previa")!);
    await settle();
    expect(rendered!.container.querySelector('[role="dialog"]')!.textContent).toContain("Sucursal Centro");
    expect(rendered!.container.querySelector('[data-testid="chip-estado"]')!.textContent).toBe("Vista previa");
    expect(texto()).toContain("Aún no hay una llamada activa");
  });

  it("si la API responde 503 al emitir la sesión (la credencial se perdió) muestra el error y no abre ningún socket", async () => {
    const { entorno, socket } = entornoFalso();
    await pintar({ preview: { status: 503, body: { message: "Voz no configurada: falta GEMINI_API_KEY." } } }, { entornoVoz: entorno });
    click(boton("Vista previa")!);
    await settle();
    click(boton("Iniciar llamada de prueba")!);
    await settle();
    expect(rendered!.container.querySelector('[data-testid="chip-estado"]')!.textContent).toBe("Error");
    expect(socket.url).toBe("");
  });

  it("con el servicio de voz apagado (config 503) la llamada de prueba dice que no está activo", async () => {
    await pintar({ config: { status: 503 }, conversaciones: { status: 503 } });
    click(boton("Vista previa")!);
    await settle();
    expect(texto()).toContain("No disponible: el servicio de voz todavía no está activo para este negocio.");
  });
});
