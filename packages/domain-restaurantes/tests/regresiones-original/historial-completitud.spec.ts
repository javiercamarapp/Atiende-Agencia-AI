// Regresiones del HISTORIAL del original (atiende-restaurantes @ 13fb3bd) que la tabla de trazabilidad marcaba PARCIAL: la correccion
// vivia en main pero ninguna prueba la nombraba (import-orig-11, hallazgo NC-HIST). Una prueba por bug, con el codigo Hnn y el commit en el
// titulo. Todo es servidor/prompt (sin LLM). Reloj fijo: miercoles 12:00 America/Merida (= 18:00Z).
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../../src/agent-tools/registry.ts";
import { getSalesKpis, getSalesTrendKpis } from "../../src/kpis.ts";
import { createOrder, quoteOrder, searchProducts } from "../../src/orders.ts";
import { FALLBACK_CONFIG, PM_CONFIG_POR_OMISION, buildSystemPrompt, enforceBistecPackNotice } from "../../src/whatsapp/llm-turn-handler.ts";
import type { Order } from "../../src/types.ts";
import { item, mensajeDe, pedido, pmFixture } from "./fixture.ts";
import type { F } from "./fixture.ts";

const MIERCOLES_12_MERIDA = new Date("2026-10-07T18:00:00Z");
const ZONA = "America/Merida";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(MIERCOLES_12_MERIDA);
});
afterEach(() => {
  vi.useRealTimers();
});

const nombres = async (f: F, query: string) => (await searchProducts(f.repo, { propertyId: f.t1, query })).map((r) => r.name);
const sucursales = [{ propertyId: "p1", slug: "t1", name: "Prolongacion Montejo", address: null }];
const promptPM = () => buildSystemPrompt(PM_CONFIG_POR_OMISION, sucursales, { isNew: true }, MIERCOLES_12_MERIDA);
const promptGenerico = () => buildSystemPrompt(FALLBACK_CONFIG, sucursales, { isNew: true }, MIERCOLES_12_MERIDA);

/** Agrega un producto "(orden de N)" a las tres sucursales del fixture (pack_size se infiere del nombre, igual que el servidor). */
function conPack(f: F, nombre: string, precio: number): string {
  const id = randomUUID();
  f.repo.seedProduct({ id, organizationId: f.organizationId, categoryId: null, name: nombre, description: null, searchKeywords: [] });
  for (const propertyId of [f.t1, f.t3, f.t8]) f.repo.seedBranchProduct({ propertyId, productId: id, price: precio, isAvailable: true });
  return id;
}

describe("H35 / cec17f1: sinonimos reales ('chela', 'cheve', 'trompo', 'pizza') resuelven al producto", () => {
  it("H35 / cec17f1: «dos chelas» resuelve a Cervezas (Sol) y «una pizza» ofrece Quesobich", async () => {
    const f = pmFixture();
    const chelas = await searchProducts(f.repo, { propertyId: f.t1, query: "dos chelas" });
    expect(chelas.map((r) => r.name)).toEqual(["Sol"]);
    expect(chelas[0]!.categoryName).toBe("Cervezas");
    expect(await nombres(f, "una pizza")).toEqual(["Quesobich de Queso"]);
  });

  it("H35 / cec17f1: «una cheve» y «trompo» tambien resuelven (cerveza y pastor)", async () => {
    const f = pmFixture();
    const victoria = randomUUID();
    f.repo.seedProduct({ id: victoria, organizationId: f.organizationId, categoryId: f.categorias.cervezas, name: "Victoria", description: null, searchKeywords: ["cheve"] });
    f.repo.seedBranchProduct({ propertyId: f.t1, productId: victoria, price: 60, isAvailable: true });
    expect(await nombres(f, "una cheve")).toEqual(["Victoria"]);
    expect(await nombres(f, "trompo")).toEqual(["Taco al Pastor (individual)"]);
  });

  it("H35 / cec17f1 (negativo): el sinonimo no arrastra productos ajenos ni inventa coincidencias", async () => {
    const f = pmFixture();
    expect(await nombres(f, "dos coca colas")).toEqual(["Coca-Cola"]);
    expect(await nombres(f, "una chela")).not.toContain("Coca-Cola");
    expect(await nombres(f, "sushi")).toEqual([]);
  });
});

describe("H37 / abc543a: la frase de pack usa el N real de cada producto, no solo el bistec de 3", () => {
  it("H37 / abc543a: un sabor 'orden de 6' rechaza 4 y 8 diciendo «órdenes de 6» y ofrece multiplos de 6", async () => {
    const f = pmFixture();
    const pollo = conPack(f, "Tacos de Pollo (orden de 6)", 150);
    const base = { organizationId: f.organizationId, branchSlug: "t1-montejo", canal: "recoger" as const };
    const cuatro = await mensajeDe(quoteOrder(f.repo, { ...base, items: [item(pollo, 4, "maiz")] }));
    expect(cuatro).toMatch(/solo se vende en órdenes de 6 piezas/);
    expect(cuatro).toMatch(/puedes pedir 6\./);
    const ocho = await mensajeDe(quoteOrder(f.repo, { ...base, items: [item(pollo, 8, "maiz")] }));
    expect(ocho).toMatch(/puedes pedir 6 o 12/);
    expect(ocho).not.toMatch(/órdenes de 3/);
  });

  it("H37 / abc543a: con pack de 2 la misma frase dice 2 (no 3) y 6 piezas son 3 ordenes al precio por orden", async () => {
    const f = pmFixture();
    const par = conPack(f, "Gringas (orden de 2)", 80);
    const base = { organizationId: f.organizationId, branchSlug: "t1-montejo", canal: "recoger" as const };
    expect(await mensajeDe(quoteOrder(f.repo, { ...base, items: [item(par, 3, "maiz")] }))).toMatch(/órdenes de 2 piezas.*puedes pedir 2 o 4/);
    const q = await quoteOrder(f.repo, { ...base, items: [item(par, 6, "maiz")] });
    expect(q.total).toBe(240);
  });

  it("H37 / abc543a (negativo): un multiplo exacto y un producto individual (pack 1) no lanzan la frase de pack", async () => {
    const f = pmFixture();
    const pollo = conPack(f, "Tacos de Pollo (orden de 6)", 150);
    const base = { organizationId: f.organizationId, branchSlug: "t1-montejo", canal: "recoger" as const };
    expect((await quoteOrder(f.repo, { ...base, items: [item(pollo, 12, "maiz")] })).total).toBe(300);
    expect((await quoteOrder(f.repo, { ...base, items: [item(f.p.pastor, 8, "maiz")] })).total).toBe(336);
  });

  it("H37 / abc543a: el aviso reforzado de bistec no se dispara con otro taco (el N sale del servidor, no de un 3 fijo) y el prompt manda multiplos de cualquier pack_size", () => {
    const pollo = enforceBistecPackNotice("Claro.", [{ role: "user", content: "quiero 4 tacos de pollo" }]);
    expect(pollo).toBe("Claro.");
    expect(enforceBistecPackNotice("Claro.", [{ role: "user", content: "quiero tacos de bistec" }])).toMatch(/órdenes de 3/);
    expect(promptGenerico()).toMatch(/cualquier producto con pack_size mayor a 1, solo acepta múltiplos exactos/);
    // El perfil PM lo dice con sus palabras: «órdenes de N» en múltiplos de N para cualquier producto, y el aviso fijo solo para el bistec.
    expect(promptPM()).toMatch(/las "órdenes de N" solo se venden en múltiplos de N/);
  });
});

describe("H39 / 5d164ee: edad evasiva al pedir alcohol -> se pide un si/no claro, nunca 'no disponible'", () => {
  const evasivas = ["pues ahi vemos si soy mayor", "pues si, ¿que mas da?", "ya sabes que si", "jaja tu que crees", "no me acuerdo"];

  it("H39 / 5d164ee: el servidor no acepta una edad evasiva (texto) como confirmacion y pide confirmacion explicita sin decir 'no disponible'", async () => {
    const f = pmFixture();
    for (const evasiva of evasivas) {
      const out = await invokeAgentTool(f.repo, { organizationId: f.organizationId, channel: "whatsapp", phone: "+5219990000000" }, "cotizar_pedido", {
        branch_slug: "t1-montejo",
        canal: "recoger",
        items: [{ product_id: f.p.sol, product_name: "Sol", requested_quantity: 6 }],
        adult_confirmed: evasiva,
      }).catch((e: unknown) => e);
      const texto = JSON.stringify(out instanceof Error ? out.message : out);
      expect(texto, evasiva).toMatch(/mayor de edad/);
      expect(texto, evasiva).not.toMatch(/no disponible|agotado/i);
    }
  });

  it("H39 / 5d164ee: cotizar y crear alcohol sin confirmar lanza la pregunta de edad (no 'agotado') y con confirmacion explicita si pasa", async () => {
    const f = pmFixture();
    const sinConfirmar = await mensajeDe(quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "t1-montejo", canal: "recoger", items: [item(f.p.sol, 6)] }));
    expect(sinConfirmar).toMatch(/mayor de edad/);
    expect(sinConfirmar).not.toMatch(/no disponible|agotado/i);
    const creando = await mensajeDe(createOrder(f.repo, pedido(f, [item(f.p.sol, 6)])));
    expect(creando).toMatch(/mayor de edad/);
    expect(creando).not.toMatch(/no disponible|agotado/i);
    const q = await quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "t1-montejo", canal: "recoger", adultConfirmed: true, items: [item(f.p.sol, 6)] });
    expect(q.total).toBe(396);
  });

  it("H39 / 5d164ee: el prompt generico manda re-preguntar directo ante una respuesta evasiva y prohibe el pretexto 'no disponible'", () => {
    expect(promptGenerico()).toMatch(/Si la respuesta es evasiva o ambigua, vuelve a preguntar de forma directa/);
    expect(promptGenerico()).toMatch(/nunca digas que el producto no está disponible como pretexto/);
    expect(promptGenerico()).toMatch(/Nunca lo infieras por el tono, el nombre, la voz o una respuesta ambigua/);
  });

  it("H39 / 5d164ee: el perfil PM (P01) ni pregunta la edad: nunca manda adult_confirmed y explica con la palabra «alcohol» que se adquiere en sucursal, sin fingir agotado", () => {
    expect(promptPM()).toMatch(/nunca mande adult_confirmed/);
    expect(promptPM()).toMatch(/explíquele con la palabra "alcohol" que no se toma por este medio/);
  });

  it("H39 / 5d164ee (negativo): un producto sin alcohol no pide edad aunque el cliente sea evasivo", async () => {
    const f = pmFixture();
    const q = await quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "t1-montejo", canal: "recoger", items: [item(f.p.cocaCola, 2)] });
    expect(q.total).toBe(90);
  });
});

describe("H34 / c25e70c: el prompt prohibe un segundo crear_pedido (defensa en profundidad; el servidor ya dedupe, ver X08)", () => {
  it("H34 / c25e70c: el prompt generico trae la REGLA DURA de no volver a llamar crear_pedido y solo repetir el resumen", () => {
    const prompt = promptGenerico();
    expect(prompt).toMatch(/REGLA DURA: si en esta MISMA conversación ya llamaste a crear_pedido y te respondió con éxito, NUNCA vuelvas a llamarla/);
    expect(prompt).toMatch(/repítele el resumen del pedido/);
    expect(prompt).toMatch(/duplicado en cocina/);
  });

  it("H34 / c25e70c: el prompt del perfil PM (H12) pide crear_pedido una sola vez y, ante otro «sí», responder con el resumen ya creado", () => {
    expect(promptPM()).toMatch(/Una sola vez crear_pedido por pedido\. Si el cliente repite "sí", "confirmo" o "¿ya\?", responda con el resumen ya creado; nunca vuelva a llamar crear_pedido/);
  });

  it("H34 / c25e70c (negativo): ningun prompt invita a crear un segundo pedido", () => {
    for (const prompt of [promptPM(), promptGenerico()]) {
      expect(prompt).not.toMatch(/(puedes|debes|vuelve a) llamar (de nuevo |otra vez )?(a )?crear_pedido/i);
    }
  });
});

describe("H61 / 5f7cbb9: las estadisticas suman TODOS los pedidos (sin tope de 1000 filas)", () => {
  function pedidos(f: ReturnType<typeof pmFixture>, n: number, total: number, extra: Partial<Order> = {}): Order[] {
    return Array.from({ length: n }, (_, i) => ({
      id: randomUUID(),
      organizationId: f.organizationId,
      propertyId: f.t1,
      customerId: `c-${i % 50}`,
      customerName: `Cliente ${i % 50}`,
      customerPhone: "9990000000",
      customerAddress: null,
      customerEmail: null,
      branch: null,
      total,
      status: "completado",
      items: [{ id: randomUUID(), name: "Coca-Cola", price: total, quantity: 1 }],
      source: "web",
      notes: null,
      paymentMethod: null,
      callTranscript: null,
      callRecordingUrl: null,
      dedupeFingerprint: null,
      idempotencyKey: null,
      // Repartidos entre las 09:00 y las 20:59 del miercoles (hora de Merida = UTC-6).
      createdAt: new Date(Date.UTC(2026, 9, 7, 15 + (i % 12), i % 60, 0)).toISOString(),
      assignedRepartidorId: null,
      estimatedDeliveryAt: null,
      incidentNote: null,
      ...extra,
    })) as Order[];
  }

  it("H61 / 5f7cbb9: 1,200 pedidos de $10 suman exactamente $12,000 y 1,200 ordenes (hoy, 7 dias y tendencia)", async () => {
    const f = pmFixture();
    for (const o of pedidos(f, 1200, 10)) f.repo.seedOrder(o);

    const hoy = await getSalesKpis(f.repo, f.organizationId, null, "today", new Date(), ZONA);
    expect(hoy.revenue).toBe(12000);
    expect(hoy.orders).toBe(1200);
    expect(hoy.averageOrder).toBe(10);
    const semana = await getSalesKpis(f.repo, f.organizationId, null, "7", new Date(), ZONA);
    expect(semana.revenue).toBe(12000);
    expect(semana.orders).toBe(1200);

    const tendencia = await getSalesTrendKpis(f.repo, f.organizationId, null, "7", new Date(), null);
    expect(tendencia.reduce((s, p) => s + p.revenue, 0)).toBe(12000);
    expect(tendencia.reduce((s, p) => s + p.orders, 0)).toBe(1200);
  });

  it("H61 / 5f7cbb9 (negativo): los cancelados no suman aunque el volumen pase de 1,000", async () => {
    const f = pmFixture();
    for (const o of pedidos(f, 1100, 10)) f.repo.seedOrder(o);
    for (const o of pedidos(f, 150, 999, { status: "cancelado" })) f.repo.seedOrder(o);
    const hoy = await getSalesKpis(f.repo, f.organizationId, null, "today", new Date(), ZONA);
    expect(hoy.revenue).toBe(11000);
    expect(hoy.orders).toBe(1100);
  });
});
