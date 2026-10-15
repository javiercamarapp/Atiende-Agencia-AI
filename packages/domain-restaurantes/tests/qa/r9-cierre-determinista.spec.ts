// QA PM ronda 9, P1 -- el turno del «si» agotaba el presupuesto de 18 s y caia a «problema tecnico»: el pedido ya confirmado se perdia.
// Ahora `fallaDelSistema()` intenta antes cerrar el pedido SIN modelo desde la cotizacion vigente (cierre-determinista.ts). Estas pruebas corren el
// agente de PM de punta a punta (catalogo real del seed, LLM GUIONADO, todo en memoria) y simulan el timeout moviendo el reloj dentro del guion.
import { afterEach, describe, expect, it, vi } from "vitest";
import { banco, call, item, say } from "./r1-arnes-whatsapp-pm.ts";
import type { Banco, Paso } from "./r1-arnes-whatsapp-pm.ts";
import { efectivoConDelResumen, esSiClaroDeConfirmacion, pagoDelTexto, textoLlevaElTotal } from "../../src/whatsapp/cierre-determinista.ts";

afterEach(() => {
  vi.useRealTimers();
});

const pedidos = async (b: Banco) => (await b.w.repo.listOrders(b.w.organizationId, { propertyIds: null, limit: 100 } as never)).orders;
const RESUMEN = "Permítame repetirle su pedido:\n- 3 Tacos al pastor (maíz)\nPara recoger en García Lavín\nPago: efectivo\nTotal: $126.00\n¿Es correcto?";

/** Paso del guion que consume 25 s de reloj (el proveedor lento) y pide una herramienta: el siguiente encabezado de vuelta ya no tiene presupuesto. */
const lento =
  (extraMs = 25_000): Paso =>
  (req) => {
    vi.setSystemTime(new Date(Date.now() + extraMs));
    return call("buscar_producto", { query: "pastor", branch_slug: "garcia-lavin" })(req);
  };
const proveedorCae: Paso = () => {
  throw new Error("proveedor caido (simulado)");
};

async function conCotizacion(opciones: { readonly tel: string; readonly nombre?: string | null; readonly canal?: "recoger" | "domicilio";
  readonly cantidad?: number; readonly resumen?: string; readonly handlerOptions?: Parameters<typeof banco>[0] extends infer O ? (O extends { handlerOptions?: infer H } ? H : never) : never }) {
  const eventos: Array<{ evento: string; cierreDeterminista?: string | null }> = [];
  const b = await banco({ handlerOptions: { turnBudgetMs: 18_000, observabilidad: { emitir: (e) => eventos.push(e as never) }, ...(opciones.handlerOptions ?? {}) } });
  /** Resultado del intento de cierre sin modelo en el ULTIMO turno (telemetria del turno). */
  const cierre = () => eventos.filter((e) => e.evento === "whatsapp_turno").at(-1)?.cierreDeterminista ?? null;
  if (opciones.nombre !== null) await b.w.repo.upsertCustomer(b.w.organizationId, opciones.tel.slice(-10), opciones.nombre ?? "Ana Pech");
  const items = [item(b.pid("Taco Al Pastor (individual)"), "Taco Al Pastor (individual)", opciones.cantidad ?? 3, "maiz")];
  b.setGuion([call("cotizar_pedido", { branch_slug: "garcia-lavin", canal: opciones.canal ?? "recoger", ...(opciones.canal === "domicilio" ? { colonia_entrega: "Centro" } : {}), items }), say(opciones.resumen ?? RESUMEN)]);
  const r = await b.enviar(opciones.tel, "3 de pastor en maiz pa recoger");
  return { b, items, cotizo: r, cierre };
}

describe("P1 cierre determinista: el turno del «si» se queda sin tiempo", () => {
  it("timeout simulado con cotizacion vigente: el pedido se crea UNA vez, con el total cotizado, sin escalar", async () => {
    const { b, cierre } = await conCotizacion({ tel: "+5219990000301" });
    b.setGuion([lento()]);
    const r = await b.enviar("+5219990000301", "sí");
    expect(cierre()).toBe("creado");
    expect(r.orderId).toBeTruthy();
    expect(r.escalated).toBe(false);
    expect(r.reply).toMatch(/ya quedó registrado/i);
    expect(r.reply).not.toMatch(/problema técnico/i);
    const lista = await pedidos(b);
    expect(lista).toHaveLength(1);
    expect(lista[0]!.total).toBe(126);
    expect(lista[0]!.paymentMethod).toBe("efectivo");
    expect(b.callbacks().some((c) => c.reason === "escalada:falla_sistema")).toBe(false);
  });

  it("el proveedor cae en el turno del «si»: tambien se cierra (un «si efectivo» con el pago dicho por el cliente)", async () => {
    const { b, cierre } = await conCotizacion({ tel: "+5219990000302", resumen: "Su pedido: 3 Tacos al pastor para recoger. Total: $126.00. ¿Es correcto y cómo pagará?" });
    b.setGuion([proveedorCae]);
    const r = await b.enviar("+5219990000302", "si efectivo");
    expect(cierre()).toBe("creado");
    expect(r.orderId).toBeTruthy();
    expect(await pedidos(b)).toHaveLength(1);
  });

  it("la nota del pedido lleva el resumen que el cliente confirmo (los ajustes que no entran a la huella no se pierden en silencio)", async () => {
    const { b } = await conCotizacion({ tel: "+5219990000303", resumen: `${RESUMEN}\nSin cebolla.` });
    b.setGuion([lento()]);
    await b.enviar("+5219990000303", "sí");
    const [pedido] = await pedidos(b);
    expect(pedido!.notes ?? "").toMatch(/Sin cebolla/);
    expect(pedido!.notes ?? "").toMatch(/cerrado automaticamente/i);
  });

  it("sin cotizacion vigente: escala falla_sistema como antes y no crea nada", async () => {
    const b = await banco({ handlerOptions: { turnBudgetMs: 18_000 } });
    await b.w.repo.upsertCustomer(b.w.organizationId, "9990000304", "Ana Pech");
    b.setGuion([lento()]);
    const r = await b.enviar("+5219990000304", "sí");
    expect(r.orderId ?? null).toBeNull();
    expect(r.escalated).toBe(true);
    expect(r.reply).toMatch(/problema técnico/i);
    expect(b.callbacks().some((c) => c.reason === "escalada:falla_sistema")).toBe(true);
    expect(await pedidos(b)).toHaveLength(0);
  });

  it("cotizacion vencida (mas de 20 min): no se crea; se escala como antes", async () => {
    const { b, cierre } = await conCotizacion({ tel: "+5219990000305" });
    vi.setSystemTime(new Date(Date.now() + 21 * 60_000));
    b.setGuion([lento()]);
    const r = await b.enviar("+5219990000305", "sí");
    expect(cierre()).toBeNull(); // sin cotizacion vigente al inicio del turno el atajo ni se intenta
    expect(r.orderId ?? null).toBeNull();
    expect(r.escalated).toBe(true);
    expect(await pedidos(b)).toHaveLength(0);
  });

  it("la cotizacion CAMBIO durante el turno (el modelo re-cotizo otro carrito antes de agotarse): no se crea el pedido viejo ni el nuevo", async () => {
    const { b, cierre } = await conCotizacion({ tel: "+5219990000306" });
    const otro = [item(b.pid("Taco Al Pastor (individual)"), "Taco Al Pastor (individual)", 5, "maiz")];
    b.setGuion([call("cotizar_pedido", { branch_slug: "garcia-lavin", canal: "recoger", items: otro }), lento()]);
    const r = await b.enviar("+5219990000306", "sí");
    expect(cierre()).toBe("no_aplica:cotizacion_cambio");
    expect(r.orderId ?? null).toBeNull();
    expect(r.escalated).toBe(true);
    expect(await pedidos(b)).toHaveLength(0);
  });

  it.each([
    ["con un cambio", "sí pero mejor 5 tacos"],
    ["con un producto nuevo", "si agrega una coca"],
    ["una pregunta", "si, ¿a qué hora está?"],
    ["una negativa", "no"],
    ["una duda", "mmm no sé"],
    ["un emoji", "👍"],
    ["otra forma de pago", "sí, pero con tarjeta"],
  ])("«si» ambiguo o distinto (%s: «%s»): NO se crea el pedido", async (_n, texto) => {
    const { b, cierre } = await conCotizacion({ tel: "+5219990000307" });
    b.setGuion([lento()]);
    const r = await b.enviar("+5219990000307", texto);
    expect(cierre()).toBe("no_aplica:si_ambiguo");
    expect(r.orderId ?? null).toBeNull();
    expect(await pedidos(b)).toHaveLength(0);
  });

  it("doble disparo secuencial (el cliente manda otro «si» y tambien se agota): un solo pedido, la verdad al cliente y sin escalar", async () => {
    const { b } = await conCotizacion({ tel: "+5219990000308" });
    b.setGuion([lento()]);
    const primero = await b.enviar("+5219990000308", "sí");
    expect(primero.orderId).toBeTruthy();
    b.setGuion([lento()]);
    const segundo = await b.enviar("+5219990000308", "sí");
    expect(segundo.reply).toMatch(/ya quedó registrado/i);
    expect(segundo.escalated).toBe(false);
    expect(await pedidos(b)).toHaveLength(1);
  });

  it("doble disparo CONCURRENTE (el mismo «si» procesado dos veces a la vez): un solo pedido", async () => {
    const { b } = await conCotizacion({ tel: "+5219990000309" });
    const mensajes = [
      { role: "user" as const, content: "3 de pastor en maiz pa recoger" },
      { role: "assistant" as const, content: RESUMEN },
      { role: "user" as const, content: "sí" },
    ];
    b.setGuion([lento()]);
    const entrada = { organizationId: b.w.organizationId, phone: "+5219990000309", messages: mensajes, customer: { isNew: false as const, name: "Ana Pech", orderCount: 0, addresses: [], lastOrderItems: null, frequentItems: [], tier: null, agentNotes: [] }, propertyId: b.t7 };
    const [x, y] = await Promise.all([b.handler.handleInboundMessage(entrada), b.handler.handleInboundMessage(entrada)]);
    expect([x.orderId, y.orderId].filter(Boolean).length).toBeLessThanOrEqual(2);
    expect(await pedidos(b)).toHaveLength(1);
  });

  it("el modelo YA habia creado el pedido cuando se agoto el tiempo: el cierre no crea otro (confirma el que existe)", async () => {
    const { b, items } = await conCotizacion({ tel: "+5219990000310" });
    b.setGuion([call("confirmar_resumen", {}), call("crear_pedido", { branch_slug: "garcia-lavin", canal: "recoger", customer_name: "Ana Pech", payment_method: "efectivo", items }), lento()]);
    const r = await b.enviar("+5219990000310", "sí");
    expect(r.orderId).toBeTruthy();
    expect(r.reply).toMatch(/registrado/i);
    expect(await pedidos(b)).toHaveLength(1);
  });

  it("cliente sin nombre en el sistema (nuevo): no se inventa uno; se escala como antes", async () => {
    const { b, cierre } = await conCotizacion({ tel: "+5219990000311", nombre: null });
    b.setGuion([lento()]);
    const r = await b.enviar("+5219990000311", "sí");
    expect(cierre()).toBe("no_aplica:sin_nombre");
    expect(r.orderId ?? null).toBeNull();
    expect(r.escalated).toBe(true);
    expect(await pedidos(b)).toHaveLength(0);
  });

  it("nombre generico guardado («Cliente»): la guarda de #556 sigue valiendo y no se crea", async () => {
    const { b, cierre } = await conCotizacion({ tel: "+5219990000312", nombre: "Cliente" });
    b.setGuion([lento()]);
    const r = await b.enviar("+5219990000312", "sí");
    expect(cierre()).toBe("no_aplica:nombre_no_utilizable");
    expect(r.orderId ?? null).toBeNull();
    expect(await pedidos(b)).toHaveLength(0);
  });

  it("a domicilio no se cierra solo (falta direccion, colonia/pin y cobertura): se escala como antes", async () => {
    const b = await banco({ handlerOptions: { turnBudgetMs: 18_000, observabilidad: { emitir: (e) => eventos.push(e as never) } } });
    const eventos: Array<{ evento: string; cierreDeterminista?: string | null }> = [];
    const tel = "+5219990000313";
    await b.w.repo.upsertCustomer(b.w.organizationId, tel.slice(-10), "Ana Pech");
    b.setGuion([say("Su pedido a domicilio: 8 Tacos al pastor. Pago: efectivo. Total: $336.00. ¿Es correcto?")]);
    await b.enviar(tel, "8 de pastor a domicilio");
    // Cotizacion vigente de un pedido A DOMICILIO (se siembra: la direccion y la cobertura no viven en la cotizacion guardada).
    const pastor = b.pid("Taco Al Pastor (individual)");
    await b.w.repo.writeOrderFlow(b.w.organizationId, `wa:${tel}`, 0, { state: "cotizado", context: { quoteHash: "a".repeat(32), quotedAtMs: Date.now(), quotedTurn: "1", quotedItems: [{ id: pastor, name: "Taco Al Pastor (individual)", qty: 8, tortilla: "maiz" }], quotedBranchSlug: "garcia-lavin", quotedCanal: "domicilio", quotedTotal: 336 } }, 3600);
    b.setGuion([lento()]);
    const r = await b.enviar(tel, "sí");
    expect(eventos.filter((e) => e.evento === "whatsapp_turno").at(-1)?.cierreDeterminista).toBe("no_aplica:no_es_recoger");
    expect(r.orderId ?? null).toBeNull();
    expect(await pedidos(b)).toHaveLength(0);
  });

  it("pago no claro (el resumen no lo dice ni el cliente tampoco): no se adivina", async () => {
    const { b, cierre } = await conCotizacion({ tel: "+5219990000314", resumen: "Su pedido: 3 Tacos al pastor para recoger. Total: $126.00. ¿Es correcto?" });
    b.setGuion([lento()]);
    const r = await b.enviar("+5219990000314", "sí");
    expect(cierre()).toBe("no_aplica:pago_no_claro");
    expect(r.orderId ?? null).toBeNull();
    expect(await pedidos(b)).toHaveLength(0);
  });

  it("el resumen que el cliente vio no traia el total cotizado: no se crea", async () => {
    const { b, cierre } = await conCotizacion({ tel: "+5219990000315", resumen: "Su pedido: 3 Tacos al pastor para recoger, pago en efectivo. ¿Es correcto?" });
    b.setGuion([lento()]);
    const r = await b.enviar("+5219990000315", "sí");
    expect(cierre()).toBe("no_aplica:resumen_sin_total");
    expect(r.orderId ?? null).toBeNull();
    expect(await pedidos(b)).toHaveLength(0);
  });

  it("el interruptor cierreDeterminista:false devuelve el comportamiento anterior", async () => {
    const { b, cierre } = await conCotizacion({ tel: "+5219990000316", handlerOptions: { cierreDeterminista: false } });
    b.setGuion([lento()]);
    const r = await b.enviar("+5219990000316", "sí");
    expect(cierre()).toBeNull();
    expect(r.orderId ?? null).toBeNull();
    expect(r.escalated).toBe(true);
    expect(await pedidos(b)).toHaveLength(0);
  });
});

describe("cierre determinista: decisiones puras", () => {
  it.each(["si", "Sí", "sí.", "sii", "si!!", "claro", "correcto", "sí, está bien", "si por favor", "sí efectivo", "dale", "ok", "Sí, confirmo", "perfecto gracias", "así es, sí"])("«%s» es un si claro", (t) => {
    expect(esSiClaroDeConfirmacion(t)).toBe(true);
  });
  it.each(["", "no", "no, gracias", "sí pero mejor 5", "si agrega una coca", "si, ¿cuánto tarda?", "mmm", "👍", "tal vez", "si y que sean 4 tacos", "x".repeat(200), "ok ok ok ok ok ok ok"])("«%s» NO es un si claro", (t) => {
    expect(esSiClaroDeConfirmacion(t)).toBe(false);
  });
  it("pago: uno, ninguno o ambiguo", () => {
    expect(pagoDelTexto("pago en EFECTIVO")).toBe("efectivo");
    expect(pagoDelTexto("llevar terminal, tarjeta")).toBe("tarjeta");
    expect(pagoDelTexto("efectivo o tarjeta")).toBe("ambiguo");
    expect(pagoDelTexto("sí")).toBeNull();
  });
  it("total del resumen con miles y decimales", () => {
    expect(textoLlevaElTotal("Total: $1,250.00", 1250)).toBe(true);
    expect(textoLlevaElTotal("Total: $126", 126)).toBe(true);
    expect(textoLlevaElTotal("Total: $126.50", 126.5)).toBe(true);
    expect(textoLlevaElTotal("Total: $127.00", 126)).toBe(false);
    expect(textoLlevaElTotal("sin cifras", 126)).toBe(false);
  });
  it("efectivo con", () => {
    expect(efectivoConDelResumen("Paga con $500")).toBe(500);
    expect(efectivoConDelResumen("cambio de 1,000")).toBe(1000);
    expect(efectivoConDelResumen("efectivo")).toBeNull();
  });
});
