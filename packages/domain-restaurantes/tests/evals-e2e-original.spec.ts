// Escenarios E2E del original (anexo NC-E2E): forma, ausencia de datos personales, totales recalculados con el menu de PM, el agente de referencia
// sin LLM contra el mundo simulado y los graders, y una comprobacion por cada escenario que depende de una regla del servidor: 10 ejecutan el SERVIDOR REAL
// (invokeAgentTool / reglas de dominio sobre el repositorio en memoria) y C26 combina el mundo simulado con la regla real del 0.0.
// Sin reloj: ningun escenario depende de la fecha o la hora real (la hora del caso es un dato de entrada del arnes).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CONTRATO_OBJETIVO, Mundo, cargarMenu, cargarSuite } from "../src/evals/agente-pm/mundo.ts";
import { GRADERS, evaluarCaso } from "../src/evals/agente-pm/graders.ts";
import { ejecutarCasoReferencia } from "../src/evals/agente-pm/ejecutor.ts";
import { cargarEscenariosE2eOriginal, type CasoE2eOriginal } from "../src/evals/agente-pm/escenarios-e2e-original.ts";
import { canonicalizeMexicanPhone } from "../src/phone.ts";
import { createOrder } from "../src/orders.ts";
import { requiresAdultConfirmation } from "../src/product-search.ts";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { PM_CONFIG_POR_OMISION, buildSystemPrompt, enforceBistecPackNotice, saludoSegunHora } from "../src/whatsapp/llm-turn-handler.ts";
import { enforceQuotedTotal } from "../src/whatsapp/guards.ts";
import { NEW_CUSTOMER } from "./pm/harness.ts";
import { item, mensajeDe, pedido, pmFixture, type F } from "./regresiones-original/fixture.ts";

const suite = cargarEscenariosE2eOriginal();
const base = cargarSuite();
const menu = cargarMenu();
const activos = suite.casos.filter((c) => c.estado === "activo");
const pendientes = suite.casos.filter((c) => c.estado === "pendiente_decision");

const precioDe = (nombre: string) => menu.find((p) => p.nombre === nombre)!;
/** Total recalculado A MANO contra el menu de PM (independiente del mundo): precio por orden * ordenes. */
function totalDe(items: readonly { producto: string; piezas: number }[]): number {
  return items.reduce((s, i) => {
    const p = precioDe(i.producto);
    return s + p.precio_mxn * (p.pack_size > 1 ? i.piezas / p.pack_size : i.piezas);
  }, 0);
}
const caso = (id: string): CasoE2eOriginal => suite.casos.find((c) => c.id === id)!;
const mundoDe = (id: string) => new Mundo(caso(id), base, menu, CONTRATO_OBJETIVO);

describe("escenarios E2E del original: forma y datos", () => {
  it("son C22-C37 (chat) y L48-L49 (voz), sin chocar con los IDs de casos.json", () => {
    expect(suite.casos.map((c) => c.id)).toEqual([...Array.from({ length: 16 }, (_, i) => `C${22 + i}`), "L48", "L49"]);
    const existentes = new Set(base.casos.map((c) => c.id));
    expect(suite.casos.filter((c) => existentes.has(c.id))).toEqual([]);
    for (const c of suite.casos) expect(c.canal, c.id).toBe(c.id.startsWith("L") ? "llamada" : "chat");
  });

  it("cada escenario cita su origen (fila E del anexo), usa graders que existen y declara resultado coherente", () => {
    for (const c of suite.casos) {
      expect(c.origen_original, c.id).toMatch(/^E\d{2} \/ /);
      expect(c.graders.length, c.id).toBeGreaterThan(0);
      for (const g of c.graders) expect(Object.keys(GRADERS), `${c.id} ${g}`).toContain(g);
      expect(c.esperado.resultado === "comanda" ? Boolean(c.esperado.comanda) : Boolean(c.esperado.escalar), c.id).toBe(true);
      expect(c.contexto.sucursal_contexto in base.fixtures.sucursales, c.id).toBe(true);
    }
  });

  it("los pendientes de decision son exactamente C24 y C25 (alcohol para recoger, P17) y llevan la duda escrita", () => {
    expect(pendientes.map((c) => c.id)).toEqual(["C24", "C25"]);
    for (const c of pendientes) expect(c.dudas.join(" "), c.id).toMatch(/P17/);
    expect(activos).toHaveLength(16);
  });

  it("cero PII: telefonos 9995550xxx, nombres como [NOMBRE], sin correos, links ni tarjetas", () => {
    const crudo = JSON.stringify(suite.casos);
    expect(crudo).not.toMatch(/@|https?:\/\/|www\.|\b\d{4} \d{4} \d{4}/);
    for (const c of suite.casos) {
      const d = c.simulador_cliente.datos;
      for (const k of ["telefono", "telefono_primer_intento"]) if (d[k]) expect(d[k], `${c.id} ${k}`).toMatch(/^9995550\d{3,4}$/);
      if (d.nombre) expect(d.nombre, c.id).toMatch(/^\[NOMBRE(_[A-C])?\]$/);
    }
  });
});

describe("escenarios E2E del original: totales recalculados con menu-pm.json (no los del original)", () => {
  for (const c of suite.casos.filter((x) => x.esperado.comanda)) {
    it(`${c.id}: los productos existen, respetan su pack y el total es el del menu de PM`, () => {
      const com = c.esperado.comanda!;
      for (const i of com.items) {
        const p = menu.find((m) => m.nombre === i.producto);
        expect(p, `${c.id}: ${i.producto} no esta en el menu`).toBeDefined();
        expect(i.piezas % p!.pack_size, `${c.id}: ${i.producto} fuera de multiplos de ${p!.pack_size}`).toBe(0);
      }
      expect(com.total_mxn).toBe(totalDe(com.items));
      if (com.tipo === "domicilio") expect(com.total_mxn, `${c.id}: domicilio bajo el minimo`).toBeGreaterThanOrEqual(200);
    });
  }

  it("L49 (la orden mixta grande): 8 pastor + 2 ordenes de bistec = 8*42 + 2*194 recalculado, no copiado", () => {
    expect(precioDe("Taco Al Pastor (individual)").precio_mxn * 8 + precioDe("Tacos de Bistec de Res (orden de 3)").precio_mxn * 2).toBe(caso("L49").esperado.comanda!.total_mxn);
  });
});

describe("escenarios E2E del original: agente de referencia sin LLM", () => {
  for (const c of activos) {
    it(`${c.id} (${c.categoria}) pasa todos sus graders con el contrato objetivo`, async () => {
      const { resultado } = await ejecutarCasoReferencia(c, CONTRATO_OBJETIVO, base);
      expect(resultado.graders.filter((g) => !g.ok), c.id).toEqual([]);
      expect(resultado.ok).toBe(true);
    });
  }

  for (const c of pendientes) it.todo(`${c.id} (${c.categoria}) pendiente_decision: ${c.dudas[0]?.slice(0, 60)}`);

  it("NEGATIVO: los graders muerden; la comanda REAL del mundo contra un total, un nombre o un producto distintos hace fallar a G_COMANDA", async () => {
    for (const id of ["C22", "L49", "C37"]) {
      const c = caso(id);
      const { mundo, resultado } = await ejecutarCasoReferencia(c, CONTRATO_OBJETIVO, base);
      expect(resultado.ok, id).toBe(true);
      const comanda = c.esperado.comanda!;
      const mutaciones = {
        total: { ...comanda, total_mxn: comanda.total_mxn + 1 },
        nombre: { ...comanda, nombre: "[NOMBRE_A]" },
        producto: { ...comanda, items: [{ producto: "Coca-Cola", piezas: 1 }] },
      };
      for (const [que, mala] of Object.entries(mutaciones)) {
        if (que === "nombre" && comanda.nombre === "[NOMBRE_A]") continue;
        const malo = { ...c, esperado: { ...c.esperado, comanda: mala } };
        expect(evaluarCaso(malo, mundo).graders.find((g) => g.grader === "G_COMANDA")?.ok, `${id} ${que}`).toBe(false);
      }
    }
  });

  it("NEGATIVO: una escalacion con motivo fuera de los validos hace fallar a G_ESCALACION (C34 solo acepta privacidad_arco)", async () => {
    const c = caso("C34");
    const { mundo } = await ejecutarCasoReferencia(c, CONTRATO_OBJETIVO, base);
    expect(mundo.escalaciones.map((e) => e.motivo)).toEqual(["privacidad_arco"]);
    const otro = { ...c, esperado: { ...c.esperado, escalar: { ...c.esperado.escalar!, motivos_validos: ["queja"] } } };
    expect(evaluarCaso(otro, mundo).graders.find((g) => g.grader === "G_ESCALACION")?.ok).toBe(false);
  });
});

// ---- Comprobaciones contra el SERVIDOR REAL (invokeAgentTool / reglas de dominio sobre el repositorio en memoria) ----
const SUC = "t1-montejo";
const TEL = "+5219995550232";
const ctxWa = (f: F, turn?: string) => ({ organizationId: f.organizationId, channel: "whatsapp" as const, phone: TEL, ...(turn ? { flow: { key: `wa:${TEL}`, turn } } : {}) });
type Hallado = { name: string; price: number; pack_size: number | null };
const buscar = async (f: F, query: string) => (await invokeAgentTool(f.repo, ctxWa(f), "buscar_producto", { query, branch_slug: SUC })).result as Hallado[];

/** pmFixture() mas lo que piden los escenarios y el fixture compartido no tiene (sin tocar el compartido): kilos de pastor y bistec,
 * y los refrescos de cola en la categoria `Refrescos`. */
function fixtureE2e() {
  const f = pmFixture();
  const catRefrescos = randomUUID();
  f.repo.seedCategory({ id: catRefrescos, organizationId: f.organizationId, name: "Refrescos" });
  const catCarnes = randomUUID();
  f.repo.seedCategory({ id: catCarnes, organizationId: f.organizationId, name: "Carnes al kilo" });
  const nuevo = (categoryId: string, name: string, price: number, id: string = randomUUID()) => {
    f.repo.seedProduct({ id, organizationId: f.organizationId, categoryId, name, description: null, searchKeywords: [] });
    for (const propertyId of [f.t1, f.t3, f.t8]) f.repo.seedBranchProduct({ propertyId, productId: id, price, isAvailable: true });
    return id;
  };
  // La Coca-Cola del fixture vive en `Bebidas`: se vuelve a sembrar con el mismo id en `Refrescos` (como en el menu real de PM).
  f.repo.seedProduct({ id: f.p.cocaCola, organizationId: f.organizationId, categoryId: catRefrescos, name: "Coca-Cola", description: null, searchKeywords: [] });
  nuevo(catRefrescos, "Coca-Cola Light", 45);
  nuevo(catRefrescos, "Coca-Cola sin Azúcar", 45);
  const pastor500 = nuevo(catCarnes, "Pastor — 500 g", 450);
  const pastor1kg = nuevo(catCarnes, "Pastor — 1 kg", 900);
  const bistec1kg = nuevo(catCarnes, "Bistec de Res — 1 kg", 400);
  return { ...f, k: { pastor500, pastor1kg, bistec1kg } };
}
const lineas = (r: unknown) => (r as { quote: { total: number; lines: { name: string; requested_quantity: number; line_total: number }[] } }).quote;

/** Una comprobacion por cada clave `verificacion_servidor`. Las que no dicen otra cosa ejecutan el servidor real; `Mundo` solo aparece donde se indica. */
const VERIFICACIONES: Readonly<Record<string, () => Promise<void> | void>> = {
  busqueda_pizza_ofrece_quesobich: async () => {
    const f = fixtureE2e();
    const r = await buscar(f, "pizza");
    expect(r.map((p) => p.name)).toEqual(["Quesobich de Queso"]);
    // Negativo: lo que no existe sigue devolviendo lista vacia (el agente dice «no tenemos eso», nunca inventa una pizza).
    expect(await buscar(f, "sushi")).toEqual([]);
  },
  un_taco_bistec_rechazado_con_orden_de_3: async () => {
    const f = fixtureE2e();
    const cotizar = (piezas: number) =>
      invokeAgentTool(f.repo, ctxWa(f), "cotizar_pedido", { branch_slug: SUC, canal: "recoger", payment_method: "efectivo", items: [{ product_id: f.p.bistec, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: piezas, tortilla: "maiz" }] });
    // Servidor real: un taco suelto se rechaza con la regla de la orden de 3 y tres piezas cotizan UNA orden.
    await expect(cotizar(1)).rejects.toThrow(/solo se vende en órdenes de 3 piezas.*puedes pedir 3/);
    expect(lineas((await cotizar(3)).result).total).toBe(164);
    // Servidor real: el aviso reforzado sale en el mismo turno aunque el modelo no lo diga, y no sale si no se habla de bistec.
    expect(enforceBistecPackNotice("¿Para recoger o a domicilio?", [{ role: "user", content: "quiero un taco de bistec" }])).toMatch(/únicamente en órdenes de 3/);
    expect(enforceBistecPackNotice("¿Para recoger o a domicilio?", [{ role: "user", content: "quiero un taco de pastor" }])).toBe("¿Para recoger o a domicilio?");
  },
  heineken_cero_no_es_alcohol: () => {
    // Contra el MUNDO simulado (replica las reglas de alcohol y zona a domicilio) + la regla del 0.0 en el servidor real.
    const m = mundoDe("C26");
    const sinAlcohol = m.ejecutar("cotizar_pedido", { branch_slug: "t8", canal: "domicilio", colonia_entrega: "Vista Alegre", payment_method: "efectivo", items: [{ product_name: "Heineken 0.0", requested_quantity: 2 }, { product_name: "Papas a la Francesa", requested_quantity: 1 }] }) as { error?: string; quote?: { total: number } };
    expect(sinAlcohol.error).toBeUndefined();
    expect(sinAlcohol.quote?.total).toBe(273);
    const conAlcohol = m.ejecutar("cotizar_pedido", { branch_slug: "t8", canal: "domicilio", colonia_entrega: "Vista Alegre", payment_method: "efectivo", adult_confirmed: true, items: [{ product_name: "Heineken", requested_quantity: 2 }, { product_name: "Papas a la Francesa", requested_quantity: 1 }] }) as { error?: string };
    expect(conAlcohol.error).toMatch(/no se vende a domicilio/);
    // Servidor real: la regla del 0.0 vive en requiresAdultConfirmation.
    expect(requiresAdultConfirmation("Heineken 0.0", "Cervezas")).toBe(false);
    expect(requiresAdultConfirmation("Heineken", "Cervezas")).toBe(true);
  },
  kilos_por_renglon: async () => {
    const f = fixtureE2e();
    const r = await buscar(f, "kilo de pastor");
    expect(r.find((p) => p.name === "Pastor — 1 kg")?.price).toBe(900);
    // Servidor real: el kilo y el medio kilo son renglones distintos, cada uno con su propio importe (sin multiplicar por piezas).
    const q = lineas((await invokeAgentTool(f.repo, ctxWa(f), "cotizar_pedido", { branch_slug: SUC, canal: "recoger", payment_method: "efectivo", items: [{ product_id: f.k.pastor1kg, product_name: "Pastor — 1 kg", requested_quantity: 1 }, { product_id: f.k.pastor500, product_name: "Pastor — 500 g", requested_quantity: 1 }] })).result);
    expect(q.lines.map((l) => [l.name, l.line_total])).toEqual([["Pastor — 1 kg", 900], ["Pastor — 500 g", 450]]);
    expect(q.total).toBe(1350);
  },
  guacamole_vs_extra: async () => {
    const f = fixtureE2e();
    const r = await buscar(f, "guacamole");
    expect(r.map((p) => [p.name, p.price])).toEqual(expect.arrayContaining([["Guacamole", 30], ["Extra Guacamole", 25]]));
    expect(r).toHaveLength(2);
  },
  una_sola_comanda_por_pedido: async () => {
    const f = fixtureE2e();
    const items = [
      { product_id: f.p.pastor, product_name: "Taco al Pastor (individual)", requested_quantity: 2, tortilla: "maiz" },
      { product_id: f.p.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 },
    ];
    const crear = { branch_slug: SUC, customer_name: "[NOMBRE]", canal: "recoger", payment_method: "efectivo", items };
    await invokeAgentTool(f.repo, ctxWa(f, "1"), "cotizar_pedido", { branch_slug: SUC, canal: "recoger", items });
    await invokeAgentTool(f.repo, ctxWa(f, "2"), "confirmar_resumen", {});
    const creado = await invokeAgentTool(f.repo, ctxWa(f, "2"), "crear_pedido", crear);
    expect(creado.orderId).not.toBeNull();
    // Servidor real: UN pedido (una comanda) con los dos productos, y un segundo crear_pedido del mismo flujo se rechaza sin duplicarlo.
    const pagina = await f.repo.listOrders(f.organizationId, { propertyIds: [f.t1], limit: 50 });
    expect(pagina.orders).toHaveLength(1);
    expect(pagina.orders[0]!.items.map((i) => i.name).sort()).toEqual(["Coca-Cola", "Taco al Pastor (individual)"]);
    const otra = await invokeAgentTool(f.repo, ctxWa(f, "2"), "crear_pedido", crear).catch((e: unknown) => e);
    expect((otra as { code?: string }).code).toBe("pedido_ya_creado");
    expect((await f.repo.listOrders(f.organizationId, { propertyIds: [f.t1], limit: 50 })).orders).toHaveLength(1);
  },
  saludo_buenas_noches: () => {
    // Servidor real: 00:14 en America/Merida (UTC-6) = 06:14Z del mismo dia; el system prompt PM del agente lleva ese saludo.
    const ahora = new Date("2026-10-08T06:14:00Z");
    expect(saludoSegunHora("America/Merida", ahora)).toBe("Buenas noches");
    expect(saludoSegunHora("America/Merida", new Date("2026-10-08T18:00:00Z"))).toBe("Buenas tardes");
    expect(buildSystemPrompt(PM_CONFIG_POR_OMISION, [{ propertyId: "p1", slug: "t1", name: "Prolongación Montejo", address: null }], NEW_CUSTOMER, ahora)).toContain("Buenas noches");
  },
  escalacion_sin_nombre_inventado: async () => {
    // Servidor real: sin nombre dado, el aviso queda a nombre de «Cliente» (el servidor no inventa uno).
    const f = pmFixture();
    await invokeAgentTool(f.repo, { organizationId: f.organizationId, channel: "whatsapp", phone: TEL }, "escalar_a_humano", { motivo: "otro", resumen: "Pide factura y vacantes." });
    expect(f.repo.peekCallbackRequests().map((r) => r.customerName)).toEqual(["Cliente"]);
  },
  refrescos_de_cola_y_kilo_sin_tortilla: async () => {
    const f = fixtureE2e();
    expect((await buscar(f, "refresco de cola")).map((p) => p.name).sort()).toEqual(["Coca-Cola", "Coca-Cola Light", "Coca-Cola sin Azúcar"]);
    // Servidor real: ni los refrescos ni el kilo piden tortilla, y el total es la suma de los importes.
    const q = lineas((await invokeAgentTool(f.repo, ctxWa(f), "cotizar_pedido", { branch_slug: SUC, canal: "recoger", payment_method: "efectivo", items: [{ product_id: f.p.cocaCola, product_name: "Coca-Cola", requested_quantity: 3 }, { product_id: f.k.bistec1kg, product_name: "Bistec de Res — 1 kg", requested_quantity: 1 }] })).result);
    expect(q.lines.map((l) => [l.name, l.line_total])).toEqual([["Coca-Cola", 135], ["Bistec de Res — 1 kg", 400]]);
    expect(q.total).toBe(535);
    // :121 del original: «un kilo de bistec» no dispara el aviso de ordenes de 3 de los tacos.
    expect(enforceBistecPackNotice("Claro, buscaré el producto.", [{ role: "user", content: "Quiero un kilo de bistec" }])).toBe("Claro, buscaré el producto.");
    // :374 del original: el modelo no puede presentar un total inventado; sale el de la cotizacion real.
    const corregido = enforceQuotedTotal("Su total es $999.00, ¿confirma?", q.total);
    expect(corregido).toContain("$535.00");
    expect(corregido).not.toContain("999");
  },
  telefono_voz_once_digitos_rechazado: async () => {
    // Servidor real: el telefono dictado de 11 digitos no se recorta en silencio, se rechaza para que el agente pida repetirlo.
    expect(canonicalizeMexicanPhone("99955501489")).toBeNull();
    expect(canonicalizeMexicanPhone("9995550148")).toBe("9995550148");
    const f = pmFixture();
    const once = await mensajeDe(createOrder(f.repo, pedido(f, [item(f.p.pastor, 1, "maiz")], { source: "voice", customerPhone: "99955501489" })));
    expect(once).toMatch(/Teléfono inválido: confirma exactamente 10 dígitos/);
    const diez = await createOrder(f.repo, pedido(f, [item(f.p.pastor, 1, "maiz")], { source: "voice", customerPhone: "9995550148" }));
    expect(diez.customerPhone).toBe("9995550148");
  },
  orden_mixta_total_recalculado: async () => {
    // Servidor real: 8 tacos individuales + 2 ordenes de bistec (6 piezas, pack de 3) se cobran por orden y suman el total recalculado.
    const f = fixtureE2e();
    const q = lineas((await invokeAgentTool(f.repo, ctxWa(f), "cotizar_pedido", { branch_slug: SUC, canal: "recoger", payment_method: "efectivo", items: [{ product_id: f.p.pastor, product_name: "Taco al Pastor (individual)", requested_quantity: 8, tortilla: "maiz" }, { product_id: f.p.bistec, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: 6, tortilla: "maiz" }] })).result);
    expect(q.lines.map((l) => [l.name, l.line_total])).toEqual([["Taco al Pastor (individual)", 8 * 42], ["Tacos de Bistec de Res (orden de 3)", 2 * 164]]);
    expect(q.total).toBe(8 * 42 + 2 * 164);
  },
};

describe("escenarios E2E del original: comprobaciones contra el servidor", () => {
  it("todo escenario con verificacion_servidor tiene su comprobacion y no sobra ninguna", () => {
    const claves = suite.casos.flatMap((c) => (c.verificacion_servidor ? [c.verificacion_servidor] : []));
    expect(new Set(claves).size).toBe(claves.length);
    expect([...claves].sort()).toEqual(Object.keys(VERIFICACIONES).sort());
  });

  for (const c of suite.casos.filter((x) => x.verificacion_servidor)) {
    it(`${c.id}: ${c.verificacion_servidor}`, async () => {
      await VERIFICACIONES[c.verificacion_servidor!]!();
    });
  }
});
