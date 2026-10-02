// Espejo en memoria de la bandeja de conversaciones (H-20) para tests de ruta y de dominio. NO emula RLS/GRANT (los cubre
// scripts/verify-hoteles-conversaciones contra Postgres real); SI replica las reglas visibles de las funciones de la migracion
// 043: transiciones agente/humano/cerrada, "tomar" atomico con un solo ganador, responsable, reasignar solo owner/gm, ventana
// de 24 h, canal de WhatsApp habilitado, minimizacion de datos sensibles y la degradacion "base sin migrar" (`migrated: false`).
import { randomUUID } from "node:crypto";
import type { ConversacionesRepository } from "./repository.ts";
import {
  CONVERSACIONES_ROLES,
  ConversacionesConflictoError,
  ConversacionesNoDisponibleError,
  ConversacionesNoEncontradaError,
  ConversacionesRechazadaError,
  CONFLICTO_MENSAJES,
  claveTelefonoConversacion,
  validarTextoConversacion,
  type ConversacionActor,
  type ConversacionBandeja,
  type ConversacionConflictoCodigo,
  type ConversacionDetalle,
  type ConversacionItem,
  type ConversacionMensaje,
  type ConversacionModo,
  type ConversacionNota,
  type ConversacionesFiltro,
  type ConversacionesSistemaPort,
  type DerivacionResultado,
  type EstadoEnvio,
  type ResponderResultado,
  type TomarResultado,
} from "./tipos.ts";

export interface SeedConversacion {
  readonly id?: string;
  readonly organizationId?: string;
  readonly propertyId: string;
  readonly phone: string;
  readonly modo?: ConversacionModo;
  readonly responsableId?: string | null;
  readonly mensajes?: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  readonly noLeidos?: number;
  readonly ultimoEntranteEn?: Date | null;
}

interface StoredMensaje {
  rol: "user" | "assistant";
  texto: string;
  origen: "huesped" | "agente" | "personal";
  creadoEn: string | null;
  autorId: string | null;
  outboxId: string | null;
}

interface Stored {
  id: string;
  organizationId: string;
  propertyId: string;
  phone: string;
  modo: ConversacionModo;
  responsableId: string | null;
  tomadaEn: Date | null;
  motivo: string | null;
  handoffEn: Date | null;
  handoffN: number;
  ultimoEntranteEn: Date | null;
  noLeidos: number;
  cerradaEn: Date | null;
  actualizadaEn: Date;
  mensajes: StoredMensaje[];
  notas: (ConversacionNota & { readonly propertyId: string })[];
}

export interface OutboxHumano {
  readonly id: string;
  readonly propertyId: string;
  readonly to: string;
  readonly phoneNumberId: string;
  readonly body: string;
  status: "pending" | "processing" | "sent" | "failed" | "dead";
}

export interface NotificacionHandoff {
  readonly evento: "hoteles.conversacion.handoff";
  readonly organizationId: string;
  readonly propertyId: string;
  readonly clave: string;
}

const ESTADO_ENVIO: Record<OutboxHumano["status"], EstadoEnvio> = { pending: "pendiente_envio", processing: "enviando", sent: "enviado", failed: "fallido", dead: "fallido" };

export class InMemoryConversacionesRepository implements ConversacionesRepository {
  private readonly store = new Map<string, Stored>();
  readonly outbox: OutboxHumano[] = [];
  /** Notificaciones que el productor compartido habria emitido (misma clave de dedupe que el adaptador Postgres). */
  readonly notificaciones: NotificacionHandoff[] = [];
  private readonly nombres = new Map<string, string>();
  private readonly canales = new Map<string, string>();
  /** `false` simula una base SIN la migracion 043. */
  migrated: boolean;
  now: () => Date;

  constructor(opts: { readonly migrated?: boolean; readonly now?: () => Date } = {}) {
    this.migrated = opts.migrated ?? true;
    this.now = opts.now ?? (() => new Date());
  }

  seedNombre(userId: string, nombre: string): void {
    this.nombres.set(userId, nombre);
  }
  /** Canal de WhatsApp habilitado de una property (sin esto, responder da `canal_no_configurado`). */
  seedCanal(propertyId: string, phoneNumberId = "100000000000001"): void {
    this.canales.set(propertyId, phoneNumberId);
  }
  quitarCanal(propertyId: string): void {
    this.canales.delete(propertyId);
  }
  seedConversacion(s: SeedConversacion): string {
    const id = s.id ?? randomUUID();
    const modo = s.modo ?? "agente";
    this.store.set(id, {
      id,
      organizationId: s.organizationId ?? randomUUID(),
      propertyId: s.propertyId,
      phone: s.phone,
      modo,
      responsableId: modo === "humano" ? (s.responsableId ?? null) : null,
      tomadaEn: modo === "humano" && s.responsableId ? this.now() : null,
      motivo: null,
      handoffEn: null,
      handoffN: 0,
      ultimoEntranteEn: s.ultimoEntranteEn === undefined ? this.now() : s.ultimoEntranteEn,
      noLeidos: s.noLeidos ?? 0,
      cerradaEn: null,
      actualizadaEn: this.now(),
      mensajes: (s.mensajes ?? []).map((m) => ({ rol: m.role, texto: m.content, origen: m.role === "user" ? "huesped" : "agente", creadoEn: null, autorId: null, outboxId: null })),
      notas: [],
    });
    return id;
  }
  /** Estado crudo (para aserciones). */
  estado(id: string): { modo: ConversacionModo; responsableId: string | null; noLeidos: number; handoffN: number; motivo: string | null; mensajes: number } | null {
    const c = this.store.get(id);
    return c ? { modo: c.modo, responsableId: c.responsableId, noLeidos: c.noLeidos, handoffN: c.handoffN, motivo: c.motivo, mensajes: c.mensajes.length } : null;
  }
  porTelefono(propertyId: string, phone: string): string | null {
    for (const c of this.store.values()) if (c.propertyId === propertyId && c.phone === phone) return c.id;
    return null;
  }
  /** Un mensaje entrante del huesped agregado al historial (lo que hace `whatsapp_append_turn`). */
  agregarMensajeDeHuesped(propertyId: string, phone: string, texto: string, organizationId = randomUUID()): string {
    let id = this.porTelefono(propertyId, phone);
    if (!id) id = this.seedConversacion({ propertyId, phone, organizationId, ultimoEntranteEn: null });
    this.store.get(id)!.mensajes.push({ rol: "user", texto, origen: "huesped", creadoEn: null, autorId: null, outboxId: null });
    return id;
  }

  // ---- Puerto de sistema -----------------------------------------------------------------------------------------------
  sistema(): ConversacionesSistemaPort {
    return {
      registrarEntrante: async (propertyId, phone) => {
        if (!this.migrated) return null;
        const id = this.porTelefono(propertyId, phone);
        const c = id ? this.store.get(id) : undefined;
        if (!c) return null;
        c.ultimoEntranteEn = this.now();
        c.noLeidos = Math.min(c.noLeidos + 1, 9999);
        if (c.modo === "cerrada") {
          c.modo = "agente";
          c.cerradaEn = null;
        }
        return c.modo;
      },
      derivarAHumano: async (propertyId, phone, motivo): Promise<DerivacionResultado | null> => {
        if (!this.migrated) return null;
        const id = this.porTelefono(propertyId, phone);
        const c = id ? this.store.get(id) : undefined;
        if (!c) return null;
        let transicion = false;
        if (c.modo === "agente") {
          c.modo = "humano";
          c.responsableId = null;
          c.tomadaEn = null;
          c.motivo = motivo;
          c.handoffEn = this.now();
          c.handoffN += 1;
          transicion = true;
          this.notificaciones.push({ evento: "hoteles.conversacion.handoff", organizationId: c.organizationId, propertyId, clave: `${c.id}:${c.handoffN}` });
        }
        return { conversationId: c.id, organizationId: c.organizationId, handoffN: c.handoffN, transicion };
      },
    };
  }

  // ---- Staff -----------------------------------------------------------------------------------------------------------
  private exigirMigrada(operacion: string): void {
    if (!this.migrated) throw new ConversacionesNoDisponibleError(operacion);
  }
  private autorizar(actor: ConversacionActor, propertyId: string, id: string): Stored {
    const c = this.store.get(id);
    if (!c || c.propertyId !== propertyId || !CONVERSACIONES_ROLES.includes(actor.role)) throw new ConversacionesNoEncontradaError();
    return c;
  }
  private conflicto(codigo: ConversacionConflictoCodigo): never {
    throw new ConversacionesConflictoError(codigo, CONFLICTO_MENSAJES[codigo]);
  }
  private nombre(userId: string | null): string | null {
    return userId ? (this.nombres.get(userId) ?? null) : null;
  }
  private item(c: Stored): ConversacionItem {
    const ultimo = c.mensajes[c.mensajes.length - 1];
    const clave = claveTelefonoConversacion(c.phone);
    return {
      id: c.id,
      telefono: c.phone,
      modo: c.modo,
      responsableId: c.responsableId,
      responsableNombre: this.nombre(c.responsableId),
      tomadaEn: c.tomadaEn?.toISOString() ?? null,
      motivo: c.motivo,
      handoffEn: c.handoffEn?.toISOString() ?? null,
      noLeidos: c.noLeidos,
      ultimoEntranteEn: c.ultimoEntranteEn?.toISOString() ?? null,
      actividadEn: c.actualizadaEn.toISOString(),
      vistaPrevia: ultimo ? ultimo.texto.slice(0, 160) : null,
      ultimoRol: ultimo ? ultimo.rol : null,
      huespedId: this.huespedes.get(`${c.propertyId}:${clave ?? ""}`)?.id ?? null,
      huespedNombre: this.huespedes.get(`${c.propertyId}:${clave ?? ""}`)?.nombre ?? null,
    };
  }
  private readonly huespedes = new Map<string, { id: string; nombre: string }>();
  /** Huesped de la property enlazado por los ultimos 10 digitos de su telefono. */
  seedHuesped(propertyId: string, phone: string, id: string, nombre: string): void {
    this.huespedes.set(`${propertyId}:${claveTelefonoConversacion(phone) ?? ""}`, { id, nombre });
  }

  async listar(actor: ConversacionActor, propertyId: string, f: ConversacionesFiltro): Promise<ConversacionBandeja> {
    if (!this.migrated) return { disponible: false, total: 0, items: [] };
    if (!CONVERSACIONES_ROLES.includes(actor.role)) throw new ConversacionesRechazadaError();
    const filas = [...this.store.values()]
      .filter((c) => c.propertyId === propertyId)
      .filter((c) => {
        if (f.modo === null) return true;
        if (f.modo === "por_atender") return c.modo === "humano" && c.responsableId === null;
        return c.modo === f.modo;
      })
      .filter((c) => !f.soloNoLeidas || c.noLeidos > 0)
      .filter((c) => f.telefonoClave === null || c.phone.replace(/\D/g, "").endsWith(f.telefonoClave))
      .sort((a, b) => {
        const pa = a.modo === "humano" && a.responsableId === null ? 1 : 0;
        const pb = b.modo === "humano" && b.responsableId === null ? 1 : 0;
        if (pa !== pb) return pb - pa;
        const ua = a.noLeidos > 0 ? 1 : 0;
        const ub = b.noLeidos > 0 ? 1 : 0;
        if (ua !== ub) return ub - ua;
        return b.actualizadaEn.getTime() - a.actualizadaEn.getTime();
      });
    return { disponible: true, total: filas.length, items: filas.slice(f.offset, f.offset + f.limit).map((c) => this.item(c)) };
  }

  async detalle(actor: ConversacionActor, propertyId: string, id: string): Promise<{ disponible: boolean; valor: ConversacionDetalle | null }> {
    if (!this.migrated) return { disponible: false, valor: null };
    const c = this.store.get(id);
    if (!c || c.propertyId !== propertyId || !CONVERSACIONES_ROLES.includes(actor.role)) return { disponible: true, valor: null };
    const mensajes: ConversacionMensaje[] = c.mensajes.slice(-200).map((m) => {
      const out = m.outboxId ? this.outbox.find((o) => o.id === m.outboxId) : undefined;
      return { rol: m.rol, origen: m.origen, texto: m.texto, creadoEn: m.creadoEn, autorId: m.autorId, envio: m.origen === "personal" ? (out ? ESTADO_ENVIO[out.status] : "pendiente_envio") : null };
    });
    return { disponible: true, valor: { ...this.item(c), propertyId: c.propertyId, handoffN: c.handoffN, cerradaEn: c.cerradaEn?.toISOString() ?? null, totalMensajes: c.mensajes.length, mensajes, notas: c.notas.map(({ propertyId: _p, ...n }) => n) } };
  }

  async leer(actor: ConversacionActor, propertyId: string, id: string): Promise<void> {
    this.exigirMigrada("marcar la conversación como leída");
    this.autorizar(actor, propertyId, id).noLeidos = 0;
  }

  async tomar(actor: ConversacionActor, propertyId: string, id: string, reasignar: boolean): Promise<TomarResultado> {
    this.exigirMigrada("tomar la conversación");
    const c = this.autorizar(actor, propertyId, id);
    if (reasignar && actor.role !== "owner" && actor.role !== "gm") throw new ConversacionesRechazadaError("Solo owner o gm pueden reasignar una conversación.");
    const libre = c.modo === "agente" || (c.modo === "humano" && (c.responsableId === null || c.responsableId === actor.userId || reasignar));
    if (!libre) this.conflicto(c.modo === "cerrada" ? "cerrada" : "ya_tomada");
    if (c.modo === "agente") c.motivo = "tomada_por_personal";
    c.handoffEn ??= this.now();
    if (c.responsableId !== actor.userId) c.tomadaEn = this.now();
    c.modo = "humano";
    c.responsableId = actor.userId;
    return { modo: c.modo, responsableId: c.responsableId, tomadaEn: c.tomadaEn?.toISOString() ?? null };
  }

  async devolver(actor: ConversacionActor, propertyId: string, id: string): Promise<ConversacionModo> {
    this.exigirMigrada("devolver la conversación al agente");
    const c = this.autorizar(actor, propertyId, id);
    if (c.modo !== "humano") this.conflicto("no_en_humano");
    if (c.responsableId !== null && c.responsableId !== actor.userId && actor.role !== "owner" && actor.role !== "gm") {
      throw new ConversacionesRechazadaError("Solo la persona responsable, owner o gm pueden devolver la conversación.");
    }
    c.modo = "agente";
    c.responsableId = null;
    c.tomadaEn = null;
    return c.modo;
  }

  async cerrar(actor: ConversacionActor, propertyId: string, id: string): Promise<ConversacionModo> {
    this.exigirMigrada("cerrar la conversación");
    const c = this.autorizar(actor, propertyId, id);
    if (c.modo === "cerrada") this.conflicto("ya_cerrada");
    if (c.modo === "humano" && c.responsableId !== null && c.responsableId !== actor.userId && actor.role !== "owner" && actor.role !== "gm") {
      throw new ConversacionesRechazadaError("Solo la persona responsable, owner o gm pueden cerrar la conversación.");
    }
    c.modo = "cerrada";
    c.responsableId = null;
    c.tomadaEn = null;
    c.cerradaEn = this.now();
    c.noLeidos = 0;
    return c.modo;
  }

  async agregarNota(actor: ConversacionActor, propertyId: string, id: string, texto: string): Promise<string> {
    this.exigirMigrada("agregar la nota");
    const c = this.autorizar(actor, propertyId, id);
    const limpio = validarTextoConversacion(texto, "texto");
    const nota = { id: randomUUID(), autorId: actor.userId, autorNombre: this.nombre(actor.userId), texto: limpio, creadaEn: this.now().toISOString(), propertyId };
    c.notas.push(nota);
    return nota.id;
  }

  async responder(actor: ConversacionActor, propertyId: string, id: string, texto: string): Promise<ResponderResultado> {
    this.exigirMigrada("responder la conversación");
    const c = this.autorizar(actor, propertyId, id);
    if (c.modo !== "humano") this.conflicto("no_en_humano");
    if (c.responsableId !== actor.userId) this.conflicto("no_eres_responsable");
    const limpio = validarTextoConversacion(texto, "texto");
    const ultima = c.ultimoEntranteEn ?? c.actualizadaEn;
    if (this.now().getTime() - ultima.getTime() > 24 * 3600_000) this.conflicto("ventana_24h");
    const phoneNumberId = this.canales.get(propertyId);
    if (!phoneNumberId) this.conflicto("canal_no_configurado");
    const outboxId = randomUUID();
    this.outbox.push({ id: outboxId, propertyId, to: c.phone, phoneNumberId: phoneNumberId!, body: limpio, status: "pending" });
    c.mensajes.push({ rol: "assistant", texto: limpio, origen: "personal", creadoEn: this.now().toISOString(), autorId: actor.userId, outboxId });
    c.noLeidos = 0;
    c.actualizadaEn = this.now();
    return { outboxId, envio: "pendiente_envio" };
  }
}
