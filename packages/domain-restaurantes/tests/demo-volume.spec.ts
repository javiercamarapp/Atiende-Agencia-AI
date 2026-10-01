// R-20 -- seed de volumen de la demo: los pedidos salen del motor REAL (prepareCreateOrder con el menu, precios, horario y promocion
// del seed de PM), con totales coherentes, reglas duras respetadas, sin PII real, deterministas e idempotentes.
// Postgres real: scripts/verify-restaurantes-demo-volumen/.
import { describe, expect, it } from "vitest";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import {
  DEMO_VOLUME_SCALES,
  DemoVolumeError,
  generarVolumenDemo,
  localToUtc,
  memorizarLecturas,
  type DemoConversationRow,
  type DemoHandoffRow,
  type DemoOrderRow,
  type DemoVolumeOptions,
  type DemoVolumeSummary,
} from "../src/seed/demo-volume.ts";
import { esTelefonoDemo } from "../src/demo/types.ts";
import { fechaLocal } from "../src/horarios.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
const plan = buildPmSeedPlan(data, agent);
// Miercoles 14-oct-2026 09:00 en Merida: el ultimo dia generado es el martes 13.
const AHORA = new Date("2026-10-14T15:00:00Z");
const ORG_ID = "00000000-0000-4000-8000-0000000000d1";

async function generar(extra: Partial<DemoVolumeOptions> = {}) {
  // Organizacion fija: la clave de idempotencia incluye la organizacion (misma organizacion -> mismas claves).
  const world = await buildInMemoryPmWorld(plan, { organizationId: ORG_ID });
  const orders: DemoOrderRow[] = [];
  const customers: { phone: string; name: string; address: string; firstOrderAt: string }[] = [];
  let conversations: readonly DemoConversationRow[] = [];
  let handoffs: readonly DemoHandoffRow[] = [];
  let callbacks: readonly { phone: string; resolved: boolean }[] = [];
  const gen = generarVolumenDemo(world.repo, { organizationId: world.organizationId, dias: 28, pedidosPorDia: 20, ahora: AHORA, ...extra });
  let summary: DemoVolumeSummary | undefined;
  for (;;) {
    const r = await gen.next();
    if (r.done) {
      summary = r.value;
      break;
    }
    orders.push(...r.value.orders);
    customers.push(...r.value.customers);
    if (r.value.conversations.length) conversations = r.value.conversations;
    if (r.value.handoffs.length) handoffs = r.value.handoffs;
    if (r.value.callbacks.length) callbacks = r.value.callbacks;
  }
  return { world, orders, customers, conversations, handoffs, callbacks, summary: summary! };
}

const subtotal = (o: DemoOrderRow) => Math.round(o.items.reduce((s, i) => s + i.price * i.quantity, 0) * 100) / 100;
const descuento = (o: DemoOrderRow) => Number(/Promoción aplicada: [A-Z0-9_-]+ \(-\$([0-9.]+)\)/.exec(o.notes)?.[1] ?? 0);

describe("generarVolumenDemo (motor real de pedidos)", () => {
  it("genera volumen moderado en las 5 sucursales activas y NUNCA toca T4 (inactiva)", async () => {
    const { orders, summary } = await generar();
    expect(orders.length).toBeGreaterThan(300);
    expect(summary.orders).toBe(orders.length);
    expect(Object.keys(summary.porSucursal).sort()).toEqual(["altabrisa", "fco-montejo", "garcia-lavin", "pensiones", "prol-montejo"]);
    expect(orders.some((o) => o.branchSlug === "t4-pendiente")).toBe(false);
    // Proporcion ilustrativa: la sucursal grande vende mas que la mas chica.
    expect(summary.porSucursal["garcia-lavin"]!).toBeGreaterThan(summary.porSucursal["pensiones"]!);
  });

  it("los totales son COHERENTES: suma de renglones (precio del menu x cantidad) menos el descuento que el motor aplico", async () => {
    const { orders } = await generar();
    for (const o of orders) {
      expect(o.total, `pedido ${o.idempotencyKey.slice(0, 8)}`).toBeCloseTo(subtotal(o) - descuento(o), 2);
      expect(o.items.length).toBeGreaterThan(0);
      for (const i of o.items) {
        expect(i.quantity).toBeGreaterThan(0);
        expect(Number.isInteger(i.quantity)).toBe(true);
        expect(i.price).toBeGreaterThan(0);
      }
    }
  });

  it("respeta las reglas duras: minimo $200 a domicilio (antes de descuentos), alcohol solo al recoger, propina solo con tarjeta, tortilla en tacos", async () => {
    const { orders, world } = await generar();
    const alcohol = new Set(plan.products.filter((p) => p.noDomicilio).map((p) => p.name));
    expect(alcohol.size).toBe(42);
    let domicilio = 0;
    let recogerConAlcohol = 0;
    for (const o of orders) {
      if (o.canal === "domicilio") {
        domicilio += 1;
        expect(subtotal(o)).toBeGreaterThanOrEqual(200);
        expect(o.items.some((i) => alcohol.has(i.name))).toBe(false);
        expect(o.address).toBeTruthy();
      } else {
        expect(o.address).toBeNull();
        if (o.items.some((i) => alcohol.has(i.name))) recogerConAlcohol += 1;
      }
      if (o.propina !== null) expect(o.paymentMethod).toBe("tarjeta");
      for (const i of o.items) if (/\btacos?\b/i.test(i.name)) expect(["maiz", "harina", "mixta"]).toContain(i.tortilla);
    }
    expect(domicilio).toBeGreaterThan(100);
    expect(recogerConAlcohol).toBeGreaterThanOrEqual(0);
    // Los precios son los del menu sembrado (ningun precio inventado).
    const precioPorNombre = new Map(plan.products.map((p) => [p.name, p.price]));
    for (const o of orders) for (const i of o.items) if (precioPorNombre.has(i.name)) expect(i.price).toBe(precioPorNombre.get(i.name));
    void world;
  });

  it("la promocion 2x1 del lunes la aplica el motor: solo lunes, solo recoger y solo con tacos al pastor", async () => {
    const { orders } = await generar({ dias: 56, pedidosPorDia: 30 });
    const conPromo = orders.filter((o) => descuento(o) > 0);
    expect(conPromo.length).toBeGreaterThan(0);
    for (const o of conPromo) {
      expect(o.canal).toBe("recoger");
      const dia = new Intl.DateTimeFormat("en-US", { timeZone: "America/Merida", weekday: "long" }).format(new Date(o.createdAt));
      expect(dia).toBe("Monday");
      expect(o.items.some((i) => i.name === "Taco Al Pastor (individual)")).toBe(true);
    }
    // A domicilio nunca hay promocion (aunque sea lunes).
    expect(orders.filter((o) => o.canal === "domicilio").every((o) => descuento(o) === 0)).toBe(true);
  });

  it("todos los pedidos caen dentro del horario (12:00-01:00, America/Merida) y antes de hoy", async () => {
    const { orders } = await generar();
    const hoy = fechaLocal(AHORA, "America/Merida");
    for (const o of orders) {
      const t = new Date(o.createdAt);
      const hora = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Merida", hour: "2-digit", hourCycle: "h23" }).format(t));
      const minuto = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Merida", minute: "2-digit" }).format(t));
      expect(hora >= 12 || (hora === 0 && minuto < 60), o.createdAt).toBe(true);
      expect(t.getTime()).toBeLessThan(AHORA.getTime());
      expect(fechaLocal(t, "America/Merida") <= hoy).toBe(true);
    }
  });

  it("estados coherentes: solo los completados traen entrega posterior a la creacion; cancelados y problemas no", async () => {
    const { orders } = await generar();
    const estados = new Set(orders.map((o) => o.status));
    expect([...estados].every((e) => ["completado", "cancelado", "problema", "no_recogido"].includes(e))).toBe(true);
    for (const o of orders) {
      if (o.status === "completado") expect(Date.parse(o.deliveredAt!)).toBeGreaterThan(Date.parse(o.createdAt));
      else expect(o.deliveredAt).toBeNull();
      if (o.status === "no_recogido") expect(o.canal).toBe("recoger");
    }
    expect(orders.filter((o) => o.status === "completado").length / orders.length).toBeGreaterThan(0.85);
  });

  it("sin PII real: telefonos del rango reservado 0001, nombres ficticios, sin correos, canal sin voz", async () => {
    const { orders, customers, conversations } = await generar();
    for (const o of orders) {
      expect(esTelefonoDemo(o.customerPhone)).toBe(true);
      expect(o.customerPhone).toMatch(/^0001\d{6}$/);
      expect(o.customerName).toMatch(/(Demo|Ficticio|Prueba|Muestra|Ejemplo) \d{4}$/);
      expect(["web", "whatsapp", "admin"]).toContain(o.source);
    }
    expect(new Set(customers.map((c) => c.phone)).size).toBe(customers.length);
    for (const c of conversations) expect(c.phone).toMatch(/^\+520001\d{6}$/);
    expect(JSON.stringify({ orders, customers, conversations })).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
  });

  it("es DETERMINISTA e IDEMPOTENTE: misma semilla -> mismas filas y claves unicas; otra semilla -> otras filas", async () => {
    const a = await generar();
    const b = await generar();
    // Los ids de producto son uuid aleatorios de cada mundo en memoria: se comparan los pedidos sin ellos.
    const sinIds = (os: readonly DemoOrderRow[]) => JSON.stringify(os.map((o) => ({ ...o, items: o.items.map((i) => ({ ...i, id: undefined })) })));
    expect(sinIds(a.orders)).toBe(sinIds(b.orders));
    expect(new Set(a.orders.map((o) => o.idempotencyKey)).size).toBe(a.orders.length);
    for (const o of a.orders) expect(o.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    const otra = await generar({ seed: 7 });
    expect(sinIds(otra.orders)).not.toBe(sinIds(a.orders));
  });

  it("conversaciones y handoffs: una por telefono, ligadas a su pedido, con el total del motor; solo 3 tomas pendientes (las recientes)", async () => {
    const { orders, conversations, handoffs, callbacks } = await generar({ dias: 60, pedidosPorDia: 25 });
    const porClave = new Map(orders.map((o) => [o.idempotencyKey, o]));
    expect(new Set(conversations.map((c) => c.phone)).size).toBe(conversations.length);
    const completadas = conversations.filter((c) => c.status === "completed");
    expect(completadas.length).toBeGreaterThan(20);
    for (const c of completadas) {
      const o = porClave.get(c.orderKey!)!;
      expect(o).toBeDefined();
      expect(c.messages.some((m) => m.content.includes(`$${Number.isInteger(o.total) ? o.total : o.total.toFixed(2)}`))).toBe(true);
    }
    for (const c of conversations.filter((x) => x.status === "abandoned")) expect(c.orderKey).toBeNull();
    expect(handoffs.filter((h) => h.estado === "pendiente")).toHaveLength(3);
    for (const h of handoffs) {
      expect(conversations.some((c) => c.phone === h.phone)).toBe(true);
      if (h.estado === "cerrada") expect(Date.parse(h.cerradaAt!)).toBeGreaterThan(Date.parse(h.solicitadaAt));
      else expect(h.cerradaAt).toBeNull();
    }
    expect(callbacks.filter((c) => !c.resolved)).toHaveLength(3);
  });

  it("clientes: cada cliente nuevo aparece una sola vez, antes de su primer pedido", async () => {
    const { orders, customers } = await generar();
    const primero = new Map<string, string>();
    for (const o of orders) if (!primero.has(o.customerPhone)) primero.set(o.customerPhone, o.createdAt);
    for (const c of customers) expect(c.firstOrderAt).toBe(primero.get(c.phone));
    expect(customers.length).toBe(primero.size);
  });

  it("opciones invalidas se rechazan (dias, pedidos por dia) y sin menu cargado avisa que falta el seed de PM", async () => {
    const world = await buildInMemoryPmWorld(plan);
    const intentar = async (extra: Partial<DemoVolumeOptions>) => {
      const gen = generarVolumenDemo(world.repo, { organizationId: world.organizationId, dias: 5, pedidosPorDia: 5, ahora: AHORA, ...extra });
      await gen.next();
    };
    await expect(intentar({ dias: 0 })).rejects.toBeInstanceOf(DemoVolumeError);
    await expect(intentar({ dias: 366 })).rejects.toBeInstanceOf(DemoVolumeError);
    await expect(intentar({ pedidosPorDia: 0 })).rejects.toBeInstanceOf(DemoVolumeError);
    await expect(intentar({ organizationId: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(/seed de PM/);
  });

  it("escalas: la de ~90k pedidos es OPCIONAL (90 dias x ~1000); la de por omision es moderada", () => {
    expect(DEMO_VOLUME_SCALES.moderado).toEqual({ dias: 90, pedidosPorDia: 24 });
    expect(DEMO_VOLUME_SCALES.completo.dias * DEMO_VOLUME_SCALES.completo.pedidosPorDia).toBe(90_000);
    expect(DEMO_VOLUME_SCALES.ligero.dias * DEMO_VOLUME_SCALES.ligero.pedidosPorDia).toBeLessThan(DEMO_VOLUME_SCALES.moderado.dias * DEMO_VOLUME_SCALES.moderado.pedidosPorDia);
  });
});

describe("helpers", () => {
  it("localToUtc: Merida es UTC-6 sin horario de verano", () => {
    expect(localToUtc("America/Merida", 2026, 10, 5, 13, 30).toISOString()).toBe("2026-10-05T19:30:00.000Z");
    expect(localToUtc("America/Merida", 2026, 1, 15, 0, 15).toISOString()).toBe("2026-01-15T06:15:00.000Z");
  });

  it("memorizarLecturas: las lecturas de catalogo se consultan UNA vez; el resto pasa directo", async () => {
    let lecturas = 0;
    let escrituras = 0;
    const repo = {
      async findBranchPolicy(id: string) {
        lecturas += 1;
        return { id };
      },
      async createCustomer() {
        escrituras += 1;
      },
    };
    const memo = memorizarLecturas(repo);
    await memo.findBranchPolicy("a");
    await memo.findBranchPolicy("a");
    await memo.findBranchPolicy("b");
    await memo.createCustomer();
    await memo.createCustomer();
    expect(lecturas).toBe(2);
    expect(escrituras).toBe(2);
  });
});
