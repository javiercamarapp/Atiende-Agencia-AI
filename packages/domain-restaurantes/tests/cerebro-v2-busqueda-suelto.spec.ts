/* eslint-disable @typescript-eslint/no-explicit-any -- port literal de pruebas Deno (deno-lint-ignore-file no-explicit-any en el origen) */
// Pruebas de la búsqueda de producto PORTADAS TAL CUAL del suelto (e69279e): fallos-post-c3, fallos-post-c3-r19/r20/r28,
// fallos-c2-busqueda-platillo, fallos-c3-1939849, fallos-medicion-2/3/4 y create-order-core.test.ts (solo los Deno.test que
// ejercen la búsqueda pura). Se generaron con un shim: `pedidos.buscarProductosCore(bd, …)` lee las filas de la base falsa
// del suelto (mismo SELECT encadenado) y llama a la búsqueda pura del port; `Deno.test` -> `it`; `assert` lanza como allá.
// Catálogo: tests/cerebro-v2-busqueda-menu-pm.json (garcia-lavin y pensiones del arnés de medición del suelto).
import { describe, expect, it } from "vitest";
import * as b from "../src/whatsapp/cerebro-v2/busqueda.ts";
import menuCatalogo from "./cerebro-v2-busqueda-menu-pm.json" with { type: "json" };
import dosPartes from "./cerebro-v2-busqueda-dos-partes-r19.json" with { type: "json" };

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// El menú en la forma original del arnés (categories / products / branch_products), reconstruido del catálogo por sucursal.
const menuPm: any = (() => {
  const cats = new Map<string, string>();
  const products = new Map<string, any>();
  const branch_products: Record<string, Record<string, { price: number; is_available: boolean }>> = {};
  for (const suc of ["garcia-lavin", "pensiones"] as const) {
    branch_products[suc] = {};
    for (const p of (menuCatalogo as any)[suc] as b.ProductoCatalogo[]) {
      const catId = `cat:${p.category ?? ""}`;
      cats.set(catId, String(p.category ?? ""));
      products.set(p.id, { id: p.id, name: p.name, description: p.description ?? null, category_id: catId, search_keywords: p.searchKeywords ?? [] });
      (branch_products[suc] as Record<string, { price: number; is_available: boolean }>)[p.id] = { price: p.price, is_available: true };
    }
  }
  return { categories: [...cats].map(([id, name]) => ({ id, name })), products: [...products.values()], branch_products };
})();

// create-order-core.ts del suelto, en su versión pura: la base falsa de cada prueba sigue dando las filas.
async function filasDe(bd: any): Promise<b.Fila[]> {
  const { data, error } = await bd.from("branch_products").select("price, is_available, products!inner(...)").eq("branch_id", "b1").eq("is_available", true).eq("products.restaurant_id", "r1").limit(400);
  if (error) throw error;
  return data ?? [];
}
type ArgsBusqueda = { branchId?: string; restaurantId?: string; query: string };
const pedidosShim: typeof b & {
  buscarProductosConExtrasCore(bd: unknown, args: ArgsBusqueda): Promise<any>;
  buscarProductosCore(bd: unknown, args: ArgsBusqueda): Promise<any[]>;
} = {
  ...b,
  async buscarProductosConExtrasCore(bd: unknown, args: ArgsBusqueda) {
    return b.buscarProductosConExtrasEnFilas(await filasDe(bd), args.query);
  },
  async buscarProductosCore(bd: unknown, args: ArgsBusqueda) {
    return b.buscarProductosEnFilas(await filasDe(bd), args.query);
  },
};
const pedidos = pedidosShim;
const pedidosCore = pedidosShim;
const orderCore = pedidosShim;
const core: any = { resultadoBuscarProducto: b.resultadoBuscarProducto };
void [pedidos, pedidosCore, orderCore, core, menuPm, expect, dosPartes];

describe("fallos-post-c3.test.ts", () => {

// Defectos reales del examen C3 (ace28e8, Luna x5) -> rama fix/pm-post-c3. Sin PII: todo sintetico.
// Catalogo REAL del arnes (scripts/medicion/fixtures/menu-pm.json).




const fx: any = menuPm;
const cats = new Map<string, string>(fx.categories.map((c: any) => [c.id, c.name]));
function bdFixture(sucursal = "garcia-lavin") {
  const bp = fx.branch_products[sucursal];
  const filas = fx.products.filter((p: any) => bp[p.id]?.is_available).map((p: any) => ({
    price: bp[p.id].price,
    is_available: true,
    products: { id: p.id, name: p.name, description: p.description, restaurant_id: "r1", search_keywords: p.search_keywords ?? [], categories: { name: cats.get(p.category_id) ?? null } },
  }));
  const q: any = { select: () => q, eq: () => q, limit: () => Promise.resolve({ data: filas, error: null }) };
  return { from: () => q };
}
const buscar = async (query: string): Promise<any[]> =>
  (await pedidos.buscarProductosCore(bdFixture(), { branchId: "b1", restaurantId: "r1", query })).map((x: { name: string }) => x.name);


// ---- G6a: un reclamo de cobro doble = 1 aviso (ESC-06 r5 registro 3) ----

// ---- Revision PR #21 ----
// «cochinita sin grasa» ya no es aproximado: «sin <ingrediente>» es nota de preparacion (ver R2-5).

// ---- Revision PR #21, ronda 2 ----

// ---- Revision PR #21, ronda 3 ----
const crudo = (query: string) => pedidos.buscarProductosCore(bdFixture(), { branchId: "b1", restaurantId: "r1", query });


// ---- Revision PR #21, ronda 4: «sin X» con lista BLANCA de ingredientes de preparacion ----
const nombres = (r: any[]) => JSON.stringify(r.map((x: any) => x.name + (x.aproximado ? " [aprox]" : "")));


// ---- Revision PR #21, ronda 4 (B): anexar al cobro duplicado abierto solo con lista BLANCA ----
const _REC_FIJO = "reclamo de pedido: faltante, producto equivocado o demora";

// ---- Revision PR #21, ronda 4 (C): cada riesgo distinto de la rafaga genera su aviso ----
const _pedidoReciente = [{ id: "o1", status: "entregado", created_at: "2026-11-03T17:00:00Z" }];


// ---- Revision PR #21, ronda 4 (D): prompt ----

// ---- Revision PR #21, quinta revision independiente (ace28e8 vs 750939a) ----

// Tabla con la restriccion unica (restaurant_id, source_event_id) y upsert ignoreDuplicates, como la real.
const _COBRO = { role: "user", content: "me cobraron dos veces" };
const _FALTA = { role: "user", content: "me faltó la coca" };
const _motivos = (filas: Array<Record<string, unknown>>) => filas.map((f) => String(f.reason)).sort();


// ---- Revision PR #21, sexta revision independiente (ace28e8 vs 8e361c9) ----

// callback_requests con estado: los selects ven las filas ya insertadas (filtros eq/in aplicados), como la real.

// ---- Revision PR #21, ronda 8 ----

// callback_requests con estado (select filtrado, update por id, upsert con llave unica) y el outbox de alertas.
const _avisoAbierto = (reason: string, message: string) => ({
  id: "c0", restaurant_id: "be3fbdeb-80e7-4e7b-9b44-22b476c08298", customer_phone: "+5219990001111", branch_id: null,
  reason, message, resolved: false, created_at: "2026-11-03T17:50:00Z", source_event_id: "wamid-viejo",
});


// ---- Revision PR #21, ronda 9 ----
// Ronda 10: el extra con costo ya no viene mezclado en los productos con extra_pedido (el servidor adivinaba un cobro):
// viene aparte en `extras_disponibles` y el agente PREGUNTA antes de agregarlo. R9-1 y R9-1b migrados a ese contrato.
const conExtras = (query: string) => pedidos.buscarProductosConExtrasCore(bdFixture(), { branchId: "b1", restaurantId: "r1", query });
const nombresExtras = (r: any) => r.extras_disponibles.map((e: any) => e.nombre);
const extrasDe = (r: any) => (Array.isArray(r) ? [] : nombresExtras(r));


// ---- Revision PR #21, ronda 10 ----
// El servidor ya no decide un cobro adivinando: el extra con costo de «con X» viene aparte (extras_disponibles) y el
// agente pregunta antes de agregarlo.

// ---- Revision PR #21, ronda 11 ----

// ---- Revision PR #21, ronda 12 ----

// ---- Revision PR #21, ronda 13 ----

// ---- Revision PR #21, ronda 14: la busqueda es una AYUDA para pedidos de varios productos ----
const otrosDe = (r: any): any[] =>
  (r.otros_productos ?? []).map((o: any) => `${o.texto}=>${o.resultados.map((x: any) => x.name).join("|")}`);


// ---- Revision PR #21, ronda 15 ----
// Menu del arnes con solo algunas filas (para probar lo que pasa si un producto no esta).
function bdFiltrada(quedan: (nombre: string) => boolean) {
  const bp = fx.branch_products["garcia-lavin"];
  const filas = fx.products.filter((p: any) => bp[p.id]?.is_available && quedan(p.name)).map((p: any) => ({
    price: bp[p.id].price,
    is_available: true,
    products: { id: p.id, name: p.name, description: p.description, restaurant_id: "r1", search_keywords: p.search_keywords ?? [], categories: { name: cats.get(p.category_id) ?? null } },
  }));
  const q: any = { select: () => q, eq: () => q, limit: () => Promise.resolve({ data: filas, error: null }) };
  return { from: () => q };
}


// Ronda 16: la cerveza ya no va exacta (el menu no tiene esa presentacion): aproximada con presentacion_no_disponible.

// Revision PR #21 ronda 16 (sintetico, catalogo del arnes).

// ---- Revision PR #21, ronda 17 ----
// Menu sintetico: el del arnes con filas agregadas o quitadas (packs, caguama, un kilo que no existe).
function bdMenu(cambiar: (filas: any[]) => any[]) {
  const bd: any = bdFixture();
  const original = bd.from().limit;
  const q: any = {
    select: () => q, eq: () => q,
    limit: async (...a: unknown[]) => {
      const { data } = await original(...a);
      return { data: cambiar(data), error: null };
    },
  };
  return { from: () => q };
}
// Una cerveza del arnes renombrada como presentacion («Sol Six Pack», «Indio Caguama»).
const conPresentaciones = (filas: any[]) => {
  const sol = filas.find((r: any) => r.products.name === "Sol");
  const fila = (id: string, name: string, price: number) => ({ ...sol, price, products: { ...sol.products, id, name } });
  return [...filas, fila("sol-6", "Sol Six Pack", 150), fila("sol-12", "Sol 12 Pack", 280), fila("indio-cag", "Indio Caguama", 120)];
};
const enMenu = (cambiar: (filas: any[]) => any[], query: string): Promise<any> =>
  pedidos.buscarProductosConExtrasCore(bdMenu(cambiar), { branchId: "b1", restaurantId: "r1", query });
const conFlags = (r: any[]) => JSON.stringify(r.map((x: any) => [x.name, x.aproximado ?? false, x.presentacion_no_disponible ?? null]));
const esPeso = (n: string) => /— \d+(?:\.\d+)? (?:kg|g)$/.test(n);


// ---- Revision PR #21, ronda 18: invariantes de la busqueda de varios productos ----
const soloCifras = (t: string) => /^\d+$/.test(t);
// Las cervezas del arnes (categoria «Cervezas»): lo unico que puede salir por una presentacion sin marca.
const cervezasDelMenu = new Set<string>(fx.products.filter((p: any) => /^cervezas?$/i.test(cats.get(p.category_id) ?? "")).map((p: any) => p.name));
const cervezaConPresentacion = (r: any[], presentacion: string) =>
  r.length > 0 && r.every((x: any) => cervezasDelMenu.has(x.name) && x.aproximado === true && x.presentacion_no_disponible === presentacion);


// Pedidos de varios productos para las propiedades de la ronda 18.
const PEDIDOS_VARIOS = [
  "jugo de naranja y 2 tacos", "una heineken cero y 2 tacos", "agua 1 L y 2 tacos", "xyz y 2 tacos", "media orden de tacos y 2 cocas",
  "2 tacos y una caguama", "dos cocas y una caguama", "tacos de pastor y una coca", "tacos de pastor y 2 cocas", "orden de pastor y 2 cocas",
  "2 tacos y 2 kilos de pastor", "tacos de pastor y 2 kilos de bistec", "2 tacos y 1/2 kilo de pastor", "4 pastor 2 bistec y una coca",
  "una sol y una heineken", "una heineken y una heineken 0.0", "dos cocas y una coca light", "dos cocas y una light", "gringa de pastor y una horchata",
  "3 tacos de bistec y 2 jarritos", "agua de horchata y 2 jarritos de tamarindo", "una limonada, una coca y 2 tacos de pastor", "pizza y sushi",
  "sushi y 2 tacos", "una coca y 3 tacos de pastor", "2 caguamas y 3 tacos", "un six pack y 2 tacos", "una caguama y una coca",
  "tacos de pastor, una horchata y una jamaica", "quesadilla y una coca", "un kilo de pastor y una coca", "medio kilo de bistec y 2 cocas",
  "2 tacos de pastor y 1 y 1/2 kilos de bistec", "una cerveza y 2 tacos", "nachos de pastor y 2 cocas", "frijoles charros y una coca",
  "una coca y una sprite", "una sprite y una fanta", "tacos de pastor y lasaña", "tecate light y 2 tacos", "una heineken y una heineken cero",
  "2 tacos y 1 y 1/2 kilos de pastor",
];

// Lo que el menú de PM no tiene: la única parte que puede salir con resultados [] (R18-2, revisión 19).
const PARTES_FUERA_DEL_MENU = new Set(["jugo de naranja", "xyz", "sushi", "2 jarritos", "2 jarritos de tamarindo", "lasaña"]);

it("G3: «heineken cero cero», «heineken 00», «cerveza sin alcohol», «cero cero» encuentran Heineken 0.0", async () => {
  for (const q of ["heineken cero cero", "heineken 00", "heineken 0 0", "cerveza sin alcohol", "cero cero", "heineken sin alcohol", "heineken 0.0"]) {
    const r = await buscar(q);
    assert(r.includes("Heineken 0.0"), `«${q}» -> ${JSON.stringify(r)}`);
  }
});
it("G3: «bistec por kilo» / «bistec normal por kilo» encuentran Bistec de Res — 1 kg", async () => {
  for (const q of ["bistec por kilo", "bistec normal por kilo", "un kilo de bistec", "bistec normal"]) {
    const r = await buscar(q);
    assert(r.some((n) => /^Bistec de Res — 1 kg/.test(n)), `«${q}» -> ${JSON.stringify(r)}`);
  }
});
it("G3: la relajada no inventa: un producto que no existe sigue devolviendo vacio", async () => {
  for (const q of ["sushi", "pizza hawaiana gigante", "langosta thermidor"]) {
    const r = await buscar(q);
    assert(r.length === 0 || !/sushi|langosta/i.test(q) , `«${q}» -> ${JSON.stringify(r)}`);
  }
  assert((await buscar("sushi")).length === 0, "sushi");
});
it("P1: la relajada solo suelta adjetivos (grande) y marca aproximado; un sustantivo desconocido deja la lista vacia", async () => {
  const bd = bdFixture();
  const raw = (query: string) => pedidos.buscarProductosCore(bd, { branchId: "b1", restaurantId: "r1", query });
  for (const [q, esperado] of [["horchata grande", /^Horchata$/], ["agua de horchata grande", /^Horchata$/], ["coca cola grande", /^Coca-Cola$/]] as const) {
    const r = await raw(q);
    assert(r.length > 0 && r.every((x: any) => x.aproximado === true), `«${q}» debia ser aproximado -> ${JSON.stringify(r.map((x: any) => x.name))}`);
    assert(esperado.test(r[0].name) && r.every((x: any) => /horchata|coca|cochinita/i.test(x.name)), `«${q}» -> ${JSON.stringify(r.map((x: any) => x.name))}`);
  }
  for (const q of ["sushi de pollo", "tacos de lengua", "pozole de pollo", "tacos de pescado", "pizza hawaiana gigante", "camarones al ajillo"]) {
    const r = await buscar(q);
    assert(r.length === 0, `«${q}» debia quedar vacio -> ${JSON.stringify(r)}`);
  }
  const exacta = await raw("horchata");
  assert(exacta.length > 0 && exacta.every((x: any) => x.aproximado === undefined), "una busqueda exacta no es aproximada");
});
it("P2: «0 0» con espacio es la Heineken 0.0 solo con contexto de cerveza/bebida", () => {
  const t = pedidos.tokenizeForProductSearch;
  assert(t("calle 0 0").join(" ") !== t("calle 0.0").join(" ") && !t("calle 0 0").includes("0.0"), "calle 0 0");
  assert(!t("mesa 0 0").includes("0.0"), "mesa 0 0");
  assert(t("heineken 0 0").includes("0.0") && t("cerveza 0 0").includes("0.0") && t("cerveza sin alcohol").includes("0.0"), "con contexto");
  assert(t("00").includes("0.0") || t("heineken 00").includes("0.0"), "00 pegado");
});
it("R2-2: palabras cortas y subcadenas no casan dentro de otra palabra («té» no es bisTEc/TEcate, «mole» no es guacaMOLE)", async () => {
  const bd = bdFixture();
  const raw = (query: string) => pedidos.buscarProductosCore(bd, { branchId: "b1", restaurantId: "r1", query });
  for (const q of ["té verde", "té de limón", "te verde", "té frío", "té helado", "mole"]) {
    const r = (await raw(q)).map((x: any) => x.name);
    assert(!r.some((n: string) => /bistec|tecate|tequila|guacamole/i.test(n)), `«${q}» -> ${JSON.stringify(r)}`);
  }
  const frio = await raw("té frío");
  assert(frio.length === 1 && frio[0].name === "Té" && frio[0].aproximado === true, `té frío -> ${JSON.stringify(frio)}`);
  const sol = (await raw("sol")).map((x: any) => x.name);
  assert(sol.includes("Sol") && !sol.some((n: string) => /solera/i.test(n)), `sol -> ${JSON.stringify(sol)}`);
  // Una errata tolerada no es lo pedido literal: se marca aproximado.
  const errata = await raw("grinbas");
  assert(errata.length > 0 && errata.every((x: any) => /gringa/i.test(x.name) && x.aproximado === true), `grinbas -> ${JSON.stringify(errata)}`);
});
it("R2-3: «coca 0 0», «sprite cero cero», «sol 0 0» siguen encontrando el producto; «00»/«cero cero» solo son la 0.0 con cerveza o solos", async () => {
  // «sol 0 0» ya no cae a la Sol (con alcohol): ver R5-2.
  for (const [q, re] of [["coca 0 0", /^Coca-Cola/], ["sprite 0 0", /^Sprite/], ["sprite cero cero", /^Sprite Cero$/]] as const) {
    const r = await buscar(q);
    assert(r.length > 0 && re.test(r[0]), `«${q}» -> ${JSON.stringify(r)}`);
  }
  const t = pedidos.tokenizeForProductSearch;
  assert(!t("calle 00").includes("0.0") && !t("mesa cero cero").includes("0.0") && !t("coca 0 0").includes("0.0"), "sin contexto de cerveza no es la 0.0");
  assert(t("cero cero").includes("0.0") && t("una 00").includes("0.0") && t("sol 0 0").includes("0.0") && t("indio cero cero").includes("0.0"), "solo o con cerveza si");
});
it("R2-4: «helado de vainilla» no es Jericallas (helado no es un adjetivo que se suelte)", async () => {
  const r = await buscar("helado de vainilla");
  assert(!r.includes("Jericallas"), `helado de vainilla -> ${JSON.stringify(r)}`);
});
it("R2-5: «sin <ingrediente>» es nota de preparacion (no filtra la busqueda); «sin gas/azúcar/alcohol» define otro producto y nunca se suelta", async () => {
  const bd = bdFixture();
  const raw = (query: string) => pedidos.buscarProductosCore(bd, { branchId: "b1", restaurantId: "r1", query });
  for (const [q, re] of [["pastor sin cebolla", /pastor/i], ["tacos de pastor sin cebolla ni cilantro", /pastor/i], ["cochinita sin grasa", /cochinita/i]] as const) {
    const r = await raw(q);
    assert(r.length > 0 && re.test(r[0].name) && r.every((x: any) => x.aproximado === undefined), `«${q}» -> ${JSON.stringify(r.map((x: any) => x.name))}`);
  }
  // Ronda 3: la exacta conserva «sin gas»; si queda vacia, la relajada lo suelta y marca aproximado (ver R3-2).
  const mineral = await raw("agua mineral sin gas");
  assert(mineral.length > 0 && mineral.every((x: any) => x.aproximado === true), `agua mineral sin gas debe ser aproximado -> ${JSON.stringify(mineral)}`);
  assert((await buscar("coca sin azúcar"))[0] === "Coca-Cola sin Azúcar", "sin azucar define el producto");
});
it("R2-6: «por favor» no es parte del producto", async () => {
  const r = await buscar("un kilo de bistec por favor");
  assert(r.some((n) => /^Bistec de Res — 1 kg/.test(n)), JSON.stringify(r));
});
it("R3-1: «helado/helada» despues del producto es adjetivo (se suelta, aproximado); al inicio es el producto («helado de vainilla» vacio)", async () => {
  for (const [q, re] of [
    ["limonada helada", /^Limonada/], ["coca helada", /^Coca-Cola/], ["agua helada", /^Agua/], ["heineken helada", /^Heineken/],
    ["horchata helada", /^Horchata$/], ["agua de jamaica helada", /^Agua de Jamaica$/], ["dos limonadas heladas", /^Limonada/],
  ] as const) {
    const r = await crudo(q);
    assert(r.length > 0 && re.test(r[0].name) && r.every((x: any) => x.aproximado === true), `«${q}» -> ${JSON.stringify(r.map((x: any) => x.name))}`);
  }
  for (const q of ["helado de vainilla", "helado", "helados de chocolate"]) {
    assert((await buscar(q)).length === 0, `«${q}» debia quedar vacio -> ${JSON.stringify(await buscar(q))}`);
  }
});
it("R3-2: la relajada puede soltar «sin gas/sin cafeína» (aproximado); la exacta lo conserva", async () => {
  for (const [q, re] of [["agua sin gas 600", /^Agua Purificada$/], ["agua mineral sin gas", /^Agua Mineral Cristal$/], ["coca sin cafeína", /^Coca-Cola/]] as const) {
    const r = await crudo(q);
    assert(r.length > 0 && re.test(r[0].name) && r.every((x: any) => x.aproximado === true), `«${q}» -> ${JSON.stringify(r.map((x: any) => x.name))}`);
  }
  const sinAzucar = await crudo("coca sin azúcar");
  assert(sinAzucar.length > 0 && sinAzucar[0].name === "Coca-Cola sin Azúcar" && sinAzucar.every((x: any) => x.aproximado === undefined), `coca sin azúcar -> ${JSON.stringify(sinAzucar)}`);
});
it("R3-3: solo los tokens de 1-2 letras son palabra completa; de 3+ letras vuelven a casar al inicio de palabra", async () => {
  for (const [q, re] of [
    ["bis", /bistec/i], ["pas", /pastor/i], ["arr", /arrachera/i], ["pol", /pollo/i], ["cos", /costilla/i], ["agu", /^agua/i],
    ["jam", /jamaica/i], ["hor", /horchata/i], ["tac", /^tacos?\b/i], ["sui", /suizo/i], ["gri", /gringa/i], ["ala", /alambre/i],
    ["chu", /chuleta|chuc/i], ["fri charros", /frijoles charros/i],
  ] as const) {
    const r = await buscar(q);
    assert(r.length > 0 && re.test(r[0]), `«${q}» -> ${JSON.stringify(r)}`);
  }
  for (const q of ["te", "té", "té verde", "mole"]) {
    const r = await buscar(q);
    assert(!r.some((n) => /bistec|tecate|tequila|guacamole/i.test(n)), `«${q}» -> ${JSON.stringify(r)}`);
  }
  const sol = await buscar("sol");
  assert(sol.includes("Sol") && !sol.some((n) => /solera/i.test(n)), `sol -> ${JSON.stringify(sol)}`);
});
it("R3-4: «0 0»/«cero cero» que no es la 0.0 cae a la marca pedida marcado aproximado; «tecate cero cero» = «tecate 0 0»", async () => {
  // Ronda 5: una CERVEZA «0 0» de la que no hay version sin alcohol ya no cae a la marca con alcohol (ver R5-2).
  for (const [q, re] of [["fanta 0 0", /^Fanta$/], ["coca 0 0", /^Coca-Cola/]] as const) {
    const r = await crudo(q);
    assert(r.length > 0 && re.test(r[0].name) && r.every((x: any) => x.aproximado === true), `«${q}» -> ${JSON.stringify(r.map((x: any) => [x.name, x.aproximado]))}`);
  }
  assert(JSON.stringify(await buscar("tecate cero cero")) === JSON.stringify(await buscar("tecate 0 0")), "tecate cero cero y tecate 0 0 deben dar lo mismo");
  for (const q of ["heineken 0 0", "heineken cero cero", "cero cero"]) {
    const r = await crudo(q);
    assert(r.some((x: any) => x.name === "Heineken 0.0") && r.every((x: any) => x.aproximado === undefined), `«${q}» es la 0.0 exacta -> ${JSON.stringify(r)}`);
  }
  const spriteCero = await crudo("sprite cero cero");
  assert(spriteCero[0]?.name === "Sprite Cero" && spriteCero[0].aproximado === undefined, `sprite cero cero -> ${JSON.stringify(spriteCero)}`);
});
it("R4-A1: solo «sin <ingrediente de preparacion>» sale de la busqueda; cualquier otro «sin X» se queda en la consulta", () => {
  const t = pedidos.tokenizeForProductSearch;
  for (const [q, base] of [
    ["pastor sin cebolla", "pastor"], ["tacos de pastor sin cebollas", "tacos de pastor"], ["bistec sin cebolla y cilantro", "bistec"],
    ["bistec sin cebolla ni cilantro", "bistec"], ["alambre de pastor sin cebolla por favor", "alambre de pastor"], ["coca sin hielo", "coca"],
    ["pastor sin salsa verde", "pastor"], ["bistec sin chiles, sin limones", "bistec"], ["limonada con topo chico sin hielo", "limonada con topo chico"],
  ] as const) {
    assert(JSON.stringify(t(q)) === JSON.stringify(t(base)), `«${q}» -> ${JSON.stringify(t(q))} (esperaba ${JSON.stringify(t(base))})`);
  }
  for (const [q, palabras] of [
    ["limonada sin soda", ["sin", "soda"]], ["limonada sin topo chico", ["sin", "topo", "chico"]], ["margarita sin alcohol", ["sin", "alcohol"]],
    ["coca sin azúcar", ["sin", "azúcar"]], ["sol sin alcool", ["sin", "alcohol"]], ["margarita sin alcol", ["sin", "alcohol"]],
  ] as const) {
    const tk = t(q);
    assert(palabras.every((p) => tk.includes(p)), `«${q}» debia conservar ${palabras} -> ${JSON.stringify(tk)}`);
  }
});
it("R4-A2: «sin alcool/alcol» (errata) nunca devuelve una bebida con alcohol", async () => {
  for (const q of ["sol sin alcool", "tecate sin alcool", "heineken sin alcool", "chela sin alcool", "cerveza sin alcool", "margarita sin alcool", "margarita sin alcol", "margarita sin alcoholl", "sol sin alcohol", "tecate sin alcohol"]) {
    const r = await crudo(q);
    assert(r.every((x: any) => x.requires_adult_confirmation === false), `«${q}» -> ${nombres(r)}`);
  }
  for (const q of ["heineken sin alcool", "chela sin alcool", "cerveza sin alcool"]) {
    const r = await crudo(q);
    assert(r[0]?.name === "Heineken 0.0", `«${q}» -> ${nombres(r)}`);
  }
  for (const q of ["margarita sin alcool", "margarita sin alcol", "margarita sin alcohol"]) {
    const r = await crudo(q);
    assert(r.length === 1 && r[0].name === "Margarita sin Alcohol" && r[0].aproximado === undefined, `«${q}» -> ${nombres(r)}`);
  }
});
it("R4-A3: «sin topo chico» / «sin soda» se suelta COMPLETO en la relajada, marca aproximado y nunca devuelve el producto excluido", async () => {
  for (const [q, primero] of [
    ["limonada sin topo chico", /^Limonada$/], ["naranjada sin topo chico", /^Naranjada$/], ["agua sin topo chico", /^Agua/],
    ["limonada sin soda", /^Limonada$/], ["naranjada sin soda", /^Naranjada$/],
  ] as const) {
    const r = await crudo(q);
    assert(r.length > 0 && primero.test(r[0].name), `«${q}» -> ${nombres(r)}`);
    assert(r.every((x: any) => x.aproximado === true), `«${q}» debia ser aproximado -> ${nombres(r)}`);
    assert(!r.some((x: any) => /topo chico|soda/i.test(x.name)), `«${q}» devolvio el excluido -> ${nombres(r)}`);
  }
  for (const q of ["suero sin topo chico", "suero sin soda"]) {
    const r = await crudo(q);
    assert(!r.some((x: any) => /topo chico|soda/i.test(x.name)), `«${q}» -> ${nombres(r)}`);
  }
  const conHielo = await crudo("limonada con topo chico sin hielo");
  assert(conHielo[0]?.name === "Limonada con Topo Chico" && conHielo.every((x: any) => x.aproximado === undefined), `con topo chico sin hielo -> ${nombres(conHielo)}`);
});
it("R4-A4: los casos que ya funcionaban siguen igual (preparacion exacta, «sin gas/cafeína» aproximado, «sin azúcar» exacto)", async () => {
  for (const [q, re] of [["pastor sin cebolla", /pastor/i], ["bistec sin cebolla y cilantro", /bistec/i], ["bistec sin cebolla ni cilantro", /bistec/i], ["coca sin hielo", /^Coca-Cola/]] as const) {
    const r = await crudo(q);
    assert(r.length > 0 && re.test(r[0].name) && r.every((x: any) => x.aproximado === undefined), `«${q}» -> ${nombres(r)}`);
  }
  for (const [q, re] of [["agua mineral sin gas", /^Agua Mineral Cristal$/], ["coca sin cafeína", /^Coca-Cola/]] as const) {
    const r = await crudo(q);
    assert(r.length > 0 && re.test(r[0].name) && r.every((x: any) => x.aproximado === true), `«${q}» -> ${nombres(r)}`);
  }
  const azucar = await crudo("coca sin azucar");
  assert(azucar[0]?.name === "Coca-Cola sin Azúcar" && azucar.every((x: any) => x.aproximado === undefined), `coca sin azucar -> ${nombres(azucar)}`);
});
it("R5-3: «gracias», «grax», «plis», «please» no son parte del producto", async () => {
  const t = pedidos.tokenizeForProductSearch;
  for (const q of ["pastor gracias", "pastor grax", "pastor plis", "pastor please", "pastor por favor gracias"]) {
    assert(JSON.stringify(t(q)) === JSON.stringify(t("pastor")), `«${q}» -> ${JSON.stringify(t(q))}`);
    const r = await crudo(q);
    assert(r.length > 0 && r.every((x: any) => /pastor/i.test(x.name) && x.aproximado === undefined), `«${q}» -> ${nombres(r)}`);
  }
});
it("R5-4: «de» une un ingrediente compuesto dentro del «sin» («sin salsa de piña», «sin crema de ajo»): todo es nota", () => {
  const t = pedidos.tokenizeForProductSearch;
  for (const [q, base] of [
    ["tacos sin salsa de piña", "tacos"], ["tacos sin crema de ajo", "tacos"], ["pizza sin salsa de piña", "pizza"],
    ["bistec sin salsa de chile habanero", "bistec"], ["tacos sin salsa de piña y sin cebolla", "tacos"],
    // Lo que sigue al «de» no es ingrediente: es el producto y se queda («sin salsa» es la nota).
    ["tacos sin salsa de pastor", "tacos de pastor"],
  ] as const) {
    assert(JSON.stringify(t(q)) === JSON.stringify(t(base)), `«${q}» -> ${JSON.stringify(t(q))} (esperaba ${JSON.stringify(t(base))})`);
  }
});
it("R5-1: la nota «sin <ingrediente>» no cambia QUE productos se encuentran ni su marca de aproximado", async () => {
  for (const [q, base] of [
    ["pizza sin piña", "pizza"], ["pizza sin pina", "pizza"], ["pizza sin salsa de piña", "pizza"], ["pizza sin piña y sin cebolla", "pizza"],
    ["quesobich sin piña", "quesobich"], ["pastor sin piña", "pastor"], ["tacos sin crema de ajo", "tacos"],
  ] as const) {
    const [a, b] = [nombres(await crudo(q)), nombres(await crudo(base))];
    assert(a === b, `«${q}» -> ${a}; «${base}» -> ${b}`);
  }
  // «pizza» es la categoria «Pizza Quesobich» (y el alias «pizza» de cada Quesobich): son las pizzas de la casa, no
  // un producto que el cliente no nombro.
  const pizza = await crudo("pizza sin piña");
  assert(pizza.length > 0 && pizza.every((x: any) => /^Quesobich/.test(x.name) && x.aproximado === undefined), nombres(pizza));
});
it("R5-5a: «sin hielo ni azúcar/gas»: el hielo es nota, «sin azúcar/gas» define el producto y el «ni» nunca queda de token", async () => {
  const t = pedidos.tokenizeForProductSearch;
  for (const [q, base] of [
    ["coca sin hielo ni azúcar", "coca sin azúcar"], ["coca sin azúcar ni hielo", "coca sin azúcar"], ["agua sin hielo ni gas", "agua sin gas"],
    ["limonada sin hielo ni azucar", "limonada sin azucar"], ["agua mineral sin hielo ni gas", "agua mineral sin gas"],
  ] as const) {
    assert(JSON.stringify(t(q)) === JSON.stringify(t(base)), `«${q}» -> ${JSON.stringify(t(q))} (esperaba ${JSON.stringify(t(base))})`);
    const [a, b] = [nombres(await crudo(q)), nombres(await crudo(base))];
    assert(a === b, `«${q}» -> ${a}; «${base}» -> ${b}`);
  }
  for (const q of ["coca sin azúcar ni gas", "agua sin hielo ni gas", "coca sin hielo ni azúcar"]) {
    assert(!t(q).includes("ni"), `«${q}» dejo «ni» -> ${JSON.stringify(t(q))}`);
  }
  const coca = await crudo("coca sin hielo ni azúcar");
  assert(coca[0]?.name === "Coca-Cola sin Azúcar" && coca.every((x: any) => x.aproximado === undefined), nombres(coca));
});
it("R5-5b: «(una) cerveza sin hielo» busca las cervezas: si solo quedan stopwords y la nota, se usa la consulta SIN la nota", async () => {
  const t = pedidos.tokenizeForProductSearch;
  for (const q of ["cerveza sin hielo", "una cerveza sin hielo", "una cerveza", "una cerveza por favor", "unas cervezas sin hielo"]) {
    assert(JSON.stringify(t(q)) === JSON.stringify(t("cerveza")), `«${q}» -> ${JSON.stringify(t(q))}`);
    const [a, b] = [nombres(await crudo(q)), nombres(await crudo("cerveza"))];
    assert(a === b && a !== "[]", `«${q}» -> ${a}; «cerveza» -> ${b}`);
  }
  assert(!t("cerveza sin hielo").some((x) => /hielo|sin/.test(x)), JSON.stringify(t("cerveza sin hielo")));
});
it("R5-2: «tecate cero cero» / «sol 0.0» nunca devuelven una cerveza CON alcohol; lo mas parecido sin alcohol es la Heineken 0.0 (aproximado)", async () => {
  for (const q of [
    "tecate cero cero", "tecate 0 0", "tecate 0.0", "sol cero cero", "sol 0.0", "sol 0 0", "indio cero cero", "sol 0 0 por favor",
    "una tecate cero cero", "cerveza tecate cero cero", "corona 0 0", "modelo cero cero", "victoria 00", "tecate sin alcohol",
  ]) {
    const r = await crudo(q);
    assert(r.every((x: any) => x.requires_adult_confirmation === false), `«${q}» devolvio alcohol -> ${nombres(r)}`);
    assert(r.length > 0 && r[0].name === "Heineken 0.0" && r.every((x: any) => x.aproximado === true), `«${q}» -> ${nombres(r)}`);
  }
  // La 0.0 pedida por su nombre sigue exacta; los refrescos «0 0» siguen cayendo a su marca (no son cerveza).
  for (const q of ["heineken 0 0", "heineken cero cero", "cero cero", "cerveza sin alcohol"]) {
    const r = await crudo(q);
    assert(r[0]?.name === "Heineken 0.0" && r.every((x: any) => x.aproximado === undefined), `«${q}» -> ${nombres(r)}`);
  }
  for (const [q, re] of [["coca 0 0", /^Coca-Cola/], ["fanta 0 0", /^Fanta$/], ["sprite 0 0", /^Sprite/]] as const) {
    const r = await crudo(q);
    assert(r.length > 0 && re.test(r[0].name) && r.every((x: any) => x.aproximado === true), `«${q}» -> ${nombres(r)}`);
  }
});
it("R6-1: «sin X» nunca devuelve como exacto un producto cuyo NOMBRE es X («chicharrón sin queso», «boyo sin queso», «bistec sin cebolla»)", async () => {
  // Si quedan otros, se excluye el que se llama como lo excluido.
  const boyo = await crudo("boyo sin queso");
  assert(boyo.length > 0 && boyo.every((x: any) => !/queso/i.test(x.name) && /boyo/i.test(x.name)), `boyo -> ${nombres(boyo)}`);
  const bistec = await crudo("bistec sin cebolla");
  assert(bistec.length > 0 && bistec.every((x: any) => !/cebolla/i.test(x.name) && /bistec/i.test(x.name) && x.aproximado === undefined), `bistec -> ${nombres(bistec)}`);
  // Si TODO lo encontrado se llama como lo excluido, se devuelve pero marcado aproximado (no es lo pedido).
  const chicharron = await crudo("chicharron sin queso");
  assert(chicharron.length > 0 && chicharron.every((x: any) => x.aproximado === true), `chicharron -> ${nombres(chicharron)}`);
  // Lo excluido solo en la DESCRIPCION no cambia nada: la piña del pastor es nota.
  for (const [q, base] of [["pastor sin piña", "pastor"], ["pizza sin piña", "pizza"], ["quesobich sin cebolla", "quesobich"]] as const) {
    const [a, b] = [nombres(await crudo(q)), nombres(await crudo(base))];
    assert(a === b, `«${q}» -> ${a}; «${base}» -> ${b}`);
  }
});
it("R6-4: una consulta que solo trae la nota y conectores («sin cebolla y») no busca el conector suelto: vacio", async () => {
  for (const q of ["sin cebolla y", "sin cebolla", "y sin cebolla", "sin hielo y", "con sin cebolla de", "sin cebolla, por favor"]) {
    const r = await crudo(q);
    assert(r.length === 0, `«${q}» -> ${nombres(r)}`);
  }
  // Lo que si nombra algo sigue buscando.
  for (const q of ["pastor sin cebolla y", "una cerveza sin hielo y", "xx"]) {
    assert((await crudo(q)).length > 0, `«${q}» quedo vacio`);
  }
});
it("R6-5: «sin alcohol» de una bebida que nunca lleva alcohol se suelta («coca/limonada/agua sin alcohol»); el de cerveza y coctel sigue igual", async () => {
  for (const [q, re] of [["coca sin alcohol", /^Coca-Cola/], ["limonada sin alcohol", /^Limonada/], ["agua sin alcohol", /^Agua/], ["una coca sin alcohol", /^Coca-Cola/]] as const) {
    const r = await crudo(q);
    assert(r.length > 0 && re.test(r[0].name), `«${q}» -> ${nombres(r)}`);
    assert(r.every((x: any) => x.requires_adult_confirmation === false), `«${q}» devolvio alcohol -> ${nombres(r)}`);
  }
  const margarita = await crudo("margarita sin alcohol");
  assert(margarita.length === 1 && margarita[0].name === "Margarita sin Alcohol" && margarita[0].aproximado === undefined, nombres(margarita));
  const michelada = await crudo("michelada sin alcohol");
  assert(michelada.length > 0 && michelada[0].name === "Heineken 0.0" && michelada.every((x: any) => x.aproximado === true && !x.requires_adult_confirmation), nombres(michelada));
  const cerveza = await crudo("cerveza sin alcohol");
  assert(cerveza[0]?.name === "Heineken 0.0" && cerveza.every((x: any) => x.aproximado === undefined), nombres(cerveza));
  // Con un adjetivo detras («sin alcohol grande») la relajada tampoco puede devolver la Margarita CON alcohol.
  for (const q of ["margarita sin alcohol grande", "margarita sin alcohol helada", "conga sin alcohol normal", "sangria sin alcohol grande"]) {
    const r = await crudo(q);
    assert(r.length > 0 && /sin Alcohol$/.test(r[0].name) && r.every((x: any) => x.requires_adult_confirmation === false), `«${q}» -> ${nombres(r)}`);
  }
  for (const q of ["tequila sin alcohol", "whisky sin alcohol", "mojito sin alcohol"]) {
    const r = await crudo(q);
    assert(r.every((x: any) => x.requires_adult_confirmation === false), `«${q}» devolvio alcohol -> ${nombres(r)}`);
  }
});
it("R7-1: «cebolla» vuelve a encontrar el «Encebollado» (prefijo derivativo en-/a-); «mole» y «te» siguen sin casar dentro de otra palabra", async () => {
  for (const q of ["bistec con cebolla", "bistec cebolla", "cebolla", "bistec encebollado"]) {
    const r = await buscar(q);
    assert(r.some((n) => /Encebollado/.test(n)), `«${q}» -> ${JSON.stringify(r)}`);
  }
  // La nota «sin cebolla» sigue excluyendo al Encebollado.
  for (const q of ["bistec sin cebolla", "tacos de bistec sin cebolla"]) {
    const r = await buscar(q);
    assert(r.length > 0 && !r.some((n) => /Encebollado/.test(n)), `«${q}» -> ${JSON.stringify(r)}`);
  }
  for (const q of ["mole", "te"]) {
    const r = await buscar(q);
    assert(!r.some((n) => /guacamole|bistec|tecate|tequila/i.test(n)), `«${q}» -> ${JSON.stringify(r)}`);
  }
});
it("R7-3: «cerveza/chela cero» es la 0.0; «0 0» sin cerveza no es la 0.0 exacta; con «0 0» nunca sale la version CON alcohol", async () => {
  // (a) «cerveza cero» / «chela cero» piden la cerveza 0.0, no el Sprite Cero.
  for (const q of ["cerveza cero", "chela cero", "una chela cero", "cervezas cero"]) {
    const r = await crudo(q);
    assert(r[0]?.name === "Heineken 0.0" && r.every((x: any) => x.aproximado === undefined && !/sprite/i.test(x.name)), `«${q}» -> ${nombres(r)}`);
  }
  // «sprite cero» sigue siendo el Sprite Cero; «cerveza cero cero» sigue siendo la 0.0.
  assert((await crudo("sprite cero"))[0]?.name === "Sprite Cero", "sprite cero");
  assert((await crudo("cerveza cero cero"))[0]?.name === "Heineken 0.0", "cerveza cero cero");
  // (b) «coctel 0 0»: el contenido no es cerveza -> aproximado, y nunca la Heineken como exacta.
  for (const q of ["cocteles 0 0", "coctel cero cero"]) {
    const r = await crudo(q);
    assert(r.length > 0 && r.every((x: any) => x.aproximado === true && x.requires_adult_confirmation === false), `«${q}» -> ${nombres(r)}`);
    assert(!r.some((x: any) => x.name === "Heineken 0.0"), `«${q}» devolvio la cerveza -> ${nombres(r)}`);
  }
  // Solo el «0 0» en cifras, sin nada mas: no se sabe que es; la 0.0 se ofrece como aproximada.
  for (const q of ["la 0 0", "un 0 0", "unos 00"]) {
    const r = await crudo(q);
    assert(r.every((x: any) => x.aproximado === true && x.requires_adult_confirmation === false), `«${q}» -> ${nombres(r)}`);
  }
  // (c) Con «0 0» la version CON alcohol nunca sale, aunque haya resultados.
  for (const [q, nombre] of [["conga 0 0", "Conga sin Alcohol"], ["margarita 0 0", "Margarita sin Alcohol"], ["margarita cero cero", "Margarita sin Alcohol"]] as const) {
    const r = await crudo(q);
    assert(r.length > 0 && r[0].name === nombre && r.every((x: any) => x.requires_adult_confirmation === false), `«${q}» -> ${nombres(r)}`);
  }
  assert((await crudo("tequila 0 0")).every((x: any) => x.requires_adult_confirmation === false), "tequila 0 0 devolvio alcohol");
});
it("R8-6: «con <ingrediente de preparacion>» es nota de cocina si la exacta no encuentra nada («tacos de pastor con cebolla»); si la exacta encuentra, manda («bistec con cebolla» = Encebollado)", async () => {
  for (const q of ["tacos de pastor con cebolla", "pastor con cilantro y cebolla", "tacos de pastor con salsa verde", "gringa de pastor con piña", "tacos de pastor con mucha cebolla"]) {
    const r = await crudo(q);
    assert(r.length > 0 && r.every((x: any) => !x.aproximado) && r.some((x: any) => /pastor/i.test(x.name)) && r.every((x: any) => !/encebollado/i.test(x.name)), `«${q}» -> ${nombres(r)}`);
  }
  // La exacta con las palabras tal cual va primero.
  const bistec = await crudo("bistec con cebolla");
  assert(bistec.length > 0 && bistec.every((x: any) => /encebollado/i.test(x.name) && !x.aproximado), nombres(bistec));
  const boyo = await crudo("boyo con queso");
  assert(boyo.length > 0 && boyo.every((x: any) => /con queso/i.test(x.name) && !x.aproximado), nombres(boyo));
  const limonada = await crudo("limonada con topo chico");
  assert(limonada.length > 0 && limonada.every((x: any) => /topo chico/i.test(x.name)), nombres(limonada));
  // Lo que no esta en la lista blanca no se suelta: sigue sin inventar.
  for (const q of ["tacos de pastor con sushi", "pastor con lengua"]) {
    const r = await crudo(q);
    assert(r.every((x: any) => x.aproximado === true) || r.length === 0, `«${q}» -> ${nombres(r)}`);
    assert(!r.some((x: any) => !x.aproximado), `«${q}» -> ${nombres(r)}`);
  }
});
it("R8-7: plurales en -es («pastores», «chicharrones», «limones», «bisteces») buscan su singular exacto; «tres», «mes», «res» no se recortan", async () => {
  const exactos = async (q: string, re: RegExp) => {
    const r = await crudo(q);
    assert(r.length > 0 && r.every((x: any) => !x.aproximado) && r.some((x: any) => re.test(x.name)), `«${q}» -> ${nombres(r)}`);
  };
  await exactos("pastores", /pastor/i);
  await exactos("tacos de pastores", /pastor/i);
  await exactos("chicharrones", /chicharr[oó]n/i);
  // «limones» ya no es exacto de la Limonada: ver R9-2.
  await exactos("bisteces", /bistec/i);
  // -s y cortas: igual que antes.
  await exactos("tacos", /taco/i);
  // «aguas» sola es categoria y va aproximada desde la revisión 19 (R19-3); el plural en -s se prueba con una que nombra.
  await exactos("aguas de jamaica", /agua de jamaica/i);
  await exactos("bistec de res", /bistec de res/i);
  await exactos("res", /de res/i);
  for (const [q, t] of [["tres", "tres"], ["mes", "mes"], ["res", "res"], ["pastores", "pastor"], ["chicharrones", "chicharron"], ["tacos", "taco"], ["aguas", "agua"]] as const) {
    const tk = pedidos.tokenizeForProductSearch(q);
    assert(tk.length === 0 || tk.includes(t), `tokenize «${q}» -> ${JSON.stringify(tk)}`);
  }
});
it("R9-1: «con X» donde X es un extra CON COSTO del menu (Extra Guacamole, Extra Queso...) no se tira como nota: salen los productos y el extra va en extras_disponibles", async () => {
  const casos: Array<[string, RegExp, string]> = [
    ["tacos de pastor con guacamole", /pastor/i, "Extra Guacamole"],
    ["tacos de pastor con queso extra", /pastor/i, "Extra Queso"],
    ["tacos de pastor con extra queso", /pastor/i, "Extra Queso"],
    ["gringa con guacamole", /gringa/i, "Extra Guacamole"],
    ["tacos de pastor con tocino", /pastor/i, "Extra Tocino"],
  ];
  for (const [q, principal, extra] of casos) {
    const r: any = await conExtras(q);
    const p = r.productos;
    assert(p.length > 0 && p.some((x: any) => principal.test(x.name)) && p.every((x: any) => !x.aproximado && !/^Extra /.test(x.name)), `«${q}» principales -> ${nombres(p)}`);
    assert(JSON.stringify(nombresExtras(r)) === JSON.stringify([extra]), `«${q}» extras -> ${JSON.stringify(nombresExtras(r))}`);
    const e = r.extras_disponibles[0];
    assert(typeof e?.id === "string" && Number(e?.precio) > 0, JSON.stringify(e));
  }
  // Lo que va incluido sin costo sigue siendo nota: ni extra ni aproximado (piña del pastor, salsa, cebolla, limón, cilantro).
  for (const q of ["tacos de pastor con cebolla", "tacos de pastor con salsa verde", "tacos de pastor con piña", "gringa de pastor con piña", "tacos de pastor con limón", "pastor con cilantro y cebolla", "tacos de pastor con chile"]) {
    const r: any = await conExtras(q);
    const p = r.productos;
    assert(p.length > 0 && nombresExtras(r).length === 0 && p.every((x: any) => !x.aproximado) && p.some((x: any) => /pastor/i.test(x.name)), `«${q}» -> ${nombres(p)} extras ${JSON.stringify(nombresExtras(r))}`);
  }
  // «con X» con costo que el menu NO tiene como extra («frijoles con chicharrón»): nunca se cotiza en silencio como lo
  // pedido; lo encontrado va aproximado (el agente aclara).
  for (const q of ["frijoles con chicharrón", "tacos de bistec con aguacate"]) {
    const r: any = await conExtras(q);
    assert(r.productos.every((x: any) => x.aproximado === true), `«${q}» -> ${nombres(r.productos)}`);
  }
  // Si el CATALOGO dice que lo encontrado ya lo trae (el francés suizo lleva guacamole en su descripcion), no se ofrece.
  // Pedido como «extra» si se ofrece. (Ronda 10: ya no se adivina que la gringa o las papas «llevan queso»: se ofrece
  // y la pregunta del agente lo resuelve; ver R10-5.)
  for (const q of ["francés suizo de pastor con guacamole"]) {
    const r: any = await conExtras(q);
    assert(r.productos.length > 0 && nombresExtras(r).length === 0, `«${q}» -> ${nombres(r.productos)} extras ${JSON.stringify(nombresExtras(r))}`);
  }
  const gringaExtra: any = await conExtras("gringa con queso extra");
  assert(JSON.stringify(nombresExtras(gringaExtra)) === JSON.stringify(["Extra Queso"]), nombres(gringaExtra.productos));
  // La exacta sigue mandando: «boyo con queso» es el Boyo con Queso, sin extra.
  const boyo: any = await conExtras("boyo con queso");
  assert(boyo.productos.length > 0 && nombresExtras(boyo).length === 0 && boyo.productos.every((x: any) => /con queso/i.test(x.name)), nombres(boyo.productos));
});
it("R9-1b: los extras se reconocen por como los modela el catalogo (nombre «Extra X» o categoria de complementos), no por una lista fija", async () => {
  const filas = [
    { price: 90, is_available: true, products: { id: "p1", name: "Taco de Pastor", description: "", restaurant_id: "r1", search_keywords: [], categories: { name: "Tacos" } } },
    { price: 25, is_available: true, products: { id: "p2", name: "Queso gratinado", description: "", restaurant_id: "r1", search_keywords: [], categories: { name: "Complementos" } } },
    { price: 15, is_available: true, products: { id: "p3", name: "Extra Aguacate", description: "", restaurant_id: "r1", search_keywords: [], categories: { name: "Otros" } } },
  ];
  const q: any = { select: () => q, eq: () => q, limit: () => Promise.resolve({ data: filas, error: null }) };
  const busca = (query: string) => pedidos.buscarProductosConExtrasCore({ from: () => q }, { branchId: "b1", restaurantId: "r1", query });
  const a: any = await busca("taco de pastor con aguacate");
  assert(JSON.stringify([a.productos.map((x: any) => x.name), a.extras_disponibles]) === JSON.stringify([["Taco de Pastor"], [{ id: "p3", nombre: "Extra Aguacate", precio: 15 }]]), JSON.stringify(a));
  const b: any = await busca("taco de pastor con queso");
  assert(JSON.stringify([b.productos.map((x: any) => x.name), b.extras_disponibles]) === JSON.stringify([["Taco de Pastor"], [{ id: "p2", nombre: "Queso gratinado", precio: 25 }]]), JSON.stringify(b));
});
it("R9-2: el singular de un plural en -es casa como palabra COMPLETA y no por descripcion («frijoles» no es el Chetaco; «limones» no es la Limonada)", async () => {
  const frijoles = await crudo("frijoles");
  assert(frijoles.length > 0 && frijoles.every((x: any) => !x.aproximado && /frijol/i.test(x.name)), `frijoles -> ${nombres(frijoles)}`);
  assert(frijoles.some((x: any) => /frijoles charros/i.test(x.name)) && frijoles.some((x: any) => /frijol con tostada/i.test(x.name)), nombres(frijoles));
  const conQueso = await crudo("frijoles con queso");
  assert(conQueso.length > 0 && conQueso.every((x: any) => /frijol/i.test(x.name)), `frijoles con queso -> ${nombres(conQueso)}`);
  for (const q of ["limones", "unos limones"]) {
    const r = await crudo(q);
    assert(!r.some((x: any) => !x.aproximado && /limonada/i.test(x.name)), `«${q}» -> ${nombres(r)}`);
    assert(!r.some((x: any) => !x.aproximado), `«${q}»: nada exacto (los limones van incluidos, no se venden) -> ${nombres(r)}`);
  }
  // Lo que ya funcionaba con el singular sigue igual.
  for (const [q, re] of [["champiñones", /champi/i], ["pastores", /pastor/i], ["chicharrones", /chicharr/i], ["postres", /./], ["especiales", /especial/i], ["nopales", /./]] as const) {
    const r = await crudo(q);
    if (q === "nopales") { assert(!r.some((x: any) => !x.aproximado), `nopales -> ${nombres(r)}`); continue; }
    assert(r.length > 0 && r.every((x: any) => !x.aproximado) && r.some((x: any) => re.test(x.name)), `«${q}» -> ${nombres(r)}`);
  }
  // Una palabra en singular sigue casando al inicio de palabra como siempre («limon» -> Limonada, «frijol» -> los frijoles).
  const limon = await crudo("limon");
  assert(limon.some((x: any) => /limonada/i.test(x.name)), nombres(limon));
});
it("R9-3: «con todo» (y «con todito», «con todo y cilantro») es nota de cocina: «tacos de pastor con todo» son los de pastor exactos, sin extra", async () => {
  for (const q of ["tacos de pastor con todo", "tacos al pastor con todo", "pastor con todo", "quiero tacos de pastor con todo", "tacos de pastor con todito", "tacos al pastor con todo y cilantro", "tacos de bistec con todo y salsa", "tacos de bistec con todo"]) {
    const rx: any = await conExtras(q);
    const r = rx.productos;
    const carne = /bistec/.test(q) ? /bistec/i : /pastor/i;
    assert(r.length > 0 && r.every((x: any) => !x.aproximado) && r.some((x: any) => carne.test(x.name)) && extrasDe(rx).length === 0, `«${q}» -> ${nombres(r)}`);
  }
  // Solo la nota: nada que buscar.
  for (const q of ["con todo", "con todito"]) assert((await crudo(q)).length === 0, q);
});
it("R10-2: «con queso tocino y guacamole» ofrece los TRES extras (sin tope de dos)", async () => {
  const r: any = await conExtras("tacos de pastor con queso tocino y guacamole");
  assert(JSON.stringify([...nombresExtras(r)].sort()) === JSON.stringify(["Extra Guacamole", "Extra Queso", "Extra Tocino"]), JSON.stringify(nombresExtras(r)));
  assert(r.productos.length > 0 && r.productos.some((x: any) => /pastor/i.test(x.name)), nombres(r.productos));
});
it("R10-5: «papas a la francesa con queso» son las papas + Extra Queso ofrecido (ya no se adivina que «papas» llevan queso)", async () => {
  const r: any = await conExtras("papas a la francesa con queso");
  assert(r.productos[0]?.name === "Papas a la Francesa", nombres(r.productos));
  assert(JSON.stringify(nombresExtras(r)) === JSON.stringify(["Extra Queso"]), JSON.stringify(nombresExtras(r)));
  // Tampoco se adivina por el nombre del platillo: la gringa/quesadilla/papas «con queso» se ofrecen igual (el
  // catalogo no dice que lo lleven) y la pregunta del agente lo resuelve.
  for (const q of ["gringa con queso", "papas con queso", "gringa de pastor con queso"]) {
    const x: any = await conExtras(q);
    assert(x.productos.length > 0 && JSON.stringify(nombresExtras(x)) === JSON.stringify(["Extra Queso"]), `«${q}» -> ${nombres(x.productos)} ${JSON.stringify(nombresExtras(x))}`);
  }
});
it("R10-3: un exacto por alias («Alambre Suizo de Pastor» lleva el alias «queso») no se salta los extras: «tacos de pastor con queso» son los de «tacos de pastor» + Extra Queso", async () => {
  for (const [q, plato] of [["tacos de pastor con queso", "tacos de pastor"], ["tacos de bistec con queso", "tacos de bistec"], ["tacos al pastor con guacamole", "tacos al pastor"]] as const) {
    const r: any = await conExtras(q);
    const base = (await crudo(plato)).map((x: any) => x.name);
    assert(JSON.stringify(r.productos.map((x: any) => x.name)) === JSON.stringify(base), `«${q}» -> ${nombres(r.productos)} vs «${plato}» ${JSON.stringify(base)}`);
    assert(r.productos.every((x: any) => !x.aproximado), nombres(r.productos));
    assert(JSON.stringify(nombresExtras(r)) === JSON.stringify([/queso/.test(q) ? "Extra Queso" : "Extra Guacamole"]), `«${q}» extras ${JSON.stringify(nombresExtras(r))}`);
    assert(!(r.productos.length === 1 && /alambre suizo/i.test(r.productos[0].name)), `«${q}»: el Alambre Suizo solo por las palabras «con queso»`);
  }
});
it("R10-4: «francés con piña» es el francés + Extra Piña ofrecido (nunca el Extra Piña solo como producto); en el pastor la piña sigue siendo nota", async () => {
  for (const q of ["francés con piña", "un francés con piña", "frances con piña"]) {
    const r: any = await conExtras(q);
    assert(r.productos.length > 0 && r.productos.every((x: any) => /franc/i.test(x.name) && !/^Extra /.test(x.name)), `«${q}» -> ${nombres(r.productos)}`);
    assert(JSON.stringify(nombresExtras(r)) === JSON.stringify(["Extra Piña"]), `«${q}» extras ${JSON.stringify(nombresExtras(r))}`);
  }
  const pastor: any = await conExtras("francés de pastor con piña");
  assert(pastor.productos.some((x: any) => x.name === "Francés Suizo de Pastor") && nombresExtras(pastor).length === 0, `${nombres(pastor.productos)} ${JSON.stringify(nombresExtras(pastor))}`);
  // Pedir el extra por su nombre sigue siendo el producto.
  const piña: any = await conExtras("extra piña");
  assert(piña.productos[0]?.name === "Extra Piña", nombres(piña.productos));
});
it("R10-6: «con poco/poca/poquito/menos X» pide MENOS (nota de cocina): no se ofrece el extra y el platillo se encuentra igual", async () => {
  const base = (await crudo("tacos de pastor")).map((x: any) => x.name);
  for (const q of ["tacos de pastor con poco queso", "tacos de pastor con poco guacamole", "tacos de pastor con poca salsa", "tacos de pastor con poquito queso", "tacos de pastor con menos queso", "tacos de pastor con pocos champiñones"]) {
    const r: any = await conExtras(q);
    assert(nombresExtras(r).length === 0, `«${q}» ofrece ${JSON.stringify(nombresExtras(r))}`);
    assert(JSON.stringify(r.productos.map((x: any) => x.name)) === JSON.stringify(base) && r.productos.every((x: any) => !x.aproximado), `«${q}» -> ${nombres(r.productos)}`);
  }
  // Solo lo que va con «poco» es nota: «con queso y poco guacamole» ofrece el queso, no el guacamole.
  const mixto: any = await conExtras("tacos de pastor con queso y poco guacamole");
  assert(JSON.stringify(nombresExtras(mixto)) === JSON.stringify(["Extra Queso"]), JSON.stringify(nombresExtras(mixto)));
  // «mucho» sigue siendo pedir mas: se ofrece (el agente pregunta).
  const mucho: any = await conExtras("tacos de pastor con mucho queso");
  assert(JSON.stringify(nombresExtras(mucho)) === JSON.stringify(["Extra Queso"]), JSON.stringify(nombresExtras(mucho)));
});
it("R10-7: «con extra de queso» salta el «de»; los extras de varias palabras («chile poblano») casan antes que la palabra suelta sin costo («chile»)", async () => {
  const base = (await crudo("tacos de pastor")).map((x: any) => x.name);
  for (const [q, extra] of [
    ["tacos de pastor con extra de queso", "Extra Queso"], ["tacos de pastor con extra queso", "Extra Queso"],
    ["tacos de pastor con chile poblano", "Extra Chile Poblano"], ["tacos de pastor con extra chile poblano", "Extra Chile Poblano"],
    ["tacos de pastor con extra de chile poblano", "Extra Chile Poblano"], ["tacos de pastor con queso y chile poblano", "Extra Queso,Extra Chile Poblano"],
  ] as const) {
    const r: any = await conExtras(q);
    assert(JSON.stringify(r.productos.map((x: any) => x.name)) === JSON.stringify(base) && r.productos.every((x: any) => !x.aproximado), `«${q}» -> ${nombres(r.productos)}`);
    assert(nombresExtras(r).join(",") === extra, `«${q}» extras ${JSON.stringify(nombresExtras(r))}`);
  }
  // «chile» solo (o «chile habanero») va incluido sin costo: nota, no el Extra Chile Poblano.
  for (const q of ["tacos de pastor con chile", "tacos de pastor con chile habanero"]) {
    const r: any = await conExtras(q);
    assert(nombresExtras(r).length === 0 && r.productos.every((x: any) => !x.aproximado) && r.productos.length > 0, `«${q}» -> ${nombres(r.productos)} ${JSON.stringify(nombresExtras(r))}`);
  }
  // Pedir el extra por su nombre es el producto.
  for (const [q, n] of [["extra de queso", "Extra Queso"], ["extra chile poblano", "Extra Chile Poblano"], ["extra de chile poblano", "Extra Chile Poblano"]] as const) {
    const r: any = await conExtras(q);
    assert(r.productos[0]?.name === n, `«${q}» -> ${nombres(r.productos)}`);
  }
});
it("R10-8: «orden de guacamole» es el Guacamole (la palabra «orden» no esta en su nombre); «orden de tacos» y «orden de 3» siguen igual", async () => {
  for (const q of ["orden de guacamole", "una orden de guacamole", "dos ordenes de guacamole", "orden de guacamole por favor"]) {
    const r = await crudo(q);
    assert(r[0]?.name === "Guacamole" && r.every((x: any) => !x.aproximado), `«${q}» -> ${nombres(r)}`);
  }
  const papas = await crudo("una orden de papas a la francesa");
  assert(papas[0]?.name === "Papas a la Francesa" && !papas[0].aproximado, nombres(papas));
  // Lo que ya casaba con «orden» en el nombre no cambia.
  const tacos = (await crudo("orden de tacos")).map((x: any) => x.name);
  assert(tacos[0] === "Tacos de Cochinita (orden de 4)" && tacos.length === 8 && tacos.every((n: string) => /orden de \d/.test(n)), JSON.stringify(tacos));
  const tres = (await crudo("orden de 3")).map((x: any) => x.name);
  assert(tres[0] === "Tacos de Chorizo (orden de 3)" && tres.includes("Orden Tortilla de Harina"), JSON.stringify(tres));
  // «orden» de algo que no existe sigue vacio (no se inventa).
  assert((await crudo("orden de sushi")).every((x: any) => x.aproximado), "orden de sushi");
});
it("R10-3b: la exacta manda si el CATALOGO dice que lo encontrado ya lo lleva (nombre, o descripcion de un platillo que el cliente nombro), no por un alias: «francés con guacamole» son los Francés Suizos sin extra", async () => {
  const frances: any = await conExtras("francés con guacamole");
  assert(frances.productos.length === 8 && frances.productos.every((x: any) => /^Francés Suizo/.test(x.name)) && nombresExtras(frances).length === 0, `${nombres(frances.productos)} ${JSON.stringify(nombresExtras(frances))}`);
  // R11-2 (migrado): «tortillas con queso» casaba las Flautas solo por su DESCRIPCION («Tortilla de maíz… queso
  // gratinado»), pero el cliente no nombro la flauta: son las tortillas + Extra Queso ofrecido, y la flauta sigue en la lista.
  const flautas: any = await conExtras("tortillas con queso");
  assert(/^Orden Tortilla/.test(flautas.productos[0]?.name ?? "") && flautas.productos.some((x: any) => /^Flauta/.test(x.name)) && nombresExtras(flautas).join() === "Extra Queso", `${nombres(flautas.productos)} ${JSON.stringify(nombresExtras(flautas))}`);
  // El alias no cuenta (R10-3) ni el propio extra (R10-4).
  assert(nombresExtras(await conExtras("tacos de pastor con queso")).join() === "Extra Queso", "alias");
  assert(nombresExtras(await conExtras("francés con piña")).join() === "Extra Piña", "extra");
});
it("R11-2: «pastor/arrachera/bistec con guacamole (y queso)» no es solo el Francés Suizo (que lo trae en la DESCRIPCION): son los del platillo + los extras ofrecidos; «francés con guacamole» sigue sin extra", async () => {
  for (const [q, plato, extras] of [
    ["pastor con guacamole", "pastor", "Extra Guacamole"],
    ["arrachera con guacamole", "arrachera", "Extra Guacamole"],
    ["arrachera con guacamole y queso", "arrachera", "Extra Guacamole,Extra Queso"],
    ["bistec con guacamole y queso", "bistec", "Extra Guacamole,Extra Queso"],
  ] as const) {
    const r: any = await conExtras(q);
    const base = (await crudo(plato)).map((x: any) => x.name);
    assert(r.productos.length > 1 && r.productos.some((x: any) => !/^Francés Suizo/.test(x.name)), `«${q}» -> ${nombres(r.productos)}`);
    assert(r.productos[0]?.name === base[0] && r.productos.every((x: any) => !x.aproximado), `«${q}» -> ${nombres(r.productos)} vs «${plato}» ${JSON.stringify(base)}`);
    assert([...nombresExtras(r)].sort().join(",") === extras, `«${q}» extras ${JSON.stringify(nombresExtras(r))}`);
  }
  // Lo que el cliente SI nombro por su nombre sigue mandando: el francés lo trae (descripcion), sin extra.
  for (const q of ["francés con guacamole", "francés suizo con guacamole", "francés de arrachera con guacamole"]) {
    const r: any = await conExtras(q);
    assert(r.productos.length > 0 && r.productos.every((x: any) => /^Francés Suizo/.test(x.name)) && nombresExtras(r).length === 0, `«${q}» -> ${nombres(r.productos)} ${JSON.stringify(nombresExtras(r))}`);
  }
});
it("R11-3: los cuantificadores con articulo, diminutivo, plural o tras coma («con un poco de queso», «con poquitito queso», «con extras de queso», «con guacamole, poco queso») nunca dejan la busqueda vacia: «poco» es nota, «extra(s)/mucho/doble» ofrece", async () => {
  const base = (await crudo("tacos de pastor")).map((x: any) => x.name);
  const casos: Array<[string, string]> = [
    // Pide MENOS: nota de cocina, sin extra.
    ["tacos de pastor con poquitito queso", ""], ["tacos de pastor con poquititito queso", ""],
    ["tacos de pastor con un poco de queso", ""], ["tacos de pastor con un poquito de guacamole", ""],
    ["tacos de pastor con un poquitito de queso", ""], ["tacos de pastor con poquitito de guacamole", ""],
    ["tacos de pastor con muy poco queso", ""], ["tacos de pastor con tantito queso", ""],
    // Pide MAS: se ofrece el extra.
    ["tacos de pastor con extras de queso", "Extra Queso"], ["tacos de pastor con doble queso", "Extra Queso"],
    ["tacos de pastor con mas queso", "Extra Queso"], ["tacos de pastor con más guacamole", "Extra Guacamole"],
    // Tras coma: cada ingrediente con su cuantificador.
    ["tacos de pastor con guacamole, poco queso", "Extra Guacamole"], ["tacos de pastor con queso, poco guacamole", "Extra Queso"],
    ["tacos de pastor con mucho queso, poco guacamole", "Extra Queso"], ["tacos de pastor con un poco de queso y guacamole", "Extra Guacamole"],
    ["tacos de pastor con queso y guacamole, poco chile poblano", "Extra Queso,Extra Guacamole"],
  ];
  for (const [q, extras] of casos) {
    const r: any = await conExtras(q);
    assert(JSON.stringify(r.productos.map((x: any) => x.name)) === JSON.stringify(base) && r.productos.every((x: any) => !x.aproximado), `«${q}» -> ${nombres(r.productos)}`);
    assert([...nombresExtras(r)].sort().join(",") === extras.split(",").filter(Boolean).sort().join(","), `«${q}» extras ${JSON.stringify(nombresExtras(r))}`);
  }
  // Sin «tacos de»: lo mismo con el platillo solo.
  const r: any = await conExtras("pastor con guacamole, poco queso");
  assert(r.productos.length > 1 && JSON.stringify(nombresExtras(r)) === JSON.stringify(["Extra Guacamole"]), `${nombres(r.productos)} ${JSON.stringify(nombresExtras(r))}`);
  const r2: any = await conExtras("pastor con poquitito queso");
  assert(r2.productos.length > 1 && nombresExtras(r2).length === 0 && r2.productos.every((x: any) => !x.aproximado), `${nombres(r2.productos)} ${JSON.stringify(nombresExtras(r2))}`);
});
it("R12-1: red de seguridad de «con/sin»: siempre se busca tambien el platillo ANTES del primer «con/sin»; sus resultados van primero (exactos) y lo que solo salio por las palabras del «con/sin» va aproximado", async () => {
  const base = (await crudo("tacos de pastor")).map((x: any) => x.name);
  // «con extras» solo: el cuantificador suelto sale; los del platillo, sin ningun extra ofrecido. Antes: vacio.
  const solo: any = await conExtras("tacos de pastor con extras");
  assert(JSON.stringify(solo.productos.map((x: any) => x.name)) === JSON.stringify(base) && solo.productos.every((x: any) => !x.aproximado) && nombresExtras(solo).length === 0, `«con extras» -> ${nombres(solo.productos)} ${JSON.stringify(nombresExtras(solo))}`);
  // Lo que el «con» no logra entender ya no deja la lista vacia: los del platillo («con una coca» se busca aparte).
  const coca: any = await conExtras("tacos de pastor con una coca");
  assert(JSON.stringify(coca.productos.map((x: any) => x.name)) === JSON.stringify(base), `«con una coca» -> ${nombres(coca.productos)}`);
  // El producto cuyo NOMBRE lleva el platillo y el «con X» sigue siendo exacto (y primero).
  for (const [q, primero] of [
    ["boyo con queso", "Boyo-Hamburguesa con Queso"], ["limonada con topo chico", "Limonada con Topo Chico"],
    ["frijoles charros con queso", "Frijoles Charros con Queso"], ["coca sin azucar", "Coca-Cola sin Azúcar"],
    ["queso fundido con chorizo", "Queso Fundido Chorizo"], ["margarita sin alcohol", "Margarita sin Alcohol"],
  ] as const) {
    const r: any = await conExtras(q);
    assert(r.productos[0]?.name === primero && !r.productos[0]?.aproximado, `«${q}» -> ${nombres(r.productos)}`);
  }
  const encebollado = await crudo("bistec con cebolla");
  assert(encebollado.some((x: any) => /Encebollado/.test(x.name) && !x.aproximado), `«bistec con cebolla» -> ${nombres(encebollado)}`);
  // Lo excluido con «sin» no vuelve por la base: «chicharrón sin queso» no es el Chicharrón de Queso; «cerveza sin alcohol» sigue siendo la 0.0.
  const chicharron = await crudo("chicharron sin queso con guacamole");
  assert(!chicharron.some((x: any) => /Chicharr[oó]n de Queso/.test(x.name) && !x.aproximado), `el excluido volvio exacto por la base: ${nombres(chicharron)}`);
  assert(JSON.stringify((await crudo("cerveza sin alcohol")).map((x: any) => x.name)) === JSON.stringify(["Heineken 0.0"]), "cerveza sin alcohol");
});
it("R12-1b: si la completa solo casa un producto por la DESCRIPCION/alias de lo del «con X» (y su nombre no empieza por el platillo), los del platillo van primero y exactos; ese producto sigue en la lista", async () => {
  const filas = [
    { price: 30, is_available: true, products: { id: "p1", name: "Taco de Pastor", description: "Orden individual", restaurant_id: "r1", search_keywords: [], categories: { name: "Tacos" } } },
    { price: 90, is_available: true, products: { id: "p2", name: "Volcán Gratinado", description: "Taco dorado de pastor con queso gratinado", restaurant_id: "r1", search_keywords: [], categories: { name: "Especialidades" } } },
    { price: 120, is_available: true, products: { id: "p3", name: "Plato de Bistec", description: "Bistec con queso", restaurant_id: "r1", search_keywords: [], categories: { name: "Platos" } } },
  ];
  const q: any = { select: () => q, eq: () => q, limit: () => Promise.resolve({ data: filas, error: null }) };
  const r: any = await pedidos.buscarProductosConExtrasCore({ from: () => q }, { branchId: "b1", restaurantId: "r1", query: "taco de pastor con queso" });
  assert(r.productos[0]?.name === "Taco de Pastor" && r.productos.every((x: any) => !x.aproximado), `el del platillo no va primero/exacto: ${nombres(r.productos)}`);
  assert(r.productos.some((x: any) => x.name === "Volcán Gratinado") && !r.productos.some((x: any) => x.name === "Plato de Bistec"), nombres(r.productos));
});
it("R12-2: «o» entre extras («con guacamole o queso») ofrece los dos extras; el agente pregunta cual", async () => {
  const base = (await crudo("tacos de pastor")).map((x: any) => x.name);
  // «o» entre extras: se ofrecen los dos (el agente pregunta cual). Antes: solo el Alambre Suizo de Pastor (por su alias «queso»).
  const o: any = await conExtras("tacos de pastor con guacamole o queso");
  assert(JSON.stringify(o.productos.map((x: any) => x.name)) === JSON.stringify(base) && o.productos.every((x: any) => !x.aproximado), `«o» -> ${nombres(o.productos)}`);
  assert([...nombresExtras(o)].sort().join(",") === "Extra Guacamole,Extra Queso", `«o» extras ${JSON.stringify(nombresExtras(o))}`);
});
it("R12-3: un cardinal antes de «extra(s)» («dos/2/tres extras de queso») ofrece el extra; el agente confirma la cantidad", async () => {
  const base = (await crudo("tacos de pastor")).map((x: any) => x.name);
  const basePastor = (await crudo("pastor")).map((x: any) => x.name);
  // Cardinal antes de «extra(s)»: se ofrece el extra; el agente confirma la cantidad. Antes: solo el Chetaco de Pastor.
  for (const [q, b] of [
    ["pastor con dos extras de queso", basePastor], ["tacos de pastor con 2 extras de queso", base],
    ["tacos de pastor con tres extras de queso", base], ["tacos de pastor con dos extra queso", base],
  ] as const) {
    const r: any = await conExtras(q);
    // R13: los del platillo van primero, tal cual; despues solo pueden ir los que ya traen el queso (Chetaco de Pastor).
    const fx = r.productos.map((x: any) => x.name);
    assert(JSON.stringify(fx.slice(0, b.length)) === JSON.stringify(b) && r.productos.every((x: any) => !x.aproximado), `«${q}» -> ${nombres(r.productos)}`);
    assert(fx.slice(b.length).every((n: string) => /Chetaco|Quesobich|Francés Suizo|Flauta/.test(n)), `«${q}» despues del platillo: ${nombres(r.productos)}`);
    assert(nombresExtras(r).join(",") === "Extra Queso", `«${q}» extras ${JSON.stringify(nombresExtras(r))}`);
  }
});
it("R12-1c: un producto del menu en plural tras el «con» («pastor con 3 cocas», «con unos refrescos») es otro producto, no algo desconocido: los del platillo van exactos", async () => {
  const basePastor = (await crudo("pastor")).map((x: any) => x.name);
  for (const q of ["pastor con 3 cocas", "pastor con dos coca colas", "pastor con unos refrescos"]) {
    const r = await crudo(q);
    assert(JSON.stringify(r.map((x: any) => x.name)) === JSON.stringify(basePastor) && r.every((x: any) => !x.aproximado), `«${q}» -> ${nombres(r)}`);
  }
});
it("R13-4: «arrachera con guacamole» / «bistec con guacamole y queso»: los del platillo primero (exactos) + el extra ofrecido, y el Francés Suizo que SI trae guacamole (descripcion) se queda despues, no se tira", async () => {
  for (const [q, plato, frances, extras] of [
    ["arrachera con guacamole", "arrachera", "Francés Suizo de Arrachera", "Extra Guacamole"],
    ["arrachera con guacamole y queso", "arrachera", "Francés Suizo de Arrachera", "Extra Guacamole,Extra Queso"],
    ["bistec con guacamole y queso", "bistec", "Francés Suizo de Bistec de Res", "Extra Guacamole,Extra Queso"],
  ] as const) {
    const r: any = await conExtras(q);
    const base = (await crudo(plato)).map((x: any) => x.name);
    const nombresR = r.productos.map((x: any) => x.name);
    assert(JSON.stringify(nombresR.slice(0, base.length)) === JSON.stringify(base) && r.productos.every((x: any) => !x.aproximado), `«${q}» -> ${nombres(r.productos)} vs «${plato}» ${JSON.stringify(base)}`);
    assert(nombresR.indexOf(frances) >= base.length, `«${q}»: ${frances} se tiro o va antes del platillo: ${nombres(r.productos)}`);
    assert([...nombresExtras(r)].sort().join(",") === extras, `«${q}» extras ${JSON.stringify(nombresExtras(r))}`);
  }
});
it("R13-3: «pastor con queso sin cebolla» (y sin el «sin») son los de «pastor» primero, exactos, + Extra Queso; lo que lleva el queso (Quesobich de Pastor) se queda, despues", async () => {
  const base = (await crudo("pastor")).map((x: any) => x.name);
  for (const q of ["pastor con queso sin cebolla", "pastor sin cebolla con queso", "pastor con queso"]) {
    const r: any = await conExtras(q);
    const nombresR = r.productos.map((x: any) => x.name);
    assert(JSON.stringify(nombresR.slice(0, base.length)) === JSON.stringify(base) && r.productos.every((x: any) => !x.aproximado), `«${q}» -> ${nombres(r.productos)}`);
    assert(nombresR.indexOf("Quesobich de Pastor") >= base.length, `«${q}»: el Quesobich se tiro o va antes: ${nombres(r.productos)}`);
    assert(nombresExtras(r).join(",") === "Extra Queso", `«${q}» extras ${JSON.stringify(nombresExtras(r))}`);
  }
  // Lo que se llama con la palabra COMPLETA sigue mandando.
  for (const [q, primero] of [["boyo con queso sin cebolla", "Boyo-Hamburguesa con Queso"], ["frijoles charros con queso", "Frijoles Charros con Queso"]] as const) {
    const r: any = await conExtras(q);
    assert(r.productos[0]?.name === primero && nombresExtras(r).length === 0, `«${q}» -> ${nombres(r.productos)} ${JSON.stringify(nombresExtras(r))}`);
  }
});
it("R14-1: «X y/e/o/, Y» (o una cantidad nueva: «4 pastor 2 bistec») SIEMPRE: el platillo de antes del primer separador en productos y cada otra parte en otros_productos con su busqueda, aunque la completa tuviera exactos o el menu no la tenga ([])", async () => {
  for (const [q, plato, partes, debeTraer] of [
    ["tacos de pastor y una cerveza", "tacos de pastor", ["una cerveza"], "Sol"],
    ["tacos de pastor y 2 cervezas", "tacos de pastor", ["2 cervezas"], "Sol"],
    ["tacos de pastor y 2 jarritos", "tacos de pastor", ["2 jarritos"], ""],
    ["3 tacos de bistec y 2 jarritos", "3 tacos de bistec", ["2 jarritos"], ""],
    ["agua de horchata y 2 jarritos de tamarindo", "agua de horchata", ["2 jarritos de tamarindo"], ""],
    ["quesobich de bistec y 2 jarritos", "quesobich de bistec", ["2 jarritos"], ""],
    ["con una coca y 2 tacos de pastor", "una coca", ["2 tacos de pastor"], "Taco Al Pastor (individual)"],
    ["tacos de pastor o una coca", "tacos de pastor", ["una coca"], "Coca-Cola"],
    ["tacos de pastor o bistec y 2 cocas", "tacos de pastor", ["bistec", "2 cocas"], "Coca-Cola"],
    ["4 pastor 2 bistec y una coca", "4 pastor", ["2 bistec", "una coca"], "Coca-Cola"],
    ["pastor 1 kg y una coca", "pastor 1 kg", ["una coca"], "Coca-Cola"],
  ] as const) {
    const r: any = await conExtras(q);
    const base = (await crudo(plato)).map((x: any) => x.name);
    assert(base.length > 0 && JSON.stringify(r.productos.map((x: any) => x.name)) === JSON.stringify(base), `«${q}» productos ${nombres(r.productos)} vs «${plato}» ${JSON.stringify(base)}`);
    const textos = (r.otros_productos ?? []).map((o: any) => o.texto);
    assert(JSON.stringify(textos) === JSON.stringify(partes), `«${q}» otros ${JSON.stringify(otrosDe(r))}`);
    const ultimo = r.otros_productos[r.otros_productos.length - 1];
    if (debeTraer) assert(r.otros_productos.some((o: any) => o.resultados.some((x: any) => x.name === debeTraer)), `«${q}» sin ${debeTraer}: ${JSON.stringify(otrosDe(r))}`);
    else assert(ultimo.resultados.length === 0, `«${q}»: lo que el menu no tiene trajo resultados ${JSON.stringify(otrosDe(r))}`);
  }
  // Un extra con costo sin «con» («y queso»): va aparte con el extra del menu, marcado es_extra (el agente pregunta).
  const queso: any = await conExtras("tacos de pastor y queso");
  assert(JSON.stringify(queso.productos.map((x: any) => x.name)) === JSON.stringify((await crudo("tacos de pastor")).map((x: any) => x.name)), `«y queso» productos ${nombres(queso.productos)}`);
  assert(JSON.stringify(otrosDe(queso)) === JSON.stringify(["queso=>Extra Queso"]) && queso.otros_productos[0].es_extra === true, `«y queso» otros ${JSON.stringify(queso.otros_productos)}`);
  // Lo que NO se parte: un nombre del menu que lleva la «y», una fraccion, un numero que es tamano o cantidad del mismo.
  for (const [q, primero] of [
    ["chile poblano y bistec", "Tacos Suizos de Chile Poblano y Bistec"],
    ["tacos suizos de chile poblano y arrachera", "Tacos Suizos de Chile Poblano y Arrachera"],
    ["kilo y medio de pastor", "Pastor — 1.5 kg"],
    ["heineken 0 punto 0", ""],
    ["coca de 2 litros", ""],
    ["quiero 4 tacos de pastor", "Taco Al Pastor (individual)"],
  ] as const) {
    const r: any = await conExtras(q);
    assert(!r.otros_productos && (!primero || r.productos[0]?.name === primero), `«${q}» -> ${nombres(r.productos)} otros ${JSON.stringify(otrosDe(r))}`);
  }
});
it("R14-2: entrega, pago y cortesia («para llevar», «a domicilio», «para recoger», «con tarjeta», «gracias», «por favor», «para mi esposa») no son productos ni partes del pedido; y una parte nunca es producto solo por la CATEGORIA («domicilio» no es «Kilos a Domicilio»)", async () => {
  const tacos = (await crudo("tacos de pastor")).map((x: any) => x.name);
  for (const q of [
    "tacos de pastor y una coca para llevar", "tacos de pastor y una coca a domicilio", "dos tacos de pastor y una coca para recoger",
    "tacos de pastor y una coca con tarjeta", "tacos de pastor con tarjeta y una coca", "tacos de pastor con cambio de 500 y una coca",
    "tacos de pastor y una coca gracias", "tacos de pastor y una coca por favor", "tacos de pastor y una coca para mi esposa",
    "tacos de pastor y una coca, para recoger", "tacos de pastor y una coca en efectivo",
  ]) {
    const r: any = await conExtras(q);
    assert(JSON.stringify(r.productos.map((x: any) => x.name)) === JSON.stringify(tacos) && r.productos.every((x: any) => !x.aproximado), `«${q}» productos ${nombres(r.productos)}`);
    assert(JSON.stringify((r.otros_productos ?? []).map((o: any) => o.texto)) === JSON.stringify(["una coca"]), `«${q}» otros ${JSON.stringify(otrosDe(r))}`);
    assert(r.otros_productos[0].resultados.some((x: any) => x.name === "Coca-Cola"), `«${q}» sin Coca-Cola: ${JSON.stringify(otrosDe(r))}`);
  }
  // Solos: el producto, sin la logistica (antes «tacos de pastor para llevar» volvia vacio y «pastor a domicilio» solo los kilos).
  for (const [q, plato] of [["tacos de pastor para llevar", "tacos de pastor"], ["pastor a domicilio", "pastor"], ["tacos de pastor, gracias", "tacos de pastor"], ["tacos de pastor y a domicilio", "tacos de pastor"]] as const) {
    const r: any = await conExtras(q);
    assert(JSON.stringify(r.productos.map((x: any) => x.name)) === JSON.stringify((await crudo(plato)).map((x: any) => x.name)) && !r.otros_productos, `«${q}» -> ${nombres(r.productos)} otros ${JSON.stringify(otrosDe(r))}`);
  }
  // «domicilio» suelto solo esta en la categoria «Kilos a Domicilio»: no es un producto (resultados []).
  const dom: any = await conExtras("tacos de pastor y domicilio");
  assert(JSON.stringify(otrosDe(dom)) === JSON.stringify(["domicilio=>"]), `«y domicilio» otros ${JSON.stringify(otrosDe(dom))}`);
  // La palabra que ES la categoria si cuenta («un refresco», «una cerveza»).
  const ref: any = await conExtras("tacos de pastor y un refresco");
  assert(ref.otros_productos?.[0]?.resultados.some((x: any) => x.name === "Coca-Cola"), `«y un refresco» otros ${JSON.stringify(otrosDe(ref))}`);
  // Lo que se llama «para N» sigue siendo el producto.
  const parr = (await crudo("parrillada para 4 personas")).map((x: any) => x.name);
  assert(parr[0] === "Parrillada para 4", `parrillada para 4 personas -> ${JSON.stringify(parr)}`);
});
it("R14-3: el relleno tras unos tacos («tacos de pastor y bistec», «tacos de bistec y de pastor», «2 pastor y 3 bistec») va en otros_productos con relleno_de y los TACOS de ese relleno primero (no el Platillo ni el kilo)", async () => {
  for (const [q, texto, plato, primero] of [
    ["tacos de pastor y bistec", "bistec", "tacos", "Tacos de Bistec de Res (orden de 3)"],
    ["tacos de pastor o bistec", "bistec", "tacos", "Tacos de Bistec de Res (orden de 3)"],
    ["tacos de bistec y de pastor", "de pastor", "tacos", "Taco Al Pastor (individual)"],
    ["2 pastor y 3 bistec", "3 bistec", "tacos", "Tacos de Bistec de Res (orden de 3)"],
    ["un pastor y un bistec", "un bistec", "tacos", "Tacos de Bistec de Res (orden de 3)"],
    ["tacos de pastor sin cebolla y bistec", "bistec", "tacos", "Tacos de Bistec de Res (orden de 3)"],
    ["tacos de pastor con cebolla y bistec", "bistec", "tacos", "Tacos de Bistec de Res (orden de 3)"],
    ["gringa de pastor y bistec", "bistec", "gringa", "Gringa de Bistec"],
  ] as const) {
    const r: any = await conExtras(q);
    const o = (r.otros_productos ?? []).find((x: any) => x.texto === texto);
    assert(o && o.relleno_de === plato && o.resultados[0]?.name === primero, `«${q}» otros ${JSON.stringify((r.otros_productos ?? []).map((x: any) => ({ texto: x.texto, relleno_de: x.relleno_de, r: x.resultados.slice(0, 3).map((y: any) => y.name) })))}`);
    // El platillo y el kilo siguen ahi (despues), por si el cliente si los queria.
    if (plato === "tacos" && /bistec/.test(texto)) assert(o.resultados.findIndex((x: any) => x.name === "Platillo de Bistec") > o.resultados.findIndex((x: any) => /^Tacos de Bistec/.test(x.name)), `«${q}» orden ${JSON.stringify(o.resultados.map((x: any) => x.name))}`);
  }
  // Lo que no es relleno: otra bebida, la parte que ya nombra su platillo, o un tamano.
  for (const [q, texto] of [
    ["tacos de pastor y una coca", "una coca"], ["tacos de pastor y tacos de bistec", "tacos de bistec"],
    ["tacos de pastor y una gringa de bistec", "una gringa de bistec"], ["medio kilo de pastor y bistec", "bistec"],
  ] as const) {
    const r: any = await conExtras(q);
    const o = (r.otros_productos ?? []).find((x: any) => x.texto === texto);
    assert(o && o.relleno_de === undefined, `«${q}» otros ${JSON.stringify(r.otros_productos)}`);
  }
});
it("R15-1: «ordenes/órdenes de pastor» es como «orden de pastor» (los platillos de pastor), no solo los Nachos (1/2 orden)", async () => {
  const singular = (await crudo("orden de pastor")).map((x: any) => x.name);
  assert(singular.includes("Taco Al Pastor (individual)") && singular.includes("Gringa de Pastor"), `orden de pastor -> ${JSON.stringify(singular)}`);
  for (const q of ["2 ordenes de pastor", "ordenes de pastor", "dos ordenes de pastor", "2 órdenes de pastor", "dos órdenes de pastor"]) {
    const r = (await crudo(q)).map((x: any) => x.name);
    assert(JSON.stringify(r) === JSON.stringify(singular), `«${q}» -> ${JSON.stringify(r)} vs ${JSON.stringify(singular)}`);
  }
  const conCoca: any = await conExtras("2 ordenes de pastor y una coca");
  assert(conCoca.productos.some((x: any) => x.name === "Taco Al Pastor (individual)"), `«2 ordenes de pastor y una coca» productos ${nombres(conCoca.productos)}`);
  assert(JSON.stringify((conCoca.otros_productos ?? []).map((o: any) => o.texto)) === JSON.stringify(["una coca"]), `otros ${JSON.stringify(otrosDe(conCoca))}`);
  // Sin nada con «orden», se busca sin esa palabra (igual que el singular).
  for (const q of ["2 ordenes de guacamole", "ordenes de flautas de pastor"]) {
    const r = (await crudo(q)).map((x: any) => x.name);
    const s = (await crudo(q.replace(/^\d+ /, "").replace("ordenes", "orden"))).map((x: any) => x.name);
    assert(r.length > 0 && JSON.stringify(r) === JSON.stringify(s), `«${q}» -> ${JSON.stringify(r)} vs ${JSON.stringify(s)}`);
  }
});
it("R15-2: el relleno tras unos tacos que TAMBIEN es un extra con costo («tacos de pastor y champiñones») son tacos de ese relleno primero (relleno_de), con el extra despues", async () => {
  for (const [q, texto, primero, extra] of [
    ["tacos de pastor y champiñones", "champiñones", "Taco de Champiñones (individual)", "Extra Champiñón"],
    ["tacos de bistec y chorizo", "chorizo", "Tacos de Chorizo (orden de 3)", "Extra Chorizo"],
    ["tacos de pastor y rajas", "rajas", "Taco de Rajas (individual)", "Extra Rajas"],
    ["tacos de champiñones y chorizo", "chorizo", "Tacos de Chorizo (orden de 3)", "Extra Chorizo"],
  ] as const) {
    const r: any = await conExtras(q);
    const o = (r.otros_productos ?? []).find((x: any) => x.texto === texto);
    assert(o && o.relleno_de === "tacos" && o.resultados[0]?.name === primero && !o.es_extra, `«${q}» otros ${JSON.stringify(r.otros_productos)}`);
    assert(o.resultados.some((x: any) => x.name === extra), `«${q}»: el extra ya no es opcion ${JSON.stringify(otrosDe(r))}`);
  }
  // Sin tacos de ese relleno, sigue siendo el extra.
  const queso: any = await conExtras("tacos de pastor y queso");
  assert(queso.otros_productos?.[0]?.es_extra === true && queso.otros_productos[0].resultados[0]?.name === "Extra Queso", `«y queso» ${JSON.stringify(queso.otros_productos)}`);
});
it("R15-3: «(N) orden(es) de X» como otra parte del pedido busca X («y 1 orden de guacamole» -> Guacamole), no []", async () => {
  for (const [q, texto, primero] of [
    ["3 tacos de pastor y 1 orden de guacamole", "1 orden de guacamole", "Guacamole"],
    ["tacos de pastor y 2 ordenes de guacamole", "2 ordenes de guacamole", "Guacamole"],
    ["tacos de pastor y orden de queso fundido", "orden de queso fundido", "Queso Fundido Natural"],
    ["tacos de pastor y orden de flautas de pastor", "orden de flautas de pastor", "Flauta de Pastor"],
    ["tacos de pastor y orden de chetacos", "orden de chetacos", "Chetaco de Pastor"],
    ["una coca y una orden de tacos de bistec", "una orden de tacos de bistec", "Tacos de Bistec de Res (orden de 3)"],
  ] as const) {
    const r: any = await conExtras(q);
    const o = (r.otros_productos ?? []).find((x: any) => x.texto === texto);
    assert(o && o.resultados[0]?.name === primero && !o.es_extra, `«${q}» otros ${JSON.stringify(r.otros_productos)}`);
  }
  // Lo que se llama con «orden» sigue casando con su nombre.
  const pap: any = await conExtras("tacos de cochinita y papadzules (orden de 5)");
  assert(pap.otros_productos?.[0]?.resultados[0]?.name === "Papadzules (orden de 5)", `papadzules ${JSON.stringify(otrosDe(pap))}`);
});
it("R15-4: «(1) orden de papas» son las Papas (Papa Tradicional, Papas a la Francesa…) antes que los Papadzules; si solo quedan los Papadzules por prefijo, van aproximados", async () => {
  for (const q of ["1 orden de papas", "orden de papas", "una orden de papas"]) {
    const r = await crudo(q);
    assert(r.length > 0 && /^Papas? /.test(r[0].name) && !r[0].aproximado, `«${q}» -> ${nombres(r)}`);
    const iPapadzules = r.findIndex((x: any) => /^Papadzules/.test(x.name));
    assert(iPapadzules < 0 || iPapadzules > 0, `«${q}» Papadzules primero: ${nombres(r)}`);
  }
  const soloPapadzules = bdFiltrada((n) => !/^Papas? /.test(n));
  for (const q of ["orden de papas", "papas"]) {
    const r = await pedidos.buscarProductosCore(soloPapadzules, { branchId: "b1", restaurantId: "r1", query: q });
    assert(r.length > 0 && r.every((x: any) => x.aproximado === true), `«${q}» sin Papas en el menu -> ${nombres(r)}`);
  }
  // Un nombre que SI empieza asi como palabra completa no cambia.
  const pastor = await crudo("papas pastor");
  assert(pastor[0]?.name === "Papa Pastor" && !pastor[0].aproximado, `papas pastor -> ${nombres(pastor)}`);
});
it("R15-5: una parte que ya es parte del NOMBRE del producto de la base no va en otros_productos («frijol con tostada y 2 cocas»: la tostada es del Frijol con Tostada)", async () => {
  for (const [q, primero, partes] of [
    ["frijol con tostada y 2 cocas", "Frijol con Tostada", ["2 cocas"]],
    ["limonada con topo chico y 2 tacos de pastor", "Limonada con Topo Chico", ["2 tacos de pastor"]],
    ["tacos suizos de chile poblano y arrachera y una coca", "Tacos Suizos de Chile Poblano y Arrachera", ["una coca"]],
  ] as const) {
    const r: any = await conExtras(q);
    assert(r.productos[0]?.name === primero, `«${q}» productos ${nombres(r.productos)}`);
    assert(JSON.stringify((r.otros_productos ?? []).map((o: any) => o.texto)) === JSON.stringify(partes), `«${q}» otros ${JSON.stringify(otrosDe(r))}`);
  }
  // Otro producto que no es parte del nombre sigue saliendo.
  const r: any = await conExtras("tacos de pastor y bistec");
  assert((r.otros_productos ?? []).some((o: any) => o.texto === "bistec"), `«tacos de pastor y bistec» ${JSON.stringify(otrosDe(r))}`);
});
it("R15-6: «para el/la <algo>» solo es logistica si es una PERSONA («para el niño», «para mi esposa»); «un taco para el pastor» sigue siendo pastor", async () => {
  const taco = await crudo("un taco para el pastor");
  assert(taco[0]?.name === "Taco Al Pastor (individual)" && !taco[0].aproximado, `un taco para el pastor -> ${nombres(taco)}`);
  const tacos = (await crudo("2 tacos de pastor")).map((x: any) => x.name);
  for (const q of ["2 tacos de pastor para el niño", "2 tacos de pastor para la niña", "2 tacos de pastor para mi esposa", "2 tacos de pastor para mis hijos", "2 tacos de pastor para ella", "2 tacos de pastor para la señora"]) {
    const r: any = await conExtras(q);
    assert(JSON.stringify(r.productos.map((x: any) => x.name)) === JSON.stringify(tacos) && r.productos.every((x: any) => !x.aproximado) && !r.otros_productos, `«${q}» -> ${nombres(r.productos)} otros ${JSON.stringify(otrosDe(r))}`);
  }
});
it("R15-7: «pago con 500 (pesos)», «pagando con 200», «con billete de 500» son pago, no producto", async () => {
  const tacos = (await crudo("2 tacos de pastor")).map((x: any) => x.name);
  for (const q of ["2 tacos de pastor pago con 500 pesos", "2 tacos de pastor pagando con 200", "2 tacos de pastor con billete de 500", "2 tacos de pastor con un billete de 500 y una coca", "2 tacos de pastor, pago con $500"]) {
    const r: any = await conExtras(q);
    assert(JSON.stringify(r.productos.map((x: any) => x.name)) === JSON.stringify(tacos) && r.productos.every((x: any) => !x.aproximado), `«${q}» -> ${nombres(r.productos)}`);
    const textos = (r.otros_productos ?? []).map((o: any) => o.texto);
    assert(textos.every((t: string) => t === "una coca"), `«${q}» otros ${JSON.stringify(otrosDe(r))}`);
  }
});
it("R15-8: «6 pack», «12 pack», «sixpack», «caguama» tras una cerveza: ni se parte ni estorba a la busqueda (la cerveza va aproximada)", async () => {
  for (const [q, primero, partes] of [
    ["heineken 6 pack", "Heineken", []],
    ["heineken 12 pack y 2 tacos", "Heineken", ["2 tacos"]],
    ["sol sixpack", "Sol", []],
    ["una sol six pack y una coca", "Sol", ["una coca"]],
    ["indio caguama", "Indio", []],
  ] as const) {
    const r: any = await conExtras(q);
    assert(r.productos[0]?.name === primero && r.productos[0].aproximado && r.productos[0].presentacion_no_disponible, `«${q}» productos ${nombres(r.productos)}`);
    assert(JSON.stringify((r.otros_productos ?? []).map((o: any) => o.texto)) === JSON.stringify(partes), `«${q}» otros ${JSON.stringify(otrosDe(r))}`);
  }
});
it("R15-9: «1 y 1/2 kilos», «uno y medio», «2 y 1/2» son una fraccion del mismo producto, no otra parte", async () => {
  for (const q of ["1 y 1/2 kilos de pastor", "uno y medio de pastor", "2 y 1/2 kilos de pastor", "un kilo y 1/2 de pastor"]) {
    const r: any = await conExtras(q);
    assert(!r.otros_productos, `«${q}» otros ${JSON.stringify(otrosDe(r))}`);
  }
  const kilo = await crudo("1 y 1/2 kilos de pastor");
  assert(kilo[0]?.name === "Pastor — 1.5 kg", `1 y 1/2 kilos de pastor -> ${nombres(kilo)}`);
});
it("R15-10: el texto de otra parte conserva su puntuacion de cierre («papadzules (orden de 5)»)", async () => {
  const r: any = await conExtras("tacos de cochinita y papadzules (orden de 5)");
  assert(r.otros_productos?.[0]?.texto === "papadzules (orden de 5)", `otros ${JSON.stringify(otrosDe(r))}`);
  const c: any = await conExtras("tacos de pastor y una coca (de lata)");
  assert(c.otros_productos?.[0]?.texto === "una coca (de lata)", `otros ${JSON.stringify(otrosDe(c))}`);
});
it("R15-13: «heineken 0 punto 0» y «0 punto 0» son la Heineken 0.0 (como «cero punto cero»)", async () => {
  for (const q of ["heineken 0 punto 0", "una 0 punto 0", "heineken cero punto 0"]) {
    const r = await crudo(q);
    assert(r[0]?.name === "Heineken 0.0", `«${q}» -> ${nombres(r)}`);
  }
  const conTacos: any = await conExtras("heineken 0 punto 0 y 2 tacos");
  assert(conTacos.productos[0]?.name === "Heineken 0.0" && JSON.stringify((conTacos.otros_productos ?? []).map((o: any) => o.texto)) === JSON.stringify(["2 tacos"]), `«heineken 0 punto 0 y 2 tacos» ${nombres(conTacos.productos)} ${JSON.stringify(otrosDe(conTacos))}`);
});
it("R15-14: «N piezas de X» busca X («6 piezas de pastor» -> los de pastor), no vacio", async () => {
  for (const [q, plato] of [["6 piezas de pastor", "6 de pastor"], ["3 pzas de bistec", "3 de bistec"], ["4 piezas de tacos de pastor", "4 tacos de pastor"]] as const) {
    const r = await crudo(q);
    const s = (await crudo(plato)).map((x: any) => x.name);
    assert(r.length > 0 && r.every((x: any) => !x.aproximado) && JSON.stringify(r.map((x: any) => x.name)) === JSON.stringify(s), `«${q}» -> ${nombres(r)} vs ${JSON.stringify(s)}`);
  }
  const conCocas: any = await conExtras("tacos de pastor 3 piezas y 2 cocas");
  assert(conCocas.productos.some((x: any) => x.name === "Taco Al Pastor (individual)"), `«tacos de pastor 3 piezas y 2 cocas» ${nombres(conCocas.productos)}`);
});
it("R16-1: «six pack», «6 pack», «caguama» que el menu no tiene: la cerveza va aproximada y con presentacion_no_disponible, nunca exacta", async () => {
  for (const [q, cerveza, presentacion] of [
    ["sol sixpack", "Sol", "six pack"],
    ["un six pack de sol", "Sol", "six pack"],
    ["sol caguama", "Sol", "caguama"],
    ["dos caguamas de sol", "Sol", "caguama"],
    ["heineken 6 pack", "Heineken", "six pack"],
    ["indio caguama", "Indio", "caguama"],
  ] as const) {
    const r: any = await conExtras(q);
    assert(r.productos[0]?.name === cerveza, `«${q}» productos ${nombres(r.productos)}`);
    assert(r.productos.length > 0 && r.productos.every((x: any) => x.aproximado === true && x.presentacion_no_disponible === presentacion), `«${q}» no va aproximada con su presentacion: ${JSON.stringify(r.productos.map((x: any) => [x.name, x.aproximado, x.presentacion_no_disponible]))}`);
    assert(!r.otros_productos, `«${q}» otros ${JSON.stringify(otrosDe(r))}`);
  }
  const mixto: any = await conExtras("quiero un heineken six pack y dos sol caguama");
  assert(mixto.productos.some((x: any) => x.name === "Heineken") && mixto.productos.every((x: any) => x.aproximado && x.presentacion_no_disponible === "six pack"), `mixto productos ${JSON.stringify(mixto.productos.map((x: any) => [x.name, x.aproximado, x.presentacion_no_disponible]))}`);
  const sol = mixto.otros_productos?.[0];
  assert(mixto.otros_productos?.length === 1 && /sol caguama/.test(sol.texto) && sol.resultados[0]?.name === "Sol" && sol.resultados.every((x: any) => x.aproximado && x.presentacion_no_disponible === "caguama"), `mixto otros ${JSON.stringify(mixto.otros_productos)}`);
  // Sin presentacion, la cerveza sigue exacta y sin el campo.
  const sola: any = await conExtras("una sol");
  assert(sola.productos[0]?.name === "Sol" && !sola.productos[0].aproximado && !("presentacion_no_disponible" in sola.productos[0]), `una sol ${nombres(sola.productos)}`);
});
it("R16-1: si el menu SI tiene la presentacion («Sol Caguama»), esa va exacta y la botella aproximada", async () => {
  const bd: any = bdFixture();
  const original = bd.from().limit;
  const q: any = {
    select: () => q, eq: () => q,
    limit: async (...a: unknown[]) => {
      const { data } = await original(...a);
      const sol = data.find((r: any) => r.products.name === "Sol");
      return { data: [...data, { ...sol, price: 120, products: { ...sol.products, id: "sol-caguama", name: "Sol Caguama" } }], error: null };
    },
  };
  const r: any = await pedidos.buscarProductosConExtrasCore({ from: () => q }, { branchId: "b1", restaurantId: "r1", query: "sol caguama" });
  assert(r.productos[0]?.name === "Sol Caguama" && !r.productos[0].aproximado, `sol caguama ${nombres(r.productos)}`);
  assert(r.productos.filter((x: any) => x.name === "Sol").every((x: any) => x.aproximado), `la botella va exacta: ${nombres(r.productos)}`);
});
it("R16-2: una parte que repite palabras de la anterior («una heineken y una heineken 0.0», «dos cocas y una coca light») es OTRO producto: no se pierde", async () => {
  for (const [q, base, otroTexto, otro] of [
    ["una heineken y una heineken 0.0", "Heineken", "una heineken 0.0", "Heineken 0.0"],
    ["dos cocas y una coca light", "Coca-Cola", "una coca light", "Coca-Cola Light"],
    ["una coca y una coca light", "Coca-Cola", "una coca light", "Coca-Cola Light"],
    ["una coca light y una coca", "Coca-Cola Light", "una coca", "Coca-Cola"],
  ] as const) {
    const r: any = await conExtras(q);
    assert(r.productos.some((x: any) => x.name === base && !x.aproximado), `«${q}» productos ${nombres(r.productos)}`);
    const o = (r.otros_productos ?? []).find((x: any) => x.texto === otroTexto);
    assert(o && o.resultados[0]?.name === otro && !o.resultados[0].aproximado, `«${q}» otros ${JSON.stringify(otrosDe(r))}`);
  }
  // La misma palabra repetida tal cual no es otro producto: «cero, cero» no suma un segundo Sprite Cero.
  for (const q of ["cero, cero", "una coca y una coca"]) {
    const r: any = await conExtras(q);
    assert(!r.otros_productos, `«${q}» otros ${JSON.stringify(otrosDe(r))}`);
  }
  // Un nombre del menu dicho completo sigue sin partirse.
  const suizo: any = await conExtras("tacos suizos de chile poblano y bistec");
  assert(!suizo.otros_productos && /Chile Poblano y Bistec/.test(suizo.productos[0]?.name ?? ""), `suizos ${nombres(suizo.productos)} ${JSON.stringify(otrosDe(suizo))}`);
});
it("R16-3: «dos kilos y medio», «tres kilos y medio» (en palabras) son 2.5/3.5 kg: sin ese tamano, nunca otro peso como exacto; «1 1/2 kilos» es 1.5 kg", async () => {
  for (const q of ["dos kilos y medio de costilla", "tres kilos y medio de pastor", "dos y medio kilos de pastor"]) {
    const r = await crudo(q);
    assert(r.every((x: any) => x.aproximado || !/— 1\.5 kg|— 1 kg|— 2 kg/.test(x.name)), `«${q}» -> ${nombres(r)}`);
  }
  for (const [q, kilo] of [["1 1/2 kilos de pastor", "Pastor — 1.5 kg"], ["1 1/2 kg de costilla", "Costilla de Res — 1.5 kg"], ["uno y medio kilos de pastor", "Pastor — 1.5 kg"], ["un kilo y medio de pastor", "Pastor — 1.5 kg"]] as const) {
    const r = await crudo(q);
    assert(r[0]?.name === kilo && !r[0].aproximado, `«${q}» -> ${nombres(r)}`);
  }
  assert(pedidos.tokenizeForProductSearch("dos kilos y medio de costilla").includes("2.5"), `tokens ${JSON.stringify(pedidos.tokenizeForProductSearch("dos kilos y medio de costilla"))}`);
});
it("R16-4: un tamano («355ml», «600 ml», «2 litros») no casa SOLO por la descripcion de otro producto", async () => {
  for (const q of ["cerveza 355ml", "cerveza 355 ml", "una de 355ml", "refresco 600 ml"]) {
    const r = await crudo(q);
    assert(r.every((x: any) => x.aproximado), `«${q}» -> ${nombres(r)}`);
  }
  // Con el nombre del producto, su tamano en la descripcion si cuenta.
  const agua = await crudo("agua 600ml");
  assert(agua[0]?.name === "Agua Purificada" && !agua[0].aproximado, `agua 600ml -> ${nombres(agua)}`);
  // Separado («300 ml») igual que pegado: la unidad va con su numero.
  for (const [q, nombre] of [["agua mineral 300 ml", "Agua Mineral Cristal"], ["agua 600 ml", "Agua Purificada"], ["topo chico 355 ml", "Topo Chico"]] as const) {
    const r = await crudo(q);
    assert(r[0]?.name === nombre && !r[0].aproximado, `«${q}» -> ${nombres(r)}`);
  }
  const topo = await crudo("topo chico 355ml");
  assert(topo[0]?.name === "Topo Chico" && !topo[0].aproximado, `topo chico 355ml -> ${nombres(topo)}`);
});
it("R16-5: «2 órdenes de papas» (con tilde) es lo mismo que «2 ordenes de papas»", async () => {
  const sin = await crudo("2 ordenes de papas");
  for (const q of ["2 órdenes de papas", "dos Órdenes de papas"]) {
    const con = await crudo(q);
    assert(nombres(con) === nombres(sin), `«${q}» -> ${nombres(con)} vs ${nombres(sin)}`);
  }
  assert(pedidos.tokenizeForProductSearch("órdenes").includes("orden"), `tokens ${JSON.stringify(pedidos.tokenizeForProductSearch("órdenes"))}`);
});
it("R17-1: «1/2 kilo», «1/4 kilo», «1/2 kg» son 500 g / 250 g; «dos kilos» es 2 kg y «tres kilos» (no existe) nunca es otro peso exacto", async () => {
  for (const [q, peso] of [
    ["1/2 kilo de pastor", "Pastor — 500 g"], ["1/2 kg de pastor", "Pastor — 500 g"], ["1/4 kilo de pastor", "Pastor — 250 g"],
    ["1/4 de kilo de pastor", "Pastor — 250 g"], ["dos kilos de pastor", "Pastor — 2 kg"], ["dos kilos de bistec", "Bistec de Res — 2 kg"],
  ] as const) {
    const r = await crudo(q);
    assert(r[0]?.name === peso && !r[0].aproximado, `«${q}» -> ${nombres(r)}`);
    assert(r.every((x: any) => x.aproximado || !esPeso(x.name) || x.name.endsWith(peso.split(" — ")[1])), `«${q}» otro peso exacto: ${nombres(r)}`);
  }
  const solo = await crudo("1/2 kg");
  assert(solo.length > 0 && solo.every((x: any) => x.aproximado || / — 500 g$/.test(x.name)), `1/2 kg -> ${nombres(solo)}`);
  for (const q of ["tres kilos de pastor", "tres kilos de bistec"]) {
    const r = await crudo(q);
    assert(r.every((x: any) => x.aproximado || !esPeso(x.name)), `«${q}» -> ${nombres(r)}`);
  }
  // Sin el medio kilo en el menu: ni el kilo ni otro peso salen exactos por «1/2 kilo».
  const sinMedio: any = await enMenu((f) => f.filter((r: any) => r.products.name !== "Pastor — 500 g"), "1/2 kilo de pastor");
  assert(sinMedio.productos.every((x: any) => x.aproximado || !esPeso(x.name)), `sin 500 g -> ${nombres(sinMedio.productos)}`);
  const t = pedidos.tokenizeForProductSearch("dos kilos de pastor");
  assert(t.includes("2") && t.includes("kg"), `tokens ${JSON.stringify(t)}`);
});
it("R17-8: «media de pastor», «una y media de pastor» son exactos otra vez (como ace28e8)", async () => {
  for (const [q, peso] of [["media de pastor", "Pastor — 500 g"], ["una y media de pastor", "Pastor — 1.5 kg"], ["medio de pastor", "Pastor — 500 g"]] as const) {
    const r = await crudo(q);
    assert(r.some((x: any) => x.name === peso && !x.aproximado) && r.every((x: any) => !x.aproximado), `«${q}» -> ${nombres(r)}`);
  }
});
it("R17-2: «y medio» que empieza OTRO producto («kilo de pastor y medio de bistec») se parte; «un kilo y medio de pastor» sigue siendo 1.5 kg", async () => {
  for (const [q, base, parte, bistec] of [
    ["kilo de pastor y medio de bistec", "Pastor — 1 kg", "medio de bistec", "Bistec de Res — 500 g"],
    ["un kilo de pastor y medio kilo de bistec", "Pastor — 1 kg", "medio kilo de bistec", "Bistec de Res — 500 g"],
  ] as const) {
    const r: any = await conExtras(q);
    assert(r.productos[0]?.name === base && !r.productos[0].aproximado, `«${q}» productos ${nombres(r.productos)}`);
    const o = (r.otros_productos ?? []).find((x: any) => x.texto === parte);
    assert(o && o.resultados[0]?.name === bistec && !o.resultados[0].aproximado, `«${q}» otros ${JSON.stringify(otrosDe(r))}`);
  }
  for (const [q, kilo] of [["un kilo y medio de pastor", "Pastor — 1.5 kg"], ["kilo y medio de pastor", "Pastor — 1.5 kg"], ["dos kilos y medio de pastor", null]] as const) {
    const r: any = await conExtras(q);
    assert(!r.otros_productos, `«${q}» otros ${JSON.stringify(otrosDe(r))}`);
    if (kilo) assert(r.productos[0]?.name === kilo && !r.productos[0].aproximado, `«${q}» productos ${nombres(r.productos)}`);
  }
});
it("R17-3: el numero que dice el pack («6 pack de sol», «12 pack de sol») no se quita: la otra parte encuentra la Sol", async () => {
  const r: any = await conExtras("dos cocas y 6 pack de sol");
  assert(r.productos[0]?.name === "Coca-Cola", `productos ${nombres(r.productos)}`);
  const o = (r.otros_productos ?? []).find((x: any) => /6 pack de sol/.test(x.texto));
  assert(o && o.resultados[0]?.name === "Sol" && o.resultados[0].aproximado && o.resultados[0].presentacion_no_disponible === "six pack", `otros ${JSON.stringify(r.otros_productos)}`);
  for (const [q, presentacion] of [["12 pack de sol", "12 pack"], ["6 pack sol", "six pack"], ["6 pack de sol", "six pack"]] as const) {
    const s: any = await conExtras(q);
    assert(s.productos[0]?.name === "Sol" && s.productos[0].aproximado && s.productos[0].presentacion_no_disponible === presentacion, `«${q}» ${conFlags(s.productos)}`);
  }
  // Con el pack en el menu, la otra parte es el pack, exacto.
  const conPack: any = await enMenu(conPresentaciones, "dos cocas y 6 pack de sol");
  const p = (conPack.otros_productos ?? []).find((x: any) => /6 pack de sol/.test(x.texto));
  assert(p && p.resultados[0]?.name === "Sol Six Pack" && !p.resultados[0].aproximado, `con pack ${JSON.stringify(conPack.otros_productos)}`);
});
it("R17-4: la presentacion solo marca bebidas: «tacos 6 pack» no lleva presentacion_no_disponible; «coca 6 pack» si (no hay pack de coca)", async () => {
  const tacos: any = await conExtras("tacos 6 pack");
  assert(tacos.productos.length > 0 && tacos.productos.every((x: any) => !("presentacion_no_disponible" in x)), `tacos ${conFlags(tacos.productos)}`);
  const coca: any = await conExtras("coca 6 pack");
  assert(coca.productos[0]?.name === "Coca-Cola" && coca.productos.every((x: any) => x.aproximado && x.presentacion_no_disponible === "six pack"), `coca ${conFlags(coca.productos)}`);
});
it("R17-6: «una sol y una sol 6 pack» son dos cosas: la Sol suelta sin presentacion y el pack aparte con su presentacion", async () => {
  const r: any = await conExtras("una sol y una sol 6 pack");
  assert(r.productos[0]?.name === "Sol" && !r.productos[0].aproximado && !("presentacion_no_disponible" in r.productos[0]), `productos ${conFlags(r.productos)}`);
  const o = (r.otros_productos ?? []).find((x: any) => /sol 6 pack/.test(x.texto));
  assert(r.otros_productos?.length === 1 && o && o.resultados[0]?.name === "Sol" && o.resultados[0].presentacion_no_disponible === "six pack", `otros ${JSON.stringify(r.otros_productos)}`);
});
it("R17-7: «una heineken y una heineken 0.0»: la Heineken 0.0 va solo en otros_productos, no tambien en productos", async () => {
  for (const [q, parte] of [
    ["una heineken y una heineken 0.0", "una heineken 0.0"], ["heineken y heineken 0.0", "heineken 0.0"], ["2 heineken y 1 heineken 0.0", "1 heineken 0.0"],
  ] as const) {
    const r: any = await conExtras(q);
    assert(r.productos[0]?.name === "Heineken" && r.productos.every((x: any) => x.name !== "Heineken 0.0"), `«${q}» productos ${nombres(r.productos)}`);
    const o = (r.otros_productos ?? []).find((x: any) => x.texto === parte);
    assert(o && o.resultados[0]?.name === "Heineken 0.0", `«${q}» otros ${JSON.stringify(otrosDe(r))}`);
  }
  // Lo mismo con la coca light; y al reves la base sigue siendo la light.
  const cocas: any = await conExtras("dos cocas y una coca light");
  assert(cocas.productos[0]?.name === "Coca-Cola" && cocas.productos.every((x: any) => x.name !== "Coca-Cola Light"), `cocas ${nombres(cocas.productos)}`);
  const light: any = await conExtras("una coca light y una coca");
  assert(light.productos[0]?.name === "Coca-Cola Light", `light ${nombres(light.productos)}`);
});
it("R17-9: «una heineken» es la Heineken primero; la 0.0 solo primero si se pide (0.0, cero, sin alcohol)", async () => {
  for (const q of ["una heineken", "quiero un heineken", "heineken", "2 heineken"]) {
    const r = await crudo(q);
    assert(r[0]?.name === "Heineken", `«${q}» -> ${nombres(r)}`);
  }
  for (const q of ["una heineken 0.0", "heineken cero cero", "heineken sin alcohol", "heineken 00"]) {
    const r = await crudo(q);
    assert(r[0]?.name === "Heineken 0.0", `«${q}» -> ${nombres(r)}`);
  }
  // Por categoria («una cerveza», «refresco») no se nombra la marca: la version cero no se recorre fuera de los 8.
  for (const [q, cero] of [["una cerveza", "Heineken 0.0"], ["refresco", "Sprite Cero"], ["dos chelas", "Heineken 0.0"]] as const) {
    const r = await crudo(q);
    assert(r.some((x: any) => x.name === cero), `«${q}» -> ${nombres(r)}`);
  }
});
it("R17-10: «coca 1 l» es el tamano «1l» (no la coca de cualquier tamano)", async () => {
  const t = pedidos.tokenizeForProductSearch("coca 1 l");
  assert(t.includes("1l"), `tokens ${JSON.stringify(t)}`);
  assert(nombres(await crudo("coca 1 l")) === nombres(await crudo("coca 1l")), `${nombres(await crudo("coca 1 l"))} vs ${nombres(await crudo("coca 1l"))}`);
});
it("R17-11: «una caguama» sola son las cervezas, aproximadas con presentacion_no_disponible «caguama»", async () => {
  for (const q of ["una caguama", "caguama", "dos caguamas"]) {
    const r: any = await conExtras(q);
    assert(r.productos.some((x: any) => x.name === "Sol") && r.productos.every((x: any) => x.aproximado && x.presentacion_no_disponible === "caguama"), `«${q}» ${conFlags(r.productos)}`);
    assert(r.productos.every((x: any) => !/taco|coca/i.test(x.name)), `«${q}» ${conFlags(r.productos)}`);
  }
  const conCaguama: any = await enMenu(conPresentaciones, "una caguama");
  assert(conCaguama.productos[0]?.name === "Indio Caguama" && !conCaguama.productos[0].aproximado, `con caguama ${conFlags(conCaguama.productos)}`);
});
it("R18-1 (invariante 2): lo que solo dice cantidad + presentacion («2 caguamas», «3 caguamas», «2 six pack») son las cervezas aproximadas con la presentacion; una cifra suelta nunca es palabra de busqueda", async () => {
  for (const [q, presentacion] of [
    ["2 caguamas", "caguama"], ["3 caguamas", "caguama"], ["12 caguamas", "caguama"], ["dos caguamas", "caguama"],
    ["una caguama", "caguama"], ["2 six pack", "six pack"], ["3 six packs", "six pack"],
  ] as const) {
    const r: any = await conExtras(q);
    assert(cervezaConPresentacion(r.productos, presentacion), `«${q}» ${conFlags(r.productos)}`);
  }
  // Ninguna consulta deja una cifra sola como palabra de busqueda (antes «2» casaba «Parrillada para 2», «(1/2 orden)», «2 kg»).
  for (const q of ["2", "12", "2 caguamas", "12 caguamas", "2 six pack", "3 de", "una 2"]) {
    const t = pedidos.tokenizeForProductSearch(q);
    assert(t.length === 0 || t.some((x) => !soloCifras(x)), `«${q}» tokens ${JSON.stringify(t)}`);
  }
  for (const q of ["2", "12", "3 de"]) {
    const r = await crudo(q);
    assert(r.length === 0, `«${q}» -> ${nombres(r)}`);
  }
  // Como otra parte del pedido tampoco se pierde: «y una caguama» son las cervezas, aproximadas con la presentacion.
  for (const q of ["2 tacos y una caguama", "dos cocas y una caguama", "tacos de pastor y 2 caguamas"]) {
    const r: any = await conExtras(q);
    const o = (r.otros_productos ?? []).find((x: any) => /caguama/.test(x.texto));
    assert(o && cervezaConPresentacion(o.resultados, "caguama"), `«${q}» otros ${JSON.stringify(r.otros_productos?.map((x: any) => [x.texto, conFlags(x.resultados)]))}`);
    assert(r.productos.length > 0 && r.productos.every((x: any) => !x.presentacion_no_disponible), `«${q}» productos ${conFlags(r.productos)}`);
  }
});
it("R18-2 (invariante 1): ninguna parte de un pedido de varios productos se pierde: la base en productos (o en otros_productos con [] si no encontro nada) y cada otra parte en otros_productos", async () => {
  const fallas: string[] = [];
  // Todas las consultas que fallan, no solo la primera.
  const check = (ok: boolean, msg: string) => { if (!ok) fallas.push(msg); };
  for (const q of PEDIDOS_VARIOS) {
    const partes = pedidos.partesDelPedido(q);
    check(partes.length >= 2, `«${q}» el separador no lo partio: ${JSON.stringify(partes)}`);
    const r: any = await conExtras(q);
    const otros: any[] = r.otros_productos ?? [];
    const enRespuesta = (r.productos.length > 0 ? 1 : 0) + otros.length;
    check(enRespuesta === partes.length, `«${q}» ${partes.length} partes ${JSON.stringify(partes)} pero ${enRespuesta} en la respuesta: productos ${nombres(r.productos)} otros ${JSON.stringify(otrosDe(r))}`);
    const textos = otros.map((o: any) => o.texto);
    for (const p of partes.slice(1)) check(textos.includes(p), `«${q}» se perdio «${p}»: ${JSON.stringify(textos)}`);
    if (r.productos.length === 0) {
      const base = otros.find((o: any) => o.texto === partes[0]);
      check(base !== undefined && base.resultados.length === 0, `«${q}» la base «${partes[0]}» no esta: ${JSON.stringify(otrosDe(r))}`);
    }
    // Revisión 19: una parte cuyo producto SÍ está en el menú no sale vacía (solo lo que el menú no tiene da []).
    for (const o of otros) {
      check(o.resultados.length > 0 || PARTES_FUERA_DEL_MENU.has(o.texto), `«${q}» la parte «${o.texto}» salio vacia: ${JSON.stringify(otrosDe(r))}`);
    }
    check(r.productos.length > 0 || PARTES_FUERA_DEL_MENU.has(partes[0]!), `«${q}» la base «${partes[0]}» salio vacia`);
  }
  assert(fallas.length === 0, fallas.join("\n"));
});
it("R18-3 (invariante 3): el peso se normaliza en CADA parte antes de quitar la cantidad: «2 tacos y 2 kilos de pastor» -> solo Pastor 2 kg; la parte da los mismos exactos que buscada sola", async () => {
  const exactos = (r: any[]) => r.filter((x: any) => !x.aproximado).map((x: any) => x.name);
  for (const [q, parte, peso] of [
    ["2 tacos y 2 kilos de pastor", "2 kilos de pastor", "Pastor — 2 kg"],
    ["2 tacos y 1/2 kilo de pastor", "1/2 kilo de pastor", "Pastor — 500 g"],
    ["tacos de pastor y 2 kilos de bistec", "2 kilos de bistec", "Bistec de Res — 2 kg"],
    ["2 tacos y 1 y 1/2 kilos de pastor", "1 y 1/2 kilos de pastor", "Pastor — 1.5 kg"],
    ["una coca y 2 kg de arrachera", "2 kg de arrachera", "Arrachera — 2 kg"],
    ["una coca y dos kilos de pastor", "dos kilos de pastor", "Pastor — 2 kg"],
    ["una coca y medio kilo de bistec", "medio kilo de bistec", "Bistec de Res — 500 g"],
    ["una coca y 1/4 de kilo de pastor", "1/4 de kilo de pastor", "Pastor — 250 g"],
  ] as const) {
    const r: any = await conExtras(q);
    const o = (r.otros_productos ?? []).find((x: any) => x.texto === parte);
    assert(o, `«${q}» sin la parte «${parte}»: ${JSON.stringify(otrosDe(r))}`);
    const suyos = exactos(o.resultados);
    const tamano = peso.split(" — ")[1];
    assert(suyos[0] === peso && suyos.filter(esPeso).every((n: string) => n.endsWith(` — ${tamano}`)), `«${q}» ${conFlags(o.resultados)}`);
    // La misma parte buscada sola da los mismos exactos (el peso no depende de ir en un pedido de varios).
    const sola = exactos(await crudo(parte));
    assert(JSON.stringify(sola) === JSON.stringify(suyos), `«${parte}» sola ${JSON.stringify(sola)} vs en el pedido ${JSON.stringify(suyos)}`);
  }
});
it("R18-4: «un kilo de pastor», «1 kilo», «1 kg» son SOLO el de 1 kg exacto (ni 1.5 kg ni 2 kg); una cifra casa el numero entero, no el inicio de otro («1» no es «1.5»)", async () => {
  for (const [q, kilo] of [
    ["un kilo de pastor", "Pastor — 1 kg"], ["1 kilo de pastor", "Pastor — 1 kg"], ["1 kg de pastor", "Pastor — 1 kg"], ["pastor 1 kg", "Pastor — 1 kg"],
    ["un kilo de bistec", "Bistec de Res — 1 kg"], ["1kg de arrachera", "Arrachera — 1 kg"], ["quiero un kilo de costilla", "Costilla de Res — 1 kg"],
  ] as const) {
    const r = await crudo(q);
    assert(r[0]?.name === kilo && !r[0].aproximado, `«${q}» -> ${nombres(r)}`);
    assert(r.every((x: any) => x.aproximado || !esPeso(x.name) || x.name.endsWith(" — 1 kg")), `«${q}» otro peso exacto: ${nombres(r)}`);
  }
  // Como otra parte del pedido, igual.
  const r: any = await conExtras("2 tacos y un kilo de pastor");
  const o = (r.otros_productos ?? []).find((x: any) => x.texto === "un kilo de pastor");
  assert(o && o.resultados.filter((x: any) => !x.aproximado).map((x: any) => x.name).join("|") === "Pastor — 1 kg", `otros ${JSON.stringify(otrosDe(r))}`);
  // «un kilo y medio» sigue siendo el 1.5 kg.
  assert((await crudo("un kilo y medio de pastor"))[0]?.name === "Pastor — 1.5 kg", "kilo y medio");
});
it("R18-5: «media de X» es medio kilo SOLO si X es una carne por kilo; «media orden de X» es el «(1/2 orden)» de X; «una media de cerveza/horchata» es lo pedido aproximado, nunca los 500 g", async () => {
  for (const [q, peso] of [["media de pastor", "Pastor — 500 g"], ["una media de bistec", "Bistec de Res — 500 g"], ["medio de arrachera", "Arrachera — 500 g"]] as const) {
    const r = await crudo(q);
    assert(r[0]?.name === peso && !r[0].aproximado, `«${q}» -> ${nombres(r)}`);
  }
  for (const [q, re] of [["una media de cerveza", null], ["media de cerveza", null], ["una media de horchata", /^Horchata$/]] as const) {
    const r = await crudo(q);
    assert(r.length > 0 && r.every((x: any) => x.aproximado && !esPeso(x.name)), `«${q}» -> ${nombres(r)}`);
    if (re) assert(re.test(r[0].name), `«${q}» -> ${nombres(r)}`);
    else assert(r.every((x: any) => cervezasDelMenu.has(x.name)), `«${q}» -> ${nombres(r)}`);
  }
  for (const [q, esperados] of [
    ["media orden de nachos de pastor", ["Nachos de Pastor (1/2 orden)"]],
    ["media orden de frijoles charros", ["Frijoles Charros Normal (1/2 orden)", "Frijoles Charros con Queso (1/2 orden)", "Frijoles Charros Especiales (1/2 orden)"]],
  ] as const) {
    const r = await crudo(q);
    const ex = r.filter((x: any) => !x.aproximado).map((x: any) => x.name);
    assert(JSON.stringify([...ex].sort()) === JSON.stringify([...esperados].sort()), `«${q}» -> ${nombres(r)}`);
  }
  // Sin «(1/2 orden)» de eso: lo pedido, aproximado (el agente aclara), nunca vacio.
  const tacos = await crudo("media orden de tacos");
  assert(tacos.length > 0 && tacos.every((x: any) => x.aproximado && /^Tacos? /.test(x.name)), `media orden de tacos -> ${nombres(tacos)}`);
  const conCocas: any = await conExtras("media orden de tacos y 2 cocas");
  assert(conCocas.productos.length > 0 && conCocas.productos.every((x: any) => x.aproximado), `productos ${nombres(conCocas.productos)}`);
  assert(otrosDe(conCocas).length === 1 && /^2 cocas=>Coca-Cola/.test(otrosDe(conCocas)[0]), `otros ${JSON.stringify(otrosDe(conCocas))}`);
  // Como otra parte del pedido: «y una media de horchata», «y media orden de nachos de pastor».
  const mix: any = await conExtras("2 tacos y una media de horchata y media orden de nachos de pastor");
  const horchata = (mix.otros_productos ?? []).find((o: any) => /horchata/.test(o.texto));
  const nachos = (mix.otros_productos ?? []).find((o: any) => /nachos/.test(o.texto));
  assert(horchata && horchata.resultados[0]?.name === "Horchata" && horchata.resultados[0].aproximado, `horchata ${JSON.stringify(otrosDe(mix))}`);
  assert(nachos && nachos.resultados[0]?.name === "Nachos de Pastor (1/2 orden)" && !nachos.resultados[0].aproximado, `nachos ${JSON.stringify(otrosDe(mix))}`);
});
it("R18-6: «<marca de cerveza> cero» es su 0.0 («heineken cero» -> Heineken 0.0), tambien dentro de una parte del pedido; «sprite cero» sigue siendo el Sprite Cero", async () => {
  for (const q of ["heineken cero", "una heineken cero", "2 heineken cero"]) {
    const r = await crudo(q);
    assert(r[0]?.name === "Heineken 0.0" && !r[0].aproximado, `«${q}» -> ${nombres(r)}`);
  }
  const doble: any = await conExtras("una heineken y una heineken cero");
  assert(doble.productos[0]?.name === "Heineken" && doble.productos.every((x: any) => x.name !== "Heineken 0.0"), `productos ${nombres(doble.productos)}`);
  const o = (doble.otros_productos ?? []).find((x: any) => x.texto === "una heineken cero");
  assert(o && o.resultados[0]?.name === "Heineken 0.0" && !o.resultados[0].aproximado, `otros ${JSON.stringify(otrosDe(doble))}`);
  const base: any = await conExtras("una heineken cero y 2 tacos");
  assert(base.productos[0]?.name === "Heineken 0.0", `base ${nombres(base.productos)} otros ${JSON.stringify(otrosDe(base))}`);
  assert((await crudo("sprite cero"))[0]?.name === "Sprite Cero", "sprite cero");
  // Sin 0.0 de esa marca nunca sale la de alcohol como exacta.
  const sol = await crudo("sol cero");
  assert(sol.every((x: any) => x.aproximado || x.name !== "Sol"), `sol cero -> ${nombres(sol)}`);
});
it("R18-7: «dos cocas y una light»: la parte con su propia cantidad es OTRO producto (no el resto de un nombre) y la variante es de la marca de la base: Coca-Cola en productos, Coca-Cola Light en otros_productos", async () => {
  const r: any = await conExtras("dos cocas y una light");
  assert(r.productos[0]?.name === "Coca-Cola" && r.productos.every((x: any) => x.name !== "Coca-Cola Light"), `productos ${nombres(r.productos)}`);
  const o = (r.otros_productos ?? []).find((x: any) => x.texto === "una light");
  assert(r.otros_productos?.length === 1 && o && o.resultados[0]?.name === "Coca-Cola Light" && !o.resultados[0].aproximado, `otros ${JSON.stringify(otrosDe(r))}`);
  for (const [q, base, parte, variante] of [
    ["2 heineken y una 0.0", "Heineken", "una 0.0", "Heineken 0.0"],
    ["una coca y una light", "Coca-Cola", "una light", "Coca-Cola Light"],
  ] as const) {
    const x: any = await conExtras(q);
    assert(x.productos[0]?.name === base && x.productos.every((p: any) => p.name !== variante), `«${q}» productos ${nombres(x.productos)}`);
    const ox = (x.otros_productos ?? []).find((p: any) => p.texto === parte);
    assert(ox && ox.resultados[0]?.name === variante, `«${q}» otros ${JSON.stringify(otrosDe(x))}`);
  }
  // Al reves la base es la variante y la otra parte es la marca sola: «dos cocas» no se vuelve la Light.
  const alReves: any = await conExtras("una light y dos cocas");
  const cocas = (alReves.otros_productos ?? []).find((x: any) => x.texto === "dos cocas");
  assert(cocas && cocas.resultados[0]?.name === "Coca-Cola", `al reves ${nombres(alReves.productos)} ${JSON.stringify(otrosDe(alReves))}`);
  // Sin cantidad propia, la parte sigue pudiendo ser el resto de un nombre.
  const poblano: any = await conExtras("chile poblano y bistec");
  assert(!poblano.otros_productos?.length && /Chile Poblano y Bistec/.test(poblano.productos[0]?.name ?? ""), `poblano ${nombres(poblano.productos)}`);
});
it("R18-8: solo la categoria («una cerveza», «dos cervezas», «un coctel») no es un producto: lo de la categoria va aproximado (el agente pregunta cual), nunca 8 exactos", async () => {
  for (const q of ["una cerveza", "dos cervezas", "cerveza", "unas cervezas por favor", "12 cervezas"]) {
    const r = await crudo(q);
    assert(r.length > 0 && r.every((x: any) => x.aproximado && cervezasDelMenu.has(x.name)), `«${q}» -> ${nombres(r)}`);
  }
  // «un coctel»: el menu de PM los llama «Cocktails»; lo que salga tampoco puede ir exacto.
  const cocteles = await crudo("un coctel");
  assert(cocteles.every((x: any) => x.aproximado), `un coctel -> ${nombres(cocteles)}`);
  // Como otra parte del pedido, igual; con la marca sigue exacta.
  const r: any = await conExtras("tacos de pastor y una cerveza");
  const o = (r.otros_productos ?? []).find((x: any) => x.texto === "una cerveza");
  assert(o && o.resultados.length > 0 && o.resultados.every((x: any) => x.aproximado), `otros ${JSON.stringify(otrosDe(r))}`);
  for (const q of ["una sol", "una cerveza sol", "dos cervezas heineken"]) {
    const x = await crudo(q);
    assert(x[0] && !x[0].aproximado, `«${q}» -> ${nombres(x)}`);
  }
});
it("R18-9: un tamano de bebida que el menu no tiene («agua 1 L», «coca 1 l», «coca 3 litros») no es «no tenemos»: la bebida va aproximada con presentacion_no_disponible («1 L»), igual sola que como parte del pedido", async () => {
  for (const [q, re, tamano] of [
    ["agua 1 L", /^Agua/, "1 L"], ["coca 1 l", /^Coca-Cola/, "1 L"], ["coca 1l", /^Coca-Cola/, "1 L"], ["coca 3 litros", /^Coca-Cola/, "3 L"],
    ["una coca de 1 litro", /^Coca-Cola/, "1 L"],
  ] as const) {
    const r: any = await conExtras(q);
    assert(r.productos.length > 0 && re.test(r.productos[0].name), `«${q}» ${conFlags(r.productos)}`);
    assert(r.productos.every((x: any) => x.aproximado && x.presentacion_no_disponible === tamano), `«${q}» ${conFlags(r.productos)}`);
  }
  // «coca 1 l» y «coca 1l» siguen dando lo mismo (R17-10); sin tamano, ni aproximado ni la marca.
  assert(nombres(await crudo("coca 1 l")) === nombres(await crudo("coca 1l")), "coca 1 l vs 1l");
  const coca: any = await conExtras("una coca");
  assert(coca.productos[0]?.name === "Coca-Cola" && !coca.productos[0].aproximado && !("presentacion_no_disponible" in coca.productos[0]), `una coca ${conFlags(coca.productos)}`);
  // Como base y como otra parte del pedido.
  const base: any = await conExtras("agua 1 L y 2 tacos");
  assert(base.productos.length > 0 && base.productos.every((x: any) => x.aproximado && x.presentacion_no_disponible === "1 L"), `base ${conFlags(base.productos)}`);
  assert(otrosDe(base).length === 1 && /^2 tacos=>/.test(otrosDe(base)[0]), `otros ${JSON.stringify(otrosDe(base))}`);
  const parte: any = await conExtras("2 tacos y una coca 1 l");
  const o = (parte.otros_productos ?? []).find((x: any) => x.texto === "una coca 1 l");
  assert(o && o.resultados.length > 0 && o.resultados.every((x: any) => x.aproximado && x.presentacion_no_disponible === "1 L"), `parte ${JSON.stringify(parte.otros_productos)}`);
});
it("R18-4b: «un kilo de pastor y medio», «1 kilo de bistec y medio» son el kilo y medio exacto (el «un kilo» pegado no lo rompe)", async () => {
  for (const [q, kilo] of [
    ["un kilo de pastor y medio", "Pastor — 1.5 kg"], ["1 kilo de bistec y medio", "Bistec de Res — 1.5 kg"], ["kilo de pastor y medio", "Pastor — 1.5 kg"],
    ["un kilo de pastor y medio con poca cebolla", "Pastor — 1.5 kg"],
  ] as const) {
    const r = await crudo(q);
    assert(r[0]?.name === kilo && !r[0].aproximado, `«${q}» -> ${nombres(r)}`);
  }
  // «y medio de bistec» sigue siendo otro producto.
  const r: any = await conExtras("un kilo de pastor y medio de bistec");
  assert(r.productos[0]?.name === "Pastor — 1 kg" && otrosDe(r).some((o) => /^medio de bistec=>Bistec de Res — 500 g/.test(o)), `${nombres(r.productos)} ${JSON.stringify(otrosDe(r))}`);
});
it("R18-5b: «media kilo de pastor» (con «a») es el medio kilo, no el kilo y medio", async () => {
  for (const [q, peso] of [["media kilo de pastor", "Pastor — 500 g"], ["una media kilo de bistec", "Bistec de Res — 500 g"]] as const) {
    const r = await crudo(q);
    assert(r[0]?.name === peso && !r[0].aproximado && r.every((x: any) => x.aproximado || !esPeso(x.name) || x.name.endsWith(" — 500 g")), `«${q}» -> ${nombres(r)}`);
  }
});
it("R18-5c: una «media» suelta (sin «de X», «kilo» ni «orden») no es palabra de busqueda: «una cerveza y media» son las cervezas, nunca los 500 g / 1.5 kg de las carnes", async () => {
  for (const q of ["una cerveza y media", "tres cervezas y media", "una y media cervezas"]) {
    const r = await crudo(q);
    assert(r.length > 0 && r.every((x: any) => cervezasDelMenu.has(x.name) && x.aproximado), `«${q}» -> ${nombres(r)}`);
  }
  for (const q of ["media", "una media", "dos medias"]) {
    const r = await crudo(q);
    assert(r.every((x: any) => !esPeso(x.name)), `«${q}» -> ${nombres(r)}`);
  }
  // La «media» que si dice algo sigue igual.
  for (const [q, peso] of [["kilo de pastor y medio", "Pastor — 1.5 kg"], ["una y media de pastor", "Pastor — 1.5 kg"], ["media de pastor", "Pastor — 500 g"]] as const) {
    const r = await crudo(q);
    assert(r[0]?.name === peso && !r[0].aproximado, `«${q}» -> ${nombres(r)}`);
  }
});
});

describe("fallos-post-c3-r19.test.ts", () => {
const R19_PID = "11111111-1111-4111-8111-111111111111";
const R19_PID2 = "22222222-2222-4222-8222-222222222222";
const R19_ABIERTA = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, opens_min: 0, closes_min: 1800 }));
function _r19Db(rpcs: Array<{ fingerprint?: string }>) {
  const respuesta = (t: string) => {
    if (t === "branches") return { data: { id: "b1", name: "Test", restaurant_id: "r1", is_active: true }, error: null };
    if (t === "branch_schedule") return { data: R19_ABIERTA, error: null };
    if (t === "branch_products") {
      return {
        data: [
          { price: 62, is_available: true, products: { id: R19_PID, name: "Refresco de cola", description: "individual", categories: { name: "Bebidas" } } },
          { price: 40, is_available: true, products: { id: R19_PID2, name: "Agua de horchata", description: "individual", categories: { name: "Bebidas" } } },
        ],
        error: null,
      };
    }
    if (t === "customers") return { data: { id: "customer", name: "Test" }, error: null };
    return { data: null, count: 1, error: null };
  };
  return {
    from(t: string) {
      const c: any = {
        select: () => c, eq: () => c, in: () => c, limit: () => c, insert: () => c, update: () => c, upsert: () => c,
        order: () => c, gte: () => c, neq: () => c, is: () => c,
        single: () => Promise.resolve(respuesta(t)),
        maybeSingle: () => Promise.resolve(respuesta(t)),
        then: (ok: (v: unknown) => unknown, ko: (r: unknown) => unknown) => Promise.resolve(respuesta(t)).then(ok, ko),
      };
      return c;
    },
    rpc(name: string, args: { p_dedupe_fingerprint?: string; p_order?: { total?: number; items?: unknown[] } }) {
      if (name === "create_order_idempotent") {
        rpcs.push({ fingerprint: args.p_dedupe_fingerprint });
        // Como la RPC real: devuelve la fila del pedido (total e items [{ id, name, price, quantity }]).
        return Promise.resolve({
          data: { id: `ORD-${rpcs.length + 1}`, status: "pending", total: args.p_order?.total, items: args.p_order?.items },
          error: null,
        });
      }
      return Promise.resolve({ data: "k", error: null });
    },
  };
}
const r19Tool = (name: string, args: Record<string, unknown>, id: string) => ({
  role: "assistant", content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const R19_ITEMS = [{ product_id: R19_PID, product_name: "Refresco de cola", requested_quantity: 3 }];
const _R19_NUEVOS = [{ product_id: R19_PID2, product_name: "Agua de horchata", requested_quantity: 1 }];
const r19Crear = (id: string, extra: Record<string, unknown> = {}) =>
  r19Tool("crear_pedido", { branch_slug: "test", items: R19_ITEMS, entrega: "recoger", customer_name: "Ana Uc", payment_method: "tarjeta", ...extra }, id);
const _r19Previos = (): any[] => [
  { role: "user", content: "tres refrescos para recoger, pago con tarjeta, Ana Uc" },
  r19Tool("cotizar_pedido", { branch_slug: "test", items: R19_ITEMS, entrega: "recoger" }, "q1"),
  { role: "tool", tool_call_id: "q1", content: JSON.stringify({ quote: { total: 186, branch_id: "b1" } }) },
  { role: "assistant", content: "Son $186. ¿Cómo paga?" },
  { role: "user", content: "tarjeta" },
  r19Crear("k1"),
  { role: "tool", tool_call_id: "k1", content: JSON.stringify({ order: { id: "ORD-1", items: [{ id: R19_PID, name: "Refresco de cola", price: 62, quantity: 3 }] } }) },
  { role: "assistant", content: "Listo, su pedido quedó registrado." },
];

// ---------------------------------------------------------------------------------------------------------------
// Revisión 19, búsqueda (create-order-core.ts). Catálogo REAL del arnés (scripts/medicion/fixtures/menu-pm.json).
const fx: any = menuPm;
const cats = new Map<string, string>(fx.categories.map((c: any) => [c.id, c.name]));
function bdFixture(sucursal = "garcia-lavin") {
  const bp = fx.branch_products[sucursal];
  const filas = fx.products.filter((p: any) => bp[p.id]?.is_available).map((p: any) => ({
    price: bp[p.id].price,
    is_available: true,
    products: { id: p.id, name: p.name, description: p.description, restaurant_id: "r1", search_keywords: p.search_keywords ?? [], categories: { name: cats.get(p.category_id) ?? null } },
  }));
  const q: any = { select: () => q, eq: () => q, limit: () => Promise.resolve({ data: filas, error: null }) };
  return { from: () => q };
}
const crudo = (query: string): Promise<any[]> => pedidos.buscarProductosCore(bdFixture(), { branchId: "b1", restaurantId: "r1", query });
const conExtras = (query: string): Promise<any> => pedidos.buscarProductosConExtrasCore(bdFixture(), { branchId: "b1", restaurantId: "r1", query });
const ver = (r: any[]) => JSON.stringify(r.map((x: any) => x.name + (x.aproximado ? " [aprox]" : "") + (x.presentacion_no_disponible ? ` {${x.presentacion_no_disponible}}` : "")));
const verTodo = (r: any) => `productos ${ver(r.productos)} otros ${JSON.stringify((r.otros_productos ?? []).map((o: any) => [o.texto, ver(o.resultados)]))}`;
const exactos = (r: any[]) => r.filter((x: any) => !x.aproximado).map((x: any) => x.name);
const esPeso = (n: string) => / — \d+(?:\.\d+)? (?:kg|g)$/.test(n);
/** Los exactos con peso son SOLO `peso` (y está). */
const soloPeso = (r: any[], peso: string) => {
  const e = exactos(r).filter(esPeso);
  return e.includes(peso) && e.every((n) => n.endsWith(` — ${peso.split(" — ")[1]}`));
};
const otraParte = (r: any, re: RegExp) => (r.otros_productos ?? []).find((o: any) => re.test(o.texto));


// Propiedad (refuerza R18-2): 260 pedidos de dos partes «[peso] de [carne] + conector + otra cosa» generados con semilla
// fija. Ninguna parte se pierde, ninguna parte que el menú tiene sale vacía y cada peso sale exacto y solo.
it("R19-2a: «también»/«tambien» es relleno: «dos tacos de pastor y también una coca» trae la Coca-Cola en su parte", async () => {
  const fallas: string[] = [];
  for (const q of ["dos tacos de pastor y también una coca", "dos tacos de pastor y tambien una coca", "un kilo de pastor y también dos quesadillas", "un kilo de chuleta y también un kilo y medio de arrachera"]) {
    const r = await conExtras(q);
    const o = (r.otros_productos ?? [])[0];
    if (!o || o.resultados.length === 0) fallas.push(`«${q}» ${verTodo(r)}`);
  }
  const r = await conExtras("dos tacos de pastor y también una coca");
  if (!exactos(otraParte(r, /coca/)?.resultados ?? []).includes("Coca-Cola")) fallas.push(`coca: ${verTodo(r)}`);
  const k = await conExtras("un kilo de chuleta y también un kilo y medio de arrachera");
  if (!soloPeso(otraParte(k, /arrachera/)?.resultados ?? [], "Arrachera — 1.5 kg")) fallas.push(`arrachera: ${verTodo(k)}`);
  assert(fallas.length === 0, fallas.join("\n"));
});
it("R19-2b: «un cuarto de X» es el de 250 g y «tres cuartos de X» el de 750 g (no los dos)", async () => {
  const fallas: string[] = [];
  for (const [q, peso] of [
    ["un cuarto de pastor", "Pastor — 250 g"], ["tres cuartos de pastor", "Pastor — 750 g"], ["un cuarto de bistec", "Bistec de Res — 250 g"],
    ["tres cuartos de arrachera", "Arrachera — 750 g"], ["un cuarto de kilo de pastor", "Pastor — 250 g"], ["tres cuartos de kilo de pastor", "Pastor — 750 g"],
  ] as const) {
    const r = await crudo(q);
    if (!soloPeso(r, peso)) fallas.push(`«${q}» ${ver(r)}`);
  }
  const r = await conExtras("una coca y un cuarto de pastor");
  if (!soloPeso(otraParte(r, /cuarto/)?.resultados ?? [], "Pastor — 250 g")) fallas.push(`parte: ${verTodo(r)}`);
  assert(fallas.length === 0, fallas.join("\n"));
});
it("R19-2c: «+» separa y «un/una/dos…» tras un producto empieza otra parte sin conector; «una orden de», «un kilo de» no se parten", async () => {
  const fallas: string[] = [];
  for (const [q, partes] of [
    ["dos tacos + una coca", ["dos tacos", "una coca"]],
    ["dos tacos de pastor + 2 cocas", ["dos tacos de pastor", "2 cocas"]],
    ["dos tacos una coca", ["dos tacos", "una coca"]],
    ["dos tacos de pastor una coca", ["dos tacos de pastor", "una coca"]],
    ["dos tacos de pastor una orden de papas", ["dos tacos de pastor", "una orden de papas"]],
    ["una gringa de pastor un kilo de bistec", ["una gringa de pastor", "un kilo de bistec"]],
    ["una orden de papas", ["una orden de papas"]],
    ["un kilo de pastor", ["un kilo de pastor"]],
    ["quiero una coca", ["quiero una coca"]],
    ["tacos de pastor con una coca", ["tacos de pastor", "una coca"]],
  ] as const) {
    const p = pedidos.partesDelPedido(q);
    if (JSON.stringify(p) !== JSON.stringify(partes)) fallas.push(`«${q}» -> ${JSON.stringify(p)}`);
  }
  for (const q of ["dos tacos + una coca", "dos tacos de pastor una coca"]) {
    const r = await conExtras(q);
    if (!exactos(otraParte(r, /coca/)?.resultados ?? []).includes("Coca-Cola")) fallas.push(`«${q}» ${verTodo(r)}`);
  }
  assert(fallas.length === 0, fallas.join("\n"));
});
it("R19-2d: «un kilo de pastor y media cerveza»: la «media» no es fracción del kilo (sigue un producto): Pastor 1 kg exacto y la cerveza en su parte", async () => {
  const r = await conExtras("un kilo de pastor y media cerveza");
  assert(soloPeso(r.productos, "Pastor — 1 kg") && r.productos[0]?.aproximado !== true, verTodo(r));
  const o = otraParte(r, /cerveza/);
  assert(o && o.resultados.length > 0, verTodo(r));
  // Sin producto tras la «media» sigue siendo fracción: «un kilo de pastor y medio» es el kilo y medio.
  assert(soloPeso(await crudo("un kilo de pastor y medio"), "Pastor — 1.5 kg"), "kilo de pastor y medio");
  assert(pedidos.partesDelPedido("una cerveza y media").length === 1, "una cerveza y media");
});
it("R19-2e: «dos kilos de pastor y kilo y medio de bistec»: cada parte con su peso (el kilo y medio en la segunda)", async () => {
  const fallas: string[] = [];
  for (const [q, p1, re2, p2] of [
    ["dos kilos de pastor y kilo y medio de bistec", "Pastor — 2 kg", /bistec/, "Bistec de Res — 1.5 kg"],
    ["2kg de bistec encebollado y kilo y medio de costilla", "Bistec de Res Encebollado — 2 kg", /costilla/, "Costilla de Res — 1.5 kg"],
    ["1 kg de pastor, kilo y medio de arrachera", "Pastor — 1 kg", /arrachera/, "Arrachera — 1.5 kg"],
  ] as const) {
    const r = await conExtras(q);
    if (!soloPeso(r.productos, p1) || !soloPeso(otraParte(r, re2)?.resultados ?? [], p2)) fallas.push(`«${q}» ${verTodo(r)}`);
  }
  assert(fallas.length === 0, fallas.join("\n"));
});
it("R19-3: «coca cero» es la Coca-Cola sin Azúcar; «sprite cero» sigue siendo el Sprite Cero", async () => {
  for (const q of ["coca cero", "una coca cero", "coca zero"]) {
    const r = await crudo(q);
    assert(r[0]?.name === "Coca-Cola sin Azúcar" && !r[0].aproximado, `«${q}» ${ver(r)}`);
  }
  const r = await conExtras("coca cero y dos tacos");
  assert(exactos(r.productos)[0] === "Coca-Cola sin Azúcar", verTodo(r));
  assert((await crudo("sprite cero"))[0]?.name === "Sprite Cero", "sprite cero");
});
it("R19-3: gramos y kilos: «500 gramos/gr de pastor», «kilo medio de pastor», «kilo de pastor» (sin «un») dan solo su peso", async () => {
  const fallas: string[] = [];
  for (const [q, peso] of [
    ["500 gramos de pastor", "Pastor — 500 g"], ["500 gr de pastor", "Pastor — 500 g"], ["750 gramos de pastor", "Pastor — 750 g"],
    ["250 grs de bistec", "Bistec de Res — 250 g"], ["kilo medio de pastor", "Pastor — 1.5 kg"], ["kilo de pastor", "Pastor — 1 kg"],
    ["un kilo de pastor", "Pastor — 1 kg"], ["kilo y medio de pastor", "Pastor — 1.5 kg"],
  ] as const) {
    const r = await crudo(q);
    if (!soloPeso(r, peso)) fallas.push(`«${q}» ${ver(r)}`);
  }
  assert(fallas.length === 0, fallas.join("\n"));
});
it("R19-3: palabras de categoría solas van aproximadas: «chela(s)», «un agua», «dos aguas»; «agua de jamaica» y «agua 600ml» siguen exactas", async () => {
  const fallas: string[] = [];
  for (const q of ["una chela", "dos chelas", "un agua", "dos aguas"]) {
    const r = await crudo(q);
    if (r.length === 0 || r.some((x: any) => !x.aproximado)) fallas.push(`«${q}» ${ver(r)}`);
  }
  const chelas = await crudo("dos chelas");
  if (chelas.some((x: any) => /chelada|michelada/i.test(x.name))) fallas.push(`chelas trae preparadas: ${ver(chelas)}`);
  for (const [q, n] of [["agua de jamaica", "Agua de Jamaica"], ["agua 600ml", "Agua Purificada"], ["agua mineral", "Agua Mineral Cristal"]] as const) {
    const r = await crudo(q);
    if (r[0]?.name !== n || r[0].aproximado) fallas.push(`«${q}» ${ver(r)}`);
  }
  assert(fallas.length === 0, fallas.join("\n"));
});
it("R19-3: cerveza con un tamaño que el menú no tiene («dos cervezas de 355 ml», «cerveza 1 l») son las cervezas aproximadas con presentacion_no_disponible", async () => {
  const fallas: string[] = [];
  for (const [q, tam] of [["dos cervezas de 355 ml", "355 ml"], ["cerveza 1 l", "1 L"], ["dos cervezas de 1 litro", "1 L"]] as const) {
    const r: any = await conExtras(q);
    const todos = [...r.productos, ...(r.otros_productos ?? []).flatMap((o: any) => o.resultados)];
    if (todos.length === 0 || todos.some((x: any) => !x.aproximado || x.presentacion_no_disponible !== tam)) fallas.push(`«${q}» ${verTodo(r)}`);
  }
  assert(fallas.length === 0, fallas.join("\n"));
});
it("R19-2 (propiedad): en 260 pedidos de dos partes ninguna parte del menú sale vacía y cada carne trae SOLO su peso", async () => {
  const NOMBRE: Record<string, string> = {
    pastor: "Pastor", bistec: "Bistec de Res", chuleta: "Chuleta de Cerdo", "pechuga de pollo": "Pechuga de Pollo", arrachera: "Arrachera",
    costilla: "Costilla de Res", "poc-chuc": "Poc-Chuc", "bistec encebollado": "Bistec de Res Encebollado",
  };
  const fallas: string[] = [];
  // Revisión 29: el peso de la parte 2 se verifica en TODOS los casos cuya parte 2 trae un peso (detectado en su texto,
  // no solo cuando el fixture trae meat2): cobertura = verificados / con peso, y debe ser total.
  const PESO_EN_TEXTO = /\b(?:kilos?|kg|gramos?|grs?|g)\b|\b\d+\s*(?:kg|g)\b|\b(?:medio|cuarto|cuartos)\s+(?:de\s+)?kilo/i;
  let conPeso2 = 0;
  let verificados2 = 0;
  for (const mt of dosPartes as Array<{ q: string; m: string; w: string; seg2: string; meat2?: string; w2?: string }>) {
    const r = await conExtras(mt.q);
    const otros: any[] = r.otros_productos ?? [];
    const f: string[] = [];
    if (r.productos.length === 0) f.push("PARTE1-VACIA");
    if (otros.length === 0) f.push("PARTE2-PERDIDA");
    else if (otros.some((o) => o.resultados.length === 0)) f.push("PARTE2-VACIA");
    if (!soloPeso(r.productos, `${NOMBRE[mt.m]} — ${mt.w}`)) f.push(`PESO1(${mt.w})`);
    const parte2ConPeso = PESO_EN_TEXTO.test(mt.seg2);
    if (parte2ConPeso) conPeso2++;
    if (parte2ConPeso && (!mt.meat2 || !mt.w2 || !NOMBRE[mt.meat2])) f.push("PESO2-SIN-VERIFICAR");
    if (mt.meat2 && mt.w2) {
      verificados2++;
      if (!soloPeso(otros.flatMap((o) => o.resultados), `${NOMBRE[mt.meat2]} — ${mt.w2}`)) f.push(`PESO2(${mt.w2})`);
    }
    if (f.length) fallas.push(`«${mt.q}» ${f.join(",")}: ${verTodo(r).slice(0, 300)}`);
  }
  assert(fallas.length === 0, `${fallas.length} de ${dosPartes.length}:\n${fallas.slice(0, 30).join("\n")}`);
  assert(conPeso2 > 0 && verificados2 === conPeso2, `cobertura del peso de la parte 2: ${verificados2} verificados de ${conPeso2} con peso`);

});
});

describe("fallos-post-c3-r20.test.ts", () => {

// Revisión 20 de PR #21 (rama fix/pm-post-c3): la guarda de pedido repetido de WhatsApp (motivoOtroPedidoEnSesion)
// alineada con pm-policies («Cambiar o agregar algo a un pedido YA creado»: va por registrar_contacto
// «modificacion_pedido», no como otro pedido). Todo sintético, sin PII.






const PID = "11111111-1111-4111-8111-111111111111";
const PID2 = "22222222-2222-4222-8222-222222222222";
const ABIERTA = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, opens_min: 0, closes_min: 1800 }));
const ITEMS = [{ product_id: PID, product_name: "Refresco de cola", requested_quantity: 3 }];
const NUEVOS = [{ product_id: PID2, product_name: "Agua de horchata", requested_quantity: 1 }];

function _db(rpcs: Array<{ fingerprint?: string }>, recientes: Array<Record<string, unknown>> = []) {
  const respuesta = (t: string) => {
    if (t === "branches") return { data: { id: "b1", name: "Test", restaurant_id: "r1", is_active: true }, error: null };
    if (t === "branch_schedule") return { data: ABIERTA, error: null };
    if (t === "branch_products") {
      return {
        data: [
          { price: 62, is_available: true, products: { id: PID, name: "Refresco de cola", description: "individual", categories: { name: "Bebidas" } } },
          { price: 40, is_available: true, products: { id: PID2, name: "Agua de horchata", description: "individual", categories: { name: "Bebidas" } } },
        ],
        error: null,
      };
    }
    if (t === "customers") return { data: { id: "customer", name: "Test" }, error: null };
    if (t === "orders") return { data: recientes, error: null };
    return { data: null, count: 1, error: null };
  };
  return {
    from(t: string) {
      const c: any = {
        select: () => c, eq: () => c, in: () => c, limit: () => c, insert: () => c, update: () => c, upsert: () => c,
        order: () => c, gte: () => c, neq: () => c, is: () => c, like: () => c,
        single: () => Promise.resolve(respuesta(t)),
        maybeSingle: () => Promise.resolve(respuesta(t)),
        then: (ok: (v: unknown) => unknown, ko: (r: unknown) => unknown) => Promise.resolve(respuesta(t)).then(ok, ko),
      };
      return c;
    },
    rpc(name: string, args: { p_dedupe_fingerprint?: string; p_order?: { total?: number; items?: unknown[] } }) {
      if (name === "create_order_idempotent") {
        rpcs.push({ fingerprint: args.p_dedupe_fingerprint });
        return Promise.resolve({
          data: { id: `ORD-${rpcs.length + 1}`, status: "pending", total: args.p_order?.total, items: args.p_order?.items },
          error: null,
        });
      }
      return Promise.resolve({ data: "k", error: null });
    },
  };
}
const llamada = (name: string, args: Record<string, unknown>, id: string) => ({
  role: "assistant", content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const resultado = (id: string, obj: unknown) => ({ role: "tool", tool_call_id: id, content: JSON.stringify(obj) });
const _DOM = { branch_slug: "test", entrega: "domicilio", customer_address: "Calle 1 #20, Centro", customer_name: "Ana Uc", payment_method: "tarjeta" };
const REC = { branch_slug: "test", entrega: "recoger", customer_name: "Ana Uc", payment_method: "tarjeta" };
/** Hilo con ORD-1 (3 refrescos) ya creado con `base` (DOM o REC) y `extra`. */
function previos(base: Record<string, unknown> = REC, extra: Record<string, unknown> = {}): any[] {
  return [
    { role: "user", content: "tres refrescos" },
    llamada("cotizar_pedido", { branch_slug: "test", items: ITEMS, entrega: base.entrega }, "q1"),
    resultado("q1", { quote: { total: 186, branch_id: "b1" } }),
    { role: "assistant", content: "Son $186. ¿Cómo paga?" },
    { role: "user", content: "tarjeta" },
    llamada("crear_pedido", { ...base, items: ITEMS, ...extra }, "k1"),
    resultado("k1", { order: { id: "ORD-1", items: [{ id: PID, name: "Refresco de cola", price: 62, quantity: 3 }] } }),
    { role: "assistant", content: "Listo, su pedido quedó registrado." },
  ];
}
const _cotiza = (items: unknown[], id: string, entrega = "recoger") => [
  llamada("cotizar_pedido", { branch_slug: "test", items, entrega }, id),
  resultado(id, { quote: { total: 100, branch_id: "b1" } }),
];

// ---------------------------------------------------------------------------------------------------------------
// R20-2 (P1): un crear_pedido que INCLUYE los renglones de un pedido ya creado (A+B tras A, o más cantidad de A) se
// creaba como otro pedido (cobrando A dos veces) en cuanto hubiera cualquier cotizar_pedido posterior. pm-policies:
// agregar a un pedido ya creado va por registrar_contacto «modificacion_pedido».
const _AB = [...ITEMS, ...NUEVOS];
const _MAS_A = [{ ...ITEMS[0], requested_quantity: 4 }];

// Revisión 21 (migrada a propósito): solo B cotizado y A+B a otra dirección ya no pasan dentro de la ventana (son
// modificación); solo B pasa con el sí estricto al pedido aparte.

// ---------------------------------------------------------------------------------------------------------------
// R20-3 (P1): la sesión se mide desde la ÚLTIMA actividad (hilo-modelo, 3 h): quien platica toda la tarde no podía
// repetir a las 17:00 el pedido de las 12:00. La guarda tiene su propia ventana desde la hora del PEDIDO CREADO.
const merida = (hh: number, mm = 0) => Date.UTC(2026, 10, 4, hh + 6, mm); // Mérida = UTC-6
const iso = (ms: number) => new Date(ms).toISOString();
/** previos() con hora: el mensaje del cliente que cierra el pedido a `hora` y charla posterior a las 14:30. */
function _previosConHora(hora: number, conCharla = true, base: Record<string, unknown> = REC): any[] {
  const h = previos(base);
  h[4] = { ...h[4], at: iso(hora) };
  return conCharla ? [...h, { role: "user", content: "¿ya va en camino?", at: iso(merida(14, 30)) }, { role: "assistant", content: "Sí." }] : h;
}
const UUID = "abcdef12-3456-4789-8abc-def012345678";
function _previosUuid(): any[] {
  const h = previos();
  h[6] = resultado("k1", { order: { id: UUID, items: [{ id: PID, name: "Refresco de cola", price: 62, quantity: 3 }] } });
  return h;
}
const _estado = (estadoPedido: string, id = "e1") => [
  llamada("estado_pedido", {}, id),
  resultado(id, { pedidos: [{ folio: UUID.slice(0, 8), estado: estadoPedido, estado_texto: "x", modalidad: "recoger" }] }),
];

// ---------------------------------------------------------------------------------------------------------------
// R20-7 (P2, búsqueda): catálogo REAL del arnés (scripts/medicion/fixtures/menu-pm.json).
const fx: any = menuPm;
const categorias = new Map<string, string>(fx.categories.map((c: any) => [c.id, c.name]));
function bdMenu() {
  const bp = fx.branch_products["garcia-lavin"];
  const filas = fx.products.filter((p: any) => bp[p.id]?.is_available).map((p: any) => ({
    price: bp[p.id].price,
    is_available: true,
    products: { id: p.id, name: p.name, description: p.description, restaurant_id: "r1", search_keywords: p.search_keywords ?? [], categories: { name: categorias.get(p.category_id) ?? null } },
  }));
  const q: any = { select: () => q, eq: () => q, limit: () => Promise.resolve({ data: filas, error: null }) };
  return { from: () => q };
}
const busca = (query: string): Promise<any> => pedidos.buscarProductosConExtrasCore(bdMenu(), { branchId: "b1", restaurantId: "r1", query });
const exactosDe = (r: any[]) => (r ?? []).filter((x: any) => !x.aproximado).map((x: any) => x.name as string);
const _todos = (r: any) => [...(r.productos ?? []), ...(r.otros_productos ?? []).flatMap((o: any) => o.resultados)].map((x: any) => x.name as string);

it("R20-7: «también» sin «y» separa las partes: «un taco de pastor también una coca»", async () => {
  const r = await busca("un taco de pastor también una coca");
  assert(exactosDe(r.productos).includes("Taco Al Pastor (individual)"), JSON.stringify(r.productos?.map((x: any) => x.name)));
  const otros = (r.otros_productos ?? []) as any[];
  assert(otros.length === 1 && otros[0].texto === "una coca" && otros[0].resultados.some((x: any) => x.name === "Coca-Cola"), JSON.stringify(otros));
  assert(JSON.stringify(pedidos.partesDelPedido("un taco de pastor también una coca")) === JSON.stringify(["un taco de pastor", "una coca"]), JSON.stringify(pedidos.partesDelPedido("un taco de pastor también una coca")));
  // Con «y también» sigue igual de bien (la parte ya no arrastra el «también»).
  const conY = await busca("un taco de pastor y también una coca");
  assert(exactosDe(conY.productos).includes("Taco Al Pastor (individual)") && (conY.otros_productos ?? []).length === 1, JSON.stringify(conY.otros_productos));
});
it("R20-7: el precio que dice el cliente («por $100», «$100», «por 100 pesos») no se busca como producto", async () => {
  for (const q of ["dos tacos de pastor por $100", "dos tacos de pastor $100", "dos tacos de pastor por 100 pesos", "dos tacos de pastor por $ 100.50"]) {
    const r = await busca(q);
    assert(exactosDe(r.productos).includes("Taco Al Pastor (individual)"), `${q} => ${JSON.stringify(r.productos?.map((x: any) => x.name))}`);
    assert(JSON.stringify(pedidos.partesDelPedido(q)) === JSON.stringify(["dos tacos de pastor"]), `${q} => ${JSON.stringify(pedidos.partesDelPedido(q))}`);
  }
  const kilo = await busca("un kilo de pastor por $200");
  assert(JSON.stringify(exactosDe(kilo.productos)) === JSON.stringify(["Pastor — 1 kg"]), JSON.stringify(kilo.productos?.map((x: any) => x.name)));
});
});

describe("fallos-c2-busqueda-platillo.test.ts", () => {
// Fallos del examen C2 (d1ff59b, Luna x5) -> rama fix/pm-fallos-4. Sin PII: todo sintetico.


// ---------------------------------------------------------------------------------------------
// 2. C2-POL-09 / C2-ROB-03: «poc chuc» y «arrachera» dejaban fuera el «Platillo de ...» (tope de 8).
// ---------------------------------------------------------------------------------------------
type Fila = { cat: string; name: string };
const filas = (lista: Fila[]) =>
  lista.map((p, i) => ({
    price: 100 + i,
    is_available: true,
    products: { id: `p${i}`, name: p.name, description: null, restaurant_id: "r1", search_keywords: [], categories: { name: p.cat } },
  }));
function bd(lista: Fila[]) {
  const f = filas(lista);
  // deno-lint-ignore no-explicit-any
  const q: any = { select: () => q, eq: () => q, limit: () => Promise.resolve({ data: f, error: null }) };
  return { from: () => q };
}
// Catalogo del arnes (scripts/medicion/fixtures/menu-pm.json): los productos «Poc-Chuc» y «Arrachera»
// en el orden en que los devuelve la BD; el «Platillo de ...» esta casi al final.
const poc: Fila[] = [
  ["Tacos", "Tacos de Poc-Chuc (orden de 3)"], ["Gringas", "Gringa de Poc-Chuc"], ["Mestizas", "Mestiza de Poc-Chuc"],
  ["Tacos Suizos", "Suizo de Poc-Chuc"], ["Flautas de PM", "Flauta de Poc-Chuc"], ["Chetacos", "Chetaco de Poc-Chuc"],
  ["Francés Suizo", "Francés Suizo de Poc-Chuc"], ["Kilos a Domicilio", "Poc-Chuc — 1 kg"], ["Kilos a Domicilio", "Poc-Chuc — 250 g"],
  ["Kilos a Domicilio", "Poc-Chuc — 500 g"], ["Platillos PM", "Platillo de Poc-Chuc"],
].map(([cat, name]) => ({ cat: cat!, name: name! }));
const arra: Fila[] = [
  ["Tacos", "Tacos de Arrachera (orden de 3)"], ["Gringas", "Gringa de Arrachera"], ["Mestizas", "Mestiza de Arrachera"],
  ["Alambre", "Alambre de Arrachera"], ["Tacos Suizos", "Suizo de Arrachera"], ["Flautas de PM", "Flauta de Arrachera"],
  ["Chetacos", "Chetaco de Arrachera"], ["Papas de PM", "Papa Arrachera"], ["Francés Suizo", "Francés Suizo de Arrachera"],
  ["Nachos", "Nachos de Arrachera"], ["Pizza Quesobich", "Quesobich de Arrachera"], ["Kilos a Domicilio", "Arrachera — 1 kg"],
  ["Kilos a Domicilio", "Arrachera — 500 g"], ["Platillos PM", "Fajitas de Arrachera"], ["Platillos PM", "Platillo de Arrachera"],
].map(([cat, name]) => ({ cat: cat!, name: name! }));



// Catalogo con la forma del menu real (scripts/medicion/fixtures/menu-pm.json): muchas categorias con «pastor».
const menu: Fila[] = [
  ...["Chuleta", "Champiñones", "Al Pastor", "Rajas", "Chorizo", "Bistec", "Cochinita", "Longaniza"].map((n) => ({ cat: "Tacos", name: `Taco ${n} (individual)` })),
  { cat: "Tacos Suizos", name: "Tacos Suizos de Chile Poblano y Bistec" },
  { cat: "Gringas", name: "Gringa de Pastor" }, { cat: "Gringas", name: "Gringa de Bistec" },
  { cat: "Alambre", name: "Alambre de Pastor" }, { cat: "Flautas de PM", name: "Flauta de Pastor" },
  { cat: "Nachos", name: "Nachos de Pastor" }, { cat: "Tacos Suizos", name: "Suizo de Pastor" }, { cat: "Papas de PM", name: "Papa Pastor" },
  { cat: "Mestizas", name: "Mestiza de Pastor" }, { cat: "Chetacos", name: "Chetaco de Pastor" },
  ...["750 g", "1 kg", "1.5 kg", "2 kg"].map((n) => ({ cat: "Kilos a Domicilio", name: `Pastor — ${n}` })),
  { cat: "Platillos PM", name: "Platillo de Pastor" },
  ...["Costilla", "Tradicional", "Pastor", "Chuleta", "Arrachera", "Bistec", "Pechuga", "Chorizo", "Queso"].map((n) => ({ cat: "Papas de PM", name: `Papa ${n}` })),
];
const nombresDe = async (q: string) =>
  (await pedidos.buscarProductosCore(bd(menu), { branchId: "b1", restaurantId: "r1", query: q })).map((x: { name: string }) => x.name);

it("POL-09 / ROB-03: «poc chuc», «arrachera» y sus variantes con «platillo» incluyen el Platillo en los 8 resultados", async () => {
  const casos: Array<[Fila[], string, string]> = [
    [poc, "poc chuc", "Platillo de Poc-Chuc"],
    [poc, "poc-chuc", "Platillo de Poc-Chuc"],
    [poc, "platillo de poc chuc", "Platillo de Poc-Chuc"],
    [arra, "arrachera", "Platillo de Arrachera"],
    [arra, "platillo arrachera", "Platillo de Arrachera"],
    [arra, "platillo de arrachera", "Platillo de Arrachera"],
  ];
  for (const [cat, query, esperado] of casos) {
    const r = await pedidos.buscarProductosCore(bd(cat), { branchId: "b1", restaurantId: "r1", query });
    const nombres = r.map((x: { name: string }) => x.name);
    assert(nombres.includes(esperado), `«${query}» -> ${JSON.stringify(nombres)}`);
    assert(nombres.length <= 8, `tope de 8: ${nombres.length}`);
  }
});
it("la busqueda diversifica por categoria: 12 filas de una sola categoria no tapan a las demas", async () => {
  const lista: Fila[] = [
    ...Array.from({ length: 12 }, (_, i) => ({ cat: "Kilos a Domicilio", name: `Pastor — ${i + 1} kg` })),
    { cat: "Tacos", name: "Tacos de Pastor (orden de 3)" },
    { cat: "Gringas", name: "Gringa de Pastor" },
  ];
  const r = await pedidos.buscarProductosCore(bd(lista), { branchId: "b1", restaurantId: "r1", query: "pastor" });
  const nombres = r.map((x: { name: string }) => x.name);
  assert(nombres.includes("Tacos de Pastor (orden de 3)") && nombres.includes("Gringa de Pastor"), JSON.stringify(nombres));
  assert(r.length === 8, `debian llenarse los 8: ${r.length}`);
});
it("ranking: «papas» (ya nombra su categoría) no se diversifica; «poc chuc» y «arrachera» conservan el platillo", async () => {
  const n = await nombresDe("papas");
  assert(n.length === 8 && n.every((x) => /^Papa /.test(x)), JSON.stringify(n));
  for (const [cat, q, esperado] of [[poc, "poc chuc", "Platillo de Poc-Chuc"], [arra, "arrachera", "Platillo de Arrachera"]] as Array<[Fila[], string, string]>) {
    const r = (await pedidos.buscarProductosCore(bd(cat), { branchId: "b1", restaurantId: "r1", query: q })).map((x: { name: string }) => x.name);
    assert(r.includes(esperado), JSON.stringify(r));
  }
});
});

describe("fallos-c3-1939849.test.ts", () => {

// Defectos del examen C3 sobre 1939849 (Luna x5; ANALISIS-C3-1939849.md). Sin PII: todo sintetico.
// Catalogo REAL del arnes (scripts/medicion/fixtures/menu-pm.json).



const fx: any = menuPm;
const cats = new Map<string, string>(fx.categories.map((c: any) => [c.id, c.name]));
function bdFixture(sucursal: string) {
  const bp = fx.branch_products[sucursal];
  const filas = fx.products.filter((p: any) => bp[p.id]?.is_available).map((p: any) => ({
    price: bp[p.id].price,
    is_available: true,
    products: { id: p.id, name: p.name, description: p.description, restaurant_id: "r1", search_keywords: p.search_keywords ?? [], categories: { name: cats.get(p.category_id) ?? null } },
  }));
  const q: any = { select: () => q, eq: () => q, limit: () => Promise.resolve({ data: filas, error: null }) };
  return { from: () => q };
}
const raw = (sucursal: string, query: string) => pedidos.buscarProductosCore(bdFixture(sucursal), { branchId: "b1", restaurantId: "r1", query });

// PED-07 r2 (regresion de 8692727): «normal», «regular», «sencillo» nombran la variante por omision; soltarlos no es una
// diferencia. Antes salia «Bistec de Res — 1 kg [aprox]» y el agente decia «no aparece el bistec normal por kilo».

// ---- estado_pedido con el reloj de la sesion (ANALISIS-C3-1939849, detalle 3) ----
// La herramienta llamaba a consultarPedidosRecientes y describirPedido sin el reloj inyectable: la ventana de 24 h y
// «hace N min» salian del reloj real, no del de la sesion (opciones.ahora), como el resto de las llamadas.

function _bdMenu() {
  const filas = (suc: string) => {
    const bp = fx.branch_products[suc];
    return fx.products.filter((p: any) => bp[p.id]?.is_available).map((p: any) => ({
      price: bp[p.id].price, is_available: true,
      products: { id: p.id, name: p.name, description: p.description, restaurant_id: "r1", search_keywords: p.search_keywords ?? [], categories: { name: cats.get(p.category_id) ?? null } },
    }));
  };
  const sucursales = Object.keys(fx.branch_products).map((slug, i) => ({ id: `b${i}`, slug, is_active: true, restaurant_id: "r1" }));
  return {
    from(tabla: string) {
      let branchId: string | null = null;
      const q: any = {
        select: () => q, order: () => q, limit: () => q,
        eq: (c: string, v: unknown) => {
          if (c === "branch_id") branchId = String(v);
          return q;
        },
        then: (ok: (v: unknown) => unknown, ko: (r: unknown) => unknown) => {
          const data = tabla === "branches" ? sucursales : tabla === "branch_products" ? filas(sucursales.find((s) => s.id === branchId)?.slug ?? "") : [];
          return Promise.resolve({ data, error: null }).then(ok, ko);
        },
      };
      return q;
    },
  };
}
const _hilo = (cliente: string, extra: any[] = []) => [...extra, { role: "user", content: cliente }];

it("C3-1939849 PED-07: «bistec normal por kilo» es Bistec de Res — 1 kg EXACTO (soltar «normal» no marca aproximado)", async () => {
  for (const suc of ["pensiones", "garcia-lavin"]) {
    for (const q of ["bistec normal por kilo", "bistec regular por kilo", "bistec sencillo por kilo", "un kilo de bistec normal"]) {
      const r = await raw(suc, q);
      const kilo = r.find((x: any) => /^Bistec de Res — 1 kg/.test(x.name));
      assert(!!kilo && r.every((x: any) => x.aproximado === undefined), `${suc} «${q}» -> ${JSON.stringify(r.map((x: any) => [x.name, x.aproximado]))}`);
    }
  }
});
it("C3-1939849 PED-07: un adjetivo que SI es diferencia (grande) sigue marcando aproximado, aunque venga con «normal»", async () => {
  for (const q of ["horchata grande", "coca cola grande", "horchata grande normal"]) {
    const r = await raw("garcia-lavin", q);
    assert(r.length > 0 && r.every((x: any) => x.aproximado === true), `«${q}» debia ser aproximado -> ${JSON.stringify(r.map((x: any) => [x.name, x.aproximado]))}`);
  }
});
});

describe("fallos-medicion-2.test.ts", () => {
// Fallos del agente hallados con el arnes de medicion (rama fix/pm-fallos-2).
// Una prueba por causa raiz; cada una fallaba antes del arreglo. Sin PII.




// ---- S-PED-001: «frances suizo» (sin acento) no encontraba «Francés Suizo» ----
function bdCatalogo(productos: Array<{ id: string; name: string; description?: string; categoria?: string; alias?: string[] }>) {
  const filas = productos.map((p) => ({
    price: 262,
    is_available: true,
    products: {
      id: p.id,
      name: p.name,
      description: p.description ?? "",
      restaurant_id: "r1",
      search_keywords: p.alias ?? [],
      categories: { name: p.categoria ?? "Platillos" },
    },
  }));
  const q: any = {
    select: () => q,
    eq: () => q,
    limit: () => Promise.resolve({ data: filas, error: null }),
  };
  return { from: () => q };
}


// ---- S-PED-012: ráfaga; el agente repetía «¿está bien la sucursal?» y nunca creaba el pedido ----
const llamada = (id: string, name: string) => ({
  role: "assistant",
  content: "",
  tool_calls: [{ id, function: { name, arguments: "{}" } }],
});
const resultado = (id: string, obj: unknown) => ({ role: "tool", tool_call_id: id, content: JSON.stringify(obj) });
const user = (content: string) => ({ role: "user", content });
const asistente = (content: string) => ({ role: "assistant", content });
const sucursalGL = { encontrada: true, branch_slug: "garcia-lavin", branch_name: "García Lavín (Victory Platz)", distancia_km: 1.3 };
const _hiloConPregunta = (...despues: unknown[]) => [
  user("Hola"),
  llamada("a", "buscar_sucursal_cercana"),
  resultado("a", sucursalGL),
  asistente("Su pedido saldría de García Lavín. ¿Está bien?"),
  ...despues,
];


// ---- S-ESC-004: el mismo reclamo con motivos redactados distinto generaba un aviso por mensaje ----
function _bdAvisos(filas: Array<Record<string, unknown>>) {
  const q: any = {
    filtros: [] as Array<[string, unknown]>,
    select() { return q; },
    eq(c: string, v: unknown) { q.filtros.push([c, v]); return q; },
    order() { return q; },
    update(v: Record<string, unknown>) {
      return { eq(_c: string, id: unknown) { Object.assign(filas.find((x) => x.id === id) ?? {}, v); return Promise.resolve({ error: null }); } };
    },
    limit() { return Promise.resolve({ data: filas.filter((f) => q.filtros.every(([c, v]: [string, unknown]) => f[c] === v)), error: null }); },
  };
  return { from: () => q };
}
const ahora = Date.parse("2026-10-16T19:30:00-06:00");
const hace = (min: number) => new Date(ahora - min * 60000).toISOString();
const TEL = "5219995550100";
const _abierto = (reason: string, extra: Record<string, unknown> = {}) => ({
  id: "a1", restaurant_id: "r1", customer_phone: TEL, resolved: false, branch_id: "b1", message: "llegó sin salsas", reason, created_at: hace(4), ...extra,
});


// ---- S-ESC-007: cotizar un evento no es un pedido; se registra el contacto ----

// ---- S-ROB-002: preguntar por la lluvia y recibir la misma cifra sin respuesta cortaba la conversación ----

// ---- Revisión independiente: sucursalAceptadaEnHilo (P1) ----
const _busca = (id: string, r: unknown) => [llamada(id, "buscar_sucursal_cercana"), resultado(id, r)];
const _sucursalAlt = { encontrada: true, branch_slug: "altabrisa", branch_name: "Altabrisa", distancia_km: 2 };
const _PREG_GL = "Su pedido saldría de García Lavín. ¿Está bien?";


// ---- Revisión independiente: esCotizacionDeEvento (P2a) ----

// ---- Revisión independiente: dedupe de post-venta (P2b, P2e) ----

// ---- Revisión independiente: la regla «Cierre del pedido» no se salta la cotización ni el aviso de pedido grande (P2d) ----
it("buscar_producto: el cliente escribe sin acentos («frances suizo») y encuentra «Francés Suizo»", async () => {
  const db = bdCatalogo([
    { id: "p1", name: "Francés Suizo de Pastor", alias: ["torta"] },
    { id: "p2", name: "Taco Al Pastor (individual)" },
  ]);
  for (const q of ["frances suizo de pastor", "francés suizo de pastor", "FRANCES SUIZO pastor"]) {
    const r = await pedidos.buscarProductosCore(db, { branchId: "b1", restaurantId: "r1", query: q });
    assert(r.length === 1 && r[0].id === "p1", `${q} -> ${JSON.stringify(r.map((x) => x.name))}`);
  }
});
it("buscar_producto: un alias con acento también se encuentra sin acento y al revés", async () => {
  const db = bdCatalogo([{ id: "p3", name: "Francés Suizo de Bistec de Res", alias: ["bisté", "bistek"] }]);
  for (const q of ["biste", "bisté", "bistek"]) {
    const r = await pedidos.buscarProductosCore(db, { branchId: "b1", restaurantId: "r1", query: q });
    assert(r.length === 1, `${q} no encontró el producto`);
  }
});
});

describe("fallos-medicion-3.test.ts", () => {
// Fallos del agente hallados con el banco ciego C1 (rama fix/pm-fallos-3). Una prueba por causa raiz;
// cada una fallaba antes del arreglo. Sin PII: todo es sintetico.



type Prod = { id: string; name: string; description?: string | null; categoria?: string; alias?: string[]; price?: number };

function bdCatalogo(productos: Prod[]) {
  const filas = productos.map((p) => ({
    price: p.price ?? 100,
    is_available: true,
    products: {
      id: p.id,
      name: p.name,
      description: p.description ?? null,
      restaurant_id: "r1",
      search_keywords: p.alias ?? [],
      categories: { name: p.categoria ?? "Platillos" },
    },
  }));
  const q: any = { select: () => q, eq: () => q, limit: () => Promise.resolve({ data: filas, error: null }) };
  return { from: () => q };
}

const buscar = (db: unknown, query: string) =>
  pedidos.buscarProductosCore(db, { branchId: "b1", restaurantId: "r1", query });

// ---- Causa raiz 1: «dos gringas» se contaban como 2 PIEZAS (= 1 orden) y «una gringa» como invalida ----
// C1-PED-10/17/25/29, POL-02/05/09/10, ROB-01/04, PED-11/13/16 (11 escenarios).
const MENU_PLATILLOS: Prod[] = [
  { id: "g1", name: "Gringa de Pastor", description: "Orden de 2 tacos", price: 194 },
  { id: "q1", name: "Quesadilla de Rajas", description: "Orden de 3 quesadillas. De maíz o harina", price: 124 },
  { id: "s1", name: "Suizo de Pechuga", description: "Orden de 5 tacos", price: 240 },
  { id: "t1", name: "Tacos de Bistec de Res (orden de 3)", description: "Orden de 3 tacos", price: 150 },
  { id: "i1", name: "Taco Al Pastor (individual)", description: "Orden individual", price: 42 },
];


// ---- Causa raiz 2: la busqueda devolvia las primeras 8 filas, sin orden y con «te» dentro de «bisTEc» ----
// C1-PED-05 (Guacamole), PED-27 (Te), ROB-10 (Coke), ROB-01 («grinbas»).
const MENU_BUSQUEDA: Prod[] = [
  ...["Pastor", "Champiñón", "Bistec", "Chuleta", "Pechuga", "Costilla", "Poc-Chuc", "Arrachera", "Chorizo", "Tocino"].map((c, i) => ({
    id: `f${i}`,
    name: `Francés Suizo de ${c}`,
    description: "Francés tostadito con guacamole, frijol, queso gratinado y carne",
  })),
  { id: "b1", name: "Tacos de Bistec de Res (orden de 3)", description: "Orden de 3 tacos", alias: ["bisté", "bistek"] },
  { id: "b2", name: "Tacos de Bistec Encebollado (orden de 3)", description: "Orden de 3 tacos", alias: ["bisté"] },
  { id: "tc", name: "Tecate Light", categoria: "Cervezas", alias: ["chela"] },
  { id: "te", name: "Té", categoria: "Bebidas" },
  { id: "gu", name: "Guacamole", categoria: "Entradas" },
  { id: "xg", name: "Extra Guacamole", categoria: "Extras" },
  { id: "fl", name: "Flauta de Pastor", description: "Tortilla de maíz grande, con ensalada de lechuga y tomate" },
  { id: "en", name: "Ensalada de PM", categoria: "Entradas" },
  { id: "c1", name: "Coca-Cola", description: "Botella o lata", categoria: "Refrescos" },
  { id: "gr", name: "Gringa de Pastor", description: "Orden de 2 tacos" },
  { id: "ti", name: "Taco Al Pastor (individual)", description: "Orden individual" },
];


// ---- Causa raiz 3: reclamos de post-venta sin aviso (el modelo contestaba sin llamar registrar_contacto) ----
// C1-ESC-04/05/06/10.
const _RECLAMOS = [
  "Mi pedido lleva mas de una hora, que paso?",
  "Me llego mi pedido pero me falto la coca que pedi, me la mandan?",
  "Pedi una papa de bistec y me llego de pechuga, me la cambian?",
  "Me cobraron de mas en mi tarjeta, mi pedido era de 224 y me cargaron mas",
  "Y me van a descontar algo o regalar algo por la tardanza?",
  "Quiero que me regresen la diferencia",
];
const _NO_RECLAMOS = [
  "Que pesimo servicio tienen, siempre tardan una eternidad",
  "Cuanto tarda mi pedido?",
  "Quiero 2 gringas de pastor para recoger",
  "Quien gano el partido de anoche?",
  "Me falta darle mi direccion",
  "Hola, quiero un suizo de pechuga y 3 cocas",
];

function _dbAvisos(callbacks: Array<Record<string, unknown>>) {
  const hacer = (tabla: string) => {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    upsert: (row: Record<string, unknown>) => {
      callbacks.push(row);
      return Promise.resolve({ error: null });
    },
    insert: (row: Record<string, unknown>) => {
      callbacks.push(row);
      return Promise.resolve({ error: null });
    },
    // El cliente tiene un pedido reciente (la via rapida de reclamo lo exige): solo `orders` devuelve fila.
    then: (ok: (v: unknown) => unknown, ko: (r: unknown) => unknown) => Promise.resolve({ data: tabla === "orders" ? [{ id: "o1", status: "entregado", created_at: new Date().toISOString() }] : [], error: null }).then(ok, ko),
  };
  return chain;
  };
  return { from: hacer, rpc: () => Promise.resolve({ data: "k", error: null }) };
}


// ---- Causa raiz 4: avisos de más por charla ajena a la comida o queja general ----
// C1-ROB-05 (futbol/peliculas), ROB-08 (cliente grosero).
it("platillos con nombre propio (gringa, quesadilla, suizo) se piden por platillo: pack_size null; los «(orden de N)» siguen en piezas", async () => {
  const db = bdCatalogo(MENU_PLATILLOS);
  const packs: Record<string, number | null> = {};
  for (const q of ["gringa", "quesadilla de rajas", "suizo de pechuga", "tacos de bistec", "taco al pastor"]) {
    for (const r of await buscar(db, q)) packs[r.name] = r.pack_size;
  }
  assert(packs["Gringa de Pastor"] === null, `gringa: ${packs["Gringa de Pastor"]}`);
  assert(packs["Quesadilla de Rajas"] === null, `quesadilla: ${packs["Quesadilla de Rajas"]}`);
  assert(packs["Suizo de Pechuga"] === null, `suizo: ${packs["Suizo de Pechuga"]}`);
  assert(packs["Tacos de Bistec de Res (orden de 3)"] === 3, "bistec en piezas");
  assert(packs["Taco Al Pastor (individual)"] === 1, "individual");
});
it("buscar «guacamole»: el platillo y el extra salen primero, no ocho francés suizo que solo lo traen en la descripción", async () => {
  const r = await buscar(bdCatalogo(MENU_BUSQUEDA), "guacamole");
  assert(r[0].name === "Guacamole" && r[1].name === "Extra Guacamole", JSON.stringify(r.map((x) => x.name)));
});
it("buscar «té»: el Té va primero y «bisté» (alias) ya no lo desplaza; una palabra corta solo cuenta al inicio de palabra", async () => {
  const db = bdCatalogo(MENU_BUSQUEDA);
  for (const q of ["té", "te", "un te"]) {
    const r = await buscar(db, q);
    assert(r[0]?.name === "Té", `${q} -> ${JSON.stringify(r.map((x) => x.name))}`);
    assert(!r.some((x) => /Bistec/.test(x.name)), `${q} trajo bistec por la subcadena «te»`);
  }
});
it("buscar «ensalada»: «Ensalada de PM» sale antes que la flauta que la menciona en su descripción", async () => {
  const r = await buscar(bdCatalogo(MENU_BUSQUEDA), "ensalada");
  assert(r[0].name === "Ensalada de PM", JSON.stringify(r.map((x) => x.name)));
});
it("buscar «coke»: es la Coca-Cola", async () => {
  const r = await buscar(bdCatalogo(MENU_BUSQUEDA), "una coke");
  assert(r.length === 1 && r[0].name === "Coca-Cola", JSON.stringify(r.map((x) => x.name)));
});
it("buscar con una letra mal escrita («grinbas de pastor») encuentra la gringa; si hay coincidencia exacta no se usa", async () => {
  const db = bdCatalogo(MENU_BUSQUEDA);
  const r = await buscar(db, "grinbas de pastor");
  assert(r.length >= 1 && r[0].name === "Gringa de Pastor", JSON.stringify(r.map((x) => x.name)));
  assert((await buscar(db, "xyzabc")).length === 0, "inventó un producto");
  const exacto = await buscar(db, "gringa de pastor");
  assert(exacto.length === 1 && exacto[0].name === "Gringa de Pastor", "la exacta debe ganar");
});
});

describe("fallos-medicion-4.test.ts", () => {

// ---- C1-ESC-09: «parrillada para 4 personas» no encontraba «Parrillada para 4» ----
function bdParrilladas() {
  const filas = [
    { id: "p2", name: "Parrillada para 2", price: 612 },
    { id: "p4", name: "Parrillada para 4", price: 1045 },
    { id: "al", name: "Alambre de Res", price: 276 },
  ].map((p) => ({
    price: p.price,
    is_available: true,
    products: { id: p.id, name: p.name, description: "* No incluye guarniciones estándar", restaurant_id: "r1", search_keywords: [], categories: { name: "Parrilladas" } },
  }));
  const q: any = { select: () => q, eq: () => q, limit: () => Promise.resolve({ data: filas, error: null }) };
  return { from: () => q };
}


// ---- C1-PED-02/10/14/25: la tortilla de una gringa se descartaba y el modelo avisaba «modificacion_pedido» ----

// ---- Revision independiente: tope por intento y 429 con espera ----
function _bdTurno() {
  const chain = {
    select() { return this; },
    eq() { return this; },
    maybeSingle() { return Promise.resolve({ data: null, error: null }); },
  };
  return { from() { return chain; }, rpc() { return Promise.resolve({ data: "test-key", error: null }); } };
}
const _okModelo = (texto: string) =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: texto } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });


// ---- Desempate por digito: el digito de cantidad no cuenta ----
function bdCatalogo(nombres: string[]) {
  const filas = nombres.map((name, i) => ({
    price: 100 + i,
    is_available: true,
    products: { id: `x${i}`, name, description: "", restaurant_id: "r1", search_keywords: [], categories: { name: "Varios" } },
  }));
  const q: any = { select: () => q, eq: () => q, limit: () => Promise.resolve({ data: filas, error: null }) };
  return { from: () => q };
}
async function _primero(nombres: string[], query: string) {
  const r = await pedidos.buscarProductosCore(bdCatalogo(nombres), { branchId: "b1", restaurantId: "r1", query });
  return r.map((x: any) => x.name);
}


// ---- Segunda revision: un 5xx/429 con cuerpo colgado tampoco pasa del presupuesto ----

// ---- Segunda revision: el digito seguido de una unidad de medida es tamano, no cantidad ----
it("«parrillada para 4 personas» / «para 4 comensales» encuentra la Parrillada para 4", async () => {
  for (const query of ["parrillada para 4 personas", "parrilladas de 4 personas", "parrillada 4 comensales", "parrillada para 4 gente", "parrillada para 4"]) {
    const r = await pedidos.buscarProductosCore(bdParrilladas(), { branchId: "b1", restaurantId: "r1", query });
    assert(r.length > 0 && r[0].name === "Parrillada para 4", `«${query}» -> ${JSON.stringify(r.map((x: any) => x.name))}`);
  }
});
it("digitosDeDesempate: «2 litros de coca» / «1 litro» / «1 kg» conservan el digito; «2 piezas» y las cantidades no", () => {
  const d = (q: string) => JSON.stringify(pedidos.digitosDeDesempate(q));
  assert(d("2 litros de coca") === '["2"]', d("2 litros de coca"));
  assert(d("dame, 2 litros de coca") === '["2"]', d("dame, 2 litros de coca"));
  assert(d("1 litro") === '["1"]', d("1 litro"));
  assert(d("quiero 1 kg de arrachera") === '["1"]', d("quiero 1 kg de arrachera"));
  assert(d("2 ml") === '["2"]', d("2 ml"));
  // «piezas» cuenta unidades: el 2 es cantidad (decision documentada en UNIDADES_DE_MEDIDA)
  assert(d("2 piezas") === "[]", d("2 piezas"));
  assert(d("quiero 2 piezas de gringa") === "[]", d("quiero 2 piezas de gringa"));
  // relleno nuevo y puntuacion
  assert(d("hola, agrégame 2 parrilladas de 4 personas") === '["4"]', d("hola, agrégame 2 parrilladas de 4 personas"));
  assert(d("pon unos 3 tacos") === "[]", d("pon unos 3 tacos"));
  assert(d("dame, 2 parrilladas para 4") === '["4"]', d("dame, 2 parrilladas para 4"));
  // pedido compuesto: 3 y 1 son cantidades, el 2 de «2 litros» es tamano
  assert(d("dame 3 tacos de bistec y 1 coca 2 litros") === '["2"]', d("dame 3 tacos de bistec y 1 coca 2 litros"));
});
});

describe("create-order-core.test.ts", () => {
type TestQuery = {
  table: string;
  calls: Array<{ method: string; args: unknown[] }>;
};
type DatabaseStep = {
  table: string;
  response: unknown;
  inspect?: (query: TestQuery) => void;
};

function _scriptedDatabase(steps: DatabaseStep[]) {
  const pending = [...steps];
  const finish = (query: TestQuery) => {
    const step = pending.shift();
    if (!step || step.table !== query.table) {
      throw new Error(
        `unexpected query to ${query.table}, expected ${step?.table}`,
      );
    }
    step.inspect?.(query);
    return Promise.resolve(step.response);
  };
  return {
    from(table: string) {
      const query: TestQuery = { table, calls: [] };
      const chain = {
        select(...args: unknown[]) {
          query.calls.push({ method: "select", args });
          return chain;
        },
        eq(...args: unknown[]) {
          query.calls.push({ method: "eq", args });
          return chain;
        },
        in(...args: unknown[]) {
          query.calls.push({ method: "in", args });
          return chain;
        },
        insert(...args: unknown[]) {
          query.calls.push({ method: "insert", args });
          return chain;
        },
        update(...args: unknown[]) {
          query.calls.push({ method: "update", args });
          return chain;
        },
        upsert(...args: unknown[]) {
          query.calls.push({ method: "upsert", args });
          return chain;
        },
        single() {
          return finish(query);
        },
        maybeSingle() {
          return finish(query);
        },
        then(
          resolve: (value: unknown) => unknown,
          reject: (reason: unknown) => unknown,
        ) {
          return finish(query).then(resolve, reject);
        },
      };
      return chain;
    },
    rpc(name: string, args: unknown) {
      return finish({ table: name, calls: [{ method: "rpc", args: [args] }] });
    },
    done() {
      if (pending.length) {
        throw new Error(`${pending.length} database calls not executed`);
      }
    },
  };
}

const orderProductId = "11111111-1111-4111-8111-111111111111";

function _preparationSteps(): DatabaseStep[] {
  return [
    {
      table: "branches",
      response: {
        data: {
          id: "branch",
          name: "Test",
          restaurant_id: "restaurant",
          is_active: true,
        },
        error: null,
      },
    },
    {
      table: "branch_products",
      response: {
        data: [{
          price: 250,
          is_available: true,
          products: {
            id: orderProductId,
            name: "Tacos de Bistec (orden de 3)",
            description: null,
            categories: { name: "Tacos" },
          },
        }],
        error: null,
      },
    },
  ];
}

function _persistenceSteps(
  inspectRpc?: DatabaseStep["inspect"],
  addressCount = 1,
): DatabaseStep[] {
  return [
    {
      table: "customers",
      response: {
        data: { id: "customer", name: "Test", order_count: 99 },
        error: null,
      },
    },
    {
      table: "customers",
      response: { data: { id: "customer" }, error: null },
      inspect(query) {
        const update = query.calls.find((call) => call.method === "update")
          ?.args[0] as Record<string, unknown>;
        if ("order_count" in update) {
          throw new Error(
            "overwrote a concurrent customer order increment",
          );
        }
      },
    },
    {
      table: "customer_addresses",
      response: { data: null, count: addressCount, error: null },
    },
    {
      table: "customer_addresses",
      response: { data: null, error: null },
      inspect(query) {
        const address = query.calls.find((call) => call.method === "upsert")
          ?.args[0] as Record<string, unknown>;
        if (address.is_default !== (addressCount === 0)) {
          throw new Error(
            "default address ignored the HEAD count",
          );
        }
      },
    },
    {
      table: "create_order_idempotent",
      response: { data: { id: "order" }, error: null },
      inspect: inspectRpc,
    },
  ];
}

it("product search ignores spoken quantities and category filler", () => {
  const tokenize = (orderCore as Record<string, unknown>)
    .tokenizeForProductSearch;
  if (typeof tokenize !== "function") {
    throw new Error("tokenizeForProductSearch is not implemented");
  }
  const tokens = (tokenize as (query: string) => string[])(
    "quiero dos cervezas Sol",
  );
  if (JSON.stringify(tokens) !== JSON.stringify(["sol"])) {
    throw new Error(`expected a single product token, got ${tokens}`);
  }
  const zeroAlcohol = (tokenize as (query: string) => string[])(
    "dos Heineken cero punto cero",
  );
  if (JSON.stringify(zeroAlcohol) !== JSON.stringify(["heineken", "0.0"])) {
    throw new Error(`expected spoken 0.0 normalization, got ${zeroAlcohol}`);
  }
});
});
