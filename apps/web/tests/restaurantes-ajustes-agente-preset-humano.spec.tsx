// @vitest-environment jsdom
//
// <AjustesAgentePage /> — preset «restaurante humano», ambiente con presets y tecleo (migracion 087). `fetch` mockeado por ruta real del contrato.
// Cada control llama a un endpoint real; lo que falta (migracion 087, vista previa del panel) se dice como "No disponible aún".
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, beforeAll } from "vitest";
import { AjustesAgentePage } from "../src/verticals/restaurantes/pages/AjustesAgente.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

beforeAll(prepararJsdomParaRadix);

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Gaby", staffEmail: "g@example.com" };

const AJUSTES = {
  whatsappModelo: null, whatsappTemperatura: null, vozModeloCascada: null, vozTemperatura: null, vozRitmo: "normal", vozEstilo: "neutro", vozFondoActivo: false, vozFondoVolumen: 8,
  vozFondoPreset: "cocina-taqueria", vozTecleoActivo: false, vozTecleoVolumen: 12, vozHumanizar: false,
};
const PRESET = {
  id: "restaurante-humano", ritmo: "normal", estilo: "calido", temperatura: 0.4, humanizar: true,
  fondo: { activo: true, preset: "cocina-taqueria", volumen: 7 }, tecleo: { activo: true, volumen: 12 },
  voz: { principal: "Sulafat", alternativas: ["Callirrhoe", "Aoede"], descripciones: { Sulafat: "Warm", Callirrhoe: "Easy-going", Aoede: "Breezy" } },
  vozPorMotor: { "gemini-live": { proveedor: "gemini", principal: "Sulafat", alternativas: [] }, cascada: { proveedor: "deepgram-aura-2", principal: "aura-2-estrella-es", alternativas: ["aura-2-olivia-es"] } },
  acento: "El acento mexicano se pide en la instruccion; depende del proveedor.",
  candidatasTtsCascadaV2: [],
};
function vista(parche: Record<string, unknown> = {}, ajustes: Record<string, unknown> = {}) {
  return {
    disponible: true, configurados: true, ambienteDisponible: true, actualizadoEn: "2026-10-13T10:00:00Z", ajustes: { ...AJUSTES, ...ajustes },
    modelos: [{ id: "openai/gpt-6-luna", etiqueta: "GPT-6 Luna", nivel: "economico", descripcion: "x", aceptaTemperatura: false, predeterminado: true, costoWhatsappMicroUsdPorMensaje: 800, costoVozMicroUsdPorMinuto: 1850, precioVerificadoEn: "2026-10-01" }],
    supuestosCosto: { whatsappMensaje: { tokensEntrada: 6000, tokensSalida: 400 }, vozCascadaMinuto: { tokensEntrada: 12000, tokensSalida: 500 }, nota: "No es una factura." },
    temperatura: { min: 0, max: 1, paso: 0.1 },
    habla: { ritmos: ["pausado", "normal", "agil"], estilos: ["neutro", "calido", "sobrio", "animado"], nota: "Se pide por instruccion." },
    fondo: { volumenMax: 20, porOmision: "apagado", presets: [{ id: "cocina-taqueria", descripcion: "Taqueria con la cocina a la vista." }, { id: "sala-tranquila", descripcion: "Comedor tranquilo." }, { id: "calle-ocupada", descripcion: "Abierto a la calle." }] },
    tecleo: { volumenMax: 25, porOmision: "apagado", nota: "Suena solo mientras el agente espera una herramienta." },
    presetHumano: PRESET,
    escaleraVoz: { principal: "gemini-3.8-live", respaldo: "cascada por OpenRouter" },
    aplicaEn: { whatsappModeloYTemperatura: "ahora", vozTemperaturaYHabla: "vista previa ahora; llamadas reales", vozModeloCascada: "llamadas reales", vozFondo: "llamadas reales", vozTecleo: "llamadas reales; no disponible aun en la vista previa" },
    clonacionDeVoz: { disponible: false, motivo: "No clona.", decision: "Otro proveedor." },
    documentosOmitidos: [],
    ...parche,
  };
}
const VOZ = { disponible: true, configurada: true, habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "", mensajeInicial: "Hola" };
const res = (status: number, body: unknown): Response => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

function montar(v: unknown = vista(), put?: (b: Record<string, unknown>) => unknown) {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const metodo = init?.method ?? "GET";
    const cuerpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (u.endsWith("/admin/agente/ajustes")) return res(200, metodo === "PUT" ? (put?.(cuerpo) ?? vista({}, cuerpo)) : v);
    if (u.endsWith("/admin/agente/conocimiento")) return res(503, {});
    if (u.endsWith("/admin/voz/config")) return res(200, VOZ);
    return res(404, {});
  });
  rendered = renderComponent(<AjustesAgentePage {...CTX} crearAudio={() => ({ play: () => undefined, pause: () => undefined, onended: null, onerror: null })} />);
}
async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const q = (sel: string) => rendered!.container.querySelector(sel);
const txt = () => rendered!.container.textContent ?? "";
const boton = (texto: string) => Array.from(rendered!.container.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === texto) as HTMLButtonElement | undefined;
const radio = (nombre: string, valor: string) => rendered!.container.querySelector(`input[name="${nombre}"][value="${valor}"]`) as HTMLInputElement;

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

describe("preset «restaurante humano»", () => {
  it("muestra los valores del preset y las tres voces femeninas (sugerida + 2 alternativas) con su descripcion oficial, y el limite del acento", async () => {
    montar();
    await esperar();
    const valores = q('[data-testid="preset-valores"]')?.textContent ?? "";
    expect(valores).toMatch(/Ritmo Normal y estilo Cálido; temperatura 0\.4/);
    expect(valores).toMatch(/Ambiente «Cocina de taquería» al 7 %/);
    expect(valores).toMatch(/tecleo al 12 %/);
    const voces = q('[data-testid="preset-voces"]')?.textContent ?? "";
    expect(voces).toMatch(/Sulafat · Warm · sugerida/);
    expect(voces).toMatch(/Callirrhoe · Easy-going · alternativa/);
    expect(voces).toMatch(/Aoede · Breezy · alternativa/);
    expect(q('[data-testid="preset-voz-motores"]')?.textContent).toMatch(/Gemini Live usa la voz Sulafat.*cascada usará aura-2-estrella-es de Deepgram Aura-2/);
    expect(q('[data-testid="preset-acento"]')?.textContent).toMatch(/depende del proveedor/);
  });

  it("«Aplicar el preset» solo RELLENA el borrador (no guarda); «Guardar ajustes» manda el PUT con los valores del preset", async () => {
    montar();
    await esperar();
    expect(fetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === "PUT")).toHaveLength(0);
    await act(async () => click(boton("Aplicar el preset")!));
    await esperar();
    expect(fetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === "PUT")).toHaveLength(0);
    expect(txt()).toContain("Hay cambios sin guardar");
    expect(radio("ajustes-estilo", "calido").checked).toBe(true);
    expect(radio("ajustes-fondo-volumen", "7").checked).toBe(true);
    await act(async () => click(boton("Guardar ajustes")!));
    await esperar();
    const put = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === "PUT")!;
    expect(JSON.parse(String((put[1] as RequestInit).body))).toMatchObject({
      vozRitmo: "normal", vozEstilo: "calido", vozTemperatura: 0.4, vozFondoActivo: true, vozFondoVolumen: 7, vozFondoPreset: "cocina-taqueria", vozTecleoActivo: true, vozTecleoVolumen: 12, vozHumanizar: true,
    });
    expect(txt()).toContain("Ajustes guardados");
  });

  it("sin la migracion 087: estado honesto «No disponible aún: requiere …», el boton y los controles nuevos deshabilitados", async () => {
    montar(vista({ ambienteDisponible: false }));
    await esperar();
    expect(q('[data-testid="preset-no-disponible"]')?.textContent).toMatch(/No disponible aún: requiere aplicar la migración 087/);
    expect(q('[data-testid="tecleo-no-disponible"]')?.textContent).toMatch(/No disponible aún/);
    expect(boton("Aplicar el preset")!.disabled).toBe(true);
    expect((q("#ajustes-tecleo") as HTMLButtonElement).disabled).toBe(true);
    expect((q("#ajustes-humanizar") as HTMLButtonElement).disabled).toBe(true);
  });

  it("API vieja (sin presetHumano ni ambienteDisponible): no inventa la tarjeta del preset", async () => {
    const vieja = vista({ ambienteDisponible: undefined, presetHumano: undefined, tecleo: undefined });
    montar(vieja);
    await esperar();
    expect(q('[data-testid="seccion-preset-humano"]')).toBeNull();
    expect(q('[data-testid="tecleo-no-disponible"]')).not.toBeNull();
  });
});

describe("ambiente y tecleo", () => {
  it("con el fondo activo ofrece los tres presets de ambiente con su descripcion; cambiar uno marca cambios y el PUT lo lleva", async () => {
    montar(vista({}, { vozFondoActivo: true }));
    await esperar();
    expect(radio("ajustes-fondo-preset", "sala-tranquila")).not.toBeNull();
    expect(radio("ajustes-fondo-preset", "calle-ocupada")).not.toBeNull();
    expect(q('[data-testid="descripcion-preset-ambiente"]')?.textContent).toMatch(/cocina a la vista/);
    await act(async () => click(radio("ajustes-fondo-preset", "calle-ocupada")));
    await esperar();
    expect(q('[data-testid="descripcion-preset-ambiente"]')?.textContent).toMatch(/calle/);
    await act(async () => click(boton("Guardar ajustes")!));
    await esperar();
    const put = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === "PUT")!;
    expect(JSON.parse(String((put[1] as RequestInit).body))).toMatchObject({ vozFondoPreset: "calle-ocupada", vozFondoActivo: true });
  });

  it("activar el tecleo muestra su volumen con el tope; la nota dice que NO esta disponible en la vista previa del panel", async () => {
    montar();
    await esperar();
    expect(q('[name="ajustes-tecleo-volumen"]')).toBeNull();
    await act(async () => click(q("#ajustes-tecleo") as HTMLElement));
    await esperar();
    expect(txt()).toContain("nunca pasa de 25 %");
    expect(radio("ajustes-tecleo-volumen", "12").checked).toBe(true);
    expect(q('[data-testid="nota-tecleo"]')?.textContent).toMatch(/no disponible aun en la vista previa/);
    expect(q('[data-testid="nota-vista-previa-sonido"]')?.textContent).toMatch(/No disponible aún en la vista previa/);
  });
});
