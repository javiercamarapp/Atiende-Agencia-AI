// Pruebas de la configuración por rubro (Fase 6 §1): el guardrail de crisis solo
// aplica a rubros de salud, la detección de palabras clave ignora acentos/
// mayúsculas, y las FAQs canónicas existen para cada rubro real del esquema.
import { describe, expect, it } from "vitest";
import { ALL_VERTICALS, CRISIS_ESCALATION_MESSAGE, detectCrisisKeyword, findVerticalFaqAnswer, getVerticalFaqs, requiresCrisisGuardrail } from "../src/vertical-config.ts";

describe("requiresCrisisGuardrail", () => {
  it("solo medico/dental/psicologo/veterinaria lo reciben", () => {
    for (const vertical of ["medico", "dental", "psicologo", "veterinaria"]) {
      expect(requiresCrisisGuardrail(vertical)).toBe(true);
    }
    for (const vertical of ["barberia", "salon", "spa", "restaurante", "gimnasio", "farmacia", "escuela", "seguros", "mecanico", "otro"]) {
      expect(requiresCrisisGuardrail(vertical)).toBe(false);
    }
  });

  it("un rubro desconocido nunca activa el guardrail", () => {
    expect(requiresCrisisGuardrail("rubro-inventado")).toBe(false);
  });
});

describe("detectCrisisKeyword", () => {
  it("detecta una frase real de crisis", () => {
    expect(detectCrisisKeyword("ya no aguanto más, quiero terminar con todo")).toBe("ya no aguanto");
  });

  it("ignora acentos y mayúsculas", () => {
    expect(detectCrisisKeyword("ESTARÍAN MEJOR SIN MÍ")).toBe("estarian mejor sin mi");
  });

  it("un mensaje normal no dispara nada", () => {
    expect(detectCrisisKeyword("Quiero agendar una cita para mañana a las 10")).toBeNull();
  });

  it("un mensaje vacío o undefined no revienta", () => {
    expect(detectCrisisKeyword("")).toBeNull();
    expect(detectCrisisKeyword(undefined as unknown as string)).toBeNull();
  });
});

describe("CRISIS_ESCALATION_MESSAGE", () => {
  it("incluye las líneas de ayuda reales y el 911", () => {
    expect(CRISIS_ESCALATION_MESSAGE).toContain("800 911 2000");
    expect(CRISIS_ESCALATION_MESSAGE).toContain("SAPTEL");
    expect(CRISIS_ESCALATION_MESSAGE).toContain("911");
  });
});

describe("getVerticalFaqs", () => {
  it("todo rubro real del esquema tiene una entrada (aunque sea vacía)", () => {
    for (const vertical of ALL_VERTICALS) {
      expect(Array.isArray(getVerticalFaqs(vertical))).toBe(true);
    }
  });

  it("un rubro desconocido cae en la lista de 'otro' (vacía)", () => {
    expect(getVerticalFaqs("no-existe")).toEqual([]);
  });
});

describe("findVerticalFaqAnswer", () => {
  it("matchea por keyword real del rubro, sin acentos", () => {
    const faq = findVerticalFaqAnswer("veterinaria", "¿Cuándo le toca la VACUNA a mi cachorro?");
    expect(faq).not.toBeNull();
    expect(faq!.answer).toContain("Cachorros");
  });

  it("no matchea keywords de otro rubro", () => {
    expect(findVerticalFaqAnswer("veterinaria", "¿tienen paquetes para parejas?")).toBeNull();
  });
});
