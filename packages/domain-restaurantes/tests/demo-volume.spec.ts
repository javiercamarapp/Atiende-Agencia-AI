// R-20 -- seed de volumen de la demo: los pedidos salen del motor REAL (prepareCreateOrder con el menu, precios, horario y promocion
// del seed de PM), con totales coherentes, reglas duras respetadas, sin PII real, deterministas e idempotentes.
// Postgres real: scripts/verify-restaurantes-demo-volumen/.
import { describe, expect, it } from "vitest";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import {
  DEMO_PERFIL_T7,
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
  it("genera volumen moderado solo en las sucursales activas (T1, T3 y T7) y NUNCA toca las inactivas (T2, T4, T5 y T8)", async () => {
    const { orders, summary } = await generar();
    expect(orders.length).toBeGreaterThan(300);
    expect(summary.orders).toBe(orders.length);
    expect(Object.keys(summary.porSucursal).sort()).toEqual(["garcia-lavin", "pensiones", "prol-montejo"]);
    for (const inactiva of ["fco-montejo", "galerias", "playa", "altabrisa"]) expect(orders.some((o) => o.branchSlug === inactiva)).toBe(false);
    // Proporcion ilustrativa: la sucursal grande vende mas que la mas chica.
    expect(summary.porSucursal["prol-montejo"]!).toBeGreaterThan(summary.porSucursal["pensiones"]!);
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
    // Los precios son los de la SUCURSAL del pedido en el menu sembrado (ningun precio inventado, ni el de otra sucursal).
    const branchId = new Map(plan.branches.map((b) => [b.slug, b.id]));
    const productoPorNombre = new Map(plan.products.map((p) => [p.name, p]));
    for (const o of orders) for (const i of o.items) if (productoPorNombre.has(i.name)) expect(i.price).toBe(productoPorNombre.get(i.name)!.branchPrices[branchId.get(o.branchSlug)!]);
    void world;
  });

  it("las promociones de PM las aplica el motor: 2x1 solo lunes con tacos al pastor y combo solo martes, ambas solo recoger", async () => {
    const { orders } = await generar({ dias: 56, pedidosPorDia: 30 });
    const conPromo = orders.filter((o) => descuento(o) > 0);
    expect(conPromo.length).toBeGreaterThan(0);
    const diaNegocio = (o: DemoOrderRow) =>
      // Dia de NEGOCIO: el turno cierra a la 1 am, asi que un pedido entre 00:00 y 01:00 es de la jornada anterior.
      new Intl.DateTimeFormat("en-US", { timeZone: "America/Merida", weekday: "long" }).format(new Date(new Date(o.createdAt).getTime() - 3_600_000));
    for (const o of conPromo) {
      expect(o.canal).toBe("recoger");
      // CR07/CR08: el dueño da el 2x1 para todas las sucursales (cuestionario l.99): vale en todas las sucursales con pedidos (T1, T3 y T7).
      expect(["pensiones", "prol-montejo", "garcia-lavin"]).toContain(o.branchSlug);
      const codigo = /Promoción aplicada: ([A-Z0-9_-]+)/.exec(o.notes)?.[1];
      if (codigo === "LUNES2X1PM") {
        expect(diaNegocio(o)).toBe("Monday");
        expect(o.items.some((i) => i.name === "Taco Al Pastor (individual)")).toBe(true);
      } else {
        expect(codigo).toBe("MARTESNACHOSPM");
        expect(diaNegocio(o)).toBe("Tuesday");
      }
    }
    // A domicilio nunca hay promocion (aunque sea lunes o martes).
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

// DEMO-PM: perfil `t7` = el ritmo REAL medido en el WhatsApp de T7 Garcia Lavin (muestra anonimizada, 8 semanas). Las cifras de aqui
// son las del analisis (139 pedidos, 70 clientes, 32 recurrentes = 101 pedidos = 73 %, ticket mediano ~$643, tiempos 50-90 / 10-45).
describe("perfil t7 (ritmo real de la sucursal fase 1)", () => {
  const horaLocal = (iso: string) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Merida", hour: "2-digit", hourCycle: "h23" }).format(new Date(iso)));
  const diaLocal = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Merida", weekday: "short" }).format(new Date(iso));
  const mediana = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;
  const p90 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * 0.9)]!;
  const minutos = (o: DemoOrderRow) => (Date.parse(o.deliveredAt!) - Date.parse(o.createdAt)) / 60_000;
  const t7 = (extra: Partial<DemoVolumeOptions> = {}) => generar({ dias: DEMO_PERFIL_T7.dias, perfil: "t7", pedidosPorDia: undefined, ...extra });

  it("reparte EXACTAMENTE lo medido: solo T7, 139 pedidos, 70 clientes, 32 recurrentes con 101 pedidos (73 %), uno de ellos con 11", async () => {
    const { orders, summary } = await t7();
    expect(summary.orders).toBe(139);
    expect(summary.customers).toBe(70);
    expect(summary.omitidos).toBe(0);
    expect(Object.keys(summary.porSucursal)).toEqual(["garcia-lavin"]);
    expect(orders.every((o) => o.branchSlug === "garcia-lavin")).toBe(true);
    const porCliente = new Map<string, number>();
    for (const o of orders) porCliente.set(o.customerPhone, (porCliente.get(o.customerPhone) ?? 0) + 1);
    const recurrentes = [...porCliente.values()].filter((n) => n >= 2);
    expect(porCliente.size).toBe(70);
    expect(recurrentes).toHaveLength(32);
    expect(recurrentes.reduce((a, b) => a + b, 0)).toBe(101);
    expect(Math.round((101 / 139) * 100)).toBe(73);
    expect(Math.max(...porCliente.values())).toBe(11);
  });

  it("todo entra por WhatsApp, ~79 % a domicilio, pago casi mitad y mitad; los pedidos pasan por el motor real (totales = renglones - descuento, minimo $200 a domicilio)", async () => {
    const { orders } = await t7();
    expect(orders.every((o) => o.source === "whatsapp")).toBe(true);
    const dom = orders.filter((o) => o.canal === "domicilio").length / orders.length;
    expect(dom).toBeGreaterThan(0.7);
    expect(dom).toBeLessThan(0.88);
    const tarjeta = orders.filter((o) => o.paymentMethod === "tarjeta").length / orders.length;
    expect(tarjeta).toBeGreaterThan(0.35);
    expect(tarjeta).toBeLessThan(0.58);
    for (const o of orders) {
      expect(o.total, `pedido ${o.idempotencyKey.slice(0, 8)}`).toBeCloseTo(subtotal(o) - descuento(o), 2);
      if (o.canal === "domicilio") expect(subtotal(o)).toBeGreaterThanOrEqual(200);
      if (o.propina !== null) expect(o.paymentMethod).toBe("tarjeta");
      expect(esTelefonoDemo(o.customerPhone)).toBe(true);
    }
  });

  it("los tickets se parecen a los reales: mediana ~$640, p90 ~$1,500, un 10 % sobre $1,500 y fracciones de kilo, extras de salsa y bebidas en el menu de T7", async () => {
    const { orders } = await t7();
    const totales = orders.map((o) => o.total);
    expect(mediana(totales)).toBeGreaterThan(520);
    expect(mediana(totales)).toBeLessThan(780);
    expect(p90(totales)).toBeGreaterThan(1200);
    expect(p90(totales)).toBeLessThan(1800);
    const grandes = totales.filter((t) => t > 1500).length;
    expect(grandes).toBeGreaterThanOrEqual(7);
    expect(grandes).toBeLessThanOrEqual(22);
    expect(Math.max(...totales)).toBeLessThan(4500);
    const nombres = new Set(orders.flatMap((o) => o.items.map((i) => i.name)));
    expect([...nombres].some((n) => /^Bistec de Res — 250 g$/.test(n))).toBe(true);
    expect([...nombres].some((n) => /^Pastor — 500 g$/.test(n))).toBe(true);
    expect(nombres.has("Frijol con Tostada")).toBe(true);
    expect(nombres.has("Extra Salsa")).toBe(true);
  });

  it("tiempos reales: a domicilio de 50 a 90 min (mediana ~65), para recoger de 10 a 50 min", async () => {
    const { orders } = await t7();
    const dom = orders.filter((o) => o.canal === "domicilio" && o.status === "completado").map(minutos);
    const rec = orders.filter((o) => o.canal === "recoger" && o.status === "completado").map(minutos);
    expect(Math.min(...dom)).toBeGreaterThanOrEqual(50);
    expect(Math.max(...dom)).toBeLessThanOrEqual(90);
    expect(mediana(dom)).toBeGreaterThanOrEqual(60);
    expect(mediana(dom)).toBeLessThanOrEqual(70);
    expect(Math.min(...rec)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...rec)).toBeLessThanOrEqual(50);
  });

  it("picos y dias de la sucursal: 12-16 h y 19-22 h concentran el volumen y el fin de semana pesa mas; ~6 % con problema", async () => {
    const { orders } = await t7();
    const enPico = orders.filter((o) => {
      const h = horaLocal(o.createdAt);
      return (h >= 12 && h < 16) || (h >= 19 && h < 22);
    }).length;
    expect(enPico / orders.length).toBeGreaterThan(0.55);
    const finde = orders.filter((o) => ["Sat", "Sun"].includes(diaLocal(o.createdAt))).length;
    expect(finde / orders.length).toBeGreaterThan(0.35);
    const problemas = orders.filter((o) => o.status === "problema" || o.status === "no_recogido").length;
    expect(problemas).toBeGreaterThanOrEqual(3);
    expect(problemas).toBeLessThanOrEqual(16);
    // Nunca fuera del horario de servicio (12:00 a 01:00).
    for (const o of orders) expect([...Array(12).keys()].slice(1).includes(horaLocal(o.createdAt))).toBe(false);
  });

  it("las conversaciones prometen los tiempos reales de T7 (no los 40 a 50 min genericos) y hay quejas con handoff pendiente", async () => {
    const { conversations, handoffs } = await t7();
    const textos = conversations.flatMap((c) => c.messages.map((m) => m.content)).join("\n");
    expect(textos).toContain("60 a 75 minutos");
    expect(textos).not.toContain("40 a 50");
    expect(handoffs.some((h) => h.estado === "pendiente")).toBe(true);
  });

  it("es determinista, sin PII real y escala por dias (28 dias = la mitad de pedidos)", async () => {
    const a = await t7();
    const b = await t7();
    expect(a.orders.map((o) => o.idempotencyKey)).toEqual(b.orders.map((o) => o.idempotencyKey));
    expect(a.orders.map((o) => o.createdAt)).toEqual(b.orders.map((o) => o.createdAt));
    for (const o of a.orders) expect(o.notes).not.toMatch(/@|https?:/);
    for (const c of a.customers) expect(c.phone).toMatch(/^0001[0-9]{6}$/);
    const mitad = await t7({ dias: 28 });
    expect(mitad.summary.orders).toBe(70);
    // Su clave de idempotencia es propia del perfil: no choca con la del volumen generico.
    expect(a.orders[0]!.idempotencyKey).not.toBe((await generar()).orders[0]!.idempotencyKey);
  });

  it("sin la sucursal T7 ACTIVA el perfil falla con un error claro (nunca escribe en otra sucursal)", async () => {
    const sinT7 = { ...plan, branches: plan.branches.map((b) => (b.slug === "garcia-lavin" ? { ...b, status: "inactive" as const } : b)) };
    const world = await buildInMemoryPmWorld(sinT7, { organizationId: ORG_ID });
    const gen = generarVolumenDemo(world.repo, { organizationId: world.organizationId, dias: 56, perfil: "t7", ahora: AHORA });
    await expect(gen.next()).rejects.toThrow(/garcia-lavin.*ACTIVA/);
  });
});

describe("sucursal predeterminada del chat de la demo", () => {
  it("es la misma que el perfil t7 y solo se ofrece si esta entre las activas", async () => {
    const { DEMO_SUCURSAL_PREDETERMINADA, sucursalPredeterminadaDemo } = await import("../src/demo/types.ts");
    expect(DEMO_SUCURSAL_PREDETERMINADA).toBe(DEMO_PERFIL_T7.sucursal);
    expect(sucursalPredeterminadaDemo([{ slug: "prol-montejo" }, { slug: "garcia-lavin" }])).toBe("garcia-lavin");
    expect(sucursalPredeterminadaDemo([{ slug: "prol-montejo" }])).toBeNull();
    expect(sucursalPredeterminadaDemo([])).toBeNull();
  });
});
