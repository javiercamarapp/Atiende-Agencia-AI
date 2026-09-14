// Tests reales del dispatcher — usa FakeWhatsAppGraphClient (nunca red real) y un
// puerto en memoria que replica FIELMENTE la semántica de claim-con-lease que las
// implementaciones SQL de las 3 verticales deben cumplir (ver
// packages/domain-*/tests para los tests equivalentes contra cada adaptador real).
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { CircuitBreaker, InMemoryCircuitBreakerStore } from "@atiende/agent-core/gateway";
import { computeBackoffSeconds, DEFAULT_MAX_ATTEMPTS, WhatsAppOutboundDispatcher } from "../src/dispatcher.ts";
import { WhatsAppSendError } from "../src/errors.ts";
import { FakeWhatsAppGraphClient } from "../src/providers/fake-graph-client.ts";
import type { MessagingOutboxItem, MessagingOutboxPort } from "../src/outbox-port.ts";

interface Row {
  id: string;
  status: "pending" | "processing" | "sent" | "dead";
  attempts: number;
  payload: unknown;
  claimedAt: number | null;
  nextAttemptAt: number;
  lastErrorClass: string | null;
}

/** Puerto en memoria — mismo idioma de claim-con-lease-reclamable que
 * `claim_whatsapp_message`/`whatsapp_conversation_leases` en las 3 verticales
 * reales (ver migrations/004 de hoteles/restaurantes). */
class InMemoryOutboxPort implements MessagingOutboxPort {
  readonly label = "test-vertical";
  readonly rows = new Map<string, Row>();

  enqueue(payload: unknown): string {
    const id = randomUUID();
    this.rows.set(id, { id, status: "pending", attempts: 0, payload, claimedAt: null, nextAttemptAt: 0, lastErrorClass: null });
    return id;
  }

  async claimBatch(limit: number, leaseSeconds: number): Promise<readonly MessagingOutboxItem[]> {
    const now = Date.now();
    const eligible = [...this.rows.values()]
      .filter((r) => (r.status === "pending" && r.nextAttemptAt <= now) || (r.status === "processing" && (r.claimedAt ?? 0) < now - leaseSeconds * 1000))
      .slice(0, limit);
    for (const r of eligible) {
      r.status = "processing";
      r.claimedAt = now;
    }
    return eligible.map((r) => ({ id: r.id, attempts: r.attempts, payload: r.payload }));
  }

  async markSent(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    row.status = "sent";
  }

  async markRetry(id: string, attempts: number, errorClass: string, nextAttemptAtIso: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    row.status = "pending";
    row.attempts = attempts;
    row.lastErrorClass = errorClass;
    row.nextAttemptAt = Date.parse(nextAttemptAtIso);
  }

  async markDead(id: string, attempts: number, errorClass: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    row.status = "dead";
    row.attempts = attempts;
    row.lastErrorClass = errorClass;
  }
}

function validPayload(overrides: Partial<{ to: string; phone_number_id: string; body: string; buttons: string[] }> = {}) {
  return { to: "+529991112233", phone_number_id: "phone-1", body: "hola", ...overrides };
}

describe("WhatsAppOutboundDispatcher", () => {
  let port: InMemoryOutboxPort;

  beforeEach(() => {
    port = new InMemoryOutboxPort();
  });

  it("envía un mensaje pendiente real vía el graph client y lo marca sent", async () => {
    const id = port.enqueue(validPayload());
    const client = new FakeWhatsAppGraphClient();
    const dispatcher = new WhatsAppOutboundDispatcher({ graphClient: client });

    const summary = await dispatcher.dispatchPending(port);

    expect(summary.claimed).toBe(1);
    expect(summary.sent).toBe(1);
    expect(port.rows.get(id)?.status).toBe("sent");
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]).toMatchObject({ to: "+529991112233", phoneNumberId: "phone-1", body: "hola" });
  });

  it("GARANTÍA DE IDEMPOTENCIA: un mensaje ya marcado como enviado NUNCA se reenvía ante una segunda corrida del job", async () => {
    port.enqueue(validPayload());
    const client = new FakeWhatsAppGraphClient();
    const dispatcher = new WhatsAppOutboundDispatcher({ graphClient: client });

    const first = await dispatcher.dispatchPending(port);
    expect(first.sent).toBe(1);
    expect(client.sent).toHaveLength(1);

    // Segunda corrida del mismo job contra la MISMA tabla — nada elegible, cero
    // llamadas nuevas al graph client.
    const second = await dispatcher.dispatchPending(port);
    expect(second.claimed).toBe(0);
    expect(second.sent).toBe(0);
    expect(client.sent).toHaveLength(1); // sigue en 1, no 2

    // Tercera corrida por si acaso — misma garantía, sin importar cuántas veces se
    // re-ejecute el job.
    const third = await dispatcher.dispatchPending(port);
    expect(third.claimed).toBe(0);
    expect(client.sent).toHaveLength(1);
  });

  it("reintenta con backoff un error reintentable, sin marcarlo dead antes del tope", async () => {
    const id = port.enqueue(validPayload());
    const client = new FakeWhatsAppGraphClient({
      onSend: (_msg, callIndex) => (callIndex === 0 ? new WhatsAppSendError("500 transitorio", true) : undefined),
    });
    // Fijo en el futuro lejano respecto al reloj real de la máquina que corre el
    // test — el puerto en memoria compara `next_attempt_at` contra `Date.now()`
    // real (mismo criterio que la columna SQL real), así que el "ahora" inyectado
    // al dispatcher (para que el backoff sea determinista de calcular) debe quedar
    // por delante del reloj real para que la ventana de backoff sea observable.
    const fixedNow = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const dispatcher = new WhatsAppOutboundDispatcher({ graphClient: client, now: () => fixedNow });

    const first = await dispatcher.dispatchPending(port);
    expect(first.retried).toBe(1);
    const row = port.rows.get(id)!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt).toBe(fixedNow.getTime() + computeBackoffSeconds(1) * 1000);

    // Todavía no toca next_attempt_at -> no elegible.
    const tooSoon = await dispatcher.dispatchPending(port);
    expect(tooSoon.claimed).toBe(0);

    // Avanza el reloj lógico más allá del backoff -> vuelve a ser elegible y esta
    // vez el fake ya no falla.
    row.nextAttemptAt = 0;
    const second = await dispatcher.dispatchPending(port);
    expect(second.sent).toBe(1);
    expect(port.rows.get(id)?.status).toBe("sent");
  });

  it("agota el tope de intentos y marca dead — NUNCA reintento infinito", async () => {
    const id = port.enqueue(validPayload());
    const client = new FakeWhatsAppGraphClient({ onSend: () => new WhatsAppSendError("500 siempre falla", true) });
    const dispatcher = new WhatsAppOutboundDispatcher({ graphClient: client, maxAttempts: 3 });

    for (let i = 0; i < 2; i++) {
      const row = port.rows.get(id)!;
      row.nextAttemptAt = 0;
      const result = await dispatcher.dispatchPending(port);
      expect(result.retried).toBe(1);
    }

    const row = port.rows.get(id)!;
    row.nextAttemptAt = 0;
    const finalResult = await dispatcher.dispatchPending(port);
    expect(finalResult.dead).toBe(1);
    expect(port.rows.get(id)?.status).toBe("dead");
    expect(port.rows.get(id)?.attempts).toBe(3);

    // Muerto de verdad: nunca vuelve a ser elegible aunque se resetee next_attempt_at.
    port.rows.get(id)!.nextAttemptAt = 0;
    const afterDead = await dispatcher.dispatchPending(port);
    expect(afterDead.claimed).toBe(0);
  });

  it("un error NO reintentable se marca dead de inmediato, sin gastar el tope de intentos", async () => {
    const id = port.enqueue(validPayload());
    const client = new FakeWhatsAppGraphClient({ onSend: () => new WhatsAppSendError("400 número inválido", false) });
    const dispatcher = new WhatsAppOutboundDispatcher({ graphClient: client, maxAttempts: DEFAULT_MAX_ATTEMPTS });

    const result = await dispatcher.dispatchPending(port);
    expect(result.dead).toBe(1);
    expect(port.rows.get(id)?.attempts).toBe(1); // no agotó los 5 intentos, murió al primero
  });

  it("un payload con forma inválida se marca dead sin tocar la red", async () => {
    port.enqueue({ to: "+52999", body: "sin phone_number_id" });
    const client = new FakeWhatsAppGraphClient();
    const dispatcher = new WhatsAppOutboundDispatcher({ graphClient: client });

    const result = await dispatcher.dispatchPending(port);
    expect(result.dead).toBe(1);
    expect(client.sent).toHaveLength(0);
  });

  it("respeta el circuit breaker por phone_number_id: un número con fallas en cadena se salta sin gastar intentos", async () => {
    const id = port.enqueue(validPayload({ phone_number_id: "phone-roto" }));
    const client = new FakeWhatsAppGraphClient({ onSend: () => new WhatsAppSendError("500", true) });
    const breaker = new CircuitBreaker(new InMemoryCircuitBreakerStore(), { failureThreshold: 1, openDurationSeconds: 60 });
    const dispatcher = new WhatsAppOutboundDispatcher({ graphClient: client, breaker });

    // Primer intento real: falla, abre el breaker (threshold=1) y reintenta con backoff.
    const first = await dispatcher.dispatchPending(port);
    expect(first.retried).toBe(1);
    expect(client.sent).toHaveLength(1);

    // Segunda corrida: el mensaje ya es elegible de nuevo (se fuerza next_attempt_at),
    // pero el breaker está abierto -> se salta SIN llamar al graph client y SIN
    // incrementar attempts.
    port.rows.get(id)!.nextAttemptAt = 0;
    const second = await dispatcher.dispatchPending(port);
    expect(second.skipped).toBe(1);
    expect(client.sent).toHaveLength(1); // sigue en 1, el breaker lo bloqueó
    expect(port.rows.get(id)?.attempts).toBe(1); // no se penalizó el mensaje por el breaker
  });

  it("computeBackoffSeconds crece exponencial y capa en 1 hora", () => {
    expect(computeBackoffSeconds(1)).toBe(30);
    expect(computeBackoffSeconds(2)).toBe(60);
    expect(computeBackoffSeconds(3)).toBe(120);
    expect(computeBackoffSeconds(4)).toBe(240);
    expect(computeBackoffSeconds(20)).toBe(3600);
  });

  it("aísla mensajes entre sí: uno inválido no tumba el resto del batch", async () => {
    port.enqueue({ bad: "payload" });
    port.enqueue(validPayload({ to: "+529990000001" }));
    const client = new FakeWhatsAppGraphClient();
    const dispatcher = new WhatsAppOutboundDispatcher({ graphClient: client });

    const summary = await dispatcher.dispatchPending(port);
    expect(summary.claimed).toBe(2);
    expect(summary.dead).toBe(1);
    expect(summary.sent).toBe(1);
  });

  it("envía botones como parte del mensaje cuando el payload los trae", async () => {
    port.enqueue(validPayload({ buttons: ["Confirmar", "Cancelar", "Reagendar"] }));
    const client = new FakeWhatsAppGraphClient();
    const dispatcher = new WhatsAppOutboundDispatcher({ graphClient: client });

    await dispatcher.dispatchPending(port);
    expect(client.sent[0]?.buttons).toEqual(["Confirmar", "Cancelar", "Reagendar"]);
  });
});
