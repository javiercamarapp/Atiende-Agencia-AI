// Decision del negocio: ULTIMO PEDIDO = 30 minutos antes del cierre en todas las sucursales (configurable por turno con `ultimoPedidoMin`, sin migracion:
// vive en el jsonb `branch_policy.horario`). El servidor deja de aceptar (cotizar, crear, pedido programado y hora de recogida) aunque el local siga abierto;
// los pedidos ya creados no se tocan. WhatsApp y voz usan las mismas reglas del servidor y la herramienta `consultar_sucursal`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { evaluarUltimoPedido, estaAbiertoAhora, margenUltimoPedido, validarHorario, ULTIMO_PEDIDO_MIN_POR_OMISION, type HorarioSucursal } from "../src/horarios.ts";
import { changeOrderStatus } from "../src/order-lifecycle.ts";
import { createOrder, quoteOrder } from "../src/orders.ts";
import { aplicarReglasDeSucursal } from "../src/reglas-pedido.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const ZONA = "America/Merida"; // UTC-6 todo el año
const T3: HorarioSucursal = [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "18:00", cierra: "00:00" }];
const T7: HorarioSucursal = [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }];
const T4: HorarioSucursal = [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "21:00" }];
afterEach(() => vi.useRealTimers());

/** Instante UTC a partir de fecha y hora LOCAL de Merida (UTC-6). */
const merida = (fecha: string, hhmm: string) => new Date(`${fecha}T${hhmm}:00-06:00`);

function ultimo(horario: HorarioSucursal, instante: Date, ayer: HorarioSucursal = horario) {
  const estado = estaAbiertoAhora(horario, instante, ZONA, ayer);
  return { estado, u: evaluarUltimoPedido(estado, [...horario, ...ayer], instante, ZONA) };
}

describe("bordes del ultimo pedido (30 min antes del cierre)", () => {
  it("T3 cierra 00:00: 23:29 si, 23:30 no (el local sigue abierto), 00:00 cerrada", () => {
    expect(ultimo(T3, merida("2026-10-20", "23:29")).u).toMatchObject({ aceptaPedidos: true, minutosParaCierre: 31, ultimoPedidoA: "23:30" });
    const en2330 = ultimo(T3, merida("2026-10-20", "23:30"));
    expect(en2330.estado.abierto).toBe(true);
    expect(en2330.u).toMatchObject({ aceptaPedidos: false, minutosParaCierre: 30 });
    expect(ultimo(T3, merida("2026-10-21", "00:00")).estado.abierto).toBe(false);
  });

  it("T7 cierra 01:00, domingo a lunes: 00:29 si, 00:30 no (cola del turno del domingo)", () => {
    // 2026-10-26 es lunes: el turno que sigue abierto es el del domingo 25.
    expect(ultimo(T7, merida("2026-10-26", "00:29")).u).toMatchObject({ aceptaPedidos: true, minutosParaCierre: 31, ultimoPedidoA: "00:30" });
    expect(ultimo(T7, merida("2026-10-26", "00:30")).u).toMatchObject({ aceptaPedidos: false, minutosParaCierre: 30 });
    // Mismo turno, antes de medianoche: 23:59 faltan 61 minutos.
    expect(ultimo(T7, merida("2026-10-25", "23:59")).u).toMatchObject({ aceptaPedidos: true, minutosParaCierre: 61 });
  });

  it("T4 cierra 21:00: 20:29 si, 20:30 no", () => {
    expect(ultimo(T4, merida("2026-10-20", "20:29")).u).toMatchObject({ aceptaPedidos: true, ultimoPedidoA: "20:30" });
    expect(ultimo(T4, merida("2026-10-20", "20:30")).u).toMatchObject({ aceptaPedidos: false });
  });

  it("cerrada: no acepta, sin hora de ultimo pedido", () => {
    expect(ultimo(T4, merida("2026-10-20", "09:00")).u).toEqual({ margenMin: 30, minutosParaCierre: null, aceptaPedidos: false, ultimoPedidoA: null });
  });

  it("configurable por turno: ultimoPedidoMin 0 acepta hasta el cierre; 60 deja de aceptar una hora antes; sin valor rige 30", () => {
    const sin = validarHorario([{ dias: [2], abre: "12:00", cierra: "21:00" }]);
    expect(margenUltimoPedido(sin, "21:00")).toBe(ULTIMO_PEDIDO_MIN_POR_OMISION);
    const cero = validarHorario([{ dias: [2], abre: "12:00", cierra: "21:00", ultimoPedidoMin: 0 }]);
    expect(ultimo(cero, merida("2026-10-20", "20:59")).u).toMatchObject({ aceptaPedidos: true, margenMin: 0 });
    const sesenta = validarHorario([{ dias: [2], abre: "12:00", cierra: "21:00", ultimoPedidoMin: 60 }]);
    expect(ultimo(sesenta, merida("2026-10-20", "19:59")).u.aceptaPedidos).toBe(true);
    expect(ultimo(sesenta, merida("2026-10-20", "20:00")).u.aceptaPedidos).toBe(false);
  });

  it("validarHorario conserva ultimoPedidoMin y rechaza valores invalidos", () => {
    expect(validarHorario([{ dias: [1], abre: "12:00", cierra: "21:00", ultimoPedidoMin: 45 }])[0]).toMatchObject({ ultimoPedidoMin: 45 });
    expect(validarHorario([{ dias: [1], abre: "12:00", cierra: "21:00" }])[0]).not.toHaveProperty("ultimoPedidoMin");
    for (const malo of [-1, 181, 10.5, "30"]) expect(() => validarHorario([{ dias: [1], abre: "12:00", cierra: "21:00", ultimoPedidoMin: malo }])).toThrow(/ultimoPedidoMin/);
  });
});

describe("el servidor deja de aceptar pedidos en los ultimos 30 minutos", () => {
  async function fixture(horario: HorarioSucursal) {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { horario });
    await f.repo.upsertBranchZonaHoraria(f.propertyId, ZONA);
    vi.useFakeTimers({ toFake: ["Date"] });
    return f;
  }
  const items = (f: Awaited<ReturnType<typeof fixture>>) => [{ productId: f.products.cocaCola, requestedQuantity: 2 }];
  const pedido = (f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) => ({
    organizationId: f.organizationId, branchSlug: "fco-montejo", customerName: "Marcela Pech", customerPhone: "9991234567", customerAddress: "Calle 7 #210, Vista Alegre",
    items: items(f), source: "whatsapp" as const, paymentMethod: "efectivo" as const, ...extra,
  });

  it("cotizar y crear: T3 a las 23:29 pasa; a las 23:30 se rechaza diciendo que ya no se toman pedidos para hoy y ofreciendo programar o pedir mañana", async () => {
    const f = await fixture(T3);
    vi.setSystemTime(merida("2026-10-20", "23:29"));
    await expect(quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", items: items(f) })).resolves.toMatchObject({ abiertoAhora: true, cierraA: "00:00" });
    vi.setSystemTime(merida("2026-10-20", "23:30"));
    const error = (await quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", items: items(f) }).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/ya no toma pedidos para hoy por el cierre próximo/);
    expect(error.message).toMatch(/30 minutos antes del cierre \(hasta las 23:30\)/);
    expect(error.message).toMatch(/programar el pedido para la siguiente apertura o pedirlo mañana/);
    await expect(createOrder(f.repo, pedido(f))).rejects.toThrow(/ya no toma pedidos/);
  });

  it("T7 domingo a lunes: 00:29 pasa; 00:30 se rechaza; T4 20:29 pasa y 20:30 se rechaza", async () => {
    const f7 = await fixture(T7);
    vi.setSystemTime(merida("2026-10-26", "00:29"));
    await expect(createOrder(f7.repo, pedido(f7))).resolves.toBeTruthy();
    vi.setSystemTime(merida("2026-10-26", "00:30"));
    await expect(createOrder(f7.repo, pedido(f7))).rejects.toThrow(/ya no toma pedidos/);
    vi.useRealTimers();
    const f4 = await fixture(T4);
    vi.setSystemTime(merida("2026-10-20", "20:29"));
    await expect(createOrder(f4.repo, pedido(f4))).resolves.toBeTruthy();
    vi.setSystemTime(merida("2026-10-20", "20:30"));
    await expect(createOrder(f4.repo, pedido(f4))).rejects.toThrow(/ya no toma pedidos/);
  });

  it("el panel del negocio (source admin) puede capturar un pedido hasta el cierre; el cierre real sigue rechazando", async () => {
    const f = await fixture(T3);
    vi.setSystemTime(merida("2026-10-20", "23:45"));
    await expect(createOrder(f.repo, pedido(f, { source: "admin", paymentMethod: undefined }))).resolves.toBeTruthy();
    await expect(createOrder(f.repo, pedido(f))).rejects.toThrow(/ya no toma pedidos/);
  });

  it("pedido programado: para las 23:29 pasa; para las 23:30 se rechaza por ultimo pedido (con la hora elegida); para las 00:00 sigue siendo 'no atiende a la hora elegida'", async () => {
    const f = await fixture(T3);
    vi.setSystemTime(merida("2026-10-20", "12:00"));
    await expect(createOrder(f.repo, pedido(f, { programadoPara: "2026-10-20T23:29:00-06:00" }))).resolves.toMatchObject({ status: "programado" });
    await expect(createOrder(f.repo, pedido(f, { programadoPara: "2026-10-20T23:30:00-06:00" }))).rejects.toThrow(/ya no toma pedidos para la hora elegida \(martes 20\/10 23:30\)/);
    await expect(createOrder(f.repo, pedido(f, { programadoPara: "2026-10-21T00:00:00-06:00" }))).rejects.toThrow(/no atiende a la hora elegida/);
  });

  it("hora de recogida: a las 22:00, recoger a las 23:20 pasa y a las 23:40 se rechaza por ultimo pedido", async () => {
    const f = await fixture(T3);
    vi.setSystemTime(merida("2026-10-20", "22:00"));
    await expect(quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", canal: "recoger", horaRecogida: "2026-10-20T23:20:00-06:00", items: items(f) })).resolves.toBeTruthy();
    await expect(quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", canal: "recoger", horaRecogida: "2026-10-20T23:40:00-06:00", items: items(f) })).rejects.toThrow(/ya no toma pedidos para la hora elegida/);
  });

  it("un pedido ya creado a las 23:20 sigue su curso a las 23:50 (el ultimo pedido no rompe pedidos en curso)", async () => {
    const f = await fixture(T3);
    vi.setSystemTime(merida("2026-10-20", "23:20"));
    const orden = await createOrder(f.repo, pedido(f));
    vi.setSystemTime(merida("2026-10-20", "23:50"));
    const avanzado = await changeOrderStatus(f.repo, f.organizationId, orden, "preparando", undefined, { avisarCliente: false });
    expect(avanzado.status).toBe("preparando");
  });

  it("la regla del ultimo pedido tambien llega a aplicarReglasDeSucursal con el reloj dado (`now`)", async () => {
    const f = await fixture(T3);
    const branch = (await f.repo.findBranch(f.organizationId, { slug: "fco-montejo" }))!;
    await expect(aplicarReglasDeSucursal(f.repo, { branch, canal: "recoger", subtotal: 100, now: merida("2026-10-20", "23:29") })).resolves.toMatchObject({ apertura: { abierto: true } });
    await expect(aplicarReglasDeSucursal(f.repo, { branch, canal: "recoger", subtotal: 100, now: merida("2026-10-20", "23:30") })).rejects.toThrow(/ya no toma pedidos/);
  });

  it("degradacion: sin horario (politica vacia o base sin migrar) nunca bloquea; un horario sin ultimoPedidoMin usa el default de 30", async () => {
    const f = buildRestaurantFixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(merida("2026-10-20", "23:50"));
    await expect(quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", items: items(f) as never })).resolves.toMatchObject({ abiertoAhora: null });
    f.repo.seedBranchPolicy(f.propertyId, { horario: validarHorario(T3) });
    await f.repo.upsertBranchZonaHoraria(f.propertyId, ZONA);
    await expect(quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", items: items(f) as never })).rejects.toThrow(/30 minutos antes del cierre/);
  });
});

describe("herramienta consultar_sucursal (WhatsApp y voz)", () => {
  it("expone acepta_pedidos, ultimo_pedido_a y el margen sin quitar los campos de siempre", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { horario: T3 });
    void f.repo.upsertBranchZonaHoraria(f.propertyId, ZONA);
    const ctx = { organizationId: f.organizationId, channel: "voz" as const, phone: "9991234567" };
    vi.setSystemTime(merida("2026-10-20", "23:29"));
    const antes = await invokeAgentTool(f.repo, ctx, "consultar_sucursal", { branch_slug: "fco-montejo" });
    expect(antes.result).toMatchObject({ abierto_ahora: true, cierra_a: "00:00", acepta_pedidos: true, ultimo_pedido_a: "23:30", margen_ultimo_pedido_min: 30 });
    vi.setSystemTime(merida("2026-10-20", "23:30"));
    const despues = await invokeAgentTool(f.repo, ctx, "consultar_sucursal", { branch_slug: "fco-montejo" });
    expect(despues.result).toMatchObject({ abierto_ahora: true, acepta_pedidos: false, ultimo_pedido_a: "23:30" });
  });
});
