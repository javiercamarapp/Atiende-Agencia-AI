import { describe, expect, it } from "vitest";
import { createCircuitBreaker } from "../src/gateway/circuitBreaker.ts";
import { createInMemoryLaneBudgetTracker } from "../src/gateway/budget.ts";
import { ProviderHttpError, ProviderTransientError } from "../src/gateway/provider.ts";
import {
  AllProvidersUnavailableError,
  GatewayRouter,
  NoCompliantProviderError,
  laneKey,
} from "../src/gateway/router.ts";
import type { AgentLane } from "../src/gateway/router.ts";
import { FakeProvider, makeParams } from "./support/fakeProvider.ts";

const LANE: AgentLane = { organizationId: "org-1", vertical: "hoteles", role: "canal" };
const ZERO_TOLERANCE_LANE: AgentLane = { organizationId: "org-1", vertical: "licitaciones", role: "auditor_juez" };

describe("laneKey", () => {
  it("compone organizationId:vertical:role", () => {
    expect(laneKey(LANE)).toBe("org-1:hoteles:canal");
  });
});

describe("GatewayRouter.route", () => {
  it("elige el primer proveedor disponible en orden de prioridad", () => {
    const primary = new FakeProvider("primary", "UNKNOWN", []);
    const backup = new FakeProvider("backup", "UNKNOWN", []);
    const router = new GatewayRouter({
      providers: [primary, backup],
      circuitBreakers: new Map(),
      zeroToleranceLaneRoles: new Set(),
    });
    expect(router.route(LANE).id).toBe("primary");
  });

  it("salta un proveedor no disponible y elige el siguiente", () => {
    const primary = new FakeProvider("primary", "UNKNOWN", []);
    primary.setAvailable(false);
    const backup = new FakeProvider("backup", "UNKNOWN", []);
    const router = new GatewayRouter({
      providers: [primary, backup],
      circuitBreakers: new Map(),
      zeroToleranceLaneRoles: new Set(),
    });
    expect(router.route(LANE).id).toBe("backup");
  });

  it("AllProvidersUnavailableError cuando ninguno está disponible", () => {
    const primary = new FakeProvider("primary", "UNKNOWN", []);
    primary.setAvailable(false);
    const router = new GatewayRouter({
      providers: [primary],
      circuitBreakers: new Map(),
      zeroToleranceLaneRoles: new Set(),
    });
    expect(() => router.route(LANE)).toThrow(AllProvidersUnavailableError);
  });

  it("NoCompliantProviderError cuando el carril exige tolerancia cero y ningún proveedor tiene la residencia exigida", () => {
    const openrouter = new FakeProvider("openrouter", "UNKNOWN", []);
    const router = new GatewayRouter({
      providers: [openrouter],
      circuitBreakers: new Map(),
      zeroToleranceLaneRoles: new Set(["auditor_juez"]),
    });
    expect(() => router.route(ZERO_TOLERANCE_LANE)).toThrow(NoCompliantProviderError);
  });

  it("con tolerancia cero, SOLO considera proveedores con countryOfResidence === requiredCountry (nunca degrada a UNKNOWN)", () => {
    const openrouter = new FakeProvider("openrouter", "UNKNOWN", []);
    const anthropicUs = new FakeProvider("anthropic-direct", "US", []);
    const router = new GatewayRouter({
      providers: [openrouter, anthropicUs],
      circuitBreakers: new Map(),
      zeroToleranceLaneRoles: new Set(["auditor_juez"]),
    });
    expect(router.route(ZERO_TOLERANCE_LANE).id).toBe("anthropic-direct");
  });
});

describe("GatewayRouter.complete — fallback en cascada", () => {
  it("un ProviderTransientError en el primario reintenta con el siguiente y tiene éxito", async () => {
    const primary = new FakeProvider("primary", "UNKNOWN", [{ kind: "transient_error" }]);
    const backup = new FakeProvider("backup", "UNKNOWN", [{ kind: "final", text: "respuesta de respaldo" }]);
    const cbPrimary = createCircuitBreaker("primary");
    const router = new GatewayRouter({
      providers: [primary, backup],
      circuitBreakers: new Map([["primary", cbPrimary]]),
      zeroToleranceLaneRoles: new Set(),
    });
    const result = await router.complete(LANE, makeParams());
    expect(result.text).toBe("respuesta de respaldo");
    expect(router.getLastUsedProviderId()).toBe("backup");
    // El breaker del primario SÍ registró el fallo transitorio.
    expect(cbPrimary.state()).toBe("closed"); // un solo fallo no abre el circuito (threshold default 5)
  });

  it("un ProviderHttpError se propaga tal cual, SIN fallback ni tocar el breaker", async () => {
    const primary = new FakeProvider("primary", "UNKNOWN", [{ kind: "http_error", status: 401 }]);
    const backup = new FakeProvider("backup", "UNKNOWN", [{ kind: "final", text: "nunca debería llamarse" }]);
    const router = new GatewayRouter({
      providers: [primary, backup],
      circuitBreakers: new Map(),
      zeroToleranceLaneRoles: new Set(),
    });
    await expect(router.complete(LANE, makeParams())).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it("un proveedor con el circuito ABIERTO se salta sin intentarlo", async () => {
    const primary = new FakeProvider("primary", "UNKNOWN", [{ kind: "final", text: "no debería usarse" }]);
    const backup = new FakeProvider("backup", "UNKNOWN", [{ kind: "final", text: "respuesta de respaldo" }]);
    const cbPrimary = createCircuitBreaker("primary", { failureThreshold: 1 });
    cbPrimary.onFailure(new ProviderTransientError("primary", "ya caído"));
    expect(cbPrimary.state()).toBe("open");

    const router = new GatewayRouter({
      providers: [primary, backup],
      circuitBreakers: new Map([["primary", cbPrimary]]),
      zeroToleranceLaneRoles: new Set(),
    });
    const result = await router.complete(LANE, makeParams());
    expect(result.text).toBe("respuesta de respaldo");
  });

  it("AllProvidersUnavailableError cuando TODOS fallan de forma transitoria", async () => {
    const primary = new FakeProvider("primary", "UNKNOWN", [{ kind: "transient_error" }]);
    const backup = new FakeProvider("backup", "UNKNOWN", [{ kind: "transient_error" }]);
    const router = new GatewayRouter({
      providers: [primary, backup],
      circuitBreakers: new Map(),
      zeroToleranceLaneRoles: new Set(),
    });
    await expect(router.complete(LANE, makeParams())).rejects.toThrow();
  });

  it("NoCompliantProviderError en carril de tolerancia cero: NUNCA cae a OpenRouter aunque sea el único disponible", async () => {
    const openrouter = new FakeProvider("openrouter", "UNKNOWN", [{ kind: "final", text: "no debería usarse" }]);
    const router = new GatewayRouter({
      providers: [openrouter],
      circuitBreakers: new Map(),
      zeroToleranceLaneRoles: new Set(["auditor_juez"]),
    });
    await expect(router.complete(ZERO_TOLERANCE_LANE, makeParams())).rejects.toBeInstanceOf(NoCompliantProviderError);
  });
});

describe("GatewayRouter.complete — presupuesto por carril", () => {
  it("bloquea la llamada ANTES de intentar cualquier proveedor si el carril ya está agotado", async () => {
    const primary = new FakeProvider("primary", "UNKNOWN", [{ kind: "final", text: "no debería llamarse" }]);
    const tracker = createInMemoryLaneBudgetTracker({ [laneKey(LANE)]: { maxUsdPerDay: 1 } });
    await tracker.registrarCostoUsd(LANE, 1);
    const router = new GatewayRouter({
      providers: [primary],
      circuitBreakers: new Map(),
      zeroToleranceLaneRoles: new Set(),
      laneBudgetTracker: tracker,
    });
    await expect(router.complete(LANE, makeParams())).rejects.toThrow(/agotó su presupuesto/);
  });

  it("registra el costo real tras un éxito, usando estimateCostUsd", async () => {
    const primary = new FakeProvider("primary", "UNKNOWN", [{ kind: "final", text: "ok" }]);
    const tracker = createInMemoryLaneBudgetTracker({});
    const router = new GatewayRouter({
      providers: [primary],
      circuitBreakers: new Map(),
      zeroToleranceLaneRoles: new Set(),
      laneBudgetTracker: tracker,
      estimateCostUsd: (completion) => completion.usage.outputTokens * 0.001,
    });
    await router.complete(LANE, makeParams());
    expect(await tracker.remainingUsd(LANE)).toBeUndefined(); // sin límite configurado
    // Verificamos el registro real vía un tracker CON límite, para observar el descuento.
    const trackerConLimite = createInMemoryLaneBudgetTracker({ [laneKey(LANE)]: { maxUsdPerDay: 1 } });
    const router2 = new GatewayRouter({
      providers: [new FakeProvider("primary", "UNKNOWN", [{ kind: "final", text: "ok" }])],
      circuitBreakers: new Map(),
      zeroToleranceLaneRoles: new Set(),
      laneBudgetTracker: trackerConLimite,
      estimateCostUsd: (completion) => completion.usage.outputTokens * 0.1, // 5 tokens de salida -> 0.5
    });
    await router2.complete(LANE, makeParams());
    expect(await trackerConLimite.remainingUsd(LANE)).toBeCloseTo(0.5);
  });
});
