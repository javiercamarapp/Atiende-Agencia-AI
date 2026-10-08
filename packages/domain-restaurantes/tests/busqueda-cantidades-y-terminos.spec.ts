// Corpus propio de cantidades y terminos de buscar_producto (Los Taquitos de PM, sucursal T7 = garcia-lavin) + propiedades de dinero.
// Cubre las 6 brechas de la revision de #500: "cuarto kilo", "un cuarto kilo", "media orden de bistec", "una cerveza", plurales en -es y "sin alcohol".
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toolDefinitionsForChannel } from "../src/agent-tools/registry.ts";
import { searchProducts } from "../src/orders.ts";
import { pesoDeProductoEnGramos, singularizar, tokenizeForProductSearch } from "../src/product-search.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
const mundo = buildInMemoryPmWorld(buildPmSeedPlan(data, agent));
async function buscarCompleto(consulta: string, slug = "garcia-lavin") {
  const world = await mundo;
  return searchProducts(world.repo, { propertyId: world.propertyBySlug.get(slug)!, query: consulta });
}
const nombres = async (q: string) => (await buscarCompleto(q)).map((p) => p.name);

const BISTEC_250 = ["Bistec de Res — 250 g", "Bistec de Res Encebollado — 250 g"];
const BISTEC_500 = ["Bistec de Res — 500 g", "Bistec de Res Encebollado — 500 g"];
const BISTEC_750 = ["Bistec de Res — 750 g", "Bistec de Res Encebollado — 750 g"];
const BISTEC_1500 = ["Bistec de Res — 1.5 kg", "Bistec de Res Encebollado — 1.5 kg"];
const TODOS_LOS_PASTOR = ["Pastor — 1 kg", "Pastor — 250 g", "Pastor — 500 g", "Pastor — 750 g", "Pastor — 1.5 kg", "Pastor — 2 kg"];

/** Consultas con resultado EXACTO (orden incluido). */
const EXACTOS: ReadonlyArray<readonly [string, readonly string[]]> = [
  // 250 g en todas sus formas (brechas 1 y 2)
  ["cuarto kilo de bistec", BISTEC_250],
  ["un cuarto kilo de bistec", BISTEC_250],
  ["un cuarto de kilo de bistec", BISTEC_250],
  ["cuarto de kilo de bistec", BISTEC_250],
  ["1/4 de kilo de bistec", BISTEC_250],
  ["1/4 kg de bistec", BISTEC_250],
  ["0.25 kg de bistec", BISTEC_250],
  ["250 gramos de bistec", BISTEC_250],
  ["250 g de bistec", BISTEC_250],
  ["250g de bistec", BISTEC_250],
  ["250 grs de bistec", BISTEC_250],
  ["un cuarto de bistec", BISTEC_250],
  ["cuarto de bistec", BISTEC_250],
  ["dame un cuarto de pastor", ["Pastor — 250 g"]],
  ["cuarto kilo de pastor", ["Pastor — 250 g"]],
  ["un cuarto kilo de costilla", ["Costilla de Res — 250 g"]],
  ["cuarto kilo de poc chuc", ["Poc-Chuc — 250 g"]],
  // 500 g, 750 g, 1 kg, 1.5 kg, 2 kg
  ["medio kilo de bistec", BISTEC_500],
  ["medio kg de bistec", BISTEC_500],
  ["1/2 kilo de bistec", BISTEC_500],
  ["500 gramos de bistec", BISTEC_500],
  ["medio kilo de pechuga", ["Pechuga de Pollo — 500 g"]],
  ["tres cuartos de bistec", BISTEC_750],
  ["tres cuartos de kilo de pastor", ["Pastor — 750 g"]],
  ["3/4 de kilo de pastor", ["Pastor — 750 g"]],
  ["750 gramos de arrachera", ["Arrachera — 750 g"]],
  ["un kilo de arrachera", ["Arrachera — 1 kg"]],
  ["kilo de pastor", ["Pastor — 1 kg"]],
  ["kilo y medio de bistec", BISTEC_1500],
  ["1.5 kg de bistec", BISTEC_1500],
  ["un kilo y medio de pastor", ["Pastor — 1.5 kg"]],
  ["2 kilos de arrachera", ["Arrachera — 2 kg"]],
  ["dos kilos de pastor", ["Pastor — 2 kg"]],
  ["dos kilos de bistec encebollado", ["Bistec de Res Encebollado — 2 kg"]],
  // un peso que el menu no vende como tal: solo presentaciones MENORES (nunca la de mas peso)
  ["300 gramos de pastor", ["Pastor — 250 g"]],
  ["300 gramos de bistec", BISTEC_250],
  // media orden con el platillo nombrado: la media orden SI es lo pedido
  ["media orden de nachos de bistec", ["Nachos de Bistec (1/2 orden)"]],
  ["media orden de nachos de pastor", ["Nachos de Pastor (1/2 orden)"]],
  ["media orden de frijoles charros con queso", ["Frijoles Charros con Queso (1/2 orden)"]],
  ["media orden de champiñones", ["Nachos de Champiñón (1/2 orden)"]],
  // plurales en -es y cantidad "un/una" (brechas 4 y 5)
  ["nachos de champiñon", ["Nachos de Champiñón", "Nachos de Champiñón (1/2 orden)"]],
  // sin alcohol (brecha 6)
  ["cerveza sin alcohol", ["Heineken 0.0"]],
  ["cervezas sin alcohol", ["Heineken 0.0"]],
  ["una cerveza sin alcohol", ["Heineken 0.0"]],
  ["heineken sin alcohol", ["Heineken 0.0"]],
  ["heineken 0.0", ["Heineken 0.0"]],
  ["heineken cero", ["Heineken 0.0"]],
  ["chela sin alcohol", ["Heineken 0.0"]],
  ["cerveza 0%", ["Heineken 0.0"]],
  ["margarita sin alcohol", ["Margarita sin Alcohol"]],
  ["una margarita sin alcohol", ["Margarita sin Alcohol"]],
];

describe("corpus de cantidades y terminos: resultado exacto", () => {
  it.each(EXACTOS)("%s", async (consulta, esperado) => {
    expect(await nombres(consulta)).toEqual(esperado);
  });
});

describe("corpus: ambiguedad marcada (nunca una eleccion en silencio)", () => {
  it("'media orden de bistec' no devuelve Nachos de Bistec: ofrece el medio kilo primero y todo va marcado ambiguo", async () => {
    const r = await buscarCompleto("media orden de bistec");
    expect(r.length).toBeGreaterThan(2);
    expect(r.slice(0, 2).map((p) => p.name)).toEqual(BISTEC_500);
    expect(r.every((p) => p.ambiguo === true)).toBe(true);
    expect(r.some((p) => /1\/2 orden|^Nachos/.test(p.name))).toBe(false);
  });

  it("'media orden de pastor' tampoco elige los Nachos de Pastor (1/2 orden)", async () => {
    const r = await buscarCompleto("media orden de pastor");
    expect(r[0]!.name).toBe("Pastor — 500 g");
    expect(r.every((p) => p.ambiguo === true)).toBe(true);
    expect(r.some((p) => /1\/2 orden/.test(p.name))).toBe(false);
  });

  it("'3 kilos de pastor' (sin presentacion de ese peso) lista todas las presentaciones, ninguna mayor a 2 kg, marcadas ambiguo", async () => {
    const r = await buscarCompleto("3 kilos de pastor");
    expect(r.map((p) => p.name).sort()).toEqual([...TODOS_LOS_PASTOR].sort());
    expect(r.every((p) => p.ambiguo === true)).toBe(true);
  });

  it("'kilo y cuarto de pastor' (1250 g) lista solo las presentaciones de hasta 1 kg, marcadas ambiguo", async () => {
    const r = await buscarCompleto("kilo y cuarto de pastor");
    expect(r.map((p) => p.name).sort()).toEqual(["Pastor — 1 kg", "Pastor — 250 g", "Pastor — 500 g", "Pastor — 750 g"]);
    expect(r.every((p) => p.ambiguo === true)).toBe(true);
  });

  it("'300 gramos de pastor' ofrece el de 250 g (menor), marcado ambiguo, y no el de 500 g", async () => {
    const r = await buscarCompleto("300 gramos de pastor");
    expect(r.map((p) => [p.name, p.ambiguo])).toEqual([["Pastor — 250 g", true]]);
  });

  it("'100 gramos de pastor' (menos que la presentacion mas chica) no ofrece ningun peso", async () => {
    const r = await buscarCompleto("100 gramos de pastor");
    expect(r.some((p) => pesoDeProductoEnGramos(p.name) !== null)).toBe(false);
    expect(r.every((p) => p.ambiguo === true)).toBe(true);
  });

  it("con cantidad exacta NO hay ambiguedad: ningun resultado lleva el marcador", async () => {
    for (const q of ["cuarto kilo de bistec", "medio kilo de bistec", "kilo de pastor", "una cerveza", "flanes", "heineken sin alcohol"]) {
      expect((await buscarCompleto(q)).some((p) => p.ambiguo === true), q).toBe(false);
    }
  });
});

describe("corpus: terminos", () => {
  it("'una cerveza' / 'dos cervezas' / 'una chela' devuelven cervezas (antes: vacio) y ningun coctel", async () => {
    for (const q of ["una cerveza", "dos cervezas", "una chela", "una cerveza heineken"]) {
      const r = await buscarCompleto(q);
      expect(r.length, q).toBeGreaterThan(0);
      expect(r.every((p) => p.categoryName === "Cervezas"), `${q} -> ${r.map((p) => p.name).join(" | ")}`).toBe(true);
    }
  });

  it("'una cerveza sol' sigue encontrando Sol", async () => {
    expect(await nombres("una cerveza sol")).toContain("Sol");
  });

  it("plurales en -es: flanes, dos flanes, normales, pastores, champinones", async () => {
    expect(await nombres("flanes")).toContain("Flan");
    expect(await nombres("dos flanes")).toContain("Flan");
    expect(await nombres("frijoles charros normales")).toContain("Frijoles Charros Normal");
    expect((await nombres("frijoles charros especiales"))[0]).toBe("Frijoles Charros Especiales");
    expect(await nombres("pastores")).toEqual(await nombres("pastor"));
    expect(await nombres("champiñones")).toEqual(await nombres("champiñon"));
  });

  it("'cerveza con alcohol' ya no devuelve los 'sin Alcohol'", async () => {
    const r = await nombres("cerveza con alcohol");
    expect(r.some((n) => /sin alcohol/i.test(n))).toBe(false);
    expect(r.length).toBeGreaterThan(0);
  });

  it("'sin alcohol' nunca devuelve una bebida con alcohol; la cerveza con alcohol sigue pidiendo confirmacion de edad y la 0.0 no", async () => {
    for (const q of ["sin alcohol", "cerveza sin alcohol", "coctel sin alcohol", "heineken sin alcohol", "cerveza 0%"]) {
      const r = await buscarCompleto(q);
      expect(r.length, q).toBeGreaterThan(0);
      expect(r.every((p) => /sin alcohol|0\.0/i.test(p.name) && p.requiresAdultConfirmation === false), `${q} -> ${r.map((p) => p.name).join(" | ")}`).toBe(true);
    }
    const heineken = await buscarCompleto("heineken");
    expect(heineken.find((p) => p.name === "Heineken")!.requiresAdultConfirmation).toBe(true);
    expect(heineken.find((p) => p.name === "Heineken 0.0")!.requiresAdultConfirmation).toBe(false);
  });

  it("'cerveza sin alcohol' no devuelve cocteles (antes: Margarita, Daiquiri...) y 'coctel sin alcohol' no mezcla cervezas con alcohol", async () => {
    expect((await nombres("cerveza sin alcohol")).some((n) => /Margarita|Daiquiri|Conga|Sangr/.test(n))).toBe(false);
    expect((await nombres("coctel sin alcohol")).filter((n) => !/sin alcohol|0\.0/i.test(n))).toEqual([]);
  });

  it("no inventa: lo que no esta en el menu sigue vacio", async () => {
    for (const q of ["sushi", "una cerveza de barril", "un cuarto kilo de salmon", "medio kilo de langosta"]) expect(await nombres(q), q).toEqual([]);
  });

  it("los pesos que NO aplican al platillo no rompen la busqueda: 'un cuarto de cochinita' sigue devolviendo la cochinita, marcada ambiguo", async () => {
    const r = await buscarCompleto("un cuarto de cochinita");
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((p) => /Cochinita/.test(p.name) && p.ambiguo === true)).toBe(true);
  });
});

describe("tokenizador: cantidades y singularizacion", () => {
  it.each([
    ["cuarto kilo de bistec", ["peso:250", "bistec"]],
    ["un cuarto kilo de bistec", ["peso:250", "bistec"]],
    ["un cuarto de kilo de bistec", ["peso:250", "bistec"]],
    ["kilo y medio de bistec", ["peso:1500", "bistec"]],
    ["tres cuartos de bistec", ["peso:750", "bistec"]],
    ["medio kilo de bistec", ["peso:500", "bistec"]],
    ["kilo y cuarto de bistec", ["peso:1250", "bistec"]],
    ["250 grs de bistec", ["peso:250", "bistec"]],
  ])("%s", (consulta, esperado) => {
    expect(tokenizeForProductSearch(consulta)).toEqual(esperado);
  });

  it.each([
    ["flanes", "flan"],
    ["normales", "normal"],
    ["pastores", "pastor"],
    ["champiñones", "champiñon"],
    ["tamales", "tamal"],
    ["pasteles", "pastel"],
    ["tacos", "taco"],
    ["chiles", "chile"],
    ["frijoles", "frijole"],
    ["tomates", "tomate"],
    ["flan", "flan"],
    ["pastor", "pastor"],
  ])("singularizar(%s) = %s", (plural, singular) => {
    // "champiñones" llega ya sin diacriticos al singularizador en el flujo real; aqui se prueba la regla sobre el texto tal cual.
    expect(singularizar(plural.normalize("NFD").replace(/[̀-ͯ]/g, ""))).toBe(singular.normalize("NFD").replace(/[̀-ͯ]/g, ""));
  });
});

describe("propiedades (dinero)", () => {
  const PESOS: ReadonlyArray<readonly [string, number]> = [
    ["un cuarto kilo", 250], ["cuarto kilo", 250], ["un cuarto de kilo", 250], ["1/4 kg", 250], ["250 gramos", 250], ["250g", 250],
    ["medio kilo", 500], ["medio kg", 500], ["500 gramos", 500], ["tres cuartos de kilo", 750], ["3/4 de kilo", 750], ["750 gramos", 750],
    ["un kilo", 1000], ["1 kg", 1000], ["1000 gramos", 1000], ["kilo y medio", 1500], ["1.5 kg", 1500], ["dos kilos", 2000], ["2 kg", 2000],
    ["100 gramos", 100], ["300 gramos", 300], ["600 gramos", 600], ["900 gramos", 900],
  ];
  const PLATILLOS = ["bistec", "pastor", "arrachera", "chuleta", "pechuga", "costilla", "poc chuc", "bistec encebollado"];

  it("ninguna consulta de cantidad devuelve una presentacion de MAS peso (ni de mas precio por peso) que lo pedido, y la exacta devuelve solo esa", async () => {
    let comprobadas = 0;
    for (const [frase, gramos] of PESOS) {
      for (const platillo of PLATILLOS) {
        const r = await buscarCompleto(`${frase} de ${platillo}`);
        for (const p of r) {
          const g = pesoDeProductoEnGramos(p.name);
          if (g === null) continue;
          comprobadas++;
          expect(g, `${frase} de ${platillo} -> ${p.name}`).toBeLessThanOrEqual(gramos);
        }
        const conPeso = r.filter((p) => pesoDeProductoEnGramos(p.name) !== null);
        const hayExacta = conPeso.some((p) => pesoDeProductoEnGramos(p.name) === gramos);
        if (hayExacta) {
          expect(conPeso.every((p) => pesoDeProductoEnGramos(p.name) === gramos), `${frase} de ${platillo}`).toBe(true);
          expect(r.every((p) => p.ambiguo !== true), `${frase} de ${platillo}`).toBe(true);
        }
        // Mismo platillo: el precio por kg es lineal, asi que un peso menor o igual nunca cuesta mas que el pedido.
        const porKg = Math.max(...conPeso.map((p) => (p.price / (pesoDeProductoEnGramos(p.name) ?? 1)) * 1000), 0);
        for (const p of conPeso) expect(p.price, `${frase} de ${platillo} -> ${p.name}`).toBeLessThanOrEqual((porKg * gramos) / 1000 + 0.01);
      }
    }
    expect(comprobadas).toBeGreaterThan(40);
  });

  it("singular y plural dan el mismo resultado", async () => {
    const PARES: ReadonlyArray<readonly [string, string]> = [
      ["flan", "flanes"], ["taco de pastor", "tacos de pastor"], ["flauta", "flautas"], ["chela", "chelas"], ["nacho de bistec", "nachos de bistec"],
      ["frijol charro normal", "frijoles charros normales"], ["pastor", "pastores"], ["quesadilla de champiñon", "quesadillas de champiñones"],
      ["gringa de pastor", "gringas de pastor"], ["cerveza sin alcohol", "cervezas sin alcohol"], ["cerveza", "cervezas"], ["papa pastor", "papas pastor"],
      ["coca cola", "coca colas"], ["alambre", "alambres"], ["kilo de pastor", "kilos de pastor"],
    ];
    for (const [singular, plural] of PARES) expect(await nombres(plural), `${singular} / ${plural}`).toEqual(await nombres(singular));
  });

  it("'un/una' delante de lo pedido no cambia el resultado (cantidad 1)", async () => {
    for (const q of ["flan", "cerveza", "chela", "gringa de pastor", "margarita sin alcohol", "coca cola", "kilo de pastor", "cuarto kilo de bistec"]) {
      const con = /^(?:kilo|cuarto)/.test(q) ? `un ${q}` : `una ${q}`;
      expect(await nombres(con), con).toEqual(await nombres(q));
    }
  });
});

describe("revision de #505: orden, fracciones Unicode y descripcion de la herramienta", () => {
  it("el singular de la consulta sigue contando como palabra exacta: 'champiñones' y 'especiales' no pierden contra un prefijo", async () => {
    for (const q of ["champiñones", "de champiñones", "3 de champiñones"]) expect((await nombres(q))[0], q).toBe("Taco de Champiñones (individual)");
    for (const q of ["especiales", "unos especiales"]) {
      const r = await nombres(q);
      expect(r[0], q).toBe("Frijoles Charros Especiales");
    }
  });

  it.each([
    ["dos cuartos de pastor", ["Pastor — 500 g"]],
    ["dos cuartos de kilo de bistec", BISTEC_500],
    ["½ kilo de pastor", ["Pastor — 500 g"]],
    ["¼ kilo de pastor", ["Pastor — 250 g"]],
    ["¾ de kilo de pastor", ["Pastor — 750 g"]],
    ["1½ kg de pastor", ["Pastor — 1.5 kg"]],
    ["1 kg y medio de pastor", ["Pastor — 1.5 kg"]],
    ["0% alcohol", ["Heineken 0.0", "Conga sin Alcohol", "Daiquiri sin Alcohol", "Margarita sin Alcohol", "Sangría sin Alcohol"]],
    ["cocteles sin alcohol", ["Conga sin Alcohol", "Daiquiri sin Alcohol", "Margarita sin Alcohol", "Sangría sin Alcohol"]],
  ])("%s", async (consulta, esperado) => {
    expect(await nombres(consulta)).toEqual(esperado);
  });

  it("la descripcion de buscar_producto explica `ambiguo` al modelo, en WhatsApp y en voz", () => {
    for (const canal of ["whatsapp", "voz"] as const) {
      const def = toolDefinitionsForChannel(canal).find((t) => t.name === "buscar_producto")!;
      expect(def.description, canal).toMatch(/ambiguo: true/);
      expect(def.description, canal).toMatch(/NO elijas por el cliente/);
    }
  });
});

describe("revision 2 de #505: 'N y medio' con N >= 2 nunca entrega 1.5 kg (ni otra presentacion menor) como unica coincidencia", () => {
  const TODOS = [...TODOS_LOS_PASTOR].sort();
  it.each([
    "2 kg y medio de pastor", "3 kg y medio de pastor", "4 kg y medio de pastor", "5 kg y medio de pastor", "10 kg y medio de pastor", "dos kg y medio de pastor", "tres kg y medio de pastor",
    "dos kilos y medio de pastor", "2 kilos y medio de pastor", "2½ kilos de pastor", "2 ½ kg de pastor", "2 y medio kilos de pastor", "2 y ½ kilos de pastor", "3 y medio kilos de pastor",
    "2.5 kg de pastor", "3,5 kilos de pastor",
  ])("%s -> todas las presentaciones, ambiguo", async (q) => {
    const r = await buscarCompleto(q);
    expect(r.map((p) => p.name).sort(), q).toEqual(TODOS);
    expect(r.every((p) => p.ambiguo === true), q).toBe(true);
  });

  it("'cuatro cuartos' = 1 kg exacto; 'cinco cuartos' (1250 g) = presentaciones de hasta 1 kg, ambiguo", async () => {
    expect((await buscarCompleto("cuatro cuartos de pastor")).map((p) => [p.name, p.ambiguo === true])).toEqual([["Pastor — 1 kg", false]]);
    const r = await buscarCompleto("cinco cuartos de pastor");
    expect(r.map((p) => p.name).sort()).toEqual(["Pastor — 1 kg", "Pastor — 250 g", "Pastor — 500 g", "Pastor — 750 g"]);
    expect(r.every((p) => p.ambiguo === true)).toBe(true);
  });

  it.each([
    "1 kg y medio de pastor", "un kilo y medio de pastor", "kilo y medio de pastor", "1 y medio kilos de pastor", "1 y ½ kilos de pastor", "1½ kg de pastor", "1 1/2 kg de pastor", "1.5 kg de pastor",
  ])("%s -> Pastor 1.5 kg, sin ambiguo", async (q) => {
    const r = await buscarCompleto(q);
    expect(r.map((p) => [p.name, p.ambiguo === true])).toEqual([["Pastor — 1.5 kg", false]]);
  });

  it("lo mismo con bistec y arrachera: nunca 1.5 kg para '2 kg y medio'", async () => {
    for (const platillo of ["bistec", "arrachera", "bistec encebollado"]) {
      const r = await buscarCompleto(`2 kg y medio de ${platillo}`);
      expect(r.length, platillo).toBeGreaterThan(0);
      expect(r.every((p) => p.ambiguo === true), platillo).toBe(true);
    }
  });
});

describe("revision 3 de #505: parser de peso (peso-cantidad.ts)", () => {
  it.each([
    ["un medio kilo de pastor", ["Pastor — 500 g"]],
    ["un 1/2 kg de pastor", ["Pastor — 500 g"]],
    ["un 1/2 kilo de pastor", ["Pastor — 500 g"]],
    ["un ½ kilo de pastor", ["Pastor — 500 g"]],
    ["un medio kilo de bistec", BISTEC_500],
    ["0,25 kg de pastor", ["Pastor — 250 g"]],
    ["0,5 kg de pastor", ["Pastor — 500 g"]],
    ["0,75 kg de pastor", ["Pastor — 750 g"]],
    ["1.0 kg de pastor", ["Pastor — 1 kg"]],
    ["2.0 kilos de pastor", ["Pastor — 2 kg"]],
    ["dos medios kilos de pastor", ["Pastor — 1 kg"]],
    ["tres medios kilos de pastor", ["Pastor — 1.5 kg"]],
    ["cuatro cuartos de pastor", ["Pastor — 1 kg"]],
    ["medio kilo y medio de pastor", ["Pastor — 1 kg"]],
    ["medio kilo y un cuarto de pastor", ["Pastor — 750 g"]],
    ["2 kilos y 500 gramos de pastor", []],
  ])("%s", async (consulta, esperado) => {
    const r = await nombres(consulta);
    if (esperado.length === 0) {
      // 2.5 kg no existe: solo presentaciones de hasta 2 kg, ambiguo.
      const c = await buscarCompleto(consulta);
      expect(c.length).toBeGreaterThan(0);
      expect(c.every((p) => p.ambiguo === true && (pesoDeProductoEnGramos(p.name) ?? 0) <= 2500)).toBe(true);
    } else expect(r).toEqual(esperado);
  });

  it.each([
    ["0.3 kg de pastor", ["Pastor — 250 g"]],
    ["1.25 kg de pastor", ["Pastor — 1 kg", "Pastor — 250 g", "Pastor — 500 g", "Pastor — 750 g"]],
    ["1,25 kg de pastor", ["Pastor — 1 kg", "Pastor — 250 g", "Pastor — 500 g", "Pastor — 750 g"]],
    ["diez kilos de pastor", TODOS_LOS_PASTOR],
    ["seis kilos de pastor", TODOS_LOS_PASTOR],
    ["2.5 kg de pastor", TODOS_LOS_PASTOR],
  ])("%s -> solo presentaciones menores o iguales, todas ambiguo, nunca una mayor", async (consulta, esperado) => {
    const r = await buscarCompleto(consulta);
    expect(r.map((p) => p.name).sort()).toEqual([...esperado].sort());
    expect(r.every((p) => p.ambiguo === true)).toBe(true);
  });

  it("corpus del revisor (fixtures/consultas-de-peso-revision.json): exacta sin ambiguo, o ambiguo y nunca de mas peso", async () => {
    const corpus = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/consultas-de-peso-revision.json"), "utf8")) as Array<{ q: string; g: number | null }>;
    let comprobadas = 0;
    for (const { q, g } of corpus) {
      if (!g) continue;
      const r = await buscarCompleto(q);
      const pesos = r.map((p) => pesoDeProductoEnGramos(p.name)).filter((x): x is number => x !== null);
      if (pesos.length === 0) continue;
      comprobadas++;
      const exacta = pesos.every((x) => x === g);
      expect(exacta || (r.every((p) => p.ambiguo === true) && pesos.every((x) => x <= g)), `${q} (${g}) -> ${r.map((p) => p.name).join(" | ")}`).toBe(true);
    }
    expect(comprobadas).toBeGreaterThan(400);
  });
});
