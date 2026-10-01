// H-03 -- guardrails y compuerta: funciones puras, casos de borde. Son el espejo de lo que la base decide
// (verificado contra Postgres real en scripts/verify-hoteles-agentes-aprobaciones).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GUARDRAILS,
  agentRunState,
  currentUsageMonth,
  defaultPolicy,
  evaluateGuardrails,
  firstBlockedWord,
  localMinutesOfDay,
  microUsdToUsd,
  normalizeBlockedWords,
  normalizeGuardrailText,
  qualifiesForAutoApproval,
  usdToMicroUsd,
  withinSendWindow,
} from "../../src/index.ts";

describe("normalizeGuardrailText / normalizeBlockedWords", () => {
  it("quita acentos (mayusculas y minusculas), baja a minusculas y colapsa espacios", () => {
    expect(normalizeGuardrailText("  CORTESÍA   de la Casa ñandú ")).toBe("cortesia de la casa nandu");
    expect(normalizeGuardrailText(null)).toBe("");
  });

  it("la lista se normaliza: sin vacias ni duplicadas, ordenada; mas de 60 caracteres lanza", () => {
    expect(normalizeBlockedWords([" Gratis ", "CORTESÍA", "gratis", "", "noche   gratis"])).toEqual(["cortesia", "gratis", "noche gratis"]);
    expect(normalizeBlockedWords(["x".repeat(60)])).toHaveLength(1);
    expect(() => normalizeBlockedWords(["x".repeat(61)])).toThrow(RangeError);
  });
});

describe("firstBlockedWord: palabra completa, no subcadena", () => {
  const words = ["gratis", "cortesia", "noche gratis"];
  it("detecta mayusculas, acentos y puntuacion", () => {
    expect(firstBlockedWord("Le damos una noche GRATIS", words)).toBe("gratis");
    expect(firstBlockedWord("Una Cortesía de la casa", words)).toBe("cortesia");
    expect(firstBlockedWord("Todo es gratis.", words)).toBe("gratis");
    expect(firstBlockedWord("(gratis)", words)).toBe("gratis");
    expect(firstBlockedWord("Una   noche    gratis", ["noche gratis"])).toBe("noche gratis");
  });
  it("una subcadena NO bloquea", () => {
    expect(firstBlockedWord("gratisimo", words)).toBeNull();
    expect(firstBlockedWord("regratis agratis", words)).toBeNull();
    expect(firstBlockedWord("cortesias", words)).toBeNull();
  });
  it("caracteres especiales en la palabra se escapan (no son regex)", () => {
    expect(firstBlockedWord("oferta 2+1 hoy", ["2+1"])).toBe("2+1");
    expect(firstBlockedWord("oferta 21 hoy", ["2+1"])).toBeNull();
    expect(firstBlockedWord("a.b", ["a.b"])).toBe("a.b");
    expect(firstBlockedWord("axb", ["a.b"])).toBeNull();
  });
  it("sin palabras o texto vacio no bloquea", () => {
    expect(firstBlockedWord("lo que sea", [])).toBeNull();
    expect(firstBlockedWord(null, words)).toBeNull();
  });
});

describe("evaluateGuardrails: topes duros inclusivos en el borde exacto", () => {
  it("descuento: 30% pasa, 30.01% se bloquea", () => {
    expect(evaluateGuardrails({ actionType: "descuento_tarifa", percent: 30 })).toBeNull();
    expect(evaluateGuardrails({ actionType: "descuento_tarifa", percent: 30.01 })).toBe("tope_descuento");
  });
  it("reembolso y cargo: 500000 centavos pasan, 500001 se bloquean", () => {
    expect(evaluateGuardrails({ actionType: "reembolso", amountCents: 500_000 })).toBeNull();
    expect(evaluateGuardrails({ actionType: "reembolso", amountCents: 500_001 })).toBe("tope_reembolso");
    expect(evaluateGuardrails({ actionType: "cargo_folio", amountCents: 500_000 })).toBeNull();
    expect(evaluateGuardrails({ actionType: "cargo_folio", amountCents: 500_001 })).toBe("tope_cargo_folio");
  });
  it("mensaje masivo: 200 destinatarios pasan, 201 se bloquean", () => {
    expect(evaluateGuardrails({ actionType: "mensaje_masivo", recipients: 200 })).toBeNull();
    expect(evaluateGuardrails({ actionType: "mensaje_masivo", recipients: 201 })).toBe("tope_destinatarios");
  });
  it("un tope de un tipo no se aplica a otro tipo de accion", () => {
    expect(evaluateGuardrails({ actionType: "reembolso", percent: 99 })).toBeNull();
    expect(evaluateGuardrails({ actionType: "descuento_tarifa", amountCents: 9_999_999 })).toBeNull();
  });
  it("topes configurados y palabra bloqueada", () => {
    const g = { ...DEFAULT_GUARDRAILS, maxDiscountPct: 10, blockedWords: ["regalo"] };
    expect(evaluateGuardrails({ actionType: "descuento_tarifa", percent: 10 }, g)).toBeNull();
    expect(evaluateGuardrails({ actionType: "descuento_tarifa", percent: 10.01 }, g)).toBe("tope_descuento");
    expect(evaluateGuardrails({ actionType: "respuesta_resena", text: "Un REGALO para usted" }, g)).toBe("palabra_bloqueada");
  });
});

describe("ventana de envio: inicio inclusivo, fin exclusivo, hora local de la property", () => {
  // America/Mexico_City es UTC-6 todo el ano desde 2022.
  const at = (iso: string) => new Date(iso);
  it("07:59 fuera, 08:00 dentro, 20:59 dentro, 21:00 fuera", () => {
    expect(withinSendWindow(at("2026-03-10T13:59:00Z"), "America/Mexico_City", "08:00", "21:00")).toBe(false);
    expect(withinSendWindow(at("2026-03-10T14:00:00Z"), "America/Mexico_City", "08:00", "21:00")).toBe(true);
    expect(withinSendWindow(at("2026-03-11T02:59:00Z"), "America/Mexico_City", "08:00", "21:00")).toBe(true);
    expect(withinSendWindow(at("2026-03-11T03:00:00Z"), "America/Mexico_City", "08:00", "21:00")).toBe(false);
  });
  it("la zona de la property desplaza la hora (Cancun UTC-5) y una zona invalida cae a Mexico_City", () => {
    expect(localMinutesOfDay(at("2026-03-10T13:30:00Z"), "America/Cancun")).toBe(8 * 60 + 30);
    expect(localMinutesOfDay(at("2026-03-10T13:30:00Z"), "Mars/Phobos")).toBe(7 * 60 + 30);
    expect(localMinutesOfDay(at("2026-03-10T13:30:00Z"), null)).toBe(7 * 60 + 30);
  });
  it("ventana personalizada 10:00-12:00", () => {
    expect(withinSendWindow(at("2026-03-10T15:59:00Z"), null, "10:00", "12:00")).toBe(false);
    expect(withinSendWindow(at("2026-03-10T16:00:00Z"), null, "10:00", "12:00")).toBe(true);
    expect(withinSendWindow(at("2026-03-10T17:59:00Z"), null, "10:00", "12:00")).toBe(true);
    expect(withinSendWindow(at("2026-03-10T18:00:00Z"), null, "10:00", "12:00")).toBe(false);
  });
});

describe("politica de aprobacion", () => {
  it("sin configuracion: siempre humano, 24 h, owner/gm", () => {
    expect(defaultPolicy("reembolso")).toMatchObject({ mode: "siempre_humano", expiresMinutes: 1440, approverRoles: ["owner", "gm"], configured: false });
  });
  it("auto bajo umbral: borde inclusivo, solo descuento/reembolso/cargo, nunca contenido para el huesped", () => {
    const auto = { ...defaultPolicy("descuento_tarifa"), mode: "auto_bajo_umbral" as const, autoMaxPercent: 10 };
    expect(qualifiesForAutoApproval(auto, { actionType: "descuento_tarifa", percent: 10 })).toBe(true);
    expect(qualifiesForAutoApproval(auto, { actionType: "descuento_tarifa", percent: 10.01 })).toBe(false);
    const refund = { ...defaultPolicy("reembolso"), mode: "auto_bajo_umbral" as const, autoMaxAmountCents: 10_000 };
    expect(qualifiesForAutoApproval(refund, { actionType: "reembolso", amountCents: 10_000 })).toBe(true);
    expect(qualifiesForAutoApproval(refund, { actionType: "reembolso", amountCents: 10_001 })).toBe(false);
    const resena = { ...defaultPolicy("respuesta_resena"), mode: "auto_bajo_umbral" as const, autoMaxAmountCents: 1 };
    expect(qualifiesForAutoApproval(resena, { actionType: "respuesta_resena" })).toBe(false);
    expect(qualifiesForAutoApproval(defaultPolicy("descuento_tarifa"), { actionType: "descuento_tarifa", percent: 1 })).toBe(false);
  });
});

describe("compuerta del agente (kill switch + presupuesto)", () => {
  it("sin datos de la base = activo (compatibilidad con la base sin migrar)", () => {
    expect(agentRunState(null)).toBe("activo");
  });
  it("pausado gana sobre todo; presupuesto agotado en el borde inclusivo", () => {
    expect(agentRunState({ enabled: false, budgetMicroUsd: null, spentMicroUsd: 0, pausedReason: "x" })).toBe("pausado");
    expect(agentRunState({ enabled: false, budgetMicroUsd: 100, spentMicroUsd: 500, pausedReason: "x" })).toBe("pausado");
    expect(agentRunState({ enabled: true, budgetMicroUsd: 100, spentMicroUsd: 99, pausedReason: null })).toBe("activo");
    expect(agentRunState({ enabled: true, budgetMicroUsd: 100, spentMicroUsd: 100, pausedReason: null })).toBe("presupuesto_agotado");
    expect(agentRunState({ enabled: true, budgetMicroUsd: null, spentMicroUsd: 9e12, pausedReason: null })).toBe("activo");
  });
  it("conversion USD <-> micro-USD y mes UTC", () => {
    expect(usdToMicroUsd(0.000123)).toBe(123);
    expect(usdToMicroUsd(12.5)).toBe(12_500_000);
    expect(microUsdToUsd(2_500_000)).toBe(2.5);
    expect(currentUsageMonth(new Date("2026-10-31T23:59:59Z"))).toBe("2026-10");
    expect(currentUsageMonth(new Date("2026-11-01T00:00:00Z"))).toBe("2026-11");
  });
});
