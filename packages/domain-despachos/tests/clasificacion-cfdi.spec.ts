// D-P3-13: clasificación contable de un CFDI (correcciones > ClaveProdServ > palabras) y su compuerta de revisión.
import { describe, expect, it } from "vitest";
import {
  CATEGORIAS_CONTABLES,
  NOMBRE_CATEGORIA,
  buscarCorreccion,
  clasificarCfdi,
  evaluarCompuertaClasificacion,
  validarUmbralConfianza,
} from "../src/bookkeeping/clasificacion-cfdi.ts";
import { DEFAULT_MAPPINGS } from "../src/bookkeeping/catalogo.ts";

const base = { tipo: "I", direccion: "recibido" as const, rfcEmisor: "AAA010101AAA" };

describe("clasificarCfdi", () => {
  it("nómina por TipoDeComprobante=N con confianza 0.95", () => {
    expect(clasificarCfdi({ ...base, tipo: "N", conceptos: [] })).toMatchObject({ categoria: "nomina", confianza: 0.95, metodo: "reglas", empate: false });
  });

  it("nota de crédito, traslado y pago no se clasifican solos (null)", () => {
    for (const tipo of ["E", "T", "P"]) expect(clasificarCfdi({ ...base, tipo, conceptos: [{ descripcion: "honorarios" }] })).toBeNull();
  });

  it("ClaveProdServ conocida sin descripción útil: 0.80 y metodo claveprodserv", () => {
    const r = clasificarCfdi({ ...base, conceptos: [{ claveProdServ: "43211503", descripcion: "Articulo 7788" }] })!;
    expect(r).toMatchObject({ categoria: "equipo_computo", metodo: "claveprodserv", confianza: 0.8, empate: false });
  });

  it("ClaveProdServ y descripción que coinciden suben a 0.90", () => {
    const r = clasificarCfdi({ ...base, conceptos: [{ claveProdServ: "43211503", descripcion: "Laptop 14 pulgadas" }] })!;
    expect(r).toMatchObject({ categoria: "equipo_computo", metodo: "claveprodserv", confianza: 0.9 });
  });

  it("ClaveProdServ y descripción en desacuerdo: empate, confianza 0.45 (bajo el piso)", () => {
    const r = clasificarCfdi({ ...base, conceptos: [{ claveProdServ: "43211503", descripcion: "Campaña de publicidad en redes sociales" }] })!;
    expect(r.empate).toBe(true);
    expect(r.confianza).toBeCloseTo(0.45, 10);
    expect(evaluarCompuertaClasificacion(r.confianza).requiereRevision).toBe(true);
  });

  it("dos conceptos con ClaveProdServ de categorías distintas: empate", () => {
    const r = clasificarCfdi({ ...base, conceptos: [{ claveProdServ: "43211503" }, { claveProdServ: "84131501" }] })!;
    expect(r.empate).toBe(true);
    expect(r.rivales).toBe(1);
  });

  it("sin ClaveProdServ: por descripción (palabra completa) con metodo reglas", () => {
    const r = clasificarCfdi({ ...base, conceptos: [{ descripcion: "Honorarios por asesoría y consultoría" }] })!;
    expect(r).toMatchObject({ categoria: "servicios_profesionales", metodo: "reglas", empate: false });
    expect(r.confianza).toBeGreaterThanOrEqual(0.7);
  });

  it("«renta de laptop» es un empate y no pasa la compuerta", () => {
    const r = clasificarCfdi({ ...base, conceptos: [{ descripcion: "Renta de laptop" }] })!;
    expect(r.empate).toBe(true);
    expect(evaluarCompuertaClasificacion(r.confianza)).toEqual({ requiereRevision: true, motivo: "clasificacion_baja" });
  });

  it("sin nada reconocible: otros con 0.30 (revisión)", () => {
    const r = clasificarCfdi({ ...base, conceptos: [{ descripcion: "xyz 123" }] })!;
    expect(r).toMatchObject({ categoria: "otros", confianza: 0.3, empate: false });
  });

  it("CFDI emitido usa los patrones de venta", () => {
    const r = clasificarCfdi({ ...base, direccion: "emitido", conceptos: [{ descripcion: "Venta de mercancía y producto" }] })!;
    expect(r.categoria).toBe("venta_mercancia");
  });

  it("toda categoría que se puede producir tiene mapeo contable de gasto o es de venta/otros", () => {
    for (const cat of CATEGORIAS_CONTABLES) {
      expect(DEFAULT_MAPPINGS[`I|${cat}`] ?? DEFAULT_MAPPINGS[`E|${cat}`], cat).toBeDefined();
    }
  });
});

describe("NOMBRE_CATEGORIA", () => {
  it("toda categoría contable tiene su nombre legible", () => {
    for (const c of CATEGORIAS_CONTABLES) expect(NOMBRE_CATEGORIA[c], c).toBeTruthy();
    expect(Object.keys(NOMBRE_CATEGORIA).sort()).toEqual([...CATEGORIAS_CONTABLES].sort());
  });
});

describe("correcciones del despacho por RFC", () => {
  const correcciones = [
    { rfcEmisor: "AAA010101AAA", claveProdServ: null, categoria: "publicidad", cuenta: null },
    { rfcEmisor: "AAA010101AAA", claveProdServ: "43211503", categoria: "mantenimiento", cuenta: "6020300" },
  ];

  it("se aplican ANTES de las reglas, con method correccion y confianza 0.95", () => {
    const r = clasificarCfdi({ ...base, conceptos: [{ descripcion: "Honorarios por consultoría" }] }, correcciones)!;
    expect(r).toMatchObject({ categoria: "publicidad", metodo: "correccion", confianza: 0.95, empate: false, cuenta: null });
    expect(evaluarCompuertaClasificacion(r.confianza).requiereRevision).toBe(false);
  });

  it("la corrección con ClaveProdServ exacta gana a la general del RFC y trae su cuenta", () => {
    const r = clasificarCfdi({ ...base, conceptos: [{ claveProdServ: "43211503", descripcion: "x" }] }, correcciones)!;
    expect(r).toMatchObject({ categoria: "mantenimiento", cuenta: "6020300" });
  });

  it("no cruza RFC: la corrección de otro emisor no aplica", () => {
    expect(buscarCorreccion("BBB010101BBB", [], correcciones)).toBeNull();
    const r = clasificarCfdi({ ...base, rfcEmisor: "BBB010101BBB", conceptos: [{ descripcion: "Honorarios por consultoría" }] }, correcciones)!;
    expect(r.metodo).toBe("reglas");
  });

  it("compara el RFC sin importar mayúsculas", () => {
    expect(buscarCorreccion("aaa010101aaa", [], correcciones)?.categoria).toBe("publicidad");
  });
});

describe("evaluarCompuertaClasificacion y umbral", () => {
  it("bajo el piso 0.5 siempre revisa, incluso con umbral bajo", () => {
    expect(evaluarCompuertaClasificacion(0.45, { umbral: 0.5 }).requiereRevision).toBe(true);
  });
  it("entre el piso y el umbral del despacho revisa; en el umbral pasa", () => {
    expect(evaluarCompuertaClasificacion(0.65).requiereRevision).toBe(true);
    expect(evaluarCompuertaClasificacion(0.7).requiereRevision).toBe(false);
    expect(evaluarCompuertaClasificacion(0.65, { umbral: 0.6 }).requiereRevision).toBe(false);
  });
  it("un umbral bajo el piso se eleva al piso (el piso nunca deja de actuar)", () => {
    expect(evaluarCompuertaClasificacion(0.49, { umbral: 0.1 }).requiereRevision).toBe(true);
    expect(evaluarCompuertaClasificacion(0.5, { umbral: 0.1 }).requiereRevision).toBe(false);
  });
  it("validarUmbralConfianza: umbral >= piso y <= 1", () => {
    expect(validarUmbralConfianza(0.7)).toEqual({ ok: true, umbral: 0.7 });
    expect(validarUmbralConfianza(0.5)).toEqual({ ok: true, umbral: 0.5 });
    expect(validarUmbralConfianza(0.49).ok).toBe(false);
    expect(validarUmbralConfianza(1.01).ok).toBe(false);
    expect(validarUmbralConfianza("0.7").ok).toBe(false);
    expect(validarUmbralConfianza(Number.NaN).ok).toBe(false);
  });
});
