// R11 romper -- categoria 4: errores y excepciones. LLM caido / lento / con respuesta mal formada / tool_call invalido, herramienta que
// lanza, repositorio caido, JSON roto, proveedor de WhatsApp que falla. El criterio es siempre el mismo: el cliente recibe una respuesta
// honesta en usted (nunca silencio, nunca una excepcion cruda), no se crea un pedido a medias y no se duplica nada al reintentar.
import { FakeLlmProvider } from "@atiende/agent-core";
import { describe, expect, it, vi } from "vitest";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { handleInboundWhatsAppMessage } from "../../src/whatsapp/inbound.ts";
import { NEW_CUSTOMER, PHONE, buildRestaurantFixture, gatewayDe, handlerConGuion, itemsCoca, llamada, llamadas, ordenes, pasoDelTurno, scriptedHandler, texto, hallazgo } from "./arnes.ts";
import type { Fixture } from "./arnes.ts";

const TUTEO = /\b(?:t[úu]|tus|tienes|puedes|quieres|necesitas|dime|dinos|av[íi]same|intenta)\b/i;
const turnoSimple = (f: Fixture, handler: { handleInboundMessage: (a: never) => Promise<{ reply: string; orderId: string | null }> }, msg = "hola") =>
  handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: [{ role: "user", content: msg }], customer: NEW_CUSTOMER } as never);

describe("R11-4A tool_call con argumentos que no son un objeto", () => {
  // ── HALLAZGO R11-01 (P1, disponibilidad): argumentos `null` en crear_pedido / cotizar_pedido lanzan TypeError ──
  // `JSON.parse("null")` es valido y devuelve null. El turno hace `input.payment_method` / `input.canal` sobre ese null y LANZA fuera del
  // manejo de herramientas: el webhook marca el mensaje reintentable, Meta reenvia y el cliente queda sin respuesta mientras se repite el
  // gasto del modelo. Las demas herramientas ya devuelven "Error interno" controlado. Lo emite el MODELO (algunos devuelven "null" para
  // una herramienta sin argumentos), no el cliente.
  for (const herramienta of ["crear_pedido", "cotizar_pedido"]) {
    hallazgo(`R11-01 [P1] ${herramienta} con argumentos "null": el turno responde al cliente en vez de lanzar`, async () => {
      const f = buildRestaurantFixture();
      // Control: la misma herramienta con argumentos {} (objeto vacio) no lanza.
      const { handler: ok } = scriptedHandler(f.repo, [{ calls: [{ name: herramienta, args: "{}" }] }, { text: "ok" }]);
      await expect(turnoSimple(f, ok as never)).resolves.toBeTruthy();
      const { handler } = scriptedHandler(f.repo, [{ calls: [{ name: herramienta, args: "null" }] }, { text: "ok" }]);
      await expect(turnoSimple(f, handler as never)).resolves.toBeTruthy();
    });
  }

  const noObjeto = ["[]", "42", '"x"', "true", "{bad", "", "   "] as const;
  for (const args of noObjeto) {
    it(`(control) argumentos ${JSON.stringify(args)} en crear_pedido y cotizar_pedido: el turno responde, no crea pedido y no lanza`, async () => {
      for (const herramienta of ["crear_pedido", "cotizar_pedido", "buscar_producto", "confirmar_resumen", "escalar_a_humano"]) {
        const f = buildRestaurantFixture();
        const { handler } = scriptedHandler(f.repo, [{ calls: [{ name: herramienta, args }] }, { text: "Disculpe, ¿qué desea pedir?" }]);
        const r = await turnoSimple(f, handler as never);
        expect(r.reply, herramienta).toBeTruthy();
        expect(r.orderId, herramienta).toBeNull();
        expect(await ordenes(f), herramienta).toHaveLength(0);
      }
    });
  }

  it("el JSON roto le devuelve al modelo un mensaje accionable y el modelo puede corregirse en la vuelta siguiente", async () => {
    const f = buildRestaurantFixture();
    let visto = "";
    const { handler } = handlerConGuion(f.repo, (req) => {
      if (pasoDelTurno(req) === 0) return llamada("cotizar_pedido", "{items: [");
      visto = req.messages.filter((m) => m.role === "tool").map((m) => m.content).join("");
      return texto("¿Me repite su pedido, por favor?");
    });
    const r = await turnoSimple(f, handler as never);
    expect(visto).toContain("No entendí bien los datos");
    expect(r.reply).toBe("¿Me repite su pedido, por favor?");
  });
});

describe("R11-4B el modelo responde con basura", () => {
  const basura: ReadonlyArray<readonly [string, () => ReturnType<typeof texto>]> = [
    ["texto undefined", () => ({ text: undefined as unknown as string, model: "x", tokensIn: 1, tokensOut: 1, costUsd: 0 })],
    ["texto null", () => ({ text: null as unknown as string, model: "x", tokensIn: 1, tokensOut: 1, costUsd: 0 })],
    ["texto vacio", () => texto("")],
    ["toolCalls vacio", () => ({ ...texto(""), toolCalls: [] })],
  ];
  it.each(basura)("%s: el cliente recibe una pregunta en usted, no una excepcion ni un texto vacio", async (_n, respuesta) => {
    const f = buildRestaurantFixture();
    const { handler } = handlerConGuion(f.repo, () => respuesta());
    const r = await turnoSimple(f, handler as never);
    expect(r.reply.trim().length).toBeGreaterThan(5);
    expect(r.reply).not.toMatch(TUTEO);
  });

  it("tool_call con nombre vacio, id repetido y 'name' inexistente: el servidor contesta error y el turno termina", async () => {
    const f = buildRestaurantFixture();
    const { handler } = handlerConGuion(f.repo, (req) => {
      if (pasoDelTurno(req) === 0) {
        return { text: "", toolCalls: [{ id: "x", name: "", argumentsJson: "{}" }, { id: "x", name: "no_existe", argumentsJson: "{}" }], model: "x", tokensIn: 1, tokensOut: 1, costUsd: 0 };
      }
      return texto("¿Qué le gustaría pedir?");
    });
    const r = await turnoSimple(f, handler as never);
    expect(r.reply).toBe("¿Qué le gustaría pedir?");
  });

  it("(control) un argumento de 2 MB en un tool_call no tumba el turno y es rapido", async () => {
    const f = buildRestaurantFixture();
    const { handler } = handlerConGuion(f.repo, (req) => (pasoDelTurno(req) === 0 ? llamada("escalar_a_humano", JSON.stringify({ customer_name: "Ana", motivo: "otro", resumen: "x".repeat(2_000_000) })) : texto("Listo.")));
    const t0 = Date.now();
    const r = await turnoSimple(f, handler as never);
    expect(r.reply).toBeTruthy();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(f.repo.listCallbackRequests(f.organizationId)).toHaveLength(1);
  });

  // ── HALLAZGO R11-13 (P2, integridad / panel): el texto libre del aviso al equipo no tiene tope ──
  // El camino determinista (clasificador) recorta el resumen a 500; el camino del MODELO (`escalar_a_humano`, `registrar_contacto`) guarda
  // `resumen` / `message` / `customer_name` tal cual: `callback_requests.message` y `.customer_name` son `text` sin CHECK de largo. Un modelo
  // desbocado (o inducido a copiar un mensaje enorme) deja filas de MB que luego carga el panel del equipo.
  it("R11-13 [P2] el resumen que manda el modelo en escalar_a_humano se guarda acotado (<= 1000 caracteres)", async () => {
    const f = buildRestaurantFixture();
    const { handler } = handlerConGuion(f.repo, (req) => (pasoDelTurno(req) === 0 ? llamada("escalar_a_humano", JSON.stringify({ customer_name: "Ana", motivo: "otro", resumen: "x".repeat(200_000) })) : texto("Listo.")));
    await turnoSimple(f, handler as never);
    const [cb] = f.repo.listCallbackRequests(f.organizationId);
    expect(cb).toBeDefined(); // control
    expect((cb!.message ?? "").length).toBeLessThanOrEqual(1000);
  });

  // ── HALLAZGO R11-12 (P2, entrega): la respuesta del agente no se acota al maximo de Meta (4096) ──
  // El mensaje ENTRANTE si se valida contra 4096; la respuesta SALIENTE no. Meta rechaza un texto mayor (error de parametro, no
  // reintentable): el mensaje se marca `dead` y el cliente nunca lo lee, aunque el historial diga que se envio.
  it("R11-12 [P2] una respuesta del modelo de mas de 4096 caracteres se acota / divide antes de encolarse", async () => {
    const f = buildRestaurantFixture();
    const largo = `Claro. ${"Tenemos tacos de bistec, pastor y arrachera. ".repeat(150)}`;
    expect(largo.length).toBeGreaterThan(4096); // control del insumo
    const { handler } = handlerConGuion(f.repo, () => texto(largo));
    const encolados: string[] = [];
    const original = f.repo.enqueueMessagingOutbox.bind(f.repo);
    vi.spyOn(f.repo, "enqueueMessagingOutbox").mockImplementation(async (...a) => {
      encolados.push(String((a[4] as { body?: unknown }).body ?? ""));
      return original(...a);
    });
    const out = await handleInboundWhatsAppMessage(f.repo, handler, { organizationId: f.organizationId, messageId: "wamid.r11-largo", phone: PHONE, body: "hola", phoneNumberId: "pn-1" });
    expect(out.ok).toBe(true);
    expect(encolados.length).toBeGreaterThanOrEqual(1); // control: se encolo algo
    for (const cuerpo of encolados) expect(cuerpo.length).toBeLessThanOrEqual(4096);
  });
});

describe("R11-4C proveedor del LLM caido, lento o con error raro", () => {
  const errores: ReadonlyArray<readonly [string, () => unknown]> = [
    ["429", () => new Error("429 rate limited")],
    ["500", () => new Error("500 internal")],
    ["timeout", () => new Error("OpenRouter timeout (modelo)")],
    ["red", () => new Error("fetch failed ECONNRESET")],
    ["lanza un string", () => "boom"],
    ["lanza undefined", () => undefined],
    ["lanza un objeto", () => ({ code: 42 })],
  ];
  it.each(errores)("error %s en TODOS los proveedores: mensaje honesto en usted, aviso al equipo, sin pedido y sin excepcion", async (_n, crear) => {
    const f = buildRestaurantFixture();
    const caido = (id: string) => new FakeLlmProvider({ id, failWith: crear as () => Error });
    const handler = createLlmWhatsAppTurnHandler(f.repo, gatewayDe([caido("a"), caido("b")], [caido("c")]), { defaultRole: "default", escalatedRole: "escalated" });
    const r = await turnoSimple(f, handler as never);
    expect(r.reply).toContain("problema técnico");
    expect(r.reply).not.toMatch(TUTEO);
    expect(r.orderId).toBeNull();
    expect(f.repo.listCallbackRequests(f.organizationId).length).toBeGreaterThanOrEqual(1);
  });

  // ── HALLAZGO R11-10 (P1, disponibilidad): una llamada al proveedor que se cuelga NO se corta con el presupuesto del turno ──
  // El presupuesto (`turnBudgetMs`) solo se revisa ENTRE llamadas. Con un proveedor que tarda mas que el presupuesto, el turno espera a
  // que la llamada termine (en produccion hasta el timeout del cliente HTTP, 30 s por intento), pasa el limite de la funcion y el cliente
  // no recibe nada. Ya estaba documentado como decision abierta (T-FP05b, pm-bateria-agente-whatsapp.spec.ts): aqui queda ejecutable.
  hallazgo("R11-10 [P1] con presupuesto de 150 ms y un proveedor que tarda 1.2 s, el turno responde (mensaje honesto) sin esperar al proveedor", async () => {
    const f = buildRestaurantFixture();
    const { handler } = handlerConGuion(f.repo, async () => {
      await new Promise((r) => setTimeout(r, 1200));
      return texto("Hola, ¿qué le gustaría pedir?");
    }, { turnBudgetMs: 150 });
    const t0 = Date.now();
    const r = await turnoSimple(f, handler as never);
    expect(r.reply).toBeTruthy(); // control: contesta algo
    expect(Date.now() - t0).toBeLessThan(700);
  });

  it("(control) con presupuesto agotado ANTES de llamar, no se llama al proveedor y se avisa al equipo", async () => {
    const f = buildRestaurantFixture();
    const { handler, provider } = handlerConGuion(f.repo, () => texto("no debe llamarse"), { turnBudgetMs: -1 });
    const r = await turnoSimple(f, handler as never);
    expect(provider.callCount).toBe(0);
    expect(r.reply).toContain("problema técnico");
  });
});

describe("R11-4D la base falla en medio del turno", () => {
  it("una herramienta que lanza un error NO de negocio (base caida) se reporta al modelo como error interno, sin datos del cliente, y el turno termina", async () => {
    const f = buildRestaurantFixture();
    vi.spyOn(f.repo, "findBranch").mockRejectedValue(new Error("connection terminated unexpectedly (+5219990001111)"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let visto = "";
    const { handler } = handlerConGuion(f.repo, (req) => {
      if (pasoDelTurno(req) === 0) return llamada("consultar_sucursal", { branch_slug: "fco-montejo" });
      visto = req.messages.filter((m) => m.role === "tool").map((m) => m.content).join("");
      return texto("Disculpe, tengo un problema para consultar la sucursal. ¿Desea recoger?");
    });
    const r = await turnoSimple(f, handler as never);
    expect(visto).toContain("Error interno");
    expect(visto).not.toContain("5219990001111"); // el detalle de la excepcion no llega al modelo
    expect(r.reply).toContain("problema");
    errorLog.mockRestore();
  });

  it("si la base cae ANTES del primer mensaje al modelo, el webhook marca el mensaje reintentable y el reintento (base ya sana) contesta una vez", async () => {
    const f = buildRestaurantFixture();
    const { handler, provider } = handlerConGuion(f.repo, () => texto("Hola, ¿qué le gustaría pedir?"));
    const caida = vi.spyOn(f.repo, "listBranchesForOrganization").mockRejectedValueOnce(new Error("base caida"));
    const args = { organizationId: f.organizationId, messageId: "wamid.r11-base-caida", phone: PHONE, body: "hola", phoneNumberId: "pn-1" };
    const primero = await handleInboundWhatsAppMessage(f.repo, handler, args);
    expect(primero).toMatchObject({ ok: false, retryable: true });
    caida.mockRestore();
    const segundo = await handleInboundWhatsAppMessage(f.repo, handler, args);
    expect(segundo.ok).toBe(true);
    expect(segundo.reply).toBe("Hola, ¿qué le gustaría pedir?");
    expect(provider.callCount).toBe(1);
  });

  it("crear_pedido falla por la base: el cliente NO lee 'su pedido quedo registrado' y no hay pedido", async () => {
    const f = buildRestaurantFixture();
    const { seedConfirmedOrderFlow } = await import("../support/order-flow-seed.ts");
    await seedConfirmedOrderFlow(f.repo, f.organizationId, `wa:${PHONE}`, { branchSlug: "fco-montejo", canal: "recoger", items: [{ productId: f.products.cocaCola, productName: "Coca-Cola", requestedQuantity: 2 }] });
    vi.spyOn(f.repo, "upsertCustomer").mockRejectedValue(new Error("base caida"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { handler } = handlerConGuion(f.repo, (req) =>
      pasoDelTurno(req) === 0 ? llamada("crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Ana", payment_method: "efectivo", items: itemsCoca(f, 2) }) : texto("Listo, su pedido quedó registrado y ya está en cocina."),
    );
    const r = await handler.handleInboundMessage({
      organizationId: f.organizationId,
      phone: PHONE,
      messages: [{ role: "user", content: "dos coca para recoger" }, { role: "assistant", content: "Total $90. ¿Confirma?" }, { role: "user", content: "si" }],
      customer: NEW_CUSTOMER,
    });
    expect(r.orderId).toBeNull();
    expect(await ordenes(f)).toHaveLength(0);
    expect(r.reply).not.toMatch(/qued[óo] registrado|ya est[áa] en cocina/i);
  });
});

describe("R11-4E herramientas en masa dentro de UNA respuesta del modelo", () => {
  // ── HALLAZGO R11-05 (P2, abuso de costo / avisos): no hay tope de herramientas por respuesta ──
  // `maxToolUseTurns` limita las VUELTAS (8 en PM), no cuantas herramientas trae cada respuesta: un modelo inducido puede pedir cientos en una
  // sola, y cada una consulta la base. Las `escalar_a_humano` con motivos distintos generan un aviso al equipo cada una.
  hallazgo("R11-05a [P2] una respuesta con 80 tool_calls no ejecuta mas de 16 herramientas", async () => {
    const f = buildRestaurantFixture();
    const espia = vi.spyOn(f.repo, "findBranch");
    const { handler } = handlerConGuion(f.repo, (req) =>
      pasoDelTurno(req) === 0 ? llamadas(Array.from({ length: 80 }, () => ({ name: "consultar_sucursal", args: { branch_slug: "fco-montejo" } }))) : texto("Abrimos de 12 a 1."),
    );
    await turnoSimple(f, handler as never);
    expect(espia.mock.calls.length).toBeGreaterThan(0); // control: si se ejecutaron herramientas
    expect(espia.mock.calls.length).toBeLessThanOrEqual(16);
  });

  hallazgo("R11-05b [P2] una respuesta con 11 'escalar_a_humano' de motivos distintos genera a lo mas 3 avisos al equipo", async () => {
    const f = buildRestaurantFixture();
    const motivos = ["queja", "alergia_salud", "cobro_duplicado", "urgencia", "transferencia", "producto_agotado", "zona_no_reconocida", "no_entiende", "falla_sistema", "tiempos_entrega", "privacidad_arco"];
    const { handler } = handlerConGuion(f.repo, (req) =>
      pasoDelTurno(req) === 0 ? llamadas(motivos.map((motivo) => ({ name: "escalar_a_humano", args: { customer_name: "Ana", motivo, resumen: "x" } }))) : texto("Ya avisé al equipo."),
    );
    await turnoSimple(f, handler as never);
    const avisos = f.repo.listCallbackRequests(f.organizationId).length;
    expect(avisos).toBeGreaterThan(0); // control
    expect(avisos).toBeLessThanOrEqual(3);
  });

  it("(control) la MISMA escalacion repetida 30 veces en el mismo turno deja UN solo aviso (idempotente por evento y motivo)", async () => {
    const f = buildRestaurantFixture();
    const { handler } = handlerConGuion(f.repo, (req) =>
      pasoDelTurno(req) === 0 ? llamadas(Array.from({ length: 30 }, () => ({ name: "escalar_a_humano", args: { customer_name: "Ana", motivo: "queja", resumen: "x" } }))) : texto("Ya avisé al equipo."),
    );
    await handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: [{ role: "user", content: "hola" }], customer: NEW_CUSTOMER, messageId: "wamid.r11-esc" });
    expect(f.repo.listCallbackRequests(f.organizationId)).toHaveLength(1);
  });
});
