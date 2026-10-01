// Lista 69-B (EFOS): parser del CSV publico del SAT y reglas de hallazgo sobre el
// resultado de validarCfdiDespachos. Fixture SINTETICO con RFC ficticios.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { aplicarEfosAlResultado, decodificarListado69B, Efos69bFormatoError, hallazgoEfosParaCfdi, parsearListado69B } from "../src/cfdi/efos.ts";
import type { EfosContribuyente } from "../src/cfdi/efos.ts";
import { validarCfdiDespachos } from "../src/cfdi/reglas-fiscales-avanzadas.ts";
import type { DatosCfdiDespachos } from "../src/cfdi/reglas-fiscales-avanzadas.ts";

const FIXTURE = readFileSync(fileURLToPath(new URL("./fixtures/efos-69b-muestra.csv", import.meta.url)), "utf8");

function contrib(situacion: EfosContribuyente["situacion"]): EfosContribuyente {
  return { rfc: "AAA010101AA1", nombre: "X", situacion, oficioPresuncion: null, fechaPresuncionSat: null, fechaDesvirtuadoSat: null, fechaDefinitivoSat: null, fechaSentenciaFavorableSat: null };
}

describe("parsearListado69B", () => {
  const r = parsearListado69B(FIXTURE);

  it("salta los renglones de titulo y encuentra el encabezado por nombre de columna", () => {
    expect(r.filas.map((f) => f.rfc)).toEqual(["AAA010101AA1", "BBB020202BB2", "CCC030303CC3", "DDD040404DD4"]);
  });

  it("normaliza las 4 situaciones del SAT", () => {
    expect(r.filas.map((f) => f.situacion)).toEqual(["definitivo", "presunto", "desvirtuado", "sentencia_favorable"]);
  });

  it("campos entrecomillados con comas y comillas escapadas", () => {
    expect(r.filas[0]!.nombre).toBe("EMPRESA FANTASMA, S.A. DE C.V.");
    expect(r.filas[1]!.nombre).toBe('SERVICIOS "ALFA" SA DE CV');
  });

  it("fechas dd/mm/yyyy -> ISO por etapa, y oficio de presuncion", () => {
    expect(r.filas[0]).toMatchObject({ fechaPresuncionSat: "2020-04-15", fechaDefinitivoSat: "2020-09-30", oficioPresuncion: "500-05-2020-1 de 01/03/2020" });
    expect(r.filas[2]).toMatchObject({ fechaDesvirtuadoSat: "2022-08-15", fechaDefinitivoSat: null });
    expect(r.filas[3]!.fechaSentenciaFavorableSat).toBe("2021-12-20");
  });

  it("descarta con motivo: RFC invalido, situacion desconocida y RFC duplicado (gana el primero)", () => {
    expect(r.descartadas.map((d) => d.motivo)).toEqual(["rfc_invalido", "situacion_desconocida", "rfc_duplicado"]);
    expect(r.filas[0]!.nombre).not.toBe("DUPLICADO");
  });

  it("el SHA-256 es estable e ignora BOM y CRLF vs LF; cambia si cambia el contenido", () => {
    const lf = FIXTURE.replace(/\r\n/g, "\n");
    expect(parsearListado69B("\uFEFF" + lf).fuenteSha256).toBe(r.fuenteSha256);
    expect(parsearListado69B(FIXTURE.replace("COMERCIAL BETA", "COMERCIAL BETA 2")).fuenteSha256).not.toBe(r.fuenteSha256);
    expect(r.fuenteSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fecha imposible (31/02) queda en null, no revienta", () => {
    const csv = "RFC,Situación del contribuyente,Publicación página SAT presuntos\nAAA010101AA1,Presunto,31/02/2026\n";
    expect(parsearListado69B(csv).filas[0]!.fechaPresuncionSat).toBeNull();
  });

  it("sin encabezado RFC/Situacion -> Efos69bFormatoError; archivo sin filas validas tambien", () => {
    expect(() => parsearListado69B("a,b,c\n1,2,3\n")).toThrow(Efos69bFormatoError);
    expect(() => parsearListado69B("RFC,Situación\nMAL,Presunto\n")).toThrow(/ninguna fila válida/);
  });
});

describe("decodificarListado69B", () => {
  it("UTF-8 valido se respeta; Windows-1252 no se corrompe", () => {
    expect(decodificarListado69B(Buffer.from("Situación", "utf8"))).toBe("Situación");
    expect(decodificarListado69B(Buffer.from("Situación", "latin1"))).toBe("Situación");
  });
  it("el encabezado en Windows-1252 sigue siendo reconocido por el parser", () => {
    const texto = decodificarListado69B(Buffer.from("RFC,Situación del contribuyente\nAAA010101AA1,Presunto\n", "latin1"));
    expect(parsearListado69B(texto).filas).toHaveLength(1);
  });
});

describe("hallazgoEfosParaCfdi", () => {
  it("definitivo -> issue bloqueante + revision", () => {
    const h = hallazgoEfosParaCfdi("AAA010101AA1", contrib("definitivo"), "2026-07");
    expect(h.issue?.codigo).toBe("efos_69b_definitivo");
    expect(h.requiereRevision).toBe(true);
  });
  it("presunto -> warning + revision, sin issue", () => {
    const h = hallazgoEfosParaCfdi("AAA010101AA1", contrib("presunto"), "2026-07");
    expect(h.issue).toBeNull();
    expect(h.warning).toMatch(/PRESUNTO/);
    expect(h.requiereRevision).toBe(true);
  });
  it("desvirtuado y sentencia favorable -> solo nota informativa, sin revision", () => {
    for (const s of ["desvirtuado", "sentencia_favorable"] as const) {
      const h = hallazgoEfosParaCfdi("AAA010101AA1", contrib(s), "2026-07");
      expect(h.issue).toBeNull();
      expect(h.requiereRevision).toBe(false);
      expect(h.warning).toMatch(/Informativo/);
    }
  });
  it("RFC fuera de la lista -> nada", () => {
    expect(hallazgoEfosParaCfdi("AAA010101AA1", null, "2026-07")).toEqual({ issue: null, warning: null, requiereRevision: false });
  });
});

describe("aplicarEfosAlResultado sobre validarCfdiDespachos", () => {
  const datos: DatosCfdiDespachos = {
    folioFiscal: "11111111-2222-3333-4444-555555555555", tipo: "I", subtotal: 1000, total: 1160, descuento: 0, iva: 160,
    conceptos: [{ cantidad: 1, valorUnitario: 1000, importe: 1000 }], usoCfdi: "G03", formaPago: "03", metodoPago: "PUE",
    regimenFiscalEmisor: "601", rfcEmisor: "AAA010101AA1", rfcReceptor: "BBB020202BB2", tieneSello: true, noCertificado: "00001000000504465028",
    fecha: "2026-07-01T10:00:00", fechaTimbrado: "2026-07-01T10:05:00",
  };
  const base = validarCfdiDespachos(datos);

  it("el CFDI base es valido (precondicion del resto)", () => {
    expect(base.ok).toBe(true);
  });

  it("definitivo invalida el CFDI y suma un fallo al contador, sin mutar el original", () => {
    const r = aplicarEfosAlResultado(base, hallazgoEfosParaCfdi("AAA010101AA1", contrib("definitivo"), "2026-07"));
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.codigo)).toContain("efos_69b_definitivo");
    expect(r.checks.fail).toBe(base.checks.fail + 1);
    expect(base.ok).toBe(true);
    expect(base.issues).not.toBe(r.issues);
  });

  it("presunto mantiene valido pero agrega warning", () => {
    const r = aplicarEfosAlResultado(base, hallazgoEfosParaCfdi("AAA010101AA1", contrib("presunto"), "2026-07"));
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => /PRESUNTO/.test(w))).toBe(true);
  });

  it("sin coincidencia devuelve el MISMO objeto (cero cambio de comportamiento)", () => {
    expect(aplicarEfosAlResultado(base, hallazgoEfosParaCfdi("AAA010101AA1", null, null))).toBe(base);
  });

  it("un CFDI ya sin revision (tipo T) pasa a requerir revision si el emisor es presunto", () => {
    const t = validarCfdiDespachos({ ...datos, tipo: "T", iva: null, total: 1000 });
    expect(t.requiresHumanReview).toBe(false);
    expect(aplicarEfosAlResultado(t, hallazgoEfosParaCfdi("AAA010101AA1", contrib("presunto"), "2026-07")).requiresHumanReview).toBe(true);
  });
});
