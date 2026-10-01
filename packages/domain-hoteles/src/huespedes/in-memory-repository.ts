// Espejo en memoria de PostgresHuespedesRepository (H-27) para tests de ruta, construido sobre la interfaz publica de
// `HotelesRepository` (reservas, habitaciones, tipos y contactos no operativos). NO emula RLS/GRANT/triggers (los cubre
// scripts/verify-hoteles-recepcion-ficha contra Postgres real); SI replica las reglas visibles (minimizacion de PII, bloqueo
// por ARCO, notas solo activas, archivado una vez) y la degradacion "base sin migrar" (`migrated: false`).
import { randomUUID } from "node:crypto";
import type { HotelesRepository } from "../repository.ts";
import type { HuespedesRepository } from "./repository.ts";
import {
  GUEST_NOTE_MAX_LENGTH,
  HuespedesArcoRestrictionError,
  HuespedesInvalidInputError,
  HuespedesNotFoundError,
  HuespedesUnavailableError,
  claveTelefono,
  notaTieneDatoSensible,
  type GuestConsentRow,
  type GuestContactRequestRow,
  type GuestNoteKind,
  type GuestNoteRecord,
  type GuestNotesResult,
  type GuestStayRow,
} from "./tipos.ts";

interface StoredNote extends GuestNoteRecord {
  readonly propertyId: string;
  readonly guestId: string;
  archivedAt: string | null;
}

export class InMemoryHuespedesRepository implements HuespedesRepository {
  private readonly notes = new Map<string, StoredNote>();
  private readonly consents = new Map<string, GuestConsentRow[]>();
  private readonly identities = new Set<string>();
  private readonly arco = new Set<string>();
  private readonly contactos: { propertyId: string; guestPhone: string | null; row: GuestContactRequestRow }[] = [];
  /** `false` simula una base SIN la migracion 038 (notas y bandera ARCO no disponibles). */
  migrated: boolean;
  /** `false` simula una base SIN las migraciones 031/032 (boveda y consentimientos). */
  privacidadDisponible: boolean;

  constructor(
    private readonly hoteles: HotelesRepository,
    opts: { readonly migrated?: boolean; readonly privacidadDisponible?: boolean } = {},
  ) {
    this.migrated = opts.migrated ?? true;
    this.privacidadDisponible = opts.privacidadDisponible ?? true;
  }

  seedConsentimiento(guestId: string, row: GuestConsentRow): void {
    this.consents.set(guestId, [row, ...(this.consents.get(guestId) ?? [])]);
  }
  seedIdentidad(guestId: string): void {
    this.identities.add(guestId);
  }
  /** Solicitud de contacto no operativa (voz/WhatsApp) que `listarContactos` enlaza por telefono. */
  seedContacto(propertyId: string, guestPhone: string | null, row: GuestContactRequestRow): void {
    this.contactos.push({ propertyId, guestPhone, row });
  }
  seedRestriccionArco(guestId: string): void {
    this.arco.add(guestId);
  }

  async listarEstancias(propertyId: string, guestId: string, limit: number): Promise<readonly GuestStayRow[]> {
    const [reservas, tipos, rooms] = await Promise.all([this.hoteles.listReservations(propertyId), this.hoteles.listRoomTypes(propertyId), this.hoteles.listRooms(propertyId)]);
    return reservas
      .filter((r) => r.guestId === guestId)
      .sort((a, b) => b.checkInDate.localeCompare(a.checkInDate))
      .slice(0, limit)
      .map((r) => ({
        reservationId: r.id,
        status: r.status,
        checkInDate: r.checkInDate,
        checkOutDate: r.checkOutDate,
        roomTypeName: tipos.find((t) => t.id === r.roomTypeId)?.name ?? null,
        roomCode: rooms.find((x) => x.id === r.roomId)?.code ?? null,
        netAmountCents: Math.round(r.totalAmount * 100),
      }));
  }

  async listarContactos(propertyId: string, phoneKey: string | null, limit: number): Promise<readonly GuestContactRequestRow[]> {
    if (!phoneKey) return [];
    return this.contactos
      .filter((c) => c.propertyId === propertyId && claveTelefono(c.guestPhone) === phoneKey)
      .map((c) => c.row)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async listarConsentimientos(_propertyId: string, guestId: string): Promise<readonly GuestConsentRow[] | null> {
    return this.privacidadDisponible ? (this.consents.get(guestId) ?? []) : null;
  }

  async tieneIdentidadActiva(_propertyId: string, guestId: string): Promise<boolean | null> {
    return this.privacidadDisponible ? this.identities.has(guestId) : null;
  }

  async tieneRestriccionArco(guestId: string): Promise<boolean | null> {
    return this.migrated ? this.arco.has(guestId) : null;
  }

  async listarNotas(propertyId: string, guestId: string): Promise<GuestNotesResult> {
    if (!this.migrated) return { available: false, items: [] };
    const items = [...this.notes.values()].filter((n) => n.propertyId === propertyId && n.guestId === guestId && n.archivedAt === null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { available: true, items: items.map(({ id, kind, body, createdBy, createdAt }) => ({ id, kind, body, createdBy, createdAt })) };
  }

  /** `actorUserId` lo pone la base con auth.uid(); el espejo lo recibe por `actuarComo` para poder verificar la autoria. */
  private actor: string | null = null;
  actuarComo(userId: string | null): this {
    this.actor = userId;
    return this;
  }

  async agregarNota(input: { readonly propertyId: string; readonly guestId: string; readonly kind: GuestNoteKind; readonly body: string }): Promise<GuestNoteRecord> {
    if (!this.migrated) throw new HuespedesUnavailableError("agregar notas del huesped");
    const guest = await this.hoteles.findGuestById(input.propertyId, input.guestId);
    if (!guest) throw new HuespedesNotFoundError("Huesped");
    const body = input.body.trim();
    if (body.length < 1 || body.length > GUEST_NOTE_MAX_LENGTH) throw new HuespedesInvalidInputError("La nota debe tener entre 1 y 500 caracteres y un tipo valido.");
    if (notaTieneDatoSensible(body)) throw new HuespedesInvalidInputError("no captures numeros de tarjeta ni de documento en una nota");
    if (this.arco.has(input.guestId)) throw new HuespedesArcoRestrictionError();
    const note: StoredNote = { id: randomUUID(), propertyId: input.propertyId, guestId: input.guestId, kind: input.kind, body, createdBy: this.actor, createdAt: new Date().toISOString(), archivedAt: null };
    this.notes.set(note.id, note);
    return { id: note.id, kind: note.kind, body: note.body, createdBy: note.createdBy, createdAt: note.createdAt };
  }

  async archivarNota(propertyId: string, noteId: string): Promise<GuestNoteRecord | null> {
    if (!this.migrated) throw new HuespedesUnavailableError("archivar notas del huesped");
    const note = this.notes.get(noteId);
    if (!note || note.propertyId !== propertyId || note.archivedAt !== null) return null;
    note.archivedAt = new Date().toISOString();
    return { id: note.id, kind: note.kind, body: note.body, createdBy: note.createdBy, createdAt: note.createdAt };
  }
}
