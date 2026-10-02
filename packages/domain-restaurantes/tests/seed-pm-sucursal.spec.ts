// PM-C1 -- el seed de Los Taquitos de PM carga catalogo y precio POR SUCURSAL: cada precio sale de un menu impreso
// (scripts/seed-pm-demo/data/menus-impresos/) y una prueba lo ata; T2, T7 y T8 no se cargan sin el OK de Javier a P5; sin fracciones de kilo
// ni centavos. Postgres real: scripts/verify-restaurantes-seed-pm/ (A1-A9).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prepareCreateOrder } from "../src/orders.ts";
import { buildPmSeedPlan, PmSeedError, renderPmSeedPlpgsql, type PmSeedData } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";
import { dataConP5Aprobado } from "./support/pm-seed-p5.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { data, agent } = loadSeedInputs();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
type Mutable = { productos: Array<Record<string, unknown> & { nombre: string; precios_por_sucursal: Record<string, number>; fuente_precio: Record<string, string> }>; pendientes_dueno: Array<{ id: string; estado?: string }>; sucursales: Array<{ id: string; activa: boolean }> };
const mutable = (d: PmSeedData = data) => clone(d) as unknown as Mutable;
const producto = (d: Mutable, nombre: string) => d.productos.find((p) => p.nombre === nombre)!;

// ---- Menus impresos: la unica fuente de los precios -------------------------------------------------------
const MENUS_IMPRESOS: Readonly<Record<string, string>> = { T1: "T1-2026.json", T5: "T5-2026.json", T3: "T3-2025.json" };
interface MenuImpreso {
  categorias: Array<{ nombre: string; items: Array<{ nombre: string; precio_mxn: number }> }>;
}
/** Mismo criterio que usa el seed para ligar un producto con su item impreso: sin acentos, sin parentesis ni asteriscos. */
function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\*/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
const impresos = new Map<string, Map<string, number>>();
for (const [sucursal, archivo] of Object.entries(MENUS_IMPRESOS)) {
  const menu = JSON.parse(readFileSync(path.join(HERE, "../../../scripts/seed-pm-demo/data/menus-impresos", archivo), "utf8")) as MenuImpreso;
  const items = new Map<string, number>();
  for (const c of menu.categorias) for (const i of c.items) items.set(`${normalizar(c.nombre)}|${normalizar(i.nombre)}`, i.precio_mxn);
  impresos.set(sucursal, items);
}

describe("cada precio sale de un menu impreso y una prueba lo ata", () => {
  it("todo precio `impreso` del seed coincide EXACTAMENTE con el item impreso de su sucursal (T1-2026, T5-2026, T3-2025)", () => {
    const discrepancias: string[] = [];
    let comprobados = 0;
    for (const p of data.productos) {
      for (const [sucursal, precio] of Object.entries(p.precios_por_sucursal)) {
        if (p.fuente_precio[sucursal] !== "impreso") continue;
        const clave = `${normalizar(p.impreso!.categoria)}|${normalizar(p.impreso!.item)}`;
        const impreso = impresos.get(sucursal)?.get(clave);
        comprobados += 1;
        if (impreso !== precio) discrepancias.push(`${p.nombre} en ${sucursal}: seed ${precio}, impreso ${impreso ?? "no existe"}`);
      }
    }
    expect(discrepancias).toEqual([]);
    expect(comprobados).toBe(236 + 222 + 211);
  });

  it("al reves: todo item impreso esta en el seed con su precio (el seed no se deja nada ni agrega precios sin fuente)", () => {
    for (const [sucursal, items] of impresos) {
      const delSeed = new Map<string, number>();
      for (const p of data.productos) {
        const precio = p.precios_por_sucursal[sucursal];
        if (precio !== undefined) delSeed.set(`${normalizar(p.impreso!.categoria)}|${normalizar(p.impreso!.item)}`, precio);
      }
      expect([...delSeed].sort()).toEqual([...items].sort());
    }
  });

  it("ningun precio de T1, T3 ni T5 es provisional: solo T2, T7 y T8 pueden serlo y los datos reales no los traen", () => {
    for (const p of data.productos) {
      expect(Object.keys(p.precios_por_sucursal).every((id) => ["T1", "T3", "T5"].includes(id))).toBe(true);
      expect(Object.values(p.fuente_precio).every((f) => f === "impreso")).toBe(true);
    }
  });
});

describe("precio y catalogo por sucursal en el motor de pedidos", () => {
  const plan = buildPmSeedPlan(data, agent);
  const martes = new Date("2026-10-13T20:00:00Z"); // martes 14:00 en Merida: abierto y sin 2x1

  async function cotizar(slug: string, nombreProducto: string, cantidad = 1, datos: PmSeedData = data) {
    const world = await buildInMemoryPmWorld(buildPmSeedPlan(datos, agent));
    const orden = await prepareCreateOrder(
      world.repo,
      { organizationId: world.organizationId, branchSlug: slug, customerName: "Cliente Prueba", customerPhone: "0001000001", canal: "recoger", source: "web", items: [{ productId: world.productIds.get(nombreProducto)!, requestedQuantity: cantidad }] },
      { asOf: martes },
    );
    return orden.total;
  }

  it("T3 cotiza nachos de pastor a $278 y T1 a $328", async () => {
    expect(await cotizar("pensiones", "Nachos de Pastor")).toBe(278);
    expect(await cotizar("prol-montejo", "Nachos de Pastor")).toBe(328);
  });

  it("taco al pastor: $42 en T1, $36 en T3 y $42 en T5; el precio base del producto es el de T1", () => {
    const pastor = plan.products.find((p) => p.name === "Taco Al Pastor (individual)")!;
    expect(pastor.branchPrices).toEqual({ T1: 42, T5: 42, T3: 36 });
    expect(pastor.price).toBe(42);
  });

  it("una sucursal sin llave de precio no vende el producto: T3 no cotiza la Ensalada de PM aunque exista en el catalogo", async () => {
    await expect(cotizar("pensiones", "Ensalada de PM")).rejects.toThrow();
    expect(await cotizar("prol-montejo", "Ensalada de PM")).toBe(206);
  });

  it("sin el OK de P5, T2, T7 y T8 no tienen productos y T4 tampoco", async () => {
    const { repo, propertyBySlug } = await buildInMemoryPmWorld(plan);
    for (const slug of ["fco-montejo", "garcia-lavin", "altabrisa", "galerias"]) expect(await repo.listAvailableProductsForBranch(propertyBySlug.get(slug)!), slug).toEqual([]);
    expect(plan.branches.filter((b) => b.catalogSize === 0).map((b) => b.id)).toEqual(["T2", "T4", "T7", "T8"]);
  });

  it("con el OK de P5 (fixture): T2 no encuentra codzitos ni ensalada de PM; T7 si encuentra codzitos; T2 vende Heineken Silver a $90", async () => {
    const { repo, propertyBySlug } = await buildInMemoryPmWorld(buildPmSeedPlan(dataConP5Aprobado(data), agent));
    const nombres = async (slug: string) => (await repo.listAvailableProductsForBranch(propertyBySlug.get(slug)!)).map((p) => p.name);
    const t2 = await nombres("fco-montejo");
    const t7 = await nombres("garcia-lavin");
    expect(t2).not.toContain("Codzitos (orden de 4)");
    expect(t2).not.toContain("Ensalada de PM");
    expect(t2).not.toContain("Jericallas");
    expect(t2).not.toContain("Café");
    expect(t2).toContain("Heineken Silver");
    expect(t7).toContain("Codzitos (orden de 4)");
    expect(t7).toContain("Flauta de Pastor");
    expect(buildPmSeedPlan(dataConP5Aprobado(data), agent).products.find((p) => p.name === "Heineken Silver")!.branchPrices).toEqual({ T5: 90, T2: 90 });
  });

  it("T5 no encuentra Sprite ni comida regional ni flautas, y si vende Heineken Silver; T3 no la vende", async () => {
    const { repo, propertyBySlug } = await buildInMemoryPmWorld(plan);
    const t5 = (await repo.listAvailableProductsForBranch(propertyBySlug.get("playa")!)).map((p) => p.name);
    const t3 = (await repo.listAvailableProductsForBranch(propertyBySlug.get("pensiones")!)).map((p) => p.name);
    expect(t5).not.toContain("Sprite");
    expect(t5).not.toContain("Sprite Cero");
    expect(t5).not.toContain("Sopa de Lima");
    expect(t5).not.toContain("Flauta de Pastor");
    expect(t5).toContain("Heineken Silver");
    expect(t3).not.toContain("Heineken Silver");
    expect(t3).not.toContain("Quesobich de Queso");
    expect(t3).toContain("Vino Tinto Selección (copa)");
  });

  it("ningun producto tiene fraccion de kilo disponible en ninguna sucursal; solo existe el kilo completo", async () => {
    const world = await buildInMemoryPmWorld(plan);
    for (const [slug, propertyId] of world.propertyBySlug) {
      const nombres = (await world.repo.listAvailableProductsForBranch(propertyId)).map((p) => p.name);
      expect(nombres.filter((n) => / — (250|500|750) g$/.test(n)), slug).toEqual([]);
    }
    expect(plan.products.filter((p) => p.name.endsWith(" — 1 kg"))).toHaveLength(8);
    expect(plan.products.find((p) => p.name === "Pastor — 1 kg")!.branchPrices).toEqual({ T1: 900, T5: 900, T3: 750 });
  });
});

describe("validaciones del seed por sucursal", () => {
  const casos: Array<[string, (d: Mutable) => void, RegExp]> = [
    ["un producto con centavos", (d) => { producto(d, "Taco Al Pastor (individual)").precios_por_sucursal.T1 = 42.5; }, /centavos/],
    ["una fraccion de kilo", (d) => { const p = producto(d, "Pastor — 1 kg"); p.nombre = "Pastor — 500 g"; }, /fracciones de kilo/],
    ["un producto sin precio en ninguna sucursal", (d) => { const p = producto(d, "Flan"); p.precios_por_sucursal = {}; p.fuente_precio = {}; }, /ninguna sucursal/],
    ["un precio en una sucursal que no existe", (d) => { producto(d, "Flan").precios_por_sucursal.T9 = 83; }, /sucursal desconocida/],
    ["un precio sin fuente", (d) => { delete producto(d, "Flan").fuente_precio.T1; }, /falta fuente_precio/],
    ["un precio impreso sin el item del menu", (d) => { delete producto(d, "Flan").impreso; }, /necesita el item/],
    ["precios de T2 sin el OK de Javier a P5", (d) => { const p = producto(d, "Flan"); p.precios_por_sucursal.T2 = 83; p.fuente_precio.T2 = "provisional_P5"; }, /no se carga mientras Javier no conteste P5/],
    ["precios de T7 declarados `impreso` (no existe su menu)", (d) => { d.pendientes_dueno.find((x) => x.id === "P5")!.estado = "resuelta"; const p = producto(d, "Flan"); p.precios_por_sucursal.T7 = 83; p.fuente_precio.T7 = "impreso"; }, /no tiene menu impreso/],
    ["provisional_P5 en una sucursal con menu impreso", (d) => { producto(d, "Flan").fuente_precio.T1 = "provisional_P5"; }, /provisional_P5 solo aplica a T2, T7 y T8/],
    ["producto en Galerias (T4)", (d) => { const p = producto(d, "Flan"); p.precios_por_sucursal.T4 = 83; p.fuente_precio.T4 = "impreso"; }, /T4/],
    ["codzitos en T3", (d) => { const p = producto(d, "Codzitos (orden de 4)"); p.precios_por_sucursal.T3 = 131; p.fuente_precio.T3 = "impreso"; }, /T3 no lo vende/],
    ["flautas en T5", (d) => { const p = producto(d, "Flauta de Pastor"); p.precios_por_sucursal.T5 = 276; p.fuente_precio.T5 = "impreso"; }, /T5 no lo vende/],
    ["sprite en T5", (d) => { const p = producto(d, "Sprite"); p.precios_por_sucursal.T5 = 53; p.fuente_precio.T5 = "impreso"; }, /T5 no lo vende/],
    ["ensalada de PM en T3", (d) => { const p = producto(d, "Ensalada de PM"); p.precios_por_sucursal.T3 = 206; p.fuente_precio.T3 = "impreso"; }, /T3 no lo vende/],
    ["quesobich en T3", (d) => { const p = producto(d, "Quesobich de Queso"); p.precios_por_sucursal.T3 = 206; p.fuente_precio.T3 = "impreso"; }, /T3 no lo vende/],
  ];
  it.each(casos)("rechaza %s", (_nombre, mutar, mensaje) => {
    const copia = mutable();
    mutar(copia);
    expect(() => buildPmSeedPlan(copia as unknown as PmSeedData, agent)).toThrow(PmSeedError);
    expect(() => buildPmSeedPlan(copia as unknown as PmSeedData, agent)).toThrow(mensaje);
  });

  it("T2 con el OK de P5 NO puede vender ensalada, jericallas ni cafe (el menu web de T2 no los trae)", () => {
    for (const nombre of ["Ensalada de PM", "Jericallas", "Café", "Sopa de Lima"]) {
      const copia = mutable(dataConP5Aprobado(data));
      const p = producto(copia, nombre);
      p.precios_por_sucursal.T2 = 100;
      p.fuente_precio.T2 = "provisional_P5";
      expect(() => buildPmSeedPlan(copia as unknown as PmSeedData, agent), nombre).toThrow(/T2 no lo vende/);
    }
  });

  it("con el OK de P5 el plan carga 5 sucursales activas (T1, T2, T3, T7 y T8), todas con al menos 150 productos", () => {
    const plan = buildPmSeedPlan(dataConP5Aprobado(data), agent);
    expect(plan.branches.filter((b) => b.status === "active").map((b) => b.id)).toEqual(["T1", "T2", "T3", "T7", "T8"]);
    for (const b of plan.branches.filter((x) => x.status === "active")) expect(b.catalogSize, b.id).toBeGreaterThanOrEqual(150);
    expect(plan.branches.find((b) => b.id === "T5")!.status).toBe("inactive");
  });

  it("una sucursal activa necesita al menos 150 productos: activar T2 sin catalogo falla", () => {
    const copia = mutable();
    copia.sucursales.find((b) => b.id === "T2")!.activa = true;
    expect(() => buildPmSeedPlan(copia as unknown as PmSeedData, agent)).toThrow(/al menos 150 productos \(tiene 0\)/);
  });
});

describe("pendientes del dueño y SQL del catalogo por sucursal", () => {
  it("quedan las 25 preguntas P1-P25 con su estado: P5 sigue abierta (por eso T2, T7 y T8 no se cargan) y la identidad de T4 resuelta", () => {
    const plan = buildPmSeedPlan(data, agent);
    const ids = plan.pendientes.map((p) => p.id);
    for (let i = 1; i <= 25; i++) expect(ids).toContain(`P${i}`);
    expect(plan.pendientes.find((p) => p.id === "P5")).toMatchObject({ estado: "abierta" });
    expect(plan.pendientes.find((p) => p.id === "identidad_t4")).toMatchObject({ estado: "resuelta" });
    expect(plan.pendientes.find((p) => p.id === "combo_martes")!.detalle).toMatch(/P13/);
  });

  it("el SQL inserta branch_products solo por llave de precio, con is_available = true, y re-ejecutar solo repara el precio", () => {
    const sql = renderPmSeedPlpgsql(buildPmSeedPlan(data, agent));
    expect(sql).toMatch(/insert into restaurantes\.branch_products \(property_id, product_id, price, is_available\)/);
    expect(sql).toMatch(/jsonb_each_text\(x\."branchPrices"\)/);
    expect(sql).toMatch(/on conflict \(property_id, product_id\) do update set price = excluded\.price, updated_at = now\(\);/);
    expect(sql).not.toMatch(/is_available = excluded/);
  });

  it("T5 usa coordenadas aproximadas: se guardan en la sucursal pero no crean una zona conocida", () => {
    const plan = buildPmSeedPlan(data, agent);
    expect(plan.branches.find((b) => b.id === "T5")).toMatchObject({ lat: 21.296, lng: -89.602 });
    expect(plan.zones.some((z) => /Playa|Chicxulub/.test(z.name))).toBe(false);
  });
});
