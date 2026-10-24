// Menú público de PM (lostaquitosdepm.com, capturado el 15-oct-2026): las imágenes COMPLETAS de cada página (9 u 8 por sucursal, no 3) contra el seed y el menú del arnés.
// Deterministas (sin LLM, sin red, sin base real). Solo se afirma lo que las imágenes dicen; lo que no dicen queda como pendiente explícito (ver docs/demo-pm/menu-en-linea/README.md).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildOrderQuoteFromProducts } from "../src/order-quote.ts";
import { extraerPackSize } from "../src/product-search.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import type { ProductoEncontrado } from "../src/types.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(AQUI, "../../..");
const DIR = path.join(RAIZ, "docs/demo-pm/menu-en-linea");
const leerJson = <T>(ruta: string): T => JSON.parse(readFileSync(ruta, "utf8")) as T;
const leer = <T>(archivo: string): T => leerJson<T>(path.join(DIR, archivo));

interface Presentacion { etiqueta: string; precio_mxn: number; tipo?: string; seed_nombre?: string | null; seed_nombres?: string[] }
interface Producto { imagen: number; categoria: string; categoria_canonica: string; nombre: string; presentaciones: Presentacion[]; piezas_por_orden: number | null; cita_piezas: string | null }
interface Pagina {
  version: number;
  sucursal: { slug_pagina: string; slugs_seed: string[] };
  fuente: { sitio: string; pagina: string; capturado: string };
  imagenes: Array<{ n: number; url_original: string; sha256: string; ancho: number; alto: number }>;
  productos: Producto[];
  promociones: Array<{ dia: string; precio_mxn: number | null; aplica_domicilio: boolean }>;
  no_aparece_en_las_imagenes: Record<string, unknown>;
}
interface Manifiesto { pdfs: Array<{ archivo: string; slug_pagina: string; paginas: number; sha256: string; bytes: number; pagina_fuente: string; fecha_captura: string; imagenes_de_origen: Array<{ n: number; sha256: string; url_original: string; incrustada_sin_recomprimir: boolean }> }> }

const PAGINAS = ["montejo-altabrisa-victory", "playa", "fco-montejo", "pensiones", "galerias"] as const;
type Slug = (typeof PAGINAS)[number];
const IMAGENES: Record<Slug, number> = { "montejo-altabrisa-victory": 9, playa: 8, "fco-montejo": 9, pensiones: 8, galerias: 9 };
const RENGLONES: Record<Slug, number> = { "montejo-altabrisa-victory": 236, playa: 223, "fco-montejo": 221, pensiones: 210, galerias: 164 };
const SUCURSAL_SEED: Record<Slug, string> = { "montejo-altabrisa-victory": "T1", playa: "T5", "fco-montejo": "T2", pensiones: "T3", galerias: "T1" };
const paginas = Object.fromEntries(PAGINAS.map((s) => [s, leer<Pagina>(`${s}.json`)])) as Record<Slug, Pagina>;
const manifiesto = leer<Manifiesto>("manifiesto-pdf.json");

const { data, agent } = loadSeedInputs();
const mundo = buildInMemoryPmWorld(buildPmSeedPlan(data, agent));
const seedPorNombre = new Map(data.productos.map((p) => [p.nombre, p]));
const MENU_EVALS = leerJson<{ productos: Array<{ nombre: string; pack_size: number }> }>(path.join(RAIZ, "packages/domain-restaurantes/src/evals/agente-pm/menu-pm.json"));
const renglones = (p: Pagina) => p.productos.flatMap((prod) => prod.presentaciones.map((pr) => ({ prod, pr })));
const nombresSeed = (pr: Presentacion): string[] => pr.seed_nombres ?? (pr.seed_nombre ? [pr.seed_nombre] : []);

interface Hallado { id: string; name: string; price: number; pack_size: number | null; unidad_de_venta?: string }
const buscar = async (query: string, branch = "garcia-lavin"): Promise<Hallado[]> => {
  const w = await mundo;
  return (await invokeAgentTool(w.repo, { organizationId: w.organizationId, channel: "whatsapp", phone: "9991234567" }, "buscar_producto", { query, branch_slug: branch })).result as Hallado[];
};
const exacto = async (nombre: string): Promise<ProductoEncontrado> => {
  const h = (await buscar(nombre)).find((p) => p.name === nombre);
  if (!h) throw new Error(`no está en el catálogo de garcia-lavin: ${nombre}`);
  return { id: h.id, name: h.name, price: h.price, packSize: h.pack_size, requiresAdultConfirmation: false };
};

describe("JSON por página: forma, trazabilidad y nada inventado", () => {
  it.each(PAGINAS)("%s: URL fuente, fecha, todas sus imágenes con SHA256 y precios válidos", (slug) => {
    const p = paginas[slug];
    expect(p.fuente.sitio).toBe("https://www.lostaquitosdepm.com");
    expect(p.fuente.pagina.startsWith("https://www.lostaquitosdepm.com/")).toBe(true);
    expect(p.fuente.capturado).toBe("2026-10-15");
    expect(p.imagenes).toHaveLength(IMAGENES[slug]);
    for (const im of p.imagenes) {
      expect(im.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(im.url_original).toMatch(/^https:\/\/static\.wixstatic\.com\/media\/.+~mv2\.jpe?g$/);
      expect([im.ancho, im.alto]).toEqual([2550, 3300]);
    }
    expect(new Set(p.imagenes.map((i) => i.sha256)).size).toBe(p.imagenes.length);
    expect(renglones(p)).toHaveLength(RENGLONES[slug]);
    for (const { prod, pr } of renglones(p)) expect(Number.isFinite(pr.precio_mxn) && pr.precio_mxn > 0, `${prod.nombre} ${pr.etiqueta}`).toBe(true);
    for (const prod of p.productos) {
      expect(prod.imagen).toBeGreaterThanOrEqual(1);
      expect(prod.imagen).toBeLessThanOrEqual(IMAGENES[slug]);
    }
  });

  it.each(PAGINAS)("%s: horarios por producto, agotados, mínimo de compra y costo de envío NO aparecen en las imágenes (null; no se inventan)", (slug) => {
    const v = paginas[slug].no_aparece_en_las_imagenes;
    for (const k of ["horarios_por_producto", "agotados", "solo_fin_de_semana", "limites_de_cantidad", "minimo_de_compra", "costo_de_envio"]) expect(v[k], k).toBeNull();
    expect(v.combos_aparte_de_la_promo_del_martes).toEqual([]);
  });

  it("ningún binario en el repo: solo JSON y markdown en docs/demo-pm/menu-en-linea", () => {
    for (const f of readdirSync(DIR)) expect(f, f).toMatch(/\.(json|md)$/);
  });
});

describe("manifiesto de PDF (sin binarios)", () => {
  it("7 PDF (5 páginas en español + 2 en inglés), una imagen por página, SHA256 del PDF y de cada imagen de origen, incrustadas sin recomprimir", () => {
    expect(manifiesto.pdfs.map((p) => p.archivo).sort()).toEqual(
      ["menu-english-chicxulub.pdf", "menu-english-menu.pdf", "menu-fco-montejo.pdf", "menu-galerias.pdf", "menu-montejo-altabrisa-victory.pdf", "menu-pensiones.pdf", "menu-playa.pdf"],
    );
    for (const pdf of manifiesto.pdfs) {
      expect(pdf.sha256, pdf.archivo).toMatch(/^[0-9a-f]{64}$/);
      expect(pdf.bytes).toBeGreaterThan(1_000_000);
      expect(pdf.fecha_captura).toBe("2026-10-15");
      expect(pdf.paginas, pdf.archivo).toBe(pdf.imagenes_de_origen.length);
      for (const im of pdf.imagenes_de_origen) {
        expect(im.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(im.incrustada_sin_recomprimir, `${pdf.archivo} imagen ${im.n}`).toBe(true);
      }
    }
  });

  it.each(PAGINAS)("%s: las imágenes del manifiesto son exactamente las del JSON de la página", (slug) => {
    const pdf = manifiesto.pdfs.find((p) => p.slug_pagina === slug)!;
    expect(pdf.pagina_fuente).toBe(paginas[slug].fuente.pagina);
    expect(pdf.imagenes_de_origen.map((i) => [i.n, i.sha256, i.url_original])).toEqual(paginas[slug].imagenes.map((i) => [i.n, i.sha256, i.url_original]));
  });

  it("si el PDF de un clon local existe, su SHA256 coincide con el manifiesto (se omite en CI, donde no hay binarios)", async () => {
    const { createHash } = await import("node:crypto");
    const carpeta = path.join(homedir(), "atiende-loop/work/pm-menus-pdf");
    for (const pdf of manifiesto.pdfs) {
      const ruta = path.join(carpeta, pdf.archivo);
      if (!existsSync(ruta)) continue;
      expect(createHash("sha256").update(readFileSync(ruta)).digest("hex"), pdf.archivo).toBe(pdf.sha256);
    }
  });
});

describe("precios publicados contra el seed", () => {
  it.each(["montejo-altabrisa-victory", "fco-montejo", "galerias"] as const)("%s: cada precio publicado es el de la lista T1-2026 del seed", (slug) => {
    const sucursales = slug === "montejo-altabrisa-victory" ? ["T1", "T7", "T8"] : [SUCURSAL_SEED[slug]];
    let comparados = 0;
    const soloWeb: string[] = [];
    for (const { prod, pr } of renglones(paginas[slug])) {
      if (pr.tipo === "suplemento") continue; // «Café con leche +$11» no es un precio de producto
      const nombres = nombresSeed(pr);
      expect(nombres.length, `${prod.nombre} ${pr.etiqueta} sin producto de seed`).toBeGreaterThan(0);
      for (const nombre of nombres) {
        const sp = seedPorNombre.get(nombre);
        expect(sp, `${nombre} no está en el seed`).toBeDefined();
        for (const suc of sucursales) {
          const precioSeed = sp!.precios_por_sucursal?.[suc];
          if (precioSeed === undefined && slug !== "galerias") { soloWeb.push(nombre); continue; } // en la imagen pero sin precio en esa sucursal del seed
          // T4 (Galerías) no tiene catálogo propio en el seed: se compara con la lista T1
          expect(precioSeed ?? sp!.precios_por_sucursal?.T1, `${nombre} en ${suc}`).toBe(pr.precio_mxn);
          comparados += 1;
        }
      }
    }
    // Heineken Silver sale a $90 en la imagen de Francisco de Montejo y el seed solo la carga en T5 (hallazgo; no se toca el seed)
    expect(soloWeb).toEqual(slug === "fco-montejo" ? ["Heineken Silver"] : []);
    expect(comparados).toBeGreaterThan(150);
  });

  it("Playa (T5): todo igual al seed salvo Agua Mineral Cristal 300 ml, que la imagen imprime a $50 y el seed (impreso T5-2026 y lista T1) a $53", () => {
    const difs: string[] = [];
    for (const { prod, pr } of renglones(paginas.playa)) {
      if (pr.tipo === "suplemento") continue;
      for (const nombre of nombresSeed(pr)) {
        const precio = seedPorNombre.get(nombre)!.precios_por_sucursal?.T5;
        if (precio !== pr.precio_mxn) difs.push(`${nombre}: web ${pr.precio_mxn}, seed T5 ${String(precio)} (${prod.nombre})`);
      }
    }
    expect(difs).toHaveLength(1);
    expect(difs[0]).toMatch(/^Agua Mineral Cristal: web 50, seed T5 53/);
    expect(seedPorNombre.get("Agua Mineral Cristal")!.precios_por_sucursal?.T5).toBe(53);
  });

  it("DIFERENCIA REAL: Pensiones sigue publicando la lista 2025 (T3-2025): ningún precio coincide con el T3 del seed (lista T1-2026, corrección CR01/CR02) y todos son menores", () => {
    let comparados = 0;
    for (const { pr } of renglones(paginas.pensiones)) {
      const nombres = nombresSeed(pr);
      if (nombres.length !== 1) continue; // «Rajas o champiñones $32» une dos productos del seed
      const precioSeed = seedPorNombre.get(nombres[0]!)!.precios_por_sucursal?.T3;
      if (precioSeed === undefined) continue;
      expect(pr.precio_mxn, nombres[0]).toBeLessThan(precioSeed);
      comparados += 1;
    }
    expect(comparados).toBeGreaterThan(190);
    const frijol = paginas.pensiones.productos.find((p) => /frijol con tostada/i.test(p.nombre))!;
    expect(frijol.presentaciones[0]!.precio_mxn).toBe(83);
    expect(seedPorNombre.get("Frijol con Tostada")!.precios_por_sucursal?.T3).toBe(93);
  });

  it("la lista de Pensiones es la impresa de 2025 que ya estaba en el repo (menus-impresos/T3-2025.json): mismo conjunto de precios por categoría", () => {
    const impreso = leerJson<{ categorias: Array<{ items: Array<{ precio_mxn: number }> }> }>(path.join(RAIZ, "scripts/seed-pm-demo/data/menus-impresos/T3-2025.json"));
    const impresos = impreso.categorias.flatMap((c) => c.items.map((i) => i.precio_mxn)).sort((a, b) => a - b);
    const web = renglones(paginas.pensiones).map(({ pr }) => pr.precio_mxn).sort((a, b) => a - b);
    // el impreso separa Rajas ($32) y Champiñones ($32); la web los une en un renglón, y el impreso trae un precio de «vino tinto» más
    const faltan = impresos.filter((x) => !web.includes(x));
    expect(faltan.length).toBeLessThanOrEqual(2);
    expect(web.length).toBeGreaterThanOrEqual(impresos.length - 3);
  });
});

describe("qué se vende en cada página frente al seed (lo que las imágenes SÍ muestran)", () => {
  const nombresDe = (slug: Slug) => new Set(renglones(paginas[slug]).flatMap(({ pr }) => nombresSeed(pr)));

  it("flautas y comida regional solo aparecen en la página Montejo/García Lavín/Altabrisa; el seed solo les da precio en T1, T7 y T8 (coincide)", () => {
    const flautas = data.productos.filter((p) => /^Flauta /.test(p.nombre));
    expect(flautas).toHaveLength(7);
    for (const f of flautas) expect(Object.keys(f.precios_por_sucursal ?? {}).sort(), f.nombre).toEqual(["T1", "T7", "T8"]);
    const enM = nombresDe("montejo-altabrisa-victory");
    for (const f of flautas) expect(enM.has(f.nombre), f.nombre).toBe(true);
    for (const slug of ["playa", "fco-montejo", "pensiones"] as const) for (const f of flautas) expect(nombresDe(slug).has(f.nombre), `${slug} ${f.nombre}`).toBe(false);
    expect(nombresDe("galerias").has("Papadzules (orden de 5)")).toBe(true);
    expect(nombresDe("galerias").has("Codzitos (orden de 4)")).toBe(false);
  });

  it("DIVERGENCIA CON EL SEED (decide el dueño, P10): Ensalada de PM, Jericallas y Café tienen precio en T2 y T3 del seed pero NO salen en las imágenes de Francisco de Montejo ni de Pensiones; Quesobich y Heineken 0.0 tampoco salen en Pensiones", () => {
    for (const nombre of ["Ensalada de PM", "Jericallas", "Café"]) {
      expect(Object.keys(seedPorNombre.get(nombre)!.precios_por_sucursal ?? {}), nombre).toEqual(expect.arrayContaining(["T2", "T3"]));
      expect(nombresDe("fco-montejo").has(nombre), `fco ${nombre}`).toBe(false);
      expect(nombresDe("pensiones").has(nombre), `pensiones ${nombre}`).toBe(false);
    }
    expect(nombresDe("pensiones").has("Quesobich de Pastor")).toBe(false);
    expect(nombresDe("fco-montejo").has("Quesobich de Pastor")).toBe(true);
    expect(nombresDe("pensiones").has("Heineken 0.0")).toBe(false);
  });

  it("Playa no vende Sprite en la imagen y el seed tampoco le da precio en T5 (coincide); Heineken Silver solo sale en Playa y en Francisco de Montejo", () => {
    expect(seedPorNombre.get("Sprite")!.precios_por_sucursal?.T5).toBeUndefined();
    expect(nombresDe("playa").has("Sprite")).toBe(false);
    expect(nombresDe("playa").has("Heineken Silver")).toBe(true);
    expect(nombresDe("fco-montejo").has("Heineken Silver")).toBe(true);
  });

  it("Galerías no publica licores, cervezas, cocktails ni postres (menú reducido); aun así sí publica comida regional", () => {
    const g = paginas.galerias.productos.map((p) => p.categoria_canonica);
    for (const c of ["licores", "cervezas", "cocktails", "postres"]) expect(g.includes(c), c).toBe(false);
    expect(g.includes("comida regional")).toBe(true);
  });
});

describe("promociones: lo que dice la imagen (3 sucursales, sin domicilio) frente al seed (todas, solo recoger)", () => {
  it("lunes 2x1 en tacos al pastor y martes nachos al pastor + 2 aguas: $328 en Francisco de Montejo y Galerías, $278 en Pensiones; ninguna aplica a domicilio; Montejo/García Lavín/Altabrisa/Chicxulub no traen promo", () => {
    for (const [slug, precio] of [["fco-montejo", 328], ["galerias", 328], ["pensiones", 278]] as const) {
      const promos = paginas[slug].promociones;
      expect(promos.map((p) => p.dia)).toEqual(["lunes", "martes"]);
      expect(promos.find((p) => p.dia === "martes")!.precio_mxn).toBe(precio);
      expect(promos.every((p) => p.aplica_domicilio === false)).toBe(true);
    }
    expect(paginas["montejo-altabrisa-victory"].promociones).toEqual([]);
    expect(paginas.playa.promociones).toEqual([]);
  });

  it("el seed carga el martes como combo con nachos de pastor; el precio que paga el cliente sale del precio de los nachos de cada sucursal (T3 en la lista 2025 serían $278 en la imagen, $328 en el seed)", () => {
    const nachos = seedPorNombre.get("Nachos de Pastor")!;
    expect(nachos.precios_por_sucursal?.T2).toBe(328);
    expect(nachos.precios_por_sucursal?.T3).toBe(328);
    const enPensiones = paginas.pensiones.productos.find((p) => /pastor/i.test(p.nombre) && p.categoria_canonica === "nachos")!;
    expect(enPensiones.presentaciones.find((p) => /orden/i.test(p.etiqueta) && !/media|1\/2/i.test(p.etiqueta))!.precio_mxn).toBe(278);
  });
});

describe("piezas por orden: lo que las imágenes confirman es lo que el servidor deriva del seed", () => {
  it("cada categoría con encabezado «las órdenes son de N tacos» tiene el mismo N en todos sus productos del JSON y en el pack_size que el servidor deriva del seed", () => {
    const porCategoria = new Map<string, { piezas: Set<number | null>; nombresSeed: Set<string> }>();
    for (const slug of PAGINAS) {
      for (const prod of paginas[slug].productos) {
        const e = porCategoria.get(prod.categoria_canonica) ?? { piezas: new Set<number | null>(), nombresSeed: new Set<string>() };
        e.piezas.add(prod.piezas_por_orden);
        for (const pr of prod.presentaciones) for (const n of nombresSeed(pr)) e.nombresSeed.add(n);
        porCategoria.set(prod.categoria_canonica, e);
      }
    }
    const ESPERADO: ReadonlyArray<readonly [string, number]> = [
      ["tacos individuales", 1], ["tacos (orden de 3)", 3], ["gringas (orden de 2)", 2], ["mestizas (orden de 2)", 2], ["alambre (orden de 5)", 5], ["tacos suizos (orden de 5)", 5],
    ];
    for (const [categoria, piezas] of ESPERADO) {
      const e = porCategoria.get(categoria)!;
      // los tres individuales de Galerías van en la sección «Tacos» y llevan 1: se separan por nombre
      const soloEsta = [...e.piezas].filter((x) => x !== null);
      expect(soloEsta.length > 0, categoria).toBe(true);
      for (const nombre of e.nombresSeed) {
        const sp = seedPorNombre.get(nombre)!;
        const derivado = extraerPackSize(sp.nombre, sp.descripcion ?? null);
        const esperado = /individual/i.test(nombre) ? 1 : piezas;
        expect(derivado, `${nombre} (${categoria})`).toBe(esperado);
      }
    }
    expect(porCategoria.get("tacos suizos (orden de 5)")!.nombresSeed.size).toBe(17);
  });

  it("papadzules 5, codzitos 4 y tacos de cochinita 4 (leyendas ORD.N de la imagen) = pack_size del seed", () => {
    for (const [nombre, piezas] of [["Papadzules (orden de 5)", 5], ["Codzitos (orden de 4)", 4], ["Tacos de Cochinita (orden de 4)", 4]] as const) {
      const sp = seedPorNombre.get(nombre)!;
      expect(extraerPackSize(sp.nombre, sp.descripcion ?? null), nombre).toBe(piezas);
    }
  });

  it("CAMBIO EN EL SEED: Alambre suizo (6) y Tacos suizos de chile poblano y bistec/arrachera (2) caen bajo «las órdenes son de 5 tacos»: buscar_producto ya devuelve pack_size 5", async () => {
    for (const q of ["Alambre Suizo de Pastor", "Alambre Suizo de Bistec", "Alambre Suizo de Pechuga", "Alambre Suizo de Chuleta", "Alambre Suizo de Costilla", "Alambre Suizo de Arrachera", "Tacos Suizos de Chile Poblano y Bistec", "Tacos Suizos de Chile Poblano y Arrachera", "Suizo de Pastor"]) {
      const h = (await buscar(q)).find((p) => p.name === q);
      expect(h?.pack_size, q).toBe(5);
    }
    const alambreSuizo = await exacto("Alambre Suizo de Pastor");
    expect(buildOrderQuoteFromProducts([{ productId: alambreSuizo.id, requestedQuantity: 10, tortilla: "maiz" }], [alambreSuizo]).total).toBe(612);
    expect(() => buildOrderQuoteFromProducts([{ productId: alambreSuizo.id, requestedQuantity: 3, tortilla: "maiz" }], [alambreSuizo])).toThrow(/órdenes de 5 piezas/);
  });

  it("las piezas que ninguna imagen imprime siguen null en el JSON (flautas, alitas, crujientes, quesadillas); el seed solo carga pack_size 1 en flautas (decisión de Javier 16-oct) y NO inventa el de alitas ni crujientes", async () => {
    for (const slug of PAGINAS) {
      for (const prod of paginas[slug].productos) {
        if (/flauta|alitas|crujientes|quesadilla|chicharr/i.test(prod.nombre) || prod.categoria_canonica === "flautas de pm") expect(prod.piezas_por_orden, `${slug} ${prod.nombre}`).toBeNull();
      }
    }
    for (const q of ["Alitas de Pollo", "Crujientes de Pechuga de Pollo"]) {
      const h = (await buscar(q))[0]!;
      expect(h.pack_size, q).toBeNull();
      expect(h.unidad_de_venta, q).toMatch(/ORDEN/);
    }
    // Flautas: la IMAGEN no dice el número, lo confirmó Javier: una orden = UNA flauta grande
    const flauta = (await buscar("Flauta de Pechuga"))[0]!;
    expect(flauta.pack_size).toBe(1);
    expect(flauta.unidad_de_venta).toMatch(/Cada ORDEN de flautas es UNA flauta grande/);
    // Quesadillas: la imagen solo dice «de maíz o harina»; el «orden de 3» del seed es decisión de Javier (P11), no una lectura de la imagen
    const q = (await buscar("Quesadilla de Natural")).find((p) => p.name === "Quesadilla de Natural");
    expect(q?.pack_size).toBe(3);
  });

  it("ALINEADO (decisión del dueño, 23-oct): menu-pm.json trae pack_size 2 en gringas y mestizas y 5 en alambre y los 17 suizos, como dicen las imágenes", () => {
    const pack = new Map(MENU_EVALS.productos.map((p) => [p.nombre, p.pack_size]));
    for (const p of data.productos) {
      if (/^(Gringa|Mestiza)/.test(p.nombre)) expect(pack.get(p.nombre), p.nombre).toBe(2);
      if (/^(Alambre de|Suizo de|Alambre Suizo|Tacos Suizos)/.test(p.nombre)) expect(pack.get(p.nombre), p.nombre).toBe(5);
    }
    expect([...pack.keys()].filter((n) => /^(Gringa|Mestiza|Alambre de|Suizo de|Alambre Suizo|Tacos Suizos)/.test(n))).toHaveLength(7 + 7 + 6 + 9 + 6 + 2);
  });
});

describe("T7-031 con el catálogo real: «una orden de flautas» es UNA flauta grande", () => {
  it("1 kg de bistec ($1,100) + 500 g de pastor ($450) + 1 orden de flautas de pechuga ($283) = $1,833", async () => {
    const bistec = await exacto("Bistec de Res — 1 kg");
    const pastor = await exacto("Pastor — 500 g");
    const flauta = await exacto("Flauta de Pechuga");
    expect([bistec.price, pastor.price, flauta.price]).toEqual([1100, 450, 283]);
    const q = buildOrderQuoteFromProducts([{ productId: bistec.id, requestedQuantity: 1 }, { productId: pastor.id, requestedQuantity: 1 }, { productId: flauta.id, requestedQuantity: 1 }], [bistec, pastor, flauta]);
    expect(q.total).toBe(1833);
    // pack_size 1: «4 flautas» son 4 órdenes ($1,132), no 1
    expect(flauta.packSize).toBe(1);
    expect(buildOrderQuoteFromProducts([{ productId: flauta.id, requestedQuantity: 4 }], [flauta]).total).toBe(1132);
  });
});
