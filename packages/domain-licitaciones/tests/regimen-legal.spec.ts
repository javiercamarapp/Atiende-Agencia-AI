// L-23 (REQ-050) -- regimen legal por fecha de convocatoria.
import { describe, expect, it } from "vitest";
import {
  LAASSP_2025_ENTRADA_EN_VIGOR,
  PlazoRegimenNoVerificableError,
  buildInconformidadContentByRegime,
  computeInconformidadDeadlineByRegime,
  computePaymentDueDateByRegime,
  resolveRegimenLegal,
} from "../src/regimen-legal.ts";
import { computePaymentDueDate } from "../src/contract-billing.ts";
import { computeInconformidadDeadline } from "../src/inconformidad.ts";

describe("resolveRegimenLegal", () => {
  it("el 17-abr-2025 ya rige la ley nueva y el 16-abr-2025 todavia la abrogada", () => {
    expect(LAASSP_2025_ENTRADA_EN_VIGOR).toBe("2025-04-17");
    expect(resolveRegimenLegal("2025-04-17").regimen).toBe("laassp_2025");
    expect(resolveRegimenLegal("2025-04-16").regimen).toBe("laassp_2000_abrogada");
    expect(resolveRegimenLegal("2024-01-02").regimen).toBe("laassp_2000_abrogada");
    expect(resolveRegimenLegal("2026-03-01").regimen).toBe("laassp_2025");
  });

  it("sin fecha aplica el regimen vigente y LO DECLARA (no finge conocer la fecha)", () => {
    for (const vacia of [undefined, null]) {
      const r = resolveRegimenLegal(vacia);
      expect(r.regimen).toBe("laassp_2025");
      expect(r.fuente).toBe("no_declarada");
      expect(r.convocatoriaPublicadaEn).toBeNull();
      expect(r.nota).toMatch(/No se declaro la fecha/);
      expect(r.validarConAbogado).toBe(true);
    }
  });

  it("toda resolucion pide validar con abogado y apunta a la ficha del transitorio", () => {
    const r = resolveRegimenLegal("2025-01-10");
    expect(r.validarConAbogado).toBe(true);
    expect(r.nota).toMatch(/Validar con abogado/);
    expect(r.fichas).toContain("laassp-2025-regimen-transitorio");
  });

  it("rechaza fechas que no existen en el calendario (fail-closed)", () => {
    expect(() => resolveRegimenLegal("2025-02-30")).toThrow(/invalida/);
    expect(() => resolveRegimenLegal("17/04/2025")).toThrow(/invalida/);
  });
});

describe("computePaymentDueDateByRegime", () => {
  it("regimen nuevo: 17 dias habiles (Art. 73), igual que el motor previo", () => {
    // 2026-01-05 es lunes; 17 habiles despues = miercoles 28-ene-2026 (sin inhabiles oficiales en el intervalo).
    const r = computePaymentDueDateByRegime("2026-01-05", "2025-06-01");
    expect(r.dueDate).toBe("2026-01-28");
    expect(r.dayType).toBe("habiles");
    expect(r.days).toBe(17);
    expect(r.regimen.regimen).toBe("laassp_2025");
    expect(r.dueDate).toBe(computePaymentDueDate("2026-01-05").dueDate);
  });

  it("regimen abrogado: 20 dias NATURALES, sin excluir fines de semana, y lo dice", () => {
    const r = computePaymentDueDateByRegime("2026-01-05", "2025-03-01");
    expect(r.dueDate).toBe("2026-01-25"); // domingo: los naturales no se recorren
    expect(r.dayType).toBe("naturales");
    expect(r.days).toBe(20);
    expect(r.legalReference).toMatch(/abrogada/);
    expect(r.legalReference).toMatch(/validar con abogado/i);
    expect(r.calendarNote).toMatch(/naturales/);
    expect(r.regimen.regimen).toBe("laassp_2000_abrogada");
  });

  it("los dias inhabiles NO alargan un plazo en dias naturales pero SI uno en habiles", () => {
    const inhabil = ["2026-01-06"];
    expect(computePaymentDueDateByRegime("2026-01-05", "2025-03-01", inhabil).dueDate).toBe("2026-01-25");
    expect(computePaymentDueDateByRegime("2026-01-05", "2025-06-01", inhabil).dueDate).toBe("2026-01-29");
  });

  it("cruza fin de mes y de anio con dias naturales", () => {
    expect(computePaymentDueDateByRegime("2025-12-20", "2025-01-01").dueDate).toBe("2026-01-09");
  });

  it("sin fecha de convocatoria conserva el vencimiento previo y declara la suposicion", () => {
    const r = computePaymentDueDateByRegime("2026-01-05", null);
    expect(r.dueDate).toBe("2026-01-28");
    expect(r.regimen.fuente).toBe("no_declarada");
    expect(r.legalReference).toMatch(/Fecha de convocatoria no declarada/);
    expect(r.legalReference).not.toMatch(/REQ-050/);
  });

  it("con fecha de convocatoria informada la referencia legal no lleva la nota de suposicion", () => {
    expect(computePaymentDueDateByRegime("2026-01-05", "2025-06-01").legalReference).not.toMatch(/no declarada/);
  });
});

describe("computeInconformidadDeadlineByRegime", () => {
  it("regimen nuevo: 6 dias habiles, 10 bajo tratados (Art. 95)", () => {
    const general = computeInconformidadDeadlineByRegime("2026-01-05", false, "2025-08-01");
    expect(general.status).toBe("calculado");
    if (general.status === "calculado") {
      expect(general.plazo.dueDate).toBe("2026-01-13");
      expect(general.plazo.businessDays).toBe(6);
      expect(general.plazo.dueDate).toBe(computeInconformidadDeadline("2026-01-05", false).dueDate);
    }
    const tratados = computeInconformidadDeadlineByRegime("2026-01-05", true, "2025-08-01");
    expect(tratados.status === "calculado" && tratados.plazo.dueDate).toBe("2026-01-19");
  });

  it("regimen abrogado: NO inventa una fecha limite, exige validar con abogado", () => {
    const r = computeInconformidadDeadlineByRegime("2026-01-05", false, "2025-04-16");
    expect(r.status).toBe("requiere_validacion_abogado");
    expect(r.plazo).toBeNull();
    if (r.status === "requiere_validacion_abogado") expect(r.motivo).toMatch(/validar con abogado/i);
  });

  it("sin fecha de convocatoria calcula con el regimen vigente y declara la suposicion", () => {
    const r = computeInconformidadDeadlineByRegime("2026-01-05", false, undefined);
    expect(r.status).toBe("calculado");
    if (r.status === "calculado") expect(r.plazo.legalReference).toMatch(/Fecha de convocatoria no declarada/);
  });
});

describe("buildInconformidadContentByRegime", () => {
  const base = { falloNotifiedOn: "2026-01-05", bajoTratados: false, hechos: ["h"], agravios: ["a"], pruebas: ["p"] } as const;

  it("regimen abrogado: lanza PlazoRegimenNoVerificableError y no devuelve contenido", () => {
    expect(() => buildInconformidadContentByRegime({ ...base, convocatoriaPublicadaEn: "2024-12-31" })).toThrow(PlazoRegimenNoVerificableError);
  });

  it("regimen nuevo: el hash no cambia respecto al motor previo (misma fecha limite)", () => {
    const nuevo = buildInconformidadContentByRegime({ ...base, convocatoriaPublicadaEn: "2025-09-01" });
    expect(nuevo.plazo.dueDate).toBe("2026-01-13");
    expect(nuevo.plazo.legalReference).not.toMatch(/no declarada/);
  });

  it("sin fecha: mismo plazo que antes y la referencia declara la suposicion", () => {
    const sinFecha = buildInconformidadContentByRegime(base);
    expect(sinFecha.plazo.dueDate).toBe("2026-01-13");
    expect(sinFecha.plazo.legalReference).toMatch(/Fecha de convocatoria no declarada/);
  });
});
