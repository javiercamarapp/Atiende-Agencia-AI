// ARQUITECTURA B (R11): el cierre del pedido como maquina de estados determinista en el servidor (`agent-tools/cierre-maquina.ts`).
// Deterministas, sin LLM real: cubren el servidor. El efecto sobre un LLM real (que pegue el resumen canonico y no insista) solo se mide en la ronda A/B.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { executeAgentToolSafely, invokeAgentTool } from "../src/agent-tools/registry.ts";
import { resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import {
  CIERRE_MAQUINA_ENV,
  cierreMaquinaActiva,
  clasificarRespuestaCierre,
  componerRespuestaConResumen,
  datosDelMensaje,
  esResumenParaConfirmar,
  estadoDeCierre,
  firmaDeCierre,
  resumenCanonico,
  terminaEnPreguntaDeConfirmacion,
  type RespuestaCierre,
} from "../src/agent-tools/cierre-maquina.ts";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

type Msg = { role: "user" | "assistant"; content: string };
const MARTES_13 = new Date("2026-10-06T13:00:00-06:00");

beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MARTES_13);
  vi.stubEnv(CIERRE_MAQUINA_ENV, "1");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function setup(canal: "whatsapp" | "voz" = "whatsapp", hist: Msg[] = []) {
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }], propinaPolitica: "solo_tarjeta" });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  let turn = 0;
  const conHistorial = canal === "whatsapp";
  const ctx = () => ({
    organizationId: f.organizationId,
    channel: canal,
    phone: "9991234567",
    flow: { key: "k:wa", turn: canal === "voz" ? null : String(turn), now: () => Date.now() },
    ...(conHistorial ? { conversacionReciente: hist.slice(-30) } : {}),
  });
  const items = (qty = 2) => [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: qty }];
  const base = (qty = 2) => ({ branch_slug: "fco-montejo", items: items(qty), canal: "recoger" });
  const call = (tool: string, extra: Record<string, unknown> = {}, qty = 2) => invokeAgentTool(f.repo, ctx(), tool, { ...base(qty), ...extra });
  const snap = () => f.repo.readOrderFlow(f.organizationId, "k:wa");
  const s = {
    f,
    hist,
    quote: (extra: Record<string, unknown> = {}, qty = 2) => call("cotizar_pedido", { payment_method: "efectivo", efectivo_con: 500, ...extra }, qty),
    confirm: () => call("confirmar_resumen"),
    create: (extra: Record<string, unknown> = {}, qty = 2) => call("crear_pedido", { customer_name: "Nora", payment_method: "efectivo", efectivo_con: 500, ...extra }, qty),
    createSafe: (extra: Record<string, unknown> = {}) => executeAgentToolSafely(f.repo, ctx(), "crear_pedido", { ...base(), customer_name: "Nora", payment_method: "efectivo", efectivo_con: 500, ...extra }),
    total: async () => (await snap())?.context?.quotedTotal as number,
    canonico: async () => (await snap())?.context?.resumenCanonico as string,
    cliente: (t: string) => {
      turn += 1;
      hist.push({ role: "user", content: t });
    },
    asistente: (t: string) => void hist.push({ role: "assistant", content: t }),
    snap,
    /** Muestra el resumen canonico (lo que el modelo pega) como mensaje del asistente. */
    muestraResumen: async () => s.asistente(await s.canonico()),
  };
  return s;
}

describe("activacion por variable de entorno", () => {
  it("por omision DESACTIVADA; 1/true/on/si la activan", () => {
    expect(cierreMaquinaActiva({})).toBe(false);
    expect(cierreMaquinaActiva({ [CIERRE_MAQUINA_ENV]: "0" })).toBe(false);
    expect(cierreMaquinaActiva({ [CIERRE_MAQUINA_ENV]: "" })).toBe(false);
    for (const v of ["1", "true", "TRUE", "on", "si"]) expect(cierreMaquinaActiva({ [CIERRE_MAQUINA_ENV]: v })).toBe(true);
  });
  it("desactivada: el camino es el de main (sin resumen canonico; confirmar pasa y la guarda de #566 rechaza crear sin resumen visto)", async () => {
    vi.stubEnv(CIERRE_MAQUINA_ENV, "");
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    const q = (await s.quote()) as { result: Record<string, unknown> };
    expect(q.result.resumen_canonico).toBeUndefined();
    s.asistente("Listo, anotado.");
    s.cliente("con 500");
    const c = (await s.confirm()) as { result: Record<string, unknown> };
    expect(c.result.confirmado).toBe(true);
    await expect(s.create()).rejects.toMatchObject({ code: "resumen_no_mostrado" });
    const total = await s.total();
    s.asistente(`Su total es $${total}. ¿Es correcto?`);
    s.cliente("sí");
    expect((await s.create()).orderId).not.toBeNull();
  });
});

describe("clasificador del ultimo mensaje del cliente", () => {
  const tabla: Array<[string, RespuestaCierre, boolean?]> = [
    // «si» explicitos
    ["sí", "si"], ["Si", "si"], ["sii", "si"], ["sí, correcto", "si"], ["sí confirmo", "si"], ["dale", "si"], ["va", "si"], ["ok", "si"], ["listo", "si"], ["sale", "si"],
    ["confirmo", "si"], ["adelante", "si"], ["perfecto", "si"], ["así es", "si"], ["está bien", "si"], ["👍", "si"], ["Sí 👍", "si"], ["sí, por favor", "si"], ["Confirmar pedido", "si"],
    ["[boton:rp1:confirmar:abc]Confirmar pedido", "si"],
    // visto bueno en negativo: SOLO tras el resumen
    ["No gracias", "si", true], ["no, gracias", "si", true], ["nada más", "si", true], ["eso es todo", "si", true], ["así está bien", "si", true],
    ["No gracias", "dato", false], ["nada más", "dato", false],
    // pago y propina: avanzan datos, NO confirman
    ["efectivo", "dato"], ["con 500", "dato"], ["con $600", "dato"], ["tarjeta", "dato"], ["500", "dato"], ["sin propina", "dato"], ["propina del 10%", "dato"], ["10%", "dato"], ["sí, con tarjeta", "dato"], ["ok, efectivo con 200", "dato"], ["cambio de 500", "dato"],
    // rechazos y cambios
    ["no", "no"], ["No, así no", "no"], ["no es correcto", "no"], ["espera", "no"], ["cancela", "no"], ["Cambiar algo", "cambio"],
    ["mejor 3 cocas", "cambio"], ["sí pero quítale la cebolla", "cambio"], ["agrégame otra coca", "cambio"], ["sí, y agrega una horchata", "cambio"], ["cámbialo a tarjeta pero sin propina", "cambio"],
    // R22: «sí» explicito + pregunta lateral que no toca el pedido => confirma (SIM-WA-140, T7-026)
    ["sí, ¿y cuánto tarda?", "si"], ["Sí, ¿cuánto tarda?", "si"], ["sí ¿cuánto tarda?", "si"], ["ok, ¿a qué hora llega?", "si"], ["dale, ¿tienen salsa extra?", "si"], ["confirmo. ¿cuánto cuesta el envío?", "si"], ["sí y cuánto tarda?", "si"],
    // R22: un «sí» con pregunta que cambia algo, trae dato, titubea o es condicional NO confirma (sigue ambiguo: el modelo contesta y re-pide)
    ["sí, ¿con tarjeta?", "ambiguo"], ["sí, ¿puedo agregar una coca?", "ambiguo"], ["sí pero ¿cuánto tarda?", "ambiguo"], ["sí, ¿lo pueden mandar a otra dirección?", "ambiguo"], ["sí, ¿a las 8 pm?", "ambiguo"], ["sí, ¿no hay otra opción?", "ambiguo"], ["si hay promo?", "ambiguo"], ["sí, ¿creo que cuánto tarda?", "ambiguo"], ["¿sí o no?", "ambiguo"], ["sí, ¿es correcto?", "si"], ["no, ¿cuánto tarda?", "ambiguo"],
    // preguntas y ruido: ambiguos
    ["¿cuánto tarda?", "ambiguo"], ["cuánto es el envío", "ambiguo"], ["mmm", "ambiguo"], ["", "ambiguo"], ["pues no sé", "ambiguo"], ["a ver", "ambiguo"],
  ];
  for (const [msg, esperado, despues] of tabla) {
    it(`«${msg}» ${despues === undefined ? "" : despues ? "(tras el resumen) " : "(fuera del resumen) "}=> ${esperado}`, () => {
      expect(clasificarRespuestaCierre(msg, { despuesDelResumen: despues ?? true })).toBe(esperado);
    });
  }
  it("un mensaje largo con un «sí» perdido NO confirma", () => {
    expect(clasificarRespuestaCierre("sí oye pero resulta que mi mamá también quiere algo y no sé si llegue a tiempo", { despuesDelResumen: true })).not.toBe("si");
  });
});

describe("«sí» con el dato de pago que el resumen YA muestra", () => {
  const efectivo500 = { datosCotizados: { pago: "efectivo" as const, efectivoCon: 500 }, total: 90, despuesDelResumen: true };
  const tarjeta = { datosCotizados: { pago: "tarjeta" as const }, total: 90, despuesDelResumen: true };
  it("coincide con el resumen => es un sí", () => {
    for (const m of ["Sí confirmo, pago en efectivo", "si efectivo", "Si, en efectivo", "sí, con 500", "sí, cambio de 500"]) expect(clasificarRespuestaCierre(m, efectivo500)).toBe("si");
    for (const m of ["si tarjeta", "sí, con tarjeta", "Sí confirmo, pago con tarjeta"]) expect(clasificarRespuestaCierre(m, tarjeta)).toBe("si");
  });
  it("NO coincide (otro pago o monto) => dato nuevo, no confirma", () => {
    expect(clasificarRespuestaCierre("sí, tarjeta", efectivo500)).toBe("dato");
    expect(clasificarRespuestaCierre("sí, con 600", efectivo500)).toBe("dato");
    expect(clasificarRespuestaCierre("sí, efectivo", tarjeta)).toBe("dato");
    expect(clasificarRespuestaCierre("sí, con 10% de propina", tarjeta)).toBe("dato");
    expect(clasificarRespuestaCierre("sí, efectivo", { despuesDelResumen: true })).toBe("dato"); // el resumen no traia pago
  });
  it("extrae pago, efectivo y propina del texto", () => {
    expect(datosDelMensaje("con 600")).toEqual({ pago: "efectivo", efectivoCon: 600 });
    expect(datosDelMensaje("efectivo, cambio de 500", 90)).toMatchObject({ pago: "efectivo", efectivoCon: 500 });
    expect(datosDelMensaje("tarjeta con 10% de propina")).toEqual({ pago: "tarjeta", propinaPct: 10 });
    expect(datosDelMensaje("de propina 20 pesos")).toEqual({ propinaMxn: 20 });
    expect(datosDelMensaje("sin propina")).toEqual({ sinPropina: true });
    expect(datosDelMensaje("con 50", 90)).toEqual({}); // no alcanza el total: no es un efectivo valido
  });
});

describe("el asistente mostro el resumen (estados derivados)", () => {
  it("la ULTIMA pregunta decide: confirmacion si, propina/pago no", () => {
    expect(terminaEnPreguntaDeConfirmacion("Total $90. ¿Es correcto o desea cambiar algo?")).toBe(true);
    expect(terminaEnPreguntaDeConfirmacion("Total $90. ¿Confirma?")).toBe(true);
    expect(terminaEnPreguntaDeConfirmacion("El total es de $90. ¿Desea agregar propina?")).toBe(false);
    expect(terminaEnPreguntaDeConfirmacion("El total es de $90. ¿Con cuánto paga?")).toBe(false);
    expect(terminaEnPreguntaDeConfirmacion("Total $90. ¿Efectivo o tarjeta?")).toBe(false);
    expect(terminaEnPreguntaDeConfirmacion("Total $90. ¿A nombre de quién?")).toBe(false);
    expect(terminaEnPreguntaDeConfirmacion("Listo, anotado.")).toBe(false);
    expect(esResumenParaConfirmar(90, "Son 2 Coca-Cola, $90. ¿Es correcto?")).toBe(true);
    expect(esResumenParaConfirmar(90, "Son 2 Coca-Cola. ¿Es correcto?")).toBe(false);
    expect(esResumenParaConfirmar(90, "Son 2 Coca-Cola, $190. ¿Es correcto?")).toBe(false);
  });
  it("estadoDeCierre recorre borrador -> cotizado -> esperando_confirmacion -> confirmado -> creado", async () => {
    const s = setup();
    expect(estadoDeCierre(await s.snap(), s.hist)).toBe("borrador");
    s.cliente("dos cocas para recoger");
    await s.quote();
    expect(estadoDeCierre(await s.snap(), s.hist)).toBe("cotizado");
    s.asistente(`Su pedido suma $${await s.total()}.`);
    expect(estadoDeCierre(await s.snap(), s.hist)).toBe("resumen_mostrado");
    await s.muestraResumen();
    expect(estadoDeCierre(await s.snap(), s.hist)).toBe("esperando_confirmacion");
    s.cliente("sí");
    await s.confirm();
    expect(estadoDeCierre(await s.snap(), s.hist)).toBe("confirmado");
    await s.create();
    expect(estadoDeCierre(await s.snap(), s.hist)).toBe("creado");
  });
  it("voz (sin historial): el estado es el de la fila", async () => {
    const s = setup("voz");
    await s.quote();
    expect(estadoDeCierre(await s.snap(), undefined)).toBe("cotizado");
  });
});

describe("resumen canonico del servidor", () => {
  it("cotizar devuelve el resumen con renglones, entrega, pago y el TOTAL del servidor", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger");
    const q = (await s.quote()) as { result: { resumen_canonico: string; instruccion_resumen: string; quote: { total: number } } };
    expect(q.result.resumen_canonico).toContain(`Total a pagar: $${q.result.quote.total}`);
    expect(q.result.resumen_canonico).toContain("2 × Coca-Cola");
    expect(q.result.resumen_canonico).toContain("recoger en sucursal");
    expect(q.result.resumen_canonico).toContain("Pago: efectivo (paga con $500)");
    expect(q.result.resumen_canonico).toMatch(/¿Está correcto\? Responda \*sí\*/);
    expect(q.result.instruccion_resumen).toContain("resumen_canonico");
    expect((await s.snap())?.context?.resumenCanonico).toBe(q.result.resumen_canonico);
  });
  it("el resumen canonico ES un resumen para confirmar segun el propio servidor", async () => {
    const s = setup();
    s.cliente("dos cocas");
    await s.quote();
    expect(esResumenParaConfirmar(await s.total(), await s.canonico())).toBe(true);
  });
  it("plantilla: domicilio, tarjeta con propina, descuento y decimales", () => {
    const t = resumenCanonico({
      lineas: [{ name: "Taco de pastor", quantity: 3, lineTotal: 105.5, tortilla: "maiz" }],
      total: 95.5,
      descuento: 10,
      canal: "domicilio",
      datos: { pago: "tarjeta", propinaPct: 10 },
    });
    expect(t).toContain("• 3 × Taco de pastor (maiz) — $105.50");
    expect(t).toContain("Descuento: -$10");
    expect(t).toContain("Entrega: a domicilio");
    expect(t).toContain("Pago: tarjeta");
    expect(t).toContain("Propina: 10% (no suma al total)");
    expect(t).toContain("Total a pagar: $95.50");
  });
  it("componerRespuestaConResumen: sin total pero pidiendo confirmar => canonico; con total se respeta el tono; otra pregunta no se toca", () => {
    const c = "Resumen de su pedido:\n• 2 × Coca-Cola — $40\nTotal a pagar: $40\n\n¿Está correcto? Responda *sí* para confirmar su pedido o dígame qué desea cambiar.";
    expect(componerRespuestaConResumen("¿Confirma su pedido?", c, 40)).toBe(c);
    expect(componerRespuestaConResumen("¡Claro que sí!\n\nSon 2 cocas, ¿confirma?", c, 40)).toBe(`¡Claro que sí!\n\n${c}`);
    const conTotal = "Perfecto, son 2 cocas por $40. ¿Es correcto?";
    expect(componerRespuestaConResumen(conTotal, c, 40)).toBe(conTotal);
    const otra = "Son $40. ¿Desea agregar propina?";
    expect(componerRespuestaConResumen(otra, c, 40)).toBe(otra);
    expect(componerRespuestaConResumen("¿Con cuánto paga?", c, 40)).toBe("¿Con cuánto paga?");
  });
  it("la firma de cierre distingue pago, efectivo y propina", () => {
    const a = firmaDeCierre({ pago: "efectivo", efectivoCon: 500 });
    expect(a).toBe(firmaDeCierre({ pago: "efectivo", efectivoCon: 500 }));
    expect(a).not.toBe(firmaDeCierre({ pago: "efectivo", efectivoCon: 200 }));
    expect(a).not.toBe(firmaDeCierre({ pago: "tarjeta" }));
    expect(firmaDeCierre({ pago: "tarjeta", efectivoCon: 500 })).toBe(firmaDeCierre({ pago: "tarjeta" }));
    expect(a).not.toBe(firmaDeCierre({ pago: "efectivo", efectivoCon: 500, propinaMxn: 20 }));
    expect(firmaDeCierre({ pago: "tarjeta", propinaPct: 10 })).not.toBe(firmaDeCierre({ pago: "tarjeta", propinaMxn: 10 }));
  });
});

describe("confirmar_resumen: solo con el resumen visto y un si explicito", () => {
  it("camino feliz: resumen canonico + «sí» => confirma y crea UN pedido", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora, pago con 500");
    await s.quote();
    await s.muestraResumen();
    s.cliente("sí");
    expect(((await s.confirm()) as { result: { confirmado?: boolean } }).result.confirmado).toBe(true);
    expect((await s.create()).orderId).not.toBeNull();
  });
  it("sin resumen mostrado => rechaza con el resumen canonico listo para pegar (salida segura) y NO confirma", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    s.asistente("¿Con cuánto paga?");
    s.cliente("con 500");
    const r = (await s.confirm()) as { result: { error: string; resumen_canonico: string }; rechazoDelFlujo?: string };
    expect(r.rechazoDelFlujo).toBe("cierre_resumen_no_mostrado");
    expect(r.result.error).toContain(r.result.resumen_canonico);
    expect((await s.snap())?.state).toBe("cotizado");
    await expect(s.create()).rejects.toMatchObject({ code: "sin_confirmacion" });
    // El modelo pega el resumen; el sí del turno siguiente cierra.
    s.asistente(r.result.resumen_canonico);
    s.cliente("sí");
    expect(((await s.confirm()) as { result: { confirmado?: boolean } }).result.confirmado).toBe(true);
    expect((await s.create()).orderId).not.toBeNull();
  });
  it("respuesta de PAGO al resumen no confirma: avanza datos (se re-cotiza con el pago) y pide el sí otra vez", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote({ payment_method: undefined, efectivo_con: undefined });
    s.asistente(`Su pedido suma $${await s.total()}. ¿Cómo desea pagar?`);
    s.cliente("efectivo, con 500");
    const r = (await s.confirm()) as { rechazoDelFlujo?: string };
    expect(r.rechazoDelFlujo).toBe("cierre_resumen_no_mostrado");
    await s.quote(); // el modelo guarda el dato y re-cotiza con pago
    expect((await s.snap())?.context?.quotedPago).toBe("efectivo");
    await s.muestraResumen();
    s.cliente("sí");
    expect(((await s.confirm()) as { result: { confirmado?: boolean } }).result.confirmado).toBe(true);
  });
  it("el pago llega justo despues del resumen (cliente: «con 600») => no confirma; el servidor lo adopta y rearma el resumen", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    await s.muestraResumen();
    s.cliente("con 600");
    const r = (await s.confirm()) as { rechazoDelFlujo?: string; result: { error: string; resumen_canonico: string } };
    expect(r.rechazoDelFlujo).toBe("cierre_sin_si_explicito");
    expect(r.result.error).toContain("dato de pago o propina");
    expect(r.result.resumen_canonico).toContain("paga con $600");
    expect((await s.snap())?.context?.quotedEfectivoCon).toBe(600);
    await expect(s.create({ efectivo_con: 600 })).rejects.toMatchObject({ code: "sin_confirmacion" });
    s.asistente(r.result.resumen_canonico);
    s.cliente("sí");
    expect(((await s.confirm()) as { result: { confirmado?: boolean } }).result.confirmado).toBe(true);
    expect((await s.create({ efectivo_con: 600 })).orderId).not.toBeNull();
  });
  it("«sí, pago en efectivo» a un resumen que ya dice efectivo => confirma de una vez (sin turno extra)", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    await s.muestraResumen();
    s.cliente("Sí confirmo, pago en efectivo");
    expect(((await s.confirm()) as { result: { confirmado?: boolean } }).result.confirmado).toBe(true);
  });
  it("R22: «sí, ¿cuánto tarda?» al resumen vigente CONFIRMA y crea el pedido una sola vez (sin pedir otro sí)", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    await s.muestraResumen();
    s.cliente("sí, ¿cuánto tarda?");
    expect(((await s.confirm()) as { result: { confirmado?: boolean } }).result.confirmado).toBe(true);
    const a = await s.create();
    expect(a.orderId).not.toBeNull();
    await expect(s.create()).rejects.toMatchObject({ code: "pedido_ya_creado" }); // no duplica
  });
  it("R22: «sí, ¿puedo agregar una coca?» NO confirma ni crea (cambio de pedido)", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    await s.muestraResumen();
    s.cliente("sí, ¿puedo agregar una coca?");
    expect(((await s.confirm()) as { rechazoDelFlujo?: string }).rechazoDelFlujo).toBe("cierre_sin_si_explicito");
    await expect(s.create()).rejects.toMatchObject({ code: "sin_confirmacion" });
  });
  it("«sí, mejor con tarjeta» a un resumen en efectivo => cambio de dato: no confirma y el resumen ya dice tarjeta", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    await s.muestraResumen();
    s.cliente("sí, con tarjeta");
    const r = (await s.confirm()) as { rechazoDelFlujo?: string; result: { resumen_canonico: string } };
    expect(r.rechazoDelFlujo).toBe("cierre_sin_si_explicito");
    expect(r.result.resumen_canonico).toContain("Pago: tarjeta");
    expect((await s.snap())?.context?.quotedPago).toBe("tarjeta");
  });
  it("«No gracias» a «¿Es correcto o desea cambiar algo?» ES el visto bueno (bloqueante de #566)", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    s.asistente(`Resumen: 2 Coca-Cola, total $${await s.total()}, paga con 500. ¿Es correcto o desea agregar algo más?`);
    s.cliente("No gracias");
    expect(((await s.confirm()) as { result: { confirmado?: boolean } }).result.confirmado).toBe(true);
    expect((await s.create()).orderId).not.toBeNull();
  });
  it("«No gracias» a «¿Desea agregar propina?» NO es el sí", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    s.asistente(`Son $${await s.total()}. ¿Desea agregar propina?`);
    s.cliente("No gracias");
    const r = (await s.confirm()) as { rechazoDelFlujo?: string };
    expect(r.rechazoDelFlujo).toBe("cierre_resumen_no_mostrado");
  });
  it("«no» al resumen => no confirma ni crea", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    await s.muestraResumen();
    s.cliente("no");
    const r = (await s.confirm()) as { rechazoDelFlujo?: string };
    expect(r.rechazoDelFlujo).toBe("cierre_sin_si_explicito");
    await expect(s.create()).rejects.toMatchObject({ code: "sin_confirmacion" });
  });
  it("«sí» ambiguo: se rechaza una vez; tras volver a mostrar el resumen, un segundo mensaje ambiguo pasa (nunca se traba)", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    await s.muestraResumen();
    s.cliente("pues a ver, ps órale entonces");
    const r1 = (await s.confirm()) as { rechazoDelFlujo?: string; result: { error: string } };
    expect(r1.rechazoDelFlujo).toBe("cierre_sin_si_explicito");
    expect(r1.result.error).toContain("sigue siendo un titubeo inocuo");
    // En el MISMO turno el reintento sigue rechazado.
    expect(((await s.confirm()) as { rechazoDelFlujo?: string }).rechazoDelFlujo).toBe("cierre_sin_si_explicito");
    await s.muestraResumen();
    s.cliente("pues sí, órale");
    // «pues sí, órale» ya no es ambiguo para el clasificador? Si lo es, la salida segura lo deja pasar; si no, pasa por sí.
    expect(((await s.confirm()) as { result: { confirmado?: boolean } }).result.confirmado).toBe(true);
  });
  it("un «no» o un cambio NUNCA pasan por la salida segura (solo lo ambiguo)", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    await s.muestraResumen();
    s.cliente("mmm no sé");
    expect(((await s.confirm()) as { rechazoDelFlujo?: string }).rechazoDelFlujo).toBe("cierre_sin_si_explicito"); // marca el ambiguo
    await s.muestraResumen();
    s.cliente("mejor tres cocas");
    expect(((await s.confirm()) as { rechazoDelFlujo?: string }).rechazoDelFlujo).toBe("cierre_sin_si_explicito");
    await s.muestraResumen();
    s.cliente("no");
    expect(((await s.confirm()) as { rechazoDelFlujo?: string }).rechazoDelFlujo).toBe("cierre_sin_si_explicito");
    expect((await s.snap())?.state).toBe("cotizado");
  });
  it("cambio de cantidad TRAS el resumen: no confirma; re-cotiza, se muestra el resumen nuevo y el sí crea 3", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    await s.muestraResumen();
    const total2 = await s.total();
    s.cliente("mejor 3 cocas");
    expect(((await s.confirm()) as { rechazoDelFlujo?: string }).rechazoDelFlujo).toBe("cierre_sin_si_explicito");
    await s.quote({}, 3);
    expect(await s.total()).toBeGreaterThan(total2);
    s.asistente("Claro.");
    s.cliente("sí"); // sí a "Claro." no es sí al resumen nuevo
    expect(((await s.confirm()) as { rechazoDelFlujo?: string }).rechazoDelFlujo).toBe("cierre_resumen_no_mostrado");
    await s.muestraResumen();
    s.cliente("sí");
    expect(((await s.confirm()) as { result: { confirmado?: boolean } }).result.confirmado).toBe(true);
    await expect(s.create({}, 2)).rejects.toMatchObject({ code: "pedido_distinto_al_cotizado" });
    expect((await s.create({}, 3)).orderId).not.toBeNull();
  });
  it("mismo turno de la cotizacion: sigue rechazado por el candado de siempre", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    await s.muestraResumen();
    // el resumen se pego en el mismo turno en que se cotizo y el cliente no ha contestado nada nuevo
    await expect(s.confirm()).rejects.toMatchObject({ code: "confirmacion_mismo_turno" });
  });
});

describe("crear_pedido: pago, efectivo y propina deben ser los del resumen confirmado", () => {
  async function confirmado(extraQuote: Record<string, unknown> = {}) {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote(extraQuote);
    await s.muestraResumen();
    s.cliente("sí");
    await s.confirm();
    return s;
  }
  it("propina ANTES del resumen: va en el resumen, y el pedido la lleva aunque el modelo no la repita al crear", async () => {
    const s = await confirmado({ payment_method: "tarjeta", efectivo_con: undefined, propina_porcentaje: 10 });
    expect(await s.canonico()).toContain("Propina: 10% (no suma al total)");
    const r = await s.create({ payment_method: "tarjeta", efectivo_con: undefined });
    expect(r.orderId).not.toBeNull();
    // 10% de $90 = $9: la propina del resumen viaja al pedido sin que el modelo la repita.
    expect((r.raw as { propina?: number }).propina).toBeGreaterThan(0);
  });
  it("propina DESPUES del resumen: crear la rechaza, el SERVIDOR adopta el dato y rearma el resumen; hace falta otro sí", async () => {
    const s = await confirmado({ payment_method: "tarjeta", efectivo_con: undefined });
    const r = (await s.create({ payment_method: "tarjeta", efectivo_con: undefined, propina: 20 })) as unknown as { rechazoDelFlujo?: string; result: { error: string; resumen_canonico: string; resumen_total: number } };
    expect(r.rechazoDelFlujo).toBe("cierre_datos_cambiaron");
    expect(r.result.resumen_canonico).toContain("Propina: $20 (no suma al total)");
    expect(r.result.error).toContain(r.result.resumen_canonico);
    expect(r.result.resumen_total).toBe(await s.total());
    expect((await s.snap())?.state).toBe("cotizado");
    // crear de nuevo en el mismo turno sigue sin confirmacion
    await expect(s.create({ payment_method: "tarjeta", efectivo_con: undefined, propina: 20 })).rejects.toMatchObject({ code: "sin_confirmacion" });
    s.asistente(r.result.resumen_canonico);
    s.cliente("sí");
    expect(((await s.confirm()) as { result: { confirmado?: boolean } }).result.confirmado).toBe(true);
    expect((await s.create({ payment_method: "tarjeta", efectivo_con: undefined, propina: 20 })).orderId).not.toBeNull();
  });
  it("propina dicha y el modelo re-cotiza con ella: cotizacion nueva, otro sí", async () => {
    const s = await confirmado({ payment_method: "tarjeta", efectivo_con: undefined });
    s.cliente("ah, de propina 20 pesos");
    await s.quote({ payment_method: "tarjeta", efectivo_con: undefined, propina: 20 });
    expect((await s.snap())?.state).toBe("cotizado");
    expect(await s.canonico()).toContain("Propina: $20");
  });
  it("cambiar el efectivo despues del resumen tambien lo rearma", async () => {
    const s = await confirmado();
    const r1 = (await s.create({ efectivo_con: 200 })) as unknown as { rechazoDelFlujo?: string; result: { resumen_canonico: string } };
    expect(r1.rechazoDelFlujo).toBe("cierre_datos_cambiaron");
    expect(r1.result.resumen_canonico).toContain("paga con $200");
  });
  it("cambiar de efectivo a tarjeta despues del resumen tambien lo rearma", async () => {
    const s = await confirmado();
    const r2 = (await s.create({ payment_method: "tarjeta", efectivo_con: undefined })) as unknown as { rechazoDelFlujo?: string; result: { resumen_canonico: string } };
    expect(r2.rechazoDelFlujo).toBe("cierre_datos_cambiaron");
    expect(r2.result.resumen_canonico).toContain("Pago: tarjeta");
    expect(r2.result.resumen_canonico).not.toContain("paga con");
  });
  it("relleno del modelo (propina 0, efectivo_con 0 con tarjeta) NO traba el cierre", async () => {
    const s = await confirmado({ payment_method: "tarjeta", efectivo_con: undefined });
    expect((await s.create({ payment_method: "tarjeta", efectivo_con: 0, propina: 0 })).orderId).not.toBeNull();
  });
  it("tras confirmar, si el cliente rechaza en otro turno, crear vuelve a cotizado (no crea) y exige el resumen otra vez", async () => {
    const s = await confirmado();
    s.asistente("Hubo un detalle con la dirección, ¿me la repite?");
    s.cliente("espera, mejor no");
    const r = (await s.createSafe()) as { rechazoDelFlujo?: string; orderId: string | null };
    expect(r.rechazoDelFlujo).toBe("cierre_sin_si_explicito");
    expect(r.orderId).toBeNull();
    expect((await s.snap())?.state).toBe("cotizado");
  });
  it("tras confirmar, un turno posterior con un dato neutro (la direccion) SI puede crear", async () => {
    const s = await confirmado();
    s.asistente("¿A nombre de quién?");
    s.cliente("Nora Pérez");
    expect((await s.create()).orderId).not.toBeNull();
  });
});

describe("doble «sí», timeout y concurrencia", () => {
  it("doble disparo: un solo pedido; el segundo «sí» no abre otro", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    await s.muestraResumen();
    s.cliente("sí");
    await s.confirm();
    const rs = await Promise.allSettled([s.create(), s.create()]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(s.create()).rejects.toMatchObject({ code: "pedido_ya_creado" });
    // el cliente manda otro «sí»: confirmar ya no procede y cotizar el mismo carrito devuelve el pedido ya registrado
    s.asistente("Su pedido ya quedó registrado.");
    s.cliente("sí");
    await expect(s.confirm()).rejects.toMatchObject({ code: "pedido_ya_creado" });
    const q = (await s.quote()) as { result: { ya_registrado?: boolean } };
    expect(q.result.ya_registrado).toBe(true);
  });
  it("timeout a mitad: un reclamo viejo (`creando`, proceso muerto) se retoma y crea sin volver a pedir el sí", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    await s.muestraResumen();
    s.cliente("sí");
    await s.confirm();
    const sn = (await s.snap())!;
    await s.f.repo.writeOrderFlow(s.f.organizationId, "k:wa", sn.version, { state: "creando", context: { ...sn.context!, claimedAtMs: Date.now() } }, 7200);
    // mientras el reclamo es reciente, esperar
    await expect(s.create()).rejects.toMatchObject({ code: "pedido_en_proceso" });
    vi.setSystemTime(new Date(MARTES_13.getTime() + 90_000));
    expect((await s.create()).orderId).not.toBeNull();
  });
  it("timeout: la confirmacion expira a los 20 minutos y obliga a re-cotizar", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    await s.muestraResumen();
    s.cliente("sí");
    await s.confirm();
    vi.setSystemTime(new Date(MARTES_13.getTime() + 21 * 60_000));
    await expect(s.create()).rejects.toMatchObject({ code: "cotizacion_vencida" });
  });
});

describe("cliente nuevo y cliente conocido", () => {
  it("conocido: el resumen de un pedido ANTERIOR con el mismo total no cuenta como el resumen de este", async () => {
    const hist: Msg[] = [
      { role: "user", content: "dos cocas para recoger" },
      { role: "assistant", content: "Resumen: 2 Coca-Cola, total $90. ¿Es correcto?" },
      { role: "user", content: "sí" },
      { role: "assistant", content: "¡Listo, su pedido quedó registrado!" },
      { role: "user", content: "otra vez lo mismo" },
      { role: "assistant", content: "¿Con cuánto paga?" },
    ];
    const s = setup("whatsapp", hist);
    s.cliente("otra vez lo mismo");
    await s.quote(); // cotizacion temprana
    s.asistente("¿Con cuánto paga?");
    s.cliente("con 500");
    const r = (await s.confirm()) as { rechazoDelFlujo?: string };
    expect(r.rechazoDelFlujo).toBe("cierre_resumen_no_mostrado");
  });
  it("nuevo: primer pedido de punta a punta con el resumen canonico", async () => {
    const s = setup();
    s.cliente("hola, quiero dos cocas para recoger");
    await s.quote();
    s.asistente("¿A nombre de quién?");
    s.cliente("Nora");
    await s.muestraResumen();
    s.cliente("sí, correcto");
    await s.confirm();
    expect((await s.create()).orderId).not.toBeNull();
  });
});

describe("voz (sin historial): comportamiento previo intacto", () => {
  it("cotiza, el cliente contesta en OTRO turno, confirma y crea; sin resumen canonico", async () => {
    const s = setup("voz");
    const q = (await s.quote()) as { result: Record<string, unknown> };
    expect(q.result.resumen_canonico).toBeUndefined();
    const c = (await s.confirm()) as { result: Record<string, unknown> };
    expect(c.result.confirmado).toBe(true);
    expect((await s.create()).orderId).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// De punta a punta por el manejador de WhatsApp con un LLM guionado.
// ---------------------------------------------------------------------------------------------------------------------
const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const llamada = (id: string, name: string, args: object): LlmCompletionResult => ({ text: "", toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const PHONE = "+5219990001111";
const PM = { perfil: "taqueria_pm" as const, agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo" as const, deliveryTimeText: "de 40 a 50 minutos" };

async function mundo(guion: (paso: number, f: ReturnType<typeof buildRestaurantFixture>, req: LlmCompletionRequest) => LlmCompletionResult) {
  const f = buildRestaurantFixture();
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  let paso = 0;
  const provider = new FakeLlmProvider({ id: "guion", script: (request: LlmCompletionRequest) => guion((paso += 1), f, request) });
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [provider]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "escalado-sin-uso" })]);
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
  const turno = (messages: Msg[]) => handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages, customer: { isNew: true as const }, propertyId: null });
  return { f, turno };
}

describe("manejador de WhatsApp con la maquina de cierre", () => {
  const cotiza = (f: { products: { cocaCola: string } }) => llamada("c1", "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", payment_method: "efectivo", efectivo_con: 500, items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }] });

  it("el modelo pide confirmar SIN el total: el cliente recibe el resumen del servidor; el «sí» siguiente crea el pedido", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return texto("¡Claro que sí!\n\nSon dos Coca-Cola. ¿Confirma su pedido?");
      if (paso === 3) return llamada("c2", "confirmar_resumen", {});
      if (paso === 4) return llamada("c3", "crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Nora", payment_method: "efectivo", efectivo_con: 500, items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }] });
      return texto("Su pedido quedó registrado.");
    });
    const t1 = await m.turno([{ role: "user", content: "dos cocas para recoger, soy Nora, pago con 500" }]);
    expect(t1.reply).toContain("Total a pagar: $");
    expect(t1.reply).toContain("¡Claro que sí!");
    expect(t1.reply).toMatch(/¿Está correcto\? Responda \*sí\*/);
    expect(t1.orderId ?? null).toBeNull();
    const t2 = await m.turno([
      { role: "user", content: "dos cocas para recoger, soy Nora, pago con 500" },
      { role: "assistant", content: t1.reply },
      { role: "user", content: "sí" },
    ]);
    expect(t2.orderId).toBeTruthy();
  });

  it("el modelo manda un «sí» a algo que NO es el resumen: el servidor no confirma (no se crea pedido)", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return texto("Perfecto. ¿Desea agregar propina?");
      if (paso === 3) return llamada("c2", "confirmar_resumen", {});
      return texto("Entendido.");
    });
    const t1 = await m.turno([{ role: "user", content: "dos cocas para recoger, soy Nora, pago con 500" }]);
    expect(t1.reply).toBe("Perfecto. ¿Desea agregar propina?");
    const t2 = await m.turno([
      { role: "user", content: "dos cocas para recoger, soy Nora, pago con 500" },
      { role: "assistant", content: t1.reply },
      { role: "user", content: "no gracias" },
    ]);
    expect(t2.orderId ?? null).toBeNull();
    const flow = await m.f.repo.readOrderFlow(m.f.organizationId, `wa:${PHONE}`);
    expect(flow?.state).toBe("cotizado");
  });

  it("desactivada: la respuesta del modelo pasa tal cual", async () => {
    vi.stubEnv(CIERRE_MAQUINA_ENV, "");
    const m = await mundo((paso, f) => (paso === 1 ? cotiza(f) : texto("Son dos Coca-Cola. ¿Confirma su pedido?")));
    const t1 = await m.turno([{ role: "user", content: "dos cocas para recoger, soy Nora, pago con 500" }]);
    expect(t1.reply).not.toContain("Total a pagar");
  });
});
