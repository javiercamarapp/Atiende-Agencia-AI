import { describe, expect, it } from "vitest";
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
