// H-29 -- configuracion editable del canal WhatsApp y del agente de voz desde el panel (migracion 039).
// SIN SECRETOS EN CLARO: el panel nunca recibe ni muestra `tool_webhook_secret`. El secreto de voz lo GENERA el
// servidor, se entrega UNA sola vez al rotarlo (write-only) y despues solo se ve "configurado". La plataforma
// usa UNA Meta App compartida: no hay token de envio por hotel que guardar (solo el `phone_number_id`).
import { randomBytes } from "node:crypto";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";

export class MensajeriaUnavailableError extends Error {
  constructor(operation: string) {
    super(`La edicion de la mensajeria no esta disponible aun: requiere la migracion 039 (${operation}).`);
    this.name = "MensajeriaUnavailableError";
  }
}
export class MensajeriaConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MensajeriaConflictError";
  }
}
export class MensajeriaInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MensajeriaInvalidInputError";
  }
}

export interface WhatsAppChannelStatus {
  readonly configurado: boolean;
  readonly phoneNumberId: string | null;
  readonly enabled: boolean;
  readonly updatedAt: string | null;
}

export interface VoiceAgentStatus {
  readonly configurado: boolean;
  readonly enabled: boolean;
  /** true si ya hay un secreto guardado. El valor NUNCA se expone. */
  readonly secretoConfigurado: boolean;
  readonly updatedAt: string | null;
}

export interface MensajeriaConfigRepository {
  getWhatsAppChannel(propertyId: string): Promise<WhatsAppChannelStatus>;
  saveWhatsAppChannel(propertyId: string, input: { readonly phoneNumberId: string; readonly enabled: boolean }, actorId: string): Promise<WhatsAppChannelStatus>;
  getVoiceAgent(propertyId: string): Promise<VoiceAgentStatus>;
  /** Crea la fila de voz con un secreto nuevo o rota el existente. Devuelve el estado (sin el secreto). */
  rotateVoiceSecret(propertyId: string, organizationId: string, secret: string, enabled: boolean): Promise<VoiceAgentStatus>;
  /** Enciende/apaga la voz SIN tocar el secreto. `null` si no hay fila de voz. */
  setVoiceEnabled(propertyId: string, enabled: boolean): Promise<VoiceAgentStatus | null>;
}

const PHONE_NUMBER_ID_RE = /^[0-9]{5,20}$/;

export function parseWhatsAppChannelInput(raw: unknown): { phoneNumberId: string; enabled: boolean } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new MensajeriaInvalidInputError("Cuerpo invalido: se esperaba un objeto.");
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (key !== "phoneNumberId" && key !== "habilitado") throw new MensajeriaInvalidInputError(`Campo desconocido: ${key}.`);
  }
  const phoneNumberId = typeof body.phoneNumberId === "string" ? body.phoneNumberId.trim() : "";
  if (!PHONE_NUMBER_ID_RE.test(phoneNumberId)) throw new MensajeriaInvalidInputError("phoneNumberId: de 5 a 20 digitos (el identificador de Meta, no el telefono).");
  if (typeof body.habilitado !== "boolean") throw new MensajeriaInvalidInputError("habilitado: se esperaba true o false.");
  return { phoneNumberId, enabled: body.habilitado };
}

/** 32 bytes aleatorios en hex (256 bits): el servidor lo genera, nunca lo elige el cliente. */
export function generateVoiceSecret(): string {
  return randomBytes(32).toString("hex");
}

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

function mapPgError(err: unknown, operation: string): unknown {
  if (isMigrationPendingError(err)) return new MensajeriaUnavailableError(operation);
  switch (pgCode(err)) {
    case "42501":
      // La ruta ya filtro por rol (owner/gm): un 42501 aqui significa que la base aun no tiene los GRANT/policies de 039
      // (contra la base vieja el cliente no puede insertar). Es "no disponible aun", no un acceso indebido.
      return new MensajeriaUnavailableError(operation);
    case "23505":
      return new MensajeriaConflictError("Ese numero de WhatsApp ya esta conectado a otra propiedad.");
    case "23514":
      return new MensajeriaInvalidInputError("El numero de WhatsApp no tiene un formato valido.");
    case "23503":
      return new MensajeriaConflictError("La propiedad no existe.");
    default:
      return err;
  }
}

interface ChannelRow { phone_number_id: string; enabled: boolean; updated_at: string | null }
interface VoiceRow { enabled: boolean; updated_at: string | null; tiene_secreto: boolean }

/** Adaptador Postgres sobre la sesion del staff (RLS real: solo owner/gm editan; voz solo owner/gm leen su ESTADO).
 *  Todo corre en SAVEPOINT: contra la base sin migrar las lecturas degradan a "no configurado" y las escrituras a 503. */
export class PostgresMensajeriaConfigRepository implements MensajeriaConfigRepository {
  constructor(private readonly db: TenantDbSession) {}

  private write<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary: fn,
      isRecoverable: () => true,
      fallback: (err) => {
        throw mapPgError(err, operation);
      },
    });
  }

  async getWhatsAppChannel(propertyId: string): Promise<WhatsAppChannelStatus> {
    const empty: WhatsAppChannelStatus = { configurado: false, phoneNumberId: null, enabled: false, updatedAt: null };
    const toStatus = (r: ChannelRow | undefined): WhatsAppChannelStatus =>
      r ? { configurado: true, phoneNumberId: r.phone_number_id, enabled: r.enabled, updatedAt: r.updated_at } : empty;
    // `updated_at` solo existe desde 039: contra la base vieja se cae a la consulta sin esa columna (SAVEPOINT).
    return runWithSavepointFallback<WhatsAppChannelStatus>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<ChannelRow>(
          `select phone_number_id, enabled, updated_at::text as updated_at from hoteles.whatsapp_channel_config where property_id = $1;`,
          [propertyId],
        );
        return toStatus(rows[0]);
      },
      isRecoverable: isMigrationPendingError,
      fallback: () =>
        runWithSavepointFallback<WhatsAppChannelStatus>({
          session: this.db,
          primary: async () => {
            const { rows } = await this.db.query<ChannelRow>(
              `select phone_number_id, enabled, null::text as updated_at from hoteles.whatsapp_channel_config where property_id = $1;`,
              [propertyId],
            );
            return toStatus(rows[0]);
          },
          isRecoverable: isMigrationPendingError,
          fallback: () => Promise.resolve(empty),
        }),
    });
  }

  saveWhatsAppChannel(propertyId: string, input: { readonly phoneNumberId: string; readonly enabled: boolean }, actorId: string): Promise<WhatsAppChannelStatus> {
    return this.write("saveWhatsAppChannel", async () => {
      const { rows } = await this.db.query<ChannelRow>(
        `insert into hoteles.whatsapp_channel_config (property_id, phone_number_id, enabled, updated_by)
         values ($1, $2, $3, $4)
         on conflict (property_id) do update set phone_number_id = $2, enabled = $3, updated_by = $4, updated_at = now()
         returning phone_number_id, enabled, updated_at::text as updated_at;`,
        [propertyId, input.phoneNumberId, input.enabled, actorId],
      );
      const r = rows[0]!;
      return { configurado: true, phoneNumberId: r.phone_number_id, enabled: r.enabled, updatedAt: r.updated_at };
    });
  }

  getVoiceAgent(propertyId: string): Promise<VoiceAgentStatus> {
    const empty: VoiceAgentStatus = { configurado: false, enabled: false, secretoConfigurado: false, updatedAt: null };
    return runWithSavepointFallback<VoiceAgentStatus>({
      session: this.db,
      primary: async () => {
        // El secreto NO es legible por el cliente (GRANT de columna): solo se pregunta si hay fila.
        const { rows } = await this.db.query<VoiceRow>(`select enabled, updated_at::text as updated_at, true as tiene_secreto from hoteles.voice_agent_config where property_id = $1;`, [propertyId]);
        const r = rows[0];
        return r ? { configurado: true, enabled: r.enabled, secretoConfigurado: r.tiene_secreto, updatedAt: r.updated_at } : empty;
      },
      isRecoverable: isMigrationPendingError,
      fallback: () => Promise.resolve(empty),
    });
  }

  rotateVoiceSecret(propertyId: string, organizationId: string, secret: string, enabled: boolean): Promise<VoiceAgentStatus> {
    return this.write("rotateVoiceSecret", async () => {
      // organization_id sale de la sesion autenticada; desde 039 un trigger lo RE-DERIVA de core.property (el cliente no puede
      // sellar otra organizacion). Se manda tambien porque la base sin 039 lo exige NOT NULL.
      const { rows } = await this.db.query<VoiceRow>(
        `insert into hoteles.voice_agent_config (property_id, organization_id, tool_webhook_secret, enabled)
         values ($1, $2, $3, $4)
         on conflict (property_id) do update set tool_webhook_secret = $3, enabled = $4, updated_at = now()
         returning enabled, updated_at::text as updated_at, true as tiene_secreto;`,
        [propertyId, organizationId, secret, enabled],
      );
      const r = rows[0]!;
      return { configurado: true, enabled: r.enabled, secretoConfigurado: true, updatedAt: r.updated_at };
    });
  }

  setVoiceEnabled(propertyId: string, enabled: boolean): Promise<VoiceAgentStatus | null> {
    return this.write("setVoiceEnabled", async () => {
      const { rows } = await this.db.query<VoiceRow>(
        `update hoteles.voice_agent_config set enabled = $2, updated_at = now() where property_id = $1 returning enabled, updated_at::text as updated_at, true as tiene_secreto;`,
        [propertyId, enabled],
      );
      const r = rows[0];
      return r ? { configurado: true, enabled: r.enabled, secretoConfigurado: true, updatedAt: r.updated_at } : null;
    });
  }
}

/** Espejo en memoria para tests de ruta (no emula RLS/GRANT; `migrated: false` simula la base sin 039). */
export class InMemoryMensajeriaConfigRepository implements MensajeriaConfigRepository {
  private readonly channels = new Map<string, { phoneNumberId: string; enabled: boolean; updatedAt: string }>();
  private readonly voice = new Map<string, { secret: string; enabled: boolean; updatedAt: string }>();
  migrated: boolean;
  constructor(opts: { readonly migrated?: boolean } = {}) {
    this.migrated = opts.migrated ?? true;
  }
  private requireMigrated(op: string): void {
    if (!this.migrated) throw new MensajeriaUnavailableError(op);
  }
  /** Solo para tests: el secreto que quedo guardado (la API nunca lo devuelve). */
  storedSecret(propertyId: string): string | undefined {
    return this.voice.get(propertyId)?.secret;
  }
  async getWhatsAppChannel(propertyId: string): Promise<WhatsAppChannelStatus> {
    const c = this.channels.get(propertyId);
    return c ? { configurado: true, phoneNumberId: c.phoneNumberId, enabled: c.enabled, updatedAt: c.updatedAt } : { configurado: false, phoneNumberId: null, enabled: false, updatedAt: null };
  }
  async saveWhatsAppChannel(propertyId: string, input: { readonly phoneNumberId: string; readonly enabled: boolean }): Promise<WhatsAppChannelStatus> {
    this.requireMigrated("saveWhatsAppChannel");
    for (const [pid, c] of this.channels) {
      if (pid !== propertyId && c.phoneNumberId === input.phoneNumberId) throw new MensajeriaConflictError("Ese numero de WhatsApp ya esta conectado a otra propiedad.");
    }
    this.channels.set(propertyId, { phoneNumberId: input.phoneNumberId, enabled: input.enabled, updatedAt: new Date().toISOString() });
    return this.getWhatsAppChannel(propertyId);
  }
  async getVoiceAgent(propertyId: string): Promise<VoiceAgentStatus> {
    const v = this.voice.get(propertyId);
    return v ? { configurado: true, enabled: v.enabled, secretoConfigurado: true, updatedAt: v.updatedAt } : { configurado: false, enabled: false, secretoConfigurado: false, updatedAt: null };
  }
  async rotateVoiceSecret(propertyId: string, _organizationId: string, secret: string, enabled: boolean): Promise<VoiceAgentStatus> {
    this.requireMigrated("rotateVoiceSecret");
    this.voice.set(propertyId, { secret, enabled, updatedAt: new Date().toISOString() });
    return this.getVoiceAgent(propertyId);
  }
  async setVoiceEnabled(propertyId: string, enabled: boolean): Promise<VoiceAgentStatus | null> {
    this.requireMigrated("setVoiceEnabled");
    const v = this.voice.get(propertyId);
    if (!v) return null;
    this.voice.set(propertyId, { ...v, enabled, updatedAt: new Date().toISOString() });
    return this.getVoiceAgent(propertyId);
  }
}
