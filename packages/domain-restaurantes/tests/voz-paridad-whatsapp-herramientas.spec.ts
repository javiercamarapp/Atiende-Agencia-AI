// Paridad voz/WhatsApp en el SERVIDOR: las mismas herramientas con las mismas entradas y el mismo reloj dan la misma respuesta en los dos canales
// (horario cerrado, ultimo pedido, hora de recogida, packs de N piezas, direccion y pago). Lo que el cliente oye por telefono sale de estos mensajes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAgentToolSafely } from "../src/agent-tools/registry.ts";
import type { AgentToolContext, AgentToolName } from "../src/agent-tools/registry.ts";
import { HORARIO_PM } from "../src/voz/simulador/guiones-paridad.ts";
import { crearMundoVoz } from "../src/voz/simulador/mundo-voz.ts";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

const SUC = "fco-montejo";

async function correr(canal: "whatsapp" | "voz", ahora: string, tool: AgentToolName, args: (m: ReturnType<typeof crearMundoVoz>) => Record<string, unknown>) {
  vi.setSystemTime(new Date(ahora));
  const m = crearMundoVoz();
  m.repo.seedBranchPolicy(m.propertyId, { pedidoMinimoDomicilio: 200, horario: HORARIO_PM });
  await m.repo.upsertBranchZonaHoraria(m.propertyId, "America/Merida");
  const ctx: AgentToolContext = { organizationId: m.organizationId, channel: canal, phone: "9991234567", lockedPropertyId: m.propertyId, flow: { key: `t:${canal}`, turn: "1" } } as AgentToolContext;
  const salida = await executeAgentToolSafely(m.repo, ctx, tool, args(m));
  return salida.result as Record<string, unknown>;
}

const items = (m: ReturnType<typeof crearMundoVoz>, piezas: number) => [{ product_id: m.productos.bistec.id, product_name: m.productos.bistec.nombre, requested_quantity: piezas, tortilla: "maiz" }];
const CASOS: readonly { nombre: string; ahora: string; tool: AgentToolName; args: (m: ReturnType<typeof crearMundoVoz>) => Record<string, unknown> }[] = [
  { nombre: "cotizar con la sucursal cerrada (08:00)", ahora: "2026-10-07T08:00:00-06:00", tool: "cotizar_pedido", args: (m) => ({ branch_slug: SUC, canal: "recoger", items: items(m, 3) }) },
  { nombre: "cotizar despues del ultimo pedido (00:40)", ahora: "2026-10-08T00:40:00-06:00", tool: "cotizar_pedido", args: (m) => ({ branch_slug: SUC, canal: "recoger", items: items(m, 3) }) },
  { nombre: "cotizar con hora de recogida despues del ultimo pedido", ahora: "2026-10-08T00:10:00-06:00", tool: "cotizar_pedido", args: (m) => ({ branch_slug: SUC, canal: "recoger", hora_recogida: "2026-10-08T00:50:00-06:00", items: items(m, 3) }) },
  { nombre: "cotizar cantidad no multiplo de la orden (4 tacos)", ahora: "2026-10-07T12:00:00-06:00", tool: "cotizar_pedido", args: (m) => ({ branch_slug: SUC, canal: "recoger", items: items(m, 4) }) },
  { nombre: "cotizar en horario normal", ahora: "2026-10-07T12:00:00-06:00", tool: "cotizar_pedido", args: (m) => ({ branch_slug: SUC, canal: "recoger", items: items(m, 3) }) },
  { nombre: "consultar_sucursal a las 12:00", ahora: "2026-10-07T12:00:00-06:00", tool: "consultar_sucursal", args: () => ({ branch_slug: SUC }) },
  { nombre: "consultar_sucursal despues del ultimo pedido", ahora: "2026-10-08T00:40:00-06:00", tool: "consultar_sucursal", args: () => ({ branch_slug: SUC }) },
  { nombre: "consultar_sucursal cerrada", ahora: "2026-10-07T08:00:00-06:00", tool: "consultar_sucursal", args: () => ({ branch_slug: SUC }) },
];

describe("paridad voz/WhatsApp de las herramientas del servidor", () => {
  it.each(CASOS.map((c) => [c.nombre, c] as const))("%s: misma respuesta en voz y WhatsApp", async (_n, c) => {
    const wa = await correr("whatsapp", c.ahora, c.tool, c.args);
    const vz = await correr("voz", c.ahora, c.tool, c.args);
    // Ids de producto/pedido cambian entre mundos: se comparan los textos y los campos escalares.
    // Las horas ya habladas (`*_hablada`) son SOLO de voz a proposito: se quitan antes de comparar.
    const norm = (o: Record<string, unknown>) => JSON.stringify(o, (k, v) => (k.endsWith("_hablada") ? undefined : typeof v === "string" && /^[0-9a-f-]{36}$/.test(v) ? "<id>" : /hash|firma/i.test(k) ? "<h>" : v));
    expect(norm(vz)).toBe(norm(wa));
  });
});
