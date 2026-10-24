// Un cierre a las 00:00 (T2 y T3 de PM) se le dice al cliente como «12:00 a. m. (medianoche)», nunca «a las 00:00»: textos del servidor y
// campos de las herramientas del agente (aditivo: `cierra_a` sigue igual, `cierra_a_texto` es el legible).
import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { mensajeProgramadoFueraDeHorario, mensajeSucursalCerrada, type EstadoApertura } from "../src/horarios.ts";
import { quoteOrder } from "../src/orders.ts";
import { acuseHandoffPendiente } from "../src/whatsapp/inbound.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const MEDIANOCHE = "12:00 a. m. (medianoche)";
afterEach(() => vi.useRealTimers());

describe("consultar_sucursal y cotizacion con cierre 00:00", () => {
  it("consultar_sucursal: cierra_a sigue '00:00' y cierra_a_texto dice la medianoche", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T05:30:00Z")); // martes 20-oct 23:30 en Merida
    const f = buildRestaurantFixture();
    void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
    f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "18:00", cierra: "00:00" }] });
    const r = await invokeAgentTool(f.repo, { organizationId: f.organizationId, channel: "voz", phone: "9991234567" }, "consultar_sucursal", { branch_slug: "fco-montejo" });
    expect(r.result).toMatchObject({ abierto_ahora: true, cierra_a: "00:00", cierra_a_texto: MEDIANOCHE });
  });

  it("consultar_sucursal: otro cierre (01:00) queda tal cual en cierra_a_texto", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T05:30:00Z"));
    const f = buildRestaurantFixture();
    void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
    f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
    const r = await invokeAgentTool(f.repo, { organizationId: f.organizationId, channel: "voz", phone: "9991234567" }, "consultar_sucursal", { branch_slug: "fco-montejo" });
    expect(r.result).toMatchObject({ cierra_a: "01:00", cierra_a_texto: "01:00" });
  });
});

describe("textos del servidor con cierre 00:00 o apertura 00:00", () => {
  it("pedido programado despues del cierre de T3: «Hoy cierra a las 12:00 a. m. (medianoche)», sin «00:00»", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T04:00:00Z")); // martes 20-oct 22:00 en Merida: T3 abierta
    const { data, agent } = loadSeedInputs();
    const world = await buildInMemoryPmWorld(buildPmSeedPlan(data, agent));
    const err = await quoteOrder(world.repo, {
      organizationId: world.organizationId,
      branchSlug: "pensiones",
      canal: "recoger",
      horaRecogida: "2026-10-21T00:30:00-06:00", // miercoles 00:30: ya cerrada (recogida de hoy)
      items: [{ productId: world.productIds.get("Nachos de Pastor")!, requestedQuantity: 1 }],
    }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain(`Hoy cierra a las ${MEDIANOCHE}`);
    expect(err?.message).not.toContain("00:00");
  });

  const cerradaQueAbreAMedianoche: EstadoApertura = { abierto: false, cierraA: null, proximaApertura: { dia: "viernes", hora: "00:00", hoy: false } };
  it("sucursal cerrada, pedido programado fuera de horario y acuse de handoff dicen la medianoche", () => {
    expect(mensajeSucursalCerrada("Demo", cerradaQueAbreAMedianoche)).toContain(`a las ${MEDIANOCHE}`);
    expect(mensajeProgramadoFueraDeHorario("Demo", "jueves 22/10 14:00", cerradaQueAbreAMedianoche)).toContain(`a las ${MEDIANOCHE}`);
    expect(acuseHandoffPendiente(cerradaQueAbreAMedianoche)).toContain(`el viernes a las ${MEDIANOCHE}`);
    for (const t of [mensajeSucursalCerrada("Demo", cerradaQueAbreAMedianoche), acuseHandoffPendiente(cerradaQueAbreAMedianoche)]) expect(t).not.toContain("00:00");
  });
});
