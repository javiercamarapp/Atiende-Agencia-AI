// FLAUTAS (Javier, 16-oct-2026): «una orden de flautas es UNA flauta grande» (pack_size 1). Los menús públicos no traen el dato; esta es la fuente.
// R10 T7-031 cobró $2,682 porque un cliente simulado dijo «4 flautas, una orden» y el modelo cotizó 4 órdenes con pack_size null. El guion del escenario
// («1 orden de flautas», total $1,833) era y sigue siendo correcto; lo que cambia es que ahora la unidad está cargada y la herramienta la explica.
// Alitas (7) y crujientes (~12) ya confirmados por Javier el 21-oct (paquete A); siguen sin pack_size porque el precio es por orden. Pruebas deterministas, sin LLM.
import { describe, expect, it } from "vitest";
import { invokeAgentTool, quoteToWire } from "../src/agent-tools/registry.ts";
import { buildOrderQuoteFromProducts } from "../src/order-quote.ts";
import { extraerPackSize, unidadDeVenta, unidadDeVentaFlautas, unidadDeVentaSinPiezas } from "../src/product-search.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import type { ProductoEncontrado } from "../src/types.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";
import menuEvals from "../src/evals/agente-pm/menu-pm.json" with { type: "json" };

const { data, agent } = loadSeedInputs();
const mundo = buildInMemoryPmWorld(buildPmSeedPlan(data, agent));
type Hallado = { id: string; name: string; price: number; pack_size: number | null; unidad_de_venta?: string };
const buscar = async (query: string) => {
  const w = await mundo;
  const out = await invokeAgentTool(w.repo, { organizationId: w.organizationId, channel: "whatsapp", phone: "9991234567" }, "buscar_producto", { query, branch_slug: "garcia-lavin" });
  return out.result as Hallado[];
};
const exacto = async (nombre: string): Promise<ProductoEncontrado> => {
  const h = (await buscar(nombre)).find((p) => p.name === nombre);
  if (!h) throw new Error(`sin ${nombre}`);
  return { id: h.id, name: h.name, price: h.price, packSize: h.pack_size, requiresAdultConfirmation: false };
};
const cotiza = (items: Array<[ProductoEncontrado, number]>) =>
  buildOrderQuoteFromProducts(items.map(([p, n]) => ({ productId: p.id, requestedQuantity: n })), items.map(([p]) => p));

describe("FLAUTAS: una orden = UNA flauta grande (pack_size 1 en el seed)", () => {
  it("las 7 flautas del seed traen pack_size 1 en garcia-lavin y el aviso de unidad", async () => {
    const flautas = data.productos.filter((p) => /^Flauta /.test(p.nombre));
    expect(flautas).toHaveLength(7);
    for (const f of flautas) {
      expect(extraerPackSize(f.nombre, f.descripcion), f.nombre).toBe(1);
      const h = (await buscar(f.nombre)).find((p) => p.name === f.nombre)!;
      expect(h.pack_size, f.nombre).toBe(1);
      expect(h.unidad_de_venta, f.nombre).toMatch(/Cada ORDEN de flautas es UNA flauta grande/);
    }
  });

  it("el menú del arnés de evaluación ya trae pack_size 1 en las 7 flautas", () => {
    const flautas = menuEvals.productos.filter((p) => /^Flauta /.test(p.nombre));
    expect(flautas).toHaveLength(7);
    for (const f of flautas) expect(f.pack_size, f.nombre).toBe(1);
  });

  it("1, 2 y 4 flautas de pechuga: $283, $566, $1,132 (cada flauta es una orden)", async () => {
    const f = await exacto("Flauta de Pechuga");
    expect(f.packSize).toBe(1);
    for (const [n, total] of [[1, 283], [2, 566], [4, 1132]] as const) {
      const q = cotiza([[f, n]]);
      expect(q.lines[0]!.quantity, `${n} flautas`).toBe(n);
      expect(q.total, `${n} flautas`).toBe(total);
    }
  });

  it("no existe «media flauta»: el seed no trae presentación de 1/2 y una cantidad fraccionaria o 0 se rechaza", async () => {
    expect(data.productos.filter((p) => /^Flauta /.test(p.nombre) && /1\/2|media/i.test(p.nombre))).toHaveLength(0);
    const f = await exacto("Flauta de Pechuga");
    expect(() => cotiza([[f, 0.5]])).toThrow();
    expect(() => cotiza([[f, 0]])).toThrow();
  });

  it("combinadas: T7-031 con 1 orden = $1,833; con 4 flautas (4 órdenes) = $2,682; mezcla de sabores suma por precio de cada una", async () => {
    const bistec = await exacto("Bistec de Res — 1 kg");
    const pastor = await exacto("Pastor — 500 g");
    const pechuga = await exacto("Flauta de Pechuga");
    expect(cotiza([[bistec, 1], [pastor, 1], [pechuga, 1]]).total).toBe(1100 + 450 + 283);
    expect(cotiza([[bistec, 1], [pastor, 1], [pechuga, 4]]).total).toBe(1100 + 450 + 4 * 283);
    const arrachera = await exacto("Flauta de Arrachera");
    const poc = await exacto("Flauta de Poc-Chuc");
    expect(cotiza([[pechuga, 1], [arrachera, 2], [poc, 1]]).total).toBe(283 + 2 * arrachera.price + poc.price);
  });

  it("la cotización también lleva la unidad para que el agente la repita al cliente", async () => {
    const f = await exacto("Flauta de Pechuga");
    const wire = quoteToWire(cotiza([[f, 2]]));
    expect(wire.lines[0]!.unidad_de_venta).toMatch(/UNA flauta grande/);
  });
});

describe("T7-031: «4 flautas, una orden» es contradictorio; no se adivina (documentado)", () => {
  it("la unidad manda PREGUNTAR en vez de elegir; las dos lecturas tienen su total", async () => {
    const f = await exacto("Flauta de Pechuga");
    const msg = unidadDeVentaFlautas(f)!;
    expect(msg).toMatch(/«4 flautas, una orden»/);
    expect(msg).toMatch(/NO adivines/);
    // lectura A: «una orden» = 1 flauta grande
    expect(cotiza([[f, 1]]).total).toBe(283);
    // lectura B: «4 flautas» = 4 órdenes
    expect(cotiza([[f, 4]]).total).toBe(1132);
  });
});

describe("alitas y crujientes: sin pack_size: 7 piezas y ~12 confirmadas por Javier", () => {
  it("pack_size null y aviso de ORDEN sin piezas; el aviso ya no menciona flautas", async () => {
    for (const q of ["alitas de pollo", "crujientes de pechuga"]) {
      const r = await buscar(q);
      expect(r.length, q).toBeGreaterThan(0);
      expect(r[0]!.pack_size, q).toBeNull();
      expect(r[0]!.unidad_de_venta, q).toMatch(/ORDEN completa/);
      expect(r[0]!.unidad_de_venta, q).toMatch(q.startsWith("alitas") ? /7 piezas/ : /aproximadamente 12/);
      expect(r[0]!.unidad_de_venta, q).not.toMatch(/flauta/i);
    }
  });

  it("un taco o una bebida no llevan aviso; los tacos conservan su pack_size 3", async () => {
    const tacos = await buscar("tacos de bistec");
    expect(tacos.some((p) => p.pack_size === 3)).toBe(true);
    for (const p of tacos) expect(p.unidad_de_venta).toBeUndefined();
    for (const p of await buscar("coca cola")) expect(p.unidad_de_venta).toBeUndefined();
  });

  it("si PM confirma las piezas y se carga «(orden de N)», el aviso desaparece solo y pack_size manda", () => {
    expect(extraerPackSize("Alitas de Pollo (orden de 7)", null)).toBe(7);
    expect(unidadDeVentaSinPiezas({ name: "Alitas de Pollo (orden de 7)", packSize: 7 })).toBeNull();
    expect(unidadDeVentaSinPiezas({ name: "Alitas de Pollo", packSize: null })).not.toBeNull();
    expect(unidadDeVenta({ name: "Flauta de Pechuga (orden de 2)", packSize: 2 })).toBeNull();
  });
});
