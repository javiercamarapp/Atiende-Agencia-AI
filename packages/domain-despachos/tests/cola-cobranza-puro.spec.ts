// D-11 -- logica pura de la cola de cobranza: dinero en centavos, validacion, orden de la cola, WhatsApp y
// reporte de cartera/antiguedad (bordes: corte exacto, cuentas sin nombre, RFC repetido, cartera vacia).
import { describe, expect, it } from "vitest";
import {
  CUBETAS_ANTIGUEDAD,
  construirMensajeWhatsApp,
  construirReporteCartera,
  cubetaAntiguedad,
  dedupeKeyWhatsApp,
  esCentavosValidos,
  formatearCentavosMxn,
  normalizarRfc,
  normalizarTelefono,
  ordenarCola,
  pesosACentavos,
  urgenciaGestion,
  validarNuevaGestion,
} from "../src/index.ts";
import type { GestionCobranza } from "../src/index.ts";

describe("montos en centavos", () => {
  it("convierte pesos con decimales flotantes sin perder un centavo", () => {
    expect(pesosACentavos(1160.1)).toBe(116010);
    expect(pesosACentavos(0.07)).toBe(7);
    expect(pesosACentavos(19.99)).toBe(1999);
    expect(pesosACentavos(0)).toBe(0);
    expect(() => pesosACentavos(Number.NaN)).toThrow(RangeError);
  });

  it("solo acepta enteros positivos seguros", () => {
    expect(esCentavosValidos(1)).toBe(true);
    expect(esCentavosValidos(150000)).toBe(true);
    for (const malo of [0, -1, 1.5, "100", null, Number.MAX_SAFE_INTEGER + 1, 100_000_000_000_000]) expect(esCentavosValidos(malo)).toBe(false);
  });

  it("formatea desde centavos enteros", () => {
    expect(formatearCentavosMxn(116000)).toBe("$1,160.00 MXN");
    expect(formatearCentavosMxn(5)).toBe("$0.05 MXN");
    expect(formatearCentavosMxn(123456789)).toBe("$1,234,567.89 MXN");
    expect(formatearCentavosMxn(-250)).toBe("-$2.50 MXN");
    expect(() => formatearCentavosMxn(1.5)).toThrow(RangeError);
  });
});

describe("validarNuevaGestion", () => {
  const base = { tipo: "nota" as const, nota: "x", montoPromesaCentavos: null, fechaPromesa: null, fechaSeguimiento: null };
  const HOY = "2026-10-01";

  it("acepta cada tipo valido", () => {
    expect(validarNuevaGestion(base, HOY)).toBeNull();
    expect(validarNuevaGestion({ ...base, tipo: "recordatorio", nota: null }, HOY)).toBeNull();
    expect(validarNuevaGestion({ ...base, tipo: "promesa_pago", nota: null, montoPromesaCentavos: 100, fechaPromesa: "2026-10-15" }, HOY)).toBeNull();
  });

  it("rechaza promesas mal formadas y notas fuera de rango", () => {
    expect(validarNuevaGestion({ ...base, tipo: "promesa_pago", montoPromesaCentavos: null, fechaPromesa: "2026-10-15" }, HOY)).toMatch(/montoPromesaCentavos/);
    expect(validarNuevaGestion({ ...base, tipo: "promesa_pago", montoPromesaCentavos: 100.5, fechaPromesa: "2026-10-15" }, HOY)).toMatch(/entero/);
    expect(validarNuevaGestion({ ...base, tipo: "promesa_pago", montoPromesaCentavos: 100, fechaPromesa: null }, HOY)).toMatch(/fechaPromesa/);
    expect(validarNuevaGestion({ ...base, tipo: "promesa_pago", montoPromesaCentavos: 100, fechaPromesa: "2026-02-31" }, HOY)).toMatch(/fechaPromesa/);
    expect(validarNuevaGestion({ ...base, tipo: "promesa_pago", montoPromesaCentavos: 100, fechaPromesa: "2028-01-01" }, HOY)).toMatch(/un ano/);
    expect(validarNuevaGestion({ ...base, montoPromesaCentavos: 100 }, HOY)).toMatch(/solo aplican/);
    expect(validarNuevaGestion({ ...base, tipo: "llamada", nota: null }, HOY)).toMatch(/obligatoria/);
    expect(validarNuevaGestion({ ...base, nota: "   " }, HOY)).toMatch(/nota/);
    expect(validarNuevaGestion({ ...base, nota: "a".repeat(1001) }, HOY)).toMatch(/1000/);
    expect(validarNuevaGestion({ ...base, fechaSeguimiento: "manana" }, HOY)).toMatch(/fechaSeguimiento/);
  });

  it("el borde de un ano es inclusivo (365 dias si, 366 no)", () => {
    expect(validarNuevaGestion({ ...base, fechaSeguimiento: "2027-10-01" }, HOY)).toBeNull();
    expect(validarNuevaGestion({ ...base, fechaSeguimiento: "2027-10-02" }, HOY)).toMatch(/un ano/);
  });
});

function gestion(p: Partial<GestionCobranza> & { id: string }): GestionCobranza {
  return { receivableId: "r1", tipo: "nota", estado: "pendiente", montoPromesaCentavos: null, fechaPromesa: null, fechaSeguimiento: null, nota: null, creadoEn: "2026-09-01T10:00:00.000Z", actualizadoEn: "2026-09-01T10:00:00.000Z", ...p };
}

describe("cola de trabajo", () => {
  const HOY = "2026-10-01";
  it("clasifica la urgencia contra la fecha de negocio", () => {
    expect(urgenciaGestion(gestion({ id: "a", tipo: "promesa_pago", fechaPromesa: "2026-09-30" }), HOY)).toBe("promesa_vencida");
    expect(urgenciaGestion(gestion({ id: "a", tipo: "promesa_pago", fechaPromesa: HOY }), HOY)).toBe("vence_hoy");
    expect(urgenciaGestion(gestion({ id: "a", fechaSeguimiento: "2026-09-29" }), HOY)).toBe("seguimiento_vencido");
    expect(urgenciaGestion(gestion({ id: "a", fechaSeguimiento: "2026-10-02" }), HOY)).toBe("programada");
    expect(urgenciaGestion(gestion({ id: "a" }), HOY)).toBe("programada");
  });

  it("ordena: promesa vencida, seguimiento vencido, hoy, programada; excluye las resueltas", () => {
    const items = [
      { gestion: gestion({ id: "prog", fechaSeguimiento: "2026-10-05" }) },
      { gestion: gestion({ id: "hoy", fechaSeguimiento: HOY }) },
      { gestion: gestion({ id: "seg", fechaSeguimiento: "2026-09-20" }) },
      { gestion: gestion({ id: "prom-b", tipo: "promesa_pago", fechaPromesa: "2026-09-25", montoPromesaCentavos: 1 }) },
      { gestion: gestion({ id: "prom-a", tipo: "promesa_pago", fechaPromesa: "2026-09-10", montoPromesaCentavos: 1 }) },
      { gestion: gestion({ id: "hecha", estado: "cumplida", fechaSeguimiento: "2026-09-01" }) },
    ];
    expect(ordenarCola(items, HOY).map((x) => x.item.gestion.id)).toEqual(["prom-a", "prom-b", "seg", "hoy", "prog"]);
  });
});

describe("whatsapp: normalizacion y mensaje", () => {
  it("normaliza telefonos mexicanos y E.164", () => {
    expect(normalizarTelefono("998 123 4567")).toBe("+529981234567");
    expect(normalizarTelefono("(998) 123-4567")).toBe("+529981234567");
    expect(normalizarTelefono("+52 1 998 123 4567")).toBe("+529981234567");
    expect(normalizarTelefono("5219981234567")).toBe("+529981234567");
    expect(normalizarTelefono("529981234567")).toBe("+529981234567");
    expect(normalizarTelefono("+14155550123")).toBe("+14155550123");
  });
  it("rechaza lo que no es un telefono", () => {
    for (const malo of ["", "   ", "123", "abc", "+0123456789", "99812345678901234567", "+52"]) expect(normalizarTelefono(malo)).toBeNull();
  });
  it("normaliza RFC a mayusculas y rechaza formas invalidas", () => {
    expect(normalizarRfc(" xaxx010101000 ")).toBe("XAXX010101000");
    expect(normalizarRfc("PEÑ800101AB1")).toBe("PEÑ800101AB1");
    expect(normalizarRfc("XX")).toBeNull();
    expect(normalizarRfc("XAXX01010100")).toBeNull();
  });
  it("el mensaje usa las plantillas del motor y formatea el monto desde centavos", () => {
    const m = construirMensajeWhatsApp({ facturaId: "F-1", nombreCliente: "Cliente SA", saldoCentavos: 1250000, diasVencido: 7, etapa: "recordatorio_formal" });
    expect(m).toContain("12,500.00");
    expect(m.length).toBeGreaterThan(10);
    expect(m.length).toBeLessThanOrEqual(1000);
  });
  it("la llave de idempotencia es determinista por cuenta, etapa y dia", () => {
    expect(dedupeKeyWhatsApp("r1", "vencimiento", "2026-10-01")).toBe("cobranza-wa:r1:vencimiento:2026-10-01");
  });
});

describe("reporte de cartera y antiguedad", () => {
  const HOY = "2026-10-01";
  it("las cubetas separan lo corriente y respetan los bordes 30/60/90", () => {
    expect([-5, 0, 1, 30, 31, 60, 61, 90, 91, 400].map(cubetaAntiguedad)).toEqual(["corriente", "corriente", "1-30", "1-30", "31-60", "31-60", "61-90", "61-90", "90+", "90+"]);
    expect(CUBETAS_ANTIGUEDAD).toHaveLength(5);
  });

  it("agrupa por RFC, suma en centavos y cuadra detalle contra resumen", () => {
    const r = construirReporteCartera({
      hoy: HOY,
      contribuyente: { nombre: "Cliente Demo", rfc: "AAA010101AA1" },
      cuentas: [
        { folioFiscal: "f1", rfcReceptor: "RRR010101RR1", clienteNombre: null, saldoCentavos: 116010, fechaVencimiento: "2026-10-05" },
        { folioFiscal: "f2", rfcReceptor: "RRR010101RR1", clienteNombre: "Ruiz SA", saldoCentavos: 58000, fechaVencimiento: "2026-09-01" },
        { folioFiscal: "f3", rfcReceptor: "RRS020202RS2", clienteNombre: "Sanchez", saldoCentavos: 23200, fechaVencimiento: "2026-06-01" },
      ],
    });
    expect(r.sinDatos).toBe(false);
    expect(r.etiquetaPeriodo).toBe("Corte al 2026-10-01");
    expect(r.totalesCentavos).toEqual({ corriente: 116010, "1-30": 58000, "31-60": 0, "61-90": 0, "90+": 23200, total: 197210 });
    const [resumen, detalle] = r.secciones;
    expect(resumen!.filas).toHaveLength(2);
    // El cliente con mas saldo va primero y toma el nombre capturado de cualquiera de sus CFDI.
    expect(resumen!.filas[0]).toMatchObject({ rfc: "RRR010101RR1", cliente: "Ruiz SA", facturas: 2, total: 1740.1 });
    expect(resumen!.totales).toMatchObject({ total: 1972.1, facturas: 3 });
    expect(detalle!.filas.map((f) => f.folio)).toEqual(["f3", "f2", "f1"]);
    expect(detalle!.filas[0]).toMatchObject({ dias: 122, cubeta: "90+" });
    expect(detalle!.totales).toMatchObject({ saldo: 1972.1 });
  });

  it("una cartera vacia declara 'sin datos' con su motivo, nunca ceros inventados", () => {
    const r = construirReporteCartera({ hoy: HOY, contribuyente: { nombre: "X", rfc: null }, cuentas: [] });
    expect(r.sinDatos).toBe(true);
    for (const s of r.secciones) {
      expect(s.sinDatosMotivo).toMatch(/No hay cuentas/);
      expect(s.filas).toHaveLength(0);
      expect(s.totales).toBeNull();
    }
    expect(r.totalesCentavos.total).toBe(0);
  });

  it("el dia de corte es el dia de vencimiento: 0 dias = corriente", () => {
    const r = construirReporteCartera({ hoy: HOY, contribuyente: { nombre: "X", rfc: null }, cuentas: [{ folioFiscal: "f", rfcReceptor: "RRR010101RR1", clienteNombre: "R", saldoCentavos: 100, fechaVencimiento: HOY }] });
    expect(r.secciones[1]!.filas[0]).toMatchObject({ dias: 0, cubeta: "corriente" });
  });
});
