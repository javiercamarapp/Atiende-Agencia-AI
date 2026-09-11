// REQ-LIC-001/AE-01: el guardia anti-manipulación de fecha es el hallazgo de
// seguridad más repetido del repo origen. Estas pruebas verifican que
// `resolveExpedienteAsOfIso` NUNCA usa "ahora" como sustituto silencioso, y
// que `assertExplicitOffset`/`isPast` rechazan fail-closed cualquier fecha
// ambigua o calendáricamente imposible.
import { describe, expect, it } from "vitest";
import { resolveExpedienteAsOfIso, dateOnlyToMexicoCityIso, timestampToIso } from "../src/dates.ts";
import { SubmissionDeadlineUnknownError } from "../src/errors.ts";
import { assertExplicitOffset, isPast } from "../src/types.ts";
import type { TenderRecord } from "../src/types.ts";

function tender(submissionDeadline: string | null): TenderRecord {
  return { id: "t1", organizationId: "org1", title: "Convocatoria", submissionDeadline, updatedAt: "2026-01-01T00:00:00Z" };
}

describe("resolveExpedienteAsOfIso -- guardia anti-manipulación de fecha (REQ-LIC-001)", () => {
  it("deriva asOfIso del submissionDeadline real de la convocatoria", () => {
    expect(resolveExpedienteAsOfIso(tender("2026-12-01T18:00:00-06:00"))).toBe("2026-12-01T18:00:00-06:00");
  });

  it("bloquea explícitamente (nunca usa 'ahora') si la convocatoria no tiene submissionDeadline", () => {
    expect(() => resolveExpedienteAsOfIso(tender(null))).toThrow(SubmissionDeadlineUnknownError);
  });

  it("nunca acepta un asOfIso que 'mande el cliente' -- la única entrada es el tender ya resuelto por el repositorio", () => {
    // La firma de la función ni siquiera admite un segundo parámetro: esto es
    // una prueba estructural de que no hay forma de inyectar un asOfIso
    // externo, no solo de comportamiento.
    expect(resolveExpedienteAsOfIso.length).toBe(1);
  });
});

describe("assertExplicitOffset -- fail-closed ante fechas ambiguas/inválidas", () => {
  it("acepta ISO con offset explícito", () => {
    expect(() => assertExplicitOffset("2026-10-20T23:59:59-06:00")).not.toThrow();
    expect(() => assertExplicitOffset("2026-10-20T23:59:59Z")).not.toThrow();
  });

  it("rechaza una fecha 'naive' sin offset", () => {
    expect(() => assertExplicitOffset("2026-10-20T23:59:59")).toThrow(/offset horario explícito/);
  });

  it("rechaza un offset numéricamente imposible (+99:00)", () => {
    expect(() => assertExplicitOffset("2026-10-20T23:59:59+99:00")).toThrow(/offset horario fuera del rango válido/);
  });

  it("rechaza 29 de febrero en un año NO bisiesto (2026)", () => {
    expect(() => assertExplicitOffset("2026-02-29T00:00:00-06:00")).toThrow(/día calendárico inválido/);
  });

  it("acepta 29 de febrero en un año SÍ bisiesto (2028)", () => {
    expect(() => assertExplicitOffset("2028-02-29T00:00:00-06:00")).not.toThrow();
  });

  it('rechaza "24:00:00" (medianoche del día siguiente disfrazada de hora válida)', () => {
    expect(() => assertExplicitOffset("2026-10-20T24:00:00-06:00")).toThrow(/hora fuera de rango/);
  });
});

describe("isPast", () => {
  it("una fecha límite anterior a asOfIso ya pasó", () => {
    expect(isPast("2026-01-01T00:00:00-06:00", "2026-06-01T00:00:00-06:00")).toBe(true);
  });

  it("una fecha límite posterior a asOfIso NO ha pasado", () => {
    expect(isPast("2026-12-01T00:00:00-06:00", "2026-06-01T00:00:00-06:00")).toBe(false);
  });
});

describe("dateOnlyToMexicoCityIso / timestampToIso", () => {
  it("ancla una columna date a las 23:59:59 -06:00 en el borde 'end'", () => {
    expect(dateOnlyToMexicoCityIso("2026-06-30", "end")).toBe("2026-06-30T23:59:59-06:00");
  });

  it("ancla una columna date a las 00:00:00 -06:00 en el borde 'start'", () => {
    expect(dateOnlyToMexicoCityIso("2026-06-30", "start")).toBe("2026-06-30T00:00:00-06:00");
  });

  it("null se preserva como null", () => {
    expect(dateOnlyToMexicoCityIso(null, "end")).toBeNull();
    expect(timestampToIso(null)).toBeNull();
  });
});
