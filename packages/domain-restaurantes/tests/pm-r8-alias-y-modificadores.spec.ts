// Ronda 8 de medicion del agente de WhatsApp de Los Taquitos de PM, causa raiz «alias, mapeo y fracciones» (T7-032, 045, 064, 031, 005, 061, 059, 052, 038).
// Nivel funcion, sin LLM: la busqueda de producto NO debe dar lista vacia (el agente escalaba o cobraba OTRO producto) cuando el cliente pega a un platillo real una resta
// «sin X» («torta de bistek sin queso», «frijol sin tostada»), una nota de preparacion («pastor planchado», «flautas doradas», «1/4 de pollo bien picada») o dice «pollo» por la
// «Pechuga» del menu. Los precios salen siempre del menu; los negativos fijan que no se inventa un producto (sushi, BBQ) ni se cambia por uno distinto (coca sin azucar, pastor).
import { describe, expect, it } from "vitest";
import { searchProducts } from "../src/orders.ts";
import { aplicarRestas, tokenizeForProductSearch, variantesMasPermisivas } from "../src/product-search.ts";
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
  it("entradas vacias, invalidas, solo peso o solo marcadores no producen variantes ni lanzan", () => {
    for (const malo of [0, "", {}, "sin queso", null, undefined, false, [1], [null], 5n]) expect(variantesMasPermisivas(malo)).toEqual([]);
    expect(variantesMasPermisivas([])).toEqual([]);
    expect(variantesMasPermisivas(["sin"])).toEqual([]);
    expect(variantesMasPermisivas(["sin", "queso"])).toEqual([]);
    expect(variantesMasPermisivas(["peso:250"])).toEqual([]);
    expect(variantesMasPermisivas(["peso:250", "sin", "queso"])).toEqual([]);
    expect(variantesMasPermisivas(["sinalcohol"])).toEqual([]);
    expect(variantesMasPermisivas(["bien", "picada"])).toEqual([]);
  });
  it("sin restas, notas ni sinonimos no hay variantes; con ellas, de la mas conservadora a la mas permisiva, sin repetidas y con las palabras restadas", () => {
    expect(variantesMasPermisivas(["pastor"])).toEqual([]);
    expect(variantesMasPermisivas(["frijol", "sin", "tostada"])).toEqual([{ tokens: ["frijol"], restados: ["tostada"], conSinonimo: false }]);
    expect(variantesMasPermisivas(["peso:250", "pollo", "bien", "picada"])).toEqual([
      { tokens: ["peso:250", "pollo"], restados: [], conSinonimo: false },
      { tokens: ["peso:250", "pechuga", "bien", "picada"], restados: [], conSinonimo: true },
      { tokens: ["peso:250", "pechuga"], restados: [], conSinonimo: true },
    ]);
    expect(variantesMasPermisivas(["torta", "bistec", "sin", "queso", "ni", "cebolla"])).toEqual([{ tokens: ["torta", "bistec"], restados: ["queso", "cebolla"], conSinonimo: false }]);
  });
  it("una resta que DEFINE otro producto (azucar, soda, gas, gluten, cafeina...) no se relaja nunca", () => {
    for (const r of ["azucar", "soda", "gas", "gluten", "lactosa", "cafeina", "alcohol"]) expect(variantesMasPermisivas(["coca", "sin", r])).toEqual([]);
    expect(variantesMasPermisivas(["coca", "sin", "hielo"])).toEqual([{ tokens: ["coca"], restados: ["hielo"], conSinonimo: false }]);
  });
  it("tokenizar «sin alcohol» no se confunde con una resta: el marcador sigue ahi y la cerveza sin alcohol se encuentra", async () => {
    expect(tokenizeForProductSearch("cerveza sin alcohol")).toContain("sinalcohol");
    const r = await nombres("cerveza sin alcohol");
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((n) => /sin alcohol|0[.,]0/i.test(n))).toBe(true);
  });
});

describe("aplicarRestas: nunca el contrario", () => {
  const P = (name: string) => ({ name });
  it("sin restas devuelve todo; sin candidatos devuelve vacio", () => {
    expect(aplicarRestas([P("Taco")], [], ["taco"])).toEqual({ productos: [P("Taco")], ambiguo: false });
    expect(aplicarRestas([], ["queso"], ["taco"])).toEqual({ productos: [], ambiguo: false });
  });
  it("quita los que llevan la palabra restada en el nombre (incluida subcadena: cebolla en Encebollado) y los «sin ...» del menu", () => {
    const r = aplicarRestas([P("Tacos de Bistec de Res (orden de 3)"), P("Tacos de Bistec Encebollado (orden de 3)")], ["cebolla"], ["taco", "bistec"]);
    expect(r.productos.map((p) => p.name)).toEqual(["Tacos de Bistec de Res (orden de 3)"]);
    expect(aplicarRestas([P("Coca-Cola"), P("Coca-Cola sin Azúcar")], ["hielo"], ["coca"]).productos.map((p) => p.name)).toEqual(["Coca-Cola"]);
  });
  it("si el producto sin la palabra restada no esta, NO devuelve el que la lleva (Charros con Queso), salvo la excepcion «Frijol con Tostada» marcada ambiguo", () => {
    expect(aplicarRestas([P("Frijoles Charros con Queso")], ["queso"], ["frijole", "charro"])).toEqual({ productos: [], ambiguo: false });
    expect(aplicarRestas([P("Frijol con Tostada"), P("Frijoles Charros Normal")], ["tostada"], ["frijol"])).toEqual({ productos: [P("Frijol con Tostada")], ambiguo: true });
    expect(aplicarRestas([P("Frijol con Tostada"), P("Frijoles Charros Normal")], ["tostada"], ["frijole"])).toEqual({ productos: [P("Frijol con Tostada")], ambiguo: true });
  });
});

describe("R8 (revision): las restas nunca devuelven el contrario, ni con existencias agotadas", () => {
  async function sinProducto(nombreExacto: string[], consulta: string, slug = "garcia-lavin") {
    const world = await mundo;
    const propertyId = world.propertyBySlug.get(slug)!;
    const real = world.repo.listAvailableProductsForBranch.bind(world.repo);
    const repo = Object.create(world.repo) as typeof world.repo;
    repo.listAvailableProductsForBranch = async (id: string) => (await real(id)).filter((p) => !nombreExacto.includes(p.name));
    return (await searchProducts(repo, { propertyId, query: consulta })).map((p) => ({ name: p.name, ambiguo: (p as { ambiguo?: boolean }).ambiguo === true }));
  }
  it("orden: «frijoles charros sin queso» deja la version sin queso primero y sin la «con Queso»; «hamburguesa sin queso» no trae la «con Queso»", async () => {
    const charros = await nombres("frijoles charros sin queso");
    expect(charros[0]).toBe("Frijoles Charros Normal");
    expect(charros.some((n) => /con queso/i.test(n))).toBe(false);
    const hamb = await nombres("hamburguesa sin queso");
    expect(hamb).toEqual(["Boyo-Hamburguesa Sencilla"]);
  });
  it("«tacos de bistec sin cebolla» no trae el Encebollado; con los de Res agotados da vacio, no el contrario", async () => {
    expect((await nombres("tacos de bistec sin cebolla")).some((n) => /encebollado/i.test(n))).toBe(false);
    expect((await nombres("tacos de bistec sin cebolla"))[0]).toBe("Tacos de Bistec de Res (orden de 3)");
    const sinRes = await sinProducto(["Tacos de Bistec de Res (orden de 3)"], "tacos de bistec sin cebolla");
    expect(sinRes.some((x) => /encebollado/i.test(x.name))).toBe(false);
    expect(sinRes.every((x) => x.ambiguo)).toBe(true);
  });
  it("«limonada sin soda» y «coca sin azucar», «agua sin gas», «cafe sin cafeina»: sin el producto exacto agotado/inexistente dan vacio, nunca el contrario", async () => {
    expect(await nombres("limonada sin soda")).toEqual([]);
    expect(await nombres("agua sin gas")).toEqual([]);
    expect(await nombres("cafe sin cafeina")).toEqual([]);
    expect(await sinProducto(["Coca-Cola sin Azúcar"], "coca sin azucar")).toEqual([]);
    expect(await sinProducto(["Coca-Cola sin Azúcar"], "refresco sin azucar")).toEqual([]);
    expect((await sinProducto([], "coca sin azucar"))[0]).toMatchObject({ name: "Coca-Cola sin Azúcar" });
  });
  it("«coca sin hielo» no cambia a Coca-Cola sin Azucar: trae solo la Coca-Cola normal (ni la sin Azucar ni la Light), marcado ambiguo", async () => {
    const r = await sinProducto([], "coca sin hielo");
    expect(r.map((x) => x.name)).toEqual(["Coca-Cola"]);
    expect(r.every((x) => x.ambiguo)).toBe(true);
  });
  it("T7-064 (plural y singular): «frijoles sin tostadas» y «frijol sin tostada» dan el Frijol con Tostada primero, ambiguo; con el Frijol agotado NO se cobran los Charros de $123", async () => {
    for (const q of ["frijoles sin tostadas", "frijol sin tostada"]) {
      const r = await buscar(q);
      expect(r[0]).toMatchObject({ name: "Frijol con Tostada", price: 93 });
      expect((r[0] as { ambiguo?: boolean }).ambiguo).toBe(true);
    }
    const sinFrijol = await sinProducto(["Frijol con Tostada"], "frijol sin tostada");
    expect(sinFrijol.every((x) => x.ambiguo)).toBe(true);
  });
  it("el sinonimo solo casa con el NOMBRE o alias: «pollo en mole», «ensalada de pollo», «pollo con guacamole/papas/crema/lechuga» siguen vacios", async () => {
    for (const q of ["pollo en mole", "ensalada de pollo", "pollo con guacamole", "pollo con crema", "pollo con lechuga", "pollo al horno", "pollo gratinado", "pollo con champiñones", "pollo con frijol"]) expect(await nombres(q)).toEqual([]);
  });
  it("quitar una resta o inferir un sinonimo va marcado ambiguo (el agente lo confirma); solo quitar una nota con un unico producto, no", async () => {
    const amb = (r: Awaited<ReturnType<typeof buscar>>) => r.map((p) => (p as { ambiguo?: boolean }).ambiguo);
    expect(amb(await buscar("francés suizo sin queso")).every((a) => a === true)).toBe(true);
    expect(amb(await buscar("torta de bistek sin queso"))).toEqual([true]);
    expect(amb(await buscar("flautas de pollo"))).toEqual([true]);
    expect(amb(await buscar("pollo con papas"))).toEqual([true]);
    expect(amb(await buscar("1 francés suizo de pastor planchado"))).toEqual([undefined]);
  });
  it("la PRIMERA variante que encuentra algo gana (restas antes que sinonimos) y sus tokens ordenan el resultado", async () => {
    // «pollo sin cebolla»: la variante sin resta («pollo») ya encuentra platillos con «pollo» en el nombre; no se sustituye por «pechuga».
    const r = await nombres("pollo sin cebolla");
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((n) => /pollo/i.test(n))).toBe(true);
    expect(r.some((n) => /encebollado|cebolla/i.test(n))).toBe(false);
  });
  it("los tokens de la variante ganadora son los que siguen en la busqueda: «media orden de bistec sin cebolla» sigue la duda media orden / medio kilo (500 g primero, ambiguo)", async () => {
    const r = await buscar("media orden de bistec sin cebolla");
    expect(r[0]).toMatchObject({ name: "Bistec de Res — 500 g", price: 550 });
    expect(r.every((p) => (p as { ambiguo?: boolean }).ambiguo === true)).toBe(true);
  });
  it("en las variantes una palabra casa con el inicio de una palabra del nombre, no con una subcadena, y las de 1-2 letras solo si son la palabra entera", async () => {
    expect(await nombres("ito sin queso")).toEqual([]);
    expect(await nombres("en sin queso")).toEqual([]);
    expect(await nombres("pollo en sin queso")).toEqual([]);
  });
  it("la excepcion «Frijol con Tostada» exige el «con X» del nombre: quitar el platillo mismo («nachos sin pastor») NUNCA devuelve ese platillo", async () => {
    const filas: Array<[string, string]> = [
      ["nachos sin pastor", "pastor"], ["tacos sin pastor", "pastor"], ["gringa sin pastor", "pastor"], ["papa sin pastor", "pastor"], ["papa sin bistec", "bistec"],
      ["quesadilla sin chorizo", "chorizo"], ["mestiza sin bistec", "bistec"], ["alambre sin pastor", "pastor"], ["flauta sin pastor", "pastor"], ["flautas sin pastor", "pastor"],
      ["suizo sin pastor", "pastor"], ["chetaco sin pastor", "pastor"], ["platillo sin pastor", "pastor"], ["quesobich sin pastor", "pastor"], ["fajitas sin bistec", "bistec"],
    ];
    for (const [q, palabra] of filas) {
      const r = await nombres(q);
      expect(r.filter((n) => n.toLowerCase().normalize("NFD").includes(palabra)), q).toEqual([]);
    }
    const quesadilla = await nombres("quesadilla sin chorizo");
    expect(quesadilla.length).toBeGreaterThan(0);
    expect(quesadilla[0]).toMatch(/natural/i);
  });
  it("un resultado relajado SOLO por nota con varios productos va ambiguo («flautas doradas»: las 7 flautas)", async () => {
    const r = await buscar("flautas doradas");
    expect(r.length).toBeGreaterThan(1);
    expect(r.every((p) => (p as { ambiguo?: boolean }).ambiguo === true)).toBe(true);
  });
  it("las versiones cero / light / 0.0 no se cuelan en una resta ajena: «sprite sin hielo» sin Sprite Cero, «heineken sin hielo» sin la 0.0; si lo pide, si", async () => {
    expect(await nombres("sprite sin hielo")).toEqual(["Sprite"]);
    const heineken = await nombres("heineken sin hielo");
    expect(heineken.length).toBeGreaterThan(0);
    expect(heineken.some((n) => /0[.,]0|cero/i.test(n))).toBe(false);
    expect((await nombres("sprite cero"))[0]).toBe("Sprite Cero");
  });
});
