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

// ---- folio-reservation.ts ----
//
// Fix hallazgo auditoría (rubro 6, ALTA) — `DualPacCfdiPort.timbrar` usaba
// `InMemoryIdempotencyStore` (un `Map` de proceso) como ÚNICA protección contra
// timbrar dos veces el mismo folio. Eso es un TOCTOU real: entre el `get()` (cache
// miss) y el `set()` posterior a que el PAC responda hay un `await` real (la
// llamada de red al PAC) — dos llamadas concurrentes a `timbrar()` con el mismo
// folio pueden pasar el `get()` ANTES de que cualquiera de las dos llegue a
// `set()`, y ambas terminan llamando al PAC de verdad (doble timbrado fiscal). El
// `Map` tampoco sobrevive un reinicio de proceso NI se comparte entre instancias
// distintas (este monorepo corre en Vercel con Fluid Compute, que sí reutiliza una
// misma instancia — y por tanto el mismo `Map` — entre requests concurrentes de
// tenants DISTINTOS, pero nunca lo comparte entre instancias separadas).
//
// `FolioReservationStore` reemplaza ese `Map` por una RESERVA ATÓMICA (constraint
// único a nivel de almacenamiento -- nunca un check-then-insert en dos pasos desde
// la aplicación, mismo criterio que `LedgerStore.marcarVisto` en
// `packages/billing/src/ledger.ts` y que `PostgresHotelesRepository.withIdempotency`/
// `insertReservation` en `packages/domain-hoteles/src/postgres-repository.ts`) que
// se pide ANTES de invocar al PAC, no después.

export type FolioReservationOutcome<T> =
  | { readonly kind: "reserved" }
  | { readonly kind: "completed"; readonly value: T }
  /** Otro proceso tiene una reserva VIVA (no vencida) de este folio ahora mismo —
   *  ver `DualPacCfdiPort` para la política elegida ante esto (falla rápido, no
   *  espera/reintenta: ver comentario de cabecera de ese archivo). */
  | { readonly kind: "in_progress" };

export interface FolioReservationStore<T> {
  /**
   * Intenta reservar `folio` ATÓMICAMENTE antes de invocar un sistema externo no
   * idempotente. Dos llamadas concurrentes con el mismo `folio` deben producir
   * exactamente un `"reserved"` y el resto `"in_progress"`/`"completed"` — un
   * dedupe que primero lee y luego escribe (dos pasos separados desde la
   * aplicación) reintroduce exactamente la misma carrera que este store existe
   * para cerrar.
   */
  reserve(folio: string): Promise<FolioReservationOutcome<T>>;
  /** Marca `folio` como completado con éxito, persistiendo `value` — un
   *  `reserve()` posterior del mismo folio siempre debe responder `"completed"`
   *  con este mismo `value`, nunca repetir el trabajo externo. */
  complete(folio: string, value: T): Promise<void>;
  /** Libera la reserva de `folio` tras un fallo del trabajo externo (ambos PAC
   *  fallaron) -- un `reserve()` posterior debe volver a ver `"reserved"` en vez
   *  de quedar bloqueado para siempre por un error transitorio. */
  fail(folio: string): Promise<void>;
  /** Lectura de solo observación (nunca reserva ni muta nada): el `value` ya
   *  persistido si `folio` está `"completed"`, o `undefined` si no existe o sigue
   *  `"pending"`. Existe para diagnóstico/pruebas (ver
   *  `DualPacCfdiPort.usedSecondaryFor`) -- el flujo real de `timbrar()` nunca la
   *  necesita, siempre pasa por `reserve()`. */
  peek(folio: string): Promise<T | undefined>;
}

export interface InMemoryFolioReservationOptions {
  /** Cuánto tiempo (ms) se considera viva una reserva `"pending"` antes de
   *  tratarla como abandonada (el proceso que la tomó murió a medio timbrado, o
   *  nunca llamó `complete`/`fail`) y dejar que un `reserve()` posterior la
   *  reclame como si fuera nueva. Default 2 minutos: generosamente por encima de
   *  cualquier timeout HTTP razonable de un PAC real. */
  readonly staleAfterMs?: number;
}

type InMemoryReservationRow<T> = { readonly status: "pending"; readonly reservedAt: number } | { readonly status: "completed"; readonly value: T };

/**
 * Implementación en memoria: referencia de la semántica exacta que un adaptador
 * real (Postgres, ver `apps/api/src/production/cfdi-folio-reservation-store.ts`)
 * debe respetar, y default de `DualPacCfdiPort` para que los adaptadores
 * Fake/tests sigan funcionando sin construir un store aparte. Aunque Node.js es de
 * un solo hilo, el `Map` SÍ es seguro ante la carrera de este archivo porque
 * `reserve()` nunca hace `await` entre el `get()` y el `set()` -- toda la sección
 * crítica corre síncrona dentro de la función `async`, sin ceder el control al
 * event loop, igual que un `INSERT ... ON CONFLICT` real corre atómico dentro de
 * Postgres.
 */
export class InMemoryFolioReservationStore<T> implements FolioReservationStore<T> {
  private readonly rows = new Map<string, InMemoryReservationRow<T>>();
  private readonly staleAfterMs: number;

  constructor(options: InMemoryFolioReservationOptions = {}) {
    this.staleAfterMs = options.staleAfterMs ?? 2 * 60 * 1000;
  }

  async reserve(folio: string): Promise<FolioReservationOutcome<T>> {
    const existing = this.rows.get(folio);
    if (!existing || (existing.status === "pending" && Date.now() - existing.reservedAt > this.staleAfterMs)) {
      this.rows.set(folio, { status: "pending", reservedAt: Date.now() });
      return { kind: "reserved" };
    }
    if (existing.status === "completed") return { kind: "completed", value: existing.value };
    return { kind: "in_progress" };
  }

  async complete(folio: string, value: T): Promise<void> {
    this.rows.set(folio, { status: "completed", value });
  }

  async fail(folio: string): Promise<void> {
    this.rows.delete(folio);
  }

  async peek(folio: string): Promise<T | undefined> {
    const row = this.rows.get(folio);
    return row?.status === "completed" ? row.value : undefined;
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
