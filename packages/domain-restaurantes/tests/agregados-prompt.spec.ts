// La regla de agregados del prompt solo existe cuando el servidor cablea los agregados (099): sin eso el prompt es BYTE-IDENTICO al de siempre (nada de reglas que se pelean).
import { describe, expect, it } from "vitest";
import { PM_CONFIG_POR_OMISION, buildSystemPrompt } from "../src/whatsapp/llm-turn-handler.ts";
import { PM_AGREGADOS_REGLA } from "../src/whatsapp/perfil-pm.ts";
import type { BranchSummary } from "../src/types.ts";

const SUCURSALES: BranchSummary[] = [{ propertyId: "p0", slug: "garcia-lavin", name: "García Lavín", address: null }];
const base = (activos?: boolean) => buildSystemPrompt(PM_CONFIG_POR_OMISION, SUCURSALES, { isNew: true }, new Date("2026-10-24T20:00:00Z"), null, "", "", activos);

describe("prompt de agregados por validar", () => {
  it("sin los agregados cableados el prompt no cambia ni un caracter", () => {
    expect(base(false)).toBe(base());
    expect(base()).not.toContain("solicitar_agregado_pedido");
  });
  it("con los agregados cableados agrega la regla que manda usar la herramienta, sin minutos ni «ya quedó agregado»", () => {
    const p = base(true);
    expect(p).toContain(PM_AGREGADOS_REGLA);
    expect(p).toContain("solicitar_agregado_pedido");
    expect(PM_AGREGADOS_REGLA).toMatch(/NUNCA diga que ya quedó agregado/);
    expect(PM_AGREGADOS_REGLA).toMatch(/NO dé minutos ni horas/);
    expect(PM_AGREGADOS_REGLA).toMatch(/Cancelar[^.]*siguen por escalar_a_humano/);
  });
});
