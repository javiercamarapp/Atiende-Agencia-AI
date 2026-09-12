import { describe, expect, it } from "vitest";
import {
  CONTRACT_STATES,
  CONTRACT_INITIAL_STATUS,
  CONTRACT_TERMINAL_STATES,
  CONTRACT_TRANSITIONS,
  CONTRACT_ALERT_STATES,
  CONTRACT_DECISION_TRANSITIONS,
  isContractStatus,
  checkTransition,
  type ContractStatus,
} from "../src/contract-lifecycle.ts";

describe("contract-lifecycle.ts -- máquina de estados del contrato post-adjudicación (REQ-051)", () => {
  it("11 estados, con 'adjudicado' como inicial y 'cerrado' como único terminal", () => {
    expect(CONTRACT_STATES).toHaveLength(11);
    expect(CONTRACT_INITIAL_STATUS).toBe("adjudicado");
    expect(CONTRACT_TERMINAL_STATES).toEqual(["cerrado"]);
    expect(checkTransition("cerrado", "adjudicado").allowedNextStates).toEqual([]);
  });

  it("toda transición declarada en CONTRACT_TRANSITIONS apunta a un estado real del catálogo", () => {
    for (const [from, tos] of Object.entries(CONTRACT_TRANSITIONS)) {
      expect(isContractStatus(from)).toBe(true);
      for (const to of tos) expect(isContractStatus(to)).toBe(true);
    }
  });

  it("el flujo principal feliz es alcanzable de punta a punta", () => {
    const happyPath: ContractStatus[] = ["adjudicado", "contrato_firmado_declarado", "en_ejecucion", "entregado", "facturado", "pagado", "cerrado"];
    for (let i = 0; i < happyPath.length - 1; i += 1) {
      const result = checkTransition(happyPath[i]!, happyPath[i + 1]!);
      expect(result.valid, `${happyPath[i]} -> ${happyPath[i + 1]} debería ser válida`).toBe(true);
    }
  });

  it("checkTransition nunca lanza -- devuelve valid:false con los estados permitidos", () => {
    const result = checkTransition("adjudicado", "cerrado");
    expect(result.valid).toBe(false);
    expect(result.allowedNextStates).toEqual(CONTRACT_TRANSITIONS.adjudicado);
  });

  it("rescindido solo puede cerrarse -- nunca reabrirse al flujo principal", () => {
    expect(checkTransition("rescindido", "cerrado").valid).toBe(true);
    expect(checkTransition("rescindido", "en_ejecucion").valid).toBe(false);
  });

  it("en_inconformidad puede resolverse de vuelta al flujo o cerrarse directamente", () => {
    expect(checkTransition("en_inconformidad", "adjudicado").valid).toBe(true);
    expect(checkTransition("en_inconformidad", "contrato_firmado_declarado").valid).toBe(true);
    expect(checkTransition("en_inconformidad", "cerrado").valid).toBe(true);
    expect(checkTransition("en_inconformidad", "pagado").valid).toBe(false);
  });

  it("isContractStatus distingue estados válidos de arbitrarios", () => {
    expect(isContractStatus("pagado")).toBe(true);
    expect(isContractStatus("no_existe")).toBe(false);
    expect(isContractStatus(42)).toBe(false);
  });

  it("CONTRACT_ALERT_STATES son todos estados reales, y cubren cierre + las 3 ramas excepcionales", () => {
    for (const s of CONTRACT_ALERT_STATES) expect(isContractStatus(s)).toBe(true);
    expect(CONTRACT_ALERT_STATES).toEqual(expect.arrayContaining(["penalizado", "rescindido", "en_inconformidad", "cerrado"]));
  });

  it("CONTRACT_DECISION_TRANSITIONS son las 4 ramas sensibles -- nunca incluye el flujo principal feliz", () => {
    expect(CONTRACT_DECISION_TRANSITIONS).toEqual(expect.arrayContaining(["rescindido", "penalizado", "en_inconformidad", "modificado"]));
    for (const happy of ["contrato_firmado_declarado", "en_ejecucion", "entregado", "facturado", "pagado", "cerrado"] as const) {
      expect(CONTRACT_DECISION_TRANSITIONS).not.toContain(happy);
    }
  });
});
