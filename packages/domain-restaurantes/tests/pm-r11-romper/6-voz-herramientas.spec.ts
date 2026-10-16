// R11 romper -- VOZ (capa de herramientas). El modelo de voz (Gemini Live) llama las MISMAS herramientas del servidor con el canal "voz": aqui se afirma que
// los controles del servidor valen igual cuando el que improvisa los argumentos es el modelo de voz o quien le habla. La maquina de la llamada
// (duracion, costo, silencio, DTMF, proveedor que cae) se ataca en packages/voice-core/tests/pm-r11-romper-maquina.spec.ts.
import { describe, expect, it } from "vitest";
import { executeAgentToolSafely, invokeAgentTool } from "../../src/agent-tools/registry.ts";
import type { AgentToolContext } from "../../src/agent-tools/registry.ts";
import { buildRestaurantFixture, hallazgo, itemsCoca, ordenes } from "./arnes.ts";
import type { Fixture } from "./arnes.ts";

const TEL_LLAMADA = "9991112222";
const ctxVoz = (f: Fixture, turn = 1, extra: Partial<AgentToolContext> = {}): AgentToolContext => ({ organizationId: f.organizationId, channel: "voz", phone: TEL_LLAMADA, flow: { key: "voz:call-r11", turn: String(turn) }, sourceEventId: "call-r11", ...extra });
const base = (f: Fixture, qty: unknown = 2) => ({ branch_slug: "fco-montejo", canal: "recoger", items: itemsCoca(f, qty) });

describe("R11-6A voz: lo que el modelo de voz manda no cambia precio, telefono ni estado", () => {
  it("campos de precio / total / descuento / promo inventados en crear_pedido por voz se ignoran: se cobra el precio del catalogo", async () => {
    const f = buildRestaurantFixture();
    await invokeAgentTool(f.repo, ctxVoz(f, 1), "cotizar_pedido", base(f));
    await invokeAgentTool(f.repo, ctxVoz(f, 2), "confirmar_resumen", {});
    const out = await invokeAgentTool(f.repo, ctxVoz(f, 2), "crear_pedido", { ...base(f), customer_name: "Ana", payment_method: "efectivo", total: 1, price: 1, discount: 100, descuento: 100, items: [{ ...itemsCoca(f, 2)[0], price: 0 }] });
    expect(out.orderId).not.toBeNull();
    const [orden] = await ordenes(f);
    expect(orden!.total).toBe(90);
  });

  it("el telefono del pedido es el de la LLAMADA (token / caller ID), no el que el modelo escriba en customer_phone", async () => {
    const f = buildRestaurantFixture();
    await invokeAgentTool(f.repo, ctxVoz(f, 1), "cotizar_pedido", base(f));
    await invokeAgentTool(f.repo, ctxVoz(f, 2), "confirmar_resumen", {});
    await invokeAgentTool(f.repo, ctxVoz(f, 2), "crear_pedido", { ...base(f), customer_name: "Ana", payment_method: "efectivo", customer_phone: "9990000000" });
    const [orden] = await ordenes(f);
    expect(orden!.customerPhone.replace(/\D/g, "")).toContain(TEL_LLAMADA);
    expect(orden!.customerPhone).not.toContain("9990000000");
  });

  it("la maquina de estados tambien manda por voz: crear sin cotizar ni confirmar se rechaza", async () => {
    const f = buildRestaurantFixture();
    await expect(invokeAgentTool(f.repo, ctxVoz(f, 1), "crear_pedido", { ...base(f), customer_name: "Ana", payment_method: "efectivo" })).rejects.toMatchObject({ code: "sin_cotizacion" });
    expect(await ordenes(f)).toHaveLength(0);
  });

  it.each([[-1], [0], [1.5], ["dos"], [Number.NaN], [1e9], [null], [{}]])("cantidad %j por voz: se rechaza y no hay pedido", async (cantidad) => {
    const f = buildRestaurantFixture();
    const out = await executeAgentToolSafely(f.repo, ctxVoz(f, 1), "cotizar_pedido", base(f, cantidad));
    expect(JSON.stringify(out.result)).toMatch(/"error"/);
    expect(await ordenes(f)).toHaveLength(0);
  });

  // Mismo hallazgo R11-11 que en WhatsApp: la coercion `Number(...)` tambien alcanza al canal de voz.
  for (const [nombre, valor] of [["booleano true (-> 1)", true], ["hexadecimal '0x10' (-> 16)", "0x10"]] as const) {
    it(`R11-11 [P2] voz: cantidad ${nombre} se rechaza en vez de coercionarse`, async () => {
      const f = buildRestaurantFixture();
      const control = await executeAgentToolSafely(f.repo, ctxVoz(f, 1), "cotizar_pedido", base(f, 2));
      expect(JSON.stringify(control.result)).not.toMatch(/"error"/); // control: 2 SI pasa
      const out = await executeAgentToolSafely(f.repo, ctxVoz(f, 1), "cotizar_pedido", base(f, valor));
      expect(JSON.stringify(out.result)).toMatch(/"error"/);
    });
  }

  it("alcohol por voz: solo el booleano true confirma la mayoria de edad (cadenas, numeros y null no cuentan)", async () => {
    for (const valor of [undefined, false, "true", "si", 1, null]) {
      const f = buildRestaurantFixture();
      const out = await executeAgentToolSafely(f.repo, ctxVoz(f, 1), "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: [{ product_id: f.products.cervezaSol, product_name: "Sol", requested_quantity: 2 }], ...(valor === undefined ? {} : { adult_confirmed: valor }) });
      expect(JSON.stringify(out.result), String(valor)).toMatch(/"error"/);
    }
  });
});

describe("R11-6A2 voz: la guardia determinista de riesgo (en WhatsApp corre ANTES del modelo)", () => {
  // ── HALLAZGO R11-17 (P1, salud / cobro, solo VOZ): la guardia de voz solo actua si el cliente PIDE una persona ──
  // `evaluarPersonaVoz` sale con `null` salvo que `pideUnaPersona(texto)`; el clasificador de alto riesgo (alergia, cobro doble, ARCO, queja, urgencia) solo se
  // consulta DESPUES de eso para elegir el motivo. Un cliente que dice «soy alergico al cacahuate, ¿es seguro?» o «me cobraron dos veces» sin pedir una persona
  // depende de que el modelo se acuerde de la regla del prompt. Con Gemini Live real: 1 de 3 llamadas de alergia (en ingles) improviso un aviso medico y colgo sin
  // avisar al equipo (RONDA-11-ROMPER.md, RV-2). Fix minimo: consultar `classifyHighRiskIntent` para cualquier habla inteligible y escalar con su respuesta fija.
  const SIN_PEDIR_PERSONA: ReadonlyArray<readonly [string, string]> = [
    ["alergia en espanol", "Tengo alergia severa al cacahuate, ¿sus tacos son seguros para mí?"],
    ["cobro doble", "Ayer me cobraron dos veces en la terminal el mismo pedido"],
    ["queja de entrega", "El pedido de ayer me llegó frío y faltó una bebida"],
  ];
  for (const [nombre, frase] of SIN_PEDIR_PERSONA) {
    hallazgo(`R11-17 [P1] voz: ${nombre} (sin pedir una persona) se escala con la guardia determinista`, async () => {
      const { evaluarPersonaVoz } = await import("../../src/voz/guardia-persona.ts");
      // Control: pidiendo una persona SI escala, con el motivo especifico.
      expect(evaluarPersonaVoz(`Quiero hablar con una persona. ${frase}`), "control: pidiendo una persona SI escala").not.toBeNull();
      expect(evaluarPersonaVoz(frase), "sin pedir una persona").not.toBeNull();
    });
  }
});

describe("R11-6B voz: escalaciones y avisos", () => {
  it("escalar_a_humano por voz devuelve la frase fija para el cliente y deja UN aviso aunque el modelo lo repita durante la llamada", async () => {
    const f = buildRestaurantFixture();
    const llamadas = await Promise.all(Array.from({ length: 5 }, () => invokeAgentTool(f.repo, ctxVoz(f), "escalar_a_humano", { customer_name: "Ana", motivo: "queja", resumen: "llego frio" })));
    for (const l of llamadas) expect((l.result as { mensaje_al_cliente?: string }).mensaje_al_cliente).toMatch(/Ya avisé al gerente/);
    expect(f.repo.listCallbackRequests(f.organizationId)).toHaveLength(1);
  });

  it("'cliente_llego' sin pedido para recoger no avisa a la sucursal ni inventa un pedido", async () => {
    const f = buildRestaurantFixture();
    const out = await invokeAgentTool(f.repo, ctxVoz(f), "registrar_contacto", { customer_name: "Ana", reason: "cliente_llego", message: "auto gris" });
    expect(JSON.stringify(out.result)).toMatch(/No encuentro un pedido|No avise/i);
    expect(await ordenes(f)).toHaveLength(0);
  });

  it("una llamada con telefono DECLARADO (caller ID no confiable) no ve ficha, direcciones ni historial del numero dictado", async () => {
    const f = buildRestaurantFixture();
    await invokeAgentTool(f.repo, ctxVoz(f, 1), "cotizar_pedido", base(f));
    await invokeAgentTool(f.repo, ctxVoz(f, 2), "confirmar_resumen", {});
    await invokeAgentTool(f.repo, ctxVoz(f, 2), "crear_pedido", { ...base(f), customer_name: "Ana Reservada", customer_address: "Calle 7 #210 Secreta", payment_method: "efectivo", canal: "domicilio", colonia_entrega: "Centro" }).catch(() => undefined);
    const declarado = ctxVoz(f, 1, { phoneDeclared: true, flow: undefined });
    for (const herramienta of ["buscar_cliente", "historial_pedidos"]) {
      const out = await invokeAgentTool(f.repo, declarado, herramienta, {});
      expect(JSON.stringify(out.result), herramienta).not.toMatch(/Ana Reservada|Secreta|Coca-Cola/);
    }
  });
});
