// pm-cuenta-real-correcciones -- la cuenta REAL de Los Taquitos de PM tiene que quedar identica a los menus y a las respuestas del dueño.
// Estas pruebas leen el dato versionado (scripts/seed-pm-demo/data/pm-seed-data.json) y los menus impresos copiados
// (scripts/seed-pm-demo/data/menus-impresos/) y afirman, sin fiarse de las pruebas anteriores:
//   * T1, T2, T3, T7 y T8 cobran EXACTAMENTE la lista T1-2026 en cada producto impreso que venden (cuestionario: "precios iguales en todas");
//   * T2 y T3 no venden comida regional (T1, T7 y T8 si); las fracciones de kilo de TODAS son proporcionales al kilo de T1-2026, redondeo a $0.50;
//   * Extra Salsa y Extra Piña a $19 en las 6 sucursales con catalogo;
//   * el 2x1 del lunes no tiene restriccion de sucursal y el combo del martes (nachos de pastor + 2 aguas) existe solo para recoger y lo aplica
//     el motor real de cotizacion (a domicilio, media orden o en otro dia no);
//   * re-aplicar el seed reconcilia (SQL); el comportamiento contra Postgres real esta en scripts/verify-restaurantes-seed-pm/ (C6, C7).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quoteOrder } from "../src/orders.ts";
import { buildPmSeedPlan, precioFraccionDeKilo, PmSeedError, renderPmSeedPlpgsql, renderSchemaPreflightSql, type PmSeedData } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MENUS = path.join(HERE, "../../../scripts/seed-pm-demo/data/menus-impresos");
const { data, agent } = loadSeedInputs();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

interface MenuImpreso {
  readonly vigencia: string;
  readonly categorias: ReadonlyArray<{ readonly nombre: string; readonly items: ReadonlyArray<{ readonly nombre: string; readonly precio_mxn: number }> }>;
}
const t1 = JSON.parse(readFileSync(path.join(MENUS, "T1-2026.json"), "utf8")) as MenuImpreso;
/** (categoria impresa, item impreso) -> precio de la lista T1-2026. */
const precioT1 = new Map<string, number>();
for (const c of t1.categorias) for (const i of c.items) precioT1.set(`${c.nombre}|${i.nombre}`, i.precio_mxn);
const llave = (p: { impreso?: { categoria: string; item: string } }) => `${p.impreso!.categoria}|${p.impreso!.item}`;

const SUCURSALES_LISTA_T1 = ["T1", "T2", "T3", "T7", "T8"] as const;

describe("lista T1-2026 en todas las sucursales (CR01)", () => {
  it("el menu copiado es la lista vigente 2026", () => {
    expect(t1.vigencia).toBe("2026");
    expect(precioT1.size).toBeGreaterThan(200);
  });

  it.each(SUCURSALES_LISTA_T1)("%s cobra EXACTAMENTE el precio de T1-2026 en cada producto impreso que vende", (id) => {
    const discrepancias: string[] = [];
    let vendidos = 0;
    for (const p of data.productos) {
      const precio = p.precios_por_sucursal[id];
      if (precio === undefined || !p.impreso) continue;
      vendidos += 1;
      const impreso = precioT1.get(llave(p));
      if (impreso !== precio) discrepancias.push(`${p.nombre}: ${id} ${precio}, T1-2026 ${impreso ?? "no existe"}`);
    }
    expect(discrepancias).toEqual([]);
    expect(vendidos).toBeGreaterThan(190);
  });

  it("T3 ya no cotiza la lista 2025: el taco al pastor vale $42 y los nachos de pastor $328 en T3 igual que en T1", () => {
    const precios = (nombre: string) => data.productos.find((p) => p.nombre === nombre)!.precios_por_sucursal;
    expect(precios("Taco Al Pastor (individual)").T3).toBe(42);
    expect(precios("Nachos de Pastor").T3).toBe(328);
    for (const p of data.productos) if (p.precios_por_sucursal.T3 !== undefined) expect(p.precios_por_sucursal.T3, p.nombre).toBe(p.precios_por_sucursal.T1);
  });

  it("T3 vende lo mismo que T1 salvo la comida regional y las flautas (pregunta P10 abierta); T2 igual y sin Heineken Silver", () => {
    const sinRegional = (id: string) =>
      data.productos
        .filter((p) => p.precios_por_sucursal.T1 !== undefined && !["Comida Regional", "Flautas de PM"].includes(p.categoria))
        .filter((p) => p.precios_por_sucursal[id] === undefined)
        .map((p) => p.nombre);
    expect(sinRegional("T3")).toEqual([]);
    expect(sinRegional("T2")).toEqual([]);
    expect(data.productos.find((p) => p.nombre === "Heineken Silver")!.precios_por_sucursal).toEqual({ T5: 90 });
  });
});

describe("comida regional (cuestionario l.76)", () => {
  const tiene = (id: string, categoria: string) => data.productos.some((p) => p.categoria === categoria && p.precios_por_sucursal[id] !== undefined);

  it("T2 y T3 no tienen ningun producto de Comida Regional; T1, T7 y T8 si", () => {
    for (const id of ["T2", "T3"]) expect(tiene(id, "Comida Regional"), id).toBe(false);
    for (const id of ["T1", "T7", "T8"]) expect(tiene(id, "Comida Regional"), id).toBe(true);
  });
});

describe("fracciones de kilo proporcionales al kilo de T1-2026 en TODAS las sucursales (decision de Javier, 2-oct)", () => {
  it("1/4, 1/2, 3/4, 1.5 y 2 kg = precio del kilo impreso en T1-2026 x fraccion, redondeo a $0.50, en cada sucursal que vende el kilo", () => {
    const fracciones = data.productos.filter((p) => p.fraccion_kg);
    expect(fracciones).toHaveLength(40);
    for (const f of fracciones) {
      const base = data.productos.find((p) => p.nombre === f.fraccion_kg!.base)!;
      const kiloImpreso = precioT1.get(llave(base));
      expect(kiloImpreso, base.nombre).toBeDefined();
      for (const [id, precio] of Object.entries(f.precios_por_sucursal)) {
        expect(precio, `${f.nombre} ${id}`).toBe(precioFraccionDeKilo(kiloImpreso!, f.fraccion_kg!.gramos));
        expect((precio * 2) % 1, `${f.nombre} ${id} a .50`).toBe(0);
        expect(base.precios_por_sucursal[id], `${f.nombre} ${id}: el kilo`).toBeDefined();
      }
    }
  });

  it("250 g de pastor cuestan $225 en T3 (con la lista 2025 eran $187.50)", () => {
    expect(data.productos.find((p) => p.nombre === "Pastor — 250 g")!.precios_por_sucursal.T3).toBe(225);
  });
});

describe("Extra Salsa y Extra Piña (decision del 2-oct)", () => {
  it("existen a $19 en las 6 sucursales con catalogo (T1, T2, T3, T5, T7 y T8)", () => {
    for (const nombre of ["Extra Salsa", "Extra Piña"]) {
      const p = data.productos.find((x) => x.nombre === nombre)!;
      expect(p.precios_por_sucursal, nombre).toEqual({ T1: 19, T2: 19, T3: 19, T5: 19, T7: 19, T8: 19 });
      expect(Object.values(p.fuente_precio).every((f) => f === "decision_2oct"), nombre).toBe(true);
    }
  });
});

describe("promociones: lunes 2x1 sin restriccion de sucursal y combo del martes (CR07, CR08, CR09)", () => {
  const plan = buildPmSeedPlan(data, agent);

  it("LUNES2X1PM no tiene restriccion de sucursal ni en los datos ni en el plan", () => {
    const lunes = data.promociones.find((p) => p.codigo === "LUNES2X1PM")!;
    expect(lunes.sucursales).toBeUndefined();
    expect(plan.promotions.find((p) => p.code === "LUNES2X1PM")!.branchIds).toBeNull();
    expect(lunes.canales).toEqual(["recoger"]);
  });

  it("existe la cortesia del martes: solo recoger, nachos de pastor (orden completa), 2 aguas a elegir entre Jamaica, Horchata y Te, auto_apply, todas las sucursales", () => {
    const martes = plan.promotions.find((p) => p.code === "MARTESNACHOSPM")!;
    expect(martes).toMatchObject({ type: "cortesia", daysOfWeek: [2], channels: ["recoger"], autoApply: true, branchIds: null, courtesyQuantity: 2 });
    expect(martes.productNames).toEqual(["Nachos de Pastor"]);
    expect(martes.courtesyProductNames).toEqual(["Agua de Jamaica", "Horchata", "Té"]);
    expect(plan.promotions.every((p) => !p.channels.includes("domicilio"))).toBe(true);
  });

  it("el SQL persiste las columnas del combo y el preflight exige la migracion 031 (columnas de cortesia) y la 039 (espera de rafagas)", () => {
    const sql = renderPmSeedPlpgsql(plan);
    expect(sql).toMatch(/courtesy_product_ids, courtesy_quantity\)/);
    const preflight = renderSchemaPreflightSql();
    expect(preflight).toContain("restaurantes.promotions.courtesy_product_ids");
    expect(preflight).toContain("restaurantes.promotions.courtesy_quantity");
    expect(preflight).toContain("restaurantes.whatsapp_agent_config.reply_debounce_seconds");
    expect(preflight).toContain("039_agente_config_umbral_y_rafagas.sql");
  });

  it("una cortesia mal formada invalida el seed", () => {
    const sinAguas = clone(data);
    delete (sinAguas.promociones.find((p) => p.codigo === "MARTESNACHOSPM") as { cortesia_productos?: unknown }).cortesia_productos;
    expect(() => buildPmSeedPlan(sinAguas, agent)).toThrow(PmSeedError);
    expect(() => buildPmSeedPlan(sinAguas, agent)).toThrow(/productos de cortesia/);
    const cantidad = clone(data);
    (cantidad.promociones.find((p) => p.codigo === "MARTESNACHOSPM") as { cortesia_cantidad?: number }).cortesia_cantidad = 11;
    expect(() => buildPmSeedPlan(cantidad, agent)).toThrow(/cortesia_cantidad/);
    const aguaFantasma = clone(data);
    (aguaFantasma.promociones.find((p) => p.codigo === "MARTESNACHOSPM") as { cortesia_productos?: string[] }).cortesia_productos = ["Agua Fantasma"];
    expect(() => buildPmSeedPlan(aguaFantasma, agent)).toThrow(/no existe en el menu/);
    const lunesConCortesia = clone(data);
    (lunesConCortesia.promociones.find((p) => p.codigo === "LUNES2X1PM") as { cortesia_cantidad?: number }).cortesia_cantidad = 2;
    expect(() => buildPmSeedPlan(lunesConCortesia, agent)).toThrow(/solo aplican al tipo cortesia/);
  });

  describe("motor real de cotizacion con el mundo sembrado", () => {
    afterEach(() => vi.useRealTimers());
    const LUNES_14H = new Date("2026-10-12T20:00:00Z"); // lunes 14:00 en Merida
    const MARTES_14H = new Date("2026-10-13T20:00:00Z");
    const MIERCOLES_14H = new Date("2026-10-14T20:00:00Z");

    async function cotizar(ahora: Date, canal: "recoger" | "domicilio", lineas: ReadonlyArray<readonly [string, number] | readonly [string, number, "maiz"]>, slug = "garcia-lavin") {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(ahora);
      const world = await buildInMemoryPmWorld(plan);
      return quoteOrder(world.repo, {
        organizationId: world.organizationId,
        branchSlug: slug,
        canal,
        ...(canal === "domicilio" ? { customerAddress: "Calle 7 #270, Vista Alegre", colonia: "Temozón Norte" } : {}),
        items: lineas.map(([nombre, cantidad, tortilla]) => ({ productId: world.productIds.get(nombre)!, requestedQuantity: cantidad, ...(tortilla ? { tortilla } : {}) })),
      });
    }

    it("martes + recoger + nachos de pastor + 2 aguas elegidas: las 2 aguas salen a $0 (total = solo los nachos)", async () => {
      const q = await cotizar(MARTES_14H, "recoger", [["Nachos de Pastor", 1], ["Agua de Jamaica", 1], ["Horchata", 1]]);
      expect(q.subtotal).toBe(328 + 60 + 60);
      expect(q.descuento).toBe(120);
      expect(q.total).toBe(328);
      expect(q.promocionAplicada).toMatchObject({ code: "MARTESNACHOSPM", type: "cortesia" });
    });

    it("el combo vale en CUALQUIER sucursal (T1, T3 y T7), no solo en la de la fase 1", async () => {
      for (const slug of ["prol-montejo", "pensiones", "garcia-lavin"]) {
        const q = await cotizar(MARTES_14H, "recoger", [["Nachos de Pastor", 1], ["Agua de Jamaica", 1], ["Té", 1]], slug);
        expect(q.total, slug).toBe(328);
      }
    });

    it("martes + recoger + nachos sin aguas: no hay descuento y la cotizacion sugiere elegir las aguas del combo", async () => {
      const q = await cotizar(MARTES_14H, "recoger", [["Nachos de Pastor", 1]]);
      expect(q.total).toBe(328);
      expect(q.promocionAplicada).toBeNull();
      expect(q.promocionesSugeridas[0]).toMatchObject({ motivo: "falta_elegir_cortesia", cortesiaPorUnidad: 2 });
      expect(q.promocionesSugeridas[0]!.opcionesCortesia?.map((o) => o.name).sort()).toEqual(["Agua de Jamaica", "Horchata", "Té"]);
    });

    it("a DOMICILIO el mismo carrito cobra todo (las promociones de PM no aplican a domicilio)", async () => {
      const q = await cotizar(MARTES_14H, "domicilio", [["Nachos de Pastor", 1], ["Agua de Jamaica", 1], ["Horchata", 1]]);
      expect(q.descuento).toBe(0);
      expect(q.total).toBe(448);
      expect(q.promocionAplicada).toBeNull();
    });

    it("la MEDIA orden de nachos de pastor no dispara el combo", async () => {
      const q = await cotizar(MARTES_14H, "recoger", [["Nachos de Pastor (1/2 orden)", 1], ["Agua de Jamaica", 1], ["Horchata", 1]]);
      expect(q.descuento).toBe(0);
      expect(q.total).toBe(232 + 120);
    });

    it("lunes y miercoles el combo no aplica; el lunes si aplica el 2x1 al recoger", async () => {
      for (const dia of [LUNES_14H, MIERCOLES_14H]) {
        const q = await cotizar(dia, "recoger", [["Nachos de Pastor", 1], ["Agua de Jamaica", 1], ["Horchata", 1]]);
        expect(q.promocionAplicada, dia.toISOString()).toBeNull();
        expect(q.total, dia.toISOString()).toBe(448);
      }
      const q = await cotizar(LUNES_14H, "recoger", [["Taco Al Pastor (individual)", 4, "maiz"]], "pensiones");
      expect(q.promocionAplicada).toMatchObject({ code: "LUNES2X1PM" });
      expect(q.total).toBe(2 * 42);
    });
  });
});

describe("reconciliacion al re-aplicar el seed (CR: una fila sobrante no queda viva)", () => {
  it("el SQL borra de branch_products solo lo que el plan ya no vende, acotado a la organizacion, a las sucursales y a los productos del plan", () => {
    const sql = renderPmSeedPlpgsql(buildPmSeedPlan(data, agent));
    const i = sql.indexOf("delete from restaurantes.branch_products bp");
    expect(i).toBeGreaterThan(-1);
    const bloque = sql.slice(i, sql.indexOf("-- 6)", i));
    expect(bloque).toMatch(/pr\.organization_id = v_org/);
    expect(bloque).toMatch(/p\.organization_id = v_org and p\.name = b\.name/);
    expect(bloque).toMatch(/jsonb_to_recordset\(v->'products'\) as k\(name text\) where k\.name = pr\.name/);
    expect(bloque).toMatch(/not exists \(select 1 from jsonb_to_recordset\(v->'products'\) as x\(name text, "branchPrices" jsonb\) where x\.name = pr\.name and x\."branchPrices" -> b\.id is not null\)/);
    // El borrado va DESPUES de reparar/insertar los precios y ANTES de las zonas: nunca deja un producto del plan sin fila.
    expect(sql.indexOf("on conflict (property_id, product_id) do update set price")).toBeLessThan(i);
  });

  it("quitar un producto de una sucursal en los datos lo saca de su plan (la fila se borraria en la base)", () => {
    const sinSilverEnT5 = clone(data);
    const silver = sinSilverEnT5.productos.find((p) => p.nombre === "Heineken Silver")!;
    delete (silver.precios_por_sucursal as Record<string, number>).T5;
    delete (silver.fuente_precio as Record<string, string>).T5;
    // Un producto sin precio en ninguna sucursal no es valido: el seed obliga a decidir (quitarlo del todo o dejarle una sucursal).
    expect(() => buildPmSeedPlan(sinSilverEnT5, agent)).toThrow(/no tiene precio en ninguna sucursal/);
    const plan = buildPmSeedPlan(data as PmSeedData, agent);
    expect(plan.products.find((p) => p.name === "Heineken Silver")!.branchPrices).toEqual({ T5: 90 });
  });
});

describe("la cuenta demo no se toca", () => {
  it("el plan por omision es la cuenta real: slug los-taquitos-de-pm, sin marca demo", () => {
    const plan = buildPmSeedPlan(data, agent);
    expect(plan.organization.slug).toBe("los-taquitos-de-pm");
    expect(plan.demo).toBeNull();
    expect(renderPmSeedPlpgsql(plan)).not.toContain("los-taquitos-de-pm-demo");
    expect(renderPmSeedPlpgsql(plan)).toContain('"demo":null');
  });
});
