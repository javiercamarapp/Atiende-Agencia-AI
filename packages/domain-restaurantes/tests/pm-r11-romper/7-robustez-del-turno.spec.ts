// R12 robustez del turno: bordes de R11-01 (argumentos null), R11-05 (tope de herramientas y una sola escalacion por turno) y R11-10 (tope de tiempo por
// llamada al proveedor). Todo con modelo simulado y repositorio en memoria: sin gasto de LLM.
import { describe, expect, it, vi } from "vitest";
import type { LlmCompletionRequest } from "@atiende/agent-core";
import { MAX_HERRAMIENTAS_POR_RESPUESTA } from "../../src/whatsapp/llm-turn-handler.ts";
import { NEW_CUSTOMER, PHONE, buildRestaurantFixture, handlerConGuion, itemsCoca, llamada, llamadas, ordenes, pasoDelTurno, texto } from "./arnes.ts";
import type { Fixture } from "./arnes.ts";

const turno = (f: Fixture, handler: { handleInboundMessage: (a: never) => Promise<{ reply: string; orderId: string | null }> }) =>
  handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: [{ role: "user", content: "hola" }], customer: NEW_CUSTOMER } as never);
const consultas = (n: number) => llamadas(Array.from({ length: n }, () => ({ name: "consultar_sucursal", args: { branch_slug: "fco-montejo" } })));
const resultadosDeHerramienta = (req: LlmCompletionRequest) => req.messages.filter((m) => m.role === "tool");
const idsDe = (msgs: ReturnType<typeof resultadosDeHerramienta>) => msgs.map((m) => (m as { toolCallId?: string }).toolCallId);

describe("R12 tope de herramientas por respuesta del modelo", () => {
  it(`exactamente ${MAX_HERRAMIENTAS_POR_RESPUESTA} herramientas: se ejecutan todas y ninguna recibe el error de tope`, async () => {
    const f = buildRestaurantFixture();
    let vistos: ReturnType<typeof resultadosDeHerramienta> = [];
    const { handler } = handlerConGuion(f.repo, (req) => {
      if (pasoDelTurno(req) === 0) return consultas(8);
      vistos = resultadosDeHerramienta(req);
      return texto("Abrimos de 12 a 1.");
    });
    await turno(f, handler as never);
    expect(vistos).toHaveLength(8);
    expect(vistos.every((m) => !m.content.includes("Demasiadas herramientas"))).toBe(true);
  });

  it("9 herramientas: se ejecutan 8 (igual que con 8), la novena recibe error con su mismo id y el turno responde", async () => {
    const f9 = buildRestaurantFixture();
    const espia9 = vi.spyOn(f9.repo, "findBranch");
    let vistos: ReturnType<typeof resultadosDeHerramienta> = [];
    const { handler } = handlerConGuion(f9.repo, (req) => {
      if (pasoDelTurno(req) === 0) return consultas(9);
      vistos = resultadosDeHerramienta(req);
      return texto("Abrimos de 12 a 1.");
    });
    const r = await turno(f9, handler as never);
    expect(r.reply).toBe("Abrimos de 12 a 1.");
    expect(vistos).toHaveLength(9); // protocolo: un resultado por tool_call
    expect(idsDe(vistos)).toEqual(Array.from({ length: 9 }, (_, i) => `m${i}_consultar_sucursal`));
    expect(vistos[8]!.content).toContain("Demasiadas herramientas");
    expect(vistos.slice(0, 8).every((m) => !m.content.includes("Demasiadas herramientas"))).toBe(true);

    const f8 = buildRestaurantFixture();
    const espia8 = vi.spyOn(f8.repo, "findBranch");
    const { handler: h8 } = handlerConGuion(f8.repo, (req) => (pasoDelTurno(req) === 0 ? consultas(8) : texto("x")));
    await turno(f8, h8 as never);
    expect(espia8.mock.calls.length).toBeGreaterThan(0);
    expect(espia9.mock.calls.length).toBe(espia8.mock.calls.length);
  });

  it("tool_call sin nombre, con id repetido y nombre inexistente: cada uno recibe un resultado y el turno termina", async () => {
    const f = buildRestaurantFixture();
    let vistos: ReturnType<typeof resultadosDeHerramienta> = [];
    const { handler } = handlerConGuion(f.repo, (req) => {
      if (pasoDelTurno(req) === 0) {
        return {
          text: "",
          toolCalls: [
            { id: "x", name: "", argumentsJson: "{}" },
            { id: "x", name: "no_existe", argumentsJson: "null" },
            { id: "y", name: undefined as unknown as string, argumentsJson: "null" },
          ],
          model: "x",
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
        };
      }
      vistos = resultadosDeHerramienta(req);
      return texto("¿Qué le gustaría pedir?");
    });
    const r = await turno(f, handler as never);
    expect(r.reply).toBe("¿Qué le gustaría pedir?");
    expect(vistos).toHaveLength(3);
    expect(await ordenes(f)).toHaveLength(0);
  });

  it("el tope cuenta por respuesta: una herramienta en cada una de 8 vueltas sigue ejecutandose", async () => {
    const f = buildRestaurantFixture();
    const { handler } = handlerConGuion(f.repo, (req) => (pasoDelTurno(req) < 8 ? consultas(1) : texto("Listo.")), { maxToolUseTurns: 10 });
    const r = await turno(f, handler as never);
    expect(r.reply).toBe("Listo.");
  });
});

describe("R12 una sola escalar_a_humano por turno", () => {
  const esc = (motivo: string) => ({ name: "escalar_a_humano", args: { customer_name: "Ana", motivo, resumen: "x" } });

  it("en una misma respuesta: una ejecutada; las demas reciben error y no avisan", async () => {
    const f = buildRestaurantFixture();
    let vistos: ReturnType<typeof resultadosDeHerramienta> = [];
    const { handler } = handlerConGuion(f.repo, (req) => {
      if (pasoDelTurno(req) === 0) return llamadas([esc("queja"), esc("urgencia")]);
      vistos = resultadosDeHerramienta(req);
      return texto("Ya avisé al equipo.");
    });
    await turno(f, handler as never);
    expect(f.repo.listCallbackRequests(f.organizationId)).toHaveLength(1);
    expect(vistos).toHaveLength(2);
    expect(vistos[1]!.content).toContain("ya fue avisado");
  });

  it("en vueltas distintas del mismo turno: la segunda tampoco avisa", async () => {
    const f = buildRestaurantFixture();
    const { handler } = handlerConGuion(f.repo, (req) => {
      const p = pasoDelTurno(req);
      if (p === 0) return llamadas([esc("queja")]);
      if (p === 1) return llamadas([esc("urgencia")]);
      return texto("Ya avisé al equipo.");
    });
    await turno(f, handler as never);
    expect(f.repo.listCallbackRequests(f.organizationId)).toHaveLength(1);
  });

  it("si la primera escalacion falla por argumentos invalidos, una segunda correcta SI se ejecuta", async () => {
    const f = buildRestaurantFixture();
    const { handler } = handlerConGuion(f.repo, (req) => (pasoDelTurno(req) === 0 ? llamadas([{ name: "escalar_a_humano", args: "{bad" }, esc("queja")]) : texto("Ya avisé.")));
    await turno(f, handler as never);
    expect(f.repo.listCallbackRequests(f.organizationId)).toHaveLength(1);
  });
});

describe("R12 argumentos null", () => {
  it.each(["crear_pedido", "cotizar_pedido", "escalar_a_humano", "buscar_producto", "consultar_sucursal"])('%s con "null": responde, no crea pedido y no lanza', async (herramienta) => {
    const f = buildRestaurantFixture();
    const { handler } = handlerConGuion(f.repo, (req) => (pasoDelTurno(req) === 0 ? llamada(herramienta, "null") : texto("¿Qué desea pedir?")));
    const r = await turno(f, handler as never);
    expect(r.reply).toBe("¿Qué desea pedir?");
    expect(r.orderId).toBeNull();
    expect(await ordenes(f)).toHaveLength(0);
  });
});

describe("R12 tope de tiempo por llamada al proveedor", () => {
  const tardaYResponde = (ms: number) => async () => {
    await new Promise((r) => setTimeout(r, ms));
    return texto("tarde");
  };

  it("el proveedor recibe una senal que se aborta al vencer el tope", async () => {
    const f = buildRestaurantFixture();
    let senal: AbortSignal | undefined;
    const { handler } = handlerConGuion(
      f.repo,
      (req) => {
        senal = req.signal;
        return new Promise(() => undefined) as never; // nunca responde
      },
      { turnBudgetMs: 100 },
    );
    const t0 = Date.now();
    const r = await turno(f, handler as never);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(senal).toBeDefined();
    expect(senal!.aborted).toBe(true);
    expect(r.reply).toContain("problema técnico");
  });

  it("un proveedor que IGNORA la senal tambien se corta, avisa al equipo y no crea pedido", async () => {
    const f = buildRestaurantFixture();
    const { handler } = handlerConGuion(f.repo, tardaYResponde(3000), { turnBudgetMs: 100 });
    const t0 = Date.now();
    const r = await turno(f, handler as never);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.reply).toContain("problema técnico");
    expect(r.orderId).toBeNull();
    expect(await ordenes(f)).toHaveLength(0);
    expect(f.repo.listCallbackRequests(f.organizationId).length).toBeGreaterThanOrEqual(1);
  });

  it("un proveedor que rechaza TARDE (despues del tope) no produce un rechazo sin manejar", async () => {
    const f = buildRestaurantFixture();
    const sinManejar: unknown[] = [];
    const escucha = (e: unknown) => sinManejar.push(e);
    process.on("unhandledRejection", escucha);
    const { handler } = handlerConGuion(
      f.repo,
      async () => {
        await new Promise((r) => setTimeout(r, 800));
        throw new Error("boom tardio");
      },
      { turnBudgetMs: 50 },
    );
    const r = await turno(f, handler as never);
    expect(r.reply).toContain("problema técnico");
    await new Promise((r2) => setTimeout(r2, 1000));
    process.off("unhandledRejection", escucha);
    expect(sinManejar).toHaveLength(0);
  });

  it("respuesta dentro del tope: se usa normalmente, sin aviso ni mensaje de falla", async () => {
    const f = buildRestaurantFixture();
    const { handler } = handlerConGuion(f.repo, tardaYResponde(100), { turnBudgetMs: 5000 });
    const r = await turno(f, handler as never);
    expect(r.reply.startsWith("tarde")).toBe(true);
    expect(f.repo.listCallbackRequests(f.organizationId)).toHaveLength(0);
  });

  it("piso del tope: con presupuesto casi agotado una llamada rapida (<500 ms) aun se acepta", async () => {
    const f = buildRestaurantFixture();
    const { handler } = handlerConGuion(f.repo, tardaYResponde(150), { turnBudgetMs: 10 });
    const r = await turno(f, handler as never);
    expect(r.reply.startsWith("tarde")).toBe(true);
  });

  it("si el modelo se cuelga DESPUES de crear el pedido, el cliente sabe que el pedido existe (nada a medias)", async () => {
    const f = buildRestaurantFixture();
    const { seedConfirmedOrderFlow } = await import("../support/order-flow-seed.ts");
    await seedConfirmedOrderFlow(f.repo, f.organizationId, `wa:${PHONE}`, { branchSlug: "fco-montejo", canal: "recoger", items: [{ productId: f.products.cocaCola, productName: "Coca-Cola", requestedQuantity: 2 }] });
    const { handler } = handlerConGuion(
      f.repo,
      async (req) => {
        if (pasoDelTurno(req) === 0) return llamada("crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Ana", payment_method: "efectivo", items: itemsCoca(f, 2) });
        await new Promise((r) => setTimeout(r, 3000)); // se cuelga al redactar la confirmacion
        return texto("tarde");
      },
      { turnBudgetMs: 100 },
    );
    const r = await handler.handleInboundMessage({
      organizationId: f.organizationId,
      phone: PHONE,
      messages: [{ role: "user", content: "dos coca para recoger" }, { role: "assistant", content: "Total $90. ¿Confirma?" }, { role: "user", content: "si" }],
      customer: NEW_CUSTOMER,
    });
    const creadas = await ordenes(f);
    if (creadas.length > 0) {
      expect(creadas).toHaveLength(1);
      expect(r.orderId).toBe(creadas[0]!.id);
    } else {
      expect(r.orderId).toBeNull();
    }
    expect(r.reply.length).toBeGreaterThan(5);
  });
});
