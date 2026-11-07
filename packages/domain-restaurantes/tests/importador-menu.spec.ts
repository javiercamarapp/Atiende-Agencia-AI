import { describe, expect, it } from "vitest";
import {
  borradorDesdeCsv,
  borradorDesdeExtraccion,
  ImportacionMenuInvalida,
  MAX_PRODUCTOS_IMPORTACION,
  parsearPrecio,
  slugCategoria,
  validarImportacionAprobada,
} from "../src/importador-menu.ts";

describe("parsearPrecio", () => {
  it.each([
    ["$1,250.00", 1250],
    ["1.250,50", 1250.5],
    ["99,5", 99.5],
    ["120 pesos", 120],
    ["MXN 85", 85],
    [45.555, 45.56],
    ["", null],
    ["a consultar", null],
    [-3, null],
  ])("%s -> %s", (raw, esperado) => expect(parsearPrecio(raw)).toBe(esperado));
});

describe("borradorDesdeExtraccion (salida del modelo de vision)", () => {
  it("arma categorias y productos; precio ilegible queda null con duda; nunca lo inventa", () => {
    const b = borradorDesdeExtraccion({
      productos: [
        { nombre: "Taco de pastor", categoria: "Tacos", descripcion: null, precio: 25, esPaquete: false, incluye: [] },
        { nombre: "Gringa", categoria: "Tacos", descripcion: "Con queso", precio: null, esPaquete: false, incluye: [] },
        { nombre: "Taco de pastor", categoria: "Tacos", descripcion: null, precio: 25, esPaquete: false, incluye: [] },
        { nombre: "Combo familiar", categoria: "", descripcion: null, precio: 4500, esPaquete: true, incluye: ["10 tacos", "Refresco 2 L"] },
        { nombre: "Agua", categoria: "", descripcion: null, precio: "30", esPaquete: false, incluye: [] },
        "basura",
        { nombre: "x" },
      ],
    });
    expect(b.categorias).toEqual(["Tacos", "Paquetes", "Sin clasificar"]);
    expect(b.productos.map((p) => [p.nombre, p.precio, p.dudas])).toEqual([
      ["Taco de pastor", 25, []],
      ["Gringa", null, ["sin_precio"]],
      ["Taco de pastor", 25, ["duplicado"]],
      ["Combo familiar", 4500, ["precio_inusual"]],
      ["Agua", 30, ["sin_categoria"]],
    ]);
    expect(b.productos[3]!.descripcion).toBe("Incluye: 10 tacos, Refresco 2 L.");
    expect(b.ilegibles).toBe(2);
  });

  it("texto con cercas de codigo o JSON roto: no truena, devuelve borrador vacio con ilegibles", () => {
    expect(borradorDesdeExtraccion('```json\n{"productos":[{"nombre":"Sope","categoria":"Antojitos","descripcion":null,"precio":40,"esPaquete":false,"incluye":[]}]}\n```').productos).toHaveLength(1);
    expect(borradorDesdeExtraccion("no es json")).toMatchObject({ productos: [], ilegibles: 1 });
  });

  it("recorta a MAX_PRODUCTOS_IMPORTACION y lo avisa", () => {
    const productos = Array.from({ length: MAX_PRODUCTOS_IMPORTACION + 5 }, (_, i) => ({ nombre: `Producto ${i}`, categoria: "A", descripcion: null, precio: 10, esPaquete: false, incluye: [] }));
    const b = borradorDesdeExtraccion({ productos });
    expect(b.productos).toHaveLength(MAX_PRODUCTOS_IMPORTACION);
    expect(b.recortado).toBe(true);
  });
});

describe("borradorDesdeCsv", () => {
  it("encabezados con alias y acentos, separador ; y comillas", () => {
    const csv = '\uFEFFPlatillo;Categoría;Precio;Descripción;Paquete;Incluye\n"Taco ""especial""";Tacos;$35;"Con piña, cebolla";;\nCombo 2;;150;;sí;2 tacos|refresco\n';
    const b = borradorDesdeCsv(csv);
    expect(b.productos.map((p) => [p.nombre, p.categoria, p.precio, p.esPaquete])).toEqual([
      ['Taco "especial"', "Tacos", 35, false],
      ["Combo 2", "Paquetes", 150, true],
    ]);
    expect(b.productos[0]!.descripcion).toBe("Con piña, cebolla");
  });

  it("sin columnas nombre/precio: borrador vacio con todas las filas ilegibles", () => {
    expect(borradorDesdeCsv("a,b\n1,2\n")).toMatchObject({ productos: [], ilegibles: 2 });
  });
});

describe("validarImportacionAprobada", () => {
  it("exige nombre y precio en cada fila aprobada; categoria vacia va a Sin clasificar", () => {
    expect(validarImportacionAprobada({ productos: [{ nombre: "Sope", categoria: "", precio: 40 }] })).toEqual([{ nombre: "Sope", categoria: "Sin clasificar", descripcion: null, precio: 40 }]);
    expect(() => validarImportacionAprobada({ productos: [{ nombre: "Sope", categoria: "A", precio: null }] })).toThrow(ImportacionMenuInvalida);
    expect(() => validarImportacionAprobada({ productos: [] })).toThrow(/No hay productos/);
    expect(() => validarImportacionAprobada({ productos: Array.from({ length: MAX_PRODUCTOS_IMPORTACION + 1 }, () => ({ nombre: "aa", precio: 1 })) })).toThrow(/Máximo/);
  });

  it("slugCategoria cumple el patron de admin-catalog", () => {
    expect(slugCategoria("Bebidas Frías & Más")).toBe("bebidas-frias-mas");
    expect(slugCategoria("¡¡!!")).toBe("categoria");
    expect(slugCategoria("x".repeat(100))).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});
