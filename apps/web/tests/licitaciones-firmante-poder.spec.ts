// Semaforo del poder del firmante y formato de dinero de la pantalla de Datos de la empresa (puras, con "hoy" inyectado).
import { describe, expect, it } from "vitest";
import { diasParaVencer, formatCentavos, hoyLocal, pesosACentavos, poderEstado } from "../src/verticals/licitaciones/lib/firmante-poder.ts";

describe("poderEstado", () => {
  const HOY = "2026-06-15";
  it("sin ninguna fecha: sin vigencia capturada (nunca vigente por omision)", () => {
    expect(poderEstado(null, null, HOY)).toBe("sin_vigencia");
    expect(poderEstado(undefined, undefined, HOY)).toBe("sin_vigencia");
  });
  it("vigente, por vencer (<= 30 dias), vencido y aun no vigente, con las fronteras exactas", () => {
    expect(poderEstado("2026-01-01", null, HOY)).toBe("vigente");
    expect(poderEstado("2026-01-01", "2027-06-15", HOY)).toBe("vigente");
    expect(poderEstado("2026-01-01", "2026-07-15", HOY)).toBe("por_vencer"); // 30 dias
    expect(poderEstado("2026-01-01", "2026-07-16", HOY)).toBe("vigente"); // 31 dias
    expect(poderEstado("2026-01-01", "2026-06-15", HOY)).toBe("por_vencer"); // vence hoy: aun vale hoy
    expect(poderEstado("2026-01-01", "2026-06-14", HOY)).toBe("vencido");
    expect(poderEstado("2026-06-16", null, HOY)).toBe("aun_no_vigente");
    expect(poderEstado("2026-06-15", null, HOY)).toBe("vigente");
  });
  it("acepta timestamps y calcula los dias restantes", () => {
    expect(poderEstado("2026-01-01T00:00:00Z", "2026-06-14T23:59:59Z", HOY)).toBe("vencido");
    expect(diasParaVencer("2026-06-20", HOY)).toBe(5);
    expect(diasParaVencer("2026-06-10", HOY)).toBe(-5);
    expect(diasParaVencer(null, HOY)).toBeNull();
  });
  it("hoyLocal da AAAA-MM-DD con ceros", () => {
    expect(hoyLocal(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

describe("dinero en centavos", () => {
  it("formatCentavos agrupa miles sin toLocale", () => {
    expect(formatCentavos(150_000_050)).toBe("$1,500,000.50");
    expect(formatCentavos(5)).toBe("$0.05");
    expect(formatCentavos(0)).toBe("$0.00");
    expect(formatCentavos(null)).toBe("—");
  });
  it("pesosACentavos acepta hasta dos decimales y separadores; rechaza lo demas", () => {
    expect(pesosACentavos("1500000.5")).toBe(150_000_050);
    expect(pesosACentavos("$1,500,000")).toBe(150_000_000);
    expect(pesosACentavos("0.05")).toBe(5);
    for (const mal of ["", "abc", "1.234", "-5", "1e3", "1,5,0.00x"]) expect(pesosACentavos(mal), mal).toBeNull();
  });
});
