// Latencia de voz PM (E2E r3): lecturas que el worker precarga antes de la primera vuelta del modelo. Primer turno: cliente y sucursal (el modelo las pedia casi
// siempre: ~1.8 por llamada). Cada turno que nombra productos: buscar_producto por producto (hasta 3). Un «sí» o un nombre propio solo no precargan nada.
import { describe, expect, it } from "vitest";
import { precargaVozPm } from "../src/llamada.ts";

describe("precarga de lecturas de voz PM", () => {
  it("primer turno con pedido: cliente, sucursal y un buscar_producto por producto", () => {
    const p = precargaVozPm("Buenas tardes, quiero tres tacos de pastor y una coca cola para recoger", 1, "garcia-lavin");
    expect(p.map((x) => x.nombre)).toEqual(expect.arrayContaining(["buscar_cliente", "consultar_sucursal", "buscar_producto"]));
    expect(p.find((x) => x.nombre === "consultar_sucursal")?.args).toEqual({ branch_slug: "garcia-lavin" });
    const productos = p.filter((x) => x.nombre === "buscar_producto");
    expect(productos.length).toBeGreaterThanOrEqual(2);
    expect(productos.every((x) => x.args["branch_slug"] === "garcia-lavin")).toBe(true);
    expect(p.length).toBeLessThanOrEqual(4);
  });

  it("turnos siguientes: sin cliente ni sucursal; una afirmacion no precarga nada", () => {
    expect(precargaVozPm("Sí, es correcto.", 4, "garcia-lavin")).toEqual([]);
    const p = precargaVozPm("Mejor ponme seis, de maíz", 3, "garcia-lavin");
    expect(p.some((x) => x.nombre === "buscar_cliente" || x.nombre === "consultar_sucursal")).toBe(false);
  });
});
