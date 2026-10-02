// D-24: cliente del libro contable (funciones puras: pesos <-> centavos exactos, cuadre, validacion del formulario, cuerpo) y rutas HTTP.
import { describe, expect, it, vi } from "vitest";
import {
  centavosAPesos,
  cuerpoPoliza,
  dinero,
  erroresPoliza,
  fetchPolizas,
  pesosACentavos,
  polizaDesdeCfdi,
  polizaVacia,
  registrarPoliza,
  resumenCuadre,
} from "../src/verticals/despachos/lib/libro-client.ts";
import type { PolizaFormulario } from "../src/verticals/despachos/lib/libro-client.ts";

describe("pesosACentavos / centavosAPesos (exactos, sin flotantes)", () => {
  it.each([
    ["1160", 116000],
    ["1,160.00", 116000],
    ["0.05", 5],
    ["10.5", 1050],
    ["1,234,567.89", 123456789],
    ["0", 0],
  ])("%s -> %i", (texto, centavos) => expect(pesosACentavos(texto)).toBe(centavos));

  it.each(["", "abc", "1.234", "-5", "1,23", "12,34,567", "1e3", "$100", "99999999999999.99", "1 000"])("rechaza %j (nunca redondea en silencio)", (t) => expect(pesosACentavos(t)).toBeNull());

  it("ida y vuelta sin perder un centavo", () => {
    for (const c of [0, 1, 5, 99, 100, 101, 116000, 123456789, 100000000000]) expect(pesosACentavos(centavosAPesos(c))).toBe(c);
    expect(centavosAPesos(116000)).toBe("1,160.00");
    expect(centavosAPesos(-1234)).toBe("-12.34");
    expect(dinero(null)).toBe("—");
    expect(dinero(5)).toBe("$0.05");
  });
});

const cuentas = new Set(["1050000", "4080000", "2600400"]);
const valida: PolizaFormulario = {
  tipo: "ingreso",
  fecha: "2026-07-20",
  concepto: "Honorarios",
  partidas: [
    { cuenta: "1050000", concepto: "", debe: "1,160.00", haber: "" },
    { cuenta: "4080000", concepto: "", debe: "", haber: "1,000.00" },
    { cuenta: "2600400", concepto: "", debe: "", haber: "160" },
  ],
};

describe("formulario de poliza", () => {
  it("el resumen de cuadre se calcula en centavos y marca si cuadra", () => {
    expect(resumenCuadre(valida.partidas)).toEqual({ debeCentavos: 116000, haberCentavos: 116000, diferenciaCentavos: 0, cuadra: true });
    expect(resumenCuadre([{ cuenta: "1050000", concepto: "", debe: "10.01", haber: "" }, { cuenta: "4080000", concepto: "", debe: "", haber: "10" }]).cuadra).toBe(false);
  });

  it("una poliza valida no tiene errores y el cuerpo viaja en CENTAVOS enteros", () => {
    expect(erroresPoliza(valida, cuentas)).toEqual({});
    expect(cuerpoPoliza(valida)).toEqual({
      tipo: "ingreso",
      fecha: "2026-07-20",
      concepto: "Honorarios",
      movimientos: [
        { cuenta: "1050000", concepto: "", debe: 116000, haber: 0 },
        { cuenta: "4080000", concepto: "", debe: 0, haber: 100000 },
        { cuenta: "2600400", concepto: "", debe: 0, haber: 16000 },
      ],
    });
  });

  it("errores por campo: vacio, cuenta ajena, debe y haber juntos, importe invalido, descuadre", () => {
    expect(Object.keys(erroresPoliza(polizaVacia("2026-07-01"), cuentas))).toEqual(expect.arrayContaining(["concepto", "partida0", "partida1"]));
    const e = (partidas: PolizaFormulario["partidas"]) => erroresPoliza({ ...valida, partidas }, cuentas);
    expect(e([{ ...valida.partidas[0]!, cuenta: "9999999" }, valida.partidas[1]!]).partida0).toMatch(/no está en el catálogo/);
    expect(e([{ ...valida.partidas[0]!, haber: "5" }, valida.partidas[1]!]).partida0).toMatch(/debe o haber/);
    expect(e([{ ...valida.partidas[0]!, debe: "10.555" }, valida.partidas[1]!]).partida0).toMatch(/2 decimales/);
    expect(e([valida.partidas[0]!, { ...valida.partidas[1]!, haber: "999.99" }]).cuadre).toMatch(/no cuadra: diferencia de \$160\.01/);
    expect(erroresPoliza({ ...valida, partidas: [valida.partidas[0]!] }, cuentas).partidas).toMatch(/al menos 2/);
    expect(erroresPoliza({ ...valida, fecha: "" }, cuentas).fecha).toBeTruthy();
  });
});

describe("rutas HTTP", () => {
  const respuesta = (cuerpo: unknown, status = 200) => vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(cuerpo), { status }));

  it("lista las polizas del periodo con ejercicio y mes", async () => {
    const f = respuesta({ estado: "disponible", polizas: [] });
    await fetchPolizas(f as unknown as typeof fetch, "https://api.test", "tok", "p1", "2026-07");
    expect(f.mock.calls[0]![0]).toBe("https://api.test/despachos/p1/libro/polizas?ejercicio=2026&mes=7&limit=200");
  });

  it("registra una poliza (POST con el cuerpo en centavos) y una desde un CFDI", async () => {
    const f = respuesta({ polizaId: "x", folio: 1 }, 201);
    await registrarPoliza(f as unknown as typeof fetch, "https://api.test", "tok", "p1", valida);
    expect(f.mock.calls[0]![0]).toBe("https://api.test/despachos/p1/libro/polizas");
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body)).movimientos[0]).toEqual({ cuenta: "1050000", concepto: "", debe: 116000, haber: 0 });
    await polizaDesdeCfdi(f as unknown as typeof fetch, "https://api.test", "tok", "p1", "inv-1");
    expect(f.mock.calls[1]![0]).toBe("https://api.test/despachos/p1/libro/polizas/desde-cfdi");
    expect(JSON.parse(String(f.mock.calls[1]![1]!.body))).toEqual({ invoiceId: "inv-1" });
  });

  it("un error del servidor llega con su mensaje real", async () => {
    const f = respuesta({ code: "conflict", message: "el periodo 2026-07 está cerrado" }, 409);
    await expect(registrarPoliza(f as unknown as typeof fetch, "https://api.test", "tok", "p1", valida)).rejects.toThrow(/cerrado/);
  });
});
