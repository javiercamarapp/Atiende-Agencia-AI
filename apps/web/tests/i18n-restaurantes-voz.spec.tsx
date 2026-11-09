// @vitest-environment jsdom
//
// i18n ES/EN — restaurantes, agente de voz (pagina, indicadores, resumen del canal, conversaciones, ajustes del agente y etiquetas de lib/). Con la
// consola en espanol el DOM es identico con y sin IdiomaProvider; con EN (diseno ds3) las pantallas salen en ingles, sin claves
// crudas, y lo que no es interfaz (saludo de ejemplo que la voz dice al cliente, nombres de las voces, periodo que redacta la API)
// queda tal cual.
import { act } from "react";
import type { ReactElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IdiomaProvider, cargarIdioma } from "@atiende/ui";
import { fijarIdiomaActivo } from "../../../packages/ui/src/i18n/activo.ts";
import { AgenteVozPage } from "../src/verticals/restaurantes/pages/AgenteVoz.tsx";
import { AjustesAgentePage } from "../src/verticals/restaurantes/pages/AjustesAgente.tsx";
import { ESTILOS, PRESETS_AMBIENTE, RITMOS, costoPorMil, etiquetaNivel, rotuloTemperatura } from "../src/verticals/restaurantes/voz/formato-ajustes.ts";
import { PestanaIndicadores } from "../src/verticals/restaurantes/voz/PestanaIndicadores.tsx";
import { PestanaConversaciones } from "../src/verticals/restaurantes/voz/PestanaConversaciones.tsx";
import { ResumenKpisVoz } from "../src/verticals/restaurantes/voz/ResumenKpisVoz.tsx";
import { etiquetaAlerta, formatoDia } from "../src/verticals/restaurantes/voz/formato-kpi.ts";
import { etiquetaResultado } from "../src/verticals/restaurantes/voz/formato-voz.ts";
import { buscarVoz, filtrarVoces, CATALOGO_VOCES } from "../src/verticals/restaurantes/lib/voz-catalogo.ts";
import { VOCES_TELEFONO } from "../src/verticals/restaurantes/lib/voz-telefono-catalogo.ts";
import { VozNoDisponibleError } from "../src/verticals/restaurantes/lib/voz-client.ts";
import type { ConversacionVoz } from "../src/verticals/restaurantes/lib/voz-client.ts";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

let rendered: RenderedComponent | undefined;

const API = "https://api.test/v1/restaurantes/prop-1/admin";
const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Gaby", staffEmail: "g@example.com", nombreSucursal: "Sucursal Centro" };
const CONFIG = { disponible: true, configurada: true, habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "Habla en español de México.", mensajeInicial: "Hola, le atiende el asistente virtual de Los Taquitos." };
const CONVERSACIONES = {
  disponible: true,
  total: 2,
  nextOffset: null,
  items: [
    { id: "c1", iniciadaEn: "2026-09-30T18:00:00Z", duracionS: 125, costoEstimadoMicroUsd: 42500, resultado: "pedido_creado" },
    { id: "c2", iniciadaEn: "2026-09-30T19:00:00Z", duracionS: 30, costoEstimadoMicroUsd: 0, resultado: null },
  ],
};
const CANALES = {
  totalOrders: 80,
  totalRevenue: 0,
  voice: { orders: 20, completed: 18, cancelled: 1, revenue: 0 },
  whatsapp: { orders: 0, completed: 0, cancelled: 0, revenue: 0 },
  whatsappConversations: { total: 0, withOrder: 0, averageMessages: 0 },
  aiAdoptionPct: null,
  aiRevenuePct: null,
  estimatedHoursSaved: 0,
  periodo: { acotado: true, etiqueta: "Últimos 30 días" },
};

function totales(parcial: Record<string, unknown> = {}) {
  return {
    dias: 1, llamadas: 0, llamadasCerradas: 0, duracionPromedioS: null, pedidosVoz: 0, escaladas: 0, abandonadas: 0,
    tasaResolucionPct: null, tasaHandoffPct: null, tasaAbandonoPct: null, erroresProveedor: 0, erroresTwilio: 0, erroresOtros: 0,
    tasaErrorPct: null, toolCalls: 0, toolP95PeorDiaMs: null, costoVozMicroUsd: 0, costoTelefoniaMicroUsd: 0, costoCentavosMxn: 0, costoCompleto: true,
    costoPorLlamadaCentavosMxn: null, costoLlmOrgCentavosMxn: null, ...parcial,
  };
}
const KPI = {
  disponible: true, zonaHoraria: "America/Mexico_City", hoy: "2026-03-10", mesDesde: "2026-03-01",
  diaDeHoy: totales({ llamadas: 4, llamadasCerradas: 3, duracionPromedioS: 430, pedidosVoz: 1, escaladas: 1, tasaResolucionPct: 33, tasaHandoffPct: 33, erroresProveedor: 4, erroresTwilio: 1, erroresOtros: 1, toolP95PeorDiaMs: 950, costoCentavosMxn: 4000, costoPorLlamadaCentavosMxn: 1000 }),
  mes: totales({ dias: 10, llamadas: 7, llamadasCerradas: 6, pedidosVoz: 3, escaladas: 1, tasaResolucionPct: 50, tasaHandoffPct: 17, tasaErrorPct: 57, erroresProveedor: 4, costoCentavosMxn: 123456, costoLlmOrgCentavosMxn: 6000 }),
  serie: [{ fecha: "2026-03-10", llamadas: 4, pedidosVoz: 1, escaladas: 1, erroresProveedor: 4, toolP95Ms: 950, costoCentavosMxn: 4000 }],
};
const ALERTAS = { disponible: true, umbrales: { configurado: true, umbralCostoDiaCentavosMxn: 3000, umbralTasaErrorPct: null, minLlamadasTasaError: 5 }, alertas: [{ fecha: "2026-03-10", tipo: "costo_dia", valor: 4000, umbral: 3000 }] };
const AJUSTES_VISTA = {
  disponible: true, configurados: true, ambienteDisponible: true, actualizadoEn: "2026-10-13T10:00:00Z",
  ajustes: { whatsappModelo: null, whatsappTemperatura: null, vozModeloCascada: null, vozTemperatura: 0.6, vozRitmo: "normal", vozEstilo: "calido", vozFondoActivo: true, vozFondoVolumen: 8, vozFondoPreset: "cocina-taqueria", vozTecleoActivo: true, vozTecleoVolumen: 12, vozHumanizar: false },
  modelos: [{ id: "openai/gpt-6-luna", etiqueta: "GPT-6 Luna", nivel: "economico", descripcion: "El predeterminado de la plataforma.", aceptaTemperatura: false, vozZdr: true, predeterminado: true, costoWhatsappMicroUsdPorMensaje: 800, costoVozMicroUsdPorMinuto: 1850, precioVerificadoEn: "2026-10-01" }],
  supuestosCosto: { whatsappMensaje: { tokensEntrada: 6000, tokensSalida: 400 }, vozCascadaMinuto: { tokensEntrada: 12000, tokensSalida: 500 }, nota: "No es una factura." },
  temperatura: { min: 0, max: 1, paso: 0.1, maxLlamada: 0.4 },
  habla: { ritmos: ["pausado", "normal", "agil"], estilos: ["neutro", "calido", "sobrio", "animado"], nota: "Se pide por instruccion." },
  fondo: { volumenMax: 20, porOmision: "apagado", presets: [{ id: "cocina-taqueria", descripcion: "Taqueria con la cocina a la vista." }] },
  tecleo: { volumenMax: 25, porOmision: "apagado" },
  presetHumano: {
    id: "restaurante-humano", ritmo: "normal", estilo: "calido", temperatura: 0.4, humanizar: true,
    fondo: { activo: true, preset: "cocina-taqueria", volumen: 7 }, tecleo: { activo: true, volumen: 12 },
    voz: { principal: "Sulafat", alternativas: ["Aoede"], descripciones: { Sulafat: "Cálida", Aoede: "Ligera" } },
    vozPorMotor: { "gemini-live": { proveedor: "gemini", principal: "Sulafat", alternativas: [] }, cascada: { proveedor: "deepgram-aura-2", principal: "aura-2-estrella-es", alternativas: [] } },
    acento: "El acento mexicano se pide en la instruccion.",
    candidatasTtsCascadaV2: [],
  },
  escaleraVoz: { principal: "gemini-3.8-live", respaldo: "cascada por OpenRouter" },
  aplicaEn: { whatsappModeloYTemperatura: "ahora", vozTemperaturaYHabla: "vista previa ahora", vozModeloCascada: "llamadas reales", vozFondo: "llamadas reales" },
  clonacionDeVoz: { disponible: false, motivo: "No clona.", decision: "Otro proveedor." },
  documentosOmitidos: [],
};
const DESBORDE = {
  disponible: true, desde: "2026-03-01", hasta: "2026-03-10", objetivoLatenciaP95Ms: 1500,
  totales: { llamadasDesborde: 4, pedidosDesborde: 2, ventasRecuperadas: 350 },
  ultimaLatencia: { fecha: "2026-03-10", p50Ms: 800, p95Ms: 1200 },
};

beforeAll(async () => {
  prepararJsdomParaRadix();
  await cargarIdioma("en");
});

beforeEach(() => {
  document.documentElement.dataset.diseno = "ds3";
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const metodo = init?.method ?? "GET";
      if (url === `${API}/voz/config`) return json(CONFIG);
      if (url.startsWith(`${API}/voz/conversaciones`)) return json(CONVERSACIONES);
      if (url.startsWith(`${API}/kpis/channels`)) return json(CANALES);
      if (url === `${API}/voz/kpi`) return json(KPI);
      if (url === `${API}/voz/kpi-desborde`) return json(DESBORDE);
      if (url === `${API}/voz/alertas/evaluar` && metodo === "POST") return json({ disponible: true, alertas: [] });
      if (url === `${API}/voz/alertas`) return json(ALERTAS);
      if (url === `${API}/agente/ajustes`) return json(AJUSTES_VISTA);
      if (url === `${API}/agente/conocimiento`) return json({}, 404);
      throw new Error(`sin respuesta simulada: ${metodo} ${url}`);
    }),
  );
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fijarIdiomaActivo("es");
  delete document.documentElement.dataset.diseno;
});

async function asentar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i++) await flushMicrotasks();
  });
}

async function montar(el: ReactElement): Promise<HTMLElement> {
  rendered = renderComponent(el);
  await asentar();
  return rendered.container;
}

async function htmlDe(el: ReactElement): Promise<string> {
  const c = await montar(el);
  // Los ids de React (useId: «:r3:») cambian entre montajes; el resto debe ser identico.
  const html = c.innerHTML.replace(/:r[0-9a-z]+:/g, ":id:").replace(/«r[0-9a-z]+»/g, "«id»");
  rendered?.unmount();
  rendered = undefined;
  return html;
}

async function irA(c: HTMLElement, nombre: string): Promise<void> {
  const tab = Array.from(c.querySelectorAll<HTMLElement>('[role="tab"]')).find((t) => t.textContent === nombre);
  expect(tab, nombre).toBeDefined();
  click(tab!);
  await asentar();
}

const CLAVE_CRUDA = /\brestaurantes\.[a-zA-Z]+\.[A-Za-z0-9._]+/;
const agente = () => <AgenteVozPage {...CTX} />;
const indicadores = () => <PestanaIndicadores apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" />;
const resumenKpis = () => <ResumenKpisVoz apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" role="owner" />;
const LISTA: readonly ConversacionVoz[] = [
  { id: "c1", iniciadaEn: "2026-09-30T18:00:00Z", duracionSegundos: 125, costoUsd: 0.0425, resultado: "pedido_creado" },
  { id: "c2", iniciadaEn: "2026-09-30T19:00:00Z", duracionSegundos: 30, costoUsd: 0, resultado: null },
];
const ajustes = () => <AjustesAgentePage {...CTX} crearAudio={() => ({ play: () => undefined, pause: () => undefined, onended: null, onerror: null })} />;
const conversaciones = () => <PestanaConversaciones conversaciones={{ estado: "listo", datos: LISTA }} onReintentar={() => undefined} />;

describe("Agente de voz ES/EN", () => {
  it("en espanol el DOM es identico con y sin IdiomaProvider (Resumen, Voz, Mensaje inicial y Herramientas)", async () => {
    for (const tab of ["Resumen", "Voz", "Mensaje inicial", "Herramientas"]) {
      const sin = await (async () => {
        const c = await montar(agente());
        if (tab !== "Resumen") await irA(c, tab);
        const h = c.innerHTML.replace(/:r[0-9a-z]+:/g, ":id:").replace(/«r[0-9a-z]+»/g, "«id»");
        rendered?.unmount();
        rendered = undefined;
        return h;
      })();
      const con = await (async () => {
        const c = await montar(<IdiomaProvider idiomaInicial="es">{agente()}</IdiomaProvider>);
        if (tab !== "Resumen") await irA(c, tab);
        const h = c.innerHTML.replace(/:r[0-9a-z]+:/g, ":id:").replace(/«r[0-9a-z]+»/g, "«id»");
        rendered?.unmount();
        rendered = undefined;
        return h;
      })();
      expect(con, tab).toBe(sin);
    }
  });

  it("en ingles sale en ingles, sin claves crudas; el saludo de ejemplo y los nombres de voz quedan tal cual", async () => {
    const c = await montar(<IdiomaProvider idiomaInicial="en">{agente()}</IdiomaProvider>);
    const tabs = Array.from(c.querySelectorAll('[role="tab"]')).map((t) => t.textContent);
    expect(tabs).toEqual(["Overview", "Voice", "Knowledge", "Behavior", "Opening message", "Tools", "Conversations", "Metrics"]);
    let texto = c.textContent ?? "";
    for (const en of ["Voice service", "Selected voice", "Kore · Firm", "Before going live", "Choose a voice", "Open test call", "Voice orders completed", "18 of 20 · reference target: 90%", "1 canceled"]) expect(texto, en).toContain(en);
    for (const es of ["Servicio de voz", "Voz elegida", "Antes de salir en vivo", "Firme", "Pedidos completados por voz"]) expect(texto, es).not.toContain(es);
    // El periodo lo redacta la API: llega tal cual.
    expect(texto).toContain("Últimos 30 días");

    await irA(c, "Voice");
    texto = c.textContent ?? "";
    for (const en of ["Agent enabled to take calls at this branch", "Voice — 30/30 voices", "Phone call voice"]) expect(texto, en).toContain(en);
    expect(c.querySelector("input[aria-label='Search voices']")?.getAttribute("placeholder")).toBe("Search by name or tone…");

    await irA(c, "Opening message");
    texto = c.textContent ?? "";
    expect(texto).toContain("Transparency:");
    expect(c.querySelector("#voz-mensaje-inicial")?.getAttribute("placeholder")).toBe("Hola, le atiende el asistente virtual de …");

    await irA(c, "Tools");
    texto = c.textContent ?? "";
    expect(texto).toContain("Tools the agent can use during a call.");
    // Las herramientas del agente se quedan en espanol a proposito (herramientas-agente.ts).
    expect(texto).toContain("Buscar producto");
    expect(c.innerHTML).not.toMatch(CLAVE_CRUDA);
  });
});

describe("Indicadores de voz ES/EN", () => {
  it("en espanol el DOM es identico con y sin IdiomaProvider", async () => {
    const sin = await htmlDe(indicadores());
    const con = await htmlDe(<IdiomaProvider idiomaInicial="es">{indicadores()}</IdiomaProvider>);
    expect(con).toBe(sin);
    expect(sin).toContain("Hoy es 10 mar (zona America/Mexico_City)");
    expect(sin).toContain("Cumple el objetivo de 1.5 s");
  });

  it("en ingles sale en ingles, sin claves crudas", async () => {
    const c = await montar(<IdiomaProvider idiomaInicial="en">{indicadores()}</IdiomaProvider>);
    const texto = c.textContent ?? "";
    for (const en of ["Today is Mar 10 (America/Mexico_City time zone)", "Current month", "Last 14 days", "Threshold alerts", "High daily cost", "Calls not answered by staff", "Meets the 1.5 s target", "Save thresholds"]) expect(texto, en).toContain(en);
    for (const es of ["Hoy es", "Mes en curso", "Alertas por umbral", "Guardar umbrales", "10 mar"]) expect(texto, es).not.toContain(es);
    expect(c.innerHTML).not.toMatch(CLAVE_CRUDA);
  });
});

describe("Resumen del canal y conversaciones de voz ES/EN", () => {
  it("en espanol el DOM es identico con y sin IdiomaProvider", async () => {
    expect(await htmlDe(<IdiomaProvider idiomaInicial="es">{resumenKpis()}</IdiomaProvider>)).toBe(await htmlDe(resumenKpis()));
    const sin = await htmlDe(conversaciones());
    expect(await htmlDe(<IdiomaProvider idiomaInicial="es">{conversaciones()}</IdiomaProvider>)).toBe(sin);
    expect(sin).toContain("Pedido creado");
    expect(sin).toContain("Sin clasificar");
  });

  it("en ingles salen en ingles, con plurales y sin claves crudas", async () => {
    let c = await montar(<IdiomaProvider idiomaInicial="en">{resumenKpis()}</IdiomaProvider>);
    let texto = c.textContent ?? "";
    for (const en of ["Voice channel share", "20 of 80 orders · reference target: 25%", "Calls this month", "6 closed", "1 call", "Concurrency usage"]) expect(texto, en).toContain(en);
    expect(c.innerHTML).not.toMatch(CLAVE_CRUDA);
    rendered?.unmount();

    c = await montar(<IdiomaProvider idiomaInicial="en">{conversaciones()}</IdiomaProvider>);
    texto = c.textContent ?? "";
    for (const en of ["Voice conversations", "Order created", "Unclassified", "View transcript", "Outcome"]) expect(texto, en).toContain(en);
    for (const es of ["Pedido creado", "Ver transcripción"]) expect(texto, es).not.toContain(es);
    expect(c.innerHTML).not.toMatch(CLAVE_CRUDA);
  });
});

describe("Ajustes del agente ES/EN", () => {
  it("en espanol el DOM es identico con y sin IdiomaProvider", async () => {
    const sin = await htmlDe(ajustes());
    const con = await htmlDe(<IdiomaProvider idiomaInicial="es">{ajustes()}</IdiomaProvider>);
    expect(con).toBe(sin);
    expect(sin).toContain("Ritmo Normal y estilo Cálido; temperatura 0.4.");
    expect(sin).toContain("En llamadas reales la temperatura nunca pasa de 0.4: el valor 0.6 que elegiste se usa como 0.4 en las llamadas");
  });

  it("en ingles sale en ingles, sin claves crudas; lo que redacta la API llega tal cual", async () => {
    const c = await montar(<IdiomaProvider idiomaInicial="en">{ajustes()}</IdiomaProvider>);
    const texto = c.textContent ?? "";
    for (const en of [
      "WhatsApp agent",
      "Applies from the next message.",
      "Platform default (GPT-6 Luna)",
      "Estimated cost: ≈ US$0.80 per 1,000 messages",
      "«Human restaurant» preset",
      "Pace: Normal, style: Warm; temperature 0.4.",
      "«Taqueria kitchen» ambience at 7 % and typing at 12 %.",
      "Voice (calls)",
      "In real calls the temperature never goes above 0.4: the 0.6 you chose is used as 0.4 in calls",
      "Restaurant background sound",
      "Typing while taking notes: on",
      "Save settings",
      "Voice and greeting for this branch",
      "Voice cloning",
    ])
      expect(texto, en).toContain(en);
    for (const es of ["Agente de WhatsApp", "Sonido de fondo de restaurante", "Guardar ajustes", "Voz y saludo de esta sucursal", "Clonación de voz", "Cocina de taquería"]) expect(texto, es).not.toContain(es);
    for (const api of ["No es una factura.", "Taqueria con la cocina a la vista.", "No clona."]) expect(texto, api).toContain(api);
    expect(c.querySelector("#ajustes-saludo")?.getAttribute("placeholder")).toBe("Hola, le atiende el asistente virtual de …");
    expect(c.innerHTML).not.toMatch(CLAVE_CRUDA);
  });
});

describe("etiquetas de lib/ del agente de voz", () => {
  it("en espanol son los textos de siempre", () => {
    expect(buscarVoz("Kore")?.tono).toBe("Firme");
    expect(buscarVoz("Algenib")?.tono).toBe("Grave y áspero");
    expect(filtrarVoces(CATALOGO_VOCES, "calido").map((v) => v.id)).toEqual(["Sulafat"]);
    expect(VOCES_TELEFONO[0]!.estilo).toBe("Femenina mexicana, de centro de atención (la de la plataforma)");
    expect(etiquetaResultado("escalado")).toBe("Escalada a una persona");
    expect(etiquetaResultado(null)).toBe("Sin clasificar");
    expect(etiquetaAlerta("tasa_error", 40, 20)).toBe("La tasa de error de proveedor (40%) llegó al umbral de 20%.");
    expect(formatoDia("2026-03-10")).toBe("10 mar");
    expect(new VozNoDisponibleError(404).message).toBe("El servicio de voz todavía no está disponible para este negocio.");
    expect(costoPorMil(800, "minutos")).toBe("≈ US$0.80 por 1,000 minutos");
    expect(costoPorMil(null, "mensajes")).toBe("sin precio de lista conocido");
    expect(RITMOS.map((r) => r.rotulo)).toEqual(["Pausado", "Normal", "Ágil"]);
    expect(Object.keys(RITMOS[0]!).sort()).toEqual(["id", "rotulo"]);
    expect(ESTILOS.find((e) => e.id === "calido")?.rotulo).toBe("Cálido");
    expect(PRESETS_AMBIENTE[0]!.rotulo).toBe("Cocina de taquería");
    expect(etiquetaNivel("economico")).toBe("Económico");
    expect(rotuloTemperatura("auto")).toBe("Automática");
  });

  it("en ingles siguen al idioma activo", () => {
    fijarIdiomaActivo("en");
    expect(buscarVoz("Kore")?.tono).toBe("Firm");
    expect(filtrarVoces(CATALOGO_VOCES, "warm").map((v) => v.id)).toEqual(["Sulafat"]);
    expect(VOCES_TELEFONO[1]!.estilo).toBe("Male, Mexican, corporate");
    expect(etiquetaResultado("abandonado")).toBe("Abandoned");
    expect(etiquetaAlerta("costo_dia", 4000, 3000)).toBe("Today's cost ($40.00 MXN) reached the $30.00 MXN threshold.");
    expect(formatoDia("2026-03-10")).toBe("Mar 10");
    expect(new VozNoDisponibleError(503).message).toBe("The voice service isn't available for this business yet.");
    expect(costoPorMil(800, "mensajes")).toBe("≈ US$0.80 per 1,000 messages");
    expect(RITMOS.map((r) => r.rotulo)).toEqual(["Slow", "Normal", "Fast"]);
    expect(PRESETS_AMBIENTE[2]!.rotulo).toBe("Busy street");
    expect(etiquetaNivel("equilibrado")).toBe("Balanced");
    expect(rotuloTemperatura("auto")).toBe("Automatic");
  });
});
