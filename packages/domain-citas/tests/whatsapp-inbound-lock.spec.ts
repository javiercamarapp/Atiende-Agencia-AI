// ─────────────────────────────────────────────────────────────────────────────
// Hallazgo de auditoría de credenciales (fix/conversation-lock-upstash) — citas
// es el ÚNICO vertical que depende del lock de @atiende/core-conversation para
// serializar mensajes casi-simultáneos del mismo cliente (restaurantes/hoteles ya
// lo resuelven con una lease atómica real en Postgres, ver
// packages/domain-restaurantes/migrations/004_whatsapp_atomic_append_and_rate_limit.sql).
// Este archivo prueba las 2 mitades del arreglo:
//
//   1. `createDefaultConversationGuard` elige el LockStore correcto según las
//      credenciales de entorno (antes SIEMPRE devolvía InMemoryLockStore, sin
//      importar qué hubiera configurado).
//   2. Con RedisLockStore de verdad conectado (Upstash simulado vía `fetch`
//      inyectado, mismo patrón que packages/core-conversation/tests/lock.spec.ts),
//      2 mensajes casi-simultáneos del mismo cliente NUNCA disparan 2 llamadas al
//      LLM en paralelo — se serializan, igual que con InMemoryLockStore.
// ─────────────────────────────────────────────────────────────────────────────
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryLockStore, RedisLockStore } from "@atiende/core-conversation";
import { createDefaultConversationGuard, handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { buildCitasFixture } from "./fixtures.ts";

describe("createDefaultConversationGuard — selección de LockStore según credenciales de Upstash", () => {
  it("SIN UPSTASH_REDIS_REST_URL/_TOKEN — usa InMemoryLockStore (degradación explícita, no fail-open silencioso)", () => {
    const guard = createDefaultConversationGuard({});
    expect(guard.lockStore).toBeInstanceOf(InMemoryLockStore);
  });

  it("con solo UNA de las 2 variables — sigue en InMemoryLockStore (ambas son obligatorias)", () => {
    const guard = createDefaultConversationGuard({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io" });
    expect(guard.lockStore).toBeInstanceOf(InMemoryLockStore);
  });

  it("CON UPSTASH_REDIS_REST_URL/_TOKEN configuradas — usa RedisLockStore real", () => {
    const guard = createDefaultConversationGuard({
      UPSTASH_REDIS_REST_URL: "https://fake-redis.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "tok-de-prueba",
    });
    expect(guard.lockStore).toBeInstanceOf(RedisLockStore);
    expect((guard.lockStore as RedisLockStore).isConfigured()).toBe(true);
  });
});

// ─── Fake mínimo de la REST API de Upstash, servido por `fetch` ────────────
// Mismo protocolo que packages/core-conversation/tests/fake-upstash.ts
// (SET NX EX + EVAL release), sin TTL/expiración real — no hace falta aquí,
// ya se prueba a fondo en core-conversation/tests/lock.spec.ts. Este test
// solo verifica el efecto end-to-end: contención real entre 2 mensajes.
function makeFakeUpstashFetch() {
  const store = new Map<string, string>();
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const [cmd, ...rest] = JSON.parse(String(init?.body ?? "[]")) as unknown[];
    if (cmd === "SET") {
      const [key, value] = rest as [string, string];
      if (store.has(key)) return new Response(JSON.stringify({ result: null }), { status: 200 });
      store.set(key, value);
      return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
    }
    if (cmd === "EVAL") {
      const [script, , key, token] = rest as [string, number, string, string];
      if (script.includes("del") && store.get(key as string) === token) {
        store.delete(key as string);
        return new Response(JSON.stringify({ result: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: 0 }), { status: 200 });
    }
    throw new Error(`fake-upstash: comando no soportado: ${cmd}`);
  });
  return fetchMock;
}

describe("handleInboundWhatsAppMessage con RedisLockStore real — nunca 2 llamadas al LLM en paralelo por la misma conversación", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFakeUpstashFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** turnHandler instrumentado: cuenta cuántas invocaciones están EN VUELO al
   *  mismo tiempo (concurrencia real, no solo cuántas veces se llamó en total). */
  function makeTrackingTurnHandler(latencyMs: number): { handler: WhatsAppTurnHandler; maxConcurrent: () => number; callCount: () => number } {
    let inFlight = 0;
    let maxConcurrent = 0;
    let callCount = 0;
    const handler: WhatsAppTurnHandler = {
      async handleInboundMessage() {
        inFlight += 1;
        callCount += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, latencyMs));
        inFlight -= 1;
        return { reply: "Claro, ¿qué día te gustaría agendar?", appointmentId: null, propertyId: null };
      },
    };
    return { handler, maxConcurrent: () => maxConcurrent, callCount: () => callCount };
  }

  it("2 mensajes casi-simultáneos del MISMO teléfono: el lock de Redis serializa — el turn handler NUNCA corre 2 veces en paralelo", async () => {
    const fixture = buildCitasFixture();
    const guard = createDefaultConversationGuard({
      UPSTASH_REDIS_REST_URL: "https://fake-redis.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "tok-de-prueba",
    });
    expect(guard.lockStore).toBeInstanceOf(RedisLockStore); // confirma que esta prueba SÍ ejercita Redis, no memoria

    const { handler: turnHandler, maxConcurrent, callCount } = makeTrackingTurnHandler(30);
    const phone = "+5219981234567";

    const [a, b] = await Promise.all([
      handleInboundWhatsAppMessage(fixture.repo, turnHandler, guard, {
        organizationId: fixture.organizationId,
        messageId: "wamid-lock-1",
        phone,
        body: "Hola, quiero agendar una cita",
        phoneNumberId: "1234567890",
      }),
      handleInboundWhatsAppMessage(fixture.repo, turnHandler, guard, {
        organizationId: fixture.organizationId,
        messageId: "wamid-lock-2",
        phone,
        body: "¿Tienen espacio mañana?",
        phoneNumberId: "1234567890",
      }),
    ]);

    // Ambos mensajes se procesaron (nadie se perdió) — el lock serializa, no descarta.
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(callCount()).toBe(2);
    // La prueba real: JAMÁS hubo 2 llamadas al LLM en vuelo al mismo tiempo.
    expect(maxConcurrent()).toBe(1);
  });

  it("teléfonos DISTINTOS no se bloquean entre sí (locks por conversación, no un mutex global)", async () => {
    const fixture = buildCitasFixture();
    const guard = createDefaultConversationGuard({
      UPSTASH_REDIS_REST_URL: "https://fake-redis.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "tok-de-prueba",
    });
    const { handler: turnHandler, maxConcurrent } = makeTrackingTurnHandler(30);

    const [a, b] = await Promise.all([
      handleInboundWhatsAppMessage(fixture.repo, turnHandler, guard, {
        organizationId: fixture.organizationId,
        messageId: "wamid-multi-1",
        phone: "+5219981110000",
        body: "Hola",
        phoneNumberId: "1234567890",
      }),
      handleInboundWhatsAppMessage(fixture.repo, turnHandler, guard, {
        organizationId: fixture.organizationId,
        messageId: "wamid-multi-2",
        phone: "+5219982220000",
        body: "Hola",
        phoneNumberId: "1234567890",
      }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // Clientes distintos SÍ pueden correr en paralelo — el lock es por conversación.
    expect(maxConcurrent()).toBe(2);
  });
});
