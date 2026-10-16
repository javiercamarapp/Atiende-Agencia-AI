// QA-PM-R3-whatsapp-06 (P1): fuera de horario "por minutos" el agente aceptaba una recogida y daba tiempos sin decir que la sucursal estaba cerrada ni cuando abre
// (R3W28 a la 1:10 con cierre a la 1:00; R3W26 a las 11:57 con apertura a las 12:00). El servidor calcula el estado con el horario y lo pone en el prompt.
import { describe, expect, it } from "vitest";
import { estadoSucursalParaPrompt } from "../src/whatsapp/llm-turn-handler.ts";
import { PM_AGENT_NAME_POR_OMISION, buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { instruccionVozConReglas } from "../src/voz/perfil-voz-pm.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

async function mundo(horario: { dias: number[]; abre: string; cierra: string }[] | null) {
  const f = buildRestaurantFixture();
  if (horario) f.repo.seedBranchPolicy(f.propertyId, { horario });
  await f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  const branch = (await f.repo.findBranch(f.organizationId, { slug: "fco-montejo" }))!;
  return { f, branch };
}
const TODOS = [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }];
const a = (iso: string) => new Date(iso);

describe("estado de la sucursal en el prompt", () => {
  it("01:10 (cerro a la 1:00): CERRADA, dice cuando abre y prohibe tomar pedido u hora", async () => {
    const m = await mundo(TODOS);
    const t = await estadoSucursalParaPrompt(m.f.repo, m.branch, a("2026-10-07T01:10:00-06:00"));
    expect(t).toMatch(/CERRADA ahora; abre hoy a las 12:00/);
    expect(t).toMatch(/tome el pedido y PROGRÁMELO con programado_para/);
    expect(t).not.toMatch(/NO tome el pedido|escale \(otro\)/);
  });
  it("11:57 (abre a las 12:00): CERRADA con la hora de apertura", async () => {
    const m = await mundo(TODOS);
    expect(await estadoSucursalParaPrompt(m.f.repo, m.branch, a("2026-10-07T11:57:00-06:00"))).toMatch(/CERRADA ahora; abre hoy a las 12:00/);
  });
  it("13:00: ABIERTA y cierra a la 01:00", async () => {
    const m = await mundo(TODOS);
    const t = await estadoSucursalParaPrompt(m.f.repo, m.branch, a("2026-10-06T13:00:00-06:00"));
    expect(t).toMatch(/ABIERTA y cierra a las 01:00/);
  });
  it("00:57 (turno que cruza la medianoche) sigue ABIERTA", async () => {
    const m = await mundo(TODOS);
    expect(await estadoSucursalParaPrompt(m.f.repo, m.branch, a("2026-10-07T00:57:00-06:00"))).toMatch(/ABIERTA/);
  });
  it("sin horario configurado o sin sucursal no agrega nada (el prompt queda como antes)", async () => {
    const m = await mundo(null);
    expect(await estadoSucursalParaPrompt(m.f.repo, m.branch, new Date())).toBe("");
    expect(await estadoSucursalParaPrompt(m.f.repo, null, new Date())).toBe("");
  });
  it("el prompt de PM lo incluye en el contexto de la conversacion", () => {
    const p = buildPmSystemPrompt({
      businessName: "Los Taquitos de PM", agentName: PM_AGENT_NAME_POR_OMISION, deliveryTimeText: "de 40 a 50 minutos", saludo: "Buenas noches",
      branches: [], entryBranch: null, customer: { isNew: true }, estadoSucursalAhora: "García Lavín está CERRADA ahora; abre hoy a las 12:00.",
    });
    expect(p).toMatch(/Estado de la sucursal de este chat AHORA[^\n]*CERRADA ahora; abre hoy a las 12:00/);
  });

  // Ronda 8 (decision de Javier): cerrada = tomar y PROGRAMAR. El estado que inyecta el servidor "gana" (no lo contradiga), asi que NO puede contradecir H16.
  it("R8: con la sucursal CERRADA, el prompt completo (WhatsApp y voz) manda programar y no contiene la prohibicion vieja", async () => {
    const m = await mundo(TODOS);
    const estado = await estadoSucursalParaPrompt(m.f.repo, m.branch, a("2026-10-07T01:10:00-06:00"));
    const base = { businessName: "Los Taquitos de PM", agentName: PM_AGENT_NAME_POR_OMISION, deliveryTimeText: "de 40 a 50 minutos", saludo: "Buenas noches", branches: [], entryBranch: null, customer: { isNew: true } as const, estadoSucursalAhora: estado };
    for (const canal of ["whatsapp", "voz"] as const) {
      const p = buildPmSystemPrompt({ ...base, canal });
      expect(p).toMatch(/CERRADA ahora; abre hoy a las 12:00/);
      expect(p).toMatch(/PROGRÁMELO con programado_para/);
      expect(p).not.toMatch(/NO tome el pedido ni acepte|no tome el pedido ni|no programe|si insiste, escale \(otro\)/);
    }
  });
  it("R8 voz: con un comportamiento guardado VIEJO ('no programe'), el bloque de reglas vigentes que se anexa al final trae la regla nueva", () => {
    const viejo = "H16. Horario: solo los datos. Cerrada: no programe; si insiste, escale (otro).";
    const instruccion = instruccionVozConReglas({ comportamiento: viejo });
    const bloque = instruccion.slice(instruccion.indexOf("# REGLAS VIGENTES DE LA PLATAFORMA"));
    expect(bloque).toMatch(/Cerrada: programe el pedido \(programado_para\)/);
    expect(bloque).not.toMatch(/no programe|Otro día: escale/);
  });
});
