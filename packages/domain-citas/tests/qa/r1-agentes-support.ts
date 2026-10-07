// QA R1 (lente AGENTES, vertical citas) -- arnes compartido: un consultorio dental real sembrado en memoria (fixture de siempre, Merida,
// lunes a viernes 9-17), un LLM GUIONADO paso a paso sobre el LlmGateway real (sin red ni credenciales) y el webhook de dominio completo
// (`handleInboundWhatsAppMessage`: dedupe, lock, crisis, ARCO, handoff, turno, outbox). Nada toca una base real ni a Meta.
import { randomUUID } from "node:crypto";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { GatewayKillSwitch, LlmCompletionRequest, LlmCompletionResult, LlmToolCall } from "@atiende/agent-core";
import { InMemoryConversacionesRepository, InMemoryHandoffAgentGate } from "../../src/conversaciones/index.ts";
import { createDefaultConversationGuard, handleInboundWhatsAppMessage } from "../../src/whatsapp/inbound.ts";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { buildCitasFixture, nextWeekdayDateStr } from "../fixtures.ts";

export const PNID = "1234567890";

/** Un paso del modelo guionado: texto final, o llamadas a herramientas (los args pueden depender de lo que devolvio la herramienta anterior). */
export type PasoModelo = { readonly texto: string } | { readonly caido: true } | { readonly tools: ReadonlyArray<{ readonly name: string; readonly args: Record<string, unknown> | ((ctx: CtxPaso) => Record<string, unknown>) }> };

export interface CtxPaso {
  /** Resultado (ya parseado) de la ultima herramienta con ese nombre en ESTE turno. */
  ultimo(nombre: string): unknown;
  readonly request: LlmCompletionRequest;
}

function ctxDe(request: LlmCompletionRequest): CtxPaso {
  return {
    request,
    ultimo(nombre: string) {
      // Busca hacia atras el tool_call con ese nombre y su resultado.
      const msgs = request.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]!;
        if (m.role === "assistant" && m.toolCalls) {
          const call = m.toolCalls.find((c) => c.name === nombre);
          if (call) {
            const res = msgs.find((r) => r.role === "tool" && r.toolCallId === call.id);
            return res ? JSON.parse(res.content) : undefined;
          }
        }
      }
      return undefined;
    },
  };
}

export interface ModeloGuionado {
  readonly gateway: LlmGateway;
  readonly peticiones: LlmCompletionRequest[];
  /** Agrega pasos al guion (se consumen en orden, uno por llamada al modelo). */
  encolar(...pasos: PasoModelo[]): void;
  llamadas(): number;
}

export function modeloGuionado(opts: { readonly killSwitch?: GatewayKillSwitch; readonly fallar?: () => Error } = {}): ModeloGuionado {
  const cola: PasoModelo[] = [];
  const peticiones: LlmCompletionRequest[] = [];
  let n = 0;
  let caido = false;
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
    ...(opts.killSwitch ? { killSwitch: opts.killSwitch } : {}),
  });
  const script = (request: LlmCompletionRequest): LlmCompletionResult => {
    peticiones.push(request);
    n += 1;
    // Un paso `caido` deja al proveedor caido de ahi en adelante (presupuesto agotado / proveedor fuera a mitad de turno).
    if (caido) throw new Error("proveedor caido (simulado)");
    const paso = cola.shift() ?? { texto: "¿En qué más le ayudo?" };
    const base = { model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
    if ("caido" in paso) {
      caido = true;
      throw new Error("proveedor caido (simulado)");
    }
    if ("texto" in paso) return { text: paso.texto, ...base };
    const ctx = ctxDe(request);
    const toolCalls: LlmToolCall[] = paso.tools.map((t) => ({ id: `call_${randomUUID()}`, name: t.name, argumentsJson: JSON.stringify(typeof t.args === "function" ? t.args(ctx) : t.args) }));
    return { text: "", toolCalls, ...base } as LlmCompletionResult;
  };
  const proveedor = opts.fallar ? new FakeLlmProvider({ id: "p", failWith: opts.fallar }) : new FakeLlmProvider({ id: "p", script });
  gateway.registerLadder("default", [proveedor]);
  gateway.registerLadder("escalated", [opts.fallar ? new FakeLlmProvider({ id: "e", failWith: opts.fallar }) : new FakeLlmProvider({ id: "e", script })]);
  return { gateway, peticiones, encolar: (...p) => cola.push(...p), llamadas: () => n };
}

/** Consultorio + agente real con el modelo guionado + bandeja de handoff en memoria. */
export function montarConsultorio(opts: { readonly rubro?: string; readonly modelo?: ModeloGuionado; readonly telefono?: string } = {}) {
  const fixture = buildCitasFixture();
  fixture.repo.seedTenantConfig({ organizationId: fixture.organizationId, rubro: opts.rubro ?? "dental", defaultTimezone: "America/Merida", ownerNotificationPhone: "+5219990001111" });
  const modelo = opts.modelo ?? modeloGuionado();
  const handler = createLlmWhatsAppTurnHandler(fixture.repo, modelo.gateway, { defaultRole: "default", escalatedRole: "escalated" });
  const store = new InMemoryConversacionesRepository({ actorUserId: randomUUID(), nombres: {} });
  store.organizacionesConNumero.add(fixture.organizationId);
  const gate = new InMemoryHandoffAgentGate(store);
  const guard = createDefaultConversationGuard({});
  const telefono = opts.telefono ?? "+5219991234567";
  // La bandeja necesita la conversacion para abrir un handoff (en Postgres la crea el primer append).
  store.conversaciones.push({ id: randomUUID(), organizationId: fixture.organizationId, propertyId: null, telefono, mensajes: [], actividadAt: new Date().toISOString() });
  let seq = 0;
  const entrante = (body: string, o: { readonly messageId?: string; readonly phone?: string } = {}) =>
    handleInboundWhatsAppMessage(fixture.repo, handler, guard, { organizationId: fixture.organizationId, messageId: o.messageId ?? `wamid.${++seq}.${randomUUID()}`, phone: o.phone ?? telefono, body, phoneNumberId: PNID, handoffGate: gate });
  const lunes = nextWeekdayDateStr(new Date(), 1);
  const citas = async () => fixture.repo.listAppointmentsInRange(fixture.organizationId, "2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z", undefined, 500);
  const respuestasEnOutbox = () => fixture.repo.getOutbox().filter((o) => o.eventType === "whatsapp.inbound_reply");
  return { ...fixture, modelo, handler, store, gate, telefono, entrante, lunes, citas, respuestasEnOutbox };
}

/** `id` del primer elemento de una lista devuelta por listar_servicios / listar_proveedores. */
export function primerId(resultado: unknown): string {
  return (resultado as ReadonlyArray<{ readonly id: string }>)[0]!.id;
}

/** `appointment_id` de la primera cita que devolvio buscar_mis_citas en este turno. */
export function primeraCitaId(c: CtxPaso): string {
  return (c.ultimo("buscar_mis_citas") as { readonly appointments: ReadonlyArray<{ readonly appointment_id: string }> }).appointments[0]!.appointment_id;
}

/** Pasos tipicos del modelo bien portado. */
export const pasos = {
  listar: (): PasoModelo => ({ tools: [{ name: "listar_servicios", args: {} }, { name: "listar_proveedores", args: {} }] }),
  consultar: (fecha: string): PasoModelo => ({
    tools: [{ name: "consultar_disponibilidad", args: (c) => ({ provider_id: primerId(c.ultimo("listar_proveedores")), service_id: primerId(c.ultimo("listar_servicios")), date: fecha }) }],
  }),
  consultarIds: (providerId: string, serviceId: string, fecha: string): PasoModelo => ({ tools: [{ name: "consultar_disponibilidad", args: { provider_id: providerId, service_id: serviceId, date: fecha } }] }),
  crear: (providerId: string, serviceId: string, startsAt: string, nombre = "Ana Pech"): PasoModelo => ({ tools: [{ name: "crear_cita", args: { provider_id: providerId, service_id: serviceId, customer_name: nombre, starts_at: startsAt } }] }),
  buscar: (): PasoModelo => ({ tools: [{ name: "buscar_mis_citas", args: {} }] }),
  di: (texto: string): PasoModelo => ({ texto }),
};

/** ISO UTC de una hora local de Merida (UTC-6 todo el año) para un dia AAAA-MM-DD. */
export function merida(dia: string, hhmm: string): string {
  return new Date(`${dia}T${hhmm}:00.000-06:00`).toISOString();
}
