// Fase 5 pieza 1 — REQ-147/148/149.
import { describe, expect, it } from "vitest";
import { classifySourceFailure, computeStaleForMs, evaluateSourceFreshness, isSourceHealthState } from "../src/source-run.ts";
import { CaptchaDetectedError, InterfaceChangedError, SourceNotConfiguredError } from "../src/connector-registry.ts";

describe("classifySourceFailure (REQ-148: estados explícitos, nunca 'ok' por defecto)", () => {
  it("clasifica SourceNotConfiguredError como not_configured", () => {
    expect(classifySourceFailure(new SourceNotConfiguredError("sin configuración")).state).toBe("not_configured");
  });

  it("clasifica CaptchaDetectedError como captcha_detected", () => {
    expect(classifySourceFailure(new CaptchaDetectedError("bloqueado por captcha")).state).toBe("captcha_detected");
  });

  it("clasifica InterfaceChangedError como interface_changed", () => {
    expect(classifySourceFailure(new InterfaceChangedError("formato inesperado")).state).toBe("interface_changed");
  });

  it("red de seguridad: cualquier error cuyo mensaje mencione 'captcha' también se clasifica como captcha_detected", () => {
    expect(classifySourceFailure(new Error("respuesta con {\"error\":\"captcha\"}")).state).toBe("captcha_detected");
  });

  it("un error genérico (red/HTTP no reconocido) se clasifica como 'down', nunca como 'ok'", () => {
    expect(classifySourceFailure(new Error("ECONNRESET")).state).toBe("down");
  });
});

describe("computeStaleForMs / evaluateSourceFreshness (REQ-149: frescura nunca oculta)", () => {
  const NOW = new Date("2026-06-01T00:00:00Z");

  it("lastSuccessAt null -> staleForMs null y stale=true SIEMPRE (nunca se reporta '0 de antigüedad')", () => {
    expect(computeStaleForMs(null, NOW)).toBeNull();
    const freshness = evaluateSourceFreshness("comprasmx", null, null, NOW);
    expect(freshness.staleForMs).toBeNull();
    expect(freshness.stale).toBe(true);
  });

  it("una corrida exitosa reciente (dentro del umbral) -> stale=false", () => {
    const lastSuccessAt = new Date(NOW.getTime() - 5 * 60_000).toISOString(); // 5 min antes
    const freshness = evaluateSourceFreshness("comprasmx", { state: "ok", finishedAt: lastSuccessAt }, { state: "ok" }, NOW);
    expect(freshness.stale).toBe(false);
    expect(freshness.staleForMs).toBe(5 * 60_000);
  });

  it("una corrida exitosa antigua (fuera del umbral, 3x30min=90min para comprasmx) -> stale=true", () => {
    const lastSuccessAt = new Date(NOW.getTime() - 200 * 60_000).toISOString(); // 200 min antes
    const freshness = evaluateSourceFreshness("comprasmx", { state: "ok", finishedAt: lastSuccessAt }, { state: "ok" }, NOW);
    expect(freshness.stale).toBe(true);
  });

  it("reporta el ÚLTIMO estado conocido (aunque sea de falla) incluso si hubo un éxito más antiguo", () => {
    const lastSuccessAt = new Date(NOW.getTime() - 500 * 60_000).toISOString();
    const freshness = evaluateSourceFreshness("dof", { state: "ok", finishedAt: lastSuccessAt }, { state: "captcha_detected" }, NOW);
    expect(freshness.lastRunState).toBe("captcha_detected");
    expect(freshness.lastSuccessAt).toBe(lastSuccessAt); // la frescura sigue midiéndose contra el último ÉXITO, no contra la última corrida.
  });

  it("isSourceHealthState distingue estados válidos de arbitrarios", () => {
    expect(isSourceHealthState("ok")).toBe(true);
    expect(isSourceHealthState("nunca_corrio")).toBe(false);
  });
});
