// Menú en línea de PM (lostaquitosdepm.com, capturado el 15-oct-2026): los JSON de docs/demo-pm/menu-en-linea/ contra el seed y el menú del arnés.
// Pruebas deterministas (sin LLM, sin red). Solo se carga pack_size donde el menú público lo confirma (tacos: «las órdenes son de N tacos»);
// flautas, alitas y crujientes NO traen piezas en el sitio y siguen pendientes de PM (ver docs/demo-pm/menu-en-linea/README.md).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildOrderQuoteFromProducts } from "../src/order-quote.ts";
import type { ProductoEncontrado } from "../src/types.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(AQUI, "../../../docs/demo-pm/menu-en-linea");
const leer = <T>(archivo: string): T => JSON.parse(readFileSync(path.join(DIR, archivo), "utf8")) as T;
const MENU_EVALS = leer<unknown>("../../../packages/domain-restaurantes/src/evals/agente-pm/menu-pm.json") as { productos: Array<{ nombre: string; pack_size: number }> };

interface Presentacion { etiqueta: string; precio_mxn: number; piezas_por_orden: number | null; unidad_de_venta: string; seed_nombre?: string }
interface ProductoWeb { categoria: string; nombre: string; presentaciones: Presentacion[]; seed_nombre?: string }
interface Rama { sucursal: { slug: string; id_seed: string }; fuente: { sitio: string; capturado: string }; productos: ProductoWeb[]; promociones: Array<{ dia: string; precio_mxn: number | null }>; horarios_por_producto: unknown }
const SLUGS = ["prol-montejo", "garcia-lavin", "altabrisa", "fco-montejo", "pensiones", "galerias", "playa"] as const;
const ramas = Object.fromEntries(SLUGS.map((s) => [s, leer<Rama>(`${s}.json`)])) as Record<(typeof SLUGS)[number], Rama>;

const { data, agent } = loadSeedInputs();
const mundo = buildInMemoryPmWorld(buildPmSeedPlan(data, agent));
interface Hallado { id: string; name: string; price: number; pack_size: number | null }
const buscar = async (query: string, branch = "garcia-lavin"): Promise<Hallado[]> => {
  const w = await mundo;
  return (await invokeAgentTool(w.repo, { organizationId: w.organizationId, channel: "whatsapp", phone: "9991234567" }, "buscar_producto", { query, branch_slug: branch })).result as Hallado[];
};
const exacto = async (nombre: string): Promise<ProductoEncontrado> => {
  const h = (await buscar(nombre)).find((p) => p.name === nombre);
  if (!h) throw new Error(`no está en el catálogo de garcia-lavin: ${nombre}`);
  return { id: h.id, name: h.name, price: h.price, packSize: h.pack_size, requiresAdultConfirmation: false };
};

describe("JSON del menú en línea: forma y trazabilidad", () => {
  it.each(SLUGS)("%s: tiene URL fuente, fecha de captura, productos con precio y pendientes explícitos (sin inventar horarios)", (slug) => {
    const r = ramas[slug];
    expect(r.fuente.sitio).toBe("https://www.lostaquitosdepm.com");
    expect(r.fuente.capturado).toBe("2026-10-15");
    expect(r.productos.length).toBeGreaterThan(40);
    for (const p of r.productos) {
      expect(p.presentaciones.length, p.nombre).toBeGreaterThan(0);
      for (const pr of p.presentaciones) expect(Number.isFinite(pr.precio_mxn) && pr.precio_mxn > 0, `${p.nombre} ${pr.etiqueta}`).toBe(true);
    }
    expect(r.horarios_por_producto).toBeNull();
  });

  it("las sucursales que comparten página (Prolongación Montejo, Victory Platz y Altabrisa) llevan exactamente los mismos productos", () => {
    expect(ramas["garcia-lavin"].productos).toEqual(ramas["prol-montejo"].productos);
    expect(ramas.altabrisa.productos).toEqual(ramas["prol-montejo"].productos);
  });

  it("promos: el 2x1 de los lunes y los nachos del martes ($328 en lista T1-2026, $278 en Pensiones); solo para las 3 sucursales del pie de la imagen", () => {
    expect(ramas["fco-montejo"].promociones.find((p) => p.dia === "martes")?.precio_mxn).toBe(328);
    expect(ramas.galerias.promociones.find((p) => p.dia === "martes")?.precio_mxn).toBe(328);
    expect(ramas.pensiones.promociones.find((p) => p.dia === "martes")?.precio_mxn).toBe(278);
    expect(ramas["prol-montejo"].promociones).toEqual([]);
  });
});

describe("web contra seed: los precios de la lista T1-2026 coinciden con el seed (T1, T5, T7, T8)", () => {
  for (const slug of ["prol-montejo", "garcia-lavin", "altabrisa", "playa", "fco-montejo"] as const) {
    it(`${slug}: cada precio publicado es el del seed`, () => {
      const r = ramas[slug];
      const porNombre = new Map(data.productos.map((p) => [p.nombre, p]));
      let comparados = 0;
      for (const prod of r.productos) {
        for (const pr of prod.presentaciones) {
          const sn = pr.seed_nombre ?? prod.seed_nombre ?? prod.nombre;
          const sp = [...porNombre.values()].find((x) => x.nombre.normalize("NFD").replace(/\p{Mn}/gu, "").replace(/[^a-z0-9/ ]/gi, "").toLowerCase() === sn.normalize("NFD").replace(/\p{Mn}/gu, "").replace(/[^a-z0-9/ ]/gi, "").toLowerCase());
          expect(sp, `${sn} no está en el seed`).toBeDefined();
          expect(sp!.precios_por_sucursal?.[r.sucursal.id_seed], `${sn} en ${r.sucursal.id_seed}`).toBe(pr.precio_mxn);
          comparados += 1;
        }
      }
      expect(comparados).toBeGreaterThan(60);
    });
  }

  it("DIFERENCIA REAL: Pensiones sigue publicando la lista 2025 (más barata); el seed usa T1-2026 en T3. Decide el dueño (no se cambia el seed)", () => {
    const frijol = ramas.pensiones.productos.find((p) => p.nombre === "Frijol con tostada")!;
    expect(frijol.presentaciones[0]!.precio_mxn).toBe(83);
    expect(data.productos.find((p) => p.nombre === "Frijol con Tostada")!.precios_por_sucursal?.T3).toBe(93);
  });
});

describe("piezas por orden confirmadas por el menú público: el servidor las usa igual", () => {
  const CONFIRMADAS: ReadonlyArray<readonly [string, number]> = [
    ["Taco Al Pastor (individual)", 1],
    ["Tacos de Bistec de Res (orden de 3)", 3],
    ["Tacos de Chorizo (orden de 3)", 3],
    ["Gringa de Pastor", 2],
    ["Gringa de Arrachera", 2],
    ["Mestiza de Pastor", 2],
    ["Mestiza de Bistec", 2],
    ["Alambre de Pastor", 5],
    ["Alambre de Arrachera", 5],
  ];
  it.each(CONFIRMADAS)("%s: la web dice %i pieza(s) por orden y buscar_producto devuelve ese pack_size", async (nombre, piezas) => {
    const h = (await buscar(nombre)).find((p) => p.name === nombre);
    expect(h?.pack_size).toBe(piezas);
  });

  it("toda la web con piezas_por_orden coincide con el pack_size del servidor (gringas 2, mestizas 2, alambre 5, tacos 3, individuales 1)", async () => {
    let n = 0;
    for (const prod of ramas["garcia-lavin"].productos) {
      for (const pr of prod.presentaciones) {
        if (pr.piezas_por_orden === null) continue;
        const nombre = pr.seed_nombre!;
        const h = (await buscar(nombre)).find((p) => p.name === nombre);
        expect(h?.pack_size, nombre).toBe(pr.piezas_por_orden);
        n += 1;
      }
    }
    expect(n).toBe(3 + 8 + 7 + 7 + 6);
  });

  it("DIVERGENCIA CONOCIDA (no corregida a propósito): el menú del arnés (menu-pm.json) trae pack_size 1 en gringas, mestizas y alambre, el servidor 2, 2 y 5", () => {
    // Los casos L03, L17, L22, L25, C04, C08, C09, C11 y C13 de casos.json piden esos platillos contando ÓRDENES (piezas: 1) y sus totales salen de pack 1.
    // Poner 2/2/5 aquí rompe 9 casos (el mundo rechaza «1 alambre»: «puedes pedir 5»). Alinear el arnés exige reescribir esos casos: decisión pendiente.
    const porNombre = new Map(MENU_EVALS.productos.map((p) => [p.nombre, p.pack_size]));
    for (const prod of ramas["garcia-lavin"].productos) {
      for (const pr of prod.presentaciones) {
        if (!["Gringas", "Mestizas", "Alambre"].includes(prod.categoria)) continue;
        expect(porNombre.get(pr.seed_nombre!), pr.seed_nombre).toBe(1);
        expect(pr.piezas_por_orden, pr.seed_nombre).toBeGreaterThan(1);
      }
    }
  });

  it("NO confirmado por el sitio: flautas, alitas y crujientes quedan sin pack_size (no se inventa); las alitas del JSON no traen piezas", async () => {
    for (const q of ["Flauta de Pechuga", "Alitas de Pollo", "Crujientes de Pechuga de Pollo"]) {
      const h = (await buscar(q))[0]!;
      expect(h.pack_size, q).toBeNull();
    }
    const alitas = ramas["garcia-lavin"].productos.find((p) => p.nombre === "Alitas de pollo")!;
    expect(alitas.presentaciones[0]!.piezas_por_orden).toBeNull();
    expect(ramas["garcia-lavin"].productos.some((p) => /flauta|crujiente/i.test(p.nombre))).toBe(false);
  });
});

describe("T7-031 con el catálogo real del seed: «4 flautas, una orden» = 1 orden; total $1,833", () => {
  it("1 kg de bistec ($1,100) + 500 g de pastor ($450) + 1 orden de flautas de pechuga ($283) = $1,833, no $2,682", async () => {
    const bistec = await exacto("Bistec de Res — 1 kg");
    const pastor = await exacto("Pastor — 500 g");
    const flauta = await exacto("Flauta de Pechuga");
    expect([bistec.price, pastor.price, flauta.price]).toEqual([1100, 450, 283]);
    const q = buildOrderQuoteFromProducts(
      [{ productId: bistec.id, requestedQuantity: 1 }, { productId: pastor.id, requestedQuantity: 1 }, { productId: flauta.id, requestedQuantity: 1 }],
      [bistec, pastor, flauta],
    );
    expect(q.total).toBe(1833);
    // la trampa: leer «4 flautas» como 4 órdenes con pack_size desconocido
    const mal = buildOrderQuoteFromProducts([{ productId: flauta.id, requestedQuantity: 4 }], [flauta]);
    expect(mal.total).toBe(1132);
  });
});

describe("tacos por orden, kilos y tortilla con el catálogo real del seed", () => {
  it("6 tacos de bistec = 2 órdenes de 3 = $388, con tortilla; 4 tacos de bistec se rechazan (solo órdenes de 3)", async () => {
    const t = await exacto("Tacos de Bistec de Res (orden de 3)");
    const q = buildOrderQuoteFromProducts([{ productId: t.id, requestedQuantity: 6, tortilla: "maiz" }], [t]);
    expect(q.lines[0]!.quantity).toBe(2);
    expect(q.total).toBe(388);
    expect(q.lines[0]!.tortilla).toBe("maiz");
    expect(() => buildOrderQuoteFromProducts([{ productId: t.id, requestedQuantity: 4, tortilla: "maiz" }], [t])).toThrow(/orden de 3/);
  });

  it("tacos sin tortilla elegida: pide maíz, harina o mixta antes de cotizar", async () => {
    const t = await exacto("Tacos de Chorizo (orden de 3)");
    expect(() => buildOrderQuoteFromProducts([{ productId: t.id, requestedQuantity: 3 }], [t])).toThrow(/tortilla/i);
  });

  it("4 gringas = 2 órdenes de 2 = $388; 10 tacos de alambre de pastor = 2 órdenes de 5 = $552; 7 de alambre se rechazan", async () => {
    const g = await exacto("Gringa de Pastor");
    expect(buildOrderQuoteFromProducts([{ productId: g.id, requestedQuantity: 4, tortilla: "harina" }], [g]).total).toBe(388);
    const a = await exacto("Alambre de Pastor");
    expect(buildOrderQuoteFromProducts([{ productId: a.id, requestedQuantity: 10, tortilla: "maiz" }], [a]).total).toBe(552);
    expect(() => buildOrderQuoteFromProducts([{ productId: a.id, requestedQuantity: 7, tortilla: "maiz" }], [a])).toThrow(/órdenes de 5 piezas/);
  });

  it("un taco individual de pastor no tiene múltiplo: 5 tacos = 5 piezas = $210", async () => {
    const t = await exacto("Taco Al Pastor (individual)");
    expect(buildOrderQuoteFromProducts([{ productId: t.id, requestedQuantity: 5, tortilla: "harina" }], [t]).total).toBe(210);
  });

  it("kilos: el precio del kilo del sitio ($900 pastor, $1,100 bistec) es el del seed; medio kilo = $450 y 1 kg + 250 g = $1,125", async () => {
    const kilo = ramas["garcia-lavin"].productos.find((p) => p.nombre === "Pastor" && p.categoria === "Kilos a domicilio")!;
    expect(kilo.presentaciones[0]!.precio_mxn).toBe(900);
    const k1 = await exacto("Pastor — 1 kg");
    const k250 = await exacto("Pastor — 250 g");
    const q = buildOrderQuoteFromProducts([{ productId: k1.id, requestedQuantity: 1 }, { productId: k250.id, requestedQuantity: 1 }], [k1, k250]);
    expect(q.total).toBe(1125);
    expect((await exacto("Pastor — 500 g")).price).toBe(450);
  });
});
