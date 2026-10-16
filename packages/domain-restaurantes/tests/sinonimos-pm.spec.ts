// X10 / agentes-23: sinonimos de busqueda del piloto original (solo origenes aprobados) y normalizacion de faltas de escritura.
import { describe, expect, it } from "vitest";
import { searchProducts } from "../src/orders.ts";
import { tokenizeForProductSearch } from "../src/product-search.ts";
import { buildPmSeedPlan, PmSeedError, type PmSeedData } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
const plan = buildPmSeedPlan(data, agent);

async function buscar(q: string, slug = "garcia-lavin"): Promise<string[]> {
  const world = await buscar.mundo;
  return (await searchProducts(world.repo, { propertyId: world.propertyBySlug.get(slug)!, query: q })).map((p) => p.name);
}
buscar.mundo = buildInMemoryPmWorld(plan);

describe("la busqueda entiende como pide la gente", () => {
  it.each([
    ["una chela", /^(Sol|Superior|Tecate|Heineken|Indio|XX|Amstel|Bohemia|Ceiba|Patito|Ojo)/],
    ["un trompo", /^Taco Al Pastor/],
    ["una pizza", /^Quesobich/],
    ["cocacola", /^Coca-Cola/],
    ["bisteck", /Bistec/],
    ["bisctec", /Bistec/],
    ["bistek de res", /Bistec/],
    ["pok chuc", /Poc-Chuc/],
  ])("%s encuentra el producto", async (consulta, esperado) => {
    const r = await buscar(consulta);
    expect(r.length, consulta).toBeGreaterThan(0);
    expect(r.every((n) => esperado.test(n)), `${consulta} -> ${r.join(" | ")}`).toBe(true);
  });

  it("'bisctec' y 'pok' se normalizan a la forma del catalogo (falta de escritura de los chats y del piloto)", () => {
    expect(tokenizeForProductSearch("tacos de bisctec")).toEqual(["taco", "bistec"]);
    expect(tokenizeForProductSearch("pok chuc")).toEqual(["poc", "chuc"]);
    expect(tokenizeForProductSearch("nachos grandes")).toEqual(["nacho", "orden:completa"]);
  });

  it("los sinonimos del piloto cargados como alias encuentran lo que antes no", async () => {
    expect(await buscar("frijol con totopos")).toEqual(["Frijol con Tostada"]);
    expect(await buscar("cebollitas cambray")).toEqual(["Cebollas Cambray"]);
    expect(await buscar("coca zero")).toEqual(["Coca-Cola sin Azúcar"]);
    expect(await buscar("coca regular")).toEqual(["Coca-Cola"]);
    // QA-R2-AGREGADO-01: "grande/completa/entera" pide la orden COMPLETA: nunca se ofrece una media orden ("(1/2 orden)"); "media/medios" pide solo medias.
    for (const q of ["nachos grandes", "nachos completos", "nachos enteros", "grandes nachos", "una orden grande de nachos"]) {
      const completas = await buscar(q);
      expect(completas, q).toContain("Nachos de Pastor");
      expect(completas.every((n) => /^Nachos /.test(n) && !/1\/2/.test(n)), `${q} -> ${completas.join(" | ")}`).toBe(true);
    }
    const medias = await buscar("medios nachos");
    expect(medias.length).toBeGreaterThan(0);
    expect(medias.every((n) => /^Nachos .*\(1\/2 orden\)/.test(n)), medias.join(" | ")).toBe(true);
    expect(await buscar("nachos grandes de pastor")).toEqual(["Nachos de Pastor"]);
    expect((await buscar("medios charros")).every((n) => /Charros .*\(1\/2 orden\)/.test(n))).toBe(true);
  });

  it("lo que no existe en el menu sigue vacio: sushi y los productos fuera de catalogo (no se mapean a otro)", async () => {
    for (const q of ["sushi", "chipotle", "longaniza", "chistorra", "dedos de queso", "BBQ"]) expect(await buscar(q), q).toEqual([]);
  });

  it("los ambiguos que el piloto dice NO resolver con sinonimo siguen sin alias unico: 'frijol' sigue devolviendo mas de un platillo", async () => {
    expect((await buscar("frijol")).length).toBeGreaterThan(1);
    const alambre = await buscar("alambre");
    expect(alambre.length).toBeGreaterThan(1);
  });
});

describe("alias del piloto en el plan del seed", () => {
  const conAlias = plan.products.filter((p) => p.searchKeywords.length > 0);

  it("se suman a los alias ya sembrados (no los reemplazan) y trazan su origen en los datos", () => {
    const frijol = data.productos.find((p) => p.nombre === "Frijol con Tostada")!;
    expect(frijol.alias).toEqual(expect.arrayContaining(["frijoles", "frijolito", "botanero", "totopos"]));
    expect(frijol.alias_piloto).toEqual({ totopos: "chats_c3" });
    expect(conAlias.find((p) => p.name === "Frijol con Tostada")!.searchKeywords).toContain("totopos");
  });

  it("solo entran los origenes aprobados (chats_c3, derivado_nombre, cuestionario_pm y, desde el OK de Javier del 7-oct, cuestionario_web y sentido_comun_aprobado)", () => {
    for (const p of data.productos) for (const origen of Object.values(p.alias_piloto ?? {})) expect(origen).toMatch(/^(chats_c3|derivado_nombre|cuestionario_pm|cuestionario_web|sentido_comun_aprobado)/);
    const mala = JSON.parse(JSON.stringify(data)) as { productos: Array<{ nombre: string; alias?: string[]; alias_piloto?: Record<string, string> }> };
    const p = mala.productos.find((x) => x.nombre === "Coca-Cola")!;
    p.alias = [...(p.alias ?? []), "burbujas"];
    p.alias_piloto = { burbujas: "sentido_comun_a_validar" };
    expect(() => buildPmSeedPlan(mala as unknown as PmSeedData, agent)).toThrow(PmSeedError);
    expect(() => buildPmSeedPlan(mala as unknown as PmSeedData, agent)).toThrow(/origen no aprobado/);
  });

  it("un alias del piloto debe estar tambien en alias", () => {
    const mala = JSON.parse(JSON.stringify(data)) as { productos: Array<{ nombre: string; alias_piloto?: Record<string, string> }> };
    mala.productos.find((x) => x.nombre === "Coca-Cola")!.alias_piloto = { fantasma: "chats_c3" };
    expect(() => buildPmSeedPlan(mala as unknown as PmSeedData, agent)).toThrow(/no esta en alias/);
  });
});
