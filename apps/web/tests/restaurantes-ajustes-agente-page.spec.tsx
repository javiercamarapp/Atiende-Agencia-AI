// @vitest-environment jsdom
//
// <AjustesAgentePage />: modelo y temperatura del agente de WhatsApp con costo estimado, voz (temperatura, ritmo, estilo, cascada), sonido de fondo,
// voz y saludo de la sucursal, conocimiento automatico y clonacion con estado honesto. `fetch` global mockeado por ruta REAL del contrato
// (lib/ajustes-agente-client.ts y lib/voz-client.ts): cada control llama a un endpoint, y los 503 / base sin migrar / validacion se ven de verdad.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AjustesAgentePage } from "../src/verticals/restaurantes/pages/AjustesAgente.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { costoPorMil, pasoDeTemperatura, temperaturaDePaso } from "../src/verticals/restaurantes/voz/formato-ajustes.ts";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Gaby", staffEmail: "g@example.com" };

const MODELOS = [
  { id: "openai/gpt-6-luna", etiqueta: "GPT-6 Luna", nivel: "economico", descripcion: "El predeterminado de la plataforma.", aceptaTemperatura: false, predeterminado: true, costoWhatsappMicroUsdPorMensaje: 800, costoVozMicroUsdPorMinuto: 1850, precioVerificadoEn: "2026-10-01" },
  { id: "google/gemini-2.5-flash-lite", etiqueta: "Gemini 2.5 Flash-Lite", nivel: "economico", descripcion: "El mas barato.", aceptaTemperatura: true, predeterminado: false, costoWhatsappMicroUsdPorMensaje: 760, costoVozMicroUsdPorMinuto: 1400, precioVerificadoEn: "2026-10-02" },
  { id: "anthropic/claude-sonnet-5.5", etiqueta: "Claude Sonnet 5.5", nivel: "premium", descripcion: "El de mayor calidad.", aceptaTemperatura: false, predeterminado: false, costoWhatsappMicroUsdPorMensaje: 16000, costoVozMicroUsdPorMinuto: 29000, precioVerificadoEn: "2026-10-01" },
];

const AJUSTES = { whatsappModelo: null, whatsappTemperatura: null, vozModeloCascada: null, vozTemperatura: null, vozRitmo: "normal", vozEstilo: "neutro", vozFondoActivo: false, vozFondoVolumen: 8 };

function vista(parche: Record<string, unknown> = {}, ajustes: Record<string, unknown> = {}) {
  return {
    disponible: true,
    configurados: true,
    actualizadoEn: "2026-10-04T10:00:00Z",
    ajustes: { ...AJUSTES, ...ajustes },
    modelos: MODELOS,
    supuestosCosto: { whatsappMensaje: { tokensEntrada: 6000, tokensSalida: 400 }, vozCascadaMinuto: { tokensEntrada: 12000, tokensSalida: 500 }, nota: "Estimacion con precios de lista. No es una factura." },
    temperatura: { min: 0, max: 1, paso: 0.1 },
    habla: { ritmos: ["pausado", "normal", "agil"], estilos: ["neutro", "calido", "sobrio", "animado"], nota: "Gemini Live no tiene un control numerico de velocidad: se pide por instruccion." },
    fondo: { volumenMax: 20, porOmision: "apagado" },
    escaleraVoz: { principal: "gemini-3.8-live", respaldo: "cascada por OpenRouter" },
    aplicaEn: { whatsappModeloYTemperatura: "ahora", vozTemperaturaYHabla: "vista previa ahora; llamadas reales cuando se despliegue el servicio de llamadas", vozModeloCascada: "llamadas reales cuando se despliegue el servicio de llamadas", vozFondo: "llamadas reales cuando se despliegue el servicio de llamadas" },
    clonacionDeVoz: { disponible: false, motivo: "No disponible con el proveedor actual: Gemini Live no clona voces.", decision: "Requeriria un proveedor de voz aparte (decision de Javier)." },
    documentosOmitidos: [{ tipo: "ventas", motivo: "El agente no necesita cifras de ventas." }, { tipo: "personal", motivo: "El personal es informacion de personas." }],
    ...parche,
  };
}

const CONOCIMIENTO = {
  generadoEn: "2026-10-04T10:00:00Z",
  huella: "abcdef0123456789",
  nota: "Estos documentos se generan al momento desde los datos de tu cuenta.",
  documentos: [
    { tipo: "sucursales_horarios", titulo: "Sucursales y horarios", contenido: "## Centro\nHorario: lunes a viernes de 12:00 a 22:00", caracteres: 48, huella: "11112222aaaa", vacio: false, motivoVacio: null, enPrompt: true },
    { tipo: "colonias_sucursal", titulo: "Colonia → sucursal más cercana", contenido: "", caracteres: 0, huella: "3333", vacio: true, motivoVacio: "No hay colonias conocidas configuradas.", enPrompt: false },
    { tipo: "menu_precios", titulo: "Menú y precios", contenido: "- Taco de pastor: $25", caracteres: 22, huella: "44445555bbbb", vacio: false, motivoVacio: null, enPrompt: false },
  ],
  prompt: { topeCaracteres: 6000, caracteresUsados: 120, omitidos: [] },
  alertasColonias: { umbralKm: 1, items: [{ colonia: "Cerca de ambas", sucursales: ["Centro", "Norte"], diferenciaKm: 0.4 }], sinSucursal: 0 },
  documentosOmitidos: [{ tipo: "ventas", motivo: "El agente no necesita cifras de ventas." }, { tipo: "personal", motivo: "El personal es informacion de personas." }],
};

const VOZ = { disponible: true, configurada: true, habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "REGLAS DE LA SUCURSAL", mensajeInicial: "Hola, le atiende el asistente virtual de Los Taquitos." };

type Respuesta = { status: number; body?: unknown };
interface Rutas {
  ajustes?: Respuesta;
  putAjustes?: (body: Record<string, unknown>) => Respuesta;
  conocimiento?: Respuesta;
  voz?: Respuesta;
  putVoz?: (body: Record<string, unknown>) => Respuesta;
}

function res(r: Respuesta): Response {
  return { ok: r.status < 400, status: r.status, json: async () => r.body ?? {}, text: async () => JSON.stringify(r.body ?? {}) } as unknown as Response;
}

function montar(rutas: Rutas = {}) {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const metodo = init?.method ?? "GET";
    const cuerpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (u.endsWith("/admin/agente/ajustes")) return res(metodo === "PUT" ? (rutas.putAjustes?.(cuerpo) ?? { status: 200, body: vista({}, cuerpo) }) : (rutas.ajustes ?? { status: 200, body: vista() }));
    if (u.endsWith("/admin/agente/conocimiento")) return res(rutas.conocimiento ?? { status: 200, body: CONOCIMIENTO });
    if (u.endsWith("/admin/voz/config")) return res(metodo === "PUT" ? (rutas.putVoz?.(cuerpo) ?? { status: 200, body: { ...VOZ, voiceId: cuerpo.voiceId, mensajeInicial: cuerpo.mensajeInicial } }) : (rutas.voz ?? { status: 200, body: VOZ }));
    return res({ status: 404 });
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
const llamadas = (metodo: string, fin: string) => fetchMock.mock.calls.filter(([u, i]) => String(u).endsWith(fin) && ((i as RequestInit | undefined)?.method ?? "GET") === metodo);

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

describe("AjustesAgentePage — carga y estados honestos", () => {
  it("carga los ajustes reales: modelo predeterminado, costo estimado con supuestos, secciones y que aplica ahora y que depende del servicio de llamadas", async () => {
    montar();
    await esperar();
    expect((q("#ajustes-modelo-whatsapp") as HTMLSelectElement).value).toBe("");
    expect(txt()).toContain("Predeterminado de la plataforma (GPT-6 Luna)");
    expect(q('[data-testid="costo-whatsapp"]')?.textContent).toMatch(/≈ US\$0\.80 por 1,000 mensajes/);
    expect(q('[data-testid="supuestos-costo"]')?.textContent).toMatch(/6,000 tokens de entrada y 400 de salida/);
    expect(q('[data-testid="supuestos-costo"]')?.textContent).toMatch(/No es una factura/);
    expect(q('[data-testid="aplica-whatsapp"]')?.textContent).toMatch(/desde el siguiente mensaje/);
    expect(q('[data-testid="aplica-fondo"]')?.textContent).toMatch(/servicio de llamadas/);
    expect(q('[data-testid="aplica-cascada"]')?.textContent).toMatch(/servicio de llamadas/);
    expect(llamadas("GET", "/admin/agente/ajustes")).toHaveLength(1);
  });

  it("el modelo predeterminado no admite temperatura: lo dice en vez de ofrecer un control que no hace nada", async () => {
    montar();
    await esperar();
    expect(q('[data-testid="sin-temperatura-whatsapp"]')?.textContent).toMatch(/GPT-6 Luna no admite temperatura/);
    expect(q('input[name="ajustes-temperatura-whatsapp"]')).toBeNull();
  });

  it("clonacion de voz: estado honesto 'No disponible' con el motivo y la decision pendiente, sin ningun boton", async () => {
    montar();
    await esperar();
    const s = q('[data-testid="seccion-clonacion"]')!;
    expect(s.textContent).toContain("No disponible");
    expect(q('[data-testid="clonacion-motivo"]')?.textContent).toMatch(/no clona/);
    expect(q('[data-testid="clonacion-decision"]')?.textContent).toMatch(/proveedor de voz aparte/);
    expect(s.querySelectorAll("button")).toHaveLength(0);
  });

  it("base sin migrar (disponible=false): lo dice y NO deja guardar", async () => {
    montar({ ajustes: { status: 200, body: vista({ disponible: false, configurados: false }) } });
    await esperar();
    expect(q('[data-testid="ajustes-sin-migrar"]')?.textContent).toMatch(/migración 055/);
    expect((q("#ajustes-modelo-whatsapp") as HTMLSelectElement).disabled).toBe(true);
    expect(boton("Guardar ajustes")!.disabled).toBe(true);
  });

  it("503/404 del servicio: 'no disponible aun' en lugar de datos inventados; error real: mensaje y reintentar", async () => {
    montar({ ajustes: { status: 503 } });
    await esperar();
    expect(q('[data-testid="ajustes-no-disponible"]')).not.toBeNull();
    expect(q('[data-testid="seccion-whatsapp"]')).toBeNull();
    rendered!.unmount();
    montar({ ajustes: { status: 500, body: { error: { message: "fallo interno" } } } });
    await esperar();
    expect(rendered!.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(boton("Reintentar")).toBeDefined();
  });
});

describe("AjustesAgentePage — guardar de verdad", () => {
  it("elegir un modelo que admite temperatura muestra el control; guardar manda el PUT completo y confirma", async () => {
    montar();
    await esperar();
    changeValue(q("#ajustes-modelo-whatsapp") as HTMLSelectElement, "google/gemini-2.5-flash-lite");
    expect(q('[data-testid="costo-whatsapp"]')?.textContent).toMatch(/≈ US\$0\.76 por 1,000 mensajes/);
    expect(q('[data-testid="sin-temperatura-whatsapp"]')).toBeNull();
    click(radio("ajustes-temperatura-whatsapp", "0.4"));
    expect(boton("Guardar ajustes")!.disabled).toBe(false);
    await act(async () => {
      click(boton("Guardar ajustes")!);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    const put = llamadas("PUT", "/admin/agente/ajustes");
    expect(put).toHaveLength(1);
    expect(JSON.parse(String((put[0]![1] as RequestInit).body))).toEqual({ ...AJUSTES, whatsappModelo: "google/gemini-2.5-flash-lite", whatsappTemperatura: 0.4 });
    expect(txt()).toContain("Ajustes guardados");
    expect(boton("Guardar ajustes")!.disabled).toBe(true);
  });

  it("cambiar a un modelo sin temperatura la reinicia a automatica (nunca manda una combinacion que el servidor rechaza)", async () => {
    montar({ ajustes: { status: 200, body: vista({}, { whatsappModelo: "google/gemini-2.5-flash-lite", whatsappTemperatura: 0.4 }) } });
    await esperar();
    changeValue(q("#ajustes-modelo-whatsapp") as HTMLSelectElement, "anthropic/claude-sonnet-5.5");
    await act(async () => {
      click(boton("Guardar ajustes")!);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(JSON.parse(String((llamadas("PUT", "/admin/agente/ajustes")[0]![1] as RequestInit).body))).toMatchObject({ whatsappModelo: "anthropic/claude-sonnet-5.5", whatsappTemperatura: null });
  });

  it("voz: ritmo, estilo, temperatura, cascada y fondo con volumen viajan en el mismo PUT", async () => {
    montar();
    await esperar();
    click(radio("ajustes-ritmo", "pausado"));
    click(radio("ajustes-estilo", "calido"));
    click(radio("ajustes-temperatura-voz", "0.2"));
    changeValue(q("#ajustes-modelo-cascada") as HTMLSelectElement, "anthropic/claude-sonnet-5.5");
    expect(q('[data-testid="costo-cascada"]')?.textContent).toMatch(/US\$29\.00 por 1,000 minutos/);
    click(q('button[role="switch"]')!);
    click(radio("ajustes-fondo-volumen", "12"));
    await act(async () => {
      click(boton("Guardar ajustes")!);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(JSON.parse(String((llamadas("PUT", "/admin/agente/ajustes")[0]![1] as RequestInit).body))).toEqual({
      ...AJUSTES,
      vozRitmo: "pausado",
      vozEstilo: "calido",
      vozTemperatura: 0.2,
      vozModeloCascada: "anthropic/claude-sonnet-5.5",
      vozFondoActivo: true,
      vozFondoVolumen: 12,
    });
  });

  it("el fondo arranca apagado y no ofrece volumen hasta activarlo", async () => {
    montar();
    await esperar();
    expect(q('button[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    expect(q('input[name="ajustes-fondo-volumen"]')).toBeNull();
    click(q('button[role="switch"]')!);
    expect(q('input[name="ajustes-fondo-volumen"][value="8"]')).not.toBeNull();
    expect(q('[data-testid="seccion-fondo"]')?.textContent).toMatch(/nunca pasa de 20 %/);
  });

  it("el servidor rechaza (400): se ve el mensaje y los cambios siguen sin guardar", async () => {
    montar({ putAjustes: () => ({ status: 400, body: { error: { message: "whatsappModelo: no esta en la lista de modelos permitidos." } } }) });
    await esperar();
    changeValue(q("#ajustes-modelo-whatsapp") as HTMLSelectElement, "google/gemini-2.5-flash-lite");
    await act(async () => {
      click(boton("Guardar ajustes")!);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(q('[role="alert"]')?.textContent).toBeTruthy();
    expect(txt()).toContain("Hay cambios sin guardar");
    expect(boton("Guardar ajustes")!.disabled).toBe(false);
  });
});

describe("AjustesAgentePage — voz y saludo por sucursal", () => {
  it("guarda la voz y el saludo SOBRE la configuracion vigente (no borra el comportamiento ni apaga el agente)", async () => {
    montar();
    await esperar();
    const saludo = q("#ajustes-saludo") as HTMLTextAreaElement;
    expect(saludo.value).toBe(VOZ.mensajeInicial);
    changeValue(saludo, "Bienvenido, le atiende el asistente virtual de Los Taquitos de PM.");
    await act(async () => {
      click(boton("Guardar voz y saludo")!);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    const put = llamadas("PUT", "/admin/voz/config");
    expect(put).toHaveLength(1);
    expect(JSON.parse(String((put[0]![1] as RequestInit).body))).toEqual({ habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "REGLAS DE LA SUCURSAL", mensajeInicialInterrumpible: true, mensajeInicial: "Bienvenido, le atiende el asistente virtual de Los Taquitos de PM." });
    expect(txt()).toContain("Voz y saludo guardados");
  });

  it("un saludo que no dice 'asistente virtual' avisa antes de guardar", async () => {
    montar();
    await esperar();
    changeValue(q("#ajustes-saludo") as HTMLTextAreaElement, "Hola, buenas tardes");
    expect(q('[data-testid="alerta-sin-asistente-virtual"]')).not.toBeNull();
  });

  it("sin servicio de voz (503): estado honesto y no se puede guardar", async () => {
    montar({ voz: { status: 503 } });
    await esperar();
    expect(q('[data-testid="voz-no-disponible"]')?.textContent).toMatch(/No disponible aún/);
    expect(boton("Guardar voz y saludo")).toBeUndefined();
  });
});

describe("AjustesAgentePage — conocimiento automatico", () => {
  it("muestra los documentos generados con su estado (en la instruccion / se consulta en vivo / sin datos), la huella y las colonias ambiguas", async () => {
    montar();
    await esperar();
    expect(q('[data-documento="sucursales_horarios"]')?.textContent).toContain("En la instrucción de voz");
    expect(q('[data-documento="menu_precios"]')?.textContent).toContain("Se consulta en vivo");
    expect(q('[data-documento="colonias_sucursal"]')?.textContent).toMatch(/Sin datos.*No hay colonias conocidas/);
    expect(q('[data-documento="sucursales_horarios"] pre')?.textContent).toContain("Horario: lunes a viernes de 12:00 a 22:00");
    expect(q('[data-testid="conocimiento-nota"]')?.textContent).toMatch(/huella abcdef01/);
    expect(q('[data-testid="alerta-colonias"]')?.textContent).toMatch(/Cerca de ambas: Centro o Norte \(0\.40 km\)/);
    expect(q('[data-testid="conocimiento-tope"]')?.textContent).toMatch(/120 de 6,000 caracteres/);
  });

  it("declara lo que NO genera (ventas y personal) con su razon", async () => {
    montar();
    await esperar();
    const o = q('[data-testid="documentos-omitidos"]')!.textContent!;
    expect(o).toContain("Ventas:");
    expect(o).toContain("Personal:");
    expect(o).toMatch(/personas/);
  });

  it("'Volver a generar' vuelve a pedir los documentos al servidor (siempre del dato vigente)", async () => {
    montar();
    await esperar();
    expect(llamadas("GET", "/admin/agente/conocimiento")).toHaveLength(1);
    await act(async () => {
      click(boton("Volver a generar")!);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(llamadas("GET", "/admin/agente/conocimiento")).toHaveLength(2);
  });

  it("error del servicio: mensaje y reintentar, sin documentos inventados", async () => {
    montar({ conocimiento: { status: 500, body: { error: { message: "no se pudo leer el menu" } } } });
    await esperar();
    expect(q('[data-testid="seccion-conocimiento-auto"] [role="alert"]')).not.toBeNull();
    expect(q("[data-documento]")).toBeNull();
  });
});

describe("formato de ajustes", () => {
  it("costo por mil en es-MX, o 'sin precio' cuando no hay dato (no se inventa)", () => {
    expect(costoPorMil(800, "mensajes")).toBe("≈ US$0.80 por 1,000 mensajes");
    expect(costoPorMil(16000, "mensajes")).toBe("≈ US$16.00 por 1,000 mensajes");
    expect(costoPorMil(null, "mensajes")).toBe("sin precio de lista conocido");
  });

  it("pasos de temperatura: auto <-> null y valores numericos", () => {
    expect(pasoDeTemperatura(null)).toBe("auto");
    expect(pasoDeTemperatura(0.4)).toBe("0.4");
    expect(temperaturaDePaso("auto")).toBeNull();
    expect(temperaturaDePaso("0.6")).toBe(0.6);
  });
});
