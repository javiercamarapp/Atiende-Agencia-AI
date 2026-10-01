// @vitest-environment jsdom
//
// Smoke test real de <PrimerosPasosPage /> (citas, C-06): estado del servidor, progreso, enlaces, panel "listo",
// descartar/posponer, gate por rol y error honesto.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrimerosPasosPage } from "../src/verticals/citas/pages/PrimerosPasos.tsx";
import type { CitasShellContext } from "../src/verticals/citas/CitasShell.tsx";
import { installMemoryLocalStorage } from "./test-utils/memory-storage.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

beforeEach(() => {
  installMemoryLocalStorage();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX = { apiBaseUrl: "https://api.test", token: "tok-123", propertyId: "prop-1", orgSlug: "demo", orgId: "org-1", role: "owner", staffFullName: "Sam", staffEmail: "sam@example.com" } as CitasShellContext;

const paso = (id: string, titulo: string, estado: string, requerido: boolean, ruta: string, detalle: string | null = null) => ({ id, titulo, descripcion: `Descripción de ${titulo}`, estado, requeridoParaPublicar: requerido, detalle, ruta });

const INCOMPLETO = {
  propertyId: "prop-1",
  pasos: [
    paso("proveedor", "Crea al menos un profesional", "completo", true, "proveedores", "1 proveedor activo"),
    paso("servicio", "Crea un servicio con su duración", "completo", true, "servicios"),
    paso("asignacion", "Asigna un servicio a un profesional", "pendiente", true, "proveedores"),
    paso("horario", "Define el horario semanal", "pendiente", true, "disponibilidad"),
    paso("precio", "Ponle precio a tus servicios", "pendiente", false, "servicios", "1 servicio sin precio"),
    paso("whatsapp", "Conecta tu número de WhatsApp", "pendiente", false, "mensajes-whatsapp"),
    paso("cancelacion", "Avisa al cliente cuando se cancela una cita", "no_disponible", false, "mensajes-whatsapp"),
  ],
  completados: 2,
  total: 7,
  progresoPct: 29,
  faltanParaPublicar: ["asignacion", "horario"],
  listoParaRecibirCitas: false,
};

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

function stubFetch(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({ ok, status, json: async () => body }) as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function render(ctx: CitasShellContext = CTX) {
  return renderComponent(
    <MemoryRouter>
      <PrimerosPasosPage {...ctx} />
    </MemoryRouter>,
  );
}

function boton(texto: string, dentroDe?: Element | null): HTMLButtonElement {
  const raiz = dentroDe ?? rendered!.container;
  const b = [...raiz.querySelectorAll("button")].find((x) => x.textContent?.includes(texto));
  if (!b) throw new Error(`sin botón "${texto}"`);
  return b as HTMLButtonElement;
}

describe("PrimerosPasosPage (citas)", () => {
  it("pinta lo que dice el servidor: progreso, panel cerrado con lo que falta y enlaces directos", async () => {
    const fetchMock = stubFetch(INCOMPLETO);
    rendered = render();
    await esperar();

    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://api.test/v1/citas/properties/prop-1/onboarding");
    const c = rendered.container;
    const text = c.textContent ?? "";
    expect(text).toContain("Aún no estás listo para recibir citas en línea");
    expect(text).toContain("2 de 7 pasos");
    expect(text).toContain("1 servicio sin precio");
    expect(text).toContain("No disponible aún");
    const barra = c.querySelector("progress")!;
    expect(barra.getAttribute("value")).toBe("29");
    expect(c.querySelector('a[href="/citas/demo/disponibilidad"]')).not.toBeNull();
    expect(c.querySelector('a[href="/citas/demo/servicios"]')).not.toBeNull();
    // El paso no disponible no ofrece enlace a una pantalla que no puede resolverlo.
    expect(c.querySelector('[data-paso="cancelacion"] a')).toBeNull();
  });

  it("negocio listo: panel verde 'Listo para recibir citas'", async () => {
    stubFetch({ ...INCOMPLETO, pasos: INCOMPLETO.pasos.map((p) => ({ ...p, estado: "completo" })), completados: 7, progresoPct: 100, faltanParaPublicar: [], listoParaRecibirCitas: true });
    rendered = render();
    await esperar();
    const text = rendered.container.textContent ?? "";
    expect(text).toContain("Listo para recibir citas");
    expect(text).not.toContain("Aún no estás listo");
  });

  it("los pasos requeridos no se pueden descartar ni posponer", async () => {
    stubFetch(INCOMPLETO);
    rendered = render();
    await esperar();
    const requerido = rendered.container.querySelector('[data-paso="horario"]')!;
    expect(requerido.textContent).not.toContain("Descartar");
    expect(requerido.textContent).not.toContain("Posponer");
    expect(requerido.textContent).toContain("Requerido");
  });

  it("descartar y posponer ocultan el paso, lo recuerdan al recargar y se pueden revertir", async () => {
    stubFetch(INCOMPLETO);
    rendered = render();
    await esperar();
    const c = rendered.container;

    await act(async () => boton("Descartar", c.querySelector('[data-paso="precio"]')).click());
    await act(async () => boton("Posponer", c.querySelector('[data-paso="whatsapp"]')).click());
    expect(c.querySelector('[data-paso="precio"]')).toBeNull();
    expect(c.querySelector('[data-paso="whatsapp"]')).toBeNull();
    expect(c.textContent).toContain("Pasos ocultos (2)");
    // La barra sigue mostrando el estado REAL del negocio, no el filtrado.
    expect(c.textContent).toContain("2 de 7 pasos");

    rendered.unmount();
    rendered = render();
    await esperar();
    expect(rendered.container.querySelector('[data-paso="precio"]')).toBeNull();
    expect(rendered.container.textContent).toContain("Pasos ocultos (2)");

    await act(async () => boton("Volver a mostrar", rendered!.container).click());
    expect(rendered.container.textContent).toContain("Pasos ocultos (1)");
    expect(rendered.container.querySelector('[data-paso="precio"]')).not.toBeNull();
  });

  it("rol staff: no consulta al servidor y explica por que", async () => {
    const fetchMock = stubFetch(INCOMPLETO);
    rendered = render({ ...CTX, role: "staff" });
    await esperar();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("Solo los roles");
    expect(rendered.container.querySelector("progress")).toBeNull();
  });

  it("si la carga falla muestra el error y ninguna cifra inventada", async () => {
    stubFetch({ message: "Error interno" }, false, 500);
    rendered = render();
    await esperar();
    const text = rendered.container.textContent ?? "";
    expect(text).toContain("No se pudo cargar");
    expect(text).not.toMatch(/\d+ de \d+ pasos/);
    expect(text).not.toContain("Listo para recibir citas");
    expect(rendered.container.querySelector("progress")).toBeNull();
  });
});
