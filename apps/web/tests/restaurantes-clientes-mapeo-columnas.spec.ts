// Mapeo asistido de columnas al importar clientes: sugerencia por encabezado + por contenido, repetidas, faltantes, ejemplos y vista previa local.
import { describe, expect, it } from "vitest";
import {
  calidadTelefono,
  camposFaltantes,
  camposRepetidos,
  columnaTelefonoPorContenido,
  ejemplosDeColumna,
  esTelefonoPlausible,
  sugerirMapeoCompleto,
  vistaPreviaLocal,
} from "../src/verticals/restaurantes/lib/mapeo-columnas-clientes.ts";

const SIN: { telefono: null; nombre: null; direccion: null; colonia: null; notas: null } = { telefono: null, nombre: null, direccion: null, colonia: null, notas: null };

describe("esTelefonoPlausible", () => {
  it("acepta 10 digitos con separadores y +52 / 521; rechaza 11 digitos, texto y vacios", () => {
    expect(esTelefonoPlausible("999 123 0001")).toBe(true);
    expect(esTelefonoPlausible("(999) 123-0001")).toBe(true);
    expect(esTelefonoPlausible("+52 999 123 0001")).toBe(true);
    expect(esTelefonoPlausible("5219991230001")).toBe(true);
    expect(esTelefonoPlausible("99912300011")).toBe(false);
    expect(esTelefonoPlausible("Ana")).toBe(false);
    expect(esTelefonoPlausible("")).toBe(false);
  });
});

describe("sugerirMapeoCompleto", () => {
  it("con encabezados reconocibles usa el nombre de la columna (igual que antes)", () => {
    const filas = [
      ["Nombre", "Celular", "Colonia"],
      ["Ana", "9991230001", "Centro"],
    ];
    expect(sugerirMapeoCompleto(filas, true)).toEqual({ ...SIN, nombre: 0, telefono: 1, colonia: 2 });
  });

  it("sin encabezados encuentra el telefono por el contenido de las celdas", () => {
    const filas = [
      ["Ana", "Calle 60", "999 123 0001"],
      ["Beto", "Calle 62", "9991230002"],
      ["Caro", "Calle 64", "+52 999 123 0003"],
    ];
    expect(sugerirMapeoCompleto(filas, false)).toEqual({ ...SIN, telefono: 2 });
  });

  it("descarta un encabezado engañoso («Número de cliente») y elige la columna que de verdad trae telefonos", () => {
    const filas = [
      ["Número de cliente", "Nombre", "Dato"],
      ["17", "Ana", "9991230001"],
      ["18", "Beto", "9991230002"],
    ];
    expect(sugerirMapeoCompleto(filas, true)).toEqual({ ...SIN, nombre: 1, telefono: 2 });
  });

  it("no propone telefono si ninguna columna llega al umbral, ni reutiliza una columna ya ocupada", () => {
    const filas = [
      ["Nombre", "Notas"],
      ["Ana", "sin cebolla"],
      ["Beto", "9991230002"],
      ["Caro", "llamar tarde"],
    ];
    expect(sugerirMapeoCompleto(filas, true).telefono).toBeNull();
    expect(columnaTelefonoPorContenido([["9991230001"]], 1, new Set([0]))).toBeNull();
  });
});

describe("validacion y muestra", () => {
  it("camposRepetidos marca los campos que comparten columna y camposFaltantes exige el telefono", () => {
    expect(camposRepetidos({ ...SIN, telefono: 0, nombre: 1, notas: 1 })).toEqual(["nombre", "notas"]);
    expect(camposRepetidos({ ...SIN, telefono: 0, nombre: 1 })).toEqual([]);
    expect(camposFaltantes(SIN)).toEqual(["telefono"]);
    expect(camposFaltantes({ ...SIN, telefono: 3 })).toEqual([]);
  });

  it("calidadTelefono cuenta celdas con valor y plausibles; ejemplosDeColumna salta vacios y recorta textos largos", () => {
    const datos = [["9991230001", ""], ["abc", "x".repeat(60)], ["", "Centro"]];
    expect(calidadTelefono(datos, 0)).toEqual({ conValor: 2, plausibles: 1 });
    const ej = ejemplosDeColumna(datos, 1);
    expect(ej).toHaveLength(2);
    expect(ej[0]!.length).toBe(40);
    expect(ej[0]!.endsWith("…")).toBe(true);
    expect(ej[1]).toBe("Centro");
  });

  it("vistaPreviaLocal arma los primeros renglones con el mapeo", () => {
    const datos = [
      ["Ana", "9991230001"],
      ["Beto", "9991230002"],
    ];
    expect(vistaPreviaLocal(datos, { ...SIN, nombre: 0, telefono: 1 }, 1)).toEqual([{ telefono: "9991230001", nombre: "Ana", direccion: "", colonia: "", notas: "" }]);
  });
});
