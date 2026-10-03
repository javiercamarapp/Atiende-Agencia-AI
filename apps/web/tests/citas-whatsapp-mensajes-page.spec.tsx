// @vitest-environment jsdom
//
// <WhatsappMensajesPage /> (citas): gate por rol, base sin migrar (solo lectura, no un vacio real), flujo revisar -> confirmar -> guardar
// con version, conflicto 409 y volver al default con confirmacion.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsappMensajesPage } from "../src/verticals/citas/pages/WhatsappMensajes.tsx";
import type { CitasShellContext } from "../src/verticals/citas/CitasShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const json = (body: unknown, ok = true, status = ok ? 200 : 500): Response => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const ctx = (role: string): CitasShellContext => ({ apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", orgId: "org-1", role, staffFullName: "Sam", staffEmail: "sam@example.com" }) as CitasShellContext;

async function esperar() {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

const CONFIG = {
  reminderEnabled: true, reminderText: null, reminderLeadHours: 24, confirmationEnabled: false, confirmationText: null,
  cancellationEnabled: false, cancellationText: null, rescheduleEnabled: false, rescheduleText: null, sendWindowStart: null, sendWindowEnd: null,
};
const OPCIONES = {
  mensajes: [
    { kind: "recordatorio", etiqueta: "Recordatorio de cita", variables: ["nombre", "hora"], textoPorOmision: "Hola {{nombre}}, {{hora}}" },
    { kind: "confirmacion", etiqueta: "Confirmación de cita", variables: ["nombre", "hora"], textoPorOmision: "Confirmada {{hora}}" },
    { kind: "cancelacion", etiqueta: "Cancelación de cita", variables: ["nombre"], textoPorOmision: "Cancelada" },
    { kind: "reagendado", etiqueta: "Cita reagendada", variables: ["nombre", "fecha_anterior", "hora"], textoPorOmision: "Reagendada {{hora}}" },
  ],
  porOmision: CONFIG,
  limites: { texto: 600, anticipacionMin: 1, anticipacionMax: 72 },
};

interface Estado {
  disponible?: boolean;
  version?: number;
  put?: (body: Record<string, unknown>) => Response;
  historial?: unknown[];
}
function stub(e: Estado = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const metodo = init?.method ?? "GET";
    if (url.endsWith("/whatsapp-plantillas")) return json({ disponible: e.disponible ?? true, estados: ["borrador", "enviada", "aprobada", "rechazada"], eventos: [] });
    if (url.endsWith("/opciones")) return json(OPCIONES);
    if (url.includes("/historial")) return json({ disponible: e.disponible ?? true, entradas: e.historial ?? [] });
    if (url.endsWith("/vista-previa")) {
      return json({ vistaPrevia: [{ kind: "recordatorio", activo: true, texto: "VISTA PREVIA DEL RECORDATORIO", esPorDefecto: false }], diferencias: [{ campo: "Texto del recordatorio", antes: "", despues: "Hola" }], version: e.version ?? 0 });
    }
    if (url.endsWith("/restablecer")) return json({ disponible: true, version: (e.version ?? 0) + 1, config: CONFIG, vistaPrevia: [] });
    if (metodo === "PUT") return e.put ? e.put(JSON.parse(String(init?.body))) : json({ disponible: true, version: (e.version ?? 0) + 1, config: CONFIG, vistaPrevia: [] });
    return json({ disponible: e.disponible ?? true, version: e.version ?? 0, config: CONFIG, actualizadoEn: null, vistaPrevia: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
}

const boton = (texto: string) => Array.from(rendered!.container.querySelectorAll("button")).find((b) => b.textContent?.trim() === texto) as HTMLButtonElement | undefined;

describe("WhatsappMensajesPage (citas)", () => {
  it("rol staff: no edita y no hace ninguna llamada de red", async () => {
    stub();
    rendered = renderComponent(<WhatsappMensajesPage {...ctx("staff")} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Solo los roles");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("base sin migrar: avisa que la edicion no esta disponible y deshabilita los campos y 'Revisar cambios'", async () => {
    stub({ disponible: false });
    rendered = renderComponent(<WhatsappMensajesPage {...ctx("owner")} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Edición todavía no disponible");
    expect(rendered.container.querySelector("textarea")?.hasAttribute("disabled")).toBe(true);
    expect(boton("Revisar cambios")?.disabled).toBe(true);
    // el historial no se pide si no esta disponible
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/historial"))).toBe(false);
  });

  it("owner: muestra las 4 plantillas con sus variables y la nota sobre las plantillas de Meta", async () => {
    stub();
    rendered = renderComponent(<WhatsappMensajesPage {...ctx("owner")} />);
    await esperar();
    const texto = rendered.container.textContent ?? "";
    for (const etiqueta of ["Recordatorio de cita", "Confirmación de cita", "Cancelación de cita", "Cita reagendada"]) expect(texto).toContain(etiqueta);
    expect(texto).toContain("{{fecha_anterior}}");
    expect(texto).toContain("aprobada por Meta");
    expect(rendered.container.querySelectorAll("textarea").length).toBe(4);
  });

  it("revisar -> confirmar y guardar manda la version vista y recarga lo vigente", async () => {
    const puts: Record<string, unknown>[] = [];
    stub({ version: 2, put: (b) => (puts.push(b), json({ disponible: true, version: 3, config: CONFIG, vistaPrevia: [] })) });
    rendered = renderComponent(<WhatsappMensajesPage {...ctx("owner")} />);
    await esperar();
    changeValue(rendered.container.querySelector("textarea") as HTMLTextAreaElement, "Hola {{nombre}}, es a las {{hora}}");
    click(boton("Revisar cambios")!);
    await esperar();
    expect(rendered.container.textContent).toContain("VISTA PREVIA DEL RECORDATORIO");
    expect(rendered.container.textContent).toContain("Texto del recordatorio");
    click(boton("Confirmar y guardar")!);
    await esperar();
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ reminderText: "Hola {{nombre}}, es a las {{hora}}", versionEsperada: 2 });
    expect(rendered.container.textContent).toContain("Guardado.");
    // 1 carga inicial + 1 recarga tras guardar
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/whatsapp-mensajes") && ((c[1] as RequestInit | undefined)?.method ?? "GET") === "GET").length).toBe(2);
  });

  it("un cambio en el formulario descarta la vista previa vieja (no se guarda algo que no se reviso)", async () => {
    stub();
    rendered = renderComponent(<WhatsappMensajesPage {...ctx("owner")} />);
    await esperar();
    click(boton("Revisar cambios")!);
    await esperar();
    expect(boton("Confirmar y guardar")).toBeDefined();
    changeValue(rendered.container.querySelector("textarea") as HTMLTextAreaElement, "otro {{hora}}");
    expect(boton("Confirmar y guardar")).toBeUndefined();
  });

  it("conflicto 409: muestra el aviso con 'Recargar lo vigente' y no recarga solo", async () => {
    stub({ put: () => json({ message: "La configuración cambió mientras la editabas. Recarga la página y vuelve a intentar." }, false, 409) });
    rendered = renderComponent(<WhatsappMensajesPage {...ctx("owner")} />);
    await esperar();
    click(boton("Revisar cambios")!);
    await esperar();
    click(boton("Confirmar y guardar")!);
    await esperar();
    expect(rendered.container.textContent).toContain("cambió mientras");
    expect(boton("Recargar lo vigente")).toBeDefined();
  });

  it("'Volver a los valores por defecto' solo aparece con una version guardada y pide confirmacion antes de restablecer", async () => {
    stub({ version: 0 });
    rendered = renderComponent(<WhatsappMensajesPage {...ctx("admin")} />);
    await esperar();
    expect(boton("Volver a los valores por defecto")).toBeUndefined();
    rendered.unmount();

    stub({ version: 2 });
    rendered = renderComponent(<WhatsappMensajesPage {...ctx("admin")} />);
    await esperar();
    click(boton("Volver a los valores por defecto")!);
    await esperar();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/restablecer"))).toBe(false); // todavia no confirmo
    const confirmar = Array.from(document.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "Volver a los valores por defecto").pop()!;
    click(confirmar);
    await esperar();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/restablecer"))).toBe(true);
  });

  it("'Usar esta version' del historial carga esa foto en el formulario sin guardar", async () => {
    stub({ version: 2, historial: [{ version: 1, accion: "actualizado", nuevo: { reminderText: "Texto viejo {{hora}}", reminderLeadHours: 6 }, diferencias: [{ campo: "Texto del recordatorio", antes: "", despues: "x" }], actorNombre: "Ana", creadoEn: "2026-09-30T15:00:00.000Z" }] });
    rendered = renderComponent(<WhatsappMensajesPage {...ctx("owner")} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Versión 1");
    expect(rendered.container.textContent).toContain("Ana");
    click(boton("Usar esta versión")!);
    expect((rendered.container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Texto viejo {{hora}}");
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "PUT")).toBe(false);
  });
});
