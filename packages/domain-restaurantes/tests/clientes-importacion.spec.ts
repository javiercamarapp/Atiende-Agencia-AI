// Importacion de cartera: normalizacion pura de renglones + mascara de telefono.
import { describe, expect, it } from "vitest";
import { maskPhone } from "../src/phone.ts";
import { prepararImportacionClientes } from "../src/clientes-importacion.ts";

describe("prepararImportacionClientes", () => {
  it("acepta 10 digitos, +52 y 521 y normaliza a 10 digitos", () => {
    const r = prepararImportacionClientes([
      { telefono: "9991230001", nombre: "Ana" },
      { telefono: "+52 999 123 0002", nombre: "Bruno" },
      { telefono: "5219991230003", nombre: "Carla" },
      { telefono: "(999) 123-0004" },
    ]);
    expect(r.errores).toEqual([]);
    expect(r.validas.map((v) => v.phone)).toEqual(["9991230001", "9991230002", "9991230003", "9991230004"]);
  });

  it("rechaza 11 digitos (X16/X17/X18: nunca recorta), telefonos cortos y renglones sin telefono, con el numero de renglon", () => {
    const r = prepararImportacionClientes([{ telefono: "99912300011", nombre: "Once" }, { telefono: "12345" }, { nombre: "Sin telefono" }, { telefono: "9991230009", nombre: "Bien" }]);
    expect(r.validas).toHaveLength(1);
    expect(r.errores.map((e) => e.renglon)).toEqual([1, 2, 3]);
    expect(r.errores[0]!.motivo).toContain("10 digitos");
    expect(r.errores[2]!.motivo).toBe("Falta el telefono.");
  });

  it("un renglon completamente vacio o que no es objeto es un error, no un cliente", () => {
    const r = prepararImportacionClientes([{}, { telefono: "  ", nombre: "" }, null, "texto", [1]]);
    expect(r.validas).toEqual([]);
    expect(r.errores).toHaveLength(5);
    expect(r.errores[0]!.motivo).toBe("Renglon vacio.");
    expect(r.errores[2]!.motivo).toBe("Renglon invalido.");
  });

  it("un telefono que Excel entrego como numero se acepta", () => {
    const r = prepararImportacionClientes([{ telefono: 9991230001, nombre: "Ana" }]);
    expect(r.validas[0]!.phone).toBe("9991230001");
  });

  it("anexa la colonia a la direccion, limpia espacios y caracteres de control y recorta a los maximos de la base", () => {
    const r = prepararImportacionClientes([
      { telefono: "9991230001", nombre: "  Ana \n  Maria  ", direccion: "Calle 5 #10", colonia: "Centro", notas: "x".repeat(900) },
      { telefono: "9991230002", colonia: "Solo colonia" },
    ]);
    expect(r.validas[0]).toMatchObject({ name: "Ana Maria", address: "Calle 5 #10, Centro" });
    expect(r.validas[0]!.notes).toHaveLength(500);
    expect(r.validas[1]!.address).toBe("Solo colonia");
  });

  it("cuenta los telefonos repetidos dentro del archivo (el primero gana en la base)", () => {
    const r = prepararImportacionClientes([{ telefono: "9991230001", nombre: "Uno" }, { telefono: "+529991230001", nombre: "Dos" }]);
    expect(r.validas).toHaveLength(2);
    expect(r.duplicadosEnArchivo).toBe(1);
  });
});

describe("maskPhone", () => {
  it("deja solo los ultimos 4 digitos", () => {
    expect(maskPhone("9991230001")).toBe("******0001");
    expect(maskPhone("+52 999 123 0001")).toBe("********0001");
  });
  it("con menos de 4 digitos enmascara todo", () => {
    expect(maskPhone("12")).toBe("****");
    expect(maskPhone("")).toBe("****");
  });
});
