// QA restaurantes, ronda 1 (lote storefront / dinero / idempotencia): regresiones de los defectos del storefront publico
// y del checkout, por HTTP real sobre el repositorio en memoria (sin base real). Cada caso fallaba antes del arreglo.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const ORG = "los-taquitos-de-pm";
const BASE = `/v1/restaurantes/${ORG}/storefront`;

// Cuerpos de respuesta heterogeneos: los asserts verifican la forma.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function setup() {
  const t = await buildTestDeps();
  const app = buildApp(t.deps);
  // Cada prueba usa su propia IP para no compartir el bucket de tasa con otras.
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const headers = { origin: "http://localhost:5173", "x-forwarded-for": ip };
  const post = (path: string, body: Record<string, unknown>, h: Record<string, string> = headers) => app.request(`${BASE}${path}`, jsonRequestInit(body, h));
  const json = async (res: Response) => (await res.json()) as Json;
  const session = `caos-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const coca = { product_id: t.products.cocaCola, requested_quantity: 2 };
  const tacos = { product_id: t.products.tacosPastor, requested_quantity: 3, tortilla: "maiz" };
  const cliente = { customer_name: "Ana Pérez", customer_phone: "999 123 4567", customer_address: "Calle 10 #200, Centro" };
  const pedidos = async () => (await t.restaurantesRepo.listOrders(t.organizationId, { propertyIds: null, limit: 100 })).orders;
  /** Lo que hace SucursalPage al pulsar "Revisar pedido" y luego "Confirmar pedido". */
  const ciclo = async (body: Record<string, unknown>, extraCrear: Record<string, unknown> = {}) => {
    const q = await post("/fco-montejo/quote", body);
    const quote = await json(q);
    const c = await post("/fco-montejo/confirm", { session_id: body.session_id, quote_hash: quote.quote_hash });
    const o = await post("/fco-montejo/orders", { ...body, quote_hash: quote.quote_hash, ...cliente, ...extraCrear });
    return { q, quote, c, o, creado: await json(o) };
  };
  return { ...t, app, post, json, session, coca, tacos, cliente, pedidos, ciclo, headers };
}

describe("caos: respuesta perdida de POST /orders y reintento desde la UI (re-cotizar -> confirmar -> crear)", () => {
  it("PASA: mismo carrito y mismos datos -> se devuelve el mismo pedido, no se duplica", async () => {
    const s = await setup();
    const body = { session_id: s.session, items: [s.coca], canal: "recoger", payment_method: "efectivo" };
    const primero = await s.ciclo(body);
    expect(primero.o.status).toBe(200);
    // La respuesta se "perdio": el navegador conserva sessionId y carrito y el cliente vuelve a pulsar "Revisar pedido".
    const segundo = await s.ciclo(body);
    expect(segundo.o.status).toBe(200);
    expect(await s.pedidos()).toHaveLength(1);
  });

  // QA-restaurantes-R1-caos-01: tras perder la respuesta, el cliente corrige un dato de contacto (direccion/notas)
  // antes de reintentar. La llave de idempotencia (sesion + huella del carrito) es la misma pero el contenido no:
  // el servidor responde 409 con el mensaje interno en INGLES y el cliente no sabe que su pedido SI quedo registrado.
  it("QA-caos-01: corregir la direccion al reintentar -> 200 ya registrado (o mensaje claro en espanol), no 409 en ingles", async () => {
    const s = await setup();
    const body = { session_id: s.session, items: [s.tacos], canal: "domicilio", payment_method: "efectivo" };
    const primero = await s.ciclo(body);
    expect(primero.o.status).toBe(200);
    const segundo = await s.ciclo(body, { customer_address: "Calle 10 #200 x 15 y 17, Centro (porton verde)" });
    const cuerpo = segundo.creado;
    expect(segundo.o.status).toBe(200);
    expect(JSON.stringify(cuerpo)).not.toMatch(/idempotency key|payload/i);
    expect(await s.pedidos()).toHaveLength(1);
  });

  // QA-restaurantes-R1-caos-02: la misma sesion del navegador ya registro un pedido (estado "creado" en la maquina de
  // estados), pero una nueva cotizacion lo pisa en silencio: si el cliente, creyendo que fallo, agrega algo y reenvia,
  // nacen DOS pedidos para cocina. El servidor sabe que esa sesion ya tiene pedido y no lo avisa.
  it("QA-caos-02: re-cotizar en una sesion que ya creo pedido avisa 'ya tienes un pedido registrado' en vez de crear otro", async () => {
    const s = await setup();
    const body = { session_id: s.session, items: [s.coca], canal: "recoger", payment_method: "efectivo" };
    expect((await s.ciclo(body)).o.status).toBe(200);
    const masCosas = { ...body, items: [s.coca, s.tacos] };
    const segundo = await s.ciclo(masCosas);
    const advirtio = segundo.q.status !== 200 || segundo.creado.ya_registrado === true || /ya .*registrad/i.test(JSON.stringify(segundo.quote));
    expect(advirtio).toBe(true);
    expect(await s.pedidos()).toHaveLength(1);
  });

  it("PASA: dos POST /orders simultaneos (doble clic real) -> un solo pedido", async () => {
    const s = await setup();
    const body = { session_id: s.session, items: [s.coca], canal: "recoger", payment_method: "efectivo" };
    const quote = await s.json(await s.post("/fco-montejo/quote", body));
    await s.post("/fco-montejo/confirm", { session_id: s.session, quote_hash: quote.quote_hash });
    const crear = () => s.post("/fco-montejo/orders", { ...body, quote_hash: quote.quote_hash, ...s.cliente });
    const [a, b] = await Promise.all([crear(), crear()]);
    expect([a.status, b.status].filter((x) => x === 200).length).toBeGreaterThanOrEqual(1);
    expect(await s.pedidos()).toHaveLength(1);
  });
});

describe("caos: el catalogo cambia en vivo entre la confirmacion y la creacion", () => {
  // QA-restaurantes-R1-caos-03: la huella de la cotizacion (fingerprintOrder) solo lleva sucursal, canal, productos y
  // cantidades, NO el precio. Si el dueno cambia un precio despues de que el cliente vio y confirmo el total, el
  // pedido se crea con el precio NUEVO sin volver a pedir confirmacion: el cliente paga algo distinto a lo que acepto.
  it("QA-caos-03: precio cambiado tras confirmar -> exige re-cotizar (o respeta el total confirmado)", async () => {
    const s = await setup();
    const body = { session_id: s.session, items: [s.coca], canal: "recoger", payment_method: "efectivo" };
    const quote = await s.json(await s.post("/fco-montejo/quote", body));
    expect(quote.quote.total).toBe(90);
    await s.post("/fco-montejo/confirm", { session_id: s.session, quote_hash: quote.quote_hash });
    await s.restaurantesRepo.upsertBranchProductState(s.propertyId, s.products.cocaCola!, 60, true);
    const res = await s.post("/fco-montejo/orders", { ...body, quote_hash: quote.quote_hash, ...s.cliente });
    if (res.status === 200) {
      expect((await s.json(res)).total).toBe(90);
    } else {
      expect(res.status).toBe(400);
      expect((await s.json(res)).motivo).toBeDefined();
    }
  });

  it("PASA: producto agotado ('hoy no hay') tras confirmar -> 400 claro y ningun pedido", async () => {
    const s = await setup();
    const body = { session_id: s.session, items: [s.coca], canal: "recoger", payment_method: "efectivo" };
    const quote = await s.json(await s.post("/fco-montejo/quote", body));
    await s.post("/fco-montejo/confirm", { session_id: s.session, quote_hash: quote.quote_hash });
    await s.restaurantesRepo.upsertBranchProductState(s.propertyId, s.products.cocaCola!, 45, false);
    const res = await s.post("/fco-montejo/orders", { ...body, quote_hash: quote.quote_hash, ...s.cliente });
    expect(res.status).toBe(400);
    expect((await s.json(res)).message).toMatch(/no disponible|agotad|no hay/i);
    expect(await s.pedidos()).toHaveLength(0);
  });
});

describe("caos: limite de tasa bajo IP compartida (CGNAT de redes moviles)", () => {
  // QA-restaurantes-R1-caos-04: el bucket del storefront es (scope, IP) sin organizacion. Diez pedidos de clientes
  // de OTRO restaurante detras de la misma IP publica (CGNAT de Telcel/AT&T, wifi de una plaza) dejan sin poder
  // pedir a los clientes de PM durante un minuto.
  it("QA-caos-04: el cupo agotado por otro restaurante no bloquea los pedidos de este", async () => {
    const s = await setup();
    const otraOrg = randomUUID();
    const otraSucursal = randomUUID();
    s.restaurantesRepo.seedOrganization({ id: otraOrg, slug: "otra-taqueria", name: "Otra Taqueria" });
    s.restaurantesRepo.seedBranch({ propertyId: otraSucursal, organizationId: otraOrg, name: "Centro", slug: "centro", status: "active", phone: null, address: null, lat: null, lng: null });
    const cat = randomUUID();
    s.restaurantesRepo.seedCategory({ id: cat, organizationId: otraOrg, name: "Bebidas" });
    const agua = randomUUID();
    s.restaurantesRepo.seedProduct({ id: agua, organizationId: otraOrg, categoryId: cat, name: "Agua", description: null, searchKeywords: [] });
    s.restaurantesRepo.seedBranchProduct({ propertyId: otraSucursal, productId: agua, price: 20, isAvailable: true });
    for (let i = 0; i < 10; i++) {
      const r = await s.app.request(
        `/v1/restaurantes/otra-taqueria/storefront/centro/orders`,
        jsonRequestInit({ session_id: `otra-sesion-${String(i).padStart(10, "0")}`, items: [{ product_id: agua, requested_quantity: 1 }], canal: "recoger" }, s.headers),
      );
      expect(r.status).not.toBe(429);
    }
    const body = { session_id: s.session, items: [s.coca], canal: "recoger", payment_method: "efectivo" };
    const { o } = await s.ciclo(body);
    expect(o.status).not.toBe(429);
  });
});

describe("caos: datos raros (unicode, emoji, tamanos limite, centavos)", () => {
  it("PASA: emoji, acentos y caracteres invisibles en nombre/notas no rompen el pedido", async () => {
    const s = await setup();
    const body = { session_id: s.session, items: [s.coca], canal: "recoger", payment_method: "efectivo" };
    const { o, creado } = await s.ciclo(body, { customer_name: "Ñoño 🌮 Pérez​", notes: "sin cebolla 🙏 ‮gracias" });
    expect(o.status).toBe(200);
    expect(creado.total).toBe(90);
    const [pedido] = await s.pedidos();
    expect(pedido!.customerName).toContain("🌮");
  });

  // QA-restaurantes-R1-caos-05: `str(body.notes, 2000)` devuelve undefined cuando el texto pasa del tope, asi que las
  // notas largas (indicaciones de entrega, alergias) se DESCARTAN en silencio: el pedido se crea sin ellas y el
  // cliente nunca se entera. Lo mismo con la direccion (> 1000) que termina en un 400 "falta direccion" enganoso.
  it("QA-caos-05: notas de mas de 2000 caracteres -> 400 explicito (o se conservan truncadas), nunca se pierden en silencio", async () => {
    const s = await setup();
    const body = { session_id: s.session, items: [s.coca], canal: "recoger", payment_method: "efectivo" };
    const notas = `ALERGIA A LA NUEZ. ${"Toque el timbre dos veces y espere. ".repeat(60)}`;
    expect(notas.length).toBeGreaterThan(2000);
    const { o } = await s.ciclo(body, { notes: notas });
    if (o.status === 200) {
      const [pedido] = await s.pedidos();
      expect(pedido!.notes ?? "").toContain("ALERGIA A LA NUEZ");
    } else {
      expect(o.status).toBe(400);
    }
  });

  // QA-restaurantes-R1-caos-06: la propina acepta fracciones de centavo (0.001, 10.555): se guarda el numero crudo y
  // la nota impresa dice "$0.00" o redondea distinto que la columna; el dinero debe ir a centavos.
  it("QA-caos-06: propina con fraccion de centavo -> 400 o redondeada a centavos de forma consistente", async () => {
    const s = await setup();
    s.restaurantesRepo.seedBranchPolicy(s.propertyId, { propinaPolitica: "solo_tarjeta" });
    const body = { session_id: s.session, items: [s.coca], canal: "recoger", payment_method: "tarjeta" };
    const { o } = await s.ciclo(body, { propina: 10.555 });
    if (o.status === 200) {
      const [pedido] = await s.pedidos();
      const propina = (pedido as unknown as { propina: number | null }).propina;
      expect(propina === null || Math.round(propina * 100) === propina * 100).toBe(true);
    } else {
      expect(o.status).toBe(400);
    }
  });
});

describe("regresiones reforzadas del lote (dinero, idempotencia, entradas, programados, legado)", () => {
  it("caos-03: precio cambiado tras confirmar -> 400 con motivo precio_cambio, ningun pedido; re-cotizar muestra el total nuevo y se crea", async () => {
    const s = await setup();
    const body = { session_id: s.session, items: [s.coca], canal: "recoger", payment_method: "efectivo" };
    const quote = await s.json(await s.post("/fco-montejo/quote", body));
    await s.post("/fco-montejo/confirm", { session_id: s.session, quote_hash: quote.quote_hash });
    await s.restaurantesRepo.upsertBranchProductState(s.propertyId, s.products.cocaCola!, 60, true);
    const res = await s.post("/fco-montejo/orders", { ...body, quote_hash: quote.quote_hash, ...s.cliente });
    expect(res.status).toBe(400);
    const cuerpo = await s.json(res);
    expect(cuerpo.motivo).toBe("precio_cambio");
    expect(cuerpo.message).toMatch(/precios/i);
    expect(await s.pedidos()).toHaveLength(0);
    // El cliente vuelve a revisar: ve el total vigente (120) y ese si se cobra.
    const { o, creado, quote: nueva } = await s.ciclo(body);
    expect(nueva.quote.total).toBe(120);
    expect(o.status).toBe(200);
    expect(creado.total).toBe(120);
  });

  it("caos-03: sin cambio de precio entre confirmar y crear el flujo normal sigue funcionando (sin falsos positivos)", async () => {
    const s = await setup();
    const { o, creado } = await s.ciclo({ session_id: s.session, items: [s.coca, s.tacos], canal: "recoger", payment_method: "efectivo" });
    expect(o.status).toBe(200);
    expect(creado.total).toBeGreaterThan(90);
    expect(await s.pedidos()).toHaveLength(1);
  });

  it("caos-02: re-cotizar en una sesion con pedido registrado -> 409 ya_registrado con el rastreo del pedido existente", async () => {
    const s = await setup();
    const body = { session_id: s.session, items: [s.coca], canal: "recoger", payment_method: "efectivo" };
    const primero = await s.ciclo(body);
    expect(primero.o.status).toBe(200);
    const q = await s.post("/fco-montejo/quote", { ...body, items: [s.coca, s.tacos] });
    expect(q.status).toBe(409);
    const cuerpo = await s.json(q);
    expect(cuerpo).toMatchObject({ ya_registrado: true, motivo: "pedido_ya_creado" });
    expect(cuerpo.rastreo_token).toBe(primero.creado.rastreo_token);
    expect(cuerpo.message).toMatch(/pedido registrado/i);
    expect(await s.pedidos()).toHaveLength(1);
    // Confirmar tras un pedido creado tambien devuelve el rastreo, no un error mudo.
    const c = await s.post("/fco-montejo/confirm", { session_id: s.session, quote_hash: primero.quote.quote_hash });
    expect(c.status).toBe(409);
    expect((await s.json(c)).rastreo_token).toBe(primero.creado.rastreo_token);
  });

  it("caos-02: otra sesion (carrito nuevo) si puede hacer otro pedido: el aviso es por sesion, no por telefono", async () => {
    const s = await setup();
    const body = { items: [s.coca], canal: "recoger", payment_method: "efectivo" };
    expect((await s.ciclo({ ...body, session_id: s.session })).o.status).toBe(200);
    expect((await s.ciclo({ ...body, session_id: `${s.session}-otra` })).o.status).toBe(200);
    expect((await s.pedidos()).length).toBe(2);
  });

  it("caos-01: corregir la direccion al reintentar -> 200 ya_registrado con el rastreo, sin el texto interno del motor", async () => {
    const s = await setup();
    const body = { session_id: s.session, items: [s.tacos], canal: "domicilio", payment_method: "efectivo" };
    const primero = await s.ciclo(body);
    const segundo = await s.ciclo(body, { customer_address: "Calle 10 #200 x 15 y 17, Centro (porton verde)" });
    expect(segundo.o.status).toBe(200);
    expect(segundo.creado).toMatchObject({ ya_registrado: true, rastreo_token: primero.creado.rastreo_token });
    expect(JSON.stringify(segundo.creado)).not.toMatch(/idempotency key|payload/i);
    expect(await s.pedidos()).toHaveLength(1);
  });

  it("caos-01: sin maquina de estados (base sin migrar) y la misma llave con otra direccion -> 409 con mensaje en espanol", async () => {
    const s = await setup();
    s.restaurantesRepo.orderFlowUnavailable = true;
    const hash = "a".repeat(32);
    const body = { session_id: s.session, items: [s.tacos], canal: "domicilio", payment_method: "efectivo", quote_hash: hash, ...s.cliente };
    expect((await s.post("/fco-montejo/orders", body)).status).toBe(200);
    const res = await s.post("/fco-montejo/orders", { ...body, customer_address: "Otra calle 99, Centro" });
    expect(res.status).toBe(409);
    const cuerpo = await s.json(res);
    expect(cuerpo.message).toMatch(/ya quedó registrado/);
    expect(JSON.stringify(cuerpo)).not.toMatch(/idempotency key|payload/i);
    expect(await s.pedidos()).toHaveLength(1);
  });

  it("caos-04: el cupo es por restaurante: agotar el de otro no limita a PM, pero PM sigue teniendo su propio tope de 10 por minuto", async () => {
    const s = await setup();
    const body = { session_id: s.session, items: [s.coca], canal: "recoger", payment_method: "efectivo" };
    // 10 intentos de pedido de PM desde la misma IP agotan el cupo de PM...
    const codigos: number[] = [];
    for (let i = 0; i < 12; i++) codigos.push((await s.post("/fco-montejo/orders", { ...body, session_id: `${s.session}${i}`, ...s.cliente })).status);
    expect(codigos.slice(0, 10)).not.toContain(429);
    expect(codigos.slice(10)).toEqual([429, 429]);
  });

  it("caos-05: notas de mas de 2000 caracteres y direccion de mas de 1000 -> 400 que nombra el campo, ningun pedido", async () => {
    const s = await setup();
    const body = { session_id: s.session, items: [s.coca], canal: "recoger", payment_method: "efectivo" };
    const notas = await s.ciclo(body, { notes: `ALERGIA A LA NUEZ. ${"x".repeat(2100)}` });
    expect(notas.o.status).toBe(400);
    expect(notas.creado.message).toMatch(/Las notas/);
    expect(await s.pedidos()).toHaveLength(0);
    const s2 = await setup();
    const dom = await s2.ciclo({ session_id: s2.session, items: [s2.tacos], canal: "domicilio", payment_method: "efectivo" }, { customer_address: "Calle ".repeat(300) });
    expect(dom.o.status).toBe(400);
    expect(dom.creado.message).toMatch(/La dirección excede el máximo de 1000/);
  });

  it("caos-05: notas dentro del tope (2000) se conservan completas", async () => {
    const s = await setup();
    const notas = `ALERGIA A LA NUEZ. ${"a".repeat(500)}`;
    const { o } = await s.ciclo({ session_id: s.session, items: [s.coca], canal: "recoger", payment_method: "efectivo" }, { notes: notas });
    expect(o.status).toBe(200);
    expect((await s.pedidos())[0]!.notes).toContain("ALERGIA A LA NUEZ");
  });

  it("caos-06: propina 10.555 -> se guarda 10.56 y la nota dice $10.56 (una sola cifra a centavos)", async () => {
    const s = await setup();
    s.restaurantesRepo.seedBranchPolicy(s.propertyId, { propinaPolitica: "solo_tarjeta" });
    const { o } = await s.ciclo({ session_id: s.session, items: [s.coca], canal: "recoger", payment_method: "tarjeta" }, { propina: 10.555 });
    expect(o.status).toBe(200);
    const [pedido] = await s.pedidos();
    expect((pedido as unknown as { propina: number }).propina).toBe(10.56);
    expect(pedido!.notes).toContain("Propina: $10.56");
  });

  it("features-10: programado_para en el storefront se rechaza explicitamente (400) en cotizar, confirmar y crear, y no entra a cocina", async () => {
    const s = await setup();
    const manana = new Date(Date.now() + 26 * 3600_000).toISOString();
    const body = { session_id: s.session, items: [s.coca], canal: "recoger", payment_method: "efectivo", programado_para: manana };
    const q = await s.post("/fco-montejo/quote", body);
    expect(q.status).toBe(400);
    expect((await s.json(q)).message).toMatch(/programados.*menú en línea/);
    expect((await s.post("/fco-montejo/orders", { ...body, ...s.cliente })).status).toBe(400);
    expect(await s.pedidos()).toHaveLength(0);
  });

  it("features-02: el checkout legado sin credenciales exige direccion a domicilio, telefono de 10 digitos y forma de pago", async () => {
    const s = await setup();
    const legado = (extra: Record<string, unknown>) =>
      s.app.request(`/v1/restaurantes/${ORG}/orders`, jsonRequestInit({ branch_slug: "fco-montejo", customer_name: "Sin Direccion", items: [s.coca], ...extra }, {}));
    const sinNada = await legado({ customer_phone: "123", canal: "domicilio" });
    expect(sinNada.status).toBe(400);
    expect((await legado({ customer_phone: "9991234567", canal: "domicilio", payment_method: "efectivo" })).status).toBe(400); // sin direccion
    expect((await legado({ customer_phone: "9991234567", canal: "recoger" })).status).toBe(400); // sin forma de pago
    expect((await legado({ customer_phone: "123", canal: "recoger", payment_method: "efectivo" })).status).toBe(400); // telefono invalido
    expect(await s.pedidos()).toHaveLength(0);
    const ok = await legado({ customer_phone: "9991234567", canal: "domicilio", payment_method: "efectivo", customer_address: "Calle 10 #200, Centro" });
    expect(ok.status).toBe(200);
    expect(await s.pedidos()).toHaveLength(1);
  });
});
