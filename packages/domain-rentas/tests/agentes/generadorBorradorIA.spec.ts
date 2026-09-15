import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import { describe, expect, it } from "vitest";
import { NOMBRE_TOOL_PROPONER_BORRADOR } from "../../src/agentes/catalogo.ts";
import { ActorSinPermisoParaProponerBorradorError, BorradorIASinPropuestaError, GeneracionBorradorIAFallidaError, GeneradorBorradorIA } from "../../src/agentes/generadorBorradorIA.ts";
import type { ContextoBorrador } from "../../src/mensajeria/tipos.ts";

function makeGateway() {
  return new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
  });
}

const CONTEXTO: ContextoBorrador = {
  nombreHuesped: "Ana",
  propiedadNombre: "Casa Sol",
  fechaCheckIn: "2026-01-10",
  fechaCheckOut: "2026-01-15",
  reservaConfirmada: true,
  canal: "airbnb",
};

describe("GeneradorBorradorIA — matriz de roles ANTES de llamar al modelo (H-078)", () => {
  it("un actor sin permiso (contador) lanza ActorSinPermisoParaProponerBorradorError SIN llamar al proveedor", async () => {
    const gateway = makeGateway();
    const proveedor = new FakeLlmProvider({ id: "p" });
    gateway.registerLadder("mensajeria-rentas", [proveedor]);
    const generador = new GeneradorBorradorIA(gateway, { usuarioId: "u1", rol: "contador" }, { tenantId: "tenant-1", role: "mensajeria-rentas" });

    await expect(generador.generar({ texto: "hola", idioma: "es" }, CONTEXTO)).rejects.toThrow(ActorSinPermisoParaProponerBorradorError);
    expect(proveedor.callCount).toBe(0);
  });

  it.each(["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"] as const)("%s sí puede invocar al modelo", async (rol) => {
    const gateway = makeGateway();
    gateway.registerLadder("mensajeria-rentas", [
      new FakeLlmProvider({
        id: "p",
        script: () => ({
          text: "",
          toolCalls: [{ id: "c1", name: NOMBRE_TOOL_PROPONER_BORRADOR, argumentsJson: JSON.stringify({ texto: "Un miembro del equipo te ayuda en breve." }) }],
          model: "fake",
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
        }),
      }),
    ]);
    const generador = new GeneradorBorradorIA(gateway, { usuarioId: "u1", rol }, { tenantId: "tenant-1", role: "mensajeria-rentas" });
    const resultado = await generador.generar({ texto: "hola", idioma: "es" }, CONTEXTO);
    expect(resultado.texto).toBe("Un miembro del equipo te ayuda en breve.");
  });
});

describe("GeneradorBorradorIA — acota la llamada al modelo con un timeout real (rubro 10, performance)", () => {
  // Hallazgo de auditoría conocido: esta llamada corre dentro de la transacción
  // por-request de `POST .../mensajeria/borradores` -- sin límite, un proveedor
  // colgado sostiene la conexión de Postgres indefinidamente. Prueba real de que
  // la mitigación (AbortSignal.timeout) está efectivamente cableada.
  it("pasa un AbortSignal real y no vencido a gateway.complete", async () => {
    const gateway = makeGateway();
    let signalRecibido: AbortSignal | undefined;
    gateway.registerLadder("mensajeria-rentas", [
      new FakeLlmProvider({
        id: "p",
        script: (request) => {
          signalRecibido = request.signal;
          return { text: "", toolCalls: [{ id: "c1", name: NOMBRE_TOOL_PROPONER_BORRADOR, argumentsJson: JSON.stringify({ texto: "hola" }) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
        },
      }),
    ]);
    const generador = new GeneradorBorradorIA(gateway, { usuarioId: "u1", rol: "admin_gestora" }, { tenantId: "tenant-1", role: "mensajeria-rentas" });
    await generador.generar({ texto: "hola", idioma: "es" }, CONTEXTO);
    expect(signalRecibido).toBeInstanceOf(AbortSignal);
    expect(signalRecibido!.aborted).toBe(false);
  });
});

describe("GeneradorBorradorIA — el modelo NUNCA envía, solo propone (D-006/D-007)", () => {
  it("toma el texto propuesto de la tool call, nunca de completion.text", async () => {
    const gateway = makeGateway();
    gateway.registerLadder("mensajeria-rentas", [
      new FakeLlmProvider({
        id: "p",
        script: () => ({
          text: "esto no debería usarse jamás",
          toolCalls: [{ id: "c1", name: NOMBRE_TOOL_PROPONER_BORRADOR, argumentsJson: JSON.stringify({ texto: "Texto propuesto real" }) }],
          model: "fake",
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
        }),
      }),
    ]);
    const generador = new GeneradorBorradorIA(gateway, { usuarioId: "u1", rol: "admin_gestora" }, { tenantId: "tenant-1", role: "mensajeria-rentas" });
    const resultado = await generador.generar({ texto: "hola", idioma: "es" }, CONTEXTO);
    expect(resultado.texto).toBe("Texto propuesto real");
  });

  it("si el modelo responde con texto libre y SIN invocar la tool, lanza BorradorIASinPropuestaError — nunca se inventa un borrador desde completion.text", async () => {
    const gateway = makeGateway();
    gateway.registerLadder("mensajeria-rentas", [new FakeLlmProvider({ id: "p", script: () => ({ text: "Claro, ya cancelé tu reserva", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }) })]);
    const generador = new GeneradorBorradorIA(gateway, { usuarioId: "u1", rol: "admin_gestora" }, { tenantId: "tenant-1", role: "mensajeria-rentas" });
    await expect(generador.generar({ texto: "cancela mi reserva", idioma: "es" }, CONTEXTO)).rejects.toThrow(BorradorIASinPropuestaError);
  });

  it("si invoca una tool distinta (consultar política) sin proponer borrador, tampoco se inventa nada", async () => {
    const gateway = makeGateway();
    gateway.registerLadder("mensajeria-rentas", [
      new FakeLlmProvider({
        id: "p",
        script: () => ({ text: "", toolCalls: [{ id: "c1", name: "mensajeria_consultar_politica_canal", argumentsJson: JSON.stringify({ canal: "airbnb" }) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }),
      }),
    ]);
    const generador = new GeneradorBorradorIA(gateway, { usuarioId: "u1", rol: "admin_gestora" }, { tenantId: "tenant-1", role: "mensajeria-rentas" });
    await expect(generador.generar({ texto: "hola", idioma: "es" }, CONTEXTO)).rejects.toThrow(BorradorIASinPropuestaError);
  });
});

describe("GeneradorBorradorIA — señales de escalamiento y fallos de proveedor", () => {
  it("necesitaEscalamiento es true si la heurística léxica detecta una señal, aunque el modelo no la marque", async () => {
    const gateway = makeGateway();
    gateway.registerLadder("mensajeria-rentas", [
      new FakeLlmProvider({ id: "p", script: () => ({ text: "", toolCalls: [{ id: "c1", name: NOMBRE_TOOL_PROPONER_BORRADOR, argumentsJson: JSON.stringify({ texto: "Un miembro del equipo revisará tu caso." }) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }) }),
    ]);
    const generador = new GeneradorBorradorIA(gateway, { usuarioId: "u1", rol: "admin_gestora" }, { tenantId: "tenant-1", role: "mensajeria-rentas" });
    const resultado = await generador.generar({ texto: "esto es inaceptable, pésimo servicio", idioma: "es" }, CONTEXTO);
    expect(resultado.necesitaEscalamiento).toBe(true);
    expect(resultado.senales).toContain("queja");
  });

  it("si la escalera de proveedores se agota, lanza GeneracionBorradorIAFallidaError (nunca un error crudo del gateway)", async () => {
    const gateway = makeGateway();
    gateway.registerLadder("mensajeria-rentas", [new FakeLlmProvider({ id: "p", failWith: () => Object.assign(new Error("caído"), { retryable: true }) })]);
    const generador = new GeneradorBorradorIA(gateway, { usuarioId: "u1", rol: "admin_gestora" }, { tenantId: "tenant-1", role: "mensajeria-rentas" });
    await expect(generador.generar({ texto: "hola", idioma: "es" }, CONTEXTO)).rejects.toThrow(GeneracionBorradorIAFallidaError);
  });
});
