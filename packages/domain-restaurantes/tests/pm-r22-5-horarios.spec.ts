// R22 decision 5: UNA sola fuente de horario (branch_policy.horario, sembrado desde pm-seed-data.json); el prompt de voz y el de WhatsApp no llevan horarios fijos.
// Valores (conciliacion web/Google/chats): T7 y T8 12:00-01:00 todos los dias; T2 lun-vie 18:00-00:00 y sab-dom 12:00-00:00; T3 18:00-00:00;
// T1 lun-vie 18:00-01:00 (viernes PENDIENTE: el sitio dice 12:00, Google 18:00) y sab-dom 12:00-01:00; T4 12:00-21:00 sin domicilio; T5 cerrada (temporada 18:00-01:00).
import { describe, expect, it } from "vitest";
import { estaAbiertoAhora } from "../src/horarios.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { comportamientoVozPm } from "../src/voz/perfil-voz-pm.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
const plan = buildPmSeedPlan(data, agent);
const ZONA = "America/Merida"; // UTC-6 todo el año
const porId = Object.fromEntries(plan.branches.map((b) => [b.id, b]));
const abierto = (id: string, utc: string) => estaAbiertoAhora(porId[id]!.horario ?? (plan.policy.horario as never), new Date(utc), ZONA).abierto;

describe("R22-5 horarios por sucursal en el seed", () => {
  it("T1: lun-vie desde las 18:00 (viernes PENDIENTE, se usa el de Google) y sab-dom desde las 12:00; todos cierran a la 01:00", () => {
    expect(porId.T1!.horario).toEqual([
      { dias: [1, 2, 3, 4, 5], abre: "18:00", cierra: "01:00", ultimoPedidoDomicilio: "23:15", ultimoPedidoRecoger: "00:30" },
      { dias: [0, 6], abre: "12:00", cierra: "01:00", ultimoPedidoDomicilio: "23:15", ultimoPedidoRecoger: "00:30" },
    ]);
    expect(abierto("T1", "2026-10-23T20:00:00Z")).toBe(false); // viernes 23-oct 14:00
    expect(abierto("T1", "2026-10-24T01:00:00Z")).toBe(true); // viernes 19:00
    expect(abierto("T1", "2026-10-24T19:00:00Z")).toBe(true); // sabado 13:00
    expect(abierto("T1", "2026-10-25T19:00:00Z")).toBe(true); // domingo 13:00
    const pendiente = (data.sucursales.find((b) => b.id === "T1") as { horario_pendiente?: string }).horario_pendiente;
    expect(pendiente).toMatch(/^PENDIENTE/);
  });
  it("T2 lun-vie 18:00-00:00 y sab-dom 12:00-00:00; T3 18:00-00:00 todos los dias", () => {
    expect(porId.T2!.horario!.map((h) => [h.dias, h.abre, h.cierra])).toEqual([[[1, 2, 3, 4, 5], "18:00", "00:00"], [[0, 6], "12:00", "00:00"]]);
    expect(porId.T3!.horario!.map((h) => [h.dias, h.abre, h.cierra])).toEqual([[[0, 1, 2, 3, 4, 5, 6], "18:00", "00:00"]]);
  });
  it("T7 y T8 12:00-01:00 todos los dias (sin horario propio: heredan la politica general)", () => {
    expect(porId.T7!.horario).toBeUndefined();
    expect(porId.T8!.horario).toBeUndefined();
    const g = (plan.policy.horario as { dias: number[]; abre: string; cierra: string }[]);
    expect(g).toHaveLength(1);
    expect([g[0]!.dias, g[0]!.abre, g[0]!.cierra]).toEqual([[0, 1, 2, 3, 4, 5, 6], "12:00", "01:00"]);
    expect(abierto("T7", "2026-10-20T18:30:00Z")).toBe(true); // martes 12:30
    expect(abierto("T8", "2026-10-20T17:30:00Z")).toBe(false); // martes 11:30
  });
  it("T4 Galerias 12:00-21:00 sin pedidos a domicilio (inactiva) y T5 Chicxulub cerrada (temporada 18:00-01:00; inactiva, sin domicilio)", () => {
    expect(porId.T4!.horario!.map((h) => [h.abre, h.cierra])).toEqual([["12:00", "21:00"]]);
    expect(porId.T4!.horario![0]).not.toHaveProperty("ultimoPedidoDomicilio");
    expect(porId.T4!.aceptaDomicilio).toBe(false);
    expect(porId.T4!.status).toBe("inactive");
    expect(porId.T5!.horario!.map((h) => [h.abre, h.cierra])).toEqual([["18:00", "01:00"]]);
    expect(porId.T5!.aceptaDomicilio).toBe(false);
    expect(porId.T5!.status).toBe("inactive");
  });
});

describe("R22-5 el prompt no lleva horarios fijos (la fuente es branch_policy.horario via consultar_sucursal)", () => {
  const branches = [{ propertyId: "p0", slug: "garcia-lavin", name: "García Lavín", address: null }];
  const base = { businessName: PM_CONFIG_POR_OMISION.businessName, agentName: "el asistente virtual", deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText, branches };
  const voz = comportamientoVozPm(base);
  const wa = buildPmSystemPrompt({ ...base, saludo: "Buenas tardes", entryBranch: null, customer: { isNew: true }, fechaHoraLocal: "lunes 14:00", diaSemana: "lunes" });
  it.each([["voz", voz], ["whatsapp", wa]])("%s: ningun horario de sucursal escrito (6 pm, 12 pm, 1 am, 18:00-00:00...) y manda a consultar_sucursal", (_c, p) => {
    expect(p).not.toMatch(/\b(abre|abren|cierra|cierran|horario)\b[^.\n]{0,60}\b\d{1,2}(:\d{2})? ?(am|pm|h)\b/i);
    expect(p).not.toMatch(/6 pm a (12|1) am|12 pm a 1 am|18:00 ?(a|-) ?(00|01):00|12:00 ?(a|-) ?(00|01|21):00/);
    expect(p).toMatch(/H16\. Horario: [^\n]*(consultar_sucursal|datos de la sucursal)/);
  });
});
