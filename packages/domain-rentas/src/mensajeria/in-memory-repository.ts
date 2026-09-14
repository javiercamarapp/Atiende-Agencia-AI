// InMemoryRentasMensajeriaRepository — implementación real (no un mock) de
// `RentasMensajeriaRepository`, autocontenida (mismo criterio que
// `InMemoryRentasOwnerPortalRepository`): no comparte estado con
// `InMemoryRentasRepository`/`InMemoryRentasCalendarStore`. Sirve para tests
// determinísticos y como adaptador dev/CI sin Postgres real.
import { randomUUID } from "node:crypto";
import type { RentasMensajeriaRepository } from "./repository.ts";
import type {
  BorradorRecord,
  ConversacionRecord,
  MarcarBorradorAprobadoYEnviadoInput,
  MarcarBorradorRechazadoInput,
  MensajeRecord,
  NewBorradorInput,
  NewConversacionInput,
  NewMensajeInput,
  NewPlantillaInput,
  PlantillaRecord,
  UpdatePlantillaInput,
} from "./types.ts";

function nowIso(): string {
  return new Date().toISOString();
}

export class InMemoryRentasMensajeriaRepository implements RentasMensajeriaRepository {
  private readonly conversaciones = new Map<string, ConversacionRecord>();
  private readonly mensajes = new Map<string, MensajeRecord>();
  private readonly borradores = new Map<string, BorradorRecord>();
  private readonly plantillas = new Map<string, PlantillaRecord>();

  // ---- Conversaciones ----

  async insertConversacion(input: NewConversacionInput): Promise<ConversacionRecord> {
    const record: ConversacionRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      unidadId: input.unidadId,
      canal: input.canal,
      ocupacionId: input.ocupacionId ?? null,
      huespedMinimoId: input.huespedMinimoId ?? null,
      propiedadNombre: input.propiedadNombre,
      huespedNombre: input.huespedNombre ?? null,
      fechaCheckIn: input.fechaCheckIn ?? null,
      fechaCheckOut: input.fechaCheckOut ?? null,
      reservaConfirmada: input.reservaConfirmada ?? false,
      creadoEn: nowIso(),
    };
    this.conversaciones.set(record.id, record);
    return record;
  }

  async findConversacion(propertyId: string, conversacionId: string): Promise<ConversacionRecord | null> {
    const record = this.conversaciones.get(conversacionId);
    if (!record || record.propertyId !== propertyId) return null;
    return record;
  }

  async listConversaciones(propertyId: string, unidadId?: string): Promise<readonly ConversacionRecord[]> {
    return [...this.conversaciones.values()]
      .filter((c) => c.propertyId === propertyId)
      .filter((c) => (unidadId ? c.unidadId === unidadId : true))
      .sort((a, b) => (a.creadoEn < b.creadoEn ? 1 : -1));
  }

  // ---- Mensajes ----

  async insertMensaje(input: NewMensajeInput): Promise<MensajeRecord> {
    const record: MensajeRecord = {
      id: randomUUID(),
      conversacionId: input.conversacionId,
      direccion: input.direccion,
      origen: input.origen,
      texto: input.texto,
      redactado: input.redactado ?? false,
      creadoEn: nowIso(),
    };
    this.mensajes.set(record.id, record);
    return record;
  }

  async findMensajeEntrante(conversacionId: string, mensajeId: string): Promise<MensajeRecord | null> {
    const record = this.mensajes.get(mensajeId);
    if (!record || record.conversacionId !== conversacionId || record.direccion !== "entrante") return null;
    return record;
  }

  async listMensajes(conversacionId: string): Promise<readonly MensajeRecord[]> {
    return [...this.mensajes.values()].filter((m) => m.conversacionId === conversacionId).sort((a, b) => (a.creadoEn < b.creadoEn ? -1 : 1));
  }

  // ---- Borradores ----

  async insertBorrador(input: NewBorradorInput): Promise<BorradorRecord> {
    const now = nowIso();
    const record: BorradorRecord = {
      id: randomUUID(),
      conversacionId: input.conversacionId,
      mensajeEntranteId: input.mensajeEntranteId ?? null,
      canal: input.canal,
      texto: input.texto,
      estado: "pendiente_aprobacion",
      generadoPor: input.generadoPor,
      redactado: false,
      aprobadoPor: null,
      aprobadoEn: null,
      rechazadoPor: null,
      rechazadoEn: null,
      motivoRechazo: null,
      mensajeEnviadoId: null,
      creadoEn: now,
      actualizadoEn: now,
    };
    this.borradores.set(record.id, record);
    return record;
  }

  private conversacionPropertyId(conversacionId: string): string | null {
    return this.conversaciones.get(conversacionId)?.propertyId ?? null;
  }

  async findBorrador(propertyId: string, borradorId: string): Promise<BorradorRecord | null> {
    const record = this.borradores.get(borradorId);
    if (!record) return null;
    if (this.conversacionPropertyId(record.conversacionId) !== propertyId) return null;
    return record;
  }

  async listBorradores(propertyId: string, conversacionId: string): Promise<readonly BorradorRecord[]> {
    if (this.conversacionPropertyId(conversacionId) !== propertyId) return [];
    return [...this.borradores.values()].filter((b) => b.conversacionId === conversacionId).sort((a, b) => (a.creadoEn < b.creadoEn ? 1 : -1));
  }

  async marcarBorradorAprobadoYEnviado(input: MarcarBorradorAprobadoYEnviadoInput): Promise<BorradorRecord> {
    const actual = this.borradores.get(input.id);
    if (!actual) throw new Error(`Borrador ${input.id} no encontrado`);
    const actualizado: BorradorRecord = {
      ...actual,
      estado: "enviado",
      texto: input.textoFinal,
      redactado: input.redactado,
      aprobadoPor: input.aprobadoPor,
      aprobadoEn: nowIso(),
      mensajeEnviadoId: input.mensajeEnviadoId,
      actualizadoEn: nowIso(),
    };
    this.borradores.set(input.id, actualizado);
    return actualizado;
  }

  async marcarBorradorRechazado(input: MarcarBorradorRechazadoInput): Promise<BorradorRecord> {
    const actual = this.borradores.get(input.id);
    if (!actual) throw new Error(`Borrador ${input.id} no encontrado`);
    const actualizado: BorradorRecord = {
      ...actual,
      estado: "rechazado",
      rechazadoPor: input.rechazadoPor,
      rechazadoEn: nowIso(),
      motivoRechazo: input.motivo,
      actualizadoEn: nowIso(),
    };
    this.borradores.set(input.id, actualizado);
    return actualizado;
  }

  async tocarBorradorParaAuditoria(borradorId: string): Promise<void> {
    const actual = this.borradores.get(borradorId);
    if (!actual) return;
    this.borradores.set(borradorId, { ...actual, actualizadoEn: nowIso() });
  }

  // ---- Plantillas ----

  async listPlantillas(organizationId: string, filtro?: { evento?: string; idioma?: string; canal?: string | null }): Promise<readonly PlantillaRecord[]> {
    return [...this.plantillas.values()]
      .filter((p) => p.organizationId === organizationId)
      .filter((p) => (filtro?.evento ? p.evento === filtro.evento : true))
      .filter((p) => (filtro?.idioma ? p.idioma === filtro.idioma : true))
      .filter((p) => (filtro?.canal !== undefined ? p.canal === filtro.canal : true));
  }

  async findPlantilla(organizationId: string, id: string): Promise<PlantillaRecord | null> {
    const record = this.plantillas.get(id);
    if (!record || record.organizationId !== organizationId) return null;
    return record;
  }

  async insertPlantilla(input: NewPlantillaInput): Promise<PlantillaRecord> {
    const now = nowIso();
    const record: PlantillaRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      evento: input.evento,
      idioma: input.idioma,
      canal: input.canal,
      cuerpo: input.cuerpo,
      aprobadaPorTenant: input.aprobadaPorTenant ?? false,
      activa: input.activa ?? true,
      creadoEn: now,
      actualizadoEn: now,
    };
    this.plantillas.set(record.id, record);
    return record;
  }

  async updatePlantilla(input: UpdatePlantillaInput): Promise<PlantillaRecord | null> {
    const actual = this.plantillas.get(input.id);
    if (!actual || actual.organizationId !== input.organizationId) return null;
    const actualizado: PlantillaRecord = {
      ...actual,
      cuerpo: input.cuerpo ?? actual.cuerpo,
      aprobadaPorTenant: input.aprobadaPorTenant ?? actual.aprobadaPorTenant,
      activa: input.activa ?? actual.activa,
      actualizadoEn: nowIso(),
    };
    this.plantillas.set(input.id, actualizado);
    return actualizado;
  }
}
