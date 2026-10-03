// @vitest-environment jsdom
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminTaxonomiaPage, claveDe } from "../src/superadmin/pages/Taxonomia.tsx";
import { click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as unknown as Response;
const montar = () => renderComponent(<MemoryRouter><SuperAdminTaxonomiaPage apiBaseUrl="https://api.test" token="tok" /></MemoryRouter>);

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const VIGENTE = {
  vertical: "restaurantes", version: 2, vigente: true, estadoValidacion: "propuesta", planNombre: null,
  precio: { estado: "por_definir", texto: "Precio por definir" },
  subtipos: [{ clave: "taqueria", nombre: "Taquería" }],
  rangosTamano: { unidad: "empleados", rangos: [{ clave: "1_5", etiqueta: "1 a 5" }] },
  senales: [{ tipo: "sin_menu_en_linea", nombre: "Sin menú en línea", dimension: "ajuste", puntos: 30, comoConseguirla: "Revisar su sitio." }],
  icp: { descripcion: "Restaurantes independientes.", subtiposObjetivo: ["taqueria"], tamanosObjetivo: ["1_5"] },
  objeciones: [{ objecion: "Ya uso WhatsApp", respuesta: "Se integra." }],
  mensajesBase: [{ canal: "correo", variante: "A", texto: "Hola, platiquemos." }],
};
const DATOS = { disponible: true, verticales: ["restaurantes"], versiones: [VIGENTE] };

describe("Taxonomia por vertical", () => {
  it("muestra la version vigente marcada como propuesta y 'precio por definir' (nunca inventado)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => (u.includes("/planes") ? json({ planes: [] }) : json(DATOS))));
    rendered = montar();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Propuesta, validar con Javier");
    expect(t).toContain("Precio por definir");
    expect(t).toContain("Sin menú en línea");
    expect(t).toContain("Editar (versión nueva)");
  });

  it("base sin migrar: aviso 'no disponible' y SIN boton de editar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ disponible: false, mensaje: "Falta la migración.", verticales: [], versiones: [] })));
    rendered = montar();
    await esperar();
    expect(rendered.container.textContent).toContain("Todavía no disponible");
    expect(rendered.container.textContent).not.toContain("Editar (versión nueva)");
  });

  it("guardar sin step-up: el error del backend se muestra y no se anuncia exito", async () => {
    const fetchMock = vi.fn(async (u: string, init?: RequestInit) => {
      if (init?.method === "PUT") return json({ error: "Se requiere verificación adicional (step-up)." }, false, 403);
      return u.includes("/planes") ? json({ planes: [] }) : json(DATOS);
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = montar();
    await esperar();
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Editar (versión nueva)"))!);
    await esperar();
    const form = document.body.querySelector("form") as HTMLFormElement;
    await submitForm(form);
    await esperar();
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "PUT")).toBe(true);
    expect(document.body.textContent).not.toContain("se creó una versión nueva");
    expect(document.body.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("claveDe normaliza acentos y simbolos", () => {
    expect(claveDe("Menú en línea")).toBe("menu_en_linea");
  });
});
