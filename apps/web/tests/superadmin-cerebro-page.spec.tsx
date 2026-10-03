// @vitest-environment jsdom
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminProspectosPage } from "../src/superadmin/pages/Prospectos.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body }) as unknown as Response;
const montar = () => renderComponent(<MemoryRouter><SuperAdminProspectosPage apiBaseUrl="https://api.test" token="tok" /></MemoryRouter>);

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const EXPLICACION = {
  version: "reglas-v1",
  dimensiones: {
    ajuste: { puntaje: 40, items: [{ regla: "Subtipo objetivo", puntos: 40, evidencia: { fuente: "sitio oficial", fecha: "2026-09-01" } }] },
    urgencia: { puntaje: null, items: [] },
    cierre: { puntaje: 10, items: [{ regla: "Pidio demo", puntos: 10, evidencia: { fuente: "formulario", fecha: "2026-09-02" } }] },
    completitud: { puntaje: 20, items: [] },
  },
  insuficiente: { mensaje: "SENAL INSUFICIENTE: falta urgencia, como conseguirlo: revisar reseñas recientes." },
};

const PROSPECTO = {
  id: "11111111-1111-4111-8111-111111111111",
  empresa: "Hotel Sol", vertical: "hoteles", ciudad: "Mérida", contactoNombre: null, telefono: null, correo: null,
  estado: "nuevo", fuente: "referido", notas: null, updatedAt: "2026-09-30T10:00:00.000Z",
  senales: [], baseLicitud: null, scoreAjuste: 40, scoreUrgencia: null, scoreCierre: 10, scoreCompletitud: 20,
  scoreExplicacion: EXPLICACION, scoreVersion: "reglas-v1", contactoLegado: false,
};
const LISTA = { disponible: true, prospectos: [PROSPECTO], taxonomias: [] };

describe("Cerebro de ventas (Prospectos)", () => {
  it("detalle desplegable: barras por dimension, 'por que' con fuente y SENAL INSUFICIENTE", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => (u.endsWith("/detalle") ? json({ disponible: true, personas: [], eventos: [] }) : json(LISTA))));
    rendered = montar();
    await esperar();
    expect(rendered.container.textContent).toContain("Cerebro de ventas");
    click(rendered.container.querySelector('button[aria-label^="Ver el detalle"]')!);
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Señal insuficiente");
    expect(t).toContain("SENAL INSUFICIENTE: falta urgencia");
    expect(t).toContain("Subtipo objetivo");
    expect(t).toContain("fuente: sitio oficial, 2026-09-01");
    expect(rendered.container.querySelectorAll('[data-testid^="score-"]').length).toBe(4);
    expect(t).toContain("Personas de contacto");
  });

  it("base sin migrar: aviso honesto, sin boton de taxonomia ni columna de score", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ disponible: false, mensaje: "Falta la migración.", prospectos: [{ ...PROSPECTO, scoreVersion: undefined }], taxonomias: [] })));
    rendered = montar();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("no disponible aún");
    expect(t).not.toContain("Taxonomía por vertical");
    expect(t).not.toContain("Sin calificar");
    expect(rendered.container.querySelector('button[aria-label^="Ver el detalle"]')).toBeNull();
  });

  it("error de red: estado de error, no se queda cargando", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    rendered = montar();
    await esperar();
    expect(rendered.container.textContent).toContain("No se pudieron cargar los prospectos");
  });

  it("alta con datos de contacto exige base de licitud y no llama al backend sin ella", async () => {
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => (init?.method === "POST" ? json({ prospecto: PROSPECTO }) : json({ ...LISTA, prospectos: [] })));
    vi.stubGlobal("fetch", fetchMock);
    rendered = montar();
    await esperar();
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Nuevo prospecto"))!);
    const form = document.body.querySelector("#form-prospecto") as HTMLFormElement;
    const inputs = [...form.querySelectorAll("input")];
    changeValue(inputs[0] as HTMLInputElement, "Hotel Luna");
    const tel = [...form.querySelectorAll("label")].find((l) => l.textContent?.startsWith("Teléfono"));
    changeValue(form.querySelector(`#${tel?.getAttribute("for")}`) as HTMLInputElement, "9991234567");
    await submitForm(form);
    expect(document.body.textContent).toContain("La base de licitud es obligatoria");
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false);
  });
});
