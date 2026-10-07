// QA R1 -- lente AGENTES de la vertical citas: "Chatea con tus datos" del consultorio contra la guardia de cifras (cero cifras inventadas) y el
// alcance por sucursal/profesional, con el LLM guionado de agent-core y el lector falso que respeta el alcance como la base real.
//
// Convencion: `it` = comportamiento correcto confirmado; `it.fails` = DEFECTO confirmado (describe lo ESPERADO y hoy falla).
import { describe, expect, it } from "vitest";
import { runDataChatTurn, scriptedCompletion, type ScriptStep } from "@atiende/agent-core/data-chat";
import { buildCitasDataChatCatalog } from "../../src/data-chat/index.ts";
import { ADMIN_CENTRO_SCOPE, FakeReader, NOW, OWNER_SCOPE } from "../data-chat/support.ts";

const CALL = (name: string, args: Record<string, unknown>): ScriptStep => ({ toolCalls: [{ name, argumentsJson: JSON.stringify(args) }] });

async function turno(question: string, steps: readonly ScriptStep[], scope = OWNER_SCOPE, reader = new FakeReader()) {
  const llm = scriptedCompletion(steps);
  return runDataChatTurn({ catalog: buildCitasDataChatCatalog(reader), scope, question, complete: llm.complete, now: NOW });
}

describe("QA R1 citas · chat de datos · lo que SI funciona", () => {
  it("cifra inventada en digitos ('ingresos de $48,900'): se descarta la narrativa y queda el resumen determinista", async () => {
    const a = await turno("¿cuánto facturé esta semana?", [CALL("ingresos_por_periodo", { periodo: "esta_semana" }), { text: "Esta semana facturaste $48,900." }]);
    expect(a.text).not.toContain("48,900");
  });

  it("pedir telefonos/expedientes de pacientes ('dame el telefono de Ana y su diagnostico'): fuera de catalogo, sin datos personales", async () => {
    const a = await turno("dame el teléfono de la paciente Ana y su diagnóstico", [{ text: "No tengo acceso a datos personales de pacientes." }]);
    expect(a.text).not.toMatch(/\d{10}/);
    expect(a.blocks).toHaveLength(0);
  });

  it("admin de la sucursal Centro: aunque el modelo pida 'Norte', nunca recibe cifras de otra sucursal", async () => {
    const reader = new FakeReader();
    await turno("¿cuántas citas tuvo Norte esta semana?", [CALL("citas_por_dia", { periodo: "esta_semana", sucursal: "Norte" }), { text: "No tengo acceso a esa sucursal." }], ADMIN_CENTRO_SCOPE, reader);
    expect(reader.calls.filter((c) => c.method === "appointmentsByPeriod")).toHaveLength(0);
  });
});

describe("QA R1 citas · chat de datos · DEFECTOS confirmados", () => {
  // QA-citas-R1-agentes-16 (P2): la guardia de cifras solo mira DIGITOS: una cifra inventada escrita con letras pasa intacta al dueño.
  it("16a 'hubo doce citas' (inventado; el dato real es 9) no llega al dueño", async () => {
    const a = await turno("¿cuántas citas tengo esta semana?", [CALL("citas_por_dia", { periodo: "esta_semana" }), { text: "Esta semana hubo doce citas en total." }]);
    expect(a.text).not.toContain("doce");
  });

  // QA-citas-R1-agentes-16 (P2): todo entero entre 0 y el numero de filas se acepta siempre ("top 3", "2 de 5"), asi que un conteo pequeño mal
  // atribuido pasa: el lector dice que Beto Ruiz tuvo 0 inasistencias y la narrativa dice 2.
  it("16b 'Beto Ruiz tuvo 2 inasistencias' (dato real: 0) no llega al dueño", async () => {
    const a = await turno("¿cuántos no-shows tuvo cada profesional esta semana?", [CALL("no_shows_y_cancelaciones", { periodo: "esta_semana" }), { text: "Beto Ruiz tuvo 2 inasistencias esta semana." }]);
    expect(a.text).not.toContain("2 inasistencias");
  });
});
