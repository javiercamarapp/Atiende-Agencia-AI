// Arnes de pruebas del agente de reservas: LLM FALSO con guion (nunca llamadas reales), repos en memoria y espias del handoff.
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { CircuitBreaker, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway, FakeLlmProvider } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { createLlmHotelesWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { InMemoryHotelesRepository } from "../../src/in-memory-repository.ts";
import { InMemoryReservasAgenteRepository } from "../../src/reservas-agente/in-memory-repository.ts";
import type { ContactoNoOperativoRecord, NewContactoNoOperativoInput } from "../../src/types.ts";

export const NOW = new Date("2031-06-01T18:00:00Z");
export const PHONE_A = "+5219991110001";
export const PHONE_B = "+5219991110002";

export type ScriptStep =
  | { readonly text: string }
  | { readonly tools: ReadonlyArray<{ readonly name: string; readonly args: unknown }> }
  | ((req: LlmCompletionRequest, results: readonly ToolResult[]) => { readonly text: string } | { readonly tools: ReadonlyArray<{ readonly name: string; readonly args: unknown }> });

export interface ToolResult {
  readonly toolCallId: string;
  readonly json: Record<string, unknown>;
}

export interface World {
  readonly hoteles: InMemoryHotelesRepository;
  readonly reservas: InMemoryReservasAgenteRepository;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly otherPropertyId: string;
  readonly doble: string;
  readonly suite: string;
  readonly handoffs: NewContactoNoOperativoInput[];
  /** Herramientas ofrecidas al modelo en cada peticion. */
  readonly toolNamesSeen: string[][];
  readonly systemPrompts: string[];
  run(script: readonly ScriptStep[], opts?: { readonly phone?: string; readonly userText?: string; readonly maxToolUseTurns?: number }): Promise<{ reply: string; results: ToolResult[]; handoff?: { readonly motivo: string } }>;
}

export function makeWorld(opts: { readonly holdsEnabled?: boolean; readonly mode?: "aprobacion_humana" | "link_pago"; readonly timezone?: string; readonly withReservasPort?: boolean } = {}): World {
  const hoteles = new InMemoryHotelesRepository();
  const reservas = new InMemoryReservasAgenteRepository();
  reservas.clock = () => NOW;
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  const otherPropertyId = randomUUID();
  const doble = randomUUID();
  const suite = randomUUID();
  const otherDoble = randomUUID();
  reservas.seedProperty(propertyId, { organizationId, timezone: opts.timezone ?? "America/Mexico_City" });
  reservas.seedRoomType(propertyId, doble, "Doble", 2);
  reservas.seedRoomType(propertyId, suite, "Suite", 4);
  reservas.seedInventory(propertyId, doble, "2031-06-01", "2031-07-15", 2, 150_000);
  reservas.seedInventory(propertyId, suite, "2031-06-01", "2031-07-15", 1, 500_000);
  reservas.setPriceGuard(propertyId, suite, 100_000, 300_000); // la tarifa publicada (5000) queda FUERA del techo (3000)
  reservas.seedProperty(otherPropertyId);
  reservas.seedRoomType(otherPropertyId, otherDoble, "Doble", 2);
  reservas.seedInventory(otherPropertyId, otherDoble, "2031-06-01", "2031-07-15", 5, 90_000);
  void hoteles.upsertPropertyTimezone(propertyId, organizationId, opts.timezone ?? "America/Mexico_City", randomUUID());
  if (opts.holdsEnabled !== false) reservas.setPolicy(propertyId, { holdsEnabled: true, mode: opts.mode ?? "aprobacion_humana" });

  const handoffs: NewContactoNoOperativoInput[] = [];
  const original = hoteles.insertContactoNoOperativo.bind(hoteles);
  vi.spyOn(hoteles, "insertContactoNoOperativo").mockImplementation(async (input: NewContactoNoOperativoInput): Promise<ContactoNoOperativoRecord> => {
    handoffs.push(input);
    return original(input);
  });

  const toolNamesSeen: string[][] = [];
  const systemPrompts: string[] = [];

  async function run(script: readonly ScriptStep[], runOpts: { phone?: string; userText?: string; maxToolUseTurns?: number } = {}) {
    const results: ToolResult[] = [];
    let step = 0;
    const gateway = new LlmGateway({
      breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
      budgetStore: new InMemoryBudgetLedgerStore(),
      budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
    });
    const provider = new FakeLlmProvider({
      id: "script",
      script: (req): LlmCompletionResult => {
        toolNamesSeen.push((req.tools ?? []).map((t) => t.name));
        systemPrompts.push(req.system);
        // Resultados de herramienta ya entregados al modelo (el ultimo bloque de mensajes `tool`).
        const seen: ToolResult[] = [];
        for (const m of req.messages) {
          if (m.role === "tool") {
            try {
              seen.push({ toolCallId: m.toolCallId, json: JSON.parse(m.content) as Record<string, unknown> });
            } catch {
              // ignorar
            }
          }
        }
        results.splice(0, results.length, ...seen);
        const raw = script[Math.min(step, script.length - 1)]!;
        step += 1;
        const resolved = typeof raw === "function" ? raw(req, seen) : raw;
        if ("text" in resolved) return { text: resolved.text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
        return {
          text: "",
          toolCalls: resolved.tools.map((t, i) => ({ id: `c${step}_${i}`, name: t.name, argumentsJson: typeof t.args === "string" ? t.args : JSON.stringify(t.args) })),
          model: "fake",
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
        };
      },
    });
    gateway.registerLadder("default", [provider]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmHotelesWhatsAppTurnHandler(hoteles, gateway, {
      defaultRole: "default",
      escalatedRole: "escalated",
      ...(runOpts.maxToolUseTurns ? { maxToolUseTurns: runOpts.maxToolUseTurns } : {}),
      ...(opts.withReservasPort === false ? {} : { reservas }),
      now: () => NOW,
    });
    const out = await handler.handleInboundMessage({
      organizationId,
      propertyId,
      phone: runOpts.phone ?? PHONE_A,
      messages: [{ role: "user", content: runOpts.userText ?? "quiero reservar" }],
    });
    // El ultimo `results` conocido se refresca con los mensajes del ultimo request; completa con lo ejecutado en el ultimo paso.
    return { reply: out.reply, results, ...(out.handoff ? { handoff: out.handoff } : {}) };
  }

  return { hoteles, reservas, organizationId, propertyId, otherPropertyId, doble, suite, handoffs, toolNamesSeen, systemPrompts, run };
}

export const tool = (name: string, args: unknown) => ({ tools: [{ name, args }] }) as const;
export const say = (text: string) => ({ text }) as const;

/** Atajo: el primer `tool` result del turno (ya JSON). */
export function firstResult(results: readonly ToolResult[]): Record<string, unknown> {
  return results[0]?.json ?? {};
}

export const STAY = { fecha_llegada: "2031-06-12", fecha_salida: "2031-06-14" } as const;
export const QUOTED_TOTAL = 357_000; // 2 noches x 1500.00 + IVA 16 % + ISH 3 %
