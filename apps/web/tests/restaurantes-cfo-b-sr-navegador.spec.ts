// CFO-08 · importación de SoftRestaurant en el navegador: encabezado entre títulos, mapeo con los alias del dominio, columnas personales excluidas y
// tabla que conserva la numeración del archivo. Usa los archivos SINTÉTICOS de CFO-04 (nunca datos reales).
import { describe, expect, it } from "vitest";
import { normalizarExportSr, parsearCsvSr } from "@atiende/domain-restaurantes/cfo";
import { CSV_SR_SINTETICO, filasXlsxSrSintetico } from "../../../packages/domain-restaurantes/tests/fixtures/cfo-pm-sintetico.ts";
import { parsearCsv } from "../src/verticals/restaurantes/lib/clientes-importacion.ts";
import {
  camposFaltantes,
  camposRepetidos,
  columnasPersonales,
  construirTablaSr,
  detectarFilaEncabezado,
  sugerirMapeoSr,
  sugerirTipo,
} from "../src/verticals/restaurantes/cfo/sr-importacion-navegador.ts";

const filasCsv = parsearCsv(CSV_SR_SINTETICO);

describe("importación SR en el navegador", () => {
  it("detecta el encabezado debajo de la línea de título SINTÉTICO y el layout de cuentas", () => {
    const h = detectarFilaEncabezado(filasCsv);
    expect(h).toBe(1);
    expect(filasCsv[h]![0]).toBe("Folio");
    expect(sugerirTipo(filasCsv[h]!)).toBe("cuentas");
  });

  it("el XLSX de resumen por servicio se reconoce como resumen_servicio", () => {
    const h = detectarFilaEncabezado(filasXlsxSrSintetico);
    expect(h).toBe(1);
    expect(sugerirTipo(filasXlsxSrSintetico[h]!)).toBe("resumen_servicio");
    const m = sugerirMapeoSr(filasXlsxSrSintetico[h]!, "resumen_servicio");
    expect(camposFaltantes("resumen_servicio", m)).toEqual([]);
    expect(m["tickets"]).toBe(2);
  });

  it("sugiere cada campo con los alias del dominio y no repite columnas", () => {
    const enc = filasCsv[1]!;
    const m = sugerirMapeoSr(enc, "cuentas");
    expect(m).toMatchObject({ folio: 0, fecha: 1, hora: 2, servicio: 3, total: 7, forma_pago: 8, cancelada: 9 });
    expect(camposFaltantes("cuentas", m)).toEqual([]);
    expect(camposRepetidos(m)).toEqual([]);
  });

  it("las columnas personales (Teléfono, Nombre del cliente, Dirección, RFC) se excluyen del mapeo y de la tabla que se sube", () => {
    const filas = [
      ["SINTÉTICO"],
      ["Folio", "Fecha", "Teléfono", "Tipo de servicio", "Nombre del cliente", "Total", "Dirección", "RFC"],
      ["T2-1", "21/09/2026", "9990000000", "Domicilio", "Cliente SINTÉTICO 1", "$100.00", "Calle Falsa 123", "XAXX010101000"],
    ];
    const enc = filas[1]!;
    expect(columnasPersonales(enc)).toEqual([2, 4, 6, 7]);
    const m = sugerirMapeoSr(enc, "cuentas");
    expect(Object.values(m)).not.toContain(2);
    expect(Object.values(m)).not.toContain(4);
    const t = construirTablaSr(filas, 1, "cuentas", m);
    expect(t.excluidas).toEqual(["Teléfono", "Nombre del cliente", "Dirección", "RFC"]);
    const enviado = JSON.stringify(t.tabla);
    for (const pii of ["9990000000", "Cliente SINTÉTICO", "Calle Falsa", "XAXX", "Teléfono", "RFC"]) expect(enviado).not.toContain(pii);
    expect(t.tabla[0]).toEqual([]); // el título se vacía pero conserva su número de renglón
    expect(t.tabla[2]![0]).toBe("T2-1");
  });

  it("un mapeo que apunta a una columna personal falla (nunca se sube)", () => {
    const filas = [["Folio", "Fecha", "Teléfono", "Total"], ["1", "21/09/2026", "9990000000", "10"]];
    expect(() => construirTablaSr(filas, 0, "cuentas", { folio: 0, fecha: 1, total: 2 })).toThrow(/datos personales/);
  });

  it("la tabla mapeada la entiende el normalizador del servidor (mismos renglones, errores con la numeración del archivo)", () => {
    const m = sugerirMapeoSr(filasCsv[1]!, "cuentas");
    const { tabla } = construirTablaSr(filasCsv, 1, "cuentas", m);
    const directo = normalizarExportSr({ tabla: parsearCsvSr(CSV_SR_SINTETICO), corte: "01:00", tipo: "cuentas" });
    const mapeado = normalizarExportSr({ tabla, corte: "01:00", tipo: "cuentas" });
    expect(directo.ok && mapeado.ok).toBe(true);
    if (directo.ok && mapeado.ok) {
      expect(mapeado.aceptados).toBe(directo.aceptados);
      expect(mapeado.renglones).toEqual(directo.renglones);
    }
    // Un monto roto en el renglón 5 del archivo se informa como renglón 5.
    const rota = filasCsv.map((f, i) => (i === 4 ? f.map((c, j) => (j === 7 ? "abc" : c)) : f));
    const r = normalizarExportSr({ tabla: construirTablaSr(rota, 1, "cuentas", m).tabla, corte: "01:00", tipo: "cuentas" });
    expect(r.ok && r.errores.map((e) => e.renglon)).toEqual([5]);
  });
});
