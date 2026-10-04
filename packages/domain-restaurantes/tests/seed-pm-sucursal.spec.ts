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
import { cargarMenu } from "../src/evals/agente-pm/mundo.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";
import { dataConP5Aprobado } from "./support/pm-seed-p5.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { data, agent } = loadSeedInputs();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
type Mutable = { productos: Array<Record<string, unknown> & { nombre: string; precios_por_sucursal: Record<string, number>; fuente_precio: Record<string, string> }>; pendientes_dueno: Array<{ id: string; estado?: string }>; sucursales: Array<{ id: string; activa: boolean }> };
const mutable = (d: PmSeedData = data) => clone(d) as unknown as Mutable;
const producto = (d: Mutable, nombre: string) => d.productos.find((p) => p.nombre === nombre)!;

// ---- Menus impresos: la unica fuente de los precios -------------------------------------------------------
// T3-2025 es la lista VIEJA (solo referencia de nombres): T3 vende con la lista T1-2026 (cuestionario: "precios iguales en todas").
const MENUS_IMPRESOS: Readonly<Record<string, string>> = { T1: "T1-2026.json", T5: "T5-2026.json" };
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
  it("todo precio `impreso` del seed coincide EXACTAMENTE con el item impreso de su sucursal (T1-2026, T5-2026)", () => {
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
    expect(comprobados).toBe(236 + 222);
  });

  it("al reves: todo item impreso esta en el seed con su precio (el seed no se deja nada ni agrega precios sin fuente)", () => {
    for (const [sucursal, items] of impresos) {
      const delSeed = new Map<string, number>();
      for (const p of data.productos) {
        const precio = p.precios_por_sucursal[sucursal];
        // Las fracciones de kilo y los extras no son items impresos: su precio sale de otra regla (ver pruebas de abajo).
        if (precio !== undefined && p.fuente_precio[sucursal] === "impreso") delSeed.set(`${normalizar(p.impreso!.categoria)}|${normalizar(p.impreso!.item)}`, precio);
      }
      expect([...delSeed].sort()).toEqual([...items].sort());
    }
  });

  it("ningun precio de T1, T3 ni T5 es provisional; T3 = lista T1-2026 (mismo precio que T1), T7 tambien, y T2 y T8 son provisionales hasta confirmar su catalogo", () => {
    for (const p of data.productos) {
      for (const [id, fuente] of Object.entries(p.fuente_precio)) {
        if (["T1", "T5"].includes(id)) expect(["impreso", "proporcional_kilo", "decision_2oct"], `${p.nombre} ${id}`).toContain(fuente);
        if (id === "T3") {
          expect(["lista_t1_2026_cuestionario", "proporcional_kilo", "decision_2oct"], `${p.nombre} T3`).toContain(fuente);
          expect(p.precios_por_sucursal.T3, `${p.nombre} T3`).toBe(p.precios_por_sucursal.T1);
        }
        if (id === "T7" && !p.fraccion_kg && fuente !== "decision_2oct") expect(fuente, `${p.nombre} T7`).toBe("lista_t1_2026");
        if (id === "T7") expect(p.precios_por_sucursal.T7, `${p.nombre} T7`).toBe(p.precios_por_sucursal.T1);
        if ((id === "T2" || id === "T8") && !p.fraccion_kg && fuente !== "decision_2oct") expect(fuente, `${p.nombre} ${id}`).toBe("provisional_P5");
      }
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

  it("T3 cotiza nachos de pastor a $328, igual que T1 (lista T1-2026 en todas las sucursales)", async () => {
    expect(await cotizar("pensiones", "Nachos de Pastor")).toBe(328);
    expect(await cotizar("prol-montejo", "Nachos de Pastor")).toBe(328);
  });

  it("taco al pastor: $42 en TODAS las sucursales (T3 ya no lleva el $36 de la lista 2025); el precio base del producto es el de T1", () => {
    const pastor = plan.products.find((p) => p.name === "Taco Al Pastor (individual)")!;
    expect(pastor.branchPrices).toEqual({ T1: 42, T5: 42, T3: 42, T7: 42, T8: 42, T2: 42 });
    expect(pastor.price).toBe(42);
  });

  it("una sucursal sin llave de precio no vende el producto: T3 no cotiza las flautas (solo T1, T7 y T8, pregunta P10) pero si la Ensalada de PM a $206", async () => {
    await expect(cotizar("pensiones", "Flauta de Pastor")).rejects.toThrow();
    expect(await cotizar("pensiones", "Ensalada de PM")).toBe(206);
    expect(await cotizar("prol-montejo", "Ensalada de PM")).toBe(206);
  });

  it("T4 (Galerias) no tiene productos; T7 es la unica sucursal nueva ACTIVA y T2 y T8 tienen catalogo provisional pero inactivo", async () => {
    const { repo, propertyBySlug } = await buildInMemoryPmWorld(plan);
    expect(await repo.listAvailableProductsForBranch(propertyBySlug.get("galerias")!)).toEqual([]);
    expect(plan.branches.filter((b) => b.catalogSize === 0).map((b) => b.id)).toEqual(["T4"]);
    expect(plan.branches.filter((b) => b.status === "active").map((b) => b.id)).toEqual(["T1", "T3", "T7"]);
  });

  it("T2 no encuentra codzitos ni flautas pero si Ensalada de PM, Jericallas y Cafe; T7 si encuentra codzitos y flautas; Heineken Silver solo existe en T5", async () => {
    const { repo, propertyBySlug } = await buildInMemoryPmWorld(plan);
    const nombres = async (slug: string) => (await repo.listAvailableProductsForBranch(propertyBySlug.get(slug)!)).map((p) => p.name);
    const t2 = await nombres("fco-montejo");
    const t7 = await nombres("garcia-lavin");
    expect(t2).not.toContain("Codzitos (orden de 4)");
    expect(t2).not.toContain("Flauta de Pastor");
    expect(t2).toContain("Ensalada de PM");
    expect(t2).toContain("Jericallas");
    expect(t2).toContain("Café");
    expect(t2).not.toContain("Heineken Silver");
    expect(t7).toContain("Codzitos (orden de 4)");
    expect(t7).toContain("Flauta de Pastor");
    expect(plan.products.find((p) => p.name === "Heineken Silver")!.branchPrices).toEqual({ T5: 90 });
  });

  it("T5 no encuentra Sprite ni comida regional ni flautas, y si vende Heineken Silver; T3 vende la pizza Quesobich pero no Silver ni flautas", async () => {
    const { repo, propertyBySlug } = await buildInMemoryPmWorld(plan);
    const t5 = (await repo.listAvailableProductsForBranch(propertyBySlug.get("playa")!)).map((p) => p.name);
    const t3 = (await repo.listAvailableProductsForBranch(propertyBySlug.get("pensiones")!)).map((p) => p.name);
    expect(t5).not.toContain("Sprite");
    expect(t5).not.toContain("Sprite Cero");
    expect(t5).not.toContain("Sopa de Lima");
    expect(t5).not.toContain("Flauta de Pastor");
    expect(t5).toContain("Heineken Silver");
    expect(t3).not.toContain("Heineken Silver");
    expect(t3).toContain("Quesobich de Queso");
    expect(t3).toContain("Heineken 0.0");
    expect(t3).not.toContain("Flauta de Pastor");
    expect(t3).not.toContain("Sopa de Lima");
    expect(t3).toContain("Vino Tinto Selección (copa)");
  });

  it("fracciones de kilo (decision de Javier, 2-oct): 1/4, 1/2, 3/4, 1.5 y 2 kg a precio proporcional del kilo, redondeo a $0.50, en toda sucursal que vende el kilo", async () => {
    const world = await buildInMemoryPmWorld(plan);
    expect(plan.products.filter((p) => p.name.endsWith(" — 1 kg"))).toHaveLength(8);
    expect(plan.products.filter((p) => / — (250 g|500 g|750 g|1\.5 kg|2 kg)$/.test(p.name))).toHaveLength(40);
    expect(plan.products.find((p) => p.name === "Pastor — 1 kg")!.branchPrices).toEqual({ T1: 900, T5: 900, T3: 900, T7: 900, T8: 900, T2: 900 });
    // Casos del anexo del analisis: 3/4 de bistec de res = $825 en 2026 y $712.50 en 2025; 1/4 = $275; 1/2 kg de pastor = $450; 1.5 kg de pastor = $1,350.
    expect(plan.products.find((p) => p.name === "Bistec de Res — 750 g")!.branchPrices).toMatchObject({ T1: 1100 * 0.75, T3: 825, T7: 825 });
    expect(plan.products.find((p) => p.name === "Bistec de Res — 250 g")!.branchPrices).toMatchObject({ T1: 275, T3: 275 });
    expect(plan.products.find((p) => p.name === "Pastor — 500 g")!.branchPrices).toMatchObject({ T1: 450, T3: 450 });
    expect(plan.products.find((p) => p.name === "Pastor — 1.5 kg")!.branchPrices).toMatchObject({ T1: 1350, T7: 1350 });
    for (const [slug, propertyId] of world.propertyBySlug) {
      const nombres = (await world.repo.listAvailableProductsForBranch(propertyId)).map((p) => p.name);
      const conKilo = nombres.filter((n) => / — 1 kg$/.test(n));
      const fracciones = nombres.filter((n) => / — (250 g|500 g|750 g|1\.5 kg|2 kg)$/.test(n));
      expect(fracciones.length, slug).toBe(conKilo.length * 5);
    }
  });

  it("T7 cotiza 1/4 kg de bistec a $275, ni un peso mas: el motor cobra el precio proporcional del catalogo", async () => {
    expect(await cotizar("garcia-lavin", "Bistec de Res — 250 g")).toBe(275);
    expect(await cotizar("garcia-lavin", "Bistec de Res — 750 g")).toBe(825);
    expect(await cotizar("pensiones", "Bistec de Res — 750 g")).toBe(825);
  });

  it("Extra Salsa y Extra Piña a $19 en las 6 sucursales con catalogo (T1, T2, T3, T5, T7 y T8)", async () => {
    const world = await buildInMemoryPmWorld(plan);
    for (const slug of ["garcia-lavin", "prol-montejo", "fco-montejo", "altabrisa", "pensiones", "playa"]) {
      const productos = await world.repo.listAvailableProductsForBranch(world.propertyBySlug.get(slug)!);
      expect(productos.find((p) => p.name === "Extra Salsa")?.price, slug).toBe(19);
      expect(productos.find((p) => p.name === "Extra Piña")?.price, slug).toBe(19);
    }
  });
});

describe("validaciones del seed por sucursal", () => {
  const casos: Array<[string, (d: Mutable) => void, RegExp]> = [
    ["un producto con centavos", (d) => { producto(d, "Taco Al Pastor (individual)").precios_por_sucursal.T1 = 42.5; }, /centavos/],
    ["una fraccion de kilo sin fraccion_kg", (d) => { const p = producto(d, "Pastor — 1 kg"); p.nombre = "Pastor — 500 g"; }, /fraccion de kilo .* debe declarar `fraccion_kg`/],
    ["una fraccion de kilo con precio que no es el proporcional", (d) => { producto(d, "Pastor — 500 g").precios_por_sucursal.T1 = 449; }, /vale 449 pero 500 g de un kilo de 900 es 450/],
    ["una fraccion de kilo con fuente impresa", (d) => { producto(d, "Pastor — 500 g").fuente_precio.T1 = "impreso"; }, /solo admite fuente proporcional_kilo/],
    ["lista_t1_2026 con un precio distinto al de T1", (d) => { producto(d, "Flan").precios_por_sucursal.T7 = 80; }, /MISMO precio que T1/],
    ["decision_2oct en un producto que no es el extra", (d) => { producto(d, "Flan").fuente_precio.T7 = "decision_2oct"; }, /decision_2oct solo vale para Extra Salsa y Extra Piña/],
    ["un producto sin precio en ninguna sucursal", (d) => { const p = producto(d, "Flan"); p.precios_por_sucursal = {}; p.fuente_precio = {}; }, /ninguna sucursal/],
    ["un precio en una sucursal que no existe", (d) => { producto(d, "Flan").precios_por_sucursal.T9 = 83; }, /sucursal desconocida/],
    ["un precio sin fuente", (d) => { delete producto(d, "Flan").fuente_precio.T1; }, /falta fuente_precio/],
    ["un precio impreso sin el item del menu", (d) => { delete producto(d, "Flan").impreso; }, /necesita el item/],
    ["precios de T2 sin el OK de Javier a P5", (d) => { d.pendientes_dueno.find((x) => x.id === "P5")!.estado = "abierta"; }, /no se carga mientras Javier no conteste P5/],
    ["precios de T7 declarados `impreso` (no existe su menu: usa lista_t1_2026)", (d) => { producto(d, "Flan").fuente_precio.T7 = "impreso"; }, /no tiene menu impreso/],
    ["provisional_P5 en una sucursal con menu impreso", (d) => { producto(d, "Flan").fuente_precio.T1 = "provisional_P5"; }, /provisional_P5 solo aplica a T2, T7 y T8/],
    ["lista_t1_2026 fuera de T7", (d) => { producto(d, "Flan").fuente_precio.T1 = "lista_t1_2026"; }, /lista_t1_2026 solo aplica a T7/],
    ["producto en Galerias (T4)", (d) => { const p = producto(d, "Flan"); p.precios_por_sucursal.T4 = 83; p.fuente_precio.T4 = "impreso"; }, /T4/],
    ["codzitos en T3", (d) => { const p = producto(d, "Codzitos (orden de 4)"); p.precios_por_sucursal.T3 = p.precios_por_sucursal.T1!; p.fuente_precio.T3 = "lista_t1_2026_cuestionario"; }, /T3 no lo vende/],
    ["flautas en T3 (pregunta P10 abierta)", (d) => { const p = producto(d, "Flauta de Pastor"); p.precios_por_sucursal.T3 = p.precios_por_sucursal.T1!; p.fuente_precio.T3 = "lista_t1_2026_cuestionario"; }, /T3 no lo vende/],
    ["flautas en T2 (pregunta P10 abierta)", (d) => { const p = producto(d, "Flauta de Pastor"); p.precios_por_sucursal.T2 = p.precios_por_sucursal.T1!; p.fuente_precio.T2 = "provisional_P5"; }, /T2 no lo vende/],
    ["Heineken Silver en T2 (solo existe impresa en T5)", (d) => { const p = producto(d, "Heineken Silver"); p.precios_por_sucursal.T2 = 90; p.fuente_precio.T2 = "provisional_P5"; }, /T2 no lo vende/],
    ["Heineken Silver en T3", (d) => { const p = producto(d, "Heineken Silver"); p.precios_por_sucursal.T3 = 90; p.fuente_precio.T3 = "decision_2oct"; }, /decision_2oct solo vale|T3 no lo vende/],
    ["T3 con un precio de la lista 2025 impresa", (d) => { const p = producto(d, "Taco Al Pastor (individual)"); p.precios_por_sucursal.T3 = 36; p.fuente_precio.T3 = "impreso"; }, /T3 usa la lista T1-2026/],
    ["lista_t1_2026_cuestionario con un precio distinto al de T1", (d) => { producto(d, "Taco Al Pastor (individual)").precios_por_sucursal.T3 = 36; }, /MISMO precio que T1/],
    ["lista_t1_2026_cuestionario fuera de T3", (d) => { producto(d, "Taco Al Pastor (individual)").fuente_precio.T5 = "lista_t1_2026_cuestionario"; }, /solo aplica a T3/],
    ["flautas en T5", (d) => { const p = producto(d, "Flauta de Pastor"); p.precios_por_sucursal.T5 = 276; p.fuente_precio.T5 = "impreso"; }, /T5 no lo vende/],
    ["sprite en T5", (d) => { const p = producto(d, "Sprite"); p.precios_por_sucursal.T5 = 53; p.fuente_precio.T5 = "impreso"; }, /T5 no lo vende/],
  ];
  it.each(casos)("rechaza %s", (_nombre, mutar, mensaje) => {
    const copia = mutable();
    mutar(copia);
    expect(() => buildPmSeedPlan(copia as unknown as PmSeedData, agent)).toThrow(PmSeedError);
    expect(() => buildPmSeedPlan(copia as unknown as PmSeedData, agent)).toThrow(mensaje);
  });

  it("T2 con el OK de P5 NO puede vender comida regional, flautas ni Heineken Silver (cuestionario l.76; P10)", () => {
    for (const nombre of ["Sopa de Lima", "Flauta de Pastor", "Heineken Silver"]) {
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

  it("una sucursal activa necesita al menos 150 productos: activar T2 con el catalogo recortado falla", () => {
    const copia = mutable();
    copia.sucursales.find((b) => b.id === "T2")!.activa = true;
    for (const p of copia.productos.slice(0, 150)) { delete p.precios_por_sucursal.T2; delete p.fuente_precio.T2; }
    expect(() => buildPmSeedPlan(copia as unknown as PmSeedData, agent)).toThrow(/al menos 150 productos \(tiene 1[0-9]{2}\)/);
  });
});

describe("pendientes del dueño y SQL del catalogo por sucursal", () => {
  it("quedan las 25 preguntas P1-P25 con su estado: P5, P11 y P19 resueltas por Javier el 2-oct (T2, T7 y T8 se cargan) y la identidad de T4 resuelta", () => {
    const plan = buildPmSeedPlan(data, agent);
    const ids = plan.pendientes.map((p) => p.id);
    for (let i = 1; i <= 25; i++) expect(ids).toContain(`P${i}`);
    expect(plan.pendientes.find((p) => p.id === "P5")).toMatchObject({ estado: "resuelta" });
    expect(plan.pendientes.find((p) => p.id === "P11")).toMatchObject({ estado: "resuelta" });
    expect(plan.pendientes.find((p) => p.id === "P19")).toMatchObject({ estado: "resuelta" });
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

describe("menu-pm.json del arnes de evaluacion (regenerado desde el seed)", () => {
  it("tiene exactamente los productos del seed, con su precio de referencia y marca de alcohol; regional = comida regional y flautas (lo que T2 y T3 no venden)", () => {
    const menu = cargarMenu();
    const plan = buildPmSeedPlan(data, agent);
    expect(menu.map((p) => p.nombre)).toEqual(plan.products.map((p) => p.name));
    const categoriaPorSlug = new Map(data.productos.map((p) => [p.nombre, p.categoria]));
    for (const p of menu) {
      const delSeed = plan.products.find((x) => x.name === p.nombre)!;
      expect(p.precio_mxn, p.nombre).toBe(delSeed.price);
      expect(p.es_alcohol, p.nombre).toBe(delSeed.noDomicilio);
      const regional = ["Comida Regional", "Flautas de PM"].includes(categoriaPorSlug.get(p.nombre)!);
      expect(p.regional, p.nombre).toBe(regional);
    }
    expect(menu.filter((p) => / — (250 g|500 g|750 g|1\.5 kg|2 kg)$/.test(p.nombre))).toHaveLength(40);
  });
});
