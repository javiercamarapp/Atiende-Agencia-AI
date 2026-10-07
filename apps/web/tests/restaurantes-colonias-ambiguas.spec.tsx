// @vitest-environment jsdom
//
// Reporte de colonias ambiguas (X42) dentro de las reglas de una sucursal: se carga bajo demanda, muestra la tabla real del API con la
// marca "revisar", y cubre carga, error (con reintento), base sin migrar y vacio.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColoniasAmbiguas } from "../src/verticals/restaurantes/pages/ColoniasAmbiguas.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const URL_REPORTE = "https://api.test/v1/restaurantes/prop-1/admin/config/colonias-ambiguas";

const FILA_AMBIGUA = {
  zoneId: "z1",
  colonia: "Temozón Norte",
  sucursalAsignada: { slug: "garcia-lavin", nombre: "García Lavín" },
  variasSucursales: false,
  kmAsignada: 1.7,
  segundaSucursal: { slug: "altabrisa", nombre: "Altabrisa" },
  segundaKm: 1.8,
  diferenciaKm: 0.1,
  origenKm: "piloto_original",
  procedencia: "chats_t7",
  revisar: true,
  motivos: ["ambigua"],
};
const FILA_CLARA = { ...FILA_AMBIGUA, zoneId: "z2", colonia: "Colonia Clara", kmAsignada: 0.4, segundaKm: 3.2, diferenciaKm: 2.8, revisar: false, motivos: [] };

async function settle() {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const boton = (texto: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(texto));

function render() {
  rendered = renderComponent(<ColoniasAmbiguas apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" />);
}

describe("colonias por revisar (UI)", () => {
  it("no pide nada hasta que se abre; al abrir pinta la tabla real con la marca 'revisar' y el resumen", async () => {
    const fetchMock = vi.fn(async () => json({ disponible: true, total: 2, paraRevisar: 1, sinAsignar: 0, ambiguas: 1, filas: [FILA_AMBIGUA, FILA_CLARA] }));
    vi.stubGlobal("fetch", fetchMock);
    render();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    click(boton("Ver colonias por revisar")!);
    await settle();
    expect(fetchMock).toHaveBeenCalledWith(URL_REPORTE, expect.objectContaining({ headers: expect.anything() }));
    const text = rendered!.container.textContent!;
    expect(text).toContain("2 colonias · 1 para revisar · 0 sin asignar · 1 ambigua");
    expect(text).toContain("Temozón Norte");
    expect(text).toContain("García Lavín");
    expect(text).toContain("1.7 km");
    expect(text).toContain("Revisar: Las dos sucursales más cercanas quedan a menos de 1 km");
    expect(text).toContain("Colonia Clara");
    expect(text).toContain("Sin alerta");
    expect(rendered!.container.querySelectorAll('[data-revisar="si"]').length).toBeGreaterThan(0);
  });

  it("base sin la migracion 056: dice 'No disponible aun' (no finge una lista vacia)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ disponible: false, total: 0, paraRevisar: 0, sinAsignar: 0, ambiguas: 0, filas: [] })));
    render();
    click(boton("Ver colonias por revisar")!);
    await settle();
    expect(rendered!.container.textContent).toContain("No disponible aún");
    expect(rendered!.container.textContent).toContain("migración 056");
  });

  it("error del API (403 de un staff acotado): mensaje en la seccion y Reintentar repite la lectura", async () => {
    let intento = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        intento += 1;
        if (intento === 1) return json({ error: { message: "El reporte de colonias abarca todas las sucursales" } }, 403);
        return json({ disponible: true, total: 1, paraRevisar: 0, sinAsignar: 0, ambiguas: 0, filas: [FILA_CLARA] });
      }),
    );
    render();
    click(boton("Ver colonias por revisar")!);
    await settle();
    expect(rendered!.container.querySelector('[role="alert"]')).not.toBeNull();
    click(boton("Reintentar")!);
    await settle();
    expect(rendered!.container.textContent).toContain("Colonia Clara");
    expect(intento).toBe(2);
  });

  it("sin colonias cargadas: estado vacio honesto", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ disponible: true, total: 0, paraRevisar: 0, sinAsignar: 0, ambiguas: 0, filas: [] })));
    render();
    click(boton("Ver colonias por revisar")!);
    await settle();
    expect(rendered!.container.textContent).toContain("Todavía no hay colonias cargadas");
  });
});
