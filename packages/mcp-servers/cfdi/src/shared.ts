// ═══════════════════════════════════════════════════════════════════════════
// Utilidades compartidas MÍNIMAS que CfdiPort necesita — puerto ESCOPADO de
// `hoteles/packages/mcp-servers/shared/src/{errors,hmac,idempotency,credentials}.ts`.
//
// DECISIÓN DE FIDELIDAD (Fase 5 fusión): `@atiende/mcp-shared` (el paquete genérico
// original, usado también por PMS/WhatsApp/pagos) NO existe todavía en
// atiende-fusion — TODO el árbol `packages/mcp-servers/*` de fusión sigue "Aún no
// portado" salvo este paquete. Portar el paquete `shared` COMPLETO (incluye
// `backoff.ts`/`rate-limiter.ts`, que ningún adaptador de CFDI usa) para servir
// solo a `mcp-cfdi` habría sido alcance fuera de esta fase (esos módulos existen
// para PMS/WhatsApp/pagos, verticals que Fase 5 no toca). En vez de eso, se portan
// aquí, LITERALMENTE (misma lógica, mismos nombres), únicamente las piezas que
// `CfdiPort`/sus adaptadores consumen: errores base, HMAC + replay guard,
// idempotencia en memoria y el chequeo de credenciales por variable de entorno.
// Cuando `@atiende/mcp-shared` se porte de verdad (para PMS/WhatsApp/pagos), este
// archivo puede reemplazarse por un `re-export` de ese paquete sin cambiar ninguna
// firma pública de aquí.
// ═══════════════════════════════════════════════════════════════════════════
import { createHmac, timingSafeEqual } from "node:crypto";

// ---- errors.ts (subconjunto: PortError, PortUnavailableError, WebhookSignatureError, WebhookReplayError) ----

/** Clase base de los errores de un puerto de integración. */
export abstract class PortError extends Error {
  abstract readonly code: string;
}

/** El adaptador real no tiene credenciales/hardware configurado en este entorno.
 *  NUNCA se lanza en el adaptador Fake/Simulado (ese siempre puede responder). */
export class PortUnavailableError extends PortError {
  readonly code = "port_unavailable";
  readonly integration: string;
  readonly reason: string;

  constructor(integration: string, reason: string) {
    super(`[PENDIENTE DE CREDENCIALES] ${integration}: ${reason}`);
    this.name = "PortUnavailableError";
    this.integration = integration;
    this.reason = reason;
  }
}

/** Firma HMAC de un webhook inválida o ausente. Fail-closed: nunca se procesa el payload. */
export class WebhookSignatureError extends PortError {
  readonly code = "webhook_signature_invalid";
  readonly integration: string;

  constructor(integration: string) {
    super(`${integration}: firma HMAC de webhook inválida`);
    this.name = "WebhookSignatureError";
    this.integration = integration;
  }
}

/** El `event_id` del webhook ya fue procesado (replay). */
export class WebhookReplayError extends PortError {
  readonly code = "webhook_replay";
  readonly integration: string;
  readonly eventId: string;

  constructor(integration: string, eventId: string) {
    super(`${integration}: evento repetido (replay), ya procesado: ${eventId}`);
    this.name = "WebhookReplayError";
    this.integration = integration;
    this.eventId = eventId;
  }
}

// ---- hmac.ts ----

export interface HmacSignOptions {
  algorithm?: "sha256" | "sha1";
  prefix?: string;
}

/** Firma un payload crudo (string) con HMAC, en el mismo formato que se espera verificar. */
export function signHmac(payload: string, secret: string, options: HmacSignOptions = {}): string {
  const { algorithm = "sha256", prefix = "sha256=" } = options;
  const digest = createHmac(algorithm, secret).update(payload, "utf8").digest("hex");
  return `${prefix}${digest}`;
}

/** Compara la firma HMAC de un webhook contra el payload crudo (string, ANTES de
 *  `JSON.parse`) en tiempo constante. Nunca lanza por firma inválida — retorna
 *  `false` para que el llamador decida (típicamente lanzar `WebhookSignatureError`). */
export function verifyHmacSignature(payload: string, receivedSignature: string | undefined | null, secret: string, options: HmacSignOptions = {}): boolean {
  if (!receivedSignature || !secret) return false;
  const expected = signHmac(payload, secret, options);
  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(receivedSignature, "utf8");
  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}

/** Guarda de replay para webhooks: recuerda los `event_id` ya procesados dentro de
 *  una ventana TTL. Implementación en memoria. */
export class InMemoryReplayGuard {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  /** `true` si el evento YA fue visto (es un replay); si no, lo marca como visto. */
  seenBefore(eventId: string, now: number = Date.now()): boolean {
    this.evictExpired(now);
    if (this.seen.has(eventId)) return true;
    this.seen.set(eventId, now + this.ttlMs);
    return false;
  }

  private evictExpired(now: number): void {
    for (const [id, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(id);
    }
  }
}

// ---- idempotency.ts ----

export interface IdempotencyStore<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
}

/** Implementación en memoria. Basta para pruebas de contrato y para el adaptador Fake/Simulado. */
export class InMemoryIdempotencyStore<T> implements IdempotencyStore<T> {
  private readonly store = new Map<string, T>();

  get(key: string): T | undefined {
    return this.store.get(key);
  }

  set(key: string, value: T): void {
    if (!this.store.has(key)) this.store.set(key, value);
  }

  get size(): number {
    return this.store.size;
  }
}

// ---- credentials.ts ----

export interface CredentialCheck {
  available: boolean;
  missing: string[];
}

/** Verifica que todas las variables de entorno en `names` estén definidas y no vacías. */
export function checkEnvCredentials(names: readonly string[]): CredentialCheck {
  const missing = names.filter((name) => {
    const value = process.env[name];
    return value === undefined || value.trim() === "";
  });
  return { available: missing.length === 0, missing };
}

/** Estado uniforme que cada adaptador (real o simulado) expone vía `status()`. */
export interface AdapterStatus {
  provider: string;
  available: boolean;
  simulated: boolean;
  reason?: string;
}
