// PM-C4 -- herramientas del agente PM: alias de busqueda (search_keywords del seed), busqueda sin acentos, tortilla
// obligatoria solo cuando el menu lo dice y salsa doble sin producto "Extra salsa" (sin regresion). El SQL real del seed
// (union de alias al re-ejecutar) lo cubre scripts/verify-restaurantes-seed-pm/.
import { beforeAll, describe, expect, it } from "vitest";
import { OrderValidationError } from "../src/errors.ts";
import { buildOrderQuoteFromProducts } from "../src/order-quote.ts";
import { quoteOrder, searchProducts } from "../src/orders.ts";
import { matchesProductSearch, requiresTortillaChoice, sinAcentos, tokenizeForProductSearch } from "../src/product-search.ts";
import { buildPmSeedPlan, PmSeedError, renderPmSeedPlpgsql } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld, type PmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

let world: PmWorld;
let propertyId: string;
beforeAll(async () => {
  const plan = buildPmSeedPlan(data, agent);
  world = await buildInMemoryPmWorld(plan, { deterministic: true });
  propertyId = world.propertyBySlug.get("prol-montejo")!;
});
const buscar = async (query: string) => (await searchProducts(world.repo, { propertyId, query })).map((p) => p.name);

describe("busqueda sin acentos", () => {
  it("sinAcentos quita diacriticos y pasa a minusculas", () => {
    expect(sinAcentos("Champiñón")).toBe("champinon");
    expect(sinAcentos("BISTÉ")).toBe("biste");
  });
  it("'champinon' sin acento encuentra 'Champiñón' y con acento tambien", async () => {
    const sin = await buscar("tacos de champinon");
    expect(sin).toContain("Taco de Champiñones (individual)");
    expect(await buscar("tacos de champiñon")).toEqual(sin);
  });
  it("el nombre acentuado del catalogo se encuentra con la consulta sin acento ('frances suizo')", async () => {
    expect((await buscar("frances suizo de pastor"))).toContain("Francés Suizo de Pastor");
  });
  it("matchesProductSearch compara alias y campos sin acentos", () => {
    const fields = { name: "Taco de Champiñones", description: null, categoryName: "Tacos", searchKeywords: ["bisté"] };
    expect(matchesProductSearch(tokenizeForProductSearch("champinon"), fields)).toBe(true);
    expect(matchesProductSearch(tokenizeForProductSearch("biste"), fields)).toBe(true);
    expect(matchesProductSearch(tokenizeForProductSearch("pizza"), fields)).toBe(false);
  });
});

describe("alias del seed (search_keywords)", () => {
  it("'bitek' y 'bistek' encuentran bistec, y 'bisté' tambien", async () => {
    for (const q of ["3 de bitek", "bistek", "bisté"]) expect(await buscar(q)).toContain("Tacos de Bistec de Res (orden de 3)");
  });
  it("'pizza' encuentra Quesobich (Pizza Quesobich)", async () => {
    expect(await buscar("una pizza")).toContain("Quesobich de Pastor");
  });
  it("'chela' y 'cheve' encuentran las cervezas", async () => {
    for (const q of ["una chela", "dos cheves"]) {
      const nombres = await buscar(q);
      expect(nombres).toEqual(expect.arrayContaining(["Sol", "Heineken"]));
    }
  });
  it("'pocchuc' y 'poc chuc' encuentran Poc-Chuc", async () => {
    for (const q of ["pocchuc", "poc chuc"]) expect(await buscar(q)).toContain("Tacos de Poc-Chuc (orden de 3)");
  });
  it("'champi' encuentra Champiñón y 'de trompo' encuentra el taco al pastor por pieza", async () => {
    expect(await buscar("champi")).toContain("Taco de Champiñones (individual)");
    expect(await buscar("tacos de trompo")).toContain("Taco Al Pastor (individual)");
  });
  it("los alias P24 quedan marcados provisionales en los datos (solo bitek/bistek/bisté, trompo y champi)", () => {
    const provisionales = new Set(data.productos.flatMap((p) => p.alias_provisional_P24 ?? []));
    expect([...provisionales].sort()).toEqual(["bistek", "bisté", "bitek", "champi", "trompo"]);
  });
  it("el plan y el SQL del seed cargan los alias en products.search_keywords sin pisar los que ya tenga el producto", () => {
    const plan = buildPmSeedPlan(data, agent);
    expect(plan.products.find((p) => p.name === "Taco Al Pastor (individual)")!.searchKeywords).toEqual(["trompo"]);
    const sql = renderPmSeedPlpgsql(plan);
    expect(sql).toContain('"searchKeywords"');
    expect(sql).toMatch(/search_keywords = array\(select distinct k from unnest\(pr\.search_keywords \|\|/);
    expect(sql).toMatch(/insert into restaurantes\.products \([^)]*search_keywords\)/);
    expect(sql).toContain('"trompo"');
  });
  it("rechaza un alias invalido o un provisional que no esta en alias", () => {
    const malo = clone(data);
    (malo.productos[0] as { alias?: string[] }).alias = ["dos palabras"];
    expect(() => buildPmSeedPlan(malo, agent)).toThrow(PmSeedError);
    const huerfano = clone(data);
    (huerfano.productos[0] as { alias_provisional_P24?: string[] }).alias_provisional_P24 = ["noexiste"];
    expect(() => buildPmSeedPlan(huerfano, agent)).toThrow(/provisional/);
  });
});

describe("tortilla obligatoria solo si el menu lo dice", () => {
  it("requiresTortillaChoice: tacos y descripcion 'De maíz o harina'; nada mas", () => {
    expect(requiresTortillaChoice("Tacos de Bistec de Res (orden de 3)", "Orden de 3 tacos")).toBe(true);
    expect(requiresTortillaChoice("Quesadilla de Rajas", "De maíz o harina")).toBe(true);
    expect(requiresTortillaChoice("Gringa de Pastor", "Orden de 2 tacos")).toBe(false);
    expect(requiresTortillaChoice("Chetaco de Pastor", "Tortilla de harina extra grande con frijol")).toBe(false);
    expect(requiresTortillaChoice("Quesadilla", null)).toBe(false);
  });
  it("quesadilla sin tortilla queda como pregunta pendiente; con harina cotiza", async () => {
    const [quesadilla] = await searchProducts(world.repo, { propertyId, query: "quesadilla de rajas" });
    expect(quesadilla!.requiresTortilla).toBe(true);
    // Desde el 2-oct-2026 la quesadilla se vende en orden de 3 (decision de Javier).
    expect(quesadilla!.packSize).toBe(3);
    expect(() => buildOrderQuoteFromProducts([{ productId: quesadilla!.id, requestedQuantity: 3 }], [quesadilla!])).toThrow(/maíz, harina o mixta/);
    const quote = buildOrderQuoteFromProducts([{ productId: quesadilla!.id, requestedQuantity: 3, tortilla: "harina" }], [quesadilla!]);
    expect(quote.lines[0]!.tortilla).toBe("harina");
  });
  it("un producto cuyo menu no dice tortilla (gringa, chetaco) NO la exige", async () => {
    for (const q of ["gringa de pastor", "chetaco de pastor"]) {
      const [p] = await searchProducts(world.repo, { propertyId, query: q });
      expect(p!.requiresTortilla).toBe(false);
      const quote = buildOrderQuoteFromProducts([{ productId: p!.id, requestedQuantity: p!.packSize ?? 1 }], [p!]);
      expect(quote.lines[0]!.tortilla).toBeNull();
    }
  });
  it("sin el campo (productos de pruebas o llamadores anteriores) se decide por el nombre, como antes", () => {
    const tacos = { id: "t", name: "Tacos de Bistec", price: 100, packSize: 3, requiresAdultConfirmation: false };
    expect(() => buildOrderQuoteFromProducts([{ productId: "t", requestedQuantity: 3 }], [tacos])).toThrow(/maíz, harina o mixta/);
  });
});

describe("salsa doble sin producto 'Extra salsa' (no regresion)", () => {
  it("con el producto en el catalogo (T1, T7: $19) la doble porcion se cobra a $19 por salsa, nunca otro precio", async () => {
    for (const slug of ["prol-montejo", "garcia-lavin"]) {
      const pid = world.propertyBySlug.get(slug)!;
      const [pastor] = await searchProducts(world.repo, { propertyId: pid, query: "tacos de pastor" });
      const sinDoble = await quoteOrder(world.repo, { organizationId: world.organizationId, branchSlug: slug, canal: "recoger", items: [{ productId: pastor!.id, requestedQuantity: 1, tortilla: "maiz" }] });
      const conDoble = await quoteOrder(world.repo, { organizationId: world.organizationId, branchSlug: slug, canal: "recoger", items: [{ productId: pastor!.id, requestedQuantity: 1, tortilla: "maiz" }], doubleSalsas: ["salsa_verde", "salsa_roja"] });
      expect(conDoble.total - sinDoble.total, slug).toBe(38);
    }
  });

  it("sin el producto en el catalogo de la sucursal (T3 sigue en la lista 2025) sigue rechazando la linea con el mensaje actual: no la ofrece ni la cobra", async () => {
    const [pastor] = await searchProducts(world.repo, { propertyId: world.propertyBySlug.get("pensiones")!, query: "tacos de pastor" });
    const organizationId = world.organizationId;
    const err = await quoteOrder(world.repo, {
      organizationId,
      branchSlug: "pensiones",
      items: [{ productId: pastor!.id, requestedQuantity: pastor!.packSize ?? 1, tortilla: "maiz" }],
      doubleSalsas: ["salsa_verde"],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderValidationError);
    expect((err as Error).message).toMatch(/todavía no tiene precio en el catálogo de esta sucursal/);
    expect((err as Error).message).toMatch(/escalar_a_humano/);
  });
});
