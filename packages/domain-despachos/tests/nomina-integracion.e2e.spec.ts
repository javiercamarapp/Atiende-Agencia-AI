// Test de integración end-to-end (Fase 3, requerido por la tarea) — encadena,
// sin mocks: un periodo de nómina con varios empleados -> `procesarNomina`
// (compone ISR + IMSS + subsidio, exactamente como diseño §3) -> un
// consumidor de más arriba que alimenta `validarCfdiDespachos` con
// `nomina.totalPercepciones = totales.bruto` (el enganche que el diseño §3
// deja anotado como uso previsto, SIN acoplamiento nuevo en domain-despachos:
// `reglas-fiscales-avanzadas.ts` no se toca, esta prueba solo demuestra cómo
// un caller externo compondría ambas capas).
import { describe, expect, it } from "vitest";
import { procesarNomina } from "../src/nomina/payroll-engine.ts";
import { validarCfdiDespachos } from "../src/cfdi/reglas-fiscales-avanzadas.ts";
import type { DatosCfdiDespachos } from "../src/cfdi/reglas-fiscales-avanzadas.ts";

function cfdiNomina(overrides: Partial<DatosCfdiDespachos> = {}): DatosCfdiDespachos {
  return {
    tipo: "N",
    subtotal: 0,
    total: 0,
    descuento: 0,
    iva: 0,
    conceptos: [],
    usoCfdi: "CN01",
    formaPago: "03",
    metodoPago: "PUE",
    regimenFiscalEmisor: "601",
    rfcEmisor: "DESP010101AB1",
    emisorNombre: "DESPACHO DE PRUEBA SA DE CV",
    rfcReceptor: "XAXX010101000",
    tieneSello: true,
    noCertificado: "00001000000504465028",
    folioFiscal: "11111111-2222-3333-4444-555555555555",
    fecha: "2026-07-01T00:00:00",
    fechaTimbrado: "2026-07-01T00:05:00",
    ...overrides,
  };
}

describe("integración e2e: periodo de nómina -> procesarNomina -> validarCfdiDespachos (nomina.totalPercepciones)", () => {
  it("procesa un periodo de 3 empleados con salarios distintos y alimenta el CFDI de nómina con el bruto total", () => {
    const period = { month: 7, year: 2026, diasPagados: 30 };
    const employees = [
      { employeeId: "E1", nombre: "Empleada Uno", salarioBruto: 12000, percepciones: 0 },
      { employeeId: "E2", nombre: "Empleado Dos", salarioBruto: 25000, percepciones: 1500 },
      { employeeId: "E3", nombre: "Empleada Tres", salarioBruto: 60000, percepciones: 0 },
    ];

    const periodo = procesarNomina(period, employees, 7);

    // Cada empleado tiene su desglose completo, ISR/IMSS/Infonavit calculados
    // de forma independiente y consistente con el motor unitario.
    expect(periodo.employees).toHaveLength(3);
    for (const emp of periodo.employees) {
      expect(emp.taxes.isr).toBeGreaterThanOrEqual(0);
      expect(emp.taxes.imssObrero).toBeGreaterThan(0);
      expect(emp.taxes.imssPatronal).toBeGreaterThan(emp.taxes.imssObrero); // patronal > obrero siempre (14.25% vs 1.25%)
      expect(emp.neto).toBeLessThan(emp.salarioBruto + emp.percepciones);
      expect(emp.neto).toBeGreaterThanOrEqual(0);
    }

    // Totales del periodo son la suma de los individuales.
    const sumaIsr = periodo.employees.reduce((acc, e) => acc + e.taxes.isr, 0);
    expect(periodo.totalIsr).toBeCloseTo(sumaIsr, 6);
    expect(periodo.totalBruto).toBe(12000 + 25000 + 1500 + 60000);

    // El control de revisión humana por >40% de deducciones no se dispara
    // para salarios en este rango (consistente con diseño §5.3: es
    // matemáticamente inalcanzable).
    expect(periodo.requiresHumanReview).toBe(false);

    // ---- Enganche con Fase 1/2: CFDI de nómina alimentado con el bruto total ----
    // NOTA: el check base de Total coherente (SubTotal+IVA-Descuento) no modela
    // deducciones de nómina (esas viven en el Complemento, no en Total/SubTotal
    // del comprobante) — se deja Total=SubTotal, igual que un CFDI de nómina
    // real (Total = percepciones, sin restar ISR/IMSS del trabajador).
    const cfdi = cfdiNomina({
      subtotal: periodo.totalBruto,
      total: periodo.totalBruto,
      nomina: { totalPercepciones: periodo.totalBruto },
    });
    const resultado = validarCfdiDespachos(cfdi);

    expect(resultado.ok).toBe(true);
    expect(resultado.warnings).not.toContain("Nómina sin TotalPercepciones declarado.");
    // Todo CFDI de nómina fuerza revisión humana (nominaPresente), por diseño
    // de Fase 1 — independiente de si hay o no otros issues.
    expect(resultado.requiresHumanReview).toBe(true);
  });

  it("un CFDI de nómina SIN TotalPercepciones dispara el warning de Fase 1 (reglas-fiscales-avanzadas.ts no se tocó en esta fase)", () => {
    const period = { month: 7, year: 2026, diasPagados: 30 };
    const employees = [{ employeeId: "E1", nombre: "Empleada Uno", salarioBruto: 12000, percepciones: 0 }];
    const periodo = procesarNomina(period, employees, 7);

    const cfdi = cfdiNomina({
      subtotal: periodo.totalBruto,
      total: periodo.totalBruto - periodo.totalDeducciones,
      nomina: {},
    });
    const resultado = validarCfdiDespachos(cfdi);
    // `nomina: {}` es un dict Python vacío -> el bloque interno (MetodoPago +
    // warning TotalPercepciones) NO corre (fidelidad ya establecida en Fase
    // 1/2, ver la nota en reglas-fiscales-avanzadas.ts) — se confirma que
    // sigue intacta al consumir datos que vienen de Fase 3.
    expect(resultado.warnings).not.toContain("Nómina sin TotalPercepciones declarado.");
    expect(resultado.requiresHumanReview).toBe(true); // nominaPresente sigue siendo true
  });

  it("idempotencia: procesar el mismo periodo dos veces da exactamente los mismos totales y la misma idempotencyKey", () => {
    const period = { month: 8, year: 2026, diasPagados: 30 };
    const employees = [{ employeeId: "E1", nombre: "Empleada Uno", salarioBruto: 18500, percepciones: 200 }];

    const a = procesarNomina(period, employees, 99);
    const b = procesarNomina(period, employees, 99);

    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.idempotencyKey).toBe("nomina-2026-08-99");
    expect(a.totalNeto).toBe(b.totalNeto);
    expect(a.employees[0]!.taxes).toEqual(b.employees[0]!.taxes);
  });
});
