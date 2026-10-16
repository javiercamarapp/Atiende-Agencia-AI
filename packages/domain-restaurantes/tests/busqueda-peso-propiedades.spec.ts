// Prueba de propiedad del parser de peso (peso-cantidad.ts): frases armadas desde la gramatica con gramos de verdad conocidos, generador determinista (semilla fija),
// contra 3 platillos del catalogo real de PM. Invariantes de dinero: nunca una candidata de mas peso/precio que lo pedido, nunca una menor sola sin `ambiguo`,
// y singular/plural/mayusculas dan el mismo resultado.
import { describe, expect, it } from "vitest";
import { searchProducts } from "../src/orders.ts";
import { pesoDeProductoEnGramos } from "../src/product-search.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
const mundo = buildInMemoryPmWorld(buildPmSeedPlan(data, agent));
const PLATILLOS = ["pastor", "bistec", "arrachera"] as const;
const PRESENTACIONES = new Set([250, 500, 750, 1000, 1500, 2000]);

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const NUM_PALABRA: ReadonlyArray<readonly [string, number]> = [["un", 1], ["dos", 2], ["tres", 3], ["cuatro", 4], ["cinco", 5], ["seis", 6], ["siete", 7], ["ocho", 8], ["nueve", 9], ["diez", 10]];

interface Frase {
  readonly texto: string;
  readonly gramos: number;
  /** Misma frase con la unidad en la otra forma (kilo/kilos, gramo/gramos), si la tiene. */
  readonly variante?: string;
}

function generar(rnd: () => number): Frase {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const n = 1 + Math.floor(rnd() * 10); // 1..10
  const palabra = NUM_PALABRA[n - 1]![0];
  const numero = rnd() < 0.5 ? String(n) : palabra;
  const kilos = (k: number) => (k === 1 ? "kilo" : "kilos");
  const kg = pick(["kg", "kilo", "kilos", "kilogramos"]);
  const sep = () => pick(["", " "]);
  switch (Math.floor(rnd() * 14)) {
    case 0: return { texto: `${numero} ${kilos(n)}`, gramos: n * 1000, variante: `${numero} ${n === 1 ? "kilos" : "kilo"}` };
    case 1: return { texto: `${n}${sep()}kg`, gramos: n * 1000 };
    case 2: return { texto: pick(["cuarto kilo", "un cuarto kilo", "cuarto de kilo", "un cuarto de kilo", "1/4 kg", "1/4 de kilo", "¼ kilo", "0.25 kg", "0,25 kg", "250 gramos", "250g", "250 gr"]), gramos: 250 };
    case 3: return { texto: pick(["medio kilo", "un medio kilo", "medio kg", "1/2 kg", "1/2 kilo", "½ kilo", "un ½ kilo", "un 1/2 kilo", "0.5 kg", "0,5 kg", "500 gramos", "500g", "500 grs"]), gramos: 500 };
    case 4: return { texto: pick(["tres cuartos", "tres cuartos de kilo", "3/4 kg", "¾ de kilo", "0.75 kg", "0,75 kg", "750 gramos", "750g"]), gramos: 750 };
    case 5: return { texto: pick(["kilo y medio", "un kilo y medio", "1 kg y medio", "1 y medio kilos", "1 y ½ kilos", "1½ kg", "1 1/2 kg", "1.5 kg", "1,5 kilos", "1500 gramos", "dos medios kilos y medio"]), gramos: 1500 };
    case 6: return { texto: `${numero} ${kg} y medio`, gramos: n * 1000 + 500 };
    case 7: return { texto: `${n === 1 ? "1" : numero} y medio ${kilos(2)}`, gramos: n * 1000 + 500 };
    case 8: return { texto: `${n}${pick([" ½", "½", " 1/2", " y ½"])} kg`, gramos: n * 1000 + 500 };
    case 9: return { texto: `${numero} ${kg} y cuarto`, gramos: n * 1000 + 250 };
    case 10: { const g = 100 + Math.floor(rnd() * 240) * 10; return { texto: `${g} ${pick(["gramos", "gr", "grs", "g"])}`, gramos: g }; }
    case 11: { const d = pick([0.3, 0.4, 0.6, 0.7, 0.8, 0.9, 1.25, 1.75, 2.5, 3.5, 1.1]); const t = String(d); return { texto: `${rnd() < 0.5 ? t : t.replace(".", ",")} kg`, gramos: Math.round(d * 1000) }; }
    case 12: { const g = pick([100, 200, 400, 500]); return { texto: `${numero} ${kilos(n)} y ${g} gramos`, gramos: n * 1000 + g, variante: `${numero} ${n === 1 ? "kilos" : "kilo"} y ${g} gramos` }; }
    default: return { texto: pick(["cuatro cuartos", "cinco cuartos", "seis cuartos", "dos cuartos", "medio kilo y medio", "medio kilo y un cuarto", "dos medios kilos", "tres medios kilos"]), gramos: 0 };
  }
}
/** Gramos de las frases fijas del ultimo caso (su verdad no depende del azar). */
const FIJAS: Readonly<Record<string, number>> = { "cuatro cuartos": 1000, "cinco cuartos": 1250, "seis cuartos": 1500, "dos cuartos": 500, "medio kilo y medio": 1000, "medio kilo y un cuarto": 750, "dos medios kilos": 1000, "tres medios kilos": 1500 };
const verdad = (f: Frase) => (f.gramos > 0 ? f.gramos : FIJAS[f.texto]!);

describe("propiedad: parser de peso contra el catalogo real (3 platillos, semilla fija)", () => {
  it("2400 frases x 3 platillos: nunca mas peso ni mas precio que lo pedido; exacto sin ambiguo; si no hay presentacion, todo ambiguo; unidad singular/plural y mayusculas dan lo mismo", async () => {
    const world = await mundo;
    const propertyId = world.propertyBySlug.get("garcia-lavin")!;
    const buscar = async (q: string) => searchProducts(world.repo, { propertyId, query: q });
    const rnd = mulberry32(20261007);
    const prefijos = ["", "", "dame ", "quiero ", "ponme ", "un "];
    let casos = 0;
    let exactas = 0;
    let ambiguas = 0;
    for (let i = 0; i < 2400; i++) {
      const f = generar(rnd);
      const g = verdad(f);
      const prefijo = prefijos[Math.floor(rnd() * prefijos.length)]!;
      for (const platillo of PLATILLOS) {
        const consulta = `${prefijo === "un " ? "" : prefijo}${f.texto} de ${platillo}`;
        const r = await buscar(consulta);
        casos++;
        const conPeso = r.filter((p) => pesoDeProductoEnGramos(p.name) !== null);
        const ctx = `${consulta} (${g} g) -> ${r.map((p) => `${p.name}${p.ambiguo ? "[A]" : ""}`).join(" | ")}`;
        for (const p of conPeso) {
          const pg = pesoDeProductoEnGramos(p.name)!;
          expect(pg, ctx).toBeLessThanOrEqual(g);
        }
        if (PRESENTACIONES.has(g)) {
          // Exacta: solo esa presentacion, sin ambiguo.
          expect(conPeso.length, ctx).toBeGreaterThan(0);
          expect(conPeso.every((p) => pesoDeProductoEnGramos(p.name) === g), ctx).toBe(true);
          expect(r.every((p) => p.ambiguo !== true), ctx).toBe(true);
          exactas++;
        } else if (r.length > 0) {
          // Sin presentacion de ese peso: nada se elige en silencio.
          expect(r.every((p) => p.ambiguo === true), ctx).toBe(true);
          ambiguas++;
        }
        // Precio: nunca mas caro que el kilo de ese platillo prorrateado a lo pedido.
        const porKg = Math.max(0, ...r.filter((p) => pesoDeProductoEnGramos(p.name) !== null).map((p) => (p.price / pesoDeProductoEnGramos(p.name)!) * 1000));
        for (const p of conPeso) expect(p.price, ctx).toBeLessThanOrEqual((porKg * g) / 1000 + 0.01);
        // Mayusculas y plural/singular de la unidad no cambian el resultado.
        if (i % 4 === 0) {
          expect((await buscar(consulta.toUpperCase())).map((p) => p.name), consulta).toEqual(r.map((p) => p.name));
          if (f.variante) expect((await buscar(`${prefijo === "un " ? "" : prefijo}${f.variante} de ${platillo}`)).map((p) => p.name), consulta).toEqual(r.map((p) => p.name));
        }
      }
    }
    expect(casos).toBe(7200);
    expect(exactas).toBeGreaterThan(1500);
    expect(ambiguas).toBeGreaterThan(1500);
  }, 120000);
});
