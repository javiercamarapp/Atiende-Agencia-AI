// @vitest-environment jsdom
//
// Chat de WhatsApp de demostración (WidgetWhatsApp): botón flotante «Iniciar chat», panel estilo WhatsApp conectado al agente real en modo preview.
// Se afirma lo que ve el dueño y lo que viaja a la API: apertura/cierre, burbujas con hora (reloj fijo), pedido simulado PRUEBA con su insignia,
// errores honestos 503/429/500, reinicio (sesión nueva), cliente simulado, borrador sin guardar y la accesibilidad del registro en vivo.
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WidgetWhatsApp } from "../src/verticals/restaurantes/preview/WidgetWhatsApp.tsx";
import { formDesdeWire } from "../src/verticals/restaurantes/lib/agente-whatsapp-client.ts";
import { changeValue, click, flushMicrotasks, keydown, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";
import { elegirValor, prepararJsdomParaRadix, valorDe } from "./test-utils/seleccionar.tsx";

beforeAll(prepararJsdomParaRadix);

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
let envios: Record<string, unknown>[];

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}
async function esperar() {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const q = <T extends Element = HTMLElement>(sel: string) => document.body.querySelector(sel) as T | null;
const boton = (nombre: string) => Array.from(document.body.querySelectorAll("button")).find((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").includes(nombre));
const caja = () => q<HTMLInputElement>('input[aria-label="Mensaje de prueba"]')!;

const PEDIDO = { id: "PRUEBA-AB12", branch: "Francisco de Montejo", total: 90, status: "simulado", payment_method: "efectivo", simulado: true, items: [{ name: "Coca-Cola", quantity: 2, price: 45 }] };

function montar(responder: (cuerpo: Record<string, unknown>) => Response, props: { borrador?: boolean } = {}) {
  envios = [];
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/admin/customers")) return json({ customers: [{ id: "c1", name: "Beto", phone: "9992222222", orderCount: 3 }], nextCursor: null });
    if (u.endsWith("/preview/mensaje")) {
      const cuerpo = JSON.parse(String(init?.body)) as Record<string, unknown>;
      envios.push(cuerpo);
      return responder(cuerpo);
    }
    return json({});
  });
  rendered = renderComponent(<WidgetWhatsApp apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" nombreNegocio="Sucursal Centro" {...(props.borrador ? { borrador: formDesdeWire(null) } : {})} />);
}
async function abrir() {
  click(boton("Iniciar chat")!);
  await esperar();
}
async function escribir(texto: string) {
  await act(async () => changeValue(caja(), texto));
  await act(async () => {
    await submitForm(q<HTMLFormElement>(".wa-barra")!);
  });
  await esperar();
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  // Reloj fijo: 8-oct-2026 20:15 UTC = 14:15 en la zona del negocio (America/Mexico_City, UTC-6). Solo se congela Date: los temporizadores siguen reales.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T20:15:00.000Z"));
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("<WidgetWhatsApp />", () => {
  it("cerrado solo muestra el botón flotante verde «Iniciar chat»; al abrir, el panel (diálogo no modal) con encabezado de WhatsApp y el aviso de prueba", async () => {
    montar(() => json({ respuesta: "x", escalado: false, pedidoSimulado: null }));
    expect(boton("Iniciar chat")?.textContent).toContain("Iniciar chat");
    expect(q('[data-testid="chat-whatsapp"]')).toBeNull();
    await abrir();
    const panel = q('[role="dialog"]')!;
    expect(panel.getAttribute("aria-modal")).toBe("false");
    expect(panel.textContent).toContain("Sucursal Centro");
    expect(panel.textContent).toContain("En línea");
    expect(panel.textContent).toContain("no se crean pedidos ni se avisa a nadie");
    expect(document.activeElement).toBe(caja());
  });

  it("envía el mensaje: burbuja del cliente (derecha) y del agente (izquierda) con hora de 24 h, palomitas solo en la del cliente y pedido simulado con insignia Prueba", async () => {
    montar(() => json({ respuesta: "Listo, su pedido de prueba.", escalado: false, pedidoSimulado: PEDIDO }));
    await abrir();
    await escribir("quiero 2 cocas");
    const cliente = q(".wa-burbuja--cliente")!;
    const agente = q(".wa-burbuja--agente")!;
    expect(cliente.textContent).toContain("quiero 2 cocas");
    expect(cliente.textContent).toContain("14:15");
    expect(cliente.querySelector(".wa-palomitas")).not.toBeNull();
    expect(agente.textContent).toContain("Listo, su pedido de prueba.");
    expect(agente.querySelector(".wa-palomitas")).toBeNull();
    // «Prueba» aparece una sola vez (en el mensaje de sistema); la tarjeta compacta solo trae renglones y total.
    expect(q(".wa-sistema__pildora")?.textContent).toBe("Pedido simulado · PRUEBA-AB12 · Prueba");
    const tarjeta = q('[data-testid="tarjeta-pedido-simulado"]');
    expect(tarjeta?.textContent).toContain("$90.00");
    expect(tarjeta?.textContent).not.toContain("Prueba");
    expect(envios[0]).toMatchObject({ mensajes: [{ rol: "usuario", texto: "quiero 2 cocas" }] });
    expect(typeof envios[0]!.sesionId).toBe("string");
    expect(envios[0]!.borrador).toBeUndefined();
    expect(envios[0]!.clienteSimuladoId).toBeUndefined();
  });

  it("el historial que viaja incluye las respuestas del agente y nunca los mensajes de sistema", async () => {
    montar(() => json({ respuesta: "Hola 1", escalado: false, pedidoSimulado: PEDIDO }));
    await abrir();
    await escribir("uno");
    await escribir("dos");
    expect(envios[1]!.mensajes).toEqual([
      { rol: "usuario", texto: "uno" },
      { rol: "agente", texto: "Hola 1" },
      { rol: "usuario", texto: "dos" },
    ]);
  });

  it("mientras espera muestra «escribiendo…» (estado accesible) y bloquea el campo; el registro de la conversación es un aria-live polite", async () => {
    let soltar: (r: Response) => void = () => undefined;
    montar(() => json({}));
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/admin/customers")) return json({ customers: [], nextCursor: null });
      return new Promise<Response>((r) => {
        soltar = r;
      });
    });
    await abrir();
    const registro = q('[role="log"]')!;
    expect(registro.getAttribute("aria-live")).toBe("polite");
    await act(async () => changeValue(caja(), "hola"));
    await act(async () => {
      void submitForm(q<HTMLFormElement>(".wa-barra")!);
      await flushMicrotasks();
    });
    expect(q('[role="status"]')?.textContent).toContain("El agente está escribiendo");
    expect(q(".wa-cabecera__estado")?.textContent).toContain("escribiendo…");
    expect(caja().disabled).toBe(true);
    await act(async () => {
      soltar(json({ respuesta: "ya", escalado: false, pedidoSimulado: null }));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(q('[role="status"]')).toBeNull();
    expect(q(".wa-burbuja--agente")?.textContent).toContain("ya");
  });

  for (const [estado, mensaje] of [
    [503, "No disponible: requiere OPENROUTER_API_KEY. Sin un proveedor de IA configurado el agente no puede responder."],
    [429, "Demasiadas pruebas seguidas: espere unos minutos antes de probar de nuevo."],
    [500, "No se pudo completar la prueba del agente."],
  ] as const) {
    it(`error ${estado}: lo dice tal cual en un aviso (role=alert), conserva lo escrito y no inventa respuesta ni pedido`, async () => {
      montar(() => json({ code: "e", message: mensaje }, estado));
      await abrir();
      await escribir("hola");
      expect(q('[data-testid="error-prueba"]')?.textContent).toContain(mensaje);
      expect(q('[role="alert"]')).not.toBeNull();
      // Como el original: el fallo llega como burbuja del agente, con el detalle honesto debajo.
      expect(q('[role="alert"] .wa-burbuja--agente')).not.toBeNull();
      expect(q('[role="alert"]')?.textContent).toMatch(/Ahorita no pude procesar tu mensaje|Por ahora no puedo contestar/);
      expect(q('[data-testid="tarjeta-pedido-simulado"]')).toBeNull();
      expect(q(".wa-burbuja--cliente")).toBeNull();
      expect(caja().value).toBe("hola");
    });
  }

  it("«Reiniciar conversación» vacía el chat y usa una sesión nueva", async () => {
    montar(() => json({ respuesta: "Respuesta unica 77", escalado: false, pedidoSimulado: null }));
    await abrir();
    await escribir("hola");
    expect(document.body.textContent).toContain("Respuesta unica 77");
    const primera = envios[0]!.sesionId;
    click(boton("Reiniciar conversación")!);
    await esperar();
    expect(document.body.textContent).not.toContain("Respuesta unica 77");
    await escribir("otra vez");
    expect(envios[1]!.sesionId).not.toBe(primera);
    expect((envios[1]!.mensajes as unknown[]).length).toBe(1);
  });

  it("Simular cliente y «probar con los cambios sin guardar» viajan solo cuando se eligen; sin borrador no se ofrece la casilla", async () => {
    montar(() => json({ respuesta: "Hola Beto", escalado: false, pedidoSimulado: null }), { borrador: true });
    await abrir();
    click(boton("Opciones de prueba")!);
    await esperar();
    const select = q<HTMLButtonElement>('[role="combobox"]')!;
    elegirValor(select, "c1");
    await act(async () => click(q<HTMLInputElement>('input[type="checkbox"]')!));
    await escribir("hola");
    expect(envios[0]!.clienteSimuladoId).toBe("c1");
    expect(envios[0]!.borrador).toMatchObject({ perfil: "taqueria_pm" });
    expect(q<HTMLButtonElement>('[role="combobox"]')!.disabled).toBe(true);
  });

  it("Escape dentro de la lista de Simular cliente cierra solo la lista, no el chat", async () => {
    montar(() => json({ respuesta: "x", escalado: false, pedidoSimulado: null }), { borrador: true });
    await abrir();
    click(boton("Opciones de prueba")!);
    await esperar();
    const select = q<HTMLButtonElement>('[role="combobox"]')!;
    select.focus();
    keydown(select, "Enter");
    const lista = q('[role="listbox"]')!;
    expect(lista).not.toBeNull();
    keydown(lista, "Escape");
    expect(q('[data-testid="chat-whatsapp"]')).not.toBeNull();
  });

  it("«Reiniciar conversación» conserva el cliente simulado elegido", async () => {
    montar(() => json({ respuesta: "x", escalado: false, pedidoSimulado: null }));
    await abrir();
    click(boton("Opciones de prueba")!);
    await esperar();
    elegirValor(q<HTMLButtonElement>('[role="combobox"]')!, "c1");
    await escribir("hola");
    click(boton("Reiniciar conversación")!);
    await esperar();
    expect(valorDe(q<HTMLButtonElement>('[role="combobox"]'))).toBe("c1");
    await escribir("otra");
    expect(envios[1]!.clienteSimuladoId).toBe("c1");
  });

  it("sin borrador (página de indicadores) las opciones solo traen Simular cliente", async () => {
    montar(() => json({ respuesta: "x", escalado: false, pedidoSimulado: null }));
    await abrir();
    click(boton("Opciones de prueba")!);
    await esperar();
    expect(q('[role="combobox"]')).not.toBeNull();
    expect(q('input[type="checkbox"]')).toBeNull();
  });

  it("al llegar al tope de 40 mensajes se reinicia sola la conversación con un aviso amable y conserva lo escrito (sin esperar el 400 del servidor)", async () => {
    montar(() => json({ respuesta: "ok", escalado: false, pedidoSimulado: null }));
    await abrir();
    for (let i = 0; i < 20; i += 1) await escribir(`mensaje ${i}`);
    expect(envios.length).toBe(20);
    await act(async () => changeValue(caja(), "el mensaje 41"));
    await act(async () => {
      await submitForm(q<HTMLFormElement>(".wa-barra")!);
    });
    await esperar();
    expect(envios.length).toBe(20);
    expect(q('[data-testid="aviso-limite"]')?.textContent).toContain("límite de 40 mensajes");
    expect(q(".wa-burbuja--cliente")).toBeNull();
    expect(caja().value).toBe("el mensaje 41");
    await escribir("el mensaje 41");
    expect((envios[20]!.mensajes as unknown[]).length).toBe(1);
  });

  it("la hora de las burbujas usa la zona de la sucursal cuando existe", async () => {
    montar(() => json({ respuesta: "x", escalado: false, pedidoSimulado: null }));
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/config/zona-horaria")) return json({ zonaHoraria: "America/Tijuana" });
      if (u.includes("/admin/customers")) return json({ customers: [], nextCursor: null });
      envios.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ respuesta: "x", escalado: false, pedidoSimulado: null });
    });
    await abrir();
    await escribir("hola");
    // 20:15 UTC = 13:15 en Tijuana (UTC-7) en octubre de 2026 (con horario de verano).
    expect(q(".wa-burbuja--cliente")?.textContent).toContain("13:15");
  });

  it("Escape cierra el chat y el foco vuelve al botón flotante; «Cerrar chat» también; la conversación se conserva al reabrir", async () => {
    montar(() => json({ respuesta: "Se conserva", escalado: false, pedidoSimulado: null }));
    await abrir();
    await escribir("hola");
    keydown(caja(), "Escape");
    await esperar();
    expect(boton("Iniciar chat")).toBeDefined();
    expect(document.activeElement).toBe(boton("Iniciar chat"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 260));
    });
    expect(q('[data-testid="chat-whatsapp"]')).toBeNull();
    await abrir();
    expect(document.body.textContent).toContain("Se conserva");
    click(boton("Cerrar chat")!);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 260));
    });
    expect(q('[data-testid="chat-whatsapp"]')).toBeNull();
  });
});
