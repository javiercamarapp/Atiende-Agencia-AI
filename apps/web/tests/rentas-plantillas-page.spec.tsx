// @vitest-environment jsdom
//
// Rn-24 / Rn-25 -- <PlantillasPage />: lista, alta con vista previa, aprobar con confirmacion (Cancelar no
// ejecuta), automatizaciones por evento, roles, base sin migrar y error de carga.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlantillasPage } from "../src/verticals/rentas/pages/Plantillas.tsx";
import type { LoginSession } from "../src/lib/auth-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}
const sesion = (rol: string): LoginSession => ({ token: "tok", refreshToken: "ref", email: "s@example.com", organizations: [{ id: "org-1", slug: "gestora-demo", nombre: "Gestora", vertical: "rentas", rol }] });
const montar = (rol: string) => renderComponent(<PlantillasPage apiBaseUrl="http://api.local" token="tok" propertyId="prop-1" setPropertyId={() => {}} properties={[]} orgSlug="gestora-demo" session={sesion(rol)} />);
const json = (body: unknown, ok = true, status = 200): Response => ({ ok, status, json: async () => body }) as unknown as Response;

const VARIABLES = [
  { nombre: "huesped", descripcion: "Nombre del huésped", ejemplo: "Ana" },
  { nombre: "propiedad", descripcion: "Nombre de la propiedad", ejemplo: "Casa Mar" },
];
const APROBADA = { id: "p-ok", evento: "pre_llegada", idioma: "es", canal: null, cuerpo: "Hola {{huesped}}, te esperamos en {{propiedad}}.", aprobadaPorTenant: true, activa: true };
const PENDIENTE = { id: "p-pend", evento: "check_out", idioma: "es", canal: "airbnb", cuerpo: "Gracias por tu estancia, {{huesped}}.", aprobadaPorTenant: false, activa: true };
const EVENTOS = [
  { evento: "pre_llegada", programada: false, activo: false, offsetHoras: -48, plantillaId: null, ancla: "check_in", offsetSugerido: -48 },
  { evento: "check_in", programada: false, activo: false, offsetHoras: 10, plantillaId: null, ancla: "check_in", offsetSugerido: 10 },
  { evento: "check_out", programada: false, activo: false, offsetHoras: 8, plantillaId: null, ancla: "check_out", offsetSugerido: 8 },
  { evento: "resena", programada: false, activo: false, offsetHoras: 24, plantillaId: null, ancla: "check_out", offsetSugerido: 24 },
];

function red(opciones: { disponible?: boolean; plantillas?: unknown[]; falla?: boolean; extra?: (url: string, init?: RequestInit) => Response | undefined } = {}) {
  const llamadas: { url: string; method: string; body: unknown }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    llamadas.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const c = opciones.extra?.(url, init);
    if (c) return c;
    if (opciones.falla) return json({ message: "Servidor caído" }, false, 500);
    if (url.endsWith("/plantillas") && (init?.method ?? "GET") === "GET") return json({ plantillas: opciones.plantillas ?? [APROBADA, PENDIENTE] });
    if (url.endsWith("/mensajes-automaticos")) return json({ disponible: opciones.disponible ?? true, eventos: EVENTOS, variables: VARIABLES, ventanaGraciaHoras: 24, offsetMin: -720, offsetMax: 720 });
    throw new Error(`url inesperada: ${init?.method ?? "GET"} ${url}`);
  });
  return { fn, llamadas, mutaciones: () => llamadas.filter((l) => l.method !== "GET") };
}

const dialogoConfirmar = () => document.body.querySelector('[role="alertdialog"]');
const botonDialogo = (texto: string) => [...dialogoConfirmar()!.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement;
const boton = (r: RenderedComponent, texto: string) => [...r.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto) as HTMLButtonElement;

describe("PlantillasPage", () => {
  it("lista las plantillas con su estado y muestra el estado honesto de envio (borradores en Aprobaciones, canal pendiente)", async () => {
    vi.stubGlobal("fetch", red().fn);
    rendered = montar("admin_gestora");
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Pre-llegada");
    expect(texto).toContain("Aprobada");
    expect(texto).toContain("Pendiente de aprobación");
    expect(texto).toContain("Aprobaciones");
    expect(texto).toContain("Rn-16 / Rn-28");
    expect(texto).toContain("Automatizaciones");
  });

  it("Aprobar plantilla pide confirmacion: Cancelar NO llama al servidor; Confirmar hace PATCH aprobadaPorTenant:true y recarga", async () => {
    const { fn, mutaciones } = red({ extra: (url, init) => (init?.method === "PATCH" ? json({ ...PENDIENTE, aprobadaPorTenant: true }) : undefined) });
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(boton(rendered, "Aprobar plantilla"));
    await esperar();
    expect(dialogoConfirmar()).not.toBeNull();
    expect(dialogoConfirmar()!.textContent).toContain("Gracias por tu estancia, Ana.");
    expect(mutaciones()).toHaveLength(0);
    await act(async () => {
      click(botonDialogo("Cancelar"));
      await flushMicrotasks();
    });
    await esperar();
    expect(mutaciones()).toHaveLength(0);

    click(boton(rendered, "Aprobar plantilla"));
    await esperar();
    await act(async () => {
      click(botonDialogo("Aprobar plantilla"));
      await flushMicrotasks();
    });
    await esperar();
    expect(mutaciones()).toEqual([{ url: "http://api.local/rentas/prop-1/plantillas/p-pend", method: "PATCH", body: { aprobadaPorTenant: true } }]);
    expect(rendered.container.textContent).toContain("Plantilla aprobada.");
  });

  it("un operador puede redactar pero NO ve 'Aprobar plantilla' ni puede cambiar las automatizaciones", async () => {
    vi.stubGlobal("fetch", red().fn);
    rendered = montar("operador:acceso_total");
    await esperar();
    expect(boton(rendered, "Nueva plantilla")).toBeDefined();
    expect(boton(rendered, "Aprobar plantilla")).toBeUndefined();
    expect(rendered.container.textContent).toContain("Solo un administrador puede cambiar las automatizaciones");
    expect(boton(rendered, "Guardar")).toBeUndefined();
  });

  it("un rol sin escritura (contador) solo lee: sin Nueva plantilla ni Editar", async () => {
    vi.stubGlobal("fetch", red().fn);
    rendered = montar("contador");
    await esperar();
    expect(boton(rendered, "Nueva plantilla")).toBeUndefined();
    expect(boton(rendered, "Editar")).toBeUndefined();
    expect(rendered.container.textContent).toContain("Pre-llegada");
  });

  it("Nueva plantilla: la vista previa usa valores de ejemplo, avisa de variables desconocidas y POST crea la plantilla", async () => {
    const { fn, mutaciones } = red({ extra: (url, init) => (init?.method === "POST" ? json({ ...PENDIENTE, id: "nueva" }, true, 201) : undefined) });
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(boton(rendered, "Nueva plantilla"));
    await esperar();
    const dialogo = document.body.querySelector('[role="dialog"]')!;
    const area = dialogo.querySelector("textarea") as HTMLTextAreaElement;
    changeValue(area, "Hola {{huesped}}, tu wifi: {{codigo_wifi}}");
    await esperar();
    expect(dialogo.textContent).toContain("Hola Ana, tu wifi: {{codigo_wifi}}");
    expect(dialogo.textContent).toContain("Variable desconocida: codigo_wifi");
    changeValue(area, "Hola {{huesped}}");
    await esperar();
    const form = dialogo.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    await esperar();
    expect(mutaciones()).toEqual([{ url: "http://api.local/rentas/prop-1/plantillas", method: "POST", body: { evento: "pre_llegada", idioma: "es", canal: null, cuerpo: "Hola {{huesped}}" } }]);
    expect(rendered.container.textContent).toContain("Plantilla creada");
  });

  it("un error del servidor al crear queda visible en el dialogo y no se cierra", async () => {
    const { fn } = red({ extra: (url, init) => (init?.method === "POST" ? json({ message: "cuerpo: se esperaba un texto de 1-4000 caracteres." }, false, 400) : undefined) });
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(boton(rendered, "Nueva plantilla"));
    await esperar();
    const dialogo = document.body.querySelector('[role="dialog"]')!;
    changeValue(dialogo.querySelector("textarea") as HTMLTextAreaElement, "x");
    await act(async () => {
      dialogo.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    await esperar();
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("se esperaba un texto");
  });

  it("Automatizaciones: sin plantilla aprobada de un evento lo explica; con una aprobada el admin la programa (PUT) y recarga", async () => {
    const { fn, mutaciones } = red({ extra: (url, init) => (init?.method === "PUT" ? json({ evento: "pre_llegada", activo: true }) : undefined) });
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    expect(rendered.container.textContent).toContain("Aprueba una plantilla de «Día de llegada (check-in)» para poder activar este envío.");
    const fila = rendered.container.querySelector('[data-evento="pre_llegada"]')!;
    const select = fila.querySelector("select") as HTMLSelectElement;
    changeValue(select, "p-ok");
    const offset = fila.querySelector('input[type="number"]') as HTMLInputElement;
    changeValue(offset, "-72");
    click(fila.querySelector('input[type="checkbox"]') as HTMLInputElement);
    await esperar();
    await act(async () => {
      click([...fila.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Guardar")!);
      await flushMicrotasks();
    });
    await esperar();
    expect(mutaciones()).toEqual([{ url: "http://api.local/rentas/prop-1/mensajes-automaticos/pre_llegada", method: "PUT", body: { activo: true, offsetHoras: -72, plantillaId: "p-ok" } }]);
    expect(rendered.container.textContent).toContain("llegarán a Aprobaciones");
  });

  it("base sin la migracion 029: Automatizaciones dice 'Aún no disponible' pero las plantillas siguen visibles", async () => {
    vi.stubGlobal("fetch", red({ disponible: false }).fn);
    rendered = montar("admin_gestora");
    await esperar();
    expect(rendered.container.textContent).toContain("Aún no disponible");
    expect(rendered.container.textContent).toContain("Pre-llegada");
  });

  it("sin plantillas muestra el estado vacio; si la carga falla muestra el error con reintento", async () => {
    vi.stubGlobal("fetch", red({ plantillas: [] }).fn);
    rendered = montar("admin_gestora");
    await esperar();
    expect(rendered.container.textContent).toContain("Sin plantillas");
    rendered.unmount();
    rendered = undefined;
    vi.stubGlobal("fetch", red({ falla: true }).fn);
    rendered = montar("admin_gestora");
    await esperar();
    expect(rendered.container.textContent).toContain("Servidor caído");
  });
});
