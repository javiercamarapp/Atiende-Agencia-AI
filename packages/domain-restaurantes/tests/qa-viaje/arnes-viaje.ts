// QA R1 (lente "viaje completo") -- arnes de VIAJES de punta a punta de restaurantes sobre el catalogo y las reglas REALES de
// Los Taquitos de PM (plan del seed DEMO-PM -> repositorio en memoria real). Encadena lo mismo que la produccion: webhook de
// WhatsApp (dedupe, lease, aviso de privacidad, handoff) -> turno del agente con LLM GUIONADO (doble; nunca un modelo real) ->
// registro unico de tools (maquina cotizado -> confirmado -> creado) -> pedido -> cambios de estado del staff -> avisos al
// cliente (outbox, nada sale a Meta) -> KPIs. Sin red, sin base real, sin credenciales.
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { InMemoryConversacionesRepository, InMemoryHandoffAgentGate } from "../../src/conversaciones/index.ts";
import { InMemoryPrivacidadRepository } from "../../src/privacidad/in-memory-repository.ts";
import { buildPmSeedPlan } from "../../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld, type PmWorld } from "../../src/seed/pm-world.ts";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { handleInboundWhatsAppMessage } from "../../src/whatsapp/inbound.ts";
import type { CallbackRequestInput } from "../../src/types.ts";
import { loadSeedInputs } from "../../../../scripts/seed-pm-demo/seed-pm-demo.ts";

/** Martes 13-oct-2026 14:00 en Merida (UTC-6): T7 abierta (12:00-01:00), sin 2x1 de lunes. */
export const MARTES_14H = "2026-10-13T20:00:00Z";
/** Miercoles 14-oct-2026 02:30 en Merida: T7 ya cerro (cierra 01:00). */
export const MIERCOLES_0230 = "2026-10-14T08:30:00Z";

/** Telefonos de prueba (rango reservado del arnes, nunca de un cliente real). */
export const TEL_CLIENTE = "+5219995550111";
export const TEL_NUEVO = "+5219995550199";

export type PasoLlm = { readonly texto: string } | { readonly tools: ReadonlyArray<{ readonly name: string; readonly args: unknown }> };

function aResultado(paso: PasoLlm, n: number): LlmCompletionResult {
  const base = { model: "guion", tokensIn: 1, tokensOut: 1, costUsd: 0 };
  if ("texto" in paso) return { text: paso.texto, ...base };
  return { text: "", toolCalls: paso.tools.map((c, i) => ({ id: `t${n}-${i}`, name: c.name, argumentsJson: JSON.stringify(c.args) })), ...base };
}

let planCache: ReturnType<typeof buildPmSeedPlan> | null = null;
export function planPm() {
  if (!planCache) {
    const { data, agent } = loadSeedInputs();
    planCache = buildPmSeedPlan(data, agent);
  }
  return planCache;
}

export interface Viaje {
  readonly world: PmWorld;
  readonly t7: string;
  readonly conversaciones: InMemoryConversacionesRepository;
  readonly gate: InMemoryHandoffAgentGate;
  readonly privacidad: InMemoryPrivacidadRepository;
  /** Avisos al equipo (registrar_contacto / escalar_a_humano) que quedaron registrados, en orden. */
  readonly callbacks: CallbackRequestInput[];
  /** Requests que vio el "modelo" (para afirmar que el prompt/las tools llegaron). */
  readonly requests: LlmCompletionRequest[];
  /** Encola los pasos que el modelo guionado dara en el SIGUIENTE mensaje del cliente. */
  guion(pasos: readonly PasoLlm[]): void;
  /** El cliente escribe por WhatsApp al numero de T7. */
  escribe(body: string, opts?: { readonly messageId?: string; readonly phone?: string }): ReturnType<typeof handleInboundWhatsAppMessage>;
  producto(nombre: string): string;
}

/** Arma un viaje nuevo (mundo PM limpio). `conHandoff` siembra la conversacion en la bandeja para que el gate funcione. */
export async function nuevoViaje(opts: { readonly phone?: string } = {}): Promise<Viaje> {
  const world = await buildInMemoryPmWorld(planPm());
  const t7 = world.propertyBySlug.get("garcia-lavin")!;
  // Numero de WhatsApp de la sucursal (en produccion lo da el alta del canal de Meta; aqui un id ficticio del arnes).
  world.repo.seedWhatsAppBranchChannel(world.organizationId, t7, "qa-pn-t7");
  const phone = opts.phone ?? TEL_CLIENTE;
  const conversaciones = new InMemoryConversacionesRepository({ actorUserId: "00000000-0000-4000-8000-0000000000f1" });
  conversaciones.conversaciones.push({ canal: "whatsapp", id: "00000000-0000-4000-8000-0000000000c1", organizationId: world.organizationId, propertyId: t7, telefono: phone, mensajes: [], actividadAt: new Date().toISOString() });
  const gate = new InMemoryHandoffAgentGate(conversaciones);
  const privacidad = new InMemoryPrivacidadRepository();
  const callbacks: CallbackRequestInput[] = [];
  const original = world.repo.createCallbackRequest.bind(world.repo);
  world.repo.createCallbackRequest = async (input) => {
    callbacks.push(input);
    return original(input);
  };

  const cola: PasoLlm[] = [];
  const requests: LlmCompletionRequest[] = [];
  let n = 0;
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
  });
  gateway.registerLadder("default", [
    new FakeLlmProvider({
      id: "guion",
      script: (req) => {
        requests.push(req);
        const paso = cola.shift() ?? { texto: "¿Algo más en lo que le pueda ayudar?" };
        return aResultado(paso, n++);
      },
    }),
  ]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "guion-caro", script: (req) => (requests.push(req), aResultado(cola.shift() ?? { texto: "¿Algo más?" }, n++)) })]);
  const handler = createLlmWhatsAppTurnHandler(world.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
  let seq = 0;
  return {
    world,
    t7,
    conversaciones,
    gate,
    privacidad,
    callbacks,
    requests,
    guion: (pasos) => void cola.push(...pasos),
    escribe: (body, o = {}) =>
      handleInboundWhatsAppMessage(world.repo, handler, {
        organizationId: world.organizationId,
        messageId: o.messageId ?? `wamid.qa-viaje-${++seq}`,
        phone: o.phone ?? phone,
        body,
        phoneNumberId: "qa-pn-t7",
        propertyId: t7,
        handoffGate: gate,
        privacy: privacidad,
      }),
    producto: (nombre) => {
      const id = world.productIds.get(nombre);
      if (!id) throw new Error(`producto no sembrado: ${nombre}`);
      return id;
    },
  };
}

export async function pedidosDe(v: Viaje) {
  return (await v.world.repo.listOrders(v.world.organizationId, { propertyIds: null, limit: 100 })).orders;
}
