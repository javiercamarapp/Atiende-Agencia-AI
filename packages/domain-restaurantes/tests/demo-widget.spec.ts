// R-19 -- widget de chat WhatsApp para demos SIN Meta. Afirma el EFECTO: el agente real responde, el pedido queda
// creado de verdad (motor real, no un guion), y NADA se encola hacia Meta (messaging_outbox vacio), mientras que el
// webhook real SI encola la misma respuesta.
import { describe, expect, it } from "vitest";
import { canonicalizeMexicanPhone } from "../src/phone.ts";
import { handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import {
  DEMO_PHONE_PREFIX_VOLUME,
  DEMO_PHONE_PREFIX_WIDGET,
  DEMO_WIDGET_LIMITS,
  DEMO_WIDGET_MENSAJES,
  DemoWidgetValidationError,
  InMemoryDemoRepository,
  demoPhone,
  demoPhoneForSession,
  esTelefonoDemo,
  resolveDemoWidgetEstado,
  runDemoWidgetTurn,
  sanitizeWidgetMessage,
} from "../src/demo/index.ts";
import { scriptedHandler } from "./pm/harness.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const SESSION = "sesion-demo-0123456789abcdef";

describe("telefonos ficticios del rango reservado", () => {
  it("el telefono de la sesion es determinista, de 12 digitos, canonico y del rango del widget (0009)", () => {
    const a = demoPhoneForSession(SESSION);
    expect(demoPhoneForSession(SESSION)).toBe(a);
    expect(demoPhoneForSession("otra-sesion-0123456789abcdef")).not.toBe(a);
    expect(a).toMatch(/^\+520009\d{6}$/);
    expect(canonicalizeMexicanPhone(a)).toMatch(/^0009\d{6}$/);
    expect(esTelefonoDemo(a)).toBe(true);
  });

  it("el rango de volumen (0001) y el del widget (0009) no se confunden con un telefono real", () => {
    expect(demoPhone(DEMO_PHONE_PREFIX_VOLUME, 7)).toBe("+520001000007");
    expect(demoPhone(DEMO_PHONE_PREFIX_WIDGET, 999_999)).toBe("+520009999999");
    expect(esTelefonoDemo("+529991234567")).toBe(false);
    expect(esTelefonoDemo("9991234567")).toBe(false);
    expect(() => demoPhone(DEMO_PHONE_PREFIX_WIDGET, 1_000_000)).toThrow(RangeError);
  });
});

describe("resolveDemoWidgetEstado", () => {
  const org = "00000000-0000-4000-8000-0000000000a1";

  it("sin repositorio demo o sin marca: no disponible (no_es_demo); nunca atiende una organizacion real", async () => {
    expect(await resolveDemoWidgetEstado(undefined, org, true)).toEqual({ disponible: false, motivo: "no_es_demo", mensaje: DEMO_WIDGET_MENSAJES.no_es_demo });
    expect((await resolveDemoWidgetEstado(new InMemoryDemoRepository(), org, true)).motivo).toBe("no_es_demo");
  });

  it("demo apagada por el operador: apagada", async () => {
    const demo = new InMemoryDemoRepository();
    demo.markDemo(org, { activo: false });
    expect((await resolveDemoWidgetEstado(demo, org, true)).motivo).toBe("apagada");
  });

  it("sin proveedor LLM: estado honesto que nombra la llave requerida (nunca una respuesta simulada)", async () => {
    const demo = new InMemoryDemoRepository();
    demo.markDemo(org);
    const estado = await resolveDemoWidgetEstado(demo, org, false);
    expect(estado).toEqual({ disponible: false, motivo: "sin_agente", mensaje: expect.stringContaining("OPENROUTER_API_KEY") });
  });

  it("demo cargada, activa y con agente: disponible", async () => {
    const demo = new InMemoryDemoRepository();
    demo.markDemo(org);
    expect(await resolveDemoWidgetEstado(demo, org, true)).toEqual({ disponible: true, motivo: null, mensaje: null });
  });
});

describe("sanitizeWidgetMessage", () => {
  it("rechaza vacio, no-texto y mensajes demasiado largos; quita caracteres de control", () => {
    expect(() => sanitizeWidgetMessage("   ")).toThrow(DemoWidgetValidationError);
    expect(() => sanitizeWidgetMessage(42)).toThrow(DemoWidgetValidationError);
    expect(() => sanitizeWidgetMessage("x".repeat(DEMO_WIDGET_LIMITS.maxMessageChars + 1))).toThrow(DemoWidgetValidationError);
    expect(sanitizeWidgetMessage("  hola\u0000 mundo \u0007 ")).toBe("hola mundo");
  });
});

describe("runDemoWidgetTurn con el agente de WhatsApp real", () => {
  it("un pedido completo por el widget crea el pedido con el motor real y NO encola nada hacia Meta", async () => {
    const f = buildRestaurantFixture();
    const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
    const { handler } = scriptedHandler(f.repo, [
      { calls: [{ name: "cotizar_pedido", args: { branch_slug: "fco-montejo", items, canal: "recoger" } }] },
      { text: "El total es $90. ¿Pagará en efectivo y confirma?" },
      {
        calls: [
          { name: "confirmar_resumen", args: {} },
          { name: "crear_pedido", args: { branch_slug: "fco-montejo", customer_name: "Ana Demo", payment_method: "efectivo", canal: "recoger", items } },
        ],
      },
      { text: "Listo, su pedido ya esta en cocina." },
    ]);
    const deps = { repo: f.repo, turnHandler: handler };

    const primero = await runDemoWidgetTurn(deps, { organizationId: f.organizationId, sessionId: SESSION, message: "Quiero 2 coca colas para recoger" });
    expect(primero).toMatchObject({ kind: "reply", orderId: null, escalated: false });

    const segundo = await runDemoWidgetTurn(deps, { organizationId: f.organizationId, sessionId: SESSION, message: "Si, en efectivo" });
    expect(segundo.kind).toBe("reply");
    if (segundo.kind !== "reply") throw new Error("esperaba reply");
    expect(segundo.orderId).not.toBeNull();

    // El pedido existe de verdad, con total coherente (2 x $45) y a nombre del telefono ficticio del rango 0009.
    const order = await f.repo.findOrderById(f.organizationId, segundo.orderId as string);
    expect(order).toMatchObject({ total: 90, source: "whatsapp", customerName: "Ana Demo" });
    expect(esTelefonoDemo(order!.customerPhone)).toBe(true);

    // Ninguna ruta del widget envia a Meta: el outbox de WhatsApp queda VACIO.
    expect(await f.repo.claimMessagingOutboxBatch(10, 60)).toEqual([]);
  });

  it("control: el MISMO mensaje por el webhook real (deliverReply por omision) SI encola la respuesta hacia Meta", async () => {
    const f = buildRestaurantFixture();
    const { handler } = scriptedHandler(f.repo, [{ text: "Hola, ¿que le gustaria pedir?" }]);
    const out = await handleInboundWhatsAppMessage(f.repo, handler, {
      organizationId: f.organizationId,
      messageId: "wamid.control",
      phone: "+5219990000000",
      body: "Hola",
      phoneNumberId: "pn-1",
    });
    expect(out.ok).toBe(true);
    const batch = await f.repo.claimMessagingOutboxBatch(10, 60);
    expect(batch).toHaveLength(1);
  });

  it("una queja escala a un humano: abre la toma de handoff y avisa al visitante; despues el agente calla", async () => {
    const f = buildRestaurantFixture();
    const { handler } = scriptedHandler(f.repo, [{ text: "no deberia usarse" }]);
    const gateCalls: Array<{ motivo: string; phone: string }> = [];
    let abierta = false;
    const handoffGate = {
      estadoParaAgente: async () => (abierta ? ("pendiente" as const) : null),
      solicitarHumano: async (input: { motivo: string; phone: string }) => {
        gateCalls.push({ motivo: input.motivo, phone: input.phone });
        abierta = true;
        return "handoff-1";
      },
    };
    const deps = { repo: f.repo, turnHandler: handler, handoffGate };
    const queja = await runDemoWidgetTurn(deps, { organizationId: f.organizationId, sessionId: SESSION, message: "Quiero poner una queja, mi pedido llego frio" });
    expect(queja).toMatchObject({ kind: "reply", escalated: true });
    expect(gateCalls).toHaveLength(1);
    expect(esTelefonoDemo(gateCalls[0]!.phone)).toBe(true);

    const despues = await runDemoWidgetTurn(deps, { organizationId: f.organizationId, sessionId: SESSION, message: "¿Siguen ahi?" });
    expect(despues.kind).toBe("humano");
    expect(await f.repo.claimMessagingOutboxBatch(10, 60)).toEqual([]);
  });

  it("sesion invalida o mensaje vacio: error de validacion, sin tocar al agente", async () => {
    const f = buildRestaurantFixture();
    const { handler, requests } = scriptedHandler(f.repo, [{ text: "x" }]);
    const deps = { repo: f.repo, turnHandler: handler };
    await expect(runDemoWidgetTurn(deps, { organizationId: f.organizationId, sessionId: "corta", message: "hola" })).rejects.toBeInstanceOf(DemoWidgetValidationError);
    await expect(runDemoWidgetTurn(deps, { organizationId: f.organizationId, sessionId: SESSION, message: "  " })).rejects.toBeInstanceOf(DemoWidgetValidationError);
    expect(requests).toHaveLength(0);
  });

  it("aislamiento: dos visitantes (sesiones) no comparten conversacion ni telefono", async () => {
    const f = buildRestaurantFixture();
    const { handler } = scriptedHandler(f.repo, [{ text: "Hola" }]);
    const deps = { repo: f.repo, turnHandler: handler };
    await runDemoWidgetTurn(deps, { organizationId: f.organizationId, sessionId: SESSION, message: "Hola, soy el visitante A" });
    await runDemoWidgetTurn(deps, { organizationId: f.organizationId, sessionId: "visitante-b-0123456789abcdef", message: "Hola, soy el visitante B" });
    expect(demoPhoneForSession(SESSION)).not.toBe(demoPhoneForSession("visitante-b-0123456789abcdef"));
  });
});
