// B06: cobertura medida de los sinonimos del piloto. Recorre los 436 pares producto-sinonimo del piloto original (todos APROBADOS: los 73 de
// sentido comun y web los aprobo Javier el 7-oct-2026) y verifica que `buscar_producto` encuentra el producto en CADA sucursal que lo vende.
// Tambien fija los casos que la ronda 2 mostro que el agente negaba (flautas, 1/4 kg de bistec, kilo de pastor, chela, cocacola) y documenta con
// `it.fails` las brechas conocidas del tokenizador (plural en -es, "cuarto kilo") sin tocar product-search.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { searchProducts } from "../src/orders.ts";
import { matchesProductSearch, tokenizeForProductSearch } from "../src/product-search.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(HERE, "fixtures/sinonimos-piloto-aprobados.json"), "utf8")) as { pares: Array<{ producto: string; sinonimo: string; origen: string }> };
const pendientes = JSON.parse(readFileSync(path.join(HERE, "../../../scripts/seed-pm-demo/data/sinonimos-y-faq-pendientes.json"), "utf8")) as { pares_sin_aprobar: unknown[]; brechas_conocidas_del_tokenizador: unknown[] };

const { data, agent } = loadSeedInputs();
const plan = buildPmSeedPlan(data, agent);
const mundo = buildInMemoryPmWorld(plan);
const SUCURSALES = ["prol-montejo", "fco-montejo", "pensiones", "garcia-lavin", "altabrisa", "playa"] as const;

/** Todo el conjunto que encuentra la busqueda (sin el tope de 8 resultados que ve el agente): ahi se mide si el sinonimo apunta al producto. */
async function coincidencias(consulta: string, slug: string): Promise<string[]> {
  const world = await mundo;
  const catalogo = await world.repo.listAvailableProductsForBranch(world.propertyBySlug.get(slug)!);
  const tokens = tokenizeForProductSearch(consulta);
  return catalogo.filter((p) => matchesProductSearch(tokens, { name: p.name, description: p.description, categoryName: p.categoryName, searchKeywords: p.searchKeywords })).map((p) => p.name);
}
async function buscar(consulta: string, slug = "garcia-lavin"): Promise<string[]> {
  const world = await mundo;
  return (await searchProducts(world.repo, { propertyId: world.propertyBySlug.get(slug)!, query: consulta })).map((p) => p.name);
}

describe("los 436 sinonimos aprobados del piloto", () => {
  it("el fixture trae los 436 pares y el origen de cada uno: 363 aprobados desde el inicio + los 73 que aprobo Javier (64 de sentido comun y 9 de la web)", () => {
    expect(fixture.pares.length).toBe(436);
    const porOrigen = (o: string) => fixture.pares.filter((x) => x.origen === o).length;
    expect(porOrigen("chats_c3") + porOrigen("derivado_nombre") + porOrigen("cuestionario_pm")).toBe(363);
    expect(porOrigen("sentido_comun_aprobado")).toBe(64);
    expect(porOrigen("cuestionario_web")).toBe(9);
    expect(porOrigen("sentido_comun_aprobado") + porOrigen("cuestionario_web")).toBe(73);
    expect(pendientes.pares_sin_aprobar).toEqual([]);
    // Sin texto de chats ni datos personales: son palabras de menu.
    expect(JSON.stringify(fixture)).not.toMatch(/@|\+52|\b\d{10}\b/);
  });

  it("buscar_producto encuentra el producto con cada sinonimo, en cada sucursal que lo vende", async () => {
    const world = await mundo;
    const catalogos = new Map<string, Set<string>>();
    for (const slug of SUCURSALES) catalogos.set(slug, new Set((await world.repo.listAvailableProductsForBranch(world.propertyBySlug.get(slug)!)).map((p) => p.name)));
    const fallas: string[] = [];
    let comprobados = 0;
    const venden = (producto: string) => SUCURSALES.filter((s) => catalogos.get(s)!.has(producto));
    for (const par of fixture.pares) {
      const sucursales = venden(par.producto);
      if (sucursales.length === 0) {
        fallas.push(`${par.producto} no se vende en ninguna sucursal con catalogo (${par.sinonimo})`);
        continue;
      }
      for (const slug of sucursales) {
        comprobados++;
        if (!(await coincidencias(par.sinonimo, slug)).includes(par.producto)) fallas.push(`[${slug}] "${par.sinonimo}" no encuentra "${par.producto}" (${par.origen})`);
      }
    }
    expect(fallas).toEqual([]);
    expect(comprobados).toBeGreaterThanOrEqual(436);
  });

  it("los sinonimos inequivocos (un solo producto de ese nombre) lo ponen entre los resultados que ve el agente (los 8 primeros)", async () => {
    const porSinonimo = new Map<string, Set<string>>();
    for (const par of fixture.pares) porSinonimo.set(par.sinonimo, (porSinonimo.get(par.sinonimo) ?? new Set()).add(par.producto));
    let unicos = 0;
    for (const par of fixture.pares) {
      if (porSinonimo.get(par.sinonimo)!.size !== 1) continue;
      for (const slug of ["prol-montejo", "garcia-lavin"]) {
        const world = await mundo;
        const vende = (await world.repo.listAvailableProductsForBranch(world.propertyBySlug.get(slug)!)).some((p) => p.name === par.producto);
        if (!vende) continue;
        const coinciden = await coincidencias(par.sinonimo, slug);
        // Si lo que coincide cabe en 8, el agente lo ve completo; si no, el sinonimo es una palabra generica que comparten varios productos.
        if (coinciden.length <= 8) {
          unicos++;
          expect(await buscar(par.sinonimo, slug), `[${slug}] ${par.sinonimo}`).toContain(par.producto);
        }
      }
    }
    expect(unicos).toBeGreaterThan(100);
  });
});

describe("casos que la ronda 2 (A10) mostro que el agente negaba", () => {
  it("flautas: en T7 (y T1) las encuentra, tambien en plural y con articulo", async () => {
    for (const slug of ["garcia-lavin", "prol-montejo"]) {
      for (const q of ["flautas", "unas flautas", "flauta"]) {
        const r = await buscar(q, slug);
        expect(r.length, `[${slug}] ${q}`).toBeGreaterThan(0);
        expect(r.every((n) => /^Flauta de /.test(n)), `[${slug}] ${q} -> ${r.join(" | ")}`).toBe(true);
      }
    }
    expect(await buscar("flautas", "garcia-lavin")).toEqual(expect.arrayContaining(["Flauta de Pastor", "Flauta de Bistec de Res"]));
  });

  it("1/4 kg de bistec, un cuarto de bistec y 1/4 de bistec piden exactamente 250 g de bistec (nunca el kilo ni la orden de tacos)", async () => {
    for (const q of ["1/4 kg de bistec", "un cuarto de bistec", "1/4 de bistec", "cuarto de kilo de bistec", "250 gramos de bistec"]) {
      const r = await buscar(q);
      expect(r, q).toEqual(["Bistec de Res — 250 g", "Bistec de Res Encebollado — 250 g"]);
    }
  });

  it("kilo de pastor / un kilo de pastor encuentran el pastor de 1 kg; medio kilo, el de 500 g", async () => {
    expect(await buscar("kilo de pastor")).toEqual(["Pastor — 1 kg"]);
    expect(await buscar("un kilo de pastor")).toEqual(["Pastor — 1 kg"]);
    expect(await buscar("medio kilo de pastor")).toEqual(["Pastor — 500 g"]);
    expect(await buscar("kilo y medio de pastor")).toEqual(["Pastor — 1.5 kg"]);
  });

  it("chela / chelas / dos chelas devuelven cervezas; cocacola (junta), cocacolas y coca cola devuelven la Coca-Cola", async () => {
    for (const q of ["chela", "chelas", "dos chelas", "cheve", "cerveza"]) {
      const r = await buscar(q);
      expect(r.length, q).toBeGreaterThan(0);
      expect(r.every((n) => /^(Sol|Superior|Heineken|Indio|XX|Amstel|Bohemia|Tecate|Ceiba|Patito|Ojo|Corona|Modelo|Victoria|Negra)/.test(n)), `${q} -> ${r.join(" | ")}`).toBe(true);
    }
    for (const q of ["cocacola", "cocacolas", "coca cola", "una coca"]) expect((await buscar(q)).every((n) => /^Coca-Cola/.test(n)), q).toBe(true);
    expect(await buscar("cocacola")).toContain("Coca-Cola");
  });

  it("sigue sin inventar: lo que no esta en el menu devuelve vacio y los ambiguos siguen siendo varios platillos", async () => {
    for (const q of ["sushi", "chipotle", "longaniza", "chistorra", "dedos de queso", "BBQ", "salchichas"]) expect(await buscar(q), q).toEqual([]);
    expect((await buscar("frijol")).length).toBeGreaterThan(1);
    expect((await buscar("alambre")).length).toBeGreaterThan(1);
  });
});

describe("brechas conocidas del tokenizador (documentadas, no arregladas aqui: product-search.ts es codigo compartido)", () => {
  it("quedan listadas en sinonimos-y-faq-pendientes.json", () => {
    expect(pendientes.brechas_conocidas_del_tokenizador.length).toBe(3);
  });

  // `it.fails` pasa mientras la brecha exista y FALLA cuando alguien la arregle: ese dia hay que convertirlo en `it` normal y quitarlo de los pendientes.
  it.fails("plural en -es: 'flanes' encuentra 'Flan' (hoy el tokenizador solo quita la s final: 'flane')", async () => {
    expect(await coincidencias("flanes", "prol-montejo")).toContain("Flan");
  });

  it.fails("plural en -es: 'normales' encuentra 'Frijoles Charros Normal' (hoy queda 'normale')", async () => {
    expect(await coincidencias("frijoles charros normales", "prol-montejo")).toContain("Frijoles Charros Normal");
  });

  it.fails("'una cerveza' (todas sus palabras son stopwords) encuentra cervezas, aunque 'cerveza' sola si (hoy el respaldo busca la frase entera)", async () => {
    expect((await buscar("una cerveza")).length).toBeGreaterThan(0);
  });

  it.fails("'cuarto kilo de bistec' (sin 'de') pide 250 g (hoy lo lee como 1 kg y suma 'cuarto')", async () => {
    expect(await buscar("cuarto kilo de bistec")).toEqual(["Bistec de Res — 250 g", "Bistec de Res Encebollado — 250 g"]);
  });

  it("lo que SI cubre: plural con s final (tacos, flautas, chelas, papas, quesadillas) y 'frijoles' por alias", async () => {
    expect(tokenizeForProductSearch("tacos flautas chelas papas quesadillas")).toEqual(["taco", "flauta", "chela", "papa", "quesadilla"]);
    expect(await buscar("frijoles")).toContain("Frijol con Tostada");
  });
});
