// @vitest-environment jsdom
//
// H-P3-03 -- Mensajeria > "Mensajes automaticos": fetch mockeado por ruta real contra apps/api/.../hoteles/mensajes-huesped.ts. Cubre que cada control
// llama a su endpoint (activar, horas de pre-llegada, enlace de resena, plantilla, quitar plantilla), el historial con el estado real del outbox, y los
// estados honestos (sin migracion 046, sin credencial de Meta, sin permiso).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

import { MensajeriaPage } from "../src/verticals/hoteles/pages/Mensajeria.tsx";
import { estadoDeEnvio, parsearVariables } from "../src/verticals/hoteles/lib/mensajes-huesped-client.ts";
import type { EventoConfig, HistorialMensajes, MensajesHuespedEstado } from "../src/verticals/hoteles/lib/mensajes-huesped-client.ts";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CTX: HotelesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Ana", staffEmail: "ana@example.com" };
const MH = "https://api.test/hoteles/prop-1/mensajes-huesped";
const SIN_VOZ = { whatsapp: { configurado: true, phoneNumberId: "1000", habilitado: true, actualizadoEn: null }, voz: { configurado: false, habilitado: false, secretoConfigurado: false, actualizadoEn: null } };

const VARS_BASE = ["nombre", "hotel", "llegada", "salida"];
function evento(parcial: Partial<EventoConfig> & Pick<EventoConfig, "evento" | "etiqueta">): EventoConfig {
  return { transaccional: true, variables: VARS_BASE, activo: true, horasAntes: null, resenaUrl: null, configurada: false, actualizadoEn: null, plantilla: null, ...parcial };
}
const EVENTOS: EventoConfig[] = [
  evento({ evento: "hold.aprobado", etiqueta: "Pre-reserva aprobada", plantilla: { nombre: "hotel_hold_aprobado", idioma: "es_MX", variables: ["nombre", "hotel"], estado: "aprobada", aprobadaEn: "2031-06-01T10:00:00Z", actualizadaEn: "2031-06-01T10:00:00Z" } }),
  evento({ evento: "pre_llegada", etiqueta: "Pre-llegada (antes del check-in)", transaccional: false, activo: false, variables: [...VARS_BASE, "enlace_aviso"] }),
  evento({ evento: "post_estancia", etiqueta: "Post-estancia (agradecimiento y reseña)", transaccional: false, activo: false, variables: ["nombre", "hotel", "enlace_resena"] }),
];

function estado(parcial: Partial<MensajesHuespedEstado> = {}): MensajesHuespedEstado {
  return {
    disponible: true,
    catalogoDisponible: true,
    puedeConfigurar: true,
    whatsapp: { canalConfigurado: true, canalHabilitado: true, credencialMeta: true, listo: true, aviso: null },
    ventanaGraciaHoras: 24,
    horasAntesPorOmision: 48,
    horasAntesMin: 1,
    horasAntesMax: 336,
    horaPostEstancia: 12,
    estadosPlantilla: ["borrador", "enviada", "aprobada", "rechazada"],
    eventos: EVENTOS,
    ...parcial,
  };
}

const HISTORIAL: HistorialMensajes = {
  disponible: true,
  envios: [
    { id: "h1", evento: "hold.aprobado", etiqueta: "Pre-reserva aprobada", estado: "encolado", canal: "whatsapp", motivo: null, motivoTexto: null, envio: "sent", errorClase: null, creadoEn: "2031-07-02T19:05:00Z" },
    { id: "h2", evento: "hold.aprobado", etiqueta: "Pre-reserva aprobada", estado: "no_enviado", canal: null, motivo: "sin_contacto", motivoTexto: "El huésped no dejó teléfono ni correo.", envio: null, errorClase: null, creadoEn: "2031-07-02T19:06:00Z" },
    { id: "h3", evento: "pre_llegada", etiqueta: "Pre-llegada (antes del check-in)", estado: "encolado", canal: "email", motivo: null, motivoTexto: null, envio: "dead", errorClase: "suprimido", creadoEn: "2031-07-02T19:07:00Z" },
  ],
};

function stub(opts: { estado?: MensajesHuespedEstado; historial?: HistorialMensajes } = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as unknown as Response;
    if (method === "GET" && url === "https://api.test/hoteles/prop-1/mensajeria") return json(SIN_VOZ);
    if (method === "GET" && url === "https://api.test/hoteles/prop-1/voz/estado") return json({ agente: { configurado: false, habilitado: false }, escalera: { operativa: false, escalones: [] }, precioMicroUsdPorMinuto: {}, preview: { disponible: false, motivo: "x" } });
    if (method === "GET" && url === MH) return json(opts.estado ?? estado());
    if (method === "GET" && url === `${MH}/historial?limite=30`) return json(opts.historial ?? HISTORIAL);
    if (method === "PUT" && url.startsWith(`${MH}/`)) return json({ ok: true });
    if (method === "DELETE" || (method === "PUT" && url.endsWith("/plantilla"))) return json({ ok: true });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
async function esperar() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}
const botones = (root: ParentNode) => [...root.querySelectorAll("button")];
const boton = (root: ParentNode, texto: string) => botones(root).find((b) => b.textContent?.trim() === texto) as HTMLButtonElement;
const dialogo = () => document.body.querySelector('[role="alertdialog"], [role="dialog"]') as HTMLElement | null;
const escrituras = () => fetchMock.mock.calls.filter(([, init]) => ["PUT", "POST", "DELETE"].includes((init as RequestInit | undefined)?.method ?? "GET"));
async function enviarDialogo() {
  await act(async () => {
    dialogo()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}

describe("Mensajes automaticos (Mensajeria de hoteles)", () => {
  it("lista los eventos con su plantilla y llama a GET /mensajes-huesped y /historial", async () => {
    stub();
    rendered = renderComponent(<MensajeriaPage {...CTX} />);
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Mensajes automáticos");
    expect(texto).toContain("Pre-reserva aprobada");
    expect(texto).toContain("hotel_hold_aprobado");
    expect(texto).toContain("Sin plantilla: sale por correo");
    expect(fetchMock.mock.calls.some(([u]) => u === MH)).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => u === `${MH}/historial?limite=30`)).toBe(true);
  });

  it("activar un evento manda PUT /:evento con activo y conserva las horas y el enlace", async () => {
    stub();
    rendered = renderComponent(<MensajeriaPage {...CTX} />);
    await esperar();
    const interruptor = rendered.container.querySelector('[aria-label="Pre-llegada (antes del check-in): activo"]') as HTMLElement;
    await act(async () => {
      click(interruptor);
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
    const put = escrituras().find(([u]) => u === `${MH}/pre_llegada`)!;
    expect(JSON.parse(String((put[1] as RequestInit).body))).toEqual({ activo: true, horasAntes: null, resenaUrl: null });
  });

  it("horas de pre-llegada: valida el rango y manda PUT con horasAntes", async () => {
    stub();
    rendered = renderComponent(<MensajeriaPage {...CTX} />);
    await esperar();
    await act(async () => {
      click(boton(rendered!.container, "Horas de pre-llegada"));
      await flushMicrotasks();
    });
    const campo = dialogo()!.querySelector("#mh-horas") as HTMLInputElement;
    const guardar = () => boton(dialogo()!, "Guardar");
    changeValue(campo, "400");
    expect(guardar().disabled).toBe(true);
    changeValue(campo, "24");
    expect(guardar().disabled).toBe(false);
    await enviarDialogo();
    const put = escrituras().find(([u]) => u === `${MH}/pre_llegada`)!;
    expect(JSON.parse(String((put[1] as RequestInit).body))).toEqual({ activo: false, horasAntes: 24, resenaUrl: null });
  });

  it("enlace de resena: solo https; manda PUT con resenaUrl", async () => {
    stub();
    rendered = renderComponent(<MensajeriaPage {...CTX} />);
    await esperar();
    await act(async () => {
      click(boton(rendered!.container, "Enlace de reseña"));
      await flushMicrotasks();
    });
    const campo = dialogo()!.querySelector("#mh-resena") as HTMLInputElement;
    changeValue(campo, "http://inseguro.example.com");
    expect(boton(dialogo()!, "Guardar").disabled).toBe(true);
    changeValue(campo, "https://g.page/r/ejemplo/review");
    await enviarDialogo();
    const put = escrituras().find(([u]) => u === `${MH}/post_estancia`)!;
    expect(JSON.parse(String((put[1] as RequestInit).body))).toMatchObject({ resenaUrl: "https://g.page/r/ejemplo/review" });
  });

  it("elegir plantilla: valida el nombre de Meta y manda PUT /:evento/plantilla con las variables en orden", async () => {
    stub();
    rendered = renderComponent(<MensajeriaPage {...CTX} />);
    await esperar();
    const botonesPlantilla = botones(rendered.container).filter((b) => b.textContent?.trim() === "Elegir plantilla");
    await act(async () => {
      click(botonesPlantilla[0]!);
      await flushMicrotasks();
    });
    const nombre = dialogo()!.querySelector("#mh-p-nombre") as HTMLInputElement;
    changeValue(nombre, "Nombre Con Mayusculas");
    expect(boton(dialogo()!, "Guardar plantilla").disabled).toBe(true);
    changeValue(nombre, "hotel_pre_llegada");
    changeValue(dialogo()!.querySelector("#mh-p-variables") as HTMLInputElement, "nombre, hotel llegada");
    changeValue(dialogo()!.querySelector("#mh-p-estado") as HTMLSelectElement, "aprobada");
    await enviarDialogo();
    const put = escrituras().find(([u]) => String(u).endsWith("/plantilla"))!;
    expect(String(put[0])).toBe(`${MH}/pre_llegada/plantilla`);
    expect(JSON.parse(String((put[1] as RequestInit).body))).toEqual({ nombre: "hotel_pre_llegada", idioma: "es_MX", variables: ["nombre", "hotel", "llegada"], estado: "aprobada" });
  });

  it("quitar la plantilla pide confirmacion y manda DELETE; Volver no escribe", async () => {
    stub();
    rendered = renderComponent(<MensajeriaPage {...CTX} />);
    await esperar();
    const quitar = () => boton(rendered!.container, "Quitar plantilla");
    await act(async () => {
      click(quitar());
      await flushMicrotasks();
    });
    await act(async () => {
      click(botones(document.body).find((b) => b.textContent?.trim() === "Volver")!);
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(escrituras()).toHaveLength(0);
    await act(async () => {
      click(quitar());
      await flushMicrotasks();
    });
    await act(async () => {
      click(botones(dialogo()!).find((b) => b.textContent?.trim() === "Quitar plantilla")!);
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
    const del = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")!;
    expect(String(del[0])).toBe(`${MH}/hold.aprobado/plantilla`);
  });

  it("historial: muestra el estado real del outbox y el motivo de lo que no salio", async () => {
    stub();
    rendered = renderComponent(<MensajeriaPage {...CTX} />);
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Enviado");
    expect(texto).toContain("No enviado");
    expect(texto).toContain("El huésped no dejó teléfono ni correo.");
    expect(texto).toContain("No se pudo entregar");
  });

  it("sin credencial de WhatsApp: muestra el aviso honesto y la insignia 'Solo correo'", async () => {
    stub({ estado: estado({ whatsapp: { canalConfigurado: true, canalHabilitado: true, credencialMeta: false, listo: false, aviso: "requiere credencial de WhatsApp (Meta); se enviará por correo" } }) });
    rendered = renderComponent(<MensajeriaPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("requiere credencial de WhatsApp (Meta); se enviará por correo");
    expect(rendered.container.textContent).toContain("Solo correo");
  });

  it("base sin la migracion 046: 'No disponible aun', sin tabla ni controles", async () => {
    stub({ estado: estado({ disponible: false, catalogoDisponible: false, eventos: [] }), historial: { disponible: false, envios: [] } });
    rendered = renderComponent(<MensajeriaPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("No disponible aún");
    expect(rendered.container.querySelector('[aria-label$=": activo"]')).toBeNull();
  });

  it("sin permiso de configuracion (puedeConfigurar:false): los controles quedan deshabilitados u ocultos y se explica por que", async () => {
    stub({ estado: estado({ puedeConfigurar: false }) });
    rendered = renderComponent(<MensajeriaPage {...CTX} role="gm" />);
    await esperar();
    expect(rendered.container.textContent).toContain("Solo el dueño o la gerencia pueden cambiar estos mensajes.");
    const interruptor = rendered.container.querySelector('[aria-label="Pre-reserva aprobada: activo"]') as HTMLButtonElement;
    expect(interruptor.disabled).toBe(true);
    expect(boton(rendered.container, "Elegir plantilla")).toBeUndefined();
  });

  it("un error del servidor al cargar se muestra, no se oculta", async () => {
    fetchMock = vi.fn(async (url: string) => {
      if (url === "https://api.test/hoteles/prop-1/mensajeria") return { ok: true, status: 200, json: async () => SIN_VOZ } as unknown as Response;
      if (String(url).endsWith("/voz/estado")) return { ok: true, status: 200, json: async () => ({ agente: { configurado: false, habilitado: false }, escalera: { operativa: false, escalones: [] }, precioMicroUsdPorMinuto: {}, preview: { disponible: false, motivo: "x" } }) } as unknown as Response;
      return { ok: false, status: 500, json: async () => ({ error: { message: "Fallo del servidor" } }), text: async () => "" } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<MensajeriaPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Ocurrió un problema");
  });
});

describe("helpers del cliente", () => {
  it("parsearVariables acepta comas, espacios y punto y coma", () => {
    expect(parsearVariables("nombre, hotel;llegada  salida")).toEqual(["nombre", "hotel", "llegada", "salida"]);
    expect(parsearVariables("")).toEqual([]);
  });

  it("estadoDeEnvio traduce el estado real del outbox", () => {
    expect(estadoDeEnvio({ estado: "encolado", canal: "whatsapp", envio: "sent" })).toEqual({ texto: "Enviado", tono: "success" });
    expect(estadoDeEnvio({ estado: "encolado", canal: "whatsapp", envio: "pending" }).tono).toBe("info");
    expect(estadoDeEnvio({ estado: "encolado", canal: "email", envio: "failed" }).tono).toBe("warning");
    expect(estadoDeEnvio({ estado: "encolado", canal: "email", envio: "dead" }).tono).toBe("danger");
    expect(estadoDeEnvio({ estado: "no_enviado", canal: null, envio: null })).toEqual({ texto: "No enviado", tono: "warning" });
    expect(estadoDeEnvio({ estado: "encolado", canal: "email", envio: null }).texto).toMatch(/Correo de confirmación/);
  });
});
