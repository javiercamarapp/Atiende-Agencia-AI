// @vitest-environment jsdom
//
// <PlantillasWhatsappSeccion /> (citas): estados de carga/error/base sin migrar, alta y edicion contra la API real (PUT), "Cancelar" que NUNCA
// guarda, quitar con confirmacion (DELETE) y errores del servidor visibles. Cada control llama a un endpoint real; lo que no se puede (base sin
// migrar) se oculta con un estado honesto.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlantillasWhatsappSeccion } from "../src/verticals/citas/pages/PlantillasWhatsapp.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const json = (body: unknown, ok = true, status = ok ? 200 : 500): Response => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

async function esperar() {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

const PLANTILLA = { evento: "appointment.reminder_24h", nombre: "recordatorio_cita_24h", idioma: "es_MX", variables: ["nombre", "hora"], estado: "aprobada", aprobadaEn: null, actualizadaEn: "2026-09-01T00:00:00.000Z" };
const EVENTOS = (conPlantilla: boolean) => [
  { evento: "appointment.reminder_24h", etiqueta: "Recordatorio de cita (24 horas antes)", variables: ["nombre", "negocio", "servicio", "profesional", "fecha", "hora", "fecha_hora"], plantilla: conPlantilla ? PLANTILLA : null },
  { evento: "waitlist.slot_offered", etiqueta: "Oferta de un espacio liberado a la lista de espera", variables: ["nombre", "negocio"], plantilla: null },
];

interface Estado {
  disponible?: boolean;
  conPlantilla?: boolean;
  put?: (body: Record<string, unknown>) => Response;
  get?: () => Response;
}
function stub(e: Estado = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const metodo = init?.method ?? "GET";
    if (metodo === "PUT") return e.put ? e.put(JSON.parse(String(init?.body))) : json({ disponible: true, plantilla: PLANTILLA });
    if (metodo === "DELETE") return json({ ok: true });
    if (e.get) return e.get();
    return json({ disponible: e.disponible ?? true, estados: ["borrador", "enviada", "aprobada", "rechazada"], eventos: EVENTOS(e.conPlantilla ?? false) });
  });
  vi.stubGlobal("fetch", fetchMock);
}

const props = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1" };
const boton = (texto: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === texto) as HTMLButtonElement | undefined;
const llamadas = (metodo: string) => fetchMock.mock.calls.filter((c) => ((c[1] as RequestInit | undefined)?.method ?? "GET") === metodo);

describe("PlantillasWhatsappSeccion (citas)", () => {
  it("lista los eventos: el que tiene plantilla muestra nombre, idioma, variables y estado; el otro dice que no sale por WhatsApp", async () => {
    stub({ conPlantilla: true });
    rendered = renderComponent(<PlantillasWhatsappSeccion {...props} />);
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Plantillas de WhatsApp");
    expect(texto).toContain("recordatorio_cita_24h");
    expect(texto).toContain("es_MX");
    expect(texto).toContain("variables: nombre, hora");
    expect(texto).toContain("Aprobada");
    expect(texto).toContain("Sin plantilla");
    expect(texto).toContain("este aviso no sale por WhatsApp");
  });

  it("base sin la migracion 0048: aviso honesto y NINGUN control de edicion (no es una maqueta)", async () => {
    stub({ disponible: false });
    rendered = renderComponent(<PlantillasWhatsappSeccion {...props} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Edición todavía no disponible");
    expect(boton("Registrar plantilla")).toBeUndefined();
    expect(boton("Editar")).toBeUndefined();
    expect(boton("Quitar")).toBeUndefined();
  });

  it("error de carga: muestra el error con reintento y no deja editar", async () => {
    stub({ get: () => json({ message: "falla" }, false, 500) });
    rendered = renderComponent(<PlantillasWhatsappSeccion {...props} />);
    await esperar();
    expect(boton("Registrar plantilla")).toBeUndefined();
    expect(rendered.container.textContent).toMatch(/falla|No se pudieron cargar/);
  });

  it("una respuesta sin el formato esperado se trata como error, nunca como lista vacia", async () => {
    stub({ get: () => json({ disponible: true, version: 0 }) });
    rendered = renderComponent(<PlantillasWhatsappSeccion {...props} />);
    await esperar();
    expect(rendered.container.textContent).toContain("formato esperado");
  });

  it("'Cancelar' cierra el formulario SIN llamar a la API de escritura", async () => {
    stub();
    rendered = renderComponent(<PlantillasWhatsappSeccion {...props} />);
    await esperar();
    click(boton("Registrar plantilla")!);
    await esperar();
    expect(document.querySelector("#citas-plantilla-whatsapp")).not.toBeNull();
    click(boton("Cancelar")!);
    await esperar();
    expect(document.querySelector("#citas-plantilla-whatsapp")).toBeNull();
    expect(llamadas("PUT")).toHaveLength(0);
    expect(llamadas("DELETE")).toHaveLength(0);
  });

  it("alta: guarda con PUT al evento correcto con nombre, idioma, variables en orden y estado, y recarga la lista", async () => {
    stub();
    rendered = renderComponent(<PlantillasWhatsappSeccion {...props} />);
    await esperar();
    click(boton("Registrar plantilla")!);
    await esperar();
    const campos = Array.from(document.querySelectorAll<HTMLInputElement>("#citas-plantilla-whatsapp input"));
    changeValue(campos[0]!, "recordatorio_cita_24h");
    changeValue(campos[2]!, "nombre, hora");
    changeValue(document.querySelector<HTMLSelectElement>("#citas-plantilla-whatsapp select")!, "aprobada");
    await submitForm(document.querySelector<HTMLFormElement>("#citas-plantilla-whatsapp")!);
    await esperar();
    const put = llamadas("PUT");
    expect(put).toHaveLength(1);
    expect(String(put[0]![0])).toBe("https://api.test/v1/citas/properties/prop-1/admin/whatsapp-plantillas/appointment.reminder_24h");
    expect(JSON.parse(String((put[0]![1] as RequestInit).body))).toEqual({ nombre: "recordatorio_cita_24h", idioma: "es_MX", variables: ["nombre", "hora"], estado: "aprobada" });
    expect(llamadas("GET").length).toBeGreaterThanOrEqual(2);
    expect(document.querySelector("#citas-plantilla-whatsapp")).toBeNull();
  });

  it("un rechazo del servidor (400) se muestra en el formulario y NO lo cierra", async () => {
    stub({ put: () => json({ message: "variables: \"doctor\" no está disponible para este evento." }, false, 400) });
    rendered = renderComponent(<PlantillasWhatsappSeccion {...props} />);
    await esperar();
    click(boton("Registrar plantilla")!);
    await esperar();
    const campos = Array.from(document.querySelectorAll<HTMLInputElement>("#citas-plantilla-whatsapp input"));
    changeValue(campos[0]!, "recordatorio_cita_24h");
    await submitForm(document.querySelector<HTMLFormElement>("#citas-plantilla-whatsapp")!);
    await esperar();
    expect(document.body.textContent).toContain("no está disponible para este evento");
    expect(document.querySelector("#citas-plantilla-whatsapp")).not.toBeNull();
  });

  it("editar precarga la plantilla; quitar pide confirmacion y solo entonces llama DELETE", async () => {
    stub({ conPlantilla: true });
    rendered = renderComponent(<PlantillasWhatsappSeccion {...props} />);
    await esperar();
    click(boton("Editar")!);
    await esperar();
    expect(Array.from(document.querySelectorAll<HTMLInputElement>("#citas-plantilla-whatsapp input"))[0]!.value).toBe("recordatorio_cita_24h");
    click(boton("Cancelar")!);
    await esperar();

    click(boton("Quitar")!);
    await esperar();
    expect(llamadas("DELETE")).toHaveLength(0); // todavia no confirmo
    click(Array.from(document.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "Quitar plantilla").pop()!);
    await esperar();
    const del = llamadas("DELETE");
    expect(del).toHaveLength(1);
    expect(String(del[0]![0])).toBe("https://api.test/v1/citas/properties/prop-1/admin/whatsapp-plantillas/appointment.reminder_24h");
  });
});
