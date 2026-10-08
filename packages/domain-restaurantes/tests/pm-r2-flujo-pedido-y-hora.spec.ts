// QA-PM-R2 (WhatsApp y voz): el pedido CIERRA aunque el modelo vuelva a cotizar en el turno del "si" (whatsapp-01, P0); una hora programada vacia
// es "sin programar" (reglas-02); la hora de recogida la valida el SERVIDOR con su reloj (reglas-05, voz-03, whatsapp-15). Reloj: solo `Date`.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { OrderFlowViolationError, resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import { OrderValidationError } from "../src/errors.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

// Martes 2026-10-06 13:00 en Merida (UTC-6).
const MARTES_13 = new Date("2026-10-06T13:00:00-06:00");

beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MARTES_13);
});
afterEach(() => vi.useRealTimers());

function setup(channel: "whatsapp" | "voz" = "whatsapp") {
  const f = buildRestaurantFixture();
  // Todos los dias 12:00 a 01:00 (como la cuenta real).
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  let turn = 1;
  const ctx = () => ({ organizationId: f.organizationId, channel, phone: "9991234567", flow: { key: `k:${channel}`, turn: String(turn), now: () => Date.now() } });
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
  const base = { branch_slug: "fco-montejo", items, canal: "recoger" };
  const quote = (extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { ...base, ...extra });
  const confirm = () => invokeAgentTool(f.repo, ctx(), "confirmar_resumen", {});
  const create = (extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), "crear_pedido", { ...base, customer_name: "Nora", payment_method: "efectivo", ...extra });
  return { f, quote, confirm, create, nextTurn: () => void (turn += 1), items };
}

describe.each(["whatsapp", "voz"] as const)("%s: re-cotizar el MISMO carrito en el turno del si ya no impide cerrar (QA-PM-R2-whatsapp-01)", (channel) => {
  it("cotiza (turno 1) -> 'no, es todo' (turno 2, re-cotiza) -> 'si' (turno 3, re-cotiza) -> confirma y crea UN pedido", async () => {
    const s = setup(channel);
    await s.quote();
    s.nextTurn();
    await s.quote(); // el modelo repite la cotizacion al responder "no, es todo"
    s.nextTurn();
    const requote = await s.quote(); // y otra vez en el turno del si
    expect((requote.result as { quote_hash: string }).quote_hash).toMatch(/^[0-9a-f]{32}$/);
    await s.confirm(); // antes: confirmacion_mismo_turno
    const created = await s.create();
    expect(created.orderId).not.toBeNull();
  });

  it("una re-cotizacion identica en un turno POSTERIOR avisa que ya se mostro y dice el siguiente paso; en el mismo turno no", async () => {
    const s = setup(channel);
    const primera = await s.quote();
    expect(primera.result).not.toHaveProperty("ya_mostrada_al_cliente");
    const mismoTurno = await s.quote();
    expect(mismoTurno.result).not.toHaveProperty("ya_mostrada_al_cliente");
    s.nextTurn();
    const siguiente = await s.quote();
    expect(siguiente.result).toMatchObject({ ya_mostrada_al_cliente: true });
    expect((siguiente.result as { siguiente_paso: string }).siguiente_paso).toContain("confirmar_resumen");
  });

  it("el relleno del modelo en los opcionales (efectivo_con 0, telefono_alterno vacio) es 'sin dato' y no impide crear el pedido", async () => {
    const s = setup(channel);
    await s.quote();
    s.nextTurn();
    await s.confirm();
    const creado = await s.create({ efectivo_con: 0, telefono_alterno: "", indicaciones_acceso: "" });
    expect(creado.orderId).not.toBeNull();
  });

  it("efectivo_con con tarjeta tambien es relleno (se ignora, no rechaza el pedido)", async () => {
    const s = setup(channel);
    await s.quote({ payment_method: "tarjeta" });
    s.nextTurn();
    await s.confirm();
    const creado = await s.create({ payment_method: "tarjeta", efectivo_con: 500 });
    expect(creado.orderId).not.toBeNull();
  });

  it("si cambia el carrito al re-cotizar, es una cotizacion NUEVA y confirmar en ese mismo turno sigue rechazado", async () => {
    const s = setup(channel);
    await s.quote();
    s.nextTurn();
    const mas = [{ product_id: s.f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 3 }];
    await s.quote({ items: mas });
    await expect(s.confirm()).rejects.toMatchObject({ code: "confirmacion_mismo_turno" });
  });

  it("si cambia el precio del catalogo entre cotizaciones, el cliente debe volver a aceptar el total nuevo", async () => {
    const s = setup(channel);
    await s.quote();
    s.nextTurn();
    const fila = (s.f.repo as unknown as { branchProducts: { productId: string; price: number }[] }).branchProducts.find((b) => b.productId === s.f.products.cocaCola)!;
    fila.price = 50;
    await s.quote();
    await expect(s.confirm()).rejects.toBeInstanceOf(OrderFlowViolationError);
  });

  it("re-cotizar despues de confirmar el mismo carrito conserva la confirmacion (idempotente)", async () => {
    const s = setup(channel);
    await s.quote();
    s.nextTurn();
    await s.confirm();
    await s.quote();
    const created = await s.create();
    expect(created.orderId).not.toBeNull();
  });
});

describe("programado_para vacio es 'sin programar' (QA-PM-R2-reglas-02)", () => {
  it("cotizar y crear con programado_para '' y hora_recogida '' crean un pedido normal", async () => {
    const s = setup();
    const quoted = await s.quote({ programado_para: "", hora_recogida: "" });
    expect((quoted.raw as { programadoPara?: string }).programadoPara).toBeUndefined();
    s.nextTurn();
    await s.confirm();
    const created = await s.create({ programado_para: "", hora_recogida: "" });
    expect((created.raw as { status: string }).status).toBe("pending");
  });

  it("un programado a menos de 30 min dice que use hora_recogida (el modelo ya no se queda en bucle)", async () => {
    const s = setup();
    const en20 = new Date(MARTES_13.getTime() + 20 * 60_000).toISOString();
    await expect(s.quote({ programado_para: en20 })).rejects.toThrow(/hora_recogida/);
  });
});

describe("hora_recogida la valida el servidor con su reloj (QA-PM-R2-reglas-05 / voz-03 / whatsapp-15)", () => {
  it("'paso en 40 minutos' calculado con la hora LOCAL se acepta y se guarda", async () => {
    const s = setup();
    const hora = "2026-10-06T13:40:00-06:00";
    await s.quote({ hora_recogida: hora });
    s.nextTurn();
    await s.confirm();
    const created = await s.create({ hora_recogida: hora });
    expect((created.raw as { horaRecogida?: string }).horaRecogida).toBe(hora);
  });

  it("la hora UTC con -06:00 (6 h tarde: 19:40) cae el mismo dia y abierto: se acepta pero una pasada se rechaza con la hora local actual", async () => {
    const s = setup();
    await expect(s.quote({ hora_recogida: "2026-10-04T20:00:00-06:00" })).rejects.toThrow(/ya pasó.*13:00/s);
  });

  it("una hora pasada (dos dias atras, VRG07) se rechaza al crear aunque se salte la cotizacion de la hora", async () => {
    const s = setup();
    await s.quote();
    s.nextTurn();
    await s.confirm();
    await expect(s.create({ hora_recogida: "2026-10-04T20:00:00-06:00" })).rejects.toBeInstanceOf(OrderValidationError);
  });

  it("2030 y otro dia se rechazan", async () => {
    const s = setup();
    await expect(s.quote({ hora_recogida: "2030-01-01T14:00:00-06:00" })).rejects.toThrow(/12 horas/);
    await expect(s.quote({ hora_recogida: "2026-10-07T14:00:00-06:00" })).rejects.toThrow(/programado_para/);
  });

  it("despues del cierre se rechaza y avisa a que hora cierra (00:57, 'paso en 20 min')", async () => {
    vi.setSystemTime(new Date("2026-10-07T00:57:00-06:00"));
    const s = setup();
    await expect(s.quote({ hora_recogida: "2026-10-07T01:17:00-06:00" })).rejects.toThrow(/cierra a las 01:00/);
  });

  it("hora_recogida y programado_para distintos en el mismo pedido se rechazan (la comanda decia 14:00 y 20:00)", async () => {
    const s = setup();
    const prog = "2026-10-06T20:00:00-06:00";
    await s.quote({ programado_para: prog });
    s.nextTurn();
    await s.confirm();
    await expect(s.create({ programado_para: prog, hora_recogida: "2026-10-06T14:00:00-06:00" })).rejects.toThrow(/distintas/);
    // la misma hora en ambos campos si es coherente
    const ok = await s.create({ programado_para: prog, hora_recogida: prog });
    expect((ok.raw as { status: string }).status).toBe("programado");
  });

  it("hora_recogida en un pedido a domicilio se rechaza (solo aplica a recoger)", async () => {
    const s = setup();
    await expect(s.quote({ canal: "domicilio", hora_recogida: "2026-10-06T14:00:00-06:00" })).rejects.toThrow(/solo aplica a pedidos para recoger/);
  });
});

describe("pedido grande partido en dos pedidos (QA-PM-R2-reglas-08)", () => {
  it("el segundo pedido de la misma conversacion suma al primero y escala pedido_grande en vez de ir a cocina", async () => {
    const f = buildRestaurantFixture();
    await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, { perfil: "taqueria_pm", agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo", deliveryTimeText: "de 40 a 50 minutos" });
    const kilos = randomUUID();
    f.repo.seedCategory({ id: kilos, organizationId: f.organizationId, name: "Kilos a Domicilio" });
    const arrachera = randomUUID();
    const bistec = randomUUID();
    for (const [id, name, price] of [[arrachera, "Arrachera — 2 kg", 2800], [bistec, "Bistec de Res — 2 kg", 2200]] as const) {
      f.repo.seedProduct({ id, organizationId: f.organizationId, categoryId: kilos, name, description: null, searchKeywords: [] });
      f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: id, price, isAvailable: true });
    }
    // Cliente con historial para que no entre por la regla de "sin historial en efectivo".
    await f.repo.upsertCustomer(f.organizationId, "9991234567", "Nora");
    let turn = 1;
    const ctx = () => ({ organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567", flow: { key: "k:grande", turn: String(turn), now: () => Date.now() } });
    const base = { branch_slug: "fco-montejo", canal: "recoger" };
    const pedir = async (id: string, name: string) => {
      const items = [{ product_id: id, product_name: name, requested_quantity: 1 }];
      await invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { ...base, items });
      turn += 1;
      await invokeAgentTool(f.repo, ctx(), "confirmar_resumen", {});
      return invokeAgentTool(f.repo, ctx(), "crear_pedido", { ...base, items, customer_name: "Nora", payment_method: "tarjeta" });
    };
    const primero = await pedir(arrachera, "Arrachera — 2 kg"); // $2,800: no es grande por si solo
    expect(primero.orderId).not.toBeNull();
    turn += 1;
    const segundo = await pedir(bistec, "Bistec de Res — 2 kg"); // $2,200: la sesion suma $5,000 > $4,000
    expect(segundo.orderId).toBeNull();
    expect(segundo.result).toMatchObject({ pedido_grande: true, escalado: true });
    const avisos = f.repo.listCallbackRequests(f.organizationId);
    expect(avisos.some((a) => a.reason === "escalada:pedido_grande" && /Total \$5000\.00/.test(a.message ?? ""))).toBe(true);
  });
});

describe("doble salsa (QA-PM-R2-reglas-13 / 14)", () => {
  it("una doble salsa fuera del catalogo se rechaza al COTIZAR (antes cotizaba $145 y crear la rechazaba)", async () => {
    const s = setup();
    await expect(s.quote({ doble_salsas: ["roja"] })).rejects.toThrow(/solo aplica a las salsas incluidas/);
  });

  it("un pedido de solo bebidas (Coca-Cola) con doble salsa se rechaza: no hay salsa incluida que duplicar", async () => {
    const f = buildRestaurantFixture();
    const extra = randomUUID();
    f.repo.seedProduct({ id: extra, organizationId: f.organizationId, categoryId: f.categories.tacos, name: "Extra Salsa", description: null, searchKeywords: [] });
    f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: extra, price: 19, isAvailable: true });
    const ctx = { organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567" };
    const bebidas = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
    await expect(invokeAgentTool(f.repo, ctx, "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: bebidas, doble_salsas: ["salsa_roja"] })).rejects.toThrow(/solo de bebidas/);
    // con un platillo si aplica
    const ok = await invokeAgentTool(f.repo, ctx, "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: [{ product_id: f.products.tacosPastor, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: 3, tortilla: "maiz" }], doble_salsas: ["salsa_roja"] });
    expect((ok.raw as { total: number }).total).toBe(164 + 19);
  });
});

describe("carrito del catalogo de WhatsApp (QA-PM-R2-whatsapp-11)", () => {
  it("un mensaje type=order ya no se ignora en silencio: entra como nota honesta para que el agente pida que lo escriba", async () => {
    const { extractMetaInboundMessages } = await import("../src/whatsapp/channel-config.ts");
    const payload = { entry: [{ changes: [{ value: { messages: [{ id: "wamid.1", from: "5219990001111", type: "order", order: { catalog_id: "c1", text: "para recoger", product_items: [{ product_retailer_id: "taco-pastor", quantity: 4 }, { product_retailer_id: "coca-cola", quantity: 1 }] } }] } }] }] };
    const [m] = extractMetaInboundMessages(payload);
    expect(m?.body).toMatch(/carrito del catálogo de WhatsApp \(5 piezas\)/);
    expect(m?.body).toMatch(/no invente productos ni precios/);
    expect(m?.body).toContain("para recoger");
  });
});

describe("zonas conocidas con aclaracion entre parentesis (QA-PM-R2-voz-07 / reglas-09)", () => {
  it("la direccion completa que escribe el modelo en `colonia` reconoce 'García Lavín (Victory Platz)'", async () => {
    const { matchKnownZone } = await import("../src/reglas-pedido.ts");
    const zonas = [
      { id: "z1", organizationId: "o", name: "García Lavín (Victory Platz)", lat: 21.0205, lng: -89.615 },
      { id: "z2", organizationId: "o", name: "Victory Altabrisa", lat: 21.0156, lng: -89.5982 },
    ] as never;
    expect(matchKnownZone(zonas, "Calle 32 #345 x 20 y 22, casa 13, fachada verde, García Lavín")?.id).toBe("z1");
    expect(matchKnownZone(zonas, "Garcia Lavin")?.id).toBe("z1");
    expect(matchKnownZone(zonas, "García Lavín (Victory Platz)")?.id).toBe("z1");
    expect(matchKnownZone(zonas, "Altabrisa")?.id).toBe("z2");
    expect(matchKnownZone(zonas, "Progreso")).toBeNull();
  });
});

describe("segundo pedido identico en la misma sesion (QA-PM-R2-reglas-15)", () => {
  it("devuelve el pedido ya registrado marcado ya_registrado en vez de presentarlo como nuevo", async () => {
    const s = setup();
    await s.quote();
    s.nextTurn();
    await s.confirm();
    const primero = await s.create();
    expect((primero.result as { ya_registrado?: boolean }).ya_registrado).toBeUndefined();
    // "otro igualito aparte para mi mama": se detecta por el id del ultimo pedido de la sesion, sin depender de relojes
    s.nextTurn();
    await s.quote({ otro_pedido: true }); // R3: sin `otro_pedido` un cotizar del mismo carrito ya NO reabre el flujo (ver order-flow-r3.spec.ts)
    s.nextTurn();
    await s.confirm();
    const segundo = await s.create();
    expect(segundo.orderId).toBe(primero.orderId);
    expect(segundo.result).toMatchObject({ ya_registrado: true });
  });
});

describe("el historial de esta misma sesion no apaga la regla de efectivo sin historial (R90)", () => {
  it("numero nuevo: un pedido de $126 y enseguida uno de $2,800 en efectivo se retiene (los $2,500 sin historial)", async () => {
    const f = buildRestaurantFixture();
    await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, { perfil: "taqueria_pm", agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo", deliveryTimeText: "de 40 a 50 minutos" });
    const kilos = randomUUID();
    f.repo.seedCategory({ id: kilos, organizationId: f.organizationId, name: "Kilos a Domicilio" });
    const arrachera = randomUUID();
    f.repo.seedProduct({ id: arrachera, organizationId: f.organizationId, categoryId: kilos, name: "Arrachera — 2 kg", description: null, searchKeywords: [] });
    f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: arrachera, price: 2800, isAvailable: true });
    let turn = 1;
    const ctx = () => ({ organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9995550199", flow: { key: "k:r90", turn: String(turn), now: () => Date.now() } });
    const base = { branch_slug: "fco-montejo", canal: "recoger" };
    const pedir = async (items: unknown[], pago: "efectivo" | "tarjeta") => {
      await invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { ...base, items });
      turn += 1;
      await invokeAgentTool(f.repo, ctx(), "confirmar_resumen", {});
      return invokeAgentTool(f.repo, ctx(), "crear_pedido", { ...base, items, customer_name: "Nora", payment_method: pago });
    };
    const chico = await pedir([{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }], "efectivo");
    expect(chico.orderId).not.toBeNull();
    turn += 1;
    const grande = await pedir([{ product_id: arrachera, product_name: "Arrachera — 2 kg", requested_quantity: 1 }], "efectivo");
    expect(grande.orderId).toBeNull();
    expect(grande.result).toMatchObject({ pedido_grande: true });
  });
});
