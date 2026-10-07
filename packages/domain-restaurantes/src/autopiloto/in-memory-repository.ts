// Repositorio en memoria del autopiloto para pruebas unitarias y la API simulada de e2e. Reproduce los contratos de la base (idempotencia por
// pedido, compare-and-set de estados, "doble clic = un efecto", zona horaria de la sucursal); la SEMANTICA REAL de SQL (RLS, bloqueos,
// concurrencia) la prueba scripts/verify-restaurantes-autopiloto contra Postgres. No es produccion.
import { randomUUID } from "node:crypto";
import { diaLocalSucursal } from "../voz/kpi.ts";
import type { CanalPedido, OrderStatus } from "../types.ts";
import { MOTIVOS_CANCELACION } from "./taxonomia.ts";
import { AutopilotoAccesoError, AutopilotoValidacionError, AUTOPILOTO_CONFIG_POR_OMISION, DECISIONES_POR_TIPO } from "./tipos.ts";
import type {
  AgotadoRepuesto, AutopilotoConfig, AutopilotoOrgConfig, AutopilotoRepository, CandidatoEstado, ComandaParaAvance, EventoEstadoPedido, FiltroSolicitudes, HandoffDevuelto, Lectura,
  MuestrasTiempo, OpcionesResolver, ResultadoCancelarCliente, ResultadoCrearSolicitud, ResultadoResolver, ResultadoRetener, SolicitudDecision, SolicitudPorEscalar,
  SolicitudTipo, SolicitudVista,
} from "./tipos.ts";

export interface PedidoMemoria {
  id: string;
  organizationId: string;
  propertyId: string;
  status: OrderStatus;
  total: number;
  clienteNombre: string;
  telefono: string;
  canal: CanalPedido | null;
  numero: number;
  renglones: { nombre: string; cantidad: number }[];
  programadoPara?: Date | null;
  entregadoAt?: Date | null;
  horaRecogida?: Date | null;
  /** Comanda en el outbox del POS (null = ninguna). */
  comanda?: { estado: "pendiente" | "enviada" | "confirmada" | "capturada_manual"; folio: string | null } | null;
}

export interface HandoffMemoria {
  id: string;
  organizationId: string;
  propertyId: string;
  conversationId: string;
  telefono: string;
  estado: "pendiente" | "tomada" | "devuelta" | "cerrada";
  tomadaAt: Date;
  ultimaHumanaAt: Date | null;
  ultimoClienteAt: Date | null;
}

export interface AgotadoMemoria {
  organizationId: string;
  propertyId: string;
  productId: string;
  disponible: boolean;
  agotadoHasta: string | null;
}

interface SolicitudMemoria {
  id: string;
  organizationId: string;
  propertyId: string;
  tipo: SolicitudTipo;
  estado: "pendiente" | "resuelta";
  orderId: string | null;
  detalle: Record<string, unknown>;
  decision: SolicitudDecision | null;
  motivoResolucion: string | null;
  codigoDescuento: string | null;
  reposicionOrderId: string | null;
  solicitadaAt: Date;
  escaladaAt: Date | null;
  resueltaAt: Date | null;
}

export class InMemoryAutopilotoRepository implements AutopilotoRepository {
  readonly pedidos = new Map<string, PedidoMemoria>();
  readonly handoffs: HandoffMemoria[] = [];
  readonly agotados: AgotadoMemoria[] = [];
  readonly eventos: (EventoEstadoPedido & { orderId: string })[] = [];
  readonly zonaPorSucursal = new Map<string, string>();
  readonly configs = new Map<string, AutopilotoConfig>();
  readonly muestras = new Map<string, MuestrasTiempo>();
  /** Mensajes "Gracias por esperar" que habrian salido (la base los encola en el outbox). */
  readonly mensajesRegreso: string[] = [];
  private readonly solicitudes: SolicitudMemoria[] = [];
  private n = 0;
  /** `false` simula la base sin la migracion 050: todo devuelve "no disponible". */
  disponible = true;
  /** Simula una persona con alcance: `false` => 42501 al resolver. */
  actorConAlcance = true;
  ahora: () => Date = () => new Date();

  private lec<T>(valor: T): Lectura<T> {
    return { disponible: this.disponible, valor };
  }

  private evento(p: PedidoMemoria, desde: OrderStatus | null, hacia: OrderStatus, actor: string, motivo: string | null): void {
    this.eventos.push({ orderId: p.id, desde, hacia, actor, motivo, at: this.ahora().toISOString() });
  }

  private mover(p: PedidoMemoria, hacia: OrderStatus, actor: string, motivo: string | null): void {
    const desde = p.status;
    p.status = hacia;
    this.evento(p, desde, hacia, actor, motivo);
  }

  async leerConfig(_org: string, propertyId: string): Promise<Lectura<AutopilotoConfig>> {
    return this.lec(this.configs.get(propertyId) ?? AUTOPILOTO_CONFIG_POR_OMISION);
  }

  async guardarConfig(_org: string, propertyId: string, c: Omit<AutopilotoConfig, "configurada">): Promise<{ readonly disponible: boolean }> {
    if (!this.disponible) return { disponible: false };
    if (!this.actorConAlcance) throw new AutopilotoAccesoError("requiere owner/admin");
    if (c.aprobacionMinutos < 1 || c.aprobacionMinutos > 240) throw new AutopilotoValidacionError("valor fuera de rango");
    this.configs.set(propertyId, { ...c, configurada: true });
    return { disponible: true };
  }

  readonly configsOrg = new Map<string, AutopilotoOrgConfig>();

  async leerConfigOrg(organizationId: string): Promise<Lectura<AutopilotoOrgConfig>> {
    return this.lec(this.configsOrg.get(organizationId) ?? { cancelacionAgente: false });
  }

  async guardarConfigOrg(organizationId: string, config: AutopilotoOrgConfig): Promise<{ readonly disponible: boolean }> {
    if (!this.disponible) return { disponible: false };
    if (!this.actorConAlcance) throw new AutopilotoAccesoError("requiere owner/admin de toda la organizacion");
    this.configsOrg.set(organizationId, config);
    return { disponible: true };
  }

  async retenerPedidoGrande(organizationId: string, orderId: string, detalle: Readonly<Record<string, unknown>>): Promise<ResultadoRetener> {
    if (!this.disponible) return { estado: "no_disponible", solicitudId: null, propertyId: null };
    const p = this.pedidos.get(orderId);
    if (!p || p.organizationId !== organizationId) throw new AutopilotoAccesoError("pedido inexistente o ajeno");
    const previa = this.solicitudes.find((s) => s.orderId === orderId && s.tipo === "pedido_grande" && s.estado === "pendiente");
    if (p.status === "por_aprobar") return { estado: "existente", solicitudId: previa?.id ?? null, propertyId: p.propertyId };
    if (p.status !== "pending" && p.status !== "programado") throw new AutopilotoValidacionError(`el pedido ya avanzo (${p.status})`);
    this.mover(p, "por_aprobar", "agente", "pedido_grande");
    const s = this.nueva(p.organizationId, p.propertyId, "pedido_grande", orderId, { ...detalle });
    return { estado: "creada", solicitudId: s.id, propertyId: p.propertyId };
  }

  private nueva(org: string, prop: string, tipo: SolicitudTipo, orderId: string | null, detalle: Record<string, unknown>): SolicitudMemoria {
    const s: SolicitudMemoria = {
      id: (this.n++, randomUUID()), organizationId: org, propertyId: prop, tipo, estado: "pendiente", orderId, detalle, decision: null, motivoResolucion: null,
      codigoDescuento: null, reposicionOrderId: null, solicitadaAt: this.ahora(), escaladaAt: null, resueltaAt: null,
    };
    this.solicitudes.push(s);
    return s;
  }

  async crearSolicitud(organizationId: string, propertyId: string, tipo: Exclude<SolicitudTipo, "pedido_grande">, orderId: string | null, detalle: Readonly<Record<string, unknown>>): Promise<ResultadoCrearSolicitud> {
    if (!this.disponible) return { estado: "no_disponible", solicitudId: null };
    if (orderId) {
      const p = this.pedidos.get(orderId);
      if (!p || p.organizationId !== organizationId || p.propertyId !== propertyId) throw new AutopilotoAccesoError("pedido ajeno");
    }
    const previa = this.solicitudes.find((s) => s.estado === "pendiente" && s.tipo === tipo && (orderId ? s.orderId === orderId : s.propertyId === propertyId));
    if (previa) return { estado: "existente", solicitudId: previa.id };
    return { estado: "creada", solicitudId: this.nueva(organizationId, propertyId, tipo, orderId, { ...detalle }).id };
  }

  async listarSolicitudes(organizationId: string, filtro: FiltroSolicitudes): Promise<Lectura<readonly SolicitudVista[]>> {
    const vistas = this.solicitudes
      .filter((s) => s.organizationId === organizationId && s.estado === filtro.estado && (filtro.propertyIds === null || filtro.propertyIds.includes(s.propertyId)))
      .sort((a, b) => (filtro.estado === "pendiente" ? a.solicitadaAt.getTime() - b.solicitadaAt.getTime() : b.solicitadaAt.getTime() - a.solicitadaAt.getTime()))
      .slice(0, filtro.limite)
      .map((s): SolicitudVista => {
        const p = s.orderId ? this.pedidos.get(s.orderId) : undefined;
        return {
          id: s.id, organizationId: s.organizationId, propertyId: s.propertyId, tipo: s.tipo, estado: s.estado, orderId: s.orderId, detalle: s.detalle, decision: s.decision,
          motivoResolucion: s.motivoResolucion, codigoDescuento: s.codigoDescuento, solicitadaAt: s.solicitadaAt.toISOString(),
          escaladaAt: s.escaladaAt?.toISOString() ?? null, resueltaAt: s.resueltaAt?.toISOString() ?? null,
          pedido: p ? { numero: p.numero, total: p.total, status: p.status, clienteNombre: p.clienteNombre, canal: p.canal, renglones: p.renglones.map((r, indice) => ({ indice, nombre: r.nombre, cantidad: r.cantidad })) } : null,
        };
      });
    return this.lec(vistas);
  }

  async resolverSolicitud(organizationId: string, solicitudId: string, decision: SolicitudDecision, o: OpcionesResolver): Promise<ResultadoResolver | null> {
    if (!this.disponible) return null;
    const s = this.solicitudes.find((x) => x.id === solicitudId && x.organizationId === organizationId);
    if (!s || !this.actorConAlcance) throw new AutopilotoAccesoError("inexistente o sin acceso");
    const p = s.orderId ? this.pedidos.get(s.orderId) : undefined;
    const base = (aplicado: boolean, extra: Partial<ResultadoResolver> = {}): ResultadoResolver => ({
      aplicado, tipo: s.tipo, decision: s.decision, orderId: s.orderId, propertyId: s.propertyId, estadoPedido: p?.status ?? null, codigoDescuento: s.codigoDescuento,
      reposicionOrderId: s.reposicionOrderId, ...extra,
    });
    if (s.estado === "resuelta") return base(false);
    if (!DECISIONES_POR_TIPO[s.tipo].includes(decision)) throw new AutopilotoValidacionError(`decision invalida para ${s.tipo}`);
    const motivoOk = (MOTIVOS_CANCELACION as readonly string[]).includes(o.motivo ?? "");
    const cerrar = (extra: Partial<SolicitudMemoria> = {}) => {
      Object.assign(s, { estado: "resuelta", decision, motivoResolucion: o.motivo ?? null, resueltaAt: this.ahora(), ...extra });
    };
    if (s.tipo === "pedido_grande" && p) {
      if (p.status !== "por_aprobar") {
        cerrar({ motivoResolucion: "pedido_ya_no_estaba_por_aprobar" });
        return base(false);
      }
      if (decision === "aprobar") {
        this.mover(p, p.programadoPara && p.programadoPara > this.ahora() ? "programado" : "pending", "staff", "aprobado");
      } else {
        if (!motivoOk) throw new AutopilotoValidacionError("rechazar exige un motivo de la lista cerrada");
        this.mover(p, "cancelado", "staff", o.motivo ?? null);
      }
      cerrar();
      return base(true, { estadoPedido: p.status });
    }
    if (s.tipo === "cancelacion" && decision === "cancelar" && p) {
      if (!motivoOk) throw new AutopilotoValidacionError("cancelar exige un motivo de la lista cerrada");
      if (!["pending", "programado", "preparando", "listo_para_recoger", "no_recogido", "problema", "por_aprobar"].includes(p.status)) {
        cerrar({ decision: "mantener", motivoResolucion: `no_cancelable_${p.status}` });
        return base(false, { decision: "mantener" });
      }
      this.mover(p, "cancelado", "staff", o.motivo ?? null);
      cerrar();
      return base(true, { estadoPedido: p.status });
    }
    if (s.tipo === "compensacion" && decision === "descuento_proximo") {
      const tope = (this.configs.get(s.propertyId) ?? AUTOPILOTO_CONFIG_POR_OMISION).compensacionTopePct;
      if (o.valor == null || o.valor < 1 || o.valor > tope) throw new AutopilotoValidacionError(`el descuento debe ser de 1 a ${tope} por ciento`);
      const codigo = `GRACIAS-${(this.n + 1000).toString(16).toUpperCase().padStart(8, "0")}`;
      cerrar({ codigoDescuento: codigo });
      return base(true, { codigoDescuento: codigo });
    }
    if (s.tipo === "compensacion" && decision === "reponer_producto" && p) {
      const idx = o.indices ?? [];
      const elegidos = idx.filter((i) => i >= 0 && i < p.renglones.length);
      if (elegidos.length === 0 || elegidos.length !== idx.length) throw new AutopilotoValidacionError("renglones a reponer invalidos");
      const id = randomUUID();
      if (!this.pedidos.has(id)) {
        const r: PedidoMemoria = { ...p, id, status: "pending", total: 0, numero: p.numero + 1000, renglones: elegidos.map((i) => p.renglones[i]!), comanda: null };
        this.pedidos.set(id, r);
        this.evento(r, null, "pending", "staff", null);
      }
      cerrar({ reposicionOrderId: id });
      return base(true, { reposicionOrderId: id });
    }
    cerrar();
    return base(true);
  }

  async solicitudesPorEscalar(ahora: Date, limite: number): Promise<Lectura<readonly SolicitudPorEscalar[]>> {
    const out: SolicitudPorEscalar[] = [];
    for (const s of this.solicitudes) {
      if (out.length >= limite) break;
      const mins = (this.configs.get(s.propertyId) ?? AUTOPILOTO_CONFIG_POR_OMISION).aprobacionMinutos;
      if (s.estado !== "pendiente" || s.escaladaAt || s.solicitadaAt.getTime() > ahora.getTime() - mins * 60_000) continue;
      s.escaladaAt = ahora;
      out.push({ id: s.id, organizationId: s.organizationId, propertyId: s.propertyId, tipo: s.tipo, orderId: s.orderId, minutos: Math.floor((ahora.getTime() - s.solicitadaAt.getTime()) / 60_000) });
    }
    return this.lec(out);
  }

  async candidatosEstados(ahora: Date, limite: number): Promise<Lectura<readonly CandidatoEstado[]>> {
    const out: CandidatoEstado[] = [];
    for (const p of this.pedidos.values()) {
      const cfg = this.configs.get(p.propertyId) ?? AUTOPILOTO_CONFIG_POR_OMISION;
      const base = { orderId: p.id, organizationId: p.organizationId, propertyId: p.propertyId, desde: p.status };
      if (p.status === "entregado" && p.entregadoAt && p.entregadoAt.getTime() <= ahora.getTime() - cfg.completadoHoras * 3_600_000) out.push({ ...base, hacia: "completado", motivo: "limpieza_entregado" });
      else if (p.status === "listo_para_recoger" && p.horaRecogida && p.horaRecogida.getTime() <= ahora.getTime() - cfg.noRecogidoMinutos * 60_000) out.push({ ...base, hacia: "no_recogido", motivo: "limpieza_no_recogido" });
      else if (p.status === "pending" && cfg.aceptacionAuto && p.comanda && ["confirmada", "capturada_manual"].includes(p.comanda.estado)) out.push({ ...base, hacia: "preparando", motivo: "aceptacion_automatica" });
    }
    return this.lec(out.slice(0, limite));
  }

  async aplicarTransicion(organizationId: string, orderId: string, desde: OrderStatus, hacia: OrderStatus, actor: "agente" | "pos" | "sistema", motivo: string): Promise<boolean> {
    const permitidos = [["entregado", "completado"], ["listo_para_recoger", "no_recogido"], ["pending", "preparando"], ["preparando", "en_camino"], ["preparando", "listo_para_recoger"]];
    if (!permitidos.some(([a, b]) => a === desde && b === hacia)) throw new AutopilotoValidacionError(`transicion no permitida (${desde} -> ${hacia})`);
    const p = this.pedidos.get(orderId);
    if (!p || p.organizationId !== organizationId || p.status !== desde) return false;
    this.mover(p, hacia, actor, motivo);
    if (hacia === "entregado") p.entregadoAt = this.ahora();
    return true;
  }

  async comandasParaAvance(limite: number): Promise<Lectura<readonly ComandaParaAvance[]>> {
    const out: ComandaParaAvance[] = [];
    for (const p of this.pedidos.values()) {
      if (p.comanda?.estado === "confirmada" && p.comanda.folio && (p.status === "pending" || p.status === "preparando")) {
        out.push({ orderId: p.id, organizationId: p.organizationId, propertyId: p.propertyId, folio: p.comanda.folio, status: p.status, canal: p.canal });
      }
    }
    return this.lec(out.slice(0, limite));
  }

  async devolverHandoffsVencidos(ahora: Date, limite: number): Promise<Lectura<readonly HandoffDevuelto[]>> {
    const out: HandoffDevuelto[] = [];
    for (const h of this.handoffs) {
      if (out.length >= limite || h.estado !== "tomada") continue;
      const mins = (this.configs.get(h.propertyId) ?? AUTOPILOTO_CONFIG_POR_OMISION).handoffRegresoMinutos;
      const ultima = Math.max(h.tomadaAt.getTime(), h.ultimaHumanaAt?.getTime() ?? 0);
      if (ultima > ahora.getTime() - mins * 60_000) continue;
      const tel = h.telefono.replace(/\D/g, "").slice(-10);
      const conPorAprobar = this.solicitudes.some((s) => s.estado === "pendiente" && s.tipo === "pedido_grande" && s.orderId && this.pedidos.get(s.orderId)?.telefono.replace(/\D/g, "").slice(-10) === tel);
      if (conPorAprobar) continue;
      h.estado = "devuelta";
      const avisado = h.ultimoClienteAt !== null && h.ultimoClienteAt.getTime() > ahora.getTime() - 24 * 3_600_000;
      if (avisado) this.mensajesRegreso.push(h.id);
      out.push({ handoffId: h.id, organizationId: h.organizationId, propertyId: h.propertyId, conversationId: h.conversationId, minutos: mins, avisado });
    }
    return this.lec(out);
  }

  async cancelarPorCliente(organizationId: string, orderId: string, motivo: string): Promise<ResultadoCancelarCliente> {
    if (!this.disponible) return null;
    if (!(MOTIVOS_CANCELACION as readonly string[]).includes(motivo)) throw new AutopilotoValidacionError("motivo fuera de la lista cerrada");
    const p = this.pedidos.get(orderId);
    if (!p || p.organizationId !== organizationId) throw new AutopilotoAccesoError("pedido inexistente o ajeno");
    if ((this.configs.get(p.propertyId) ?? AUTOPILOTO_CONFIG_POR_OMISION).cancelacionAuto !== true) return { aplicado: false, estado: "politica_apagada" };
    if (p.status !== "pending" && p.status !== "programado") return { aplicado: false, estado: p.status };
    if (p.comanda) return { aplicado: false, estado: "ya_en_cocina" };
    this.mover(p, "cancelado", "agente", motivo);
    return { aplicado: true, estado: "cancelado" };
  }

  async marcarAgotado(organizationId: string, propertyId: string, productId: string, hasta: string): Promise<{ readonly disponible: boolean; readonly aplicado: boolean }> {
    if (!this.disponible) return { disponible: false, aplicado: false };
    const a = this.agotados.find((x) => x.organizationId === organizationId && x.propertyId === propertyId && x.productId === productId);
    if (!a) return { disponible: true, aplicado: false };
    const hoy = diaLocalSucursal(this.ahora(), this.zonaPorSucursal.get(propertyId) ?? null).fecha;
    if (hasta <= hoy) throw new AutopilotoValidacionError("la fecha de reposicion debe ser posterior a hoy");
    a.disponible = false;
    a.agotadoHasta = hasta;
    return { disponible: true, aplicado: true };
  }

  async reponerAgotados(ahora: Date): Promise<Lectura<readonly AgotadoRepuesto[]>> {
    const out: AgotadoRepuesto[] = [];
    for (const a of this.agotados) {
      if (!a.agotadoHasta || a.disponible) continue;
      const hoy = diaLocalSucursal(ahora, this.zonaPorSucursal.get(a.propertyId) ?? null).fecha;
      if (hoy < a.agotadoHasta) continue;
      out.push({ organizationId: a.organizationId, propertyId: a.propertyId, productId: a.productId, agotadoHasta: a.agotadoHasta });
      a.disponible = true;
      a.agotadoHasta = null;
    }
    return this.lec(out);
  }

  async muestrasTiempo(_org: string, propertyId: string, canal: CanalPedido): Promise<Lectura<MuestrasTiempo>> {
    return this.lec(this.muestras.get(`${propertyId}:${canal}`) ?? { muestras: [], abiertos: [...this.pedidos.values()].filter((p) => p.propertyId === propertyId && ["pending", "preparando", "en_camino", "listo_para_recoger"].includes(p.status)).length });
  }

  async historialEstados(_org: string, orderId: string): Promise<Lectura<readonly EventoEstadoPedido[]>> {
    return this.lec(this.eventos.filter((e) => e.orderId === orderId).map(({ orderId: _o, ...e }) => e));
  }
}
