// @vitest-environment jsdom
//
// Paso «Mapea tus columnas» (importar clientes): ejemplos por columna en cada opcion, error si falta el telefono o se repite una
// columna, aviso si la columna del telefono no trae telefonos y vista previa local de los primeros renglones.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MapeoColumnasClientes } from "../src/verticals/restaurantes/components/MapeoColumnasClientes.tsx";
import type { MapeoColumnas } from "../src/verticals/restaurantes/lib/clientes-importacion.ts";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { elegirValor, etiquetasDe, prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

beforeAll(prepararJsdomParaRadix);

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

const SIN: MapeoColumnas = { telefono: null, nombre: null, direccion: null, colonia: null, notas: null };
const ENCABEZADOS = ["Nombre", "Dato", "Colonia"];
const DATOS = [
  ["Ana", "9991230001", "Centro"],
  ["Beto", "9991230002", "Itzimná"],
  ["Caro", "sin dato", "García Ginerés"],
];

function montar(mapeo: MapeoColumnas, onCambiar = vi.fn()) {
  rendered = renderComponent(<MapeoColumnasClientes encabezados={ENCABEZADOS} filasDatos={DATOS} columnas={3} mapeo={mapeo} onCambiar={onCambiar} />);
  return onCambiar;
}

describe("MapeoColumnasClientes", () => {
  it("cada opcion muestra el nombre de la columna y ejemplos reales; sin telefono pide elegirlo y no pinta vista previa", () => {
    montar(SIN);
    const raiz = rendered!.container;
    const etiquetas = etiquetasDe(raiz.querySelector("#clientes-import-telefono"));
    expect(etiquetas).toContain("Columna 2: Dato (ej. 9991230001 · 9991230002)");
    expect(etiquetas[0]).toBe("Elige la columna…");
    expect(raiz.textContent).toContain("Elige la columna del teléfono");
    expect(raiz.querySelector("[data-testid='mapeo-vista-local']")).toBeNull();
  });

  it("marca la columna repetida, avisa si el telefono no parece telefono y arma la vista previa con los campos elegidos", () => {
    montar({ ...SIN, telefono: 0, nombre: 0, colonia: 2 });
    const raiz = rendered!.container;
    expect(raiz.textContent).toContain("Esa columna ya se usa en otro dato.");
    expect(raiz.querySelector("[data-testid='mapeo-telefono-dudoso']")!.textContent).toContain("Solo 0 de 3 celdas");
    const tabla = raiz.querySelector("[data-testid='mapeo-vista-local'] table")!;
    expect([...tabla.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["Teléfono", "Nombre", "Colonia"]);
    expect(tabla.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(tabla.querySelector("tbody tr td:last-child")!.textContent).toBe("Centro");
  });

  it("con un telefono plausible no avisa; cambiar un selector devuelve el indice (o null)", () => {
    const onCambiar = montar({ ...SIN, telefono: 1 });
    const raiz = rendered!.container;
    expect(raiz.querySelector("[data-testid='mapeo-telefono-dudoso']")).toBeNull();
    elegirValor(raiz.querySelector("#clientes-import-nombre"), "0");
    expect(onCambiar).toHaveBeenLastCalledWith("nombre", 0);
    elegirValor(raiz.querySelector("#clientes-import-telefono"), "");
    expect(onCambiar).toHaveBeenLastCalledWith("telefono", null);
  });
});
