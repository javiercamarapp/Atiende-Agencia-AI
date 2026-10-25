// Repositorio en memoria de los agregados para pruebas unitarias y la API simulada de e2e. Reproduce los contratos de la base (un solo abierto por
// pedido con fusion, compare-and-set sobre `pendiente`, aceptar aplica los renglones al pedido, alcance por sucursal); la SEMANTICA REAL de SQL (RLS,
// grants, trigger, concurrencia) la prueba scripts/verify-restaurantes-agregados contra Postgres. No es produccion.
import { randomUUID } from "node:crypto";
import type { OrderStatus, PersistedOrderItem } from "../types.ts";
import { fusionarRenglones } from "./fusion.ts";
import { AGREGADO_MAX_RENGLONES, SLA_AGREGADO, pedidoAceptaAgregado } from "./tipos.ts";
import type {
  AgregadosRepository, AgregadoVista, DecisionAgregado, EstadoAgregado, EventoAgregadoEntrada, FiltroAgregados, LecturaAgregados, MotivoRechazoAgregado, NuevoAgregado,
  OpcionesDecidir, ResultadoCrearAgregado, ResultadoDecidirAgregado,
} from "./tipos.ts";

/** El pedido tal como lo ve este repositorio (las pruebas lo siembran; en produccion es `restaurantes.orders`). */
export interface PedidoAgregableMemoria {
  id: string;
  organizationId: string;
  propertyId: string;
  sucursal: string | null;
  orderNumber: number | null;
  status: OrderStatus;
  items: PersistedOrderItem[];
  total: number;
  customerName: string;
  customerPhone: string;
  createdAt: string;
}

interface FilaAgregado {
  id: string;
  organizationId: string;
  propertyId: string;
  orderId: string;
  estado: EstadoAgregado;
  channel: "whatsapp" | "voice";
  itemsAdded: PersistedOrderItem[];
  totalBefore: number;
  totalAdded: number;
  totalAfter: number;
  customerNote: string | null;
  version: number;
  requestedAt: string;
  firstSeenAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  rejectReason: MotivoRechazoAgregado | null;
  rejectNote: string | null;
  escalationLevel: 0 | 1 | 2;
  escalatedAt: string | null;
  sourceEventId: string | null;
}

export interface EventoMemoria extends EventoAgregadoEntrada {
  readonly at: string;
}

const redondear = (n: number): number => Math.round(n * 100) / 100;

export class InMemoryAgregadosRepository implements AgregadosRepository {
  readonly pedidos = new Map<string, PedidoAgregableMemoria>();
  readonly eventos: EventoMemoria[] = [];
  /** Nombre visible de quien decide (la base lo une con core.staff_user). */
  readonly nombresPersonal = new Map<string, string>();
  private readonly filas: FilaAgregado[] = [];
  /** `false` simula la base sin la migracion 099: todo devuelve «no disponible». */
  disponible = true;
  ahora: () => Date = () => new Date();

  /** Solo pruebas: siembra un pedido. */
  sembrarPedido(p: PedidoAgregableMemoria): void {
    this.pedidos.set(p.id, { ...p, items: [...p.items] });
  }

  /** Solo pruebas: retrocede el cronometro de una solicitud (minutos de espera) sin esperar de verdad. */
  envejecer(id: string, minutos: number): void {
    const f = this.filas.find((x) => x.id === id);
    if (f) f.requestedAt = new Date(this.ahora().getTime() - minutos * 60_000).toISOString();
  }

  private enAlcance(propertyId: string, propertyIds: readonly string[] | null): boolean {
    return propertyIds === null || propertyIds.includes(propertyId);
  }

  private vista(f: FilaAgregado): AgregadoVista {
    const p = this.pedidos.get(f.orderId);
    return {
      id: f.id,
      organizationId: f.organizationId,
      propertyId: f.propertyId,
      sucursal: p?.sucursal ?? null,
      orderId: f.orderId,
      orderNumber: p?.orderNumber ?? null,
      orderStatus: p?.status ?? "pending",
      orderItems: p ? [...p.items] : [],
      orderTotal: p?.total ?? f.totalBefore,
      orderCreatedAt: p?.createdAt ?? f.requestedAt,
      customerName: p?.customerName ?? "Cliente",
      customerPhone: p?.customerPhone ?? "",
      estado: f.estado,
      channel: f.channel,
      itemsAdded: [...f.itemsAdded],
      totalBefore: f.totalBefore,
      totalAdded: f.totalAdded,
      totalAfter: f.totalAfter,
      customerNote: f.customerNote,
      version: f.version,
      requestedAt: f.requestedAt,
      firstSeenAt: f.firstSeenAt,
      decidedAt: f.decidedAt,
      decidedBy: f.decidedBy,
      decidedByName: f.decidedBy ? (this.nombresPersonal.get(f.decidedBy) ?? null) : null,
      rejectReason: f.rejectReason,
      rejectNote: f.rejectNote,
      escalationLevel: f.escalationLevel,
      escalatedAt: f.escalatedAt,
    };
  }

  async crear(input: NuevoAgregado): Promise<ResultadoCrearAgregado> {
    if (!this.disponible) return { estado: "no_disponible" };
    if (input.items.length === 0 || input.items.length > AGREGADO_MAX_RENGLONES) throw new Error("renglones fuera de rango");
    if (input.sourceEventId) {
      const repetido = this.filas.find((f) => f.organizationId === input.organizationId && f.sourceEventId === input.sourceEventId);
      if (repetido) return { estado: "repetido", agregado: this.vista(repetido) };
    }
    const pedido = this.pedidos.get(input.orderId);
    if (!pedido || pedido.organizationId !== input.organizationId || pedido.propertyId !== input.propertyId) return { estado: "pedido_no_encontrado" };
    if (!pedidoAceptaAgregado(pedido.status)) return { estado: "pedido_no_agregable", orderStatus: pedido.status };
    const sumar = input.items.reduce((s, i) => s + i.price * i.quantity, 0);
    const abierto = this.filas.find((f) => f.orderId === input.orderId && f.estado === "pendiente");
    if (abierto) {
      if (input.sourceEventId && this.eventos.some((e) => e.amendmentId === abierto.id && e.detalle?.["fuente"] === input.sourceEventId)) return { estado: "repetido", agregado: this.vista(abierto) };
      // Fusion: mismas lineas se suman por id+nombre; el cronometro (requestedAt) NO se reinicia.
      abierto.itemsAdded = fusionarRenglones(abierto.itemsAdded, input.items);
      if (abierto.itemsAdded.length > AGREGADO_MAX_RENGLONES) throw new Error("renglones fuera de rango");
      abierto.totalAdded = redondear(abierto.totalAdded + sumar);
      abierto.totalAfter = redondear(abierto.totalBefore + abierto.totalAdded);
      abierto.version += 1;
      if (input.customerNote) abierto.customerNote = [abierto.customerNote, input.customerNote].filter(Boolean).join(" | ").slice(0, 300);
      await this.registrarEvento({ amendmentId: abierto.id, organizationId: abierto.organizationId, propertyId: abierto.propertyId, tipoEvento: "fusionado", actor: { tipo: "agente" }, detalle: { version: abierto.version, ...(input.sourceEventId ? { fuente: input.sourceEventId } : {}) } });
      return { estado: "fusionado", agregado: this.vista(abierto) };
    }
    const fila: FilaAgregado = {
      id: randomUUID(),
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      orderId: input.orderId,
      estado: "pendiente",
      channel: input.channel,
      itemsAdded: input.items.map((i) => ({ ...i })),
      totalBefore: pedido.total,
      totalAdded: redondear(sumar),
      totalAfter: redondear(pedido.total + sumar),
      customerNote: input.customerNote ? input.customerNote.slice(0, 300) : null,
      version: 1,
      requestedAt: this.ahora().toISOString(),
      firstSeenAt: null,
      decidedAt: null,
      decidedBy: null,
      rejectReason: null,
      rejectNote: null,
      escalationLevel: 0,
      escalatedAt: null,
      sourceEventId: input.sourceEventId ?? null,
    };
    this.filas.push(fila);
    await this.registrarEvento({ amendmentId: fila.id, organizationId: fila.organizationId, propertyId: fila.propertyId, tipoEvento: "creado", actor: { tipo: "agente" }, detalle: { canal: fila.channel, renglones: fila.itemsAdded.length, ...(input.sourceEventId ? { fuente: input.sourceEventId } : {}) } });
    return { estado: "creado", agregado: this.vista(fila) };
  }

  async listar(organizationId: string, filtro: FiltroAgregados): Promise<LecturaAgregados<readonly AgregadoVista[]>> {
    if (!this.disponible) return { disponible: false, valor: [] };
    const filas = this.filas
      .filter((f) => f.organizationId === organizationId && this.enAlcance(f.propertyId, filtro.propertyIds))
      .filter((f) => !filtro.estados || filtro.estados.includes(f.estado))
      .filter((f) => !filtro.desde || Date.parse(f.requestedAt) >= Date.parse(filtro.desde))
      .sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt))
      .slice(0, filtro.limite);
    return { disponible: true, valor: filas.map((f) => this.vista(f)) };
  }

  async obtener(organizationId: string, id: string, propertyIds: readonly string[] | null): Promise<LecturaAgregados<AgregadoVista | null>> {
    if (!this.disponible) return { disponible: false, valor: null };
    const f = this.filas.find((x) => x.id === id && x.organizationId === organizationId && this.enAlcance(x.propertyId, propertyIds));
    return { disponible: true, valor: f ? this.vista(f) : null };
  }

  async marcarVisto(organizationId: string, id: string, actorUserId: string, propertyIds: readonly string[] | null): Promise<void> {
    if (!this.disponible) return;
    const f = this.filas.find((x) => x.id === id && x.organizationId === organizationId && this.enAlcance(x.propertyId, propertyIds));
    if (!f || f.estado !== "pendiente" || f.firstSeenAt) return;
    f.firstSeenAt = this.ahora().toISOString();
    await this.registrarEvento({ amendmentId: f.id, organizationId, propertyId: f.propertyId, tipoEvento: "visto", actor: { tipo: "usuario", userId: actorUserId } });
  }

  async decidir(organizationId: string, id: string, decision: DecisionAgregado, actorUserId: string, propertyIds: readonly string[] | null, opciones?: OpcionesDecidir): Promise<ResultadoDecidirAgregado> {
    if (!this.disponible) return { resultado: "no_disponible" };
    const f = this.filas.find((x) => x.id === id && x.organizationId === organizationId);
    if (!f) return { resultado: "no_encontrado" };
    if (!this.enAlcance(f.propertyId, propertyIds)) return { resultado: "no_encontrado" }; // nunca se distingue «no existe» de «es de otra sucursal»
    if (f.estado !== "pendiente") return { resultado: "ya_resuelto", agregado: this.vista(f) };
    // Una pendiente con 20+ minutos YA esta vencida aunque el tick no la haya cerrado: se cierra aqui y no se acepta ni se rechaza.
    if (this.ahora().getTime() - Date.parse(f.requestedAt) >= SLA_AGREGADO.vencimientoMin * 60_000) {
      await this.vencer(organizationId, id, this.ahora());
      return { resultado: "vencido", agregado: this.vista(f) };
    }
    if (opciones?.versionEsperada !== undefined && opciones.versionEsperada !== f.version) return { resultado: "version_cambio", agregado: this.vista(f) };
    const ahora = this.ahora().toISOString();
    if (decision.tipo === "rechazar") {
      f.estado = "rechazado";
      f.rejectReason = decision.motivo;
      f.rejectNote = decision.nota ? decision.nota.slice(0, 300) : null;
      f.decidedAt = ahora;
      f.decidedBy = actorUserId;
      await this.registrarEvento({ amendmentId: f.id, organizationId, propertyId: f.propertyId, tipoEvento: "rechazado", actor: { tipo: "usuario", userId: actorUserId }, detalle: { motivo: decision.motivo } });
      return { resultado: "aplicado", agregado: this.vista(f) };
    }
    const pedido = this.pedidos.get(f.orderId);
    if (!pedido || !pedidoAceptaAgregado(pedido.status)) {
      f.estado = "no_aplicable";
      f.decidedAt = ahora;
      f.decidedBy = actorUserId;
      await this.registrarEvento({ amendmentId: f.id, organizationId, propertyId: f.propertyId, tipoEvento: "no_aplicable", actor: { tipo: "usuario", userId: actorUserId }, detalle: { estadoPedido: pedido?.status ?? null } });
      return { resultado: "no_aplicable", agregado: this.vista(f) };
    }
    f.estado = "aceptado";
    f.decidedAt = ahora;
    f.decidedBy = actorUserId;
    pedido.items = [...pedido.items, ...f.itemsAdded.map((i) => ({ ...i }))];
    pedido.total = redondear(pedido.total + f.totalAdded);
    await this.registrarEvento({ amendmentId: f.id, organizationId, propertyId: f.propertyId, tipoEvento: "aceptado", actor: { tipo: "usuario", userId: actorUserId }, detalle: { totalAgregado: f.totalAdded, version: f.version } });
    return { resultado: "aplicado", agregado: this.vista(f) };
  }

  async cancelarPorCliente(organizationId: string, orderId: string): Promise<LecturaAgregados<AgregadoVista | null>> {
    if (!this.disponible) return { disponible: false, valor: null };
    const f = this.filas.find((x) => x.organizationId === organizationId && x.orderId === orderId && x.estado === "pendiente");
    if (!f) return { disponible: true, valor: null };
    f.estado = "cancelado_por_cliente";
    f.decidedAt = this.ahora().toISOString();
    await this.registrarEvento({ amendmentId: f.id, organizationId, propertyId: f.propertyId, tipoEvento: "cancelado_por_cliente", actor: { tipo: "agente" } });
    return { disponible: true, valor: this.vista(f) };
  }

  async pendientesAntesDe(antesDeIso: string, limite: number): Promise<LecturaAgregados<readonly AgregadoVista[]>> {
    if (!this.disponible) return { disponible: false, valor: [] };
    const tope = Date.parse(antesDeIso);
    const filas = this.filas.filter((f) => f.estado === "pendiente" && Date.parse(f.requestedAt) <= tope).sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt)).slice(0, limite);
    return { disponible: true, valor: filas.map((f) => this.vista(f)) };
  }

  async escalarNivel1(organizationId: string, id: string, ahora: Date): Promise<boolean> {
    const f = this.filas.find((x) => x.id === id && x.organizationId === organizationId);
    if (!this.disponible || !f || f.estado !== "pendiente" || f.escalationLevel !== 0) return false;
    f.escalationLevel = 1;
    f.escalatedAt = ahora.toISOString();
    await this.registrarEvento({ amendmentId: f.id, organizationId, propertyId: f.propertyId, tipoEvento: "sin_respuesta_10min", actor: { tipo: "sistema" } });
    return true;
  }

  async vencer(organizationId: string, id: string, ahora: Date): Promise<boolean> {
    const f = this.filas.find((x) => x.id === id && x.organizationId === organizationId);
    if (!this.disponible || !f || f.estado !== "pendiente") return false;
    f.estado = "vencido";
    f.escalationLevel = 2;
    f.escalatedAt = ahora.toISOString();
    f.decidedAt = ahora.toISOString();
    await this.registrarEvento({ amendmentId: f.id, organizationId, propertyId: f.propertyId, tipoEvento: "vencido", actor: { tipo: "sistema" } });
    return true;
  }

  async registrarEvento(evento: EventoAgregadoEntrada): Promise<void> {
    if (!this.disponible) return;
    this.eventos.push({ ...evento, at: this.ahora().toISOString() });
  }

  async listarEventos(organizationId: string, id: string, propertyIds: readonly string[] | null) {
    if (!this.disponible) return { disponible: false, valor: [] as const };
    const f = this.filas.find((x) => x.id === id && x.organizationId === organizationId && this.enAlcance(x.propertyId, propertyIds));
    if (!f) return { disponible: true, valor: [] as const };
    return {
      disponible: true,
      valor: this.eventos.filter((e) => e.amendmentId === id).map((e) => ({ evento: e.tipoEvento, actor: e.actor.tipo, at: e.at, detalle: e.detalle ?? {} })),
    };
  }
}
