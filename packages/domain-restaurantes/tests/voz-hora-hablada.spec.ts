// La voz dice las horas con palabras ("doce y media de la noche"), no "00:30": el sintetizador lee "00:30" como numeros sueltos. `consultar_sucursal` las entrega
// ya habladas SOLO en voz (WhatsApp conserva HH:MM) y, en ambos canales, trae ademas la hora del ultimo pedido legible (paridad con el prompt de WhatsApp).
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAgentToolSafely } from "../src/agent-tools/registry.ts";
import type { AgentToolContext } from "../src/agent-tools/registry.ts";
import { horaHablada } from "../src/horarios.ts";
import { HORARIO_PM } from "../src/voz/simulador/guiones-paridad.ts";
import { crearMundoVoz } from "../src/voz/simulador/mundo-voz.ts";

afterEach(() => vi.useRealTimers());

describe("horaHablada", () => {
  it.each([
    ["00:00", "doce de la noche (medianoche)"],
    ["00:30", "doce y media de la noche"],
    ["01:00", "una de la mañana"],
    ["06:15", "seis y cuarto de la mañana"],
    ["12:00", "doce del día"],
    ["12:05", "doce y cinco del día"],
    ["13:45", "una y cuarenta y cinco de la tarde"],
    ["18:00", "seis de la tarde"],
    ["20:30", "ocho y media de la noche"],
    ["23:59", "once y cincuenta y nueve de la noche"],
    ["01:15", "una y cuarto de la mañana"],
    ["23:45", "once y cuarenta y cinco de la noche"],
    ["12:30", "doce y media del día"],
    ["12:21", "doce y veintiuno del día"],
    ["00:01", "doce y uno de la noche"],
    ["01:31", "una y treinta y uno de la mañana"],
    ["13:01", "una y uno de la tarde"],
  ])("%s -> %s", (hhmm, dicho) => expect(horaHablada(hhmm)).toBe(dicho));
  it("una entrada que no es HH:MM se devuelve tal cual (nunca inventa una hora)", () => {
    expect(horaHablada("pronto")).toBe("pronto");
    expect(horaHablada("25:00")).toBe("25:00");
    expect(horaHablada("10:75")).toBe("10:75");
  });
});

async function consultar(canal: "whatsapp" | "voz", ahora: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(ahora));
  const m = crearMundoVoz();
  m.repo.seedBranchPolicy(m.propertyId, { pedidoMinimoDomicilio: 200, horario: HORARIO_PM });
  await m.repo.upsertBranchZonaHoraria(m.propertyId, "America/Merida");
  const ctx = { organizationId: m.organizationId, channel: canal, phone: "9991234567", lockedPropertyId: m.propertyId } as AgentToolContext;
  return (await executeAgentToolSafely(m.repo, ctx, "consultar_sucursal", { branch_slug: "fco-montejo" })).result as Record<string, unknown>;
}

describe("consultar_sucursal: horas para decir en voz", () => {
  it("en voz trae cierre, ultimo pedido y hora local hablados; en WhatsApp no", async () => {
    const vz = await consultar("voz", "2026-10-08T00:20:00-06:00");
    expect(vz).toMatchObject({ cierra_a: "01:00", ultimo_pedido_a: "00:30", cierra_a_hablada: "una de la mañana", ultimo_pedido_a_hablada: "doce y media de la noche", hora_local_hablada: "doce y veinte de la noche" });
    const wa = await consultar("whatsapp", "2026-10-08T00:20:00-06:00");
    expect(Object.keys(wa).filter((k) => k.endsWith("_hablada"))).toEqual([]);
  });
  it("en los dos canales trae ultimo_pedido_a_texto (como cierra_a_texto)", async () => {
    for (const canal of ["voz", "whatsapp"] as const) {
      const r = await consultar(canal, "2026-10-07T12:00:00-06:00");
      expect(r.ultimo_pedido_a_texto, canal).toBe("00:30");
      expect(r.cierra_a_texto, canal).toBe("01:00");
    }
  });
  it("cerrada: sin horas habladas de ultimo pedido (null)", async () => {
    const vz = await consultar("voz", "2026-10-07T08:00:00-06:00");
    expect(vz).toMatchObject({ abierto_ahora: false, ultimo_pedido_a_hablada: null, cierra_a_hablada: null });
  });
});
