// Adaptador en memoria del ciclo operativo del pedido: mismas reglas observables que las funciones SQL 170 a 172 (compare-and-set de estado, una encuesta por
// pedido, huella de telefono, ventana de 30 min para el comentario) para que los tests deterministas del servicio y de las rutas corran sin Postgres.
// Los pedidos viven en el `InMemoryRestaurantesRepository` del dominio (se mueven con `updateOrderStatus`); aqui solo se guardan los campos nuevos.
// Las funciones SQL en si (permisos, RLS, SQLSTATE) las cubre la verificacion contra Postgres real (`scripts/verify-restaurantes-ciclo-pedido`).
import type { InMemoryRestaurantesRepository } from "../in-memory-repository.ts";
import { RECORDATORIO_POR_OMISION } from "./reglas.ts";
import type { ConfigRecordatorio, EncuestaCruda, MotivoOmision, MotivoRechazo, TiemposCrudos } from "./reglas.ts";
import { CicloConflictoError, CicloNoDisponibleError, CicloNoEncontradoError, CicloValidacionError } from "./tipos.ts";
import type {
  CandidatoEncuesta,
  CandidatoRecordatorio,
  CicloPedidoRepository,
  ConfigEncuesta,
  EstadoEsperadoEncuesta,
  LecturaCiclo,
  ResultadoAceptar,
  ResultadoComentarEncuesta,
  ResultadoDespachar,
  ResultadoEntregarStaff,
  ResultadoRechazar,
  ResultadoResponderEncuesta,
} from "./tipos.ts";

interface CamposPedido {
  aceptadoAt?: Date;
  tiempoPrometidoMin?: number;
  rechazadoAt?: Date;
  rechazoMotivo?: MotivoRechazo;
  salioAt?: Date;
  entregadoAt?: Date;
  /** Desde cuando cuenta la espera sin aceptar (`promovido_at` o `created_at`). */
  pendienteDesde?: Date;
}

interface PendienteMemoria {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly orderNumber: number;
}

interface FilaEncuesta {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly orderId: string;
  readonly phoneHash: string;
  estado: "enviada" | "respondida" | "omitida";
  omitidoMotivo: MotivoOmision | null;
  canal: "texto" | "plantilla" | null;
  enviadaEn: Date | null;
  calificacion: number | null;
  comentario: string | null;
  respondidaEn: Date | null;
  readonly creadaEn: Date;
}

/** Entrega sembrada por la prueba (en Postgres la deducen los pedidos `entregado` con `delivered_at`). */
export interface EntregaMemoria {
  readonly orderId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly customerPhone: string;
  readonly deliveredAt: Date;
  readonly zonaHoraria?: string | null;
  readonly phoneHash: string;
  readonly ultimoEntranteAt?: Date | null;
  readonly consentimiento?: boolean;
}

export class InMemoryCicloPedidoRepository implements CicloPedidoRepository {
  private readonly campos = new Map<string, CamposPedido>();
  private readonly encuestas: FilaEncuesta[] = [];
  private readonly optouts = new Set<string>();
  private readonly configEncuesta = new Map<string, ConfigEncuesta>();
  private readonly configRecordatorio = new Map<string, ConfigRecordatorio>();
  private readonly entregas: EntregaMemoria[] = [];
  private readonly pendientes = new Map<string, PendienteMemoria>();
  /** `false` simula la base sin migrar: lecturas `disponible: false` y escrituras `CicloNoDisponibleError`. */
  migrado = true;
  /** `false` simula la base con 170 pero sin 092 (despachar). */
  despacharDisponible = true;
  ahora: () => Date = () => new Date();

  constructor(private readonly base: InMemoryRestaurantesRepository) {}

  sembrarEntrega(e: EntregaMemoria): void {
    this.entregas.push(e);
  }
  /** Marca un pedido `pending` como candidato a recordatorio desde `desde` (en Postgres sale de `promovido_at`/`created_at`). */
  sembrarPendiente(orderId: string, datos: PendienteMemoria, desde: Date): void {
    this.campo(orderId).pendienteDesde = desde;
    this.pendientes.set(orderId, datos);
  }
  filasEncuesta(): readonly Readonly<FilaEncuesta>[] {
    return this.encuestas;
  }
  hayBaja(organizationId: string, phoneHash: string): boolean {
    return this.optouts.has(`${organizationId}:${phoneHash}`);
  }
  camposDe(orderId: string): Readonly<CamposPedido> {
    return this.campo(orderId);
  }

  private campo(orderId: string): CamposPedido {
    let c = this.campos.get(orderId);
    if (!c) {
      c = {};
      this.campos.set(orderId, c);
    }
    return c;
  }
  private async escritura<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.migrado) throw new CicloNoDisponibleError("Esta función requiere actualizar la base de datos (migraciones 170 a 172).");
    return fn();
  }
  private lectura<T>(vacio: T, valor: () => T): LecturaCiclo<T> {
    return this.migrado ? { disponible: true, valor: valor() } : { disponible: false, valor: vacio };
  }

  async aceptar(organizationId: string, orderId: string, minutos: number): Promise<ResultadoAceptar> {
    return this.escritura(async () => {
      if (!Number.isInteger(minutos) || minutos < 5 || minutos > 240) throw new CicloValidacionError("tiempo prometido fuera de rango");
      const order = await this.base.findOrderById(organizationId, orderId);
      if (!order) throw new CicloNoEncontradoError("pedido no encontrado");
      const c = this.campo(orderId);
      if (c.aceptadoAt && order.status !== "pending") return { resultado: "ya_aplicado", aceptadoAt: c.aceptadoAt.toISOString(), tiempoPrometidoMin: c.tiempoPrometidoMin ?? minutos };
      if (order.status !== "pending") throw new CicloConflictoError("el estado del pedido cambio");
      const ahora = this.ahora();
      await this.base.updateOrderStatus(organizationId, orderId, "pending", "preparando");
      c.aceptadoAt = ahora;
      c.tiempoPrometidoMin = minutos;
      return { resultado: "aceptado", aceptadoAt: ahora.toISOString(), tiempoPrometidoMin: minutos };
    });
  }

  async rechazar(organizationId: string, orderId: string, motivo: MotivoRechazo, nota: string | null): Promise<ResultadoRechazar> {
    return this.escritura(async () => {
      if (nota !== null && nota.length > 240) throw new CicloValidacionError("nota demasiado larga");
      const order = await this.base.findOrderById(organizationId, orderId);
      if (!order) throw new CicloNoEncontradoError("pedido no encontrado");
      const c = this.campo(orderId);
      if (c.rechazadoAt && order.status === "cancelado") return { resultado: "ya_aplicado", rechazadoAt: c.rechazadoAt.toISOString(), motivo: c.rechazoMotivo ?? motivo };
      if (order.status !== "pending") throw new CicloConflictoError("el estado del pedido cambio");
      const ahora = this.ahora();
      await this.base.updateOrderStatus(organizationId, orderId, "pending", "cancelado");
      c.rechazadoAt = ahora;
      c.rechazoMotivo = motivo;
      return { resultado: "rechazado", rechazadoAt: ahora.toISOString(), motivo };
    });
  }

  async despachar(organizationId: string, orderId: string, repartidorId: string, etaMin: number): Promise<ResultadoDespachar> {
    return this.escritura(async () => {
      if (!this.despacharDisponible) throw new CicloNoDisponibleError("sin 092");
      if (etaMin < 5 || etaMin > 240) throw new CicloValidacionError("eta fuera de rango");
      const order = await this.base.findOrderById(organizationId, orderId);
      if (!order) throw new CicloNoEncontradoError("pedido no encontrado");
      const c = this.campo(orderId);
      if (order.status === "en_camino") {
        if (order.assignedRepartidorId === repartidorId) return { resultado: "ya_aplicado", salioAt: c.salioAt?.toISOString() ?? null, repartidorId };
        await this.base.assignRepartidorToOrder(organizationId, orderId, repartidorId, order.estimatedDeliveryAt);
        return { resultado: "reasignado", salioAt: c.salioAt?.toISOString() ?? null, repartidorId };
      }
      if (order.status !== "preparando") throw new CicloConflictoError("el estado del pedido cambio");
      const ahora = this.ahora();
      await this.base.assignRepartidorToOrder(organizationId, orderId, repartidorId, new Date(ahora.getTime() + etaMin * 60_000).toISOString());
      await this.base.updateOrderStatus(organizationId, orderId, "preparando", "en_camino");
      c.salioAt = ahora;
      return { resultado: "despachado", salioAt: ahora.toISOString(), repartidorId };
    });
  }

  async entregarStaff(organizationId: string, orderId: string, ocurrioEn: Date | null, _cobrado: number | null): Promise<ResultadoEntregarStaff> {
    return this.escritura(async () => {
      const order = await this.base.findOrderById(organizationId, orderId);
      if (!order) throw new CicloNoEncontradoError("pedido no encontrado");
      const c = this.campo(orderId);
      const ahora = this.ahora();
      const hora = ocurrioEn ?? ahora;
      if (hora.getTime() > ahora.getTime() + 60_000) throw new CicloValidacionError("la hora real no puede ser futura");
      if (hora.getTime() < ahora.getTime() - 12 * 3_600_000) throw new CicloValidacionError("la hora real no puede ser anterior a 12 horas");
      if (order.status === "entregado") return { resultado: "ya_aplicado", entregadoAt: (c.entregadoAt ?? hora).toISOString(), salioAt: c.salioAt?.toISOString() ?? null, minutosDesdeAceptado: null, tiempoPrometidoMin: c.tiempoPrometidoMin ?? null };
      if (order.status !== "en_camino") throw new CicloConflictoError("el estado del pedido cambio");
      const piso = c.salioAt ?? new Date(order.createdAt);
      if (hora.getTime() < piso.getTime()) throw new CicloValidacionError("la hora real es anterior a la salida del pedido");
      await this.base.updateOrderStatus(organizationId, orderId, "en_camino", "entregado");
      c.entregadoAt = hora;
      return {
        resultado: "entregado",
        entregadoAt: hora.toISOString(),
        salioAt: c.salioAt?.toISOString() ?? null,
        minutosDesdeAceptado: c.aceptadoAt ? Math.round(((hora.getTime() - c.aceptadoAt.getTime()) / 60_000) * 10) / 10 : null,
        tiempoPrometidoMin: c.tiempoPrometidoMin ?? null,
      };
    });
  }

  async tiempos(organizationId: string, _propertyId: string, _desde: Date, _hasta: Date): Promise<LecturaCiclo<TiemposCrudos | null>> {
    return this.lectura<TiemposCrudos | null>(null, () => {
      const filas = [...this.campos.entries()];
      const conPromesa = filas.filter(([, c]) => c.entregadoAt && c.aceptadoAt && c.tiempoPrometidoMin !== undefined);
      const aTiempo = conPromesa.filter(([, c]) => c.entregadoAt!.getTime() <= c.aceptadoAt!.getTime() + c.tiempoPrometidoMin! * 60_000).length;
      const prom = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
      const motivos: Record<string, number> = {};
      for (const [, c] of filas) if (c.rechazoMotivo) motivos[c.rechazoMotivo] = (motivos[c.rechazoMotivo] ?? 0) + 1;
      void organizationId;
      return {
        pedidos: filas.length,
        aceptados: filas.filter(([, c]) => c.aceptadoAt).length,
        rechazados: filas.filter(([, c]) => c.rechazadoAt).length,
        entregadosConPromesa: conPromesa.length,
        aTiempo,
        realMinProm: prom(conPromesa.map(([, c]) => (c.entregadoAt!.getTime() - c.aceptadoAt!.getTime()) / 60_000)),
        prometidoMinProm: prom(conPromesa.map(([, c]) => c.tiempoPrometidoMin!)),
        aceptacionSegProm: prom(filas.filter(([, c]) => c.aceptadoAt && c.pendienteDesde).map(([, c]) => (c.aceptadoAt!.getTime() - c.pendienteDesde!.getTime()) / 1000)),
        salidaMinProm: prom(filas.filter(([, c]) => c.salioAt && c.aceptadoAt).map(([, c]) => (c.salioAt!.getTime() - c.aceptadoAt!.getTime()) / 60_000)),
        rechazosPorMotivo: motivos,
      };
    });
  }

  async leerConfigEncuesta(organizationId: string, propertyId: string): Promise<LecturaCiclo<ConfigEncuesta>> {
    return this.lectura({ habilitada: false, linkResena: null }, () => this.configEncuesta.get(`${organizationId}:${propertyId}`) ?? { habilitada: false, linkResena: null });
  }
  async guardarConfigEncuesta(organizationId: string, propertyId: string, config: ConfigEncuesta): Promise<void> {
    await this.escritura(async () => {
      if (config.linkResena !== null && !/^https:\/\//.test(config.linkResena)) throw new CicloValidacionError("link invalido");
      this.configEncuesta.set(`${organizationId}:${propertyId}`, config);
    });
  }

  async candidatasEncuesta(ahora: Date, limite: number): Promise<LecturaCiclo<readonly CandidatoEncuesta[]>> {
    return this.lectura<readonly CandidatoEncuesta[]>([], () =>
      this.entregas
        .filter((e) => {
          const cfg = this.configEncuesta.get(`${e.organizationId}:${e.propertyId}`);
          const edad = ahora.getTime() - e.deliveredAt.getTime();
          return cfg?.habilitada === true && edad >= 2 * 3_600_000 && edad < 36 * 3_600_000 && !this.encuestas.some((f) => f.orderId === e.orderId);
        })
        .slice(0, limite)
        .map((e) => {
          const previas = this.encuestas.filter((f) => f.organizationId === e.organizationId && f.phoneHash === e.phoneHash && f.enviadaEn !== null);
          const ultima = previas.reduce<Date | null>((m, f) => (m === null || f.enviadaEn! > m ? f.enviadaEn : m), null);
          return {
            orderId: e.orderId,
            organizationId: e.organizationId,
            propertyId: e.propertyId,
            customerPhone: e.customerPhone,
            deliveredAt: e.deliveredAt.toISOString(),
            zonaHoraria: e.zonaHoraria ?? "America/Merida",
            phoneHash: e.phoneHash,
            ultimoEntranteAt: e.ultimoEntranteAt ? e.ultimoEntranteAt.toISOString() : null,
            ultimaEncuestaAt: ultima ? ultima.toISOString() : null,
            optOut: this.optouts.has(`${e.organizationId}:${e.phoneHash}`),
            consentimiento: e.consentimiento === true,
            linkResena: this.configEncuesta.get(`${e.organizationId}:${e.propertyId}`)?.linkResena ?? null,
          };
        }),
    );
  }

  async reservarEncuesta(organizationId: string, orderId: string, phoneHash: string, estado: "enviada" | "omitida", omitidoMotivo: MotivoOmision | null, canal: "texto" | "plantilla" | null): Promise<boolean> {
    return this.escritura(async () => {
      if (this.encuestas.some((f) => f.orderId === orderId)) return false;
      const e = this.entregas.find((x) => x.orderId === orderId);
      this.encuestas.push({
        id: `enc-${this.encuestas.length + 1}`,
        organizationId,
        propertyId: e?.propertyId ?? "",
        orderId,
        phoneHash,
        estado,
        omitidoMotivo: estado === "omitida" ? omitidoMotivo : null,
        canal: estado === "enviada" ? canal : null,
        enviadaEn: estado === "enviada" ? this.ahora() : null,
        calificacion: null,
        comentario: null,
        respondidaEn: null,
        creadaEn: this.ahora(),
      });
      return true;
    });
  }

  private ultimaDelTelefono(organizationId: string, phoneHash: string): FilaEncuesta | null {
    const filas = this.encuestas.filter((f) => f.organizationId === organizationId && f.phoneHash === phoneHash && (f.estado === "enviada" || f.estado === "respondida"));
    return filas.reduce<FilaEncuesta | null>((m, f) => (m === null || f.enviadaEn! > m.enviadaEn! ? f : m), null);
  }

  async estadoEsperadoEncuesta(organizationId: string, phoneHash: string, ahora: Date): Promise<LecturaCiclo<EstadoEsperadoEncuesta>> {
    return this.lectura<EstadoEsperadoEncuesta>("ninguna", () => {
      const f = this.ultimaDelTelefono(organizationId, phoneHash);
      if (!f) return "ninguna";
      if (f.estado === "enviada" && ahora.getTime() - f.enviadaEn!.getTime() < 48 * 3_600_000) return "calificacion";
      if (f.estado === "respondida" && f.comentario === null && ahora.getTime() - f.respondidaEn!.getTime() < 30 * 60_000) return "comentario";
      return "ninguna";
    });
  }

  async responderEncuesta(organizationId: string, phoneHash: string, calificacion: number, ahora: Date): Promise<ResultadoResponderEncuesta> {
    return this.escritura(async () => {
      if (!Number.isInteger(calificacion) || calificacion < 1 || calificacion > 5) throw new CicloValidacionError("calificacion fuera de 1 a 5");
      const f = this.ultimaDelTelefono(organizationId, phoneHash);
      if (!f || f.estado !== "enviada" || ahora.getTime() - f.enviadaEn!.getTime() >= 48 * 3_600_000) return { resultado: "sin_encuesta" };
      f.estado = "respondida";
      f.calificacion = calificacion;
      f.respondidaEn = ahora;
      return { resultado: "respondida", encuestaId: f.id, orderId: f.orderId, propertyId: f.propertyId, orderNumber: null, linkResena: this.configEncuesta.get(`${organizationId}:${f.propertyId}`)?.linkResena ?? null };
    });
  }

  async comentarEncuesta(organizationId: string, phoneHash: string, comentario: string, ahora: Date): Promise<ResultadoComentarEncuesta> {
    return this.escritura(async () => {
      const texto = comentario.trim().slice(0, 500);
      if (texto === "") throw new CicloValidacionError("comentario vacio");
      const f = this.ultimaDelTelefono(organizationId, phoneHash);
      if (!f || f.estado !== "respondida" || f.comentario !== null || ahora.getTime() - f.respondidaEn!.getTime() >= 30 * 60_000) return { resultado: "sin_encuesta" };
      f.comentario = texto;
      return { resultado: "comentada", encuestaId: f.id, orderId: f.orderId, propertyId: f.propertyId, calificacion: f.calificacion! };
    });
  }

  async registrarBajaEncuesta(organizationId: string, phoneHash: string): Promise<boolean> {
    return this.escritura(async () => {
      const clave = `${organizationId}:${phoneHash}`;
      if (this.optouts.has(clave)) return false;
      this.optouts.add(clave);
      return true;
    });
  }

  async metricasEncuesta(organizationId: string, _propertyId: string, _desde: Date, _hasta: Date): Promise<LecturaCiclo<EncuestaCruda | null>> {
    return this.lectura<EncuestaCruda | null>(null, () => {
      const filas = this.encuestas.filter((f) => f.organizationId === organizationId);
      const dist: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
      const motivos: Record<string, number> = {};
      for (const f of filas) {
        if (f.calificacion) dist[String(f.calificacion)] = (dist[String(f.calificacion)] ?? 0) + 1;
        if (f.omitidoMotivo) motivos[f.omitidoMotivo] = (motivos[f.omitidoMotivo] ?? 0) + 1;
      }
      const respondidas = filas.filter((f) => f.estado === "respondida");
      return {
        enviadas: filas.filter((f) => f.estado !== "omitida").length,
        respondidas: respondidas.length,
        omitidas: filas.filter((f) => f.estado === "omitida").length,
        conComentario: filas.filter((f) => f.comentario !== null).length,
        sumaCalificacion: respondidas.reduce((a, f) => a + (f.calificacion ?? 0), 0),
        bajas: respondidas.filter((f) => (f.calificacion ?? 0) <= 3).length,
        distribucion: dist,
        omitidasPorMotivo: motivos,
        optouts: [...this.optouts].filter((k) => k.startsWith(`${organizationId}:`)).length,
      };
    });
  }

  async leerConfigRecordatorio(organizationId: string, propertyId: string): Promise<LecturaCiclo<ConfigRecordatorio>> {
    return this.lectura(RECORDATORIO_POR_OMISION, () => this.configRecordatorio.get(`${organizationId}:${propertyId}`) ?? RECORDATORIO_POR_OMISION);
  }
  async guardarConfigRecordatorio(organizationId: string, propertyId: string, config: ConfigRecordatorio): Promise<void> {
    await this.escritura(async () => {
      if (config.primeroMin < 3 || config.primeroMin > 120 || config.repetirMin < 3 || config.repetirMin > 120 || config.maximo < 1 || config.maximo > 6) throw new CicloValidacionError("valores fuera de rango");
      this.configRecordatorio.set(`${organizationId}:${propertyId}`, config);
    });
  }

  async candidatosRecordatorio(ahora: Date): Promise<LecturaCiclo<readonly CandidatoRecordatorio[]>> {
    if (!this.migrado) return { disponible: false, valor: [] };
    const out: CandidatoRecordatorio[] = [];
    for (const [orderId, p] of this.pendientes) {
      const c = this.campo(orderId);
      if (!c.pendienteDesde) continue;
      const order = await this.base.findOrderById(p.organizationId, orderId);
      if (!order || order.status !== "pending") continue;
      const cfg = this.configRecordatorio.get(`${p.organizationId}:${p.propertyId}`) ?? RECORDATORIO_POR_OMISION;
      const edad = (ahora.getTime() - c.pendienteDesde.getTime()) / 60_000;
      if (!cfg.habilitado || edad < cfg.primeroMin || edad > 24 * 60) continue;
      out.push({
          orderId,
          organizationId: p.organizationId,
          propertyId: p.propertyId,
          orderNumber: p.orderNumber,
          numeroRecordatorio: Math.min(cfg.maximo, 1 + Math.floor((edad - cfg.primeroMin) / cfg.repetirMin)),
          maximo: cfg.maximo,
          minutos: Math.floor(edad),
      });
    }
    return { disponible: true, valor: out };
  }
}
