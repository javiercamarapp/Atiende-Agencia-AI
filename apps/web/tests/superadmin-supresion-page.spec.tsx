// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminSupresionPage } from "../src/superadmin/pages/Supresion.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const LISTA = {
  disponible: true,
  total: 4,
  porMotivo: [{ clave: "baja", total: 3 }, { clave: "no_contactar", total: 1 }],
  porOrigen: [{ clave: "whatsapp.citas", total: 3 }, { clave: "superadmin", total: 1 }],
  grupos: [
    { tipo: "telefono", motivo: "baja", origen: "whatsapp.citas", total: 3, ultimoEnMs: 1_760_000_000_000 },
    { tipo: "telefono", motivo: "no_contactar", origen: "superadmin", total: 1, ultimoEnMs: null },
  ],
};

describe("SuperAdminSupresionPage", () => {
  it("muestra conteos por motivo y origen, sin valores", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(LISTA)));
    rendered = renderComponent(<SuperAdminSupresionPage apiBaseUrl="https://api.test" token="tok" />);
    expect(rendered.container.textContent).toContain("Cargando");
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Contactos suprimidos");
    expect(t).toContain("Baja (BAJA / STOP)");
    expect(t).toContain("whatsapp.citas");
    expect(t).toContain("Agregar no contactar");
  });

  it("lista vacia: estado vacio honesto", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...LISTA, total: 0, porMotivo: [], porOrigen: [], grupos: [] })));
    rendered = renderComponent(<SuperAdminSupresionPage apiBaseUrl="https://api.test" token="tok" />);
    await esperar();
    expect(rendered.container.textContent).toContain("Todavía no hay contactos suprimidos");
  });

  it("base sin migrar: aviso 'no disponible' y SIN boton de agregar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ disponible: false, mensaje: "Falta la migración.", total: 0, porMotivo: [], porOrigen: [], grupos: [] })));
    rendered = renderComponent(<SuperAdminSupresionPage apiBaseUrl="https://api.test" token="tok" />);
    await esperar();
    expect(rendered.container.textContent).toContain("Todavía no disponible en esta base");
    expect(rendered.container.textContent).not.toContain("Agregar no contactar");
  });

  it("error de red: estado de error, no se queda en 'Cargando'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    rendered = renderComponent(<SuperAdminSupresionPage apiBaseUrl="https://api.test" token="tok" />);
    await esperar();
    expect(rendered.container.textContent).toContain("No se pudo cargar la lista de supresión");
  });

  it("agregar: valor vacio no llama al backend; con valor arma el POST y recarga; Cancelar no ejecuta", async () => {
    let enviado: unknown = null;
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        enviado = JSON.parse(String(init.body));
        return json({ registrada: true, yaExistia: false });
      }
      return json(LISTA);
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<SuperAdminSupresionPage apiBaseUrl="https://api.test" token="tok" />);
    await esperar();

    const abrir = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Agregar no contactar"))!;
    click(abrir);
    const form = document.body.querySelector("#form-no-contactar") as HTMLFormElement;
    await submitForm(form);
    expect(document.body.textContent).toContain("Escribe el teléfono o el correo");
    expect(fetchMock.mock.calls.every((c: unknown[]) => (c[1] as RequestInit | undefined)?.method !== "POST")).toBe(true);

    const cancelar = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Cancelar")!;
    click(cancelar);
    await esperar();
    expect(enviado).toBeNull();

    click(abrir);
    changeValue(document.body.querySelector("#no-contactar-valor") as HTMLInputElement, "55 1234 5678");
    await submitForm(document.body.querySelector("#form-no-contactar") as HTMLFormElement);
    await esperar();
    expect(enviado).toEqual({ tipo: "telefono", valor: "55 1234 5678" });
    expect(rendered.container.textContent).toContain("ya no recibirá avisos proactivos");
  });
});
