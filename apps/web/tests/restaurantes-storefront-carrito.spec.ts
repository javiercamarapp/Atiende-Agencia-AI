// R-09: logica pura del carrito del storefront (reglas duras antes de cotizar, paquetes, tortilla, alcohol).
import { describe, expect, it } from "vitest";
import { agregar, aItemsApi, avisos, cambiarCantidad, hayAlcohol, nuevoIdSesion, piezasDe, propinaPermitida, subtotal } from "../src/verticals/restaurantes/storefront/carrito.ts";
import type { ProductoMenu } from "../src/verticals/restaurantes/storefront/storefront-client.ts";

const base: ProductoMenu = { id: "p", name: "Producto", description: null, price: 100, imageUrl: null, isPopular: false, available: true, packSize: null, requiresAdultConfirmation: false, requiresTortilla: false, noDomicilio: false };
const tacos: ProductoMenu = { ...base, id: "tacos", name: "Tacos de bistec (orden de 3)", price: 164, packSize: 3, requiresTortilla: true };
const coca: ProductoMenu = { ...base, id: "coca", name: "Coca-Cola", price: 45 };
const cerveza: ProductoMenu = { ...base, id: "sol", name: "Sol", price: 66, requiresAdultConfirmation: true, noDomicilio: true };

describe("agregar / cambiar cantidad", () => {
  it("no agrega un producto 'hoy no hay'", () => {
    expect(agregar([], { ...coca, available: false })).toEqual([]);
  });
  it("tacos exigen tortilla: sin elegirla no entran; con ella, renglones separados por tortilla", () => {
    expect(agregar([], tacos)).toEqual([]);
    const c = agregar(agregar([], tacos, "maiz"), tacos, "harina");
    expect(c).toHaveLength(2);
    expect(agregar(c, tacos, "maiz").find((r) => r.tortilla === "maiz")?.cantidad).toBe(2);
  });
  it("un producto sin tortilla ignora la tortilla que se le pase", () => {
    expect(agregar([], coca, "maiz")[0]!.tortilla).toBeNull();
  });
  it("tope de cantidad y cantidad 0 o invalida quita el renglon", () => {
    let c = agregar([], coca);
    c = cambiarCantidad(c, "coca", null, 999);
    expect(c[0]!.cantidad).toBe(20);
    expect(cambiarCantidad(c, "coca", null, 0)).toEqual([]);
    expect(cambiarCantidad(c, "coca", null, Number.NaN)).toEqual([]);
  });
});

describe("totales y formato del servidor", () => {
  it("subtotal por ordenes y piezas = ordenes x piezas por orden", () => {
    const c = cambiarCantidad(agregar(agregar([], tacos, "maiz"), coca), "tacos", "maiz", 2);
    expect(subtotal(c)).toBe(2 * 164 + 45);
    expect(piezasDe(c[0]!)).toBe(6);
    expect(aItemsApi(c)).toEqual([
      { product_id: "tacos", requested_quantity: 6, tortilla: "maiz" },
      { product_id: "coca", requested_quantity: 1 },
    ]);
  });
});

describe("avisos de reglas duras", () => {
  it("carrito mixto a domicilio: el alcohol bloquea; al recoger no", () => {
    const c = agregar(agregar([], coca), cerveza);
    expect(hayAlcohol(c)).toBe(true);
    const dom = avisos(c, "domicilio", null, null);
    expect(dom).toEqual([expect.objectContaining({ codigo: "no_domicilio", bloquea: true })]);
    expect(dom[0]!.mensaje).toContain("Sol");
    expect(avisos(c, "recoger", null, null)).toEqual([]);
  });
  it("minimo de $200 a domicilio: bloquea con el faltante; recoger sin minimo pasa; borde exacto pasa", () => {
    const c = agregar([], tacos, "maiz"); // 164
    expect(avisos(c, "domicilio", 200, null)[0]).toMatchObject({ codigo: "minimo", bloquea: true, mensaje: expect.stringContaining("Te faltan $36") });
    expect(avisos(c, "recoger", 200, null)).toEqual([]);
    expect(avisos(cambiarCantidad(c, "tacos", "maiz", 2), "domicilio", 200, null)).toEqual([]);
    expect(avisos(agregar([], { ...base, price: 200 }), "domicilio", 200, null)).toEqual([]);
    expect(avisos(agregar([], { ...base, price: 199.99 }), "domicilio", 200, null)).toHaveLength(1);
  });
  it("carrito vacio bloquea", () => {
    expect(avisos([], "recoger", null, null)[0]).toMatchObject({ codigo: "vacio", bloquea: true });
  });
});

describe("propina y sesion", () => {
  it("propina solo con tarjeta (solo_tarjeta); siempre/nunca/null", () => {
    expect(propinaPermitida("solo_tarjeta", "tarjeta")).toBe(true);
    expect(propinaPermitida("solo_tarjeta", "efectivo")).toBe(false);
    expect(propinaPermitida("solo_tarjeta", null)).toBe(false);
    expect(propinaPermitida("siempre", "efectivo")).toBe(true);
    expect(propinaPermitida("nunca", "tarjeta")).toBe(false);
    expect(propinaPermitida(null, "tarjeta")).toBe(false);
  });
  it("el id de sesion cumple el formato que exige el servidor y no se repite", () => {
    const a = nuevoIdSesion();
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(nuevoIdSesion()).not.toBe(a);
  });
});
