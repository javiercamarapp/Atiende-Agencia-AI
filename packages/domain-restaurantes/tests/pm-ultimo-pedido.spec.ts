// Decision del negocio: ULTIMO PEDIDO = 30 minutos antes del cierre en todas las sucursales (configurable por turno con `ultimoPedidoMin`, sin migracion:
// vive en el jsonb `branch_policy.horario`). El servidor deja de aceptar (cotizar, crear, pedido programado y hora de recogida) aunque el local siga abierto;
// los pedidos ya creados no se tocan. WhatsApp y voz usan las mismas reglas del servidor y la herramienta `consultar_sucursal`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { evaluarUltimoPedido, leerHorarioPersistido, ultimoPedidoConExcepciones, validarHorario, ULTIMO_PEDIDO_MIN_POR_OMISION, type HorarioSucursal } from "../src/horarios.ts";
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
  const u = evaluarUltimoPedido(horario, instante, ZONA, ayer);
  return { estado: { abierto: u.abierto }, u };
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
    expect(ultimo(T4, merida("2026-10-20", "09:00")).u).toEqual({ abierto: false, margenMin: 30, minutosParaCierre: null, aceptaPedidos: false, ultimoPedidoA: null, cierraA: null });
  });

  it("configurable por turno: ultimoPedidoMin 0 acepta hasta el cierre; 60 deja de aceptar una hora antes; sin valor rige 30", () => {
    const sin = validarHorario([{ dias: [2], abre: "12:00", cierra: "21:00" }]);
    expect(ultimo(sin, merida("2026-10-20", "13:00")).u.margenMin).toBe(ULTIMO_PEDIDO_MIN_POR_OMISION);
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

describe("turnos contiguos, turnos cortos, horario corrupto y excepciones", () => {
  it("turnos que se tocan se fusionan: 10-14 y 14-22 a las 13:45 sigue aceptando; el ultimo pedido es 21:30", () => {
    const contiguo = validarHorario([{ dias: [2], abre: "10:00", cierra: "14:00" }, { dias: [2], abre: "14:00", cierra: "22:00" }]);
    expect(ultimo(contiguo, merida("2026-10-20", "13:45")).u).toMatchObject({ aceptaPedidos: true, cierraA: "22:00", ultimoPedidoA: "21:30" });
    expect(ultimo(contiguo, merida("2026-10-20", "21:30")).u.aceptaPedidos).toBe(false);
  });

  it("turnos que se tocan a medianoche (18:00-00:00 y 00:00-02:00 del dia siguiente) se fusionan", () => {
    const horario = validarHorario([{ dias: [2], abre: "18:00", cierra: "00:00" }, { dias: [3], abre: "00:00", cierra: "02:00" }]);
    expect(ultimo(horario, merida("2026-10-20", "23:45")).u).toMatchObject({ aceptaPedidos: true, cierraA: "02:00", ultimoPedidoA: "01:30" });
  });

  it("pausa real entre turnos: el ultimo pedido aplica al cierre de CADA turno (regla de 30 min antes del cierre)", () => {
    const partido = validarHorario([{ dias: [2], abre: "10:00", cierra: "14:00" }, { dias: [2], abre: "16:00", cierra: "22:00" }]);
    expect(ultimo(partido, merida("2026-10-20", "13:29")).u).toMatchObject({ aceptaPedidos: true, cierraA: "14:00" });
    expect(ultimo(partido, merida("2026-10-20", "13:30")).u).toMatchObject({ abierto: true, aceptaPedidos: false, ultimoPedidoA: "13:30" });
    expect(ultimo(partido, merida("2026-10-20", "16:00")).u.aceptaPedidos).toBe(true);
  });

  it("un turno mas corto que el margen no queda sin pedidos: margen efectivo = duracion - 1 y el ultimo pedido no es anterior a la apertura", () => {
    const corto = validarHorario([{ dias: [2], abre: "12:00", cierra: "12:20" }]);
    expect(ultimo(corto, merida("2026-10-20", "12:00")).u).toMatchObject({ aceptaPedidos: true, margenMin: 19, ultimoPedidoA: "12:01" });
    expect(ultimo(corto, merida("2026-10-20", "12:01")).u.aceptaPedidos).toBe(false);
  });

  it("un ultimoPedidoMin corrupto en la base descarta SOLO el margen: dias, abre y cierra se conservan (no falla abierto 24 h)", () => {
    const leido = leerHorarioPersistido([{ dias: [0, 1, 2], abre: "12:00", cierra: "21:00", ultimoPedidoMin: 999 }, { dias: [3], abre: "18:00", cierra: "00:00", ultimoPedidoMin: 45 }]);
    expect(leido).toEqual([{ dias: [0, 1, 2], abre: "12:00", cierra: "21:00" }, { dias: [3], abre: "18:00", cierra: "00:00" }]);
    expect(leerHorarioPersistido([{ dias: [9], abre: "12:00", cierra: "21:00" }])).toBeNull();
  });

  it("excepciones por fecha: cada dia usa su horario; el margen de la excepcion no se mezcla con el semanal", () => {
    const semanal = validarHorario([{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "21:00", ultimoPedidoMin: 30 }]);
    const puente = { fechaDesde: "2026-10-20", fechaHasta: "2026-10-20", horario: validarHorario([{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "21:00", ultimoPedidoMin: 90 }]) };
    // El 20 rige la excepcion (90 min): 19:29 si y 19:30 no; el 21 rige el semanal (30 min): 20:29 si.
    expect(ultimoPedidoConExcepciones(semanal, [puente], merida("2026-10-20", "19:29"), ZONA)).toMatchObject({ aceptaPedidos: true, margenMin: 90 });
    expect(ultimoPedidoConExcepciones(semanal, [puente], merida("2026-10-20", "19:30"), ZONA)).toMatchObject({ aceptaPedidos: false, margenMin: 90 });
    expect(ultimoPedidoConExcepciones(semanal, [puente], merida("2026-10-21", "20:29"), ZONA)).toMatchObject({ aceptaPedidos: true, margenMin: 30 });
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

  it("carrera cotizar a confirmar: cotizo a las 23:29 y confirma a las 23:31, se rechaza al crear con el mensaje claro de la regla (nunca se crea un pedido fuera del ultimo pedido)", async () => {
    const f = await fixture(T3);
    vi.setSystemTime(merida("2026-10-20", "23:29"));
    await expect(quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", items: items(f) })).resolves.toBeTruthy();
    vi.setSystemTime(merida("2026-10-20", "23:31"));
    const error = (await createOrder(f.repo, pedido(f)).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/ya no toma pedidos para hoy por el cierre próximo: el último pedido se toma 30 minutos antes del cierre \(hasta las 23:30\)/);
    expect(error.message).toMatch(/programar el pedido para la siguiente apertura o pedirlo mañana/);
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
