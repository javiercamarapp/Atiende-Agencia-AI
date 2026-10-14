// Ronda 8 de medicion del agente de WhatsApp de Los Taquitos de PM, causa raiz «alias, mapeo y fracciones» (T7-032, 045, 064, 031, 005, 061, 059, 052, 038).
// Nivel funcion, sin LLM: la busqueda de producto NO debe dar lista vacia (el agente escalaba o cobraba OTRO producto) cuando el cliente pega a un platillo real una resta
// «sin X» («torta de bistek sin queso», «frijol sin tostada»), una nota de preparacion («pastor planchado», «flautas doradas», «1/4 de pollo bien picada») o dice «pollo» por la
// «Pechuga» del menu. Los precios salen siempre del menu; los negativos fijan que no se inventa un producto (sushi, BBQ) ni se cambia por uno distinto (coca sin azucar, pastor).
import { describe, expect, it } from "vitest";
import { searchProducts } from "../src/orders.ts";
import { tokenizeForProductSearch, variantesMasPermisivas } from "../src/product-search.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
const mundo = buildInMemoryPmWorld(buildPmSeedPlan(data, agent));

async function buscar(consulta: string, slug = "garcia-lavin") {
  const world = await mundo;
  return searchProducts(world.repo, { propertyId: world.propertyBySlug.get(slug)!, query: consulta });
}
const nombres = async (consulta: string) => (await buscar(consulta)).map((p) => p.name);

describe("R8: «sin X» es un ajuste, no otro producto ni otro precio", () => {
  it("T7-032: «torta de bistek sin queso» es el Frances Suizo de Bistec ($283), no lista vacia", async () => {
    const r = await buscar("1 torta de bistek sin queso");
    expect(r[0]).toMatchObject({ name: "Francés Suizo de Bistec de Res", price: 283 });
  });
  it("«frances suizo de bistec sin queso» y «frances suizo de pastor planchado sin guacamole» (T7-045) dan el platillo pedido, con su precio de menu", async () => {
    expect((await buscar("francés suizo de bistec sin queso"))[0]).toMatchObject({ name: "Francés Suizo de Bistec de Res", price: 283 });
    expect(await buscar("1 francés suizo de pastor planchado SIN guacamole")).toMatchObject([{ name: "Francés Suizo de Pastor", price: 262 }]);
  });
  it("T7-064: «frijol sin tostada» deja primero el Frijol con Tostada ($93), nunca los Frijoles Charros de $123", async () => {
    const r = await buscar("el frijol, sin tostada");
    expect(r[0]).toMatchObject({ name: "Frijol con Tostada", price: 93 });
  });
  it("varias restas («sin queso ni cebolla») y con articulo («sin la cebolla») tampoco vacian la busqueda", async () => {
    expect((await nombres("tacos de pastor sin cebolla"))[0]).toBe("Taco Al Pastor (individual)");
    expect((await nombres("nachos de bistec sin queso ni cebolla")).slice(0, 2)).toEqual(["Nachos de Bistec", "Nachos de Bistec (1/2 orden)"]);
    expect((await nombres("francés suizo de bistec sin la cebolla"))[0]).toBe("Francés Suizo de Bistec de Res");
  });
});

describe("R8: notas de preparacion y «pollo» = Pechuga", () => {
  it("T7-031: «flautas de pollo» y «1 orden de flautas con pollo doradas» encuentran la Flauta de Pechuga ($283), no se niegan", async () => {
    expect(await buscar("flautas de pollo")).toMatchObject([{ name: "Flauta de Pechuga", price: 283 }]);
    expect(await buscar("1 orden de flautas con pollo doradas")).toMatchObject([{ name: "Flauta de Pechuga", price: 283 }]);
  });
  it("T7-005: «tiras de pollo empanizadas» son los Crujientes de Pechuga de Pollo ($329)", async () => {
    expect(await buscar("las tiras de pollo empanizadas")).toMatchObject([{ name: "Crujientes de Pechuga de Pollo", price: 329 }]);
  });
  it("T7-061: «1/4 de pollo bien picada» es la Pechuga de Pollo de 250 g ($237.50), sin ambiguo", async () => {
    const r = await buscar("1/4 de pollo bien picada");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: "Pechuga de Pollo — 250 g", price: 237.5 });
    expect((r[0] as { ambiguo?: boolean }).ambiguo).toBeUndefined();
  });
  it("los que ya funcionaban se quedan: T7-059 «frijol botanero» = Frijol con Tostada; «1/4 de pollo» y «papa rellena» (papas de PM)", async () => {
    expect(await buscar("2 orden de frijol botanero")).toMatchObject([{ name: "Frijol con Tostada", price: 93 }]);
    expect(await buscar("1/4 de pollo")).toMatchObject([{ name: "Pechuga de Pollo — 250 g", price: 237.5 }]);
    const papas = await buscar("papa rellena");
    expect(papas.length).toBeGreaterThan(0);
    expect(papas.every((p) => p.categoryName === "Papas de PM")).toBe(true);
  });
});

describe("R8: negativos - la tolerancia no inventa ni cambia el producto", () => {
  it("lo que el menu no tiene sigue sin resultados: sushi, BBQ, «sin queso» a secas, una nota sola", async () => {
    for (const q of ["sushi", "sushi sin queso", "sin queso", "pollo bbq", "alitas bbq", "bien", "planchado"]) expect(await nombres(q)).toEqual([]);
  });
  it("el nombre real manda: «coca sin azucar» es Coca-Cola sin Azucar (no la normal) y «ceiba dorada» sigue siendo la cerveza", async () => {
    expect((await nombres("coca sin azucar"))[0]).toBe("Coca-Cola sin Azúcar");
    expect((await nombres("ceiba dorada"))[0]).toBe("Ceiba Dorada Premium");
  });
  it("pastor nunca se vuelve bistec (ni al reves) por la tolerancia", async () => {
    for (const q of ["flautas de pastor planchado", "francés suizo de pastor sin queso", "torta de pastor sin queso"]) {
      const r = await nombres(q);
      expect(r.length).toBeGreaterThan(0);
      expect(r.some((n) => /bistec/i.test(n))).toBe(false);
    }
    expect((await nombres("francés suizo de bistec sin queso")).some((n) => /pastor/i.test(n))).toBe(false);
  });
  it("«pollo» solo se lee como «pechuga» si no hay nada llamado pollo: la busqueda literal manda", async () => {
    const r = await nombres("pollo");
    expect(r).toContain("Alitas de Pollo");
    expect(r.every((n) => /pollo/i.test(n))).toBe(true);
  });
});

describe("R8: T7-052 y T7-038 no se rompen", () => {
  it("T7-052: «alambre de bistec con queso» es el Alambre Suizo ($314) y «frijoles charros normal» el normal ($123)", async () => {
    expect((await buscar("alambre de bistec con queso"))[0]).toMatchObject({ name: "Alambre Suizo de Bistec", price: 314 });
    expect((await buscar("2 ordenes de frijoles charros normal"))[0]).toMatchObject({ name: "Frijoles Charros Normal", price: 123 });
  });
  it("T7-038: «media orden de bistec» sigue ambigua (500 g primero) y «medio kilo de bistec» da los $550", async () => {
    const media = await buscar("media orden de bistec");
    expect(media[0]).toMatchObject({ name: "Bistec de Res — 500 g", price: 550 });
    expect(media.every((p) => (p as { ambiguo?: boolean }).ambiguo === true)).toBe(true);
    expect((await buscar("medio kilo de bistec"))[0]).toMatchObject({ name: "Bistec de Res — 500 g", price: 550 });
  });
  it("A42 (sin cambio, politica R5): 1.25 kg de pastor sigue ofreciendo las presentaciones reales marcadas ambiguas", async () => {
    const r = await buscar("1.25 kg de pastor");
    expect(r.map((p) => p.name).sort()).toEqual(["Pastor — 1 kg", "Pastor — 250 g", "Pastor — 500 g", "Pastor — 750 g"]);
    expect(r.every((p) => (p as { ambiguo?: boolean }).ambiguo === true)).toBe(true);
  });
});

describe("variantesMasPermisivas: contrato de entrada", () => {
  it("entradas vacias, solo peso o solo marcadores no producen variantes", () => {
    expect(variantesMasPermisivas([])).toEqual([]);
    expect(variantesMasPermisivas(["sin"])).toEqual([]);
    expect(variantesMasPermisivas(["sin", "queso"])).toEqual([]);
    expect(variantesMasPermisivas(["peso:250"])).toEqual([]);
    expect(variantesMasPermisivas(["peso:250", "sin", "queso"])).toEqual([]);
    expect(variantesMasPermisivas(["sinalcohol"])).toEqual([]);
    expect(variantesMasPermisivas(["bien", "picada"])).toEqual([]);
  });
  it("una consulta sin restas, notas ni sinonimos no tiene variantes; con ellas, de la mas conservadora a la mas permisiva y sin repetidas", () => {
    expect(variantesMasPermisivas(["pastor"])).toEqual([]);
    expect(variantesMasPermisivas(["frijol", "sin", "tostada"])).toEqual([["frijol"]]);
    expect(variantesMasPermisivas(["peso:250", "pollo", "bien", "picada"])).toEqual([["peso:250", "pollo"], ["peso:250", "pechuga", "bien", "picada"], ["peso:250", "pechuga"]]);
    expect(variantesMasPermisivas(["torta", "bistec", "sin", "queso", "ni", "cebolla"])).toEqual([["torta", "bistec"]]);
  });
  it("tokenizar «sin alcohol» no se confunde con una resta: el marcador sigue ahi y la cerveza sin alcohol se encuentra", async () => {
    expect(tokenizeForProductSearch("cerveza sin alcohol")).toContain("sinalcohol");
    const r = await nombres("cerveza sin alcohol");
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((n) => /sin alcohol|0[.,]0/i.test(n))).toBe(true);
  });
});
