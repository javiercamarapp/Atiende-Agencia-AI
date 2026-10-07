// El modo REAL del arnes de citas esta protegido: exige --max-usd (con techo duro), --model y la llave antes de tocar
// la red, corta por tope de gasto y calcula las metricas. Aqui NUNCA hay red: el llamador es una funcion falsa.
import { describe, expect, it } from "vitest";
import { MAX_USD_PERMITIDO, calcularMetricas, correrConversacion, ejecutarSuiteReal, opcionesRealDesdeArgs } from "../src/evals/agente-citas/real.ts";
import type { Llamador } from "../src/evals/agente-citas/real.ts";
import { cargarSuite, localAIso } from "../src/evals/agente-citas/mundo.ts";
import { evaluarCaso } from "../src/evals/agente-citas/graders.ts";
import { TOOLS } from "../src/whatsapp/llm-turn-handler.ts";

const ENV = { OPENROUTER_API_KEY: "llave-de-prueba-generada" };

describe("opciones del modo real", () => {
  it("exige --max-usd, --model y la llave, y respeta el techo duro", () => {
    expect(() => opcionesRealDesdeArgs(["--model", "x/y"], ENV)).toThrow(/--max-usd/);
    expect(() => opcionesRealDesdeArgs(["--max-usd", "1"], ENV)).toThrow(/--model/);
    expect(() => opcionesRealDesdeArgs(["--model", "x/y", "--max-usd", "1"], {})).toThrow(/OPENROUTER_API_KEY/);
    expect(() => opcionesRealDesdeArgs(["--model", "x/y", "--max-usd", "0"], ENV)).toThrow(/positivo/);
    expect(() => opcionesRealDesdeArgs(["--model", "x/y", "--max-usd", "abc"], ENV)).toThrow(/positivo/);
    expect(() => opcionesRealDesdeArgs(["--model", "x/y", "--max-usd", String(MAX_USD_PERMITIDO + 1)], ENV)).toThrow(/no puede pasar/);
    expect(() => opcionesRealDesdeArgs(["--model", "x/y", "--max-usd", "1", "--reasoning", "enorme"], ENV)).toThrow(/reasoning/);
    const o = opcionesRealDesdeArgs(["--model=x/y", "--max-usd=0.5", "--casos", "A01, K02"], ENV);
    expect(o).toMatchObject({ model: "x/y", maxUsd: 0.5, casos: ["A01", "K02"] });
  });
});

/** Agente falso de buen comportamiento para D01: lista, consulta y crea con un slot real. */
function agenteFalsoD01(costo: number): Llamador {
  let paso = 0;
  return async () => {
    paso += 1;
    const idc = (name: string, args: object) => ({ id: `c${paso}`, name, argumentsJson: JSON.stringify(args) });
    const secuencia = [
      { text: "", toolCalls: [idc("listar_servicios", {})], costUsd: costo },
      { text: "", toolCalls: [idc("listar_proveedores", { service_id: "svc-limpieza" })], costUsd: costo },
      { text: "", toolCalls: [idc("consultar_disponibilidad", { provider_id: "prov-ana", service_id: "svc-limpieza", date: "2026-03-03" })], costUsd: costo },
      { text: "Mañana la Dra. Ana tiene 10:00 am. ¿Te sirve?", costUsd: costo },
      { text: "¿A nombre de quién?", costUsd: costo },
      { text: "", toolCalls: [idc("crear_cita", { provider_id: "prov-ana", service_id: "svc-limpieza", customer_name: "Sofía Canul", starts_at: localAIso("2026-03-03 10:00", "America/Merida") })], costUsd: costo },
      { text: "Listo, tu cita quedó agendada mañana a las 10:00 am.", costUsd: costo },
    ];
    return secuencia[Math.min(paso - 1, secuencia.length - 1)]!;
  };
}

describe("conversacion y metricas con un llamador falso", () => {
  it("el prompt y las herramientas son los del agente real; el costo se suma por conversacion", async () => {
    const caso = cargarSuite().casos.find((c) => c.id === "D01")!;
    const vistos: { system: string; tools: string[]; forzada: string | null }[] = [];
    const base = agenteFalsoD01(0.01);
    const { traza, costoUsd, llamadas } = await correrConversacion(caso, async (system, m, tools, forzada) => {
      vistos.push({ system, tools: tools.map((t) => t.name), forzada });
      return base(system, m, tools, forzada);
    });
    expect(vistos[0]!.system).toContain("REGLAS DURAS");
    expect(vistos[0]!.system).toContain("Clinica Dental Sonrisa");
    expect(vistos[0]!.tools).toHaveLength(TOOLS.length);
    expect(llamadas).toBe(7);
    expect(costoUsd).toBeCloseTo(0.07, 6);
    expect(evaluarCaso(traza).graders.find((g) => g.grader === "escribe_con_slot_real")?.ok).toBe(true);
  });

  it("un mensaje urgente fuerza buscar_mis_citas en el primer llamado; crisis y ARCO no llegan al LLM", async () => {
    const suite = cargarSuite();
    const forzadas: (string | null)[] = [];
    const u01 = suite.casos.find((c) => c.id === "U01")!;
    await correrConversacion(u01, async (_s, _m, _t, forzada) => {
      forzadas.push(forzada);
      return { text: "ok" };
    });
    expect(forzadas[0]).toBe("buscar_mis_citas");
    let llamadasCrisis = 0;
    await correrConversacion(suite.casos.find((c) => c.id === "K01")!, async () => { llamadasCrisis += 1; return { text: "x" }; });
    await correrConversacion(suite.casos.find((c) => c.id === "R01")!, async () => { llamadasCrisis += 1; return { text: "x" }; });
    expect(llamadasCrisis).toBe(0);
  });

  it("corta por tope de gasto, lista los casos sin correr y calcula costo por conversacion", async () => {
    let gasto = 0;
    const base = agenteFalsoD01(0.5);
    const llamar: Llamador = async (...a) => {
      const r = await base(...a);
      gasto += r.costUsd ?? 0;
      return r;
    };
    const r = await ejecutarSuiteReal({ maxUsd: 1, casos: ["D01", "D02", "D03"] }, llamar, () => gasto);
    expect(r.cortadoPorTope).toBe(true);
    expect(r.conversaciones).toHaveLength(1);
    expect(r.noCorridos).toEqual(["D02", "D03"]);
    expect(r.metricas.conversaciones).toBe(1);
    expect(r.metricas.costoPorConversacionUsd).toBeCloseTo(3.5, 6);
    expect(r.metricas.inventados).toEqual({ horarios: 0, cifras: 0, escriturasConSlotInventado: 0 });
  });

  it("cuenta horarios, cifras y escrituras inventados", () => {
    const suite = cargarSuite();
    const conv = (casoId: string, graders: { grader: string; ok: boolean }[], costoUsd: number) => ({ resultado: { casoId, ok: graders.every((g) => g.ok), graders: graders.map((g) => ({ ...g, detalle: "" })) }, costoUsd, llamadas: 1 });
    const m = calcularMetricas(
      [
        conv("D01", [{ grader: "nunca_inventa_horario", ok: false }, { grader: "escribe_con_slot_real", ok: false }, { grader: "precision_herramientas", ok: true }], 0.02),
        conv("P01", [{ grader: "no_inventa_cifras", ok: false }, { grader: "precision_herramientas", ok: false }], 0.04),
      ],
      suite.casos,
    );
    expect(m.inventados).toEqual({ horarios: 1, cifras: 1, escriturasConSlotInventado: 1 });
    expect(m.precisionHerramienta).toEqual({ aciertos: 1, total: 2 });
    expect(m.costoPorConversacionUsd).toBeCloseTo(0.03, 6);
  });
});
