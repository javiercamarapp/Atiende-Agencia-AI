import { describe, expect, it } from "vitest";
import { MapaProductoCodigo, RESOLVER_SIN_CODIGOS, construirMapaDesdeCatalogo, renglonesAItemsComanda } from "../src/softrestaurant/catalog-map.ts";
import { validarComandaInput, type ComandaInput } from "../src/softrestaurant/types.ts";

const valida: ComandaInput = {
  idempotencyKey: "k-1",
  sucursal: "T3",
  tipo: "domicilio",
  cliente: { nombre: "Ana", telefono: "9991234567" },
  direccion: { texto: "Calle 1 #2", referencias: "esquina" },
  formaPago: "tarjeta",
  propina: 20,
  items: [{ codigo: "C1", cantidad: 1, modificadores: [] }],
};

describe("validarComandaInput", () => {
  it("acepta una comanda valida (domicilio, tarjeta con propina)", () => {
    expect(validarComandaInput(valida)).toEqual([]);
  });
  it("propina con efectivo se rechaza; propina 0 con efectivo es valida", () => {
    expect(validarComandaInput({ ...valida, formaPago: "efectivo" })).toContain("propina: solo se acepta con tarjeta");
    expect(validarComandaInput({ ...valida, formaPago: "efectivo", propina: 0 })).toEqual([]);
  });
  it("domicilio exige direccion; recoger no", () => {
    expect(validarComandaInput({ ...valida, direccion: undefined })).toContain("direccion: requerida para domicilio");
    expect(validarComandaInput({ ...valida, direccion: undefined, tipo: "recoger" })).toEqual([]);
  });
  it("sucursal fuera de T1..T8, items vacios y cantidades no enteras se rechazan", () => {
    expect(validarComandaInput({ ...valida, sucursal: "T9" as never })).toContain("sucursal: debe ser T1..T8");
    expect(validarComandaInput({ ...valida, items: [] })).toContain("items: entre 1 y 100 renglones");
    expect(validarComandaInput({ ...valida, items: [{ codigo: "C1", cantidad: 1.5, modificadores: [] }] })).toContain("items[0].cantidad: entero > 0");
  });
  it("llave de idempotencia vacia o de mas de 200 caracteres se rechaza", () => {
    expect(validarComandaInput({ ...valida, idempotencyKey: " " }).length).toBeGreaterThan(0);
    expect(validarComandaInput({ ...valida, idempotencyKey: "x".repeat(201) }).length).toBeGreaterThan(0);
  });
});

describe("MapaProductoCodigo / renglonesAItemsComanda", () => {
  it("una entrada por sucursal gana sobre la general, y hay mapeo inverso", () => {
    const mapa = new MapaProductoCodigo([
      { productId: "p1", codigo: "GEN-1" },
      { productId: "p1", codigo: "T2-1", sucursal: "T2" },
    ]);
    expect(mapa.codigoDeProducto("p1", "T1")).toBe("GEN-1");
    expect(mapa.codigoDeProducto("p1", "T2")).toBe("T2-1");
    expect(mapa.productoDeCodigo("T2-1", "T2")).toBe("p1");
    expect(mapa.codigoDeProducto("otro", "T1")).toBeNull();
  });

  it("un producto sin codigo NUNCA se inventa: se reporta y no se arma la comanda", () => {
    const mapa = new MapaProductoCodigo([{ productId: "p1", codigo: "C1" }]);
    const r = renglonesAItemsComanda([{ productId: "p1", cantidad: 2 }, { productId: "p2", cantidad: 1 }], "T1", mapa);
    expect(r).toEqual({ ok: false, productosSinCodigo: ["p2"] });
    expect(renglonesAItemsComanda([{ productId: "p1", cantidad: 1 }], "T1", RESOLVER_SIN_CODIGOS)).toEqual({ ok: false, productosSinCodigo: ["p1"] });
    expect(renglonesAItemsComanda([{ productId: "p1", cantidad: 2, nota: "sin salsa" }], "T1", mapa)).toEqual({
      ok: true,
      items: [{ codigo: "C1", cantidad: 2, modificadores: [], nota: "sin salsa" }],
    });
  });

  it("construirMapaDesdeCatalogo empareja por nombre normalizado y deja ambiguos/sobrantes fuera", () => {
    const catalogo = {
      sucursal: "T1" as const,
      generadoEn: "2026-09-30T00:00:00.000Z",
      sintetico: false,
      items: [
        { codigo: "A", nombre: "Orden de Tacos de Pastor", precio: 90, modificadores: [], disponible: true },
        { codigo: "B", nombre: "Refresco", precio: 30, modificadores: [], disponible: true },
        { codigo: "B2", nombre: "REFRESCO", precio: 30, modificadores: [], disponible: true },
        { codigo: "Z", nombre: "Postre sin producto", precio: 10, modificadores: [], disponible: true },
      ],
    };
    const r = construirMapaDesdeCatalogo(catalogo, [
      { id: "p1", name: "orden de tacos de pástor" },
      { id: "p2", name: "Refresco" },
      { id: "p3", name: "Agua" },
    ]);
    expect(r.mapa.codigoDeProducto("p1", "T1")).toBe("A");
    expect(r.mapa.codigoDeProducto("p2", "T1")).toBeNull();
    expect(r.sinCodigo).toEqual(["p2", "p3"]);
    expect(r.codigosSinProducto).toEqual(["B", "B2", "Z"]);
  });
});
