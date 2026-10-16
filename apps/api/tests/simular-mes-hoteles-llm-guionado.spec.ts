// El doble de OpenRouter de la simulacion de hoteles: el proveedor REAL (OpenRouterProvider) debe poder hablar con el, decidir la herramienta
// por lo que dice el huesped y encadenar disponibilidad -> cotizacion -> pre-reserva con los ids que devolvieron las herramientas.
import { describe, expect, it } from "vitest";
import { OpenRouterProvider } from "@atiende/agent-core";
import { instalarGuardaRed } from "../../../scripts/simular-mes-hoteles/guarda-red.ts";
import { LlmGuionado } from "../../../scripts/simular-mes-hoteles/llm-guionado.ts";

const TOOLS = ["crear_ticket_huesped_fnb", "crear_ticket_mantenimiento", "registrar_contacto_no_operativo", "consultar_disponibilidad", "cotizar_estancia", "crear_pre_reserva"].map((name) => ({ name, description: name, parameters: { type: "object", properties: {} } }));

function proveedor(llm: LlmGuionado) {
  return new OpenRouterProvider({ id: "sim", apiKey: "sk-sin-valor", model: "sim/modelo", fetchImpl: async (_u, init) => llm.responder(String(init?.body ?? "")), maxRetries: 0 });
}

describe("LlmGuionado con el proveedor real", () => {
  it("pedido de comida -> crear_ticket_huesped_fnb con la alergia marcada; con el resultado de la herramienta, cierra con texto", async () => {
    const llm = new LlmGuionado();
    const p = proveedor(llm);
    const r1 = await p.complete({ system: "s", messages: [{ role: "user", content: "Tengo alergia a los cacahuates, quiero cena. Habitacion 204." }], tools: TOOLS });
    expect(r1.toolCalls?.[0]?.name).toBe("crear_ticket_huesped_fnb");
    expect(JSON.parse(r1.toolCalls![0]!.argumentsJson)).toMatchObject({ alergia_declarada: true, habitacion: "204" });
    const r2 = await p.complete({ system: "s", messages: [{ role: "user", content: "Tengo alergia a los cacahuates, quiero cena. Habitacion 204." }, { role: "assistant", content: "", toolCalls: r1.toolCalls }, { role: "tool", content: "{}", toolCallId: r1.toolCalls![0]!.id }], tools: TOOLS });
    expect(r2.toolCalls ?? []).toHaveLength(0);
    expect(r2.text.length).toBeGreaterThan(0);
    expect(llm.uso.llamadas).toBe(2);
    expect(llm.uso.tokensEntrada).toBeGreaterThan(0);
    expect(llm.herramientas).toEqual({ crear_ticket_huesped_fnb: 1 });
  });

  it("reservar: disponibilidad -> cotizacion -> pre-reserva, con el id de tipo y el total que devolvieron las herramientas", async () => {
    const llm = new LlmGuionado();
    const p = proveedor(llm);
    const msg = "Quiero reservar del 2026-10-20 al 2026-10-22, ¿me puede apartar una habitacion?";
    const base = [{ role: "user" as const, content: msg }];
    const a = await p.complete({ system: "s", messages: base, tools: TOOLS });
    expect(a.toolCalls?.[0]?.name).toBe("consultar_disponibilidad");
    const t1 = { role: "tool" as const, content: JSON.stringify({ tipos: [{ tipo_habitacion_id: "tipo-1", disponibles: 3 }] }), toolCallId: a.toolCalls![0]!.id };
    const b = await p.complete({ system: "s", messages: [...base, { role: "assistant", content: "", toolCalls: a.toolCalls }, t1], tools: TOOLS });
    expect(b.toolCalls?.[0]?.name).toBe("cotizar_estancia");
    const t2 = { role: "tool" as const, content: JSON.stringify({ total_centavos: 360000 }), toolCallId: b.toolCalls![0]!.id };
    const c = await p.complete({ system: "s", messages: [...base, { role: "assistant", content: "", toolCalls: a.toolCalls }, t1, { role: "assistant", content: "", toolCalls: b.toolCalls }, t2], tools: TOOLS });
    expect(c.toolCalls?.[0]?.name).toBe("crear_pre_reserva");
    expect(JSON.parse(c.toolCalls![0]!.argumentsJson)).toMatchObject({ tipo_habitacion_id: "tipo-1", total_cotizado_centavos: 360000, fecha_llegada: "2026-10-20", fecha_salida: "2026-10-22" });
  });
});

describe("guarda de red del simulador", () => {
  it("atiende solo los hosts doblados y rechaza (y registra) cualquier otro, sin red", async () => {
    const guarda = instalarGuardaRed([{ host: "openrouter.ai", responder: () => new Response("{}") }]);
    try {
      expect((await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: "{}" })).status).toBe(200);
      await expect(fetch("https://graph.facebook.com/v20.0/123/messages?access_token=x")).rejects.toThrow(/bloqueada/);
      expect(guarda.bloqueadas).toEqual([{ url: "https://graph.facebook.com/v20.0/123/messages" }]);
      expect(guarda.atendidasPorDoble).toEqual({ "openrouter.ai": 1 });
    } finally {
      guarda.desinstalar();
    }
  });
});
