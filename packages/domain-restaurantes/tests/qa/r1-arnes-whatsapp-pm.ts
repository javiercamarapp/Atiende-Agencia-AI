// Arnes compartido de las pruebas de regresion del lote QA R1 "agente de WhatsApp: guardias y reglas duras" (restaurantes).
// Agente de WhatsApp sobre el catalogo y las reglas REALES de Los Taquitos de PM (plan del seed DEMO-PM: T7 Garcia Lavin,
// fracciones de kilo, extras a $19, minimo $200 a domicilio, horario 12:00-01:00, 2x1 del lunes solo para recoger), con LLM
// GUIONADO (FakeLlmProvider): el guion emite tool calls y texto, incluso erroneo a proposito; las reglas tienen que vivir en
// el servidor. Todo en memoria: ni base real, ni red, ni Meta. Telefonos sinteticos 52199900000xx.
import { vi } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { loadSeedInputs } from "../../../../scripts/seed-pm-demo/seed-pm-demo.ts";
import { buildPmSeedPlan } from "../../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../../src/seed/pm-world.ts";
import type { PmWorld } from "../../src/seed/pm-world.ts";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { handleInboundWhatsAppMessage } from "../../src/whatsapp/inbound.ts";
import { InMemoryConversacionesRepository, InMemoryHandoffAgentGate } from "../../src/conversaciones/index.ts";
import { InMemoryPrivacidadRepository } from "../../src/privacidad/in-memory-repository.ts";

/** Martes 13-oct-2026 14:00 en Merida (UTC-6): abierto, sin 2x1. */
export const MARTES_14 = "2026-10-13T20:00:00.000Z";
/** Lunes 12-oct-2026 14:00 en Merida: dia del 2x1 de pastor (solo recoger, en T3 Pensiones). */
export const LUNES_14 = "2026-10-12T20:00:00.000Z";
export const STAFF = "00000000-0000-4000-8000-0000000000f1";
export const PNID_T7 = "5550007007";

const { data, agent } = loadSeedInputs();
export const plan = buildPmSeedPlan(data, agent);

export type Paso = (req: LlmCompletionRequest) => LlmCompletionResult;
export const base = { model: "fake/qa", tokensIn: 1, tokensOut: 1, costUsd: 0 };
export const say = (text: string): Paso => () => ({ text, ...base });
export const call = (name: string, args: Record<string, unknown>): Paso => () => ({ text: "", toolCalls: [{ id: `c-${name}-${Math.random().toString(36).slice(2, 7)}`, name, argumentsJson: JSON.stringify(args) }], ...base });
export function lastTool(req: LlmCompletionRequest): Record<string, unknown> {
  const m = [...req.messages].reverse().find((x) => x.role === "tool");
  return m && m.role === "tool" ? (JSON.parse(m.content) as Record<string, unknown>) : {};
}
/** Registra en `seen` el resultado de la tool anterior y responde texto. */
export const sayObs = (seen: unknown[], text: string): Paso => (req) => {
  seen.push(lastTool(req));
  return { text, ...base };
};
export const callObs = (seen: unknown[], name: string, args: Record<string, unknown>): Paso => (req) => {
  if (req.messages.some((m) => m.role === "tool")) seen.push(lastTool(req));
  return call(name, args)(req);
};

export interface Banco {
  readonly w: PmWorld;
  readonly t7: string;
  readonly t3: string;
  readonly pid: (nombre: string) => string;
  readonly llamadasLlm: () => number;
  /** Proveedor (rol) que atendio cada llamada al modelo: "qa" = barato, "qa-escalado" = caro. */
  readonly roles: () => readonly string[];
  readonly setGuion: (pasos: readonly Paso[]) => void;
  readonly enviar: (phone: string, body: string, messageId?: string) => ReturnType<typeof handleInboundWhatsAppMessage>;
  readonly handler: ReturnType<typeof createLlmWhatsAppTurnHandler>;
  readonly conversaciones: InMemoryConversacionesRepository;
  readonly gate: { estadoParaAgente: InMemoryHandoffAgentGate["estadoParaAgente"]; solicitarHumano: InMemoryHandoffAgentGate["solicitarHumano"] };
  readonly privacidad: InMemoryPrivacidadRepository;
  readonly callbacks: () => ReadonlyArray<{ reason?: string; message?: string; propertyId: string | null; customerPhone: string }>;
}

export async function banco(opts: { readonly now?: string; readonly killSwitch?: boolean; readonly proveedorCae?: boolean; readonly handlerOptions?: Partial<Parameters<typeof createLlmWhatsAppTurnHandler>[2]> } = {}): Promise<Banco> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(opts.now ?? MARTES_14));
  const w = await buildInMemoryPmWorld(plan);
  const t7 = w.propertyBySlug.get("garcia-lavin")!;
  const t3 = w.propertyBySlug.get("pensiones")!;
  w.repo.seedWhatsAppBranchChannel(w.organizationId, t7, PNID_T7);
  let guion: readonly Paso[] = [];
  let cursor = 0;
  let n = 0;
  const roles: string[] = [];
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
    ...(opts.killSwitch ? { killSwitch: { blockedBy: async () => "agentes_llm" } } : {}),
  });
  const guionado = (id: string) =>
    new FakeLlmProvider({
      id,
      script: (req) => {
        n += 1;
        roles.push(id);
        if (opts.proveedorCae) throw new Error("proveedor caido (simulado)");
        const paso = guion[Math.min(cursor++, guion.length - 1)];
        if (!paso) throw new Error("guion vacio");
        return paso(req);
      },
    });
  // El rol escalado (turno siguiente a un error de crear_pedido) sigue el MISMO guion: el banco mide al servidor, no al modelo.
  gateway.registerLadder("default", [guionado("qa")]);
  gateway.registerLadder("escalated", [guionado("qa-escalado")]);
  const handler = createLlmWhatsAppTurnHandler(w.repo, gateway, { defaultRole: "default", escalatedRole: "escalated", ...(opts.handlerOptions ?? {}) });
  const conversaciones = new InMemoryConversacionesRepository({ actorUserId: STAFF, actorEsAdministrador: true });
  const gateBase = new InMemoryHandoffAgentGate(conversaciones);
  const gate = {
    estadoParaAgente: (org: string, phone: string) => gateBase.estadoParaAgente(org, phone),
    solicitarHumano: (input: { organizationId: string; propertyId: string | null; phone: string; motivo: string }) => {
      if (!conversaciones.conversaciones.some((c) => c.telefono === input.phone)) {
        conversaciones.conversaciones.push({ canal: "whatsapp", id: crypto.randomUUID(), organizationId: input.organizationId, propertyId: input.propertyId ?? t7, telefono: input.phone, mensajes: [], actividadAt: new Date().toISOString() });
      }
      return gateBase.solicitarHumano({ ...input, propertyId: input.propertyId ?? t7 });
    },
  };
  const privacidad = new InMemoryPrivacidadRepository();
  let msg = 0;
  return {
    w,
    t7,
    t3,
    pid: (nombre) => {
      const id = w.productIds.get(nombre);
      if (!id) throw new Error(`producto no sembrado: ${nombre}`);
      return id;
    },
    llamadasLlm: () => n,
    roles: () => roles,
    setGuion: (pasos) => {
      guion = pasos;
      cursor = 0;
    },
    enviar: (phone, body, messageId) =>
      handleInboundWhatsAppMessage(w.repo, handler, { organizationId: w.organizationId, messageId: messageId ?? `wamid.qa.${++msg}`, phone, body, phoneNumberId: PNID_T7, propertyId: t7, handoffGate: gate, privacy: privacidad }),
    handler,
    conversaciones,
    gate,
    privacidad,
    callbacks: () => (w.repo as unknown as { callbackRequests: Array<{ reason?: string; message?: string; propertyId: string | null; customerPhone: string }> }).callbackRequests,
  };
}


export const item = (id: string, name: string, q: number, tortilla?: "maiz" | "harina" | "mixta") => ({ product_id: id, product_name: name, requested_quantity: q, ...(tortilla ? { tortilla } : {}) });

