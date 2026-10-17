// R11 romper -- categoria 5: reglas de negocio. Pedidos enormes, cantidades negativas / cero / decimales, horarios limite (cierre 01:00, medianoche,
// cambio de dia), sucursal fuera de zona, alcohol / menores, alergias, privacidad (no filtrar telefonos ni pedidos de otros clientes), cobro
// incorrecto y propina. Herramientas y repositorio reales (en memoria); el modelo no interviene (se llaman las herramientas directamente).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { estaAbiertoAhora, diaDeNegocio } from "../../src/horarios.ts";
import { classifyHighRiskIntent } from "../../src/whatsapp/guards.ts";
import { buildSystemPrompt, PM_CONFIG_POR_OMISION } from "../../src/whatsapp/llm-turn-handler.ts";
import { lookupCustomerConPedidoReciente } from "../../src/customers.ts";
import { PHONE, buildRestaurantFixture, flujo, hallazgo, itemsCoca, ordenes, pedidoCompleto } from "./arnes.ts";
import type { Fixture } from "./arnes.ts";

// Martes 2026-10-06 13:00 en Merida (UTC-6): reloj fijo para que las horas relativas sean deterministas.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T13:00:00-06:00"));
});
afterEach(() => vi.useRealTimers());

async function conPerfilPm(f: Fixture) {
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, { perfil: "taqueria_pm", agentName: null, businessName: "Los Taquitos de PM", toneStyle: null, deliveryTimeText: null, escalationReasonsOff: [] });
}

describe("R11-5A cantidades: negativas, cero, decimales, no numericas y enormes", () => {
  const invalidas: ReadonlyArray<readonly [string, unknown]> = [
    ["negativa", -1],
    ["cero", 0],
    ["decimal 0.5", 0.5],
    ["decimal 1.5", 1.5],
    ["decimal casi entero", 2.0000001],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["texto 'dos'", "dos"],
    ["texto vacio", ""],
    ["null", null],
    ["objeto", { a: 1 }],
    ["gigante 1e9", 1e9],
    ["gigante 1e21", 1e21],
    ["501 piezas (tope 500 por renglon)", 501],
  ];
  it.each(invalidas)("cotizar con cantidad %s: error accionable y cero pedidos", async (_n, cantidad) => {
    const f = buildRestaurantFixture();
    const s = flujo(f);
    const out = await s.seguro("cotizar_pedido", s.base(cantidad));
    expect(JSON.stringify(out.result)).toMatch(/"error"/);
    expect(out.orderId).toBeNull();
    expect(await ordenes(f)).toHaveLength(0);
  });

  it("un renglon SIN la clave de cantidad se rechaza (no se asume 1)", async () => {
    const f = buildRestaurantFixture();
    const s = flujo(f);
    const out = await s.seguro("cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola" }] });
    expect(JSON.stringify(out.result)).toMatch(/"error"/);
    expect(await ordenes(f)).toHaveLength(0);
  });

  it("crear_pedido con cantidad invalida tras una cotizacion valida tambien se rechaza (la cantidad no se puede cambiar en silencio al crear)", async () => {
    for (const cantidad of [-2, 0, 1.5, "dos", 1e9]) {
      const f = buildRestaurantFixture();
      const s = flujo(f);
      await s.quote(2);
      s.next();
      await s.confirm();
      const out = await s.seguro("crear_pedido", { ...s.base(cantidad), customer_name: "Ana", payment_method: "efectivo" });
      expect(out.orderId, String(cantidad)).toBeNull();
      expect(await ordenes(f)).toHaveLength(0);
    }
  });

  // ── HALLAZGO R11-11 (P2, integridad de la cantidad): coercion laxa de valores que no son numeros ──
  // `toRequestedItems` hace `Number(valor)`: `true` -> 1, `[2]` -> 2 y la cadena hexadecimal "0x10" -> 16. La cantidad SI se muestra en
  // el resumen y el cliente la confirma, asi que el dano es acotado (P2), pero un renglon que el modelo mando mal-tipado no deberia
  // convertirse en una cantidad distinta en silencio.
  const coercionadas: ReadonlyArray<readonly [string, unknown]> = [
    ["booleano true (-> 1)", true],
    ["arreglo [2] (-> 2)", [2]],
    ["hexadecimal '0x10' (-> 16)", "0x10"],
  ];
  for (const [nombre, valor] of coercionadas) {
    it(`R11-11 [P2] cantidad ${nombre} se rechaza en vez de coercionarse`, async () => {
      const f = buildRestaurantFixture();
      const s = flujo(f);
      const control = await s.seguro("cotizar_pedido", s.base("2"));
      expect(JSON.stringify(control.result)).toContain('"requested_quantity":2'); // control: "2" (texto numerico) SI se acepta
      const out = await s.seguro("cotizar_pedido", s.base(valor));
      expect(JSON.stringify(out.result)).toMatch(/"error"/);
    });
  }
});

describe("R11-5B pedidos enormes", () => {
  async function creaGrande(f: Fixture) {
    const s = flujo(f);
    await s.seguro("cotizar_pedido", s.base(400));
    s.next();
    await s.seguro("confirmar_resumen", {});
    const out = await s.seguro("crear_pedido", { ...s.base(400), customer_name: "Ana", payment_method: "efectivo" });
    const enCocina = (await ordenes(f)).filter((o) => !["por_aprobar", "por_confirmar"].includes(String(o.status)));
    return { out, enCocina };
  }

  it("[taqueria_pm] 400 Coca-Cola ($18 000) no entra a cocina: queda retenido para la sucursal y el cliente lo sabe", async () => {
    const f = buildRestaurantFixture();
    await conPerfilPm(f);
    const { out, enCocina } = await creaGrande(f);
    expect(JSON.stringify(out.result)).toMatch(/pedido_grande/);
    expect(enCocina).toHaveLength(0);
  });

  // ── OBSERVACION R11-14 (P2, solo organizaciones SIN perfil taqueria_pm): el tope de pedido grande es por perfil ──
  // Decision documentada en pedido-grande.ts ("Alcance: solo organizaciones con perfil taqueria_pm"). Para PM no es un defecto; queda como
  // prueba abierta porque una organizacion que pierda su fila de configuracion (o el perfil) deja pasar $18 000 directo a cocina sin aviso.
  hallazgo("R11-14 [P2, obs.] [perfil generico] 400 Coca-Cola ($18 000) tambien se retiene para la sucursal", async () => {
    const f = buildRestaurantFixture();
    const { out, enCocina } = await creaGrande(f);
    expect(JSON.stringify(out.result)).toContain("order"); // control: hoy se crea
    expect(JSON.stringify(out.result)).toMatch(/pedido_grande/);
    expect(enCocina).toHaveLength(0);
  });

  it("repetir el renglon 50 veces con 500 piezas (25 000 piezas, ~$1.1 M) para esquivar el tope por renglon tampoco se crea directo", async () => {
    const f = buildRestaurantFixture();
    await conPerfilPm(f);
    const s = flujo(f);
    const items = Array.from({ length: 50 }, () => itemsCoca(f, 500)[0]);
    const base = { branch_slug: "fco-montejo", canal: "recoger", items };
    await s.seguro("cotizar_pedido", base);
    s.next();
    await s.seguro("confirmar_resumen", {});
    const out = await s.seguro("crear_pedido", { ...base, customer_name: "Ana", payment_method: "efectivo" });
    expect(JSON.stringify(out.result)).toMatch(/pedido_grande|error/);
    expect((await ordenes(f)).filter((o) => !["por_aprobar", "por_confirmar"].includes(String(o.status)))).toHaveLength(0);
  });

  it("5 000 renglones se rechazan (tope de renglones) sin colgar el proceso", async () => {
    const f = buildRestaurantFixture();
    const s = flujo(f);
    const t0 = Date.now();
    const out = await s.seguro("cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: Array.from({ length: 5000 }, () => itemsCoca(f, 1)[0]) });
    expect(JSON.stringify(out.result)).toMatch(/"error"/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("R11-5C aritmetica del total", () => {
  it.each([[19.99, 3, 59.97], [0.1, 3, 0.3], [33.33, 7, 233.31], [0.07, 100, 7]])("precio %s x %s = %s sin ruido de coma flotante", async (precio, cantidad, esperado) => {
    const f = buildRestaurantFixture();
    const id = randomUUID();
    f.repo.seedProduct({ id, organizationId: f.organizationId, categoryId: f.categories.bebidas, name: "Agua de prueba", description: null, searchKeywords: [] });
    f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: id, price: precio, isAvailable: true });
    const s = flujo(f);
    const items = [{ product_id: id, product_name: "Agua de prueba", requested_quantity: cantidad }];
    const out = await s.seguro("cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items });
    const total = (out.result as { quote?: { total?: number } }).quote?.total;
    expect(total).toBe(esperado);
    s.next();
    await s.seguro("confirmar_resumen", {});
    await s.seguro("crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", items, customer_name: "Ana", payment_method: "efectivo" });
    const [orden] = await ordenes(f);
    expect(orden!.total).toBe(esperado);
    expect(Number.isInteger(Math.round(orden!.total * 100))).toBe(true);
  });
});

describe("R11-5D horarios limite: cierre 01:00, medianoche y cambio de dia (turno 12:00-01:00, America/Merida)", () => {
  const horario = [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }];
  const merida = (iso: string) => new Date(`${iso}-06:00`);
  const casos: ReadonlyArray<readonly [string, string, boolean]> = [
    ["11:59:59 abierto? no", "2026-10-06T11:59:59.999", false],
    ["12:00:00 abre", "2026-10-06T12:00:00.000", true],
    ["23:59:59.999", "2026-10-06T23:59:59.999", true],
    ["00:00:00 medianoche (turno de ayer)", "2026-10-07T00:00:00.000", true],
    ["00:59:59.999 ultimo instante abierto", "2026-10-07T00:59:59.999", true],
    ["01:00:00.000 cierra", "2026-10-07T01:00:00.000", false],
    ["01:01", "2026-10-07T01:01:00.000", false],
    ["06:00 madrugada", "2026-10-07T06:00:00.000", false],
  ];
  it.each(casos)("%s", (_n, iso, abierto) => {
    expect(estaAbiertoAhora(horario, merida(iso), "America/Merida").abierto).toBe(abierto);
  });

  it("el mismo instante se evalua en la zona de la SUCURSAL, no en UTC del servidor: 07:00 UTC es 01:00 en Merida (cerrado) y 00:00 en CDMX-sin-DST-distinta", () => {
    const instante = new Date("2026-10-07T07:00:00Z");
    expect(estaAbiertoAhora(horario, instante, "America/Merida").abierto).toBe(false);
    expect(estaAbiertoAhora(horario, new Date("2026-10-07T06:59:59.999Z"), "America/Merida").abierto).toBe(true);
  });

  it("el turno del domingo que cruza la medianoche sigue abierto el lunes a las 00:30 aunque el lunes no abra", () => {
    const solo = [{ dias: [0], abre: "12:00", cierra: "01:00" }];
    expect(estaAbiertoAhora(solo, merida("2026-10-12T00:30:00.000"), "America/Merida").abierto).toBe(true); // lunes 00:30, turno del domingo
    expect(estaAbiertoAhora(solo, merida("2026-10-12T13:00:00.000"), "America/Merida").abierto).toBe(false); // lunes 13:00: no abre
    expect(estaAbiertoAhora(solo, merida("2026-10-13T00:30:00.000"), "America/Merida").abierto).toBe(false); // martes 00:30: el lunes no abrio
  });

  it("el dia de negocio no cambia a medianoche sino al corte (01:00): 00:59 pertenece al dia anterior", () => {
    expect(diaDeNegocio(merida("2026-10-07T00:59:59.999"), "America/Merida", horario)).toBe("2026-10-06");
    expect(diaDeNegocio(merida("2026-10-07T01:00:00.000"), "America/Merida", horario)).toBe("2026-10-07");
    expect(diaDeNegocio(merida("2026-10-06T23:59:00.000"), "America/Merida", horario)).toBe("2026-10-06");
  });

  it("(servidor) cotizar un pedido PROGRAMADO para 00:59 de manana pasa; para las 01:00, 01:01 y 11:59 se rechaza; para las 12:00 pasa", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { horario });
    await f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
    const s = flujo(f);
    const programa = async (iso: string) => {
      const out = await s.seguro("cotizar_pedido", s.base(2, { programado_para: iso }));
      return JSON.stringify(out.result);
    };
    expect(await programa("2026-10-07T00:59:00-06:00")).not.toMatch(/"error"/);
    for (const iso of ["2026-10-07T01:00:00-06:00", "2026-10-07T01:01:00-06:00", "2026-10-07T11:59:00-06:00"]) expect(await programa(iso), iso).toMatch(/"error"/);
    expect(await programa("2026-10-07T12:00:00-06:00")).not.toMatch(/"error"/);
  });

  const programadasInvalidas: ReadonlyArray<readonly [string, string]> = [
    ["en el pasado", "2026-10-06T10:00:00-06:00"],
    ["en 29 minutos", "2026-10-06T13:29:00-06:00"],
    ["dentro de 8 dias", "2026-10-14T13:30:00-06:00"],
    ["texto libre", "mañana a las 3"],
    ["fecha imposible", "2026-02-31T13:00:00-06:00"],
    ["anio 9999", "9999-12-31T13:00:00-06:00"],
    ["sin zona", "2026-10-07T13:00:00"],
  ];
  it.each(programadasInvalidas)("programado_para %s: se rechaza, no se crea pedido y no se guarda una hora absurda", async (_n, valor) => {
    const f = buildRestaurantFixture();
    const s = flujo(f);
    await s.seguro("cotizar_pedido", s.base(2, { programado_para: valor }));
    const out = await s.seguro("cotizar_pedido", s.base(2, { programado_para: valor }));
    expect(JSON.stringify(out.result)).toMatch(/"error"/);
    expect(await ordenes(f)).toHaveLength(0);
  });
});

describe("R11-5E sucursal fuera de zona (perfil PM: radio de 8 km fijado por el servidor)", () => {
  it("un pin en Madrid o a 12 km no se asigna ni se promete envio; el pin real si", async () => {
    const f = buildRestaurantFixture();
    await conPerfilPm(f);
    const s = flujo(f);
    const asignada = await s.seguro("buscar_sucursal_cercana", { lat: 21.0186, lng: -89.6708 });
    expect((asignada.result as { estado?: string }).estado).toBe("asignada");
    for (const pin of [{ lat: 40.4, lng: -3.7 }, { lat: 21.12, lng: -89.67 }]) {
      const out = await s.seguro("buscar_sucursal_cercana", pin);
      expect((out.result as { estado?: string }).estado).toBe("fuera_de_zona");
    }
  });

  it("coordenadas invalidas (fuera de rango, NaN, texto, solo una) nunca asignan una sucursal", async () => {
    const f = buildRestaurantFixture();
    await conPerfilPm(f);
    const s = flujo(f);
    for (const pin of [{ lat: 91, lng: 181 }, { lat: Number.NaN, lng: 1 }, { lat: "21", lng: "-89" }, { lat: 21 }, { lat: 0, lng: 0 }, { colonia: "" }, { colonia: "a".repeat(5000) }]) {
      const out = await s.seguro("buscar_sucursal_cercana", pin as Record<string, unknown>);
      expect((out.result as { estado?: string }).estado, JSON.stringify(pin).slice(0, 40)).not.toBe("asignada");
    }
  });

  it("un pedido a DOMICILIO con una colonia que no existe no se crea", async () => {
    const f = buildRestaurantFixture();
    await conPerfilPm(f);
    const s = flujo(f);
    const out = await s.seguro("cotizar_pedido", { ...s.base(5), canal: "domicilio", colonia_entrega: "Colonia Que No Existe 12345" });
    expect(await ordenes(f)).toHaveLength(0);
    expect(out.orderId).toBeNull();
  });
});

describe("R11-5F alcohol y menores", () => {
  const conCerveza = (f: Fixture) => [{ product_id: f.products.cervezaSol, product_name: "Sol", requested_quantity: 2 }];
  // WhatsApp es estricto: SOLO el booleano true confirma la mayoria de edad. Las cadenas 'true', 'si', 1, 'false' o el relleno null no cuentan.
  it.each([[undefined], [false], ["true"], ["si"], [1], [null], ["false"], [[]]])("cotizar cerveza con adult_confirmed=%j: se rechaza", async (valor) => {
    const f = buildRestaurantFixture();
    const s = flujo(f);
    const out = await s.seguro("cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: conCerveza(f), ...(valor === undefined ? {} : { adult_confirmed: valor }) });
    expect(JSON.stringify(out.result)).toMatch(/"error"/);
    expect(await ordenes(f)).toHaveLength(0);
  });

  it("(control) con adult_confirmed=true la cotizacion pasa, pero crear_pedido sin repetirlo se rechaza (la confirmacion no se hereda en silencio)", async () => {
    const f = buildRestaurantFixture();
    const s = flujo(f);
    const q = await s.seguro("cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: conCerveza(f), adult_confirmed: true });
    expect(JSON.stringify(q.result)).not.toMatch(/"error"/);
    s.next();
    await s.seguro("confirmar_resumen", {});
    const out = await s.seguro("crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: conCerveza(f), customer_name: "Ana", payment_method: "efectivo" });
    expect(out.orderId).toBeNull();
    expect(await ordenes(f)).toHaveLength(0);
  });
});

describe("R11-5G alergias y salud: el clasificador responde ANTES del modelo y nunca afirma ingredientes", () => {
  const frases = ["Soy alérgico al cacahuate, ¿lleva?", "Mi hijo es celíaco, ¿tienen algo sin gluten?", "Soy alérgica a los mariscos", "Tengo intolerancia a la lactosa", "Me intoxiqué con sus tacos de ayer", "me dio diarrea despues de comer sus tacos"];
  it.each(frases)("'%s' -> alergia_salud con respuesta fija que no promete ingredientes", (frase) => {
    const m = classifyHighRiskIntent(frase);
    expect(m?.motivo).toBe("alergia_salud");
    expect(m!.reply).not.toMatch(/no lleva|sin (?:cacahuate|gluten|lactosa)|es seguro|puede comer/i);
  });
});

describe("R11-5H privacidad: un cliente nunca ve datos de otro", () => {
  it("repetir_pedido con el numero de un pedido AJENO no devuelve los renglones del otro cliente", async () => {
    const f = buildRestaurantFixture();
    const original = f.repo.createOrderIdempotent.bind(f.repo);
    let numero = 100;
    vi.spyOn(f.repo, "createOrderIdempotent").mockImplementation(async (...a) => ({ ...(await original(...a)), orderNumber: numero++ }));
    // Cliente A pide 2 Coca (pedido #100); cliente B pide 3 Sol... y luego intenta repetir el #100.
    await pedidoCompleto(f, "9991111111", 2, { customer_name: "Ana Reservada" });
    const sB = flujo(f, "9992222222");
    const itemsB = [{ product_id: f.products.cervezaSol, product_name: "Sol", requested_quantity: 3 }];
    await sB.seguro("cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: itemsB, adult_confirmed: true });
    sB.next();
    await sB.seguro("confirmar_resumen", {});
    await sB.seguro("crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: itemsB, adult_confirmed: true, customer_name: "Beto", payment_method: "efectivo" });
    const out = await sB.seguro("repetir_pedido", { branch_slug: "fco-montejo", pedido_numero: 100 });
    const texto = JSON.stringify(out.result);
    expect(texto).not.toContain("Coca-Cola");
    expect(texto).not.toContain("Ana Reservada");
  });

  it("el telefono DICTADO por voz (linea sin identificar) recibe cliente nuevo e historial vacio, aunque ese numero tenga pedidos", async () => {
    const f = buildRestaurantFixture();
    await pedidoCompleto(f, "9991111111", 2, { customer_name: "Ana Reservada" });
    const ctx = { organizationId: f.organizationId, channel: "voz" as const, phone: "9991111111", phoneDeclared: true };
    const { invokeAgentTool } = await import("../../src/agent-tools/registry.ts");
    const cliente = await invokeAgentTool(f.repo, ctx, "buscar_cliente", {});
    const historial = await invokeAgentTool(f.repo, ctx, "historial_pedidos", {});
    expect(JSON.stringify(cliente.result)).not.toContain("Ana Reservada");
    expect((historial.result as { pedidos: unknown[] }).pedidos).toHaveLength(0);
  });

  it("el prompt del turno de B no contiene el nombre ni el telefono de A", async () => {
    const f = buildRestaurantFixture();
    await pedidoCompleto(f, "9991111111", 2, { customer_name: "Ana Reservada" });
    const clienteB = await lookupCustomerConPedidoReciente(f.repo, f.organizationId, "9992222222");
    const prompt = buildSystemPrompt(PM_CONFIG_POR_OMISION, await f.repo.listBranchesForOrganization(f.organizationId), clienteB, new Date());
    expect(prompt).not.toContain("Ana Reservada");
    expect(prompt).not.toContain("9991111111");
  });

  it("el error interno de una herramienta registra la clase del error pero NO los argumentos de la herramienta (direccion, telefono)", async () => {
    const f = buildRestaurantFixture();
    vi.spyOn(f.repo, "findBranch").mockRejectedValue(new Error("boom"));
    const registros: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => void registros.push(a.join(" ")));
    const s = flujo(f, PHONE);
    await s.seguro("consultar_sucursal", { branch_slug: "fco-montejo", customer_address: "Calle 7 #210 Secreta" });
    expect(registros.join("\n")).toContain("consultar_sucursal");
    expect(registros.join("\n")).not.toContain("Secreta");
    expect(registros.join("\n")).not.toContain(PHONE);
  });
});

describe("R11-5I cobro incorrecto y propina (sucursal con propina solo con tarjeta)", () => {
  async function creaConPago(extra: Record<string, unknown>, qty = 2) {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { propinaPolitica: "solo_tarjeta" });
    const s = flujo(f);
    await s.quote(qty, { payment_method: extra.payment_method });
    s.next();
    await s.confirm();
    const out = await s.seguro("crear_pedido", { ...s.base(qty), customer_name: "Ana", ...extra });
    const [orden] = await ordenes(f);
    return { out, orden, error: JSON.stringify(out.result).match(/"error":"([^"]*)"/)?.[1] };
  }

  it.each([
    ["efectivo con menos del total", { payment_method: "efectivo", efectivo_con: 50 }],
    ["forma de pago inventada", { payment_method: "bitcoin" }],
    ["forma de pago vacia", { payment_method: "" }],
    ["transferencia", { payment_method: "transferencia" }],
    ["propina negativa", { payment_method: "tarjeta", propina: -50 }],
    ["propina mayor que el total", { payment_method: "tarjeta", propina: 100_000 }],
    ["propina NaN", { payment_method: "tarjeta", propina: Number.NaN }],
    ["propina con efectivo", { payment_method: "efectivo", propina: 20 }],
    ["propina porcentaje 150", { payment_method: "tarjeta", propina_porcentaje: 150 }],
    ["propina porcentaje negativo", { payment_method: "tarjeta", propina_porcentaje: -5 }],
  ])("%s: se rechaza y no hay pedido", async (_n, extra) => {
    const { orden, error } = await creaConPago(extra);
    expect(error).toBeTruthy();
    expect(orden).toBeUndefined();
  });

  it("la propina NUNCA se suma al total cobrado: tarjeta + 10 % deja total $90 y la propina aparte ($9.00)", async () => {
    const { orden } = await creaConPago({ payment_method: "tarjeta", propina_porcentaje: 10 });
    expect(orden!.total).toBe(90);
    expect(orden!.notes).toContain("Propina: $9.00 (no incluida en el total).");
  });

  it("propina con centavos de mas se redondea a 2 decimales (20.555 -> $20.56) y el total no cambia", async () => {
    const { orden } = await creaConPago({ payment_method: "tarjeta", propina: 20.555 });
    expect(orden!.total).toBe(90);
    expect(orden!.notes).toContain("Propina: $20.56");
  });

  it("efectivo_con negativo o texto se ignora como 'sin dato' y NUNCA cambia el total", async () => {
    for (const efectivo_con of [-500, "abc", 0]) {
      const { orden } = await creaConPago({ payment_method: "efectivo", efectivo_con });
      expect(orden?.total, String(efectivo_con)).toBe(90);
    }
  });
});
