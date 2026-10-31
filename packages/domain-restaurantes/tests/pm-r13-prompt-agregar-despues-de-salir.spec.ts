// PM R13 Q7 / P20 (T7-043): el cliente quiere agregar algo cuando su pedido YA SALIÓ. El guion del juez esperaba «aprox. 60 min / pedirlo después», dato que nadie tiene (H6).
// Decisión de Javier (R13, «hazlo según tu recomendación»): NO dar un tiempo inventado; la sucursal confirma el tiempo. El paso 16 del prompt ya manda decir que ya salió, que no se
// le puede agregar y ofrecer un pedido nuevo SIN volver a escalar: se CONSERVA tal cual (revisión independiente: una escalación nueva con cancelacion_modificacion abre toma de alto
// riesgo y contradice ese paso). La regla nueva solo prohíbe los tiempos aproximados al ofrecer ese pedido nuevo. Determinista, sin LLM.
import { describe, expect, it } from "vitest";
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

/** La oración nueva de la regla (desde «Si el pedido YA SALIÓ y ofrece» hasta «la sucursal lo confirma.»). */
const reglaNueva = (/Si el pedido YA SALIÓ y ofrece[^\n]*?o diga que la sucursal lo confirma\./.exec(prompt) ?? [""])[0];

describe("PM R13 Q7: al ofrecer un pedido nuevo porque el anterior ya salió, sin tiempos inventados", () => {
  it("conserva el paso 16 tal cual: ya salió, no se le puede agregar, pedido nuevo sin volver a escalar", () => {
    expect(prompt).toMatch(/no se le puede agregar y ofrezca un pedido nuevo \(sin volver a escalar\)/);
  });

  it("prohíbe los tiempos aproximados inventados y manda dar solo el tiempo de la sucursal o decir que la sucursal lo confirma", () => {
    expect(reglaNueva).not.toBe("");
    expect(reglaNueva).toMatch(/pedido nuevo/);
    expect(reglaNueva).toMatch(/dé solo el tiempo de la sucursal/);
    expect(reglaNueva).toContain("dé solo el tiempo de la sucursal (paso 8) o diga que la sucursal lo confirma");
  });

  it("la regla nueva no agrega escalación ni motivo (no menciona escalar ni cancelacion_modificacion)", () => {
    expect(reglaNueva).not.toBe("");
    expect(reglaNueva).not.toMatch(/cancelacion_modificacion|escal/i);
  });

  it("el prompt ya no manda escalar con cancelacion_modificacion cuando el pedido YA SALIÓ", () => {
    expect(prompt).not.toMatch(/YA SALIÓ[^\n]{0,400}escale igual con cancelacion_modificacion/);
  });
});
