import { afterEach, describe, expect, it, vi } from "vitest";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import { computePaymentDueDate, classifyInvoiceStatus, summarizeReceivables, LAASSP_ART_73_PAYMENT_TERM_BUSINESS_DAYS } from "../src/contract-billing.ts";

describe("contract-billing.ts -- cobranza determinista (REQ-051)", () => {
  it("computePaymentDueDate suma 17 días hábiles (Art. 73 LAASSP) desde la verificación de la factura", () => {
    const result = computePaymentDueDate("2026-01-05"); // lunes
    expect(result.businessDays).toBe(LAASSP_ART_73_PAYMENT_TERM_BUSINESS_DAYS);
    expect(result.legalReference).toMatch(/Art\. 73/);
    expect(result.dueDate > "2026-01-05").toBe(true);
  });

  it("computePaymentDueDate respeta feriados declarados explícitamente", () => {
    const withoutHolidays = computePaymentDueDate("2026-01-05");
    const withHolidays = computePaymentDueDate("2026-01-05", [withoutHolidays.dueDate]);
    expect(withHolidays.dueDate > withoutHolidays.dueDate).toBe(true);
  });

  it("classifyInvoiceStatus: pagada si tiene paidAt, sin importar la fecha", () => {
    expect(classifyInvoiceStatus({ dueDate: "2020-01-01", paidAt: "2026-01-01T00:00:00Z" }, "2026-06-01")).toBe("pagada");
  });

  it("classifyInvoiceStatus: vencida si hoy > dueDate y no se ha pagado", () => {
    expect(classifyInvoiceStatus({ dueDate: "2026-01-01", paidAt: null }, "2026-01-02")).toBe("vencida");
  });

  it("classifyInvoiceStatus: pendiente si hoy <= dueDate y no se ha pagado", () => {
    expect(classifyInvoiceStatus({ dueDate: "2026-01-10", paidAt: null }, "2026-01-05")).toBe("pendiente");
    expect(classifyInvoiceStatus({ dueDate: "2026-01-10", paidAt: null }, "2026-01-10")).toBe("pendiente"); // el día mismo del vencimiento todavía no está vencida.
  });

  it("summarizeReceivables suma en Decimal (nunca number flotante) -- pendiente incluye lo vencido como subconjunto", () => {
    const summary = summarizeReceivables(
      [
        { amount: "1000.00", dueDate: "2026-01-01", paidAt: null }, // vencida al 2026-02-01
        { amount: "250.50", dueDate: "2026-03-01", paidAt: null }, // pendiente, no vencida
        { amount: "500.00", dueDate: "2026-01-01", paidAt: "2026-01-01T00:00:00Z" }, // pagada -- fuera de ambos totales
      ],
      "2026-02-01",
    );
    expect(summary.totalPending).toBe("1250.50");
    expect(summary.totalOverdue).toBe("1000.00");
    expect(summary.countPending).toBe(2);
    expect(summary.countOverdue).toBe(1);
  });

  it("summarizeReceivables sin facturas -- totales en cero, nunca NaN/undefined", () => {
    const summary = summarizeReceivables([], "2026-01-01");
    expect(summary.totalPending).toBe("0.00");
    expect(summary.totalOverdue).toBe("0.00");
    expect(summary.countPending).toBe(0);
    expect(summary.countOverdue).toBe(0);
  });
});

// Corrección de revisión r6 de PR #171 (bloqueante 2): `postgres-repository.ts::
// mapContractInvoice` llamaba `classifyInvoiceStatus(base)` SIN fecha -- caía en el
// (antiguo) default UTC de esta función, mientras `receivablesSummary` (mismo archivo)
// SÍ calculaba con `hoyFechaNegocio()`. Entre las 18:00 y las 23:59 CDMX, una factura
// que vencía HOY (día de negocio) salía "vencida" en `invoices[]` pero
// `countOverdue: 0`/`totalOverdue: "0.00"` en los totales de la MISMA respuesta -- la
// respuesta se contradecía a sí misma. Este test es puro (sin Postgres): reproduce el
// borde de horario con `vi.useFakeTimers()` + el `hoyFechaNegocio()` real, y prueba que
// `classifyInvoiceStatus`/`summarizeReceivables` dan el mismo resultado ("pendiente",
// no vencida) cuando ambos usan el día de NEGOCIO -- y que el día UTC del proceso en
// ese mismo instante sí habría producido la contradicción (control del bug).
describe("contract-billing.ts -- consistencia del día de negocio entre invoices[] y totales (REQ-r6, corrección de PR #171)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a las 22:00 CDMX del 30-sep, una factura que vence HOY (30-sep) es 'pendiente' con el día de negocio, aunque el día UTC del proceso ya sea 1-oct", () => {
    vi.useFakeTimers();
    // 2026-10-01T04:00:00Z = 2026-09-30T22:00:00 en America/Mexico_City -- el día de
    // NEGOCIO sigue siendo 30-sep; el día UTC del proceso ya es 1-oct.
    vi.setSystemTime(new Date("2026-10-01T04:00:00.000Z"));

    const diaUtcDelProceso = new Date().toISOString().slice(0, 10);
    const diaDeNegocio = hoyFechaNegocio();
    // Control: confirma que este instante reproduce el bug real (los dos "hoy" difieren).
    expect(diaUtcDelProceso).toBe("2026-10-01");
    expect(diaDeNegocio).toBe("2026-09-30");

    const facturaQueVenceHoy = { dueDate: "2026-09-30", paidAt: null, amount: "1000.00" };

    // Con el bug (día UTC del proceso como "hoy"): ya pasó el vencimiento -> "vencida".
    expect(classifyInvoiceStatus(facturaQueVenceHoy, diaUtcDelProceso)).toBe("vencida");

    // Con el fix (día de negocio como "hoy", el mismo que usa `mapContractInvoice` y
    // `receivablesSummary` tras esta corrección): el día del vencimiento mismo todavía
    // no está vencido -- consistente entre `classifyInvoiceStatus` (usado por
    // `invoices[]`) y `summarizeReceivables` (usado por los totales).
    expect(classifyInvoiceStatus(facturaQueVenceHoy, diaDeNegocio)).toBe("pendiente");

    const totales = summarizeReceivables([facturaQueVenceHoy], diaDeNegocio);
    expect(totales.countOverdue).toBe(0);
    expect(totales.totalOverdue).toBe("0.00");
    expect(totales.countPending).toBe(1);
  });
});
