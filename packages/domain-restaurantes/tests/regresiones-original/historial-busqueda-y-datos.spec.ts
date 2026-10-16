// Regresiones del HISTORIAL DE GIT del original (atiende-restaurantes @ 13fb3bd), lote 1: saludo, busqueda,
// telefono, direccion, sucursal y notas a cocina. Una prueba por bug, con el commit y el caso X en el titulo
// (ver README.md de esta carpeta). Aqui NO se arregla nada: si una regresion falla en main se marca it.fails.
import { describe, expect, it } from "vitest";
import { mensajeSaludoRespaldo, saludoPorHora } from "@atiende/voice-core";
import { OrderValidationError } from "../../src/errors.ts";
import { createOrder, quoteOrder, searchProducts } from "../../src/orders.ts";
import { invokeAgentTool } from "../../src/agent-tools/registry.ts";
import { normalizePhone } from "../../src/phone.ts";
import { tokenizeForProductSearch } from "../../src/product-search.ts";
import { PM_CONFIG_POR_OMISION, buildSystemPrompt, saludoSegunHora } from "../../src/whatsapp/llm-turn-handler.ts";
import { construirPayloadComanda } from "../../src/softrestaurant/outbox-service.ts";
import { MapaProductoCodigo } from "../../src/softrestaurant/catalog-map.ts";
import { item, mensajeDe, pedido, pmFixture } from "./fixture.ts";
import type { F } from "./fixture.ts";

const nombres = async (f: F, query: string) => (await searchProducts(f.repo, { propertyId: f.t1, query })).map((r) => r.name);

describe("6d07364 -- saludo por hora de Merida y 'Alta Brisa'", () => {
  // America/Merida es UTC-6 todo el año (sin horario de verano desde 2022).
  const casos: ReadonlyArray<readonly [string, string, string]> = [
    ["09:00", "2026-03-10T15:00:00Z", "Buenos días"],
    ["13:00", "2026-03-10T19:00:00Z", "Buenas tardes"],
    ["21:00", "2026-03-11T03:00:00Z", "Buenas noches"],
    ["00:30", "2026-03-11T06:30:00Z", "Buenas noches"],
  ];
  for (const [hora, instante, esperado] of casos) {
    it(`X40 / 6d07364: WhatsApp a las ${hora} en America/Merida saluda '${esperado}', nunca un saludo fijo`, () => {
      expect(saludoSegunHora("America/Merida", new Date(instante))).toBe(esperado);
    });
    it(`X40 / 6d07364: el pregrabado de voz a las ${hora} usa el saludo '${esperado.toLowerCase()}'`, () => {
      const horaLocal = Number(new Intl.DateTimeFormat("es-MX", { timeZone: "America/Merida", hour: "numeric", hourCycle: "h23" }).format(new Date(instante)));
      expect(saludoPorHora(horaLocal)).toBe(esperado.toLowerCase());
      expect(saludoPorHora(`${hora}`)).toBe(esperado.toLowerCase());
      const id = mensajeSaludoRespaldo(hora);
      expect(id).toBe(esperado === "Buenos días" ? "saludo_respaldo_dias" : esperado === "Buenas tardes" ? "saludo_respaldo_tardes" : "saludo_respaldo_noches");
    });
  }

  it("X40 / 6d07364: un valor que no es hora lanza en vez de dar un saludo equivocado", () => {
    expect(() => saludoPorHora("sin hora")).toThrow(RangeError);
    expect(() => saludoPorHora(24)).toThrow(RangeError);
  });

  it("X41 / 6d07364: tres variantes de Altabrisa ('Alta Brisa', 'Casa Altabrisa', 'Plaza Alta Brisa') asignan T8 (ver T-ZS01)", async () => {
    const f = pmFixture();
    f.repo.seedKnownZone({ organizationId: f.organizationId, name: "altabrisa", lat: 21.0213, lng: -89.5578 });
    for (const colonia of ["Alta Brisa", "Casa Altabrisa", "Plaza Alta Brisa", "altabrisa"]) {
      const out = await invokeAgentTool(f.repo, { organizationId: f.organizationId, channel: "whatsapp", phone: "+5219990000000" }, "buscar_sucursal_cercana", { colonia });
      expect(out.result, colonia).toMatchObject({ encontrada: true, branch_slug: "t8-altabrisa" });
    }
  });
});

describe("cec17f1 -- 'una pizza', lista vacia y aviso de bistec en el mismo turno", () => {
  it("X10 / cec17f1: 'una pizza' encuentra Quesobich (antes respondia 'no disponible')", async () => {
    expect(await nombres(pmFixture(), "una pizza")).toEqual(["Quesobich de Queso"]);
  });

  it("X10 / cec17f1: un producto que no existe devuelve lista vacia y la regla del prompt dice 'no tenemos eso', nunca 'no disponible en esta sucursal'", async () => {
    const f = pmFixture();
    const out = await invokeAgentTool(f.repo, { organizationId: f.organizationId, channel: "whatsapp", phone: "+5219990000000" }, "buscar_producto", { query: "sushi", branch_slug: "t1-montejo" });
    expect(out.result).toEqual([]);
  });
});

describe("ff76358 -- 'cerveza Sol' y 'coctel Margarita'", () => {
  it("X11 / ff76358: 'cerveza Sol' encuentra Sol y 'coctel Margarita' encuentra Margarita", async () => {
    const f = pmFixture();
    expect(await nombres(f, "cerveza Sol")).toEqual(["Sol"]);
    expect(await nombres(f, "coctel Margarita")).toEqual(["Margarita"]);
  });

  it("X11 / ff76358: ambos se cotizan para recoger (el alcohol solo se rechaza a domicilio)", async () => {
    const f = pmFixture();
    const q = await quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "t1-montejo", canal: "recoger", adultConfirmed: true, items: [item(f.p.sol, 1), item(f.p.margarita, 1)] });
    expect(q.total).toBe(156);
  });
});

describe("de885b1 -- tacos al pastor, plurales y pesos", () => {
  it("X12 / de885b1: 'tacos al pastor' y '500g' encuentran producto", async () => {
    const f = pmFixture();
    expect(await nombres(f, "tacos al pastor")).toEqual(["Taco al Pastor (individual)"]);
    expect(await nombres(f, "500g de arrachera")).toEqual(["Arrachera 500 g"]);
  });

  it("X12 / de885b1: '1kg', '1 kg' y '1.5 kg' resuelven al peso correcto", async () => {
    const f = pmFixture();
    expect(await nombres(f, "1kg de arrachera")).toEqual(["Arrachera 1 kg"]);
    expect(await nombres(f, "1 kg de arrachera")).toEqual(["Arrachera 1 kg"]);
    expect(await nombres(f, "1.5 kg de arrachera")).toEqual(["Arrachera 1.5 kg"]);
  });
});

describe("3571c1c -- busqueda tokenizada", () => {
  it("X10 / X14 / 3571c1c: las palabras de cantidad y relleno no son tokens y los plurales se singularizan", () => {
    expect(tokenizeForProductSearch("quiero dos cervezas Sol")).toEqual(["sol"]);
    expect(tokenizeForProductSearch("tacos al pastor")).toContain("taco");
    expect(tokenizeForProductSearch("tres tacos")).not.toContain("tres");
  });

  it("X39 / 3571c1c: no hay prompt de respaldo duplicado en BD (N/A); el unico prompt conserva las reglas duras (ver T-PC04..T-PC06)", () => {
    const prompt = buildSystemPrompt(PM_CONFIG_POR_OMISION, [{ propertyId: "p1", slug: "t1", name: "Prolongación Montejo", address: null }], { isNew: true }, new Date("2026-10-06T20:00:00Z"));
    expect(prompt).toMatch(/alcohol/i);
    expect(prompt).toMatch(/escal/i);
  });
});

describe("da4ce92 -- telefono vacio colapsaba clientes", () => {
  it("X17 / da4ce92: 'widget-abc' y 'widget-xyz' son dos clientes distintos", async () => {
    const f = pmFixture();
    expect(normalizePhone("widget-abc")).not.toBe(normalizePhone("widget-xyz"));
    await createOrder(f.repo, pedido(f, [item(f.p.cocaCola, 1)], { customerPhone: "widget-abc", source: "web" }));
    await createOrder(f.repo, pedido(f, [item(f.p.cocaCola, 1)], { customerPhone: "widget-xyz", source: "web" }));
    const a = await f.repo.findCustomerByPhone(f.organizationId, normalizePhone("widget-abc"));
    const b = await f.repo.findCustomerByPhone(f.organizationId, normalizePhone("widget-xyz"));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).not.toBe(b!.id);
    expect(a!.orderCount).toBe(1);
  });
});

describe("03555e2 -- telefono sin normalizar y branch_slug faltante", () => {
  it("X16 / 03555e2: '5219991234567' y '999 123 4567' son el mismo cliente (ver T-ME05)", async () => {
    const f = pmFixture();
    await createOrder(f.repo, pedido(f, [item(f.p.cocaCola, 1)], { customerPhone: "5219991234567" }));
    await createOrder(f.repo, pedido(f, [item(f.p.cocaCola, 2)], { customerPhone: "999 123 4567" }));
    expect((await f.repo.findCustomerByPhone(f.organizationId, "9991234567"))?.orderCount).toBe(2);
  });

  for (const slug of [undefined, "", "no-existe"] as const) {
    it(`X44 / 03555e2: branch_slug ${slug === undefined ? "ausente" : JSON.stringify(slug)} falla explicito en buscar_producto, cotizar_pedido y crear_pedido (nunca cae a una sucursal)`, async () => {
      const f = pmFixture();
      const ctx = { organizationId: f.organizationId, channel: "whatsapp" as const, phone: "+5219990000000" };
      const rama = slug === undefined ? {} : { branch_slug: slug };
      const items = [{ product_id: f.p.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }];
      const buscar = await invokeAgentTool(f.repo, ctx, "buscar_producto", { query: "coca", ...rama }).catch((e: unknown) => e);
      const cotizar = await invokeAgentTool(f.repo, ctx, "cotizar_pedido", { items, canal: "recoger", ...rama }).catch((e: unknown) => e);
      const crear = await invokeAgentTool(f.repo, ctx, "crear_pedido", { customer_name: "Marcela", items, payment_method: "efectivo", canal: "recoger", ...rama }).catch((e: unknown) => e);
      for (const r of [buscar, cotizar, crear]) expect(r).toBeInstanceOf(OrderValidationError);
      expect(await f.repo.findCustomerByPhone(f.organizationId, "9990000000")).toBeNull();
    });
  }
});

describe("0c0bebf -- direccion obligatoria, '(1/2 orden)' y tiempo antes de crear", () => {
  it("X46 / 0c0bebf: pedido a domicilio sin direccion se rechaza antes de crear nada", async () => {
    const f = pmFixture();
    const msg = await mensajeDe(createOrder(f.repo, pedido(f, [item(f.p.pastor, 6, "maiz"), item(f.p.cocaCola, 2)], { customerAddress: undefined, canal: "domicilio" })));
    expect(msg).toMatch(/direcci[óo]n/i);
    expect(await f.repo.findCustomerByPhone(f.organizationId, "9991234567")).toBeNull();
  });

  it("X56 / 0c0bebf: 'media orden de frijoles charros' encuentra el producto (1/2 orden)", async () => {
    expect(await nombres(pmFixture(), "media orden de frijoles charros")).toEqual(["Frijoles Charros (1/2 orden)"]);
  });
});

describe("72fd6ad -- 'sin cebolla' a cocina y Guacamole vs Extra Guacamole", () => {
  it("X25 / 72fd6ad: la nota 'sin cebolla' llega a la comanda y al ticket de cocina", async () => {
    const f = pmFixture();
    const order = await createOrder(f.repo, pedido(f, [item(f.p.pastor, 3, "maiz")], { notes: "Sin cebolla en todos" }));
    expect(order.notes).toContain("Sin cebolla en todos");
    const payload = construirPayloadComanda(
      { order },
      { resolverCodigos: new MapaProductoCodigo([]), resolverSucursal: () => "T1" },
    );
    expect(payload.notas).toContain("Sin cebolla en todos");
  });

  it("X26 / 72fd6ad: buscar 'guacamole' devuelve Guacamole y Extra Guacamole con su precio (ver T-AM06)", async () => {
    const f = pmFixture();
    const res = await searchProducts(f.repo, { propertyId: f.t1, query: "guacamole" });
    expect(res.map((r) => [r.name, r.price]).sort()).toEqual([["Extra Guacamole", 25], ["Guacamole", 30]]);
  });
});
