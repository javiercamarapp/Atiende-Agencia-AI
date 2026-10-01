// Implementacion en memoria (tests y modo sin base). Reproduce las reglas de la migracion 028 que importan al
// comportamiento: una sola toma abierta por conversacion, la segunda toma falla (`HandoffYaTomadoError`), solo
// quien tomo (o un administrador) devuelve/cierra, solo quien tomo responde. NO modela RLS (eso lo verifica
// scripts/verify-restaurantes-conversaciones-handoff/ contra Postgres real).
import { randomUUID } from "node:crypto";
import type { ConversacionesRepository, HandoffAgentGate } from "./repository.ts";
import { ConversacionesNoDisponibleError, ConversacionesRechazadaError, HandoffYaTomadoError, SinNumeroWhatsappError } from "./types.ts";
import type {
  BandejaFiltro,
  BandejaItem,
  BandejaPagina,
  CallbackIntentoEntrada,
  CallbackItem,
  ConversacionCanal,
  ConversacionDetalle,
  ConversacionesLectura,
  HandoffEstado,
  MensajeConversacion,
  NotaInterna,
  TurnoEntrada,
  TurnoPersonal,
} from "./types.ts";

interface ConvSeed {
  readonly canal: ConversacionCanal;
  readonly id: string;
  readonly organizationId: string;
  /** null = conversacion de WhatsApp sin sucursal (aparece en todas las de la organizacion). */
  readonly propertyId: string | null;
  readonly telefono: string | null;
  readonly mensajes: MensajeConversacion[];
  readonly actividadAt: string;
}

interface HandoffRow {
  id: string;
  organizationId: string;
  propertyId: string;
  canal: ConversacionCanal;
  conversationId: string;
  estado: Exclude<HandoffEstado, "agente">;
  solicitadoPor: "agente" | "staff";
  motivo: string | null;
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
  readonly conversaciones: ConvSeed[] = [];
  readonly handoffs: HandoffRow[] = [];
  readonly notas: Array<NotaInterna & { handoffId: string }> = [];
  readonly turnos: Array<{ organizationId: string; propertyId: string; turno: TurnoPersonal }> = [];
  readonly callbacks: Array<CallbackItem & { organizationId: string }> = [];
  readonly outbox: Array<{ organizationId: string; to: string; body: string }> = [];
  /** `false` simula la base sin migrar (todo degrada con el mismo contrato que Postgres). */
  disponible = true;
  /** Numero de WhatsApp configurado por sucursal: sin entrada, responder falla como en la base. */
  readonly numeroPorSucursal = new Set<string>();

  constructor(private readonly opts: InMemoryConversacionesOptions) {}

  /** Otra "sesion" (otra persona autenticada) sobre el MISMO almacen: lo que una escribe, la otra lo ve. */
  comoActor(actorUserId: string, actorEsAdministrador = false): InMemoryConversacionesRepository {
    const r = new InMemoryConversacionesRepository({ ...this.opts, actorUserId, actorEsAdministrador });
    Object.assign(r, { conversaciones: this.conversaciones, handoffs: this.handoffs, notas: this.notas, turnos: this.turnos, callbacks: this.callbacks, outbox: this.outbox, numeroPorSucursal: this.numeroPorSucursal, disponible: this.disponible });
    return r;
  }

  private now(): Date {
    return this.opts.ahora ? this.opts.ahora() : new Date();
  }
  private nombre(id: string | null): string | null {
    return id ? (this.opts.nombres?.[id] ?? null) : null;
  }
  private ultimo(canal: ConversacionCanal, conversationId: string, propertyId: string): HandoffRow | undefined {
    return this.handoffs
      .filter((h) => h.canal === canal && h.conversationId === conversationId && h.propertyId === propertyId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }
  private abierta(canal: ConversacionCanal, conversationId: string): HandoffRow | undefined {
    return this.handoffs.find((h) => h.canal === canal && h.conversationId === conversationId && (h.estado === "pendiente" || h.estado === "tomada"));
  }
  private requerirDisponible(): void {
    if (!this.disponible) throw new ConversacionesNoDisponibleError();
  }

  async listarBandeja(organizationId: string, propertyId: string, filtro: BandejaFiltro): Promise<ConversacionesLectura<BandejaPagina>> {
    if (!this.disponible) return { disponible: false, valor: { items: [], total: 0 } };
    const items: BandejaItem[] = this.conversaciones
      .filter((c) => c.organizationId === organizationId && (c.propertyId === null ? c.canal === "whatsapp" : c.propertyId === propertyId))
      .map((c) => {
        const h = this.ultimo(c.canal, c.id, propertyId);
        return {
          canal: c.canal,
          conversationId: c.id,
          propertyId,
          telefono: c.telefono,
          vistaPrevia: (c.mensajes.at(-1)?.texto ?? "").slice(0, 140),
          actividadAt: c.actividadAt,
          estado: h ? h.estado : "agente",
          handoffId: h?.id ?? null,
          motivo: h?.motivo ?? null,
          solicitadaAt: h?.solicitadaAt ?? null,
          ultimoClienteAt: h?.ultimoClienteAt ?? null,
          tomadaPor: h?.tomadaPor ?? null,
          tomadaPorNombre: this.nombre(h?.tomadaPor ?? null),
          tomadaAt: h?.tomadaAt ?? null,
          resultadoVoz: null,
        } satisfies BandejaItem;
      })
      .filter((i) => (!filtro.estado || i.estado === filtro.estado) && (!filtro.canal || i.canal === filtro.canal));
    const peso = (e: HandoffEstado) => (e === "pendiente" ? 0 : e === "tomada" ? 1 : 2);
    items.sort((a, b) => peso(a.estado) - peso(b.estado) || b.actividadAt.localeCompare(a.actividadAt));
    const limit = Math.min(100, Math.max(1, filtro.limit ?? 25));
    const offset = Math.max(0, filtro.offset ?? 0);
    return { disponible: true, valor: { items: items.slice(offset, offset + limit), total: items.length } };
  }

  async detalle(organizationId: string, propertyId: string, canal: ConversacionCanal, conversationId: string): Promise<ConversacionesLectura<ConversacionDetalle | null>> {
    if (!this.disponible) return { disponible: false, valor: null };
    const c = this.conversaciones.find((x) => x.canal === canal && x.id === conversationId && x.organizationId === organizationId && (x.propertyId === null || x.propertyId === propertyId));
    if (!c) return { disponible: true, valor: null };
    const h = this.ultimo(canal, conversationId, propertyId);
    return {
      disponible: true,
      valor: {
        canal,
        conversationId,
        mensajes: c.mensajes,
        transcripcionDisponible: true,
        handoff: h
          ? { handoffId: h.id, estado: h.estado, solicitadoPor: h.solicitadoPor, motivo: h.motivo, solicitadaAt: h.solicitadaAt, ultimoClienteAt: h.ultimoClienteAt, tomadaPor: h.tomadaPor, tomadaPorNombre: this.nombre(h.tomadaPor), tomadaAt: h.tomadaAt }
          : null,
        notas: h ? this.notas.filter((n) => n.handoffId === h.id) : [],
      },
    };
  }

  async tomar(organizationId: string, propertyId: string, canal: ConversacionCanal, conversationId: string): Promise<string> {
    this.requerirDisponible();
    const c = this.conversaciones.find((x) => x.canal === canal && x.id === conversationId && x.organizationId === organizationId && (x.propertyId === null || x.propertyId === propertyId));
    if (!c) throw new ConversacionesRechazadaError();
    const abierta = this.abierta(canal, conversationId);
    const ahora = this.now().toISOString();
    if (abierta) {
      if (abierta.propertyId !== propertyId) throw new ConversacionesRechazadaError();
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
      id: randomUUID(), organizationId, propertyId, canal, conversationId, estado: "tomada", solicitadoPor: "staff", motivo: null,
      solicitadaAt: ahora, ultimoClienteAt: null, tomadaPor: this.opts.actorUserId, tomadaAt: ahora, createdAt: this.handoffs.length,
    };
    this.handoffs.push(row);
    return row.id;
  }

  private liberar(organizationId: string, propertyId: string, handoffId: string, estado: "devuelta" | "cerrada"): boolean {
    this.requerirDisponible();
    const h = this.handoffs.find((x) => x.id === handoffId && x.organizationId === organizationId && x.propertyId === propertyId);
    if (!h) throw new ConversacionesRechazadaError();
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
    const h = this.handoffs.find((x) => x.id === handoffId && x.organizationId === organizationId && x.propertyId === propertyId);
    if (!h) throw new ConversacionesRechazadaError();
    const n = { id: randomUUID(), handoffId, autorId: this.opts.actorUserId, autorNombre: this.nombre(this.opts.actorUserId), texto: texto.trim(), createdAt: this.now().toISOString() };
    this.notas.push(n);
    return n.id;
  }

  async responderWhatsapp(organizationId: string, propertyId: string, handoffId: string, texto: string): Promise<string> {
    this.requerirDisponible();
    const h = this.handoffs.find((x) => x.id === handoffId && x.organizationId === organizationId && x.propertyId === propertyId && x.canal === "whatsapp");
    if (!h || h.estado !== "tomada" || h.tomadaPor !== this.opts.actorUserId) throw new ConversacionesRechazadaError();
    const conv = this.conversaciones.find((c) => c.id === h.conversationId);
    if (!conv?.telefono) throw new ConversacionesRechazadaError();
    if (!this.numeroPorSucursal.has(propertyId)) throw new SinNumeroWhatsappError();
    conv.mensajes.push({ rol: "humano", texto, createdAt: this.now().toISOString() });
    const id = randomUUID();
    this.outbox.push({ organizationId, to: conv.telefono, body: texto });
    return id;
  }

  async listarTurnos(organizationId: string, propertyId: string): Promise<ConversacionesLectura<readonly TurnoPersonal[]>> {
    if (!this.disponible) return { disponible: false, valor: [] };
    return { disponible: true, valor: this.turnos.filter((t) => t.organizationId === organizationId && t.propertyId === propertyId).map((t) => t.turno) };
  }

  async reemplazarTurnos(organizationId: string, propertyId: string, turnos: readonly TurnoEntrada[]): Promise<void> {
    this.requerirDisponible();
    for (let i = this.turnos.length - 1; i >= 0; i -= 1) {
      if (this.turnos[i]!.organizationId === organizationId && this.turnos[i]!.propertyId === propertyId) this.turnos.splice(i, 1);
    }
    for (const t of turnos) {
      this.turnos.push({
        organizationId,
        propertyId,
        turno: { id: randomUUID(), nombre: t.nombre, dias: t.dias, inicia: t.inicia, termina: t.termina, miembros: t.miembros.map((m) => ({ userId: m.userId, nombre: this.nombre(m.userId), orden: m.orden })) },
      });
    }
  }

  async listarCallbacks(organizationId: string, propertyId: string, soloAbiertos: boolean): Promise<ConversacionesLectura<readonly CallbackItem[]>> {
    if (!this.disponible) return { disponible: false, valor: [] };
    return {
      disponible: true,
      valor: this.callbacks.filter((c) => c.organizationId === organizationId && (c.propertyId === propertyId || c.propertyId === null) && (!soloAbiertos || !c.resolved)),
    };
  }

  async registrarIntentoCallback(organizationId: string, callbackId: string, intento: CallbackIntentoEntrada): Promise<string> {
    this.requerirDisponible();
    const i = this.callbacks.findIndex((c) => c.id === callbackId && c.organizationId === organizationId);
    if (i < 0) throw new ConversacionesRechazadaError();
    const cb = this.callbacks[i]!;
    const id = randomUUID();
    const resuelto = intento.resultado === "contactado" || intento.resultado === "numero_invalido";
    this.callbacks[i] = {
      ...cb,
      resolved: cb.resolved || resuelto,
      intentos: [{ id, resultado: intento.resultado, nota: intento.nota, proximoIntentoAt: intento.proximoIntentoAt, autor: this.nombre(this.opts.actorUserId), creadoAt: this.now().toISOString() }, ...cb.intentos],
    };
    return id;
  }
}

/** Gate en memoria del agente: lee el mismo almacen de tomas que el repositorio. */
export class InMemoryHandoffAgentGate implements HandoffAgentGate {
  constructor(private readonly repo: InMemoryConversacionesRepository) {}

  async estadoParaAgente(organizationId: string, phone: string): Promise<"pendiente" | "tomada" | null> {
    const conv = this.repo.conversaciones.find((c) => c.canal === "whatsapp" && c.organizationId === organizationId && c.telefono === phone);
    if (!conv) return null;
    const h = this.repo.handoffs.find((x) => x.canal === "whatsapp" && x.conversationId === conv.id && (x.estado === "pendiente" || x.estado === "tomada"));
    if (!h) return null;
    h.ultimoClienteAt = new Date().toISOString();
    return h.estado === "pendiente" ? "pendiente" : "tomada";
  }

  async solicitarHumano(input: { organizationId: string; propertyId: string | null; phone: string; motivo: string }): Promise<string | null> {
    if (!this.repo.disponible) return null;
    const conv = this.repo.conversaciones.find((c) => c.canal === "whatsapp" && c.organizationId === input.organizationId && c.telefono === input.phone);
    const propertyId = input.propertyId ?? conv?.propertyId ?? null;
    if (!conv || !propertyId) return null;
    const existente = this.repo.handoffs.find((x) => x.canal === "whatsapp" && x.conversationId === conv.id && (x.estado === "pendiente" || x.estado === "tomada"));
    if (existente) return existente.id;
    const ahora = new Date().toISOString();
    const id = randomUUID();
    this.repo.handoffs.push({
      id, organizationId: input.organizationId, propertyId, canal: "whatsapp", conversationId: conv.id, estado: "pendiente", solicitadoPor: "agente",
      motivo: input.motivo.slice(0, 500), solicitadaAt: ahora, ultimoClienteAt: null, tomadaPor: null, tomadaAt: null, createdAt: this.repo.handoffs.length,
    });
    return id;
  }
}
