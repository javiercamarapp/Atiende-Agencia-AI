// QA-PM-R9 P3, revision de #563: cotizar TEMPRANO (paso 5b: sin pago ni nombre) no puede quitarle al servidor el candado contra pedidos sin resumen mostrado, y una
// cotizacion temprana no cuenta como "ya mostrada" (ni en el bloque del prompt ni en el siguiente_paso de la re-cotizacion). Deterministas, sin LLM.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { bloqueCotizacionVigente, resetOrderFlowWarningForTests, resumenMostradoEnHistorial } from "../src/agent-tools/order-flow.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const MARTES_13 = new Date("2026-10-06T13:00:00-06:00");
beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MARTES_13);
});
afterEach(() => vi.useRealTimers());

function setup(historial?: () => { role: "user" | "assistant"; content: string }[]) {
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  let turn = 1;
  const ctx = () => ({
    organizationId: f.organizationId,
    channel: "whatsapp" as const,
    phone: "9991234567",
    flow: { key: "k:whatsapp", turn: String(turn), now: () => Date.now() },
    ...(historial ? { conversacionReciente: historial() } : {}),
  });
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
  const base = { branch_slug: "fco-montejo", items, canal: "recoger" };
  const quote = (extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { ...base, ...extra });
  const confirm = () => invokeAgentTool(f.repo, ctx(), "confirmar_resumen", {});
  const create = (extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), "crear_pedido", { ...base, customer_name: "Nora", payment_method: "efectivo", ...extra });
  const snap = () => f.repo.readOrderFlow(f.organizationId, "k:whatsapp");
  return { f, quote, confirm, create, snap, nextTurn: () => void (turn += 1) };
}

describe("cotizar sin pago y re-cotizar CON pago exige un turno posterior para confirmar (hallazgo bloqueante de #563)", () => {
  it("reproduccion del revisor: turno 1 sin pago, turno 2 con pago + confirmar -> confirmacion_mismo_turno (no se crea pedido sin resumen)", async () => {
    const s = setup();
    await s.quote(); // cotizacion temprana, sin pago
    s.nextTurn();
    await s.quote({ payment_method: "efectivo", efectivo_con: 500 }); // el cliente dio el pago; el modelo re-cotiza en el turno del "confirmo"
    await expect(s.confirm()).rejects.toMatchObject({ code: "confirmacion_mismo_turno" });
    await expect(s.create({ efectivo_con: 500 })).rejects.toMatchObject({ code: "sin_confirmacion" });
  });
  it("cambiar el efectivo_con o el metodo de pago tambien es cotizacion nueva", async () => {
    const s = setup();
    await s.quote({ payment_method: "efectivo", efectivo_con: 200 });
    s.nextTurn();
    await s.quote({ payment_method: "efectivo", efectivo_con: 500 });
    await expect(s.confirm()).rejects.toMatchObject({ code: "confirmacion_mismo_turno" });
    s.nextTurn();
    await s.quote({ payment_method: "tarjeta" });
    await expect(s.confirm()).rejects.toMatchObject({ code: "confirmacion_mismo_turno" });
  });
  it("tras mostrar el resumen con el pago, el turno siguiente cierra: confirma y crea UN pedido", async () => {
    const s = setup();
    await s.quote();
    s.nextTurn();
    await s.quote({ payment_method: "efectivo", efectivo_con: 500 }); // se muestra el resumen
    s.nextTurn();
    const requote = await s.quote({ payment_method: "efectivo", efectivo_con: 500 }); // turno del "si"
    expect(requote.result).toMatchObject({ ya_mostrada_al_cliente: true });
    await s.confirm();
    expect((await s.create({ efectivo_con: 500 })).orderId).not.toBeNull();
  });
  it("omitir el pago al re-cotizar en el turno del si conserva el pago cotizado (no reabre la confirmacion)", async () => {
    const s = setup();
    await s.quote({ payment_method: "efectivo", efectivo_con: 500 });
    s.nextTurn();
    await s.quote(); // el modelo olvida mandar el pago
    await s.confirm();
    expect((await s.create({ efectivo_con: 500 })).orderId).not.toBeNull();
  });
  it("tarjeta descarta el efectivo_con de relleno y el pago cotizado queda guardado", async () => {
    const s = setup();
    await s.quote({ payment_method: "tarjeta", efectivo_con: 500 });
    const ctx = (await s.snap())?.context;
    expect(ctx?.quotedPago).toBe("tarjeta");
    expect(ctx?.quotedEfectivoCon).toBeUndefined();
  });
});

describe("una cotizacion temprana no cuenta como resumen mostrado", () => {
  const total = (s: ReturnType<typeof setup>) => s.snap().then((x) => x?.context?.quotedTotal as number);

  it("con historial sin el total en un mensaje del asistente, la re-cotizacion NO trae ya_mostrada_al_cliente ni siguiente_paso", async () => {
    const hist = [{ role: "user" as const, content: "dos cocas para recoger" }, { role: "assistant" as const, content: "¿Es este su número?" }, { role: "user" as const, content: "sí" }];
    const s = setup(() => hist);
    await s.quote();
    s.nextTurn();
    const r = await s.quote();
    expect(r.result).not.toHaveProperty("ya_mostrada_al_cliente");
    expect(r.result).not.toHaveProperty("siguiente_paso");
  });
  it("si un mensaje del asistente trae el total, la re-cotizacion identica SI avisa que ya se mostro", async () => {
    const hist: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: "dos cocas" }];
    const s = setup(() => hist);
    await s.quote();
    hist.push({ role: "assistant", content: `Permítame repetirle su pedido: 2 Coca-Cola. Total $${await total(s)}. ¿Es correcto?` }, { role: "user", content: "sí" });
    s.nextTurn();
    expect((await s.quote()).result).toMatchObject({ ya_mostrada_al_cliente: true });
  });
  it("bloqueCotizacionVigente: con resumenMostrado=false es PRELIMINAR y prohibe confirmar+crear; true o ausente conserva la instruccion de siempre", async () => {
    const s = setup();
    await s.quote();
    const snap = await s.snap();
    const pre = bloqueCotizacionVigente(snap, Date.now(), { resumenMostrado: false });
    expect(pre).toMatch(/COTIZACIÓN PRELIMINAR/);
    expect(pre).toMatch(/TODAVÍA NO ha visto el resumen/);
    expect(pre).toMatch(/NO llame confirmar_resumen ni crear_pedido todavía/);
    expect(pre).not.toMatch(/SIN buscar de nuevo ni cotizar otra vez/);
    expect(pre).not.toMatch(/es la que el cliente vio en el resumen/);
    for (const opciones of [undefined, { resumenMostrado: true }, {}]) {
      const vigente = bloqueCotizacionVigente(snap, Date.now(), opciones);
      expect(vigente).toMatch(/es la que el cliente vio en el resumen/);
      expect(vigente).toMatch(/SIN buscar de nuevo ni cotizar otra vez/);
    }
  });
});

describe("resumenMostradoEnHistorial", () => {
  const asistente = (content: string) => [{ role: "assistant", content }];
  it("reconoce el total escrito como $245, 245.00, 245 pesos y 1,245.50; no confunde 2450 ni 245.5 con 245", () => {
    expect(resumenMostradoEnHistorial(245, asistente("Total $245"))).toBe(true);
    expect(resumenMostradoEnHistorial(245, asistente("Total: 245.00"))).toBe(true);
    expect(resumenMostradoEnHistorial(245, asistente("son 245 pesos"))).toBe(true);
    expect(resumenMostradoEnHistorial(1245.5, asistente("Total $1,245.50"))).toBe(true);
    expect(resumenMostradoEnHistorial(245, asistente("Total $2450"))).toBe(false);
    expect(resumenMostradoEnHistorial(245, asistente("Total $245.5"))).toBe(false);
  });
  it("solo cuentan mensajes del asistente; sin historial o sin total devuelve undefined (comportamiento anterior)", () => {
    expect(resumenMostradoEnHistorial(245, [{ role: "user", content: "$245" }])).toBe(false);
    expect(resumenMostradoEnHistorial(245, undefined)).toBeUndefined();
    expect(resumenMostradoEnHistorial(undefined, asistente("$245"))).toBeUndefined();
  });
});
