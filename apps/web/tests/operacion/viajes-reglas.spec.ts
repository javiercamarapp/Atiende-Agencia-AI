import { describe, expect, it } from "vitest";
import { alternarSeleccion, choferInicial, depurarSeleccion, etiquetaChofer, MAX_LOTE, textoBotonSalio } from "../../src/verticals/restaurantes/lib/viajes.ts";
import { MAX_PEDIDOS_POR_VIAJE } from "@atiende/domain-restaurantes/operacion";

const chofer = (id: string, extra = {}) => ({ id, nombre: id, activos: 0, disponible: true, sugerido: false, ...extra });

describe("reglas de Viajes", () => {
  it("el lote coincide con el contrato y topa en 6", () => {
    expect(MAX_LOTE).toBe(MAX_PEDIDOS_POR_VIAJE);
    let sel: readonly string[] = [];
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) sel = alternarSeleccion(sel, id);
    expect(sel).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(alternarSeleccion(sel, "c")).toEqual(["a", "b", "d", "e", "f"]);
  });
  it("depura lo que ya no esta por salir sin cambiar la referencia si nada cambia", () => {
    const sel = ["a", "b"];
    expect(depurarSeleccion(sel, ["a", "b", "z"])).toBe(sel);
    expect(depurarSeleccion(sel, ["b"])).toEqual(["b"]);
  });
  it("chofer inicial: sugerido y disponible, luego primero disponible, luego nadie", () => {
    expect(choferInicial([chofer("x"), chofer("y", { sugerido: true })])).toBe("y");
    expect(choferInicial([chofer("x", { disponible: false }), chofer("y")])).toBe("y");
    expect(choferInicial([chofer("x", { disponible: false })])).toBeNull();
    expect(choferInicial([])).toBeNull();
  });
  it("etiquetas", () => {
    expect(etiquetaChofer(chofer("Luis", { activos: 2, sugerido: true }))).toBe("Luis (2 activos) · sugerido");
    expect(etiquetaChofer(chofer("Pedro", { activos: 1, disponible: false }))).toContain("fuera de turno");
    expect(textoBotonSalio(1)).toBe("Salió (1 pedido)");
    expect(textoBotonSalio(3)).toBe("Salió (3 pedidos)");
  });
});
