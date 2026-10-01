// R-12: SLA simple de callbacks (tiempo hasta el primer contacto).
import { describe, expect, it } from "vitest";
import { SLA_CALLBACK_MIN_GENERAL, SLA_CALLBACK_MIN_URGENTE, calcularSlaCallback, objetivoSlaCallbackMin } from "../src/index.ts";

const T0 = new Date("2026-10-01T12:00:00.000Z");
const mas = (min: number) => new Date(T0.getTime() + min * 60_000);

describe("calcularSlaCallback", () => {
  it("objetivo: 60 min en general, 15 en motivos urgentes (queja, alergia, urgencia, cobro duplicado)", () => {
    expect(objetivoSlaCallbackMin(null)).toBe(SLA_CALLBACK_MIN_GENERAL);
    expect(objetivoSlaCallbackMin("facturacion")).toBe(SLA_CALLBACK_MIN_GENERAL);
    for (const m of ["escalada:queja", "escalada:alergia_salud", "escalada:urgencia", "escalada:cobro_duplicado"]) expect(objetivoSlaCallbackMin(m)).toBe(SLA_CALLBACK_MIN_URGENTE);
    expect(objetivoSlaCallbackMin("escalada:otro")).toBe(SLA_CALLBACK_MIN_GENERAL);
  });

  it("sin contacto: en_plazo -> por_vencer (ultimo 25%) -> vencido, con los minutos restantes", () => {
    const base = { reason: null, createdAt: T0.toISOString(), estado: "nuevo" as const };
    expect(calcularSlaCallback(base, mas(10))).toMatchObject({ estado: "en_plazo", minutosRestantes: 50, objetivoMin: 60 });
    expect(calcularSlaCallback(base, mas(50))).toMatchObject({ estado: "por_vencer", minutosRestantes: 10 });
    expect(calcularSlaCallback(base, mas(60))).toMatchObject({ estado: "por_vencer", minutosRestantes: 0 });
    expect(calcularSlaCallback(base, mas(61))).toMatchObject({ estado: "vencido", minutosRestantes: -1 });
    expect(calcularSlaCallback(base, mas(61)).venceAt).toBe(mas(60).toISOString());
  });

  it("con contacto a tiempo: cumplido; tarde: incumplido (aunque ya este resuelto), sin minutos restantes", () => {
    const base = { reason: "escalada:queja", createdAt: T0.toISOString() };
    expect(calcularSlaCallback({ ...base, estado: "en_curso", tomadoAt: mas(10).toISOString() }, mas(500))).toMatchObject({ estado: "cumplido", minutosRestantes: null, objetivoMin: 15 });
    expect(calcularSlaCallback({ ...base, estado: "resuelto", tomadoAt: mas(20).toISOString(), resueltoAt: mas(25).toISOString() }, mas(500))).toMatchObject({ estado: "incumplido" });
    expect(calcularSlaCallback({ ...base, estado: "resuelto", resueltoAt: mas(5).toISOString() }, mas(500))).toMatchObject({ estado: "cumplido" });
  });

  it("un callback historico resuelto sin tiempos guardados es sin_dato (no se inventa un cumplimiento)", () => {
    expect(calcularSlaCallback({ reason: null, createdAt: T0.toISOString(), estado: "resuelto" }, mas(500))).toMatchObject({ estado: "sin_dato", minutosRestantes: null });
  });
});
