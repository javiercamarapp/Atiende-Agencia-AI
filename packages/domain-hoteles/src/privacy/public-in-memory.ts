// Mirror en memoria de la privacidad publica (H-30) para pruebas de la API y de la UI. Reproduce las reglas de las
// funciones de la migracion 042 (tope por contacto, codigo de un solo uso con intentos y expiracion, plazo de 20 dias
// desde la verificacion, snapshot solo para acceso procedente) pero NUNCA aplica RLS/GRANT: eso lo prueba
// scripts/verify-hoteles-privacidad-publica contra Postgres real.
import { PrivacyAccessDeniedError, PrivacyNotFoundError, PrivacyUnavailableError, PrivacyInvalidInputError } from "./errors.ts";
import type {
  AccessGrant,
  ExportFormat,
  GuestDataDocument,
  GuestDataRepository,
  PublicNoticeProperty,
  PublicNoticesResult,
  PublicPrivacyRepository,
  PublicVerifyOutcome,
  SubmitPublicArcoInput,
} from "./public.ts";
import type { ArcoRight } from "./types.ts";

export interface InMemoryPublicRequest {
  readonly id: string;
  readonly propertyId: string;
  readonly organizationId: string;
  readonly folio: string;
  readonly rightType: ArcoRight;
  readonly name: string;
  readonly contact: string;
  readonly description: string | null;
  status: "pendiente_verificacion" | "recibida" | "procedente" | "ejecutada" | "improcedente";
  receivedOn: string;
  responseDueOn: string;
  guestId: string | null;
  readonly codeHash: string;
  readonly expiresAtMs: number;
  attempts: number;
  used: boolean;
  readonly createdAtMs: number;
}
export interface InMemoryOutboxEmail {
  readonly propertyId: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly dedupeKey: string;
}

const addDays = (ymd: string, days: number): string => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export class InMemoryPublicPrivacyRepository implements PublicPrivacyRepository, GuestDataRepository {
  readonly requests = new Map<string, InMemoryPublicRequest>();
  readonly outbox: InMemoryOutboxEmail[] = [];
  readonly exportLog: { propertyId: string; guestId: string; format: ExportFormat }[] = [];
  readonly snapshotLog: string[] = [];
  /** `false` simula la base sin la migracion 042. */
  available = true;
  organizationName: string | null = "Hotel Demo";
  /** Slug que responde; otro slug = hotel inexistente (cero propiedades). `null` = cualquiera. */
  orgSlug: string | null = null;
  organizationId = "00000000-0000-0000-0000-00000000a001";
  properties: PublicNoticeProperty[] = [];
  /** Huespedes por property para exportar (documento completo de staff). */
  guests = new Map<string, { propertyId: string; doc: GuestDataDocument }>();
  /** Propiedades que este "usuario" puede exportar (simula can_manage_catalog). */
  allowedProperties = new Set<string>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Siembra una solicitud ya existente (p. ej. creada por staff en mostrador) para probar el enlace "mis datos". */
  seedRequest(r: { id: string; propertyId: string; rightType: ArcoRight; status: InMemoryPublicRequest["status"]; contact?: string; guestId?: string | null }): void {
    this.requests.set(r.id, {
      id: r.id,
      propertyId: r.propertyId,
      organizationId: this.organizationId,
      folio: `ARCO-SEED-${r.id.slice(0, 6).toUpperCase()}`,
      rightType: r.rightType,
      name: "Titular de prueba",
      contact: r.contact ?? "titular@example.com",
      description: null,
      status: r.status,
      receivedOn: "2026-10-01",
      responseDueOn: "2026-10-21",
      guestId: r.guestId ?? null,
      codeHash: "0".repeat(64),
      expiresAtMs: 0,
      attempts: 0,
      used: true,
      createdAtMs: this.now(),
    });
  }

  async listNotices(orgSlug: string): Promise<PublicNoticesResult> {
    if (!this.available) return { available: false, organizationName: null, properties: [] };
    if (this.orgSlug !== null && this.orgSlug !== orgSlug) return { available: true, organizationName: null, properties: [] };
    return { available: true, organizationName: this.organizationName, properties: this.properties };
  }

  async submitArco(input: SubmitPublicArcoInput): Promise<string | null> {
    if (!this.available) throw new PrivacyUnavailableError("solicitud ARCO publica");
    if (!this.properties.some((p) => p.propertyId === input.propertyId)) throw new PrivacyAccessDeniedError("solicitud ARCO publica");
    const contact = input.contact.trim().toLowerCase();
    const recent = [...this.requests.values()].filter(
      (r) => r.propertyId === input.propertyId && r.status === "pendiente_verificacion" && r.contact === contact && this.now() - r.createdAtMs < 24 * 3_600_000,
    );
    if (recent.length >= 3) return null;
    this.requests.set(input.requestId, {
      id: input.requestId,
      propertyId: input.propertyId,
      organizationId: this.organizationId,
      folio: `ARCO-${input.today.replace(/-/g, "")}-${input.requestId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      rightType: input.rightType,
      name: input.name,
      contact,
      description: input.description,
      status: "pendiente_verificacion",
      receivedOn: input.today,
      responseDueOn: addDays(input.today, 20),
      guestId: null,
      codeHash: input.codeHash,
      expiresAtMs: this.now() + input.ttlSeconds * 1000,
      attempts: 0,
      used: false,
      createdAtMs: this.now(),
    });
    this.outbox.push({ propertyId: input.propertyId, to: input.email.to, subject: input.email.subject, text: input.email.text, dedupeKey: `arco-codigo:${input.requestId}` });
    return input.requestId;
  }

  async verifyArco(requestId: string, codeHash: string, todayOrNull: string | null): Promise<PublicVerifyOutcome> {
    const today = todayOrNull ?? new Date(this.now()).toISOString().slice(0, 10);
    if (!this.available) throw new PrivacyUnavailableError("verificacion de solicitud ARCO");
    const none = (result: PublicVerifyOutcome["result"]): PublicVerifyOutcome => ({ result, organizationId: null, propertyId: null, folio: null });
    const r = this.requests.get(requestId);
    if (!r) return none("invalido");
    if (r.used || r.status !== "pendiente_verificacion") return none("usado");
    if (r.expiresAtMs <= this.now()) return none("expirado");
    if (r.attempts >= 5) return none("agotado");
    if (r.codeHash !== codeHash) {
      r.attempts += 1;
      return none("invalido");
    }
    r.used = true;
    r.status = "recibida";
    r.receivedOn = today;
    r.responseDueOn = addDays(today, 20);
    return { result: "ok", organizationId: r.organizationId, propertyId: r.propertyId, folio: r.folio };
  }

  async accessSnapshot(requestId: string, orgSlug: string): Promise<GuestDataDocument | null> {
    if (!this.available) throw new PrivacyUnavailableError("consulta de mis datos");
    if (this.orgSlug !== null && this.orgSlug !== orgSlug) return null;
    const r = this.requests.get(requestId);
    if (!r || r.rightType !== "acceso" || (r.status !== "procedente" && r.status !== "ejecutada") || !r.guestId) return null;
    const g = this.guests.get(r.guestId);
    if (!g) return null;
    this.snapshotLog.push(requestId);
    const { perfil, estancias, consentimientos, identidad } = g.doc;
    return { perfil, estancias, consentimientos, identidad, folio: r.folio, solicitudId: r.id };
  }

  async exportGuestData(propertyId: string, guestId: string, format: ExportFormat): Promise<GuestDataDocument> {
    if (!this.available) throw new PrivacyUnavailableError("exportacion de datos del huesped");
    if (!this.allowedProperties.has(propertyId)) throw new PrivacyAccessDeniedError("exportacion de datos del huesped");
    const g = this.guests.get(guestId);
    if (!g || g.propertyId !== propertyId) throw new PrivacyNotFoundError("Huesped");
    this.exportLog.push({ propertyId, guestId, format });
    return g.doc;
  }

  async grantAccess(requestId: string, guestId: string): Promise<AccessGrant> {
    if (!this.available) throw new PrivacyUnavailableError("enlace de mis datos");
    const r = this.requests.get(requestId);
    if (!r || !this.allowedProperties.has(r.propertyId)) throw new PrivacyAccessDeniedError("enlace de mis datos");
    if (r.rightType !== "acceso" || (r.status !== "procedente" && r.status !== "ejecutada")) throw new PrivacyInvalidInputError("El enlace solo se emite para una solicitud de acceso procedente.");
    const g = this.guests.get(guestId);
    if (!g || g.propertyId !== r.propertyId) throw new PrivacyInvalidInputError("El huesped no pertenece a la property.");
    r.guestId = guestId;
    return { organizationId: r.organizationId, propertyId: r.propertyId, folio: r.folio, contact: r.contact, orgSlug: this.orgSlug ?? "hotel-demo", orgName: this.organizationName ?? "Hotel Demo" };
  }
}
