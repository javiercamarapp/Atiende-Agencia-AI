// Implementacion en memoria (tests y modo sin base). Reproduce las reglas de la migracion 031 que importan al comportamiento: una sola toma
// abierta por conversacion, la segunda toma falla (`HandoffYaTomadoError`), solo quien tomo (o un administrador) devuelve/cierra, solo quien
// tomo responde, transiciones sin retorno desde un estado final. NO modela RLS ni GRANT (eso lo verifica scripts/verify-citas-conversaciones-handoff/
// contra Postgres real).
import { randomUUID } from "node:crypto";
import type { ConversacionesRepository, HandoffAgentGate } from "./repository.ts";
import { ConversacionesNoDisponibleError, ConversacionesRechazadaError, ConversacionesValidacionError, HandoffYaTomadoError, NOTA_MAX, RESPUESTA_MAX, SinNumeroWhatsappError } from "./types.ts";
import type { BandejaFiltro, BandejaItem, BandejaPagina, ConversacionDetalle, ConversacionesLectura, HandoffEstado, MensajeConversacion, NotaInterna } from "./types.ts";

export interface ConversacionSemilla {
  readonly id: string;
  readonly organizationId: string;
  /** null = conversacion sin sucursal (aparece en todas las de la organizacion). */
  readonly propertyId: string | null;
  readonly telefono: string;
  readonly mensajes: MensajeConversacion[];
  readonly actividadAt: string;
  readonly citaId?: string | null;
  readonly citaInicio?: string | null;
  readonly citaEstado?: string | null;
}

interface HandoffRow {
  id: string;
  organizationId: string;
  propertyId: string | null;
  conversationId: string;
  estado: Exclude<HandoffEstado, "agente">;
  solicitadoPor: "agente" | "staff";
  motivo: string | null;
  crisis: boolean;
  solicitadaAt: string;
  ultimoClienteAt: string | null;
  tomadaPor: string | null;
  tomadaAt: string | null;
  createdAt: number;
}

export interface InMemoryConversacionesOptions {
  /** Persona autenticada que actua (equivale a `auth.uid()`). */
  readonly actorUserId: string;
  /** El actor es owner/admin (puede devolver tomas ajenas). */
  readonly actorEsAdministrador?: boolean;
  readonly nombres?: Readonly<Record<string, string>>;
  readonly ahora?: () => Date;
}

export class InMemoryConversacionesRepository implements ConversacionesRepository {
  readonly conversaciones: ConversacionSemilla[] = [];
  readonly handoffs: HandoffRow[] = [];
  readonly notas: Array<NotaInterna & { handoffId: string }> = [];
  readonly outbox: Array<{ id: string; organizationId: string; to: string; body: string }> = [];
  /** Conversaciones (por telefono) con una escalacion de crisis sin resolver. */
  readonly telefonosEnCrisis = new Set<string>();
  /** Notificaciones que el productor compartido habria emitido (misma clave de dedupe que el adaptador Postgres). */
  readonly notificaciones: Array<{ evento: "citas.conversacion.handoff"; organizationId: string; clave: string; critica: boolean }> = [];
  /** `false` simula la base sin migrar (todo degrada con el mismo contrato que Postgres). */
  disponible = true;
  /** Organizaciones con un numero de WhatsApp activo: sin entrada, responder falla como en la base. */
  readonly organizacionesConNumero = new Set<string>();

  constructor(private readonly opts: InMemoryConversacionesOptions) {}

  /** Otra "sesion" (otra persona autenticada) sobre el MISMO almacen: lo que una escribe, la otra lo ve. */
  comoActor(actorUserId: string, actorEsAdministrador = false): InMemoryConversacionesRepository {
    const r = new InMemoryConversacionesRepository({ ...this.opts, actorUserId, actorEsAdministrador });
    Object.assign(r, {
      conversaciones: this.conversaciones,
      handoffs: this.handoffs,
      notas: this.notas,
      outbox: this.outbox,
      telefonosEnCrisis: this.telefonosEnCrisis,
      notificaciones: this.notificaciones,
      organizacionesConNumero: this.organizacionesConNumero,
    });
    Object.defineProperty(r, "disponible", { get: () => this.disponible, set: (v: boolean) => { this.disponible = v; } });
    return r;
  }

  private now(): Date {
    return this.opts.ahora ? this.opts.ahora() : new Date();
  }
  private nombre(id: string | null): string | null {
    return id ? (this.opts.nombres?.[id] ?? null) : null;
  }
  private ultimo(conversationId: string): HandoffRow | undefined {
    return this.handoffs.filter((h) => h.conversationId === conversationId).sort((a, b) => b.createdAt - a.createdAt)[0];
  }
  private abierta(conversationId: string): HandoffRow | undefined {
    return this.handoffs.find((h) => h.conversationId === conversationId && (h.estado === "pendiente" || h.estado === "tomada"));
  }
  private requerirDisponible(): void {
    if (!this.disponible) throw new ConversacionesNoDisponibleError();
  }
  private visible(c: ConversacionSemilla, organizationId: string, propertyId: string): boolean {
    return c.organizationId === organizationId && (c.propertyId === null || c.propertyId === propertyId);
  }
  private handoffDe(organizationId: string, propertyId: string, handoffId: string): HandoffRow {
    const h = this.handoffs.find((x) => x.id === handoffId && x.organizationId === organizationId && (x.propertyId === null || x.propertyId === propertyId));
    if (!h) throw new ConversacionesRechazadaError();
    return h;
  }

  async listarBandeja(organizationId: string, propertyId: string, filtro: BandejaFiltro): Promise<ConversacionesLectura<BandejaPagina>> {
    if (!this.disponible) return { disponible: false, valor: { items: [], total: 0 } };
    const items: BandejaItem[] = this.conversaciones
      .filter((c) => this.visible(c, organizationId, propertyId))
      .map((c) => {
        const h = this.ultimo(c.id);
        return {
          conversationId: c.id,
          propertyId: c.propertyId ?? propertyId,
          telefono: c.telefono,
          vistaPrevia: (c.mensajes.at(-1)?.texto ?? "").slice(0, 140),
          actividadAt: c.actividadAt,
          estado: h ? h.estado : "agente",
          handoffId: h?.id ?? null,
          motivo: h?.motivo ?? null,
          crisis: this.telefonosEnCrisis.has(c.telefono) || h?.crisis === true,
          solicitadaAt: h?.solicitadaAt ?? null,
          ultimoClienteAt: h?.ultimoClienteAt ?? null,
          tomadaPor: h?.tomadaPor ?? null,
          tomadaPorNombre: this.nombre(h?.tomadaPor ?? null),
          tomadaAt: h?.tomadaAt ?? null,
          citaId: c.citaId ?? null,
          citaInicio: c.citaInicio ?? null,
          citaEstado: c.citaEstado ?? null,
        } satisfies BandejaItem;
      })
      .filter((i) => !filtro.estado || i.estado === filtro.estado);
    const peso = (e: HandoffEstado) => (e === "pendiente" ? 0 : e === "tomada" ? 1 : 2);
    items.sort((a, b) => Number(b.crisis) - Number(a.crisis) || peso(a.estado) - peso(b.estado) || b.actividadAt.localeCompare(a.actividadAt));
    const limit = Math.min(100, Math.max(1, filtro.limit ?? 25));
    const offset = Math.max(0, filtro.offset ?? 0);
    return { disponible: true, valor: { items: items.slice(offset, offset + limit), total: items.length } };
  }

  async detalle(organizationId: string, propertyId: string, conversationId: string): Promise<ConversacionesLectura<ConversacionDetalle | null>> {
    if (!this.disponible) return { disponible: false, valor: null };
    const c = this.conversaciones.find((x) => x.id === conversationId && this.visible(x, organizationId, propertyId));
    if (!c) return { disponible: true, valor: null };
    const h = this.ultimo(conversationId);
    return {
      disponible: true,
      valor: {
        conversationId,
        telefono: c.telefono,
        mensajes: c.mensajes,
        citaId: c.citaId ?? null,
        handoff: h
          ? {
              handoffId: h.id, estado: h.estado, solicitadoPor: h.solicitadoPor, motivo: h.motivo, crisis: h.crisis, solicitadaAt: h.solicitadaAt,
              ultimoClienteAt: h.ultimoClienteAt, tomadaPor: h.tomadaPor, tomadaPorNombre: this.nombre(h.tomadaPor), tomadaAt: h.tomadaAt,
            }
          : null,
        notas: h ? this.notas.filter((n) => n.handoffId === h.id) : [],
      },
    };
  }

  async tomar(organizationId: string, propertyId: string, conversationId: string): Promise<string> {
    this.requerirDisponible();
    const c = this.conversaciones.find((x) => x.id === conversationId && this.visible(x, organizationId, propertyId));
    if (!c) throw new ConversacionesRechazadaError();
    const abierta = this.abierta(conversationId);
    const ahora = this.now().toISOString();
    if (abierta) {
      if (abierta.estado === "tomada") {
        if (abierta.tomadaPor === this.opts.actorUserId) return abierta.id;
        throw new HandoffYaTomadoError();
      }
      abierta.estado = "tomada";
      abierta.tomadaPor = this.opts.actorUserId;
      abierta.tomadaAt = ahora;
      return abierta.id;
    }
    const row: HandoffRow = {
      id: randomUUID(), organizationId, propertyId: c.propertyId, conversationId, estado: "tomada", solicitadoPor: "staff", motivo: null, crisis: false,
      solicitadaAt: ahora, ultimoClienteAt: null, tomadaPor: this.opts.actorUserId, tomadaAt: ahora, createdAt: this.handoffs.length,
    };
    this.handoffs.push(row);
    return row.id;
  }

  private liberar(organizationId: string, propertyId: string, handoffId: string, estado: "devuelta" | "cerrada"): boolean {
    this.requerirDisponible();
    const h = this.handoffDe(organizationId, propertyId, handoffId);
    if (h.estado !== "pendiente" && h.estado !== "tomada") return false;
    if (h.estado === "tomada" && h.tomadaPor !== this.opts.actorUserId && !this.opts.actorEsAdministrador) throw new ConversacionesRechazadaError();
    h.estado = estado;
    return true;
  }
  async devolver(organizationId: string, propertyId: string, handoffId: string): Promise<boolean> {
    return this.liberar(organizationId, propertyId, handoffId, "devuelta");
  }
  async cerrar(organizationId: string, propertyId: string, handoffId: string): Promise<boolean> {
    return this.liberar(organizationId, propertyId, handoffId, "cerrada");
  }

  async agregarNota(organizationId: string, propertyId: string, handoffId: string, texto: string): Promise<string> {
    this.requerirDisponible();
    const h = this.handoffDe(organizationId, propertyId, handoffId);
    const limpio = texto.trim();
    if (limpio.length < 1 || limpio.length > NOTA_MAX) throw new ConversacionesValidacionError("Dato fuera de rango (revisa el texto del mensaje o de la nota).");
    const n = { id: randomUUID(), handoffId: h.id, autorId: this.opts.actorUserId, autorNombre: this.nombre(this.opts.actorUserId), texto: limpio, createdAt: this.now().toISOString() };
    this.notas.push(n);
    return n.id;
  }

  async responder(organizationId: string, propertyId: string, handoffId: string, texto: string): Promise<string> {
    this.requerirDisponible();
    const h = this.handoffDe(organizationId, propertyId, handoffId);
    const limpio = texto.trim();
    if (limpio.length < 1 || limpio.length > RESPUESTA_MAX) throw new ConversacionesValidacionError("Dato fuera de rango (revisa el texto del mensaje o de la nota).");
    if (h.estado !== "tomada" || h.tomadaPor !== this.opts.actorUserId) throw new ConversacionesRechazadaError();
    const conv = this.conversaciones.find((c) => c.id === h.conversationId);
    if (!conv) throw new ConversacionesRechazadaError();
    if (!this.organizacionesConNumero.has(organizationId)) throw new SinNumeroWhatsappError();
    conv.mensajes.push({ rol: "humano", texto: limpio });
    const id = randomUUID();
    this.outbox.push({ id, organizationId, to: conv.telefono, body: limpio });
    return id;
  }
}

/** Gate en memoria del agente: lee el mismo almacen de tomas que el repositorio. */
export class InMemoryHandoffAgentGate implements HandoffAgentGate {
  constructor(private readonly repo: InMemoryConversacionesRepository) {}

  async estadoParaAgente(organizationId: string, phone: string): Promise<"pendiente" | "tomada" | null> {
    if (!this.repo.disponible) return null;
    const conv = this.repo.conversaciones.find((c) => c.organizationId === organizationId && c.telefono === phone);
    if (!conv) return null;
    const h = this.repo.handoffs.find((x) => x.conversationId === conv.id && (x.estado === "pendiente" || x.estado === "tomada"));
    if (!h) return null;
    h.ultimoClienteAt = new Date().toISOString();
    return h.estado === "pendiente" ? "pendiente" : "tomada";
  }

  async solicitarHumano(input: { readonly organizationId: string; readonly phone: string; readonly motivo: string; readonly crisis: boolean }): Promise<string | null> {
    if (!this.repo.disponible) return null;
    const conv = this.repo.conversaciones.find((c) => c.organizationId === input.organizationId && c.telefono === input.phone);
    if (!conv) return null;
    const existente = this.repo.handoffs.find((x) => x.conversationId === conv.id && (x.estado === "pendiente" || x.estado === "tomada"));
    if (existente) return existente.id;
    const ahora = new Date().toISOString();
    const id = randomUUID();
    this.repo.handoffs.push({
      id, organizationId: input.organizationId, propertyId: conv.propertyId, conversationId: conv.id, estado: "pendiente", solicitadoPor: "agente",
      motivo: input.motivo.slice(0, 500), crisis: input.crisis, solicitadaAt: ahora, ultimoClienteAt: null, tomadaPor: null, tomadaAt: null, createdAt: this.repo.handoffs.length,
    });
    this.repo.notificaciones.push({ evento: "citas.conversacion.handoff", organizationId: input.organizationId, clave: id, critica: input.crisis });
    return id;
  }
}
