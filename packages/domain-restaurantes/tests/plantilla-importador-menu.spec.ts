import { describe, expect, it } from "vitest";
import { AdaptadorVisionFalso, CATEGORIA_SIN_CLASIFICAR, combinar, importarMenuDesdeJson, importarMenuDesdeTexto, importarMenuDesdeVision, parsearPrecio } from "../src/plantilla/importador-menu.ts";

describe("parsearPrecio", () => {
  it.each([["$65", 65], ["65", 65], ["65.00", 65], ["1,250", 1250], ["$1,250.00", 1250], ["65 pesos", 65]])("%s -> %s", (raw, esperado) => {
    expect(parsearPrecio(raw)).toBe(esperado);
  });
  it("centavos distintos de cero -> NaN (duda, no se redondea); texto -> null", () => {
    expect(parsearPrecio("65.50")).toBeNaN();
    expect(parsearPrecio("gratis")).toBeNull();
  });
});

describe("importarMenuDesdeTexto", () => {
  const TEXTO = ["TACOS", "Taco de pastor ..... $25", "Gringa - 65", "", "Bebidas:", "Agua de horchata 30.00", "Refresco  $28", "Combo familiar $4,500"].join("\n");
  it("detecta categorias, productos y precios enteros", () => {
    const r = importarMenuDesdeTexto(TEXTO);
    expect(r.menu.categorias).toEqual(["TACOS", "Bebidas"]);
    expect(r.menu.productos.map((p) => [p.nombre, p.categoria, p.precio])).toEqual([
      ["Taco de pastor", "TACOS", 25],
      ["Gringa", "TACOS", 65],
      ["Agua de horchata", "Bebidas", 30],
      ["Refresco", "Bebidas", 28],
      ["Combo familiar", "Bebidas", 4500],
    ]);
  });
  it("marca precio inusual y deja el resto limpio", () => {
    const r = importarMenuDesdeTexto(TEXTO);
    expect(r.dudas.map((d) => [d.tipo, d.referencia])).toEqual([["precio_inusual", "Combo familiar"]]);
    expect(r.limpios).toBe(4);
  });
  it("producto sin categoria, sin precio, centavos y duplicado quedan como dudas (nada se inventa)", () => {
    const r = importarMenuDesdeTexto(["Taco suelto $20", "Postres", "Pastel $45.50", "Gelatina $15", "Gelatina $15", "Flan"].join("\n"));
    const tipos = r.dudas.map((d) => `${d.tipo}:${d.referencia}`);
    expect(tipos).toContain("sin_categoria:Taco suelto");
    expect(tipos).toContain("sin_precio:Flan");
    expect(tipos).toContain("precio_invalido:Pastel");
    expect(tipos).toContain("duplicado:Gelatina");
    expect(r.menu.productos.filter((p) => p.nombre === "Gelatina")).toHaveLength(1);
    expect(r.menu.productos.find((p) => p.nombre === "Taco suelto")?.categoria).toBe(CATEGORIA_SIN_CLASIFICAR);
    expect(r.menu.productos.find((p) => p.nombre === "Flan")).toBeUndefined();
  });
  it("es determinista", () => {
    expect(importarMenuDesdeTexto(TEXTO)).toEqual(importarMenuDesdeTexto(TEXTO));
  });
});

describe("importarMenuDesdeJson", () => {
  it("arreglo plano con categoria por producto y precio en texto", () => {
    const r = importarMenuDesdeJson(JSON.stringify([{ nombre: "Pizza grande", categoria: "Pizzas", precio: "$189" }, { name: "Cola", category: "Bebidas", price: 25, alias: ["coca"] }]));
    expect(r.menu.productos.map((p) => [p.nombre, p.precio, p.alias ?? []])).toEqual([["Pizza grande", 189, []], ["Cola", 25, ["coca"]]]);
    expect(r.dudas).toEqual([]);
  });
  it("forma {categorias:[{nombre,productos}]} y alias en choque", () => {
    const r = importarMenuDesdeJson(JSON.stringify({ categorias: [{ nombre: "Café", productos: [{ nombre: "Americano", precio: 40, alias: ["negro"] }, { nombre: "Espresso", precio: 38, alias: ["negro"] }] }] }));
    expect(r.menu.categorias).toEqual(["Café"]);
    expect(r.dudas.map((d) => d.tipo)).toEqual(["alias_choque"]);
  });
  it("JSON roto o de forma desconocida -> duda json_invalido, menu vacio", () => {
    expect(importarMenuDesdeJson("{no").dudas[0]?.tipo).toBe("json_invalido");
    expect(importarMenuDesdeJson('{"x":1}').dudas[0]?.tipo).toBe("json_invalido");
    expect(importarMenuDesdeJson("{no").menu.productos).toEqual([]);
  });
  it("precio decimal numerico -> precio_invalido", () => {
    expect(importarMenuDesdeJson(JSON.stringify([{ nombre: "X", categoria: "A", precio: 10.5 }])).dudas[0]?.tipo).toBe("precio_invalido");
  });
});

describe("vision: interfaz con adaptador falso", () => {
  it("transcribe por fuente, importa el texto y conserva la fuente en las dudas", async () => {
    const a = new AdaptadorVisionFalso({ "menu1.jpg": "Pizzas\nHawaiana $150\nPepperoni $160", "menu2.pdf": "Bebidas\nCola $25\nAgua" });
    const enc = new TextEncoder();
    const r = await importarMenuDesdeVision(a, [{ tipo: "imagen", nombre: "menu1.jpg", bytes: enc.encode("x") }, { tipo: "pdf", nombre: "menu2.pdf", bytes: enc.encode("y") }]);
    expect(a.llamadas).toEqual(["menu1.jpg", "menu2.pdf"]);
    expect(r.menu.categorias).toEqual(["Pizzas", "Bebidas"]);
    expect(r.dudas.map((d) => d.referencia)).toEqual(["menu2.pdf: Agua"]);
  });
  it("fuente sin respuesta falla fuerte (no inventa menu)", async () => {
    await expect(importarMenuDesdeVision(new AdaptadorVisionFalso({}), [{ tipo: "imagen", nombre: "z.jpg", bytes: new Uint8Array() }])).rejects.toThrow(/sin respuesta/);
  });
  it("combinar detecta duplicados entre fuentes", () => {
    const p = importarMenuDesdeTexto("Pizzas\nHawaiana $150");
    expect(combinar([p, p]).dudas.map((d) => d.tipo)).toEqual(["duplicado"]);
  });
});
