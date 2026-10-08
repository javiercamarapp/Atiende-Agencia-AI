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
  pareceTelefono,
  valorPersonalEnMapeo,
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
    expect(columnasPersonales(filas, 1)).toEqual([2, 4, 6, 7]);
    const m = sugerirMapeoSr(enc, "cuentas", new Set(columnasPersonales(filas, 1)));
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

  const CON_TEL = [
    ["Folio", "Fecha", "Total", "Teléfono"],
    ["T2-1", "21/09/2026", "$100.00", "9991112222"],
    ["T2-2", "22/09/2026", "$200.00", "9993334444"],
    ["T2-3", "23/09/2026", "$300.00", "9995556666"],
  ];

  describe("BLOQUEANTE de PII: el renglón de encabezados elegido no libera una columna personal", () => {
    for (const filaEnc of [1, 2, 3]) {
      it(`con el renglón ${filaEnc + 1} (de datos) como encabezado, el teléfono sigue excluido y el JSON enviado no lo contiene`, () => {
        expect(columnasPersonales(CON_TEL, filaEnc)).toContain(3);
        const m = sugerirMapeoSr(CON_TEL[filaEnc]!, "cuentas", new Set(columnasPersonales(CON_TEL, filaEnc)));
        expect(Object.values(m)).not.toContain(3);
        // Aunque la persona fuerce el mapeo del teléfono a «folio», la tabla no se arma.
        expect(() => construirTablaSr(CON_TEL, filaEnc, "cuentas", { folio: 3, fecha: 1, total: 2 })).toThrow(/datos personales/);
        // Con el mapeo sano, el teléfono no viaja.
        const t = construirTablaSr(CON_TEL, filaEnc, "cuentas", { folio: 0, fecha: 1, total: 2 });
        const json = JSON.stringify(t.tabla);
        for (const tel of ["9991112222", "9993334444", "9995556666", "Teléfono"]) expect(json).not.toContain(tel);
        expect(t.excluidas).toEqual(["Teléfono"]);
      });
    }

    it("el nombre de la columna excluida es el encabezado, nunca un valor de datos", () => {
      expect(construirTablaSr(CON_TEL, 2, "cuentas", { folio: 0, fecha: 1, total: 2 }).excluidas).toEqual(["Teléfono"]);
    });

    it("encabezado en el renglón 0 y teléfono en otra posición: se excluye donde esté", () => {
      const filas = [["Teléfono", "Folio", "Fecha", "Total"], ["9991112222", "T2-1", "21/09/2026", "$10.00"]];
      expect(columnasPersonales(filas, 0)).toEqual([0]);
      expect(columnasPersonales(filas, 1)).toEqual([0]);
      expect(JSON.stringify(construirTablaSr(filas, 1, "cuentas", { folio: 1, fecha: 2, total: 3 }).tabla)).not.toContain("9991112222");
    });

    it("columnas personales duplicadas (Teléfono 1 y Teléfono 2) se excluyen las dos", () => {
      const filas = [["Folio", "Teléfono 1", "Fecha", "Tel 2", "Total"], ["T2-1", "9991112222", "21/09/2026", "9993334444", "$10.00"]];
      expect(columnasPersonales(filas, 1)).toEqual([1, 3]);
      const json = JSON.stringify(construirTablaSr(filas, 0, "cuentas", { folio: 0, fecha: 2, total: 4 }).tabla);
      expect(json).not.toMatch(/999\d{7}/);
    });

    it("un título de una sola celda («Ventas por colonia») no marca como personal la columna del folio", () => {
      const filas = [["Ventas por colonia"], ["Folio", "Fecha", "Total"], ["T2-1", "21/09/2026", "$10.00"]];
      expect(columnasPersonales(filas, 1)).toEqual([]);
    });
  });

  describe("defensa en profundidad: valores con forma de teléfono o correo en columnas mapeadas", () => {
    it("un teléfono dentro de la columna mapeada a folio bloquea el envío", () => {
      const filas = [["Referencia", "Fecha", "Total"], ["9991112222", "21/09/2026", "$10.00"]];
      expect(valorPersonalEnMapeo(filas, 0, "cuentas", { folio: 0, fecha: 1, total: 2 })).toEqual({ campo: "folio", renglon: 2 });
      expect(() => construirTablaSr(filas, 0, "cuentas", { folio: 0, fecha: 1, total: 2 })).toThrow(/parece un teléfono o un correo/);
    });
    it("un correo o un teléfono con separadores o +52 en forma de pago o tipo de servicio también", () => {
      const f = (v: string) => [["Folio", "Fecha", "Tipo de servicio", "Total"], ["T2-1", "21/09/2026", v, "$10.00"]];
      for (const v of ["ana@correo.com", "999 111 2222", "(999) 111-2222", "+52 999 111 2222", "+529991112222", "5219991112222"]) {
        expect(valorPersonalEnMapeo(f(v), 0, "cuentas", { folio: 0, fecha: 1, servicio: 2, total: 3 }), v).not.toBeNull();
      }
    });
    it("sin falsos positivos: folios normales (con prefijo, largos con ceros, de 6 a 9 dígitos), servicios, fechas y montos", () => {
      for (const v of ["T2-00001", "0000012345", "123456", "1234567", "12345678", "123456789", "A1B2C3D4E5", "20260921", "2026-09-21"]) expect(pareceTelefono(v), v).toBe(false);
      const filas = [["Folio", "Fecha", "Tipo de servicio", "Forma de pago", "Total"], ["0000012345", "21/09/2026", "A domicilio", "Tarjeta", "$1,234.50"], ["123456789", "22/09/2026", "Comedor", "Efectivo", "10000000"]];
      expect(valorPersonalEnMapeo(filas, 0, "cuentas", { folio: 0, fecha: 1, servicio: 2, forma_pago: 3, total: 4 })).toBeNull();
      expect(() => construirTablaSr(filas, 0, "cuentas", { folio: 0, fecha: 1, servicio: 2, forma_pago: 3, total: 4 })).not.toThrow();
    });
  });
});
