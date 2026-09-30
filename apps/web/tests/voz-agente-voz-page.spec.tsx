// @vitest-environment jsdom
//
// <AgenteVozPage />: pestañas, selector de voz SIN clonación, guardado, estados
// honestos cuando el backend aún no existe (404/503), herramientas con contador real,
// conversaciones y vista previa en modo demostración. `fetch` global mockeado por ruta
// real contra los endpoints que construye la otra tarea (lib/voz-client.ts).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgenteVozPage } from "../src/verticals/restaurantes/pages/AgenteVoz.tsx";
import type { MuestraAudio } from "../src/verticals/restaurantes/voz/SelectorVoz.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import type { ConversacionVoz, VozConfig } from "../src/verticals/restaurantes/lib/voz-client.ts";
import { changeValue, click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

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

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Gaby", staffEmail: "g@example.com" };

const CONFIG: VozConfig = { vozId: "Kore", promptSistema: "Habla en español de México.", mensajeInicial: "Hola, le atiende el asistente virtual de Los Taquitos.", conocimiento: "Abrimos de 9 a 21.", actualizadoEn: "2026-09-30T12:00:00Z" };

const CONVERSACIONES: ConversacionVoz[] = [
  {
    id: "c1",
    iniciadaEn: "2026-09-30T18:00:00Z",
    duracionSegundos: 125,
    costoUsd: 0.0425,
    resultado: "pedido",
    herramientas: ["buscar_producto", "cotizar_pedido", "crear_pedido"],
    transcripcion: [
      { rol: "agente", texto: "Hola, asistente virtual de Los Taquitos", ts: 1 },
      { rol: "usuario", texto: "Quiero dos de pastor", ts: 2 },
    ],
  },
  { id: "c2", iniciadaEn: "2026-09-30T19:00:00Z", duracionSegundos: 30, costoUsd: null, resultado: null, herramientas: ["buscar_producto"] },
];

type Respuesta = { status: number; body?: unknown };
interface Rutas {
  config?: Respuesta;
  conversaciones?: Respuesta;
  put?: (body: Record<string, unknown>) => Respuesta;
}

function res(r: Respuesta): Response {
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} } as unknown as Response;
}

function stub(rutas: Rutas) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "https://api.test/v1/restaurantes/prop-1/admin/voz/config") {
      if (method === "PUT") return res(rutas.put ? rutas.put(JSON.parse(init!.body as string)) : { status: 500 });
      return res(rutas.config ?? { status: 200, body: { config: CONFIG } });
    }
    if (url.startsWith("https://api.test/v1/restaurantes/prop-1/admin/voz/conversaciones")) return res(rutas.conversaciones ?? { status: 200, body: { conversaciones: CONVERSACIONES } });
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

async function pintar(rutas: Rutas = {}, extra: { crearAudio?: (url: string) => MuestraAudio } = {}) {
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
  it("tiene las 7 pestañas en orden y abre en Resumen", async () => {
    await pintar();
    const nombres = Array.from(rendered!.container.querySelectorAll('[role="tab"]')).map((t) => t.textContent);
    expect(nombres).toEqual(["Resumen", "Voz", "Conocimiento", "Comportamiento", "Mensaje inicial", "Herramientas", "Conversaciones"]);
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
    await pintar({ put: (body) => ({ status: 200, body: { config: { ...CONFIG, ...body, actualizadoEn: "2026-09-30T13:00:00Z" } } }) });
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
    expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({ vozId: "Puck", promptSistema: CONFIG.promptSistema, mensajeInicial: CONFIG.mensajeInicial, conocimiento: CONFIG.conocimiento });
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
  it("edita el prompt y el conocimiento y los manda en el PUT", async () => {
    await pintar({ put: (body) => ({ status: 200, body: { config: { ...CONFIG, ...body } } }) });
    await irA("Comportamiento");
    changeValue(rendered!.container.querySelector<HTMLTextAreaElement>("#voz-prompt")!, "Sé breve.");
    await irA("Conocimiento");
    changeValue(rendered!.container.querySelector<HTMLTextAreaElement>("#voz-conocimiento")!, "Cerramos los domingos.");
    click(boton("Guardar cambios")!);
    await settle();
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")!;
    expect(JSON.parse((put[1] as RequestInit).body as string)).toMatchObject({ promptSistema: "Sé breve.", conocimiento: "Cerramos los domingos." });
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
    await pintar({ config: { status: 200, body: { config: { ...CONFIG, mensajeInicial: "Hola, le atiende Arturo." } } } });
    const pasos = Array.from(rendered!.container.querySelectorAll("[data-ok]")).map((li) => li.getAttribute("data-ok"));
    expect(pasos).toEqual(["true", "true", "false"]);
  });
});

describe("Herramientas (contador real o estado honesto)", () => {
  it("cuenta ejecuciones reales de las conversaciones del servicio", async () => {
    await pintar();
    await irA("Herramientas");
    const ej = (n: string) => rendered!.container.querySelector(`[data-testid="ejecuciones-${n}"]`)!.textContent!;
    expect(ej("buscar_producto")).toContain("2 ejecuciones");
    expect(ej("buscar_producto")).toContain("últimas 2 llamadas");
    expect(ej("cotizar_pedido")).toContain("1 ejecución");
    expect(ej("crear_pedido")).toContain("1 ejecución");
    expect(ej("buscar_cliente")).toContain("Sin ejecuciones en las últimas 2 llamadas");
    expect(rendered!.container.querySelectorAll("[data-herramienta]")).toHaveLength(5);
    expect(rendered!.container.querySelector('[data-testid="motivo-sin-ejecuciones"]')).toBeNull();
  });

  it("sin historial disponible no muestra ningún '0 ejecuciones': dice que no hay datos y por qué", async () => {
    await pintar({ conversaciones: { status: 404 } });
    await irA("Herramientas");
    expect(texto()).not.toMatch(/0 ejecuciones/);
    for (const h of rendered!.container.querySelectorAll('[data-testid^="ejecuciones-"]')) expect(h.textContent).toBe("Sin datos de ejecuciones");
    expect(rendered!.container.querySelector('[data-testid="motivo-sin-ejecuciones"]')!.textContent).toContain("todavía no está disponible");
  });

  it("si el servicio no reporta herramientas por llamada, lo dice en vez de contar cero", async () => {
    const sinHerr = CONVERSACIONES.map(({ herramientas: _h, ...c }) => c);
    await pintar({ conversaciones: { status: 200, body: { conversaciones: sinHerr } } });
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
    expect(fila1).toContain("Pedido");
    const fila2 = rendered!.container.querySelector('[data-conversacion="c2"]')!.textContent!;
    expect(fila2).toContain("0:30");
    expect(fila2).toContain("—"); // sin costo: nunca un 0 inventado
    expect(fila2).toContain("Sin clasificar");

    click(boton("Ver transcripción")!);
    expect(texto()).toContain("Quiero dos de pastor");
    expect(texto()).toContain("Hola, asistente virtual de Los Taquitos".slice(0, 6));
    click(boton("Volver a la lista")!);
    expect(rendered!.container.querySelector('[data-conversacion="c1"]')).not.toBeNull();
  });

  it("una conversación sin transcripción lo dice", async () => {
    await pintar();
    await irA("Conversaciones");
    const botones = Array.from(rendered!.container.querySelectorAll<HTMLButtonElement>("button")).filter((b) => b.textContent === "Ver transcripción");
    click(botones[1]!);
    expect(texto()).toContain("Esta conversación no incluye transcripción.");
  });

  it("lista vacía: estado vacío honesto", async () => {
    await pintar({ conversaciones: { status: 200, body: { conversaciones: [] } } });
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

describe("vista previa (demostración)", () => {
  it("abre la pantalla de llamada etiquetada como simulación, usa el primer mensaje configurado y cuelga al cerrar", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      await pintar();
      click(boton("Vista previa")!);
      expect(rendered!.container.querySelector('[data-testid="aviso-simulacion"]')!.textContent).toContain("Es una simulación");
      expect(texto()).toContain("Simulación");
      expect(rendered!.container.querySelector('[data-testid="chip-estado"]')!.textContent).toBe("Vista previa");

      click(boton("Iniciar llamada de prueba")!);
      expect(rendered!.container.querySelector('[data-testid="chip-estado"]')!.textContent).toBe("Conectando…");
      for (let i = 0; i < 40; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });
      }
      expect(texto()).toContain("Hola, le atiende el asistente virtual de Los Taquitos.");
      expect(rendered!.container.querySelector(".voz-orbe")!.getAttribute("data-modo")).not.toBe("reposo");

      click(boton("Atrás")!);
      expect(rendered!.container.querySelector('[data-testid="chip-estado"]')).toBeNull();
      expect(rendered!.container.querySelector('[role="tablist"]')).not.toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
