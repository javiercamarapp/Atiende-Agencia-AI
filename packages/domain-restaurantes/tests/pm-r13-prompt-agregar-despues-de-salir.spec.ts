// PM R13 Q7 / P20 (T7-043): el cliente quiere agregar algo cuando su pedido YA SALIÓ. El guion del juez esperaba «aprox. 60 min / pedirlo después», dato que nadie tiene
// (H6). Decisión de Javier (R13, «hazlo según tu recomendación»): NO dar un tiempo inventado; decir que la sucursal le confirma si todavía se puede agregar o si va en un
// envío aparte, y avisar al equipo con el motivo que ya existe (cancelacion_modificacion). Asunción a confirmar con PM: que la sucursal sea quien decida el envío aparte.
// Esta prueba ata que el PROMPT lo diga. Determinista, sin LLM.
import { describe, expect, it } from "vitest";
import { MOTIVOS_ESCALACION } from "../src/agent-tools/registry.ts";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import type { BranchSummary } from "../src/types.ts";

const SUCURSALES: BranchSummary[] = [{ propertyId: "p0", slug: "garcia-lavin", name: "García Lavín", address: null }];
const prompt = buildPmSystemPrompt({
  businessName: PM_CONFIG_POR_OMISION.businessName,
  agentName: "el asistente virtual",
  deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
  saludo: "Buenas tardes",
  branches: SUCURSALES,
  entryBranch: null,
  customer: { isNew: true },
  fechaHoraLocal: "lunes 14:00",
  diaSemana: "lunes",
});

describe("PM R13 Q7: agregar algo cuando el pedido ya salió, sin tiempos inventados", () => {
  it("no da ningún tiempo ni plazo para el agregado (nada de «aprox. 60 min»)", () => {
    expect(prompt).toMatch(/Si el pedido YA SALIÓ[^.]*no dé ningún tiempo ni plazo para el agregado/);
  });

  it("dice que la sucursal le confirma si todavía se puede agregar o si va en un envío aparte", () => {
    expect(prompt).toContain("la sucursal le confirma si todavía se puede agregar o si va en un envío aparte");
  });

  it("escala con el motivo existente cancelacion_modificacion (no inventa uno nuevo)", () => {
    expect(MOTIVOS_ESCALACION as readonly string[]).toContain("cancelacion_modificacion");
    expect(prompt).toMatch(/YA SALIÓ[^]*escale igual con cancelacion_modificacion/);
  });

  it("conserva la frase de #cambios después de confirmar para pedidos aún en cocina", () => {
    expect(prompt).toContain("Lo paso a cocina; si el pedido ya salió, se lo pueden enviar aparte.");
  });
});
