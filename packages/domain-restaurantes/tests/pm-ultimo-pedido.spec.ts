// Decision del negocio: ULTIMO PEDIDO = 30 minutos antes del cierre en todas las sucursales (configurable por turno con `ultimoPedidoMin`, sin migracion:
// vive en el jsonb `branch_policy.horario`). El servidor deja de aceptar (cotizar, crear, pedido programado y hora de recogida) aunque el local siga abierto;
// los pedidos ya creados no se tocan. WhatsApp y voz usan las mismas reglas del servidor y la herramienta `consultar_sucursal`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { evaluarUltimoPedido, fraseUltimoPedido, horaHablada, horaLegible, leerHorarioPersistido, ultimoPedidoConExcepciones, validarHorario, ULTIMO_PEDIDO_MIN_POR_OMISION, type HorarioSucursal } from "../src/horarios.ts";
import { changeOrderStatus } from "../src/order-lifecycle.ts";
import { createOrder, quoteOrder } from "../src/orders.ts";
import { aplicarReglasDeSucursal } from "../src/reglas-pedido.ts";
import { estadoSucursalParaPrompt } from "../src/whatsapp/llm-turn-handler.ts";
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
    expect(ultimo(T4, merida("2026-10-20", "09:00")).u).toMatchObject({ abierto: false, margenMin: 30, minutosParaCierre: null, aceptaPedidos: false, ultimoPedidoA: null, cierraA: null, domicilio: { aceptaPedidos: false, ultimoPedidoA: null }, recoger: { aceptaPedidos: false, ultimoPedidoA: null } });
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


// ---------------------------------------------------------------------------
// Decision de Javier: ultimo pedido FIJO por sucursal y por tipo de pedido (domicilio vs recoger). Sustituye el margen de 30 min donde esta configurado.
// ---------------------------------------------------------------------------
const TODOS = [0, 1, 2, 3, 4, 5, 6];
// T1, T7, T8 (cierran 01:00): domicilio 23:15, recoger 00:30. T2, T3 (cierran 24:00): domicilio 22:15, recoger 23:30. T4 (sin domicilio): recoger 20:30.
const T7F = validarHorario([{ dias: TODOS, abre: "12:00", cierra: "01:00", ultimoPedidoDomicilio: "23:15", ultimoPedidoRecoger: "00:30" }]);
const T3F = validarHorario([{ dias: TODOS, abre: "18:00", cierra: "00:00", ultimoPedidoDomicilio: "22:15", ultimoPedidoRecoger: "23:30" }]);
const T4F = validarHorario([{ dias: TODOS, abre: "12:00", cierra: "21:00", ultimoPedidoRecoger: "20:30" }]);

function porTipo(horario: HorarioSucursal, fecha: string, hhmm: string) {
  const u = evaluarUltimoPedido(horario, merida(fecha, hhmm), ZONA);
  return { d: u.domicilio.aceptaPedidos, r: u.recoger.aceptaPedidos, u };
}

describe("ultimo pedido fijo por sucursal y tipo: bordes", () => {
  it("T7 domicilio: 23:14 si, 23:15 no, 23:16 no (el local sigue abierto)", () => {
    expect(porTipo(T7F, "2026-10-20", "23:14").d).toBe(true);
    expect(porTipo(T7F, "2026-10-20", "23:15").d).toBe(false);
    expect(porTipo(T7F, "2026-10-20", "23:16").d).toBe(false);
    expect(porTipo(T7F, "2026-10-20", "23:16").u).toMatchObject({ abierto: true, domicilio: { configurado: true, ultimoPedidoA: "23:15" } });
  });

  it("T7 recoger (cruce de medianoche, 00:30 = madrugada del dia siguiente): 23:59 si, lunes 00:29 si, 00:30 no, 00:31 no", () => {
    expect(porTipo(T7F, "2026-10-25", "23:59").r).toBe(true);
    expect(porTipo(T7F, "2026-10-26", "00:29").r).toBe(true);
    expect(porTipo(T7F, "2026-10-26", "00:30").r).toBe(false);
    expect(porTipo(T7F, "2026-10-26", "00:31").r).toBe(false);
    expect(porTipo(T7F, "2026-10-26", "00:29").u.recoger).toMatchObject({ configurado: true, ultimoPedidoA: "00:30" });
    // En la madrugada el domicilio ya esta cerrado desde las 23:15.
    expect(porTipo(T7F, "2026-10-26", "00:29").d).toBe(false);
  });

  it("T3 (cierra 24:00): domicilio 22:14 si / 22:15 no / 22:16 no; recoger 23:29 si / 23:30 no / 23:31 no", () => {
    expect([porTipo(T3F, "2026-10-20", "22:14").d, porTipo(T3F, "2026-10-20", "22:15").d, porTipo(T3F, "2026-10-20", "22:16").d]).toEqual([true, false, false]);
    expect([porTipo(T3F, "2026-10-20", "23:29").r, porTipo(T3F, "2026-10-20", "23:30").r, porTipo(T3F, "2026-10-20", "23:31").r]).toEqual([true, false, false]);
    expect(porTipo(T3F, "2026-10-20", "23:31").u.abierto).toBe(true);
  });

  it("T4 (sin domicilio): recoger 20:29 si, 20:30 no, 20:31 no", () => {
    expect([porTipo(T4F, "2026-10-20", "20:29").r, porTipo(T4F, "2026-10-20", "20:30").r, porTipo(T4F, "2026-10-20", "20:31").r]).toEqual([true, false, false]);
    // Domicilio sin hora fija: cae al margen de 30 min (la politica de domicilio de la sucursal decide si se ofrece).
    expect(porTipo(T4F, "2026-10-20", "20:29").u.domicilio).toMatchObject({ configurado: false, aceptaPedidos: true, ultimoPedidoA: "20:30" });
  });

  it("sin hora fija el tipo sigue el margen de 30 min (T7 sin campos: 00:29 si, 00:30 no, para los dos tipos)", () => {
    const u = porTipo(T7, "2026-10-26", "00:30");
    expect(u).toMatchObject({ d: false, r: false });
    expect(porTipo(T7, "2026-10-26", "00:29")).toMatchObject({ d: true, r: true });
  });

  it("un turno con hora fija solo para recoger deja el domicilio con el margen (campos independientes)", () => {
    const solo = validarHorario([{ dias: TODOS, abre: "12:00", cierra: "01:00", ultimoPedidoRecoger: "00:30" }]);
    expect(porTipo(solo, "2026-10-20", "23:45").u).toMatchObject({ domicilio: { configurado: false, aceptaPedidos: true }, recoger: { configurado: true, aceptaPedidos: true } });
  });

  it("por dia de semana: la hora fija vive en el turno, asi que dos turnos con dias distintos pueden tener horas distintas", () => {
    const semana = validarHorario([
      { dias: [1, 2, 3, 4], abre: "12:00", cierra: "00:00", ultimoPedidoDomicilio: "22:15" },
      { dias: [5, 6], abre: "12:00", cierra: "01:00", ultimoPedidoDomicilio: "23:15" },
    ]);
    expect(porTipo(semana, "2026-10-20", "22:30").d).toBe(false); // martes
    expect(porTipo(semana, "2026-10-23", "22:30").d).toBe(true); // viernes
  });

  it("turnos contiguos: manda la hora fija del turno que fija el cierre", () => {
    const h = validarHorario([{ dias: TODOS, abre: "12:00", cierra: "16:00", ultimoPedidoRecoger: "15:30" }, { dias: TODOS, abre: "16:00", cierra: "22:00", ultimoPedidoRecoger: "21:30" }]);
    expect(porTipo(h, "2026-10-20", "15:45").r).toBe(true);
    expect(porTipo(h, "2026-10-20", "21:29").r).toBe(true);
    expect(porTipo(h, "2026-10-20", "21:30").r).toBe(false);
  });
});

describe("validacion y lectura de las horas fijas", () => {
  it("validarHorario las conserva y rechaza formato invalido, antes de la apertura o despues del cierre", () => {
    expect(validarHorario([{ dias: [1], abre: "12:00", cierra: "01:00", ultimoPedidoDomicilio: "23:15", ultimoPedidoRecoger: "00:30" }])[0]).toMatchObject({ ultimoPedidoDomicilio: "23:15", ultimoPedidoRecoger: "00:30" });
    expect(validarHorario([{ dias: [1], abre: "12:00", cierra: "01:00" }])[0]).not.toHaveProperty("ultimoPedidoRecoger");
    for (const malo of ["24:00", "9:30", 2330, "11:59", "01:01"]) {
      expect(() => validarHorario([{ dias: [1], abre: "12:00", cierra: "01:00", ultimoPedidoRecoger: malo }])).toThrow(/ultimoPedidoRecoger/);
    }
    expect(() => validarHorario([{ dias: [1], abre: "18:00", cierra: "00:00", ultimoPedidoDomicilio: "17:00" }])).toThrow(/ultimoPedidoDomicilio/);
    expect(validarHorario([{ dias: [1], abre: "18:00", cierra: "00:00", ultimoPedidoRecoger: "00:00" }])[0]).toMatchObject({ ultimoPedidoRecoger: "00:00" });
  });

  it("un valor corrupto en la base descarta SOLO esos campos: el horario no falla abierto", () => {
    const leido = leerHorarioPersistido([{ dias: [0, 1], abre: "12:00", cierra: "01:00", ultimoPedidoDomicilio: "99:99", ultimoPedidoRecoger: "00:30" }]);
    expect(leido).toEqual([{ dias: [0, 1], abre: "12:00", cierra: "01:00" }]);
  });
});

describe("frases y herramienta: las mismas en WhatsApp y voz", () => {
  it("fraseUltimoPedido: cierre y ultimo pedido de cada tipo; sin hora fija es null; T4 no menciona domicilio", () => {
    expect(fraseUltimoPedido(porTipo(T7F, "2026-10-20", "20:00").u)).toBe("Cerramos a las 01:00. El último pedido a domicilio a las 23:15 y para recoger a las 00:30.");
    expect(fraseUltimoPedido(porTipo(T7F, "2026-10-20", "20:00").u, horaHablada)).toBe("Cerramos a las una de la mañana. El último pedido a domicilio a las once y cuarto de la noche y para recoger a las doce y media de la noche.");
    expect(fraseUltimoPedido(porTipo(T7, "2026-10-20", "20:00").u)).toBeNull();
    expect(fraseUltimoPedido(porTipo(T4F, "2026-10-20", "19:00").u, horaLegible, { domicilioDisponible: false })).toBe("Cerramos a las 21:00. El último pedido para recoger a las 20:30.");
  });

  async function consulta(horario: HorarioSucursal, instante: Date, channel: "voz" | "whatsapp") {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { horario });
    await f.repo.upsertBranchZonaHoraria(f.propertyId, ZONA);
    vi.setSystemTime(instante);
    return (await invokeAgentTool(f.repo, { organizationId: f.organizationId, channel, phone: "9991234567" }, "consultar_sucursal", { branch_slug: "fco-montejo" })).result;
  }

  it("consultar_sucursal expone acepta_pedidos / ultimo_pedido_a por tipo (T7 a las 23:20: domicilio no, recoger si)", async () => {
    const r = await consulta(T7F, merida("2026-10-20", "23:20"), "whatsapp");
    expect(r).toMatchObject({
      abierto_ahora: true, cierra_a: "01:00", acepta_pedidos: true, ultimo_pedido_a: "00:30",
      acepta_pedidos_domicilio: false, ultimo_pedido_domicilio_a: "23:15", acepta_pedidos_recoger: true, ultimo_pedido_recoger_a: "00:30",
      ultimo_pedido_domicilio_a_texto: "23:15", ultimo_pedido_recoger_a_texto: "00:30", ultimo_pedido_por_tipo_configurado: true,
      ultimo_pedido_frase: "Cerramos a las 01:00. El último pedido a domicilio a las 23:15 y para recoger a las 00:30.",
    });
    expect(r).not.toHaveProperty("ultimo_pedido_recoger_a_hablada");
  });

  it("en voz trae las mismas frases con las horas dichas con palabras", async () => {
    const r = await consulta(T7F, merida("2026-10-20", "23:20"), "voz");
    expect(r).toMatchObject({
      ultimo_pedido_domicilio_a_hablada: "once y cuarto de la noche", ultimo_pedido_recoger_a_hablada: "doce y media de la noche",
      ultimo_pedido_frase_hablada: "Cerramos a las una de la mañana. El último pedido a domicilio a las once y cuarto de la noche y para recoger a las doce y media de la noche.",
    });
  });

  it("sin horas fijas todo queda como antes (margen de 30 min) y la frase es null", async () => {
    const r = await consulta(T3, merida("2026-10-20", "23:29"), "whatsapp");
    expect(r).toMatchObject({ acepta_pedidos: true, ultimo_pedido_a: "23:30", ultimo_pedido_por_tipo_configurado: false, ultimo_pedido_frase: null, acepta_pedidos_domicilio: true, acepta_pedidos_recoger: true });
  });
});

describe("el servidor aplica la hora fija por tipo de pedido", () => {
  async function fixture(horario: HorarioSucursal) {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { horario });
    await f.repo.upsertBranchZonaHoraria(f.propertyId, ZONA);
    vi.useFakeTimers({ toFake: ["Date"] });
    return f;
  }
  const cot = (f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) =>
    quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }], ...extra } as never);

  it("T7 domicilio a las 23:14 pasa; a las 23:15 y 23:16 se rechaza ofreciendo recoger (aun se toma hasta las 00:30) o programar para el dia siguiente", async () => {
    const f = await fixture(T7F);
    vi.setSystemTime(merida("2026-10-20", "23:14"));
    await expect(cot(f)).resolves.toMatchObject({ abiertoAhora: true });
    for (const hora of ["23:15", "23:16"]) {
      vi.setSystemTime(merida("2026-10-20", hora));
      const e = (await cot(f).catch((x: unknown) => x)) as Error;
      expect(e.message).toMatch(/ya no toma pedidos a domicilio para hoy: el último pedido a domicilio es a las 23:15 \(la sucursal cierra a las 01:00\)/);
      expect(e.message).toMatch(/Ofrezca recoger en la sucursal \(el último pedido para recoger es a las 00:30\) o programar el pedido para el día siguiente/);
    }
  });

  it("T7 recoger: 23:16 pasa (el recoger sigue abierto), lunes 00:29 pasa y 00:31 se rechaza con la hora y la alternativa", async () => {
    const f = await fixture(T7F);
    vi.setSystemTime(merida("2026-10-20", "23:16"));
    await expect(cot(f, { canal: "recoger" })).resolves.toBeTruthy();
    vi.setSystemTime(merida("2026-10-26", "00:29"));
    await expect(cot(f, { canal: "recoger" })).resolves.toBeTruthy();
    vi.setSystemTime(merida("2026-10-26", "00:31"));
    const e = (await cot(f, { canal: "recoger" }).catch((x: unknown) => x)) as Error;
    expect(e.message).toMatch(/ya no toma pedidos para recoger para hoy: el último pedido para recoger es a las 00:30/);
    expect(e.message).toMatch(/programar el pedido para la siguiente apertura o pedirlo mañana/);
  });

  it("crear el pedido: T7 domicilio 23:15 rechazado; recoger 23:15 creado", async () => {
    const f = await fixture(T7F);
    const base = { organizationId: f.organizationId, branchSlug: "fco-montejo", customerName: "Marcela Pech", customerPhone: "9991234567", customerAddress: "Calle 7 #210, Vista Alegre", items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }], source: "whatsapp" as const, paymentMethod: "efectivo" as const };
    vi.setSystemTime(merida("2026-10-20", "23:15"));
    await expect(createOrder(f.repo, base)).rejects.toThrow(/ya no toma pedidos a domicilio/);
    await expect(createOrder(f.repo, { ...base, canal: "recoger" })).resolves.toBeTruthy();
  });

  it("T3: domicilio 22:14 si / 22:16 no; recoger 23:29 si / 23:31 no", async () => {
    const f = await fixture(T3F);
    vi.setSystemTime(merida("2026-10-20", "22:14"));
    await expect(cot(f)).resolves.toBeTruthy();
    vi.setSystemTime(merida("2026-10-20", "22:16"));
    await expect(cot(f)).rejects.toThrow(/último pedido a domicilio es a las 22:15/);
    await expect(cot(f, { canal: "recoger" })).resolves.toBeTruthy();
    vi.setSystemTime(merida("2026-10-20", "23:29"));
    await expect(cot(f, { canal: "recoger" })).resolves.toBeTruthy();
    vi.setSystemTime(merida("2026-10-20", "23:31"));
    const e = (await cot(f, { canal: "recoger" }).catch((x: unknown) => x)) as Error;
    expect(e.message).toMatch(/último pedido para recoger es a las 23:30 \(la sucursal cierra a las 12:00 a\. m\. \(medianoche\)\)/);
    // A domicilio pasada la hora de recoger tambien: ninguna alternativa de recoger, solo programar.
    expect(((await cot(f).catch((x: unknown) => x)) as Error).message).toMatch(/Ofrezca programar el pedido para la siguiente apertura/);
  });

  it("T4: recoger 20:29 si / 20:31 no", async () => {
    const f = await fixture(T4F);
    vi.setSystemTime(merida("2026-10-20", "20:29"));
    await expect(cot(f, { canal: "recoger" })).resolves.toBeTruthy();
    vi.setSystemTime(merida("2026-10-20", "20:31"));
    await expect(cot(f, { canal: "recoger" })).rejects.toThrow(/último pedido para recoger es a las 20:30/);
  });

  it("voz: el mensaje dice las horas con palabras (misma frase que en WhatsApp)", async () => {
    const f = await fixture(T7F);
    vi.setSystemTime(merida("2026-10-20", "23:20"));
    const e = (await createOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", customerName: "Marcela Pech", customerPhone: "9991234567", customerAddress: "Calle 7 #210, Vista Alegre", items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }], source: "voice", paymentMethod: "efectivo" }).catch((x: unknown) => x)) as Error;
    expect(e.message).toMatch(/el último pedido a domicilio es a las once y cuarto de la noche \(la sucursal cierra a las una de la mañana\)/);
    expect(e.message).toMatch(/el último pedido para recoger es a las doce y media de la noche/);
  });

  it("hora de recogida: se pide a las 22:00 para las 00:50 (posterior al ultimo pedido 00:30, <= cierre 01:00) y se acepta; el cierre exacto tambien", async () => {
    const f = await fixture(T7F);
    vi.setSystemTime(merida("2026-10-20", "22:00"));
    await expect(cot(f, { canal: "recoger", horaRecogida: "2026-10-21T00:50:00-06:00" })).resolves.toBeTruthy();
    await expect(cot(f, { canal: "recoger", horaRecogida: "2026-10-21T01:00:00-06:00" })).resolves.toBeTruthy();
  });

  it("hora de recogida despues del cierre (22:00 para 01:20): se rechaza con el motivo y se ofrece una hora anterior o programar", async () => {
    const f = await fixture(T7F);
    vi.setSystemTime(merida("2026-10-20", "22:00"));
    const e = (await cot(f, { canal: "recoger", horaRecogida: "2026-10-21T01:20:00-06:00" }).catch((x: unknown) => x)) as Error;
    expect(e.message).toMatch(/no puede entregar la recogida a la hora elegida \(miércoles 21\/10 01:20\) porque es después del cierre/);
    expect(e.message).toMatch(/Hoy cierra a las 01:00/);
    expect(e.message).toMatch(/hora anterior al cierre o programar el pedido para la siguiente apertura/);
  });

  it("hora de recogida pedida DESPUES del ultimo pedido de recoger (00:40 para las 00:55): se rechaza por el momento de pedir, no por la hora de recogida", async () => {
    const f = await fixture(T7F);
    vi.setSystemTime(merida("2026-10-21", "00:40"));
    await expect(cot(f, { canal: "recoger", horaRecogida: "2026-10-21T00:55:00-06:00" })).rejects.toThrow(/último pedido para recoger es a las 00:30/);
  });

  it("sin hora fija la recogida posterior al ultimo pedido (margen) se sigue rechazando como en #657", async () => {
    const f = await fixture(T3);
    vi.setSystemTime(merida("2026-10-20", "22:00"));
    await expect(cot(f, { canal: "recoger", horaRecogida: "2026-10-20T23:40:00-06:00" })).rejects.toThrow(/ya no toma pedidos para la hora elegida/);
  });

  it("pedido programado para recoger a las 00:45 (posterior al ultimo pedido, antes del cierre) se acepta; programado a domicilio para las 23:30 se rechaza", async () => {
    const f = await fixture(T7F);
    vi.setSystemTime(merida("2026-10-20", "12:00"));
    const base = { organizationId: f.organizationId, branchSlug: "fco-montejo", customerName: "Marcela Pech", customerPhone: "9991234567", customerAddress: "Calle 7 #210, Vista Alegre", items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }], source: "whatsapp" as const, paymentMethod: "efectivo" as const };
    await expect(createOrder(f.repo, { ...base, canal: "recoger", programadoPara: "2026-10-21T00:45:00-06:00" })).resolves.toMatchObject({ status: "programado" });
    await expect(createOrder(f.repo, { ...base, programadoPara: "2026-10-20T23:30:00-06:00" })).rejects.toThrow(/ya no toma pedidos a domicilio para la hora elegida/);
    await expect(createOrder(f.repo, { ...base, programadoPara: "2026-10-20T23:14:00-06:00" })).resolves.toMatchObject({ status: "programado" });
  });
});

describe("estado de la sucursal en el prompt de WhatsApp con hora fija por tipo", () => {
  async function prompt(horario: HorarioSucursal, instante: Date, extra: { aceptaDomicilio?: boolean } = {}) {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { horario, ...extra });
    await f.repo.upsertBranchZonaHoraria(f.propertyId, ZONA);
    const branch = (await f.repo.findBranch(f.organizationId, { slug: "fco-montejo" }))!;
    return estadoSucursalParaPrompt(f.repo, branch, instante);
  }

  it("antes del ultimo pedido de domicilio: cierre y ultimo pedido de cada tipo", async () => {
    const t = await prompt(T7F, merida("2026-10-20", "20:00"));
    expect(t).toMatch(/ABIERTA y cierra a las 01:00\. Cerramos a las 01:00\. El último pedido a domicilio a las 23:15 y para recoger a las 00:30\./);
    expect(t).toMatch(/un pedido para recoger hecho antes de su último pedido se acepta aunque la hora de recogida sea posterior/);
  });

  it("23:20: ya paso el domicilio, recoger sigue: ofrece recoger o programar", async () => {
    const t = await prompt(T7F, merida("2026-10-20", "23:20"));
    expect(t).toMatch(/YA PASÓ el último pedido a domicilio: no tome domicilio ahora; ofrezca recoger en la sucursal \(todavía se toma\) o programar para el día siguiente/);
  });

  it("00:31: ya pasaron los dos; abierta pero sin pedidos para hoy", async () => {
    const t = await prompt(T7F, merida("2026-10-26", "00:31"));
    expect(t).toMatch(/sigue ABIERTA \(cierra a las 01:00\), pero YA PASARON LOS ÚLTIMOS PEDIDOS/);
  });

  it("sin hora fija el texto de #657 queda igual", async () => {
    expect(await prompt(T7, merida("2026-10-20", "20:00"))).toMatch(/el último pedido se toma hasta las 00:30/);
  });
});

describe("dia de NEGOCIO para domicilioDisponible (madrugada 00:00-01:00 con diasDomicilio restringido)", () => {
  // 2026-10-27 es martes: a las 00:20 el turno que sigue abierto es el del LUNES (cierra 01:00); 2026-10-26 es lunes y su madrugada pertenece al DOMINGO.
  async function conDias(instante: Date, diasDomicilio: number[]) {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { horario: T7F, aceptaDomicilio: true, diasDomicilio });
    await f.repo.upsertBranchZonaHoraria(f.propertyId, ZONA);
    vi.setSystemTime(instante);
    const herramienta = (await invokeAgentTool(f.repo, { organizationId: f.organizationId, channel: "whatsapp", phone: "9991234567" }, "consultar_sucursal", { branch_slug: "fco-montejo" })).result;
    const branch = (await f.repo.findBranch(f.organizationId, { slug: "fco-montejo" }))!;
    return { herramienta, prompt: await estadoSucursalParaPrompt(f.repo, branch, instante) };
  }

  it("00:20 del martes con domicilio solo los lunes: el turno es del lunes, el domicilio SI se menciona (consultar_sucursal y prompt)", async () => {
    const r = await conDias(merida("2026-10-27", "00:20"), [1]);
    expect(r.herramienta).toMatchObject({ ultimo_pedido_domicilio_a: "23:15", ultimo_pedido_domicilio_a_texto: "23:15" });
    expect((r.herramienta as { ultimo_pedido_frase: string }).ultimo_pedido_frase).toContain("a domicilio a las 23:15");
    expect(r.prompt).toContain("a domicilio a las 23:15");
  });

  it("00:20 del lunes con domicilio solo los lunes: la madrugada es del domingo, el domicilio NO se menciona", async () => {
    const r = await conDias(merida("2026-10-26", "00:20"), [1]);
    expect(r.herramienta).toMatchObject({ ultimo_pedido_domicilio_a: null, ultimo_pedido_domicilio_a_texto: null });
    expect((r.herramienta as { ultimo_pedido_frase: string }).ultimo_pedido_frase).not.toContain("a domicilio");
    expect(r.prompt).not.toContain("a domicilio a las 23:15");
  });
});
