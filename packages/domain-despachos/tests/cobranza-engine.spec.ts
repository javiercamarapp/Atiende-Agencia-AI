import { describe, expect, it } from "vitest";
import {
  analizarCarteraCobranza,
  cobranzaAgeBucket,
  construirRecordatorioCobranza,
  diasVencidoCartera,
  etapaRecordatorioCobranzaHoy,
  proyeccionCobranza,
  reporteAntiguedadCartera,
  resumenCobranza,
  scoreCobrabilidadCartera,
  type CuentaPorCobrarInput,
} from "../src/cobranza/engine.ts";
import { formatMontoCobranza } from "../src/cobranza/templates.ts";

describe("cobranzaAgeBucket (port literal de age_bucket)", () => {
  it("no vencida o al corriente -> 0-30", () => {
    expect(cobranzaAgeBucket(-5)).toBe("0-30");
    expect(cobranzaAgeBucket(0)).toBe("0-30");
    expect(cobranzaAgeBucket(30)).toBe("0-30");
  });
  it("31-60", () => {
    expect(cobranzaAgeBucket(31)).toBe("31-60");
    expect(cobranzaAgeBucket(60)).toBe("31-60");
  });
  it("61-90", () => {
    expect(cobranzaAgeBucket(61)).toBe("61-90");
    expect(cobranzaAgeBucket(90)).toBe("61-90");
  });
  it("90+", () => {
    expect(cobranzaAgeBucket(91)).toBe("90+");
    expect(cobranzaAgeBucket(500)).toBe("90+");
  });
});

describe("diasVencidoCartera (port literal de days_overdue)", () => {
  it("positivo cuando ya venció", () => expect(diasVencidoCartera("2026-01-01", "2026-01-15")).toBe(14));
  it("negativo cuando todavía no vence", () => expect(diasVencidoCartera("2026-02-01", "2026-01-15")).toBe(-17));
  it("cero el mismo día", () => expect(diasVencidoCartera("2026-01-15", "2026-01-15")).toBe(0));
});

describe("etapaRecordatorioCobranzaHoy (port literal de reminder_stage)", () => {
  const vencimiento = "2026-02-10";
  it("7 días antes -> pre_vencimiento", () => expect(etapaRecordatorioCobranzaHoy(vencimiento, "2026-02-03")).toBe("pre_vencimiento"));
  it("el día -> vencimiento", () => expect(etapaRecordatorioCobranzaHoy(vencimiento, "2026-02-10")).toBe("vencimiento"));
  it("+7 días -> recordatorio_formal", () => expect(etapaRecordatorioCobranzaHoy(vencimiento, "2026-02-17")).toBe("recordatorio_formal"));
  it("+30 días -> segundo_recordatorio", () => expect(etapaRecordatorioCobranzaHoy(vencimiento, "2026-03-12")).toBe("segundo_recordatorio"));
  it("+60 días -> escalamiento", () => expect(etapaRecordatorioCobranzaHoy(vencimiento, "2026-04-11")).toBe("escalamiento"));
  it("cualquier otro día -> null (no toca enviar recordatorio hoy)", () => {
    expect(etapaRecordatorioCobranzaHoy(vencimiento, "2026-02-05")).toBeNull();
    expect(etapaRecordatorioCobranzaHoy(vencimiento, "2026-02-20")).toBeNull();
  });
});

describe("scoreCobrabilidadCartera (port literal de collectability_score)", () => {
  it("base por antigüedad sin historial", () => {
    expect(scoreCobrabilidadCartera(10)).toBe(0.75); // 0-30
    expect(scoreCobrabilidadCartera(45)).toBe(0.55); // 31-60
    expect(scoreCobrabilidadCartera(75)).toBe(0.38); // 61-90
    expect(scoreCobrabilidadCartera(120)).toBe(0.22); // 90+
  });

  it("respuesta 'pagado' en el historial -> score 1.0 sin importar antigüedad", () => {
    expect(scoreCobrabilidadCartera(200, [{ tipoRecordatorio: "respuesta", respuesta: "pagado" }])).toBe(1.0);
  });

  it("respuesta 'promesa_pago' -> +0.15 y +0.10 adicional por haber respuesta (recortado a 1.0)", () => {
    // 0.75 base (0-30) + 0.15 (promesa_pago) + 0.10 (hubo respuesta) = 1.0, recortado a 1.0
    expect(scoreCobrabilidadCartera(10, [{ tipoRecordatorio: "respuesta", respuesta: "promesa_pago" }])).toBe(1.0);
  });

  it("promesa_pago sobre una cuenta más vieja no llega al tope -> se ve el +0.15 y +0.10 completos", () => {
    // 0.22 base (90+) + 0.15 (promesa_pago) + 0.10 (hubo respuesta) = 0.47
    expect(scoreCobrabilidadCartera(120, [{ tipoRecordatorio: "respuesta", respuesta: "promesa_pago" }])).toBeCloseTo(0.47, 5);
  });

  it("cada etapa de escalamiento alcanzada resta 0.05", () => {
    const historial = [
      { tipoRecordatorio: "segundo_recordatorio", respuesta: null },
      { tipoRecordatorio: "escalamiento", respuesta: null },
    ];
    // 0.22 (90+) sin ajuste por respuesta (ninguna), -0.05*2 = 0.12
    expect(scoreCobrabilidadCartera(120, historial)).toBe(0.12);
  });

  it("el score nunca baja de 0 ni sube de 1", () => {
    const muchoEscalamiento = Array.from({ length: 10 }, () => ({ tipoRecordatorio: "escalamiento", respuesta: null }));
    expect(scoreCobrabilidadCartera(120, muchoEscalamiento)).toBe(0);
  });
});

describe("analizarCarteraCobranza (port literal de CollectionsManager.analyze)", () => {
  const cuentas: readonly CuentaPorCobrarInput[] = [
    { facturaId: "F-1", nombreCliente: "Cliente A", monto: 1000, fechaVencimiento: "2026-01-01" }, // 45 días vencida al 2026-02-15
    { facturaId: "F-2", nombreCliente: "Cliente B", monto: 500, fechaVencimiento: "2026-02-20" }, // no vencida
    { facturaId: "F-3", nombreCliente: "Cliente C", monto: 2000, fechaVencimiento: "2025-10-01" }, // 137 días vencida
  ];

  it("clasifica cada cuenta y agrega totales por bucket", () => {
    const resultado = analizarCarteraCobranza(cuentas, "2026-02-15");
    expect(resultado.totalInvoices).toBe(3);
    expect(resultado.totalMonto).toBe(3500);
    expect(resultado.buckets["31-60"]).toEqual({ count: 1, monto: 1000 });
    expect(resultado.buckets["0-30"]).toEqual({ count: 1, monto: 500 });
    expect(resultado.buckets["90+"]).toEqual({ count: 1, monto: 2000 });

    const f1 = resultado.invoices.find((i) => i.facturaId === "F-1")!;
    expect(f1.diasVencido).toBe(45);
    expect(f1.bucket).toBe("31-60");
    expect(f1.score).toBe(0.55);
  });

  it("cartera vacía -> totales en cero, nunca NaN", () => {
    const resultado = analizarCarteraCobranza([], "2026-02-15");
    expect(resultado.totalInvoices).toBe(0);
    expect(resultado.totalMonto).toBe(0);
    expect(resultado.buckets["0-30"]).toEqual({ count: 0, monto: 0 });
  });

  it("usa el historial por facturaId para ajustar el score", () => {
    const historiales = new Map([["F-2", [{ tipoRecordatorio: "respuesta", respuesta: "pagado" as const }]]]);
    const resultado = analizarCarteraCobranza(cuentas, "2026-02-15", historiales);
    const f2 = resultado.invoices.find((i) => i.facturaId === "F-2")!;
    expect(f2.score).toBe(1.0);
  });
});

describe("reporteAntiguedadCartera / proyeccionCobranza / resumenCobranza (port de collections_report.py)", () => {
  const analizada = analizarCarteraCobranza(
    [
      { facturaId: "F-1", nombreCliente: "Cliente A", monto: 1000, fechaVencimiento: "2026-01-01" },
      { facturaId: "F-2", nombreCliente: "Cliente B", monto: 500, fechaVencimiento: "2026-02-20" },
      { facturaId: "F-3", nombreCliente: "Cliente C", monto: 2000, fechaVencimiento: "2025-10-01" },
    ],
    "2026-02-15",
  ).invoices;

  it("reporteAntiguedadCartera recalcula bucket/dias y respeta el score ya calculado", () => {
    const aging = reporteAntiguedadCartera(analizada, "2026-02-15");
    expect(aging.totalCount).toBe(3);
    expect(aging.totalMonto).toBe(3500);
    expect(aging.invoices.find((i) => i.facturaId === "F-3")!.score).toBe(0.22);
  });

  it("proyeccionCobranza pondera monto x score y agrupa por rango", () => {
    const proj = proyeccionCobranza(analizada, "2026-02-15");
    // F-1: 1000*0.55=550, F-2: 500*0.75=375, F-3: 2000*0.22=440 -> total esperado 1365
    expect(proj.totalCartera).toBe(3500);
    expect(proj.totalEsperado).toBeCloseTo(1365, 5);
    expect(proj.porScore.media.count).toBe(1); // F-1 (0.55)
    expect(proj.porScore.alta.count).toBe(1); // F-2 (0.75)
    expect(proj.porScore.baja.count).toBe(1); // F-3 (0.22)
  });

  it("proyeccionCobranza sin cuentas -> tasa 0, nunca NaN", () => {
    expect(proyeccionCobranza([], "2026-02-15").tasaRecuperacionEsperada).toBe(0);
  });

  it("resumenCobranza genera alertas para 90+ y score bajo, y el top 5 de montos", () => {
    const resumen = resumenCobranza(analizada, "2026-02-15");
    expect(resumen.totalCartera).toBe(3500);
    expect(resumen.alertas.some((a) => a.includes("más de 90 días"))).toBe(true);
    expect(resumen.alertas.some((a) => a.includes("score de cobrabilidad bajo"))).toBe(true);
    expect(resumen.topMontos[0]!.facturaId).toBe("F-3"); // monto más alto primero
    expect(resumen.topMontos).toHaveLength(3);
  });
});

describe("construirRecordatorioCobranza (port literal de build_reminder) — NO envía nada, solo genera contenido", () => {
  const factura = { facturaId: "F-9", nombreCliente: "Despacho Ejemplo SA de CV", monto: 12500, diasVencido: 7 };

  it("email incluye subject y body con las variables sustituidas", () => {
    const msg = construirRecordatorioCobranza(factura, "recordatorio_formal", "email");
    expect(msg.channel).toBe("email");
    expect(msg.subject).toContain("F-9");
    expect(msg.body).toContain("Despacho Ejemplo SA de CV");
    expect(msg.body).toContain(formatMontoCobranza(12500));
    expect(msg.body).toContain("7 días");
    expect(msg.whatsapp).toBeUndefined();
  });

  it("whatsapp genera solo el texto directo", () => {
    const msg = construirRecordatorioCobranza(factura, "escalamiento", "whatsapp");
    expect(msg.channel).toBe("whatsapp");
    expect(msg.whatsapp).toContain("F-9");
    expect(msg.whatsapp).toContain("gerencia");
    expect(msg.subject).toBeUndefined();
    expect(msg.body).toBeUndefined();
  });

  it("cada etapa tiene su propio tono/contenido (secuencia completa)", () => {
    const etapas = ["pre_vencimiento", "vencimiento", "recordatorio_formal", "segundo_recordatorio", "escalamiento"] as const;
    const subjects = etapas.map((e) => construirRecordatorioCobranza(factura, e, "email").subject);
    expect(new Set(subjects).size).toBe(5); // ningún subject se repite entre etapas
  });
});

describe("formatMontoCobranza", () => {
  it("formatea con separador de miles y 2 decimales + sufijo MXN", () => {
    expect(formatMontoCobranza(12500)).toBe("$12,500.00 MXN");
    expect(formatMontoCobranza(0)).toBe("$0.00 MXN");
  });
});
