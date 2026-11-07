// QA citas R1 (lente VIAJE COMPLETO) -- arnes compartido de los viajes de punta a punta del agente de WhatsApp de citas.
// Todo es doble: LLM guionado (`FakeLlmProvider`), repositorio en memoria (el mismo motor de agenda que produccion), outbox en memoria
// (nada sale a Meta) y lock de conversacion en memoria. Datos inventados (telefonos +52999555xxxx, negocio ficticio).
import { randomUUID } from "node:crypto";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { InMemoryCitasRepository } from "../../src/in-memory-repository.ts";
import { createDefaultConversationGuard, handleInboundWhatsAppMessage } from "../../src/whatsapp/inbound.ts";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import type { MetaInteractiveReply } from "../../src/whatsapp/channel-config.ts";

export const ZONA = "America/Merida";
export const TEL_PACIENTE = "+529995550301";
export const TEL_ESPERA = "+529995550302";
export const TEL_AVISOS = "+529995550399";

export type PasoGuion = (request: LlmCompletionRequest, paso: number) => LlmCompletionResult;

export const herramienta = (id: string, name: string, args: Record<string, unknown>): LlmCompletionResult => ({
  text: "",
  toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }],
  model: "fake",
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 0,
});
export const texto = (t: string): LlmCompletionResult => ({ text: t, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });

/** Resultado (JSON) de la ultima herramienta que vio el modelo en este request. */
export function ultimoResultado(request: LlmCompletionRequest): Record<string, unknown> {
  const msg = [...request.messages].reverse().find((m) => m.role === "tool");
  if (!msg || msg.role !== "tool") throw new Error("se esperaba un resultado de herramienta");
  return JSON.parse(msg.content) as Record<string, unknown>;
}

/** Proximo dia de la semana (0=domingo) a partir de `desdeDias` dias en el futuro, como YYYY-MM-DD. */
export function proximoDia(diaSemana: number, desdeDias = 1): string {
  const d = new Date(Date.now() + desdeDias * 86_400_000);
  const base = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const diff = (diaSemana - base.getUTCDay() + 7) % 7;
  base.setUTCDate(base.getUTCDate() + diff);
  return base.toISOString().slice(0, 10);
}

export interface MundoClinica {
  readonly repo: InMemoryCitasRepository;
  readonly organizationId: string;
  readonly drPaola: string;
  readonly drLuis: string;
  readonly limpieza: string;
  readonly ortodoncia: string;
}

/** Clinica dental en Merida (rubro de salud: guardia de crisis activa), dos profesionales, L-V 9:00-20:00 (horario de tarde real). */
export function clinicaDental(opciones: { readonly rubro?: string; readonly hastaLas?: string } = {}): MundoClinica {
  const repo = new InMemoryCitasRepository();
  const organizationId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: `clinica-qa-${organizationId.slice(0, 6)}`, name: "Clínica Dental QA", defaultTimezone: ZONA });
  repo.seedTenantConfig({ organizationId, rubro: opciones.rubro ?? "dental", defaultTimezone: ZONA, ownerNotificationPhone: TEL_AVISOS });
  repo.seedWhatsAppConfig(organizationId, "100200300");
  const drPaola = randomUUID();
  const drLuis = randomUUID();
  repo.seedProvider({ id: drPaola, organizationId, propertyId: null, displayName: "Dra. Paola Medina", roleLabel: "Odontóloga", isActive: true });
  repo.seedProvider({ id: drLuis, organizationId, propertyId: null, displayName: "Dr. Luis Cetina", roleLabel: "Ortodoncista", isActive: true });
  const limpieza = randomUUID();
  const ortodoncia = randomUUID();
  repo.seedService({ id: limpieza, organizationId, name: "Limpieza dental", durationMinutes: 30, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents: 65000, isActive: true });
  repo.seedService({ id: ortodoncia, organizationId, name: "Revisión de ortodoncia", durationMinutes: 30, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents: 90000, isActive: true });
  for (const p of [drPaola, drLuis]) {
    repo.seedProviderService(p, limpieza);
    repo.seedProviderService(p, ortodoncia);
    for (const dayOfWeek of [1, 2, 3, 4, 5]) repo.seedAvailabilityRule({ id: randomUUID(), providerId: p, dayOfWeek, startTime: "09:00", endTime: opciones.hastaLas ?? "20:00", isActive: true });
  }
  return { repo, organizationId, drPaola, drLuis, limpieza, ortodoncia };
}

/** Un canal de WhatsApp completo (webhook -> dedupe -> lock -> crisis/ARCO/botones -> LLM guionado -> outbox) sobre el mundo. */
export function canalWhatsapp(mundo: MundoClinica) {
  const requests: LlmCompletionRequest[] = [];
  let guion: PasoGuion = () => texto("¿En qué le ayudo?");
  let paso = 0;
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  const proveedor = (id: string) =>
    new FakeLlmProvider({
      id,
      script: (req) => {
        requests.push(req);
        return guion(req, paso++);
      },
    });
  gateway.registerLadder("default", [proveedor("barato")]);
  gateway.registerLadder("escalated", [proveedor("caro")]);
  const handler = createLlmWhatsAppTurnHandler(mundo.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
  const guard = createDefaultConversationGuard({});
  let n = 0;
  return {
    requests,
    /** Llamadas al LLM hechas hasta ahora. */
    get llamadasLlm() {
      return requests.length;
    },
    /** Manda un mensaje del cliente con el guion que seguira el modelo en ESTE turno. */
    async escribe(phone: string, body: string, nuevoGuion?: PasoGuion, interactive?: MetaInteractiveReply) {
      if (nuevoGuion) {
        guion = nuevoGuion;
        paso = 0;
      }
      n += 1;
      return handleInboundWhatsAppMessage(mundo.repo, handler, guard, { organizationId: mundo.organizationId, messageId: `wamid.qa-${n}-${randomUUID()}`, phone, body, phoneNumberId: "100200300", ...(interactive ? { interactive } : {}) });
    },
  };
}

/** Hora local HH:MM de un ISO en la zona de la clinica. */
export function horaLocal(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: ZONA, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}
