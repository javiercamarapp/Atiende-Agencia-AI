// @vitest-environment jsdom
//
// R-10: seccion "Agente de WhatsApp" de Configuracion. Flujo real: cargar lo vigente -> editar -> "Revisar cambios" (vista previa
// de diferencias, solo lectura) -> "Confirmar y guardar" con la version que la pantalla vio; conflicto 409; base sin la 033;
// historial; "volver al perfil por defecto".
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgenteWhatsappSeccion } from "../src/verticals/restaurantes/pages/AgenteWhatsappSeccion.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const CONFIG = { perfil: "taqueria_pm", agentName: "Lupita", businessName: null, toneStyle: "formal_directo", deliveryTimeText: "de 40 a 50 minutos", greetingText: null, salsasText: null, promosText: "lunes 2x1", escalationReasonsOff: [], version: 2 };
const OPCIONES = {
  perfiles: [
    { perfil: "generico", agentName: null, businessName: "este restaurante", toneStyle: "calido_cercano", deliveryTimeText: "40 a 50 minutos", salsasText: null, promosText: null },
    { perfil: "taqueria_pm", agentName: "el asistente virtual", businessName: "Los Taquitos de PM", toneStyle: "formal_directo", deliveryTimeText: "de 40 a 50 minutos", salsasText: "roja, verde", promosText: "lunes 2x1", largeOrderText: "más de $4,000 o más de 5 kg" },
  ],
  tonos: ["calido_cercano", "formal_directo", "profesional_neutro", "divertido_desenfadado"],
  motivosDesactivables: ["pedido_grande", "zona_ambigua", "producto_agotado", "no_entiende"],
  limites: { agentName: 60, businessName: 120, deliveryTimeText: 200, greetingText: 80, salsasText: 300, promosText: 300, largeOrderText: 200 },
  esperaRafagasMaxSegundos: 30,
};
const PREVIA = {
  prompt: "PROMPT COMPLETO",
  promptVigente: "PROMPT VIGENTE",
  diferenciasCampos: [{ campo: "Saludo", antes: "", despues: "Hola" }],
  diferenciasPrompt: [{ tipo: "igual", texto: "a" }, { tipo: "quitada", texto: "viejo" }, { tipo: "agregada", texto: "nuevo" }],
  version: 2,
};
const HISTORIAL = [
  { version: 2, accion: "actualizado", anterior: { agentName: "Lu" }, nuevo: { agentName: "Lupita", perfil: "taqueria_pm" }, actorUserId: "u1", actorNombre: "Jefa", creadoEn: "2026-10-01T12:00:00.000Z" },
  { version: 1, accion: "actualizado", anterior: null, nuevo: { agentName: "Lu", perfil: "taqueria_pm" }, actorUserId: "u9", actorNombre: null, creadoEn: "2026-09-30T12:00:00.000Z" },
];

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const botones = () => Array.from(rendered!.container.querySelectorAll("button"));
const boton = (texto: string) => botones().find((b) => b.textContent === texto);
const campo = (etiqueta: string) => {
  const label = Array.from(rendered!.container.querySelectorAll("label")).find((l) => (l.textContent ?? "").startsWith(etiqueta));
  return rendered!.container.querySelector(`#${label?.getAttribute("for")}`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
};

function montar(opts: { organizacion?: unknown; sucursal?: unknown; escritura?: (url: string, init?: RequestInit) => Response | undefined; historial?: unknown[] } = {}) {
  const organizacion = "organizacion" in opts ? opts.organizacion : CONFIG;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const r = opts.escritura?.(u, init);
    if (r) return r;
    if (u.endsWith("/staff/miembros")) return json({ miembros: [{ id: "u9", email: "m@x.com", fullName: "Marta", verticalRole: "admin", propertyIds: null }] });
    if (u.endsWith("/opciones")) return json(OPCIONES);
    if (u.includes("/historial")) return json({ entradas: opts.historial ?? HISTORIAL });
    if (u.endsWith("/vista-previa")) return json(PREVIA);
    return json({ organizacion, sucursal: opts.sucursal ?? null });
  });
  rendered = renderComponent(<AgenteWhatsappSeccion apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" />);
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

describe("AgenteWhatsappSeccion", () => {
  it("carga lo vigente en el formulario, con los valores del perfil como sugerencia, y muestra el historial", async () => {
    montar();
    await esperar();
    expect((campo("Nombre del agente") as HTMLInputElement).value).toBe("Lupita");
    expect((campo("Nombre del negocio") as HTMLInputElement).placeholder).toBe("Los Taquitos de PM");
    expect((campo("Promociones") as HTMLTextAreaElement).value).toBe("lunes 2x1");
    expect(rendered!.container.textContent).toContain("Versión 2");
    expect(rendered!.container.textContent).toContain("Cambió: Perfil, Nombre del agente");
    // el nombre del actor sale de la base cuando es uno mismo y, si no, de la lista del equipo
    expect(rendered!.container.textContent).toContain("· Jefa");
    expect(rendered!.container.textContent).toContain("· Marta");
    expect(rendered!.container.textContent).not.toContain("Edición limitada");
  });

  it("PM-C5: umbral de pedido grande y espera de ráfagas se editan, se validan y viajan en el PUT (vacío = valores por omisión / apagada)", async () => {
    let put: Record<string, unknown> | null = null;
    montar({
      organizacion: { ...CONFIG, largeOrderText: "más de $5,000", replyDebounceSeconds: 6 },
      escritura: (_u, init) => {
        if (init?.method === "PUT") {
          put = JSON.parse(String(init.body));
          return json({ ...CONFIG, largeOrderText: "más de $6,000", replyDebounceSeconds: 8, version: 3 });
        }
        return undefined;
      },
    });
    await esperar();
    const umbral = campo("Umbral de pedido grande") as HTMLTextAreaElement;
    const espera = campo("Espera de ráfagas") as HTMLInputElement;
    expect(umbral.value).toBe("más de $5,000");
    expect(umbral.placeholder).toBe("más de $4,000 o más de 5 kg");
    expect(espera.value).toBe("6");
    expect(espera.max).toBe("30");
    expect(espera.min).toBe("0");
    changeValue(umbral, "más de $6,000");
    changeValue(espera, "8");
    await esperar();
    click(boton("Revisar cambios")!);
    await esperar();
    click(boton("Confirmar y guardar")!);
    await esperar();
    expect(put).toMatchObject({ alcance: "organizacion", largeOrderText: "más de $6,000", replyDebounceSeconds: 8, versionEsperada: 2 });
  });

  it("PM-C5: con los dos campos vacíos el PUT manda null (la espera queda apagada y el umbral vuelve al de siempre)", async () => {
    let put: Record<string, unknown> | null = null;
    montar({
      organizacion: { ...CONFIG, largeOrderText: "más de $5,000", replyDebounceSeconds: 6 },
      escritura: (_u, init) => {
        if (init?.method === "PUT") {
          put = JSON.parse(String(init.body));
          return json({ ...CONFIG, version: 3 });
        }
        return undefined;
      },
    });
    await esperar();
    changeValue(campo("Umbral de pedido grande"), "");
    changeValue(campo("Espera de ráfagas"), "");
    await esperar();
    click(boton("Revisar cambios")!);
    await esperar();
    click(boton("Confirmar y guardar")!);
    await esperar();
    expect(put).toMatchObject({ largeOrderText: null, replyDebounceSeconds: null });
  });

  it("PM-C5: los campos solo existen en el perfil de la taquería (el genérico no los muestra)", async () => {
    montar({ organizacion: { ...CONFIG, perfil: "generico" } });
    await esperar();
    const etiquetas = Array.from(rendered!.container.querySelectorAll("label")).map((l) => l.textContent ?? "");
    expect(etiquetas.some((t) => t.startsWith("Umbral de pedido grande"))).toBe(false);
    expect(etiquetas.some((t) => t.startsWith("Espera de ráfagas"))).toBe(false);
  });

  it("revisar -> vista previa con diferencias y prompt de solo lectura -> confirmar manda PUT con la version vista", async () => {
    let put: { url: string; body: Record<string, unknown> } | null = null;
    montar({
      escritura: (u, init) => {
        if (init?.method === "PUT") {
          put = { url: u, body: JSON.parse(String(init.body)) };
          return json({ ...CONFIG, greetingText: "Hola", version: 3 });
        }
        return undefined;
      },
    });
    await esperar();
    changeValue(campo("Saludo"), "Hola");
    await esperar();
    expect(boton("Confirmar y guardar")).toBeUndefined(); // sin revisar no hay guardado
    click(boton("Revisar cambios")!);
    await esperar();
    const t = rendered!.container.textContent ?? "";
    expect(t).toContain("Saludo:");
    expect(t).toContain("− viejo");
    expect(t).toContain("+ nuevo");
    const prompt = rendered!.container.querySelector("textarea[aria-label='Prompt resultante']") as HTMLTextAreaElement;
    expect(prompt.value).toBe("PROMPT COMPLETO");
    expect(prompt.readOnly).toBe(true);
    const vistaPrevia = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/vista-previa"));
    expect(JSON.parse(String(vistaPrevia![1].body))).toMatchObject({ alcance: "organizacion", greetingText: "Hola" });
    expect(JSON.parse(String(vistaPrevia![1].body))).not.toHaveProperty("versionEsperada");
    click(boton("Confirmar y guardar")!);
    await esperar();
    expect(put!.body).toMatchObject({ alcance: "organizacion", greetingText: "Hola", versionEsperada: 2, agentName: "Lupita" });
    expect(rendered!.container.textContent).toContain("Guardado.");
  });

  it("editar despues de revisar descarta la vista previa (nunca se guarda algo distinto de lo revisado)", async () => {
    montar();
    await esperar();
    click(boton("Revisar cambios")!);
    await esperar();
    expect(boton("Confirmar y guardar")).toBeDefined();
    changeValue(campo("Nombre del agente"), "Otra");
    await esperar();
    expect(boton("Confirmar y guardar")).toBeUndefined();
  });

  it("409 al guardar: avisa que otra persona cambio la config y ofrece recargar lo vigente", async () => {
    montar({ escritura: (_u, init) => (init?.method === "PUT" ? json({ message: "La configuración del agente cambió mientras la editaba. Recargue y revise los cambios antes de guardar." }, 409) : undefined) });
    await esperar();
    click(boton("Revisar cambios")!);
    await esperar();
    click(boton("Confirmar y guardar")!);
    await esperar();
    expect(rendered!.container.textContent).toContain("cambió mientras la editaba");
    expect(boton("Recargar lo vigente")).toBeDefined();
  });

  it("los motivos que se pueden apagar son casillas; apagar uno viaja en escalationReasonsOff", async () => {
    montar();
    await esperar();
    const casillas = Array.from(rendered!.container.querySelectorAll("fieldset input[type='checkbox']")) as HTMLInputElement[];
    expect(casillas).toHaveLength(4);
    expect(casillas.every((c) => c.checked)).toBe(true);
    click(casillas[0]!);
    await esperar();
    click(boton("Revisar cambios")!);
    await esperar();
    const previa = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/vista-previa"));
    expect(JSON.parse(String(previa![1].body)).escalationReasonsOff).toEqual(["pedido_grande"]);
  });

  it("perfil generico oculta saludo, salsas, promociones y motivos", async () => {
    montar({ organizacion: { ...CONFIG, perfil: "generico", promosText: null } });
    await esperar();
    expect(rendered!.container.textContent).not.toContain("Salsas incluidas sin costo");
    expect(rendered!.container.querySelector("fieldset")).toBeNull();
  });

  it("base sin la 033 (version null): aviso de edicion limitada, sin historial y se guarda sin versionEsperada", async () => {
    let put: Record<string, unknown> | null = null;
    montar({
      organizacion: { ...CONFIG, version: null },
      escritura: (_u, init) => {
        if (init?.method === "PUT") {
          put = JSON.parse(String(init.body));
          return json({ ...CONFIG, version: null });
        }
        return undefined;
      },
    });
    await esperar();
    expect(rendered!.container.textContent).toContain("Edición limitada");
    expect(rendered!.container.textContent).not.toContain("Historial");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/historial"))).toBe(false);
    changeValue(campo("Nombre del agente"), "Lupe");
    await esperar();
    click(boton("Revisar cambios")!);
    await esperar();
    click(boton("Confirmar y guardar")!);
    await esperar();
    expect(put).not.toHaveProperty("versionEsperada");
  });

  it("'Usar esta versión' carga la foto del historial en el formulario sin guardar nada", async () => {
    montar();
    await esperar();
    changeValue(campo("Nombre del agente"), "Temporal");
    await esperar();
    click(boton("Usar esta versión")!);
    await esperar();
    expect((campo("Nombre del agente") as HTMLInputElement).value).toBe("Lupita");
    expect(rendered!.container.textContent).toContain("Se cargó la versión 2");
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "PUT")).toBe(false);
  });

  it("sin configuracion propia no se ofrece 'Volver al perfil por defecto'; con ella si, y pide confirmacion antes de restablecer", async () => {
    montar({ organizacion: null, historial: [] });
    await esperar();
    expect(boton("Volver al perfil por defecto")).toBeUndefined();
    rendered!.unmount();
    let post: { url: string; body: Record<string, unknown> } | null = null;
    montar({
      escritura: (u, init) => {
        if (u.endsWith("/restablecer")) {
          post = { url: u, body: JSON.parse(String(init!.body)) };
          return json({ ...CONFIG, agentName: null, version: 3 });
        }
        return undefined;
      },
    });
    await esperar();
    click(boton("Volver al perfil por defecto")!);
    await esperar();
    expect(post).toBeNull(); // todavia no: falta confirmar
    const confirmar = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Volver al perfil por defecto" && b.closest("[role='alertdialog']"));
    expect(confirmar).toBeDefined();
    click(confirmar!);
    await esperar();
    expect(post!.body).toEqual({ alcance: "organizacion", versionEsperada: 2 });
  });

  it("falla de carga: error con reintento, no una pantalla vacia", async () => {
    fetchMock.mockResolvedValue(json({ message: "boom" }, 500));
    rendered = renderComponent(<AgenteWhatsappSeccion apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" />);
    await esperar();
    expect(rendered.container.textContent).toContain("boom");
    expect(boton("Revisar cambios")).toBeUndefined();
  });
});
