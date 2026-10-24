// Doble en memoria de `CronSatRepository` (pruebas de los crons sin Postgres). Reproduce la semantica de las funciones SQL de la
// migracion 022: `cancelado` es terminal, `pendiente` solo anota el intento, el reintento respeta la ventana y el escalamiento es
// idempotente por nivel.
import type { EstadoSatCfdi } from "../cfdi/modelo-cfdi.ts";
import type { NivelEscalamiento } from "../vencimientos/engine.ts";
import { CronSatNoDisponibleError } from "./types.ts";
import type { CfdiPendienteEstatusSat, ClienteFichaSistema, CronSatRepository, DetalleEstatusSat, EfosAfectadoSistema, RegistroEstatusSat, VencimientoPorEscalar } from "./types.ts";

const RANGO: Readonly<Record<NivelEscalamiento, number>> = { nivel_1: 1, nivel_2: 2, nivel_3: 3, nivel_4: 4 };

type CfdiSembrado = { -readonly [K in keyof CfdiPendienteEstatusSat]: CfdiPendienteEstatusSat[K] } & {
  /** Fecha de emision (YYYY-MM-DD). Sin ella se trata como reciente. */
  fecha?: string;
  detalle: DetalleEstatusSat;
  intentadoEn: number | null;
  verificadoEn: number | null;
  readonly creadoEn: number;
};
interface VencimientoSembrado {
  readonly id: string;
  readonly propertyId: string;
  tipo: string;
  periodo: string;
  fechaLimite: string;
  prioridad: string;
  estado: "pendiente" | "completado" | "escalado";
  nivelMax: NivelEscalamiento | null;
}

export class InMemoryCronSatRepository implements CronSatRepository {
  /** false = simula la base sin la migracion 022. */
  disponible = true;
  private secuencia = 0;
  private readonly cfdi = new Map<string, CfdiSembrado>();
  private readonly efos: EfosAfectadoSistema[] = [];
  private readonly clientes: ClienteFichaSistema[] = [];
  private readonly vencimientos = new Map<string, VencimientoSembrado>();
  /** Escalamientos registrados, en orden (para aserciones). */
  readonly escalamientos: { deadlineId: string; nivel: NivelEscalamiento; notas: string }[] = [];

  sembrarCfdi(c: Omit<CfdiPendienteEstatusSat, "estadoSat" | "prioridad"> & { estadoSat?: EstadoSatCfdi; intentadoEn?: number | null; fecha?: string; estatusCancelacion?: string | null }): void {
    const { estatusCancelacion, ...resto } = c;
    this.cfdi.set(c.invoiceId, { ...resto, estadoSat: c.estadoSat ?? "pendiente", detalle: { esCancelable: null, estatusCancelacion: estatusCancelacion ?? null, codigoEstatus: null, validacionEfos: null }, intentadoEn: c.intentadoEn ?? null, verificadoEn: null, creadoEn: ++this.secuencia });
  }
  estadoCfdi(invoiceId: string): { estadoSat: EstadoSatCfdi; intentadoEn: number | null; verificadoEn: number | null; detalle: DetalleEstatusSat } {
    const c = this.cfdi.get(invoiceId)!;
    return { estadoSat: c.estadoSat, intentadoEn: c.intentadoEn, verificadoEn: c.verificadoEn, detalle: c.detalle };
  }
  sembrarEfosAfectado(a: EfosAfectadoSistema): void {
    this.efos.push(a);
  }
  sembrarCliente(c: ClienteFichaSistema): void {
    this.clientes.push(c);
  }
  vencimientosDe(propertyId: string): readonly VencimientoSembrado[] {
    return [...this.vencimientos.values()].filter((v) => v.propertyId === propertyId);
  }
  completarVencimiento(id: string): void {
    this.vencimientos.get(id)!.estado = "completado";
  }

  private requerirDisponible(): void {
    if (!this.disponible) throw new CronSatNoDisponibleError();
  }

  /** false = simula la base con la migracion 022 pero SIN la 027 (orden anterior y sin detalle de cancelacion). */
  migracion027 = true;
  /** Ahora (ms) inyectable para las pruebas de ventana y reintento. */
  ahora: () => number = Date.now;

  private prioridadDe(c: CfdiSembrado): number {
    const enProceso = /^en proceso/i.test((c.detalle.estatusCancelacion ?? "").trim());
    if (c.intentadoEn === null) return 0;
    if (enProceso) return 1;
    const fecha = c.fecha ? Date.parse(`${c.fecha}T00:00:00Z`) : this.ahora();
    return this.ahora() - fecha <= 90 * 86_400_000 ? 2 : 3;
  }

  async listarCfdiPendientesEstatusSat(limite: number, reintentoDias: number, ventanaEjercicios = 2, porProperty = 15): Promise<readonly CfdiPendienteEstatusSat[] | null> {
    if (!this.disponible) return null;
    const limpiar = ({ intentadoEn: _i, verificadoEn: _v, creadoEn: _c, fecha: _f, detalle: _d, ...c }: CfdiSembrado): CfdiPendienteEstatusSat => c;
    if (!this.migracion027) {
      const corte = this.ahora() - reintentoDias * 86_400_000;
      return [...this.cfdi.values()]
        .filter((c) => c.estadoSat !== "cancelado" && (c.intentadoEn === null || c.intentadoEn < corte))
        .sort((a, b) => (a.intentadoEn ?? 0) - (b.intentadoEn ?? 0) || a.creadoEn - b.creadoEn)
        .slice(0, Math.min(limite, 500))
        .map(limpiar);
    }
    const ahora = this.ahora();
    const corte = ahora - reintentoDias * 86_400_000;
    const desde = Date.UTC(new Date(ahora).getUTCFullYear() - (ventanaEjercicios - 1), 0, 1);
    const candidatos = [...this.cfdi.values()].filter((c) => {
      if (c.estadoSat === "cancelado") return false;
      if (c.intentadoEn === null) return true;
      const enProceso = /^en proceso/i.test((c.detalle.estatusCancelacion ?? "").trim());
      if (enProceso && c.intentadoEn < ahora - 20 * 3_600_000) return true;
      const fecha = c.fecha ? Date.parse(`${c.fecha}T00:00:00Z`) : ahora;
      return fecha >= desde && c.intentadoEn < corte;
    });
    const orden = (a: CfdiSembrado, b: CfdiSembrado) => this.prioridadDe(a) - this.prioridadDe(b) || (a.intentadoEn ?? 0) - (b.intentadoEn ?? 0) || a.creadoEn - b.creadoEn;
    const porCliente = new Map<string, number>();
    return candidatos
      .sort(orden)
      .filter((c) => {
        const n = (porCliente.get(c.propertyId) ?? 0) + 1;
        porCliente.set(c.propertyId, n);
        return n <= porProperty;
      })
      .slice(0, Math.min(limite, 500))
      .map((c) => ({ ...limpiar(c), prioridad: this.prioridadDe(c) }));
  }

  async registrarEstatusSatSistema(invoiceId: string, estado: EstadoSatCfdi, detalle?: DetalleEstatusSat): Promise<RegistroEstatusSat> {
    this.requerirDisponible();
    const c = this.cfdi.get(invoiceId);
    if (!c) throw Object.assign(new Error("CFDI no encontrado"), { code: "P0002" });
    const anterior = c.estadoSat;
    const enProceso = (v: string | null) => /^en proceso/i.test((v ?? "").trim());
    const detalleAnterior = c.detalle;
    c.intentadoEn = this.ahora();
    let cancelacionEnProcesoNueva = false;
    if (estado !== "pendiente" && anterior !== "cancelado") {
      c.estadoSat = estado;
      c.verificadoEn = this.ahora();
      if (this.migracion027) {
        c.detalle = detalle ?? { esCancelable: null, estatusCancelacion: null, codigoEstatus: null, validacionEfos: null };
        cancelacionEnProcesoNueva = enProceso(c.detalle.estatusCancelacion) && !enProceso(detalleAnterior.estatusCancelacion);
      }
    }
    return { organizationId: c.organizationId, propertyId: c.propertyId, estadoAnterior: anterior, estadoNuevo: c.estadoSat, cambioACancelado: anterior !== "cancelado" && c.estadoSat === "cancelado", cancelacionEnProcesoNueva };
  }

  async listarEfosAfectadosSistema(limite: number): Promise<readonly EfosAfectadoSistema[] | null> {
    return this.disponible ? this.efos.slice(0, Math.min(limite, 2000)) : null;
  }

  async listarClientesFichaSistema(limite: number): Promise<readonly ClienteFichaSistema[] | null> {
    return this.disponible ? this.clientes.slice(0, Math.min(limite, 1000)) : null;
  }

  async upsertVencimientoSistema(propertyId: string, nuevo: { readonly tipo: string; readonly periodo: string; readonly fechaLimite: string; readonly prioridad: string }): Promise<{ readonly id: string; readonly creado: boolean }> {
    this.requerirDisponible();
    if (!this.clientes.some((c) => c.propertyId === propertyId)) throw Object.assign(new Error("la property no tiene ficha de cliente"), { code: "22023" });
    const existente = [...this.vencimientos.values()].find((v) => v.propertyId === propertyId && v.tipo === nuevo.tipo && v.periodo === nuevo.periodo);
    if (existente) {
      if (existente.estado !== "completado") {
        existente.fechaLimite = nuevo.fechaLimite;
        existente.prioridad = nuevo.prioridad;
      }
      return { id: existente.id, creado: false };
    }
    const id = `dl-${++this.secuencia}`;
    this.vencimientos.set(id, { id, propertyId, tipo: nuevo.tipo, periodo: nuevo.periodo, fechaLimite: nuevo.fechaLimite, prioridad: nuevo.prioridad, estado: "pendiente", nivelMax: null });
    return { id, creado: true };
  }

  async listarVencimientosPorEscalarSistema(propertyId: string, hoy: string): Promise<readonly VencimientoPorEscalar[]> {
    this.requerirDisponible();
    const limite = new Date(`${hoy}T00:00:00Z`);
    limite.setUTCDate(limite.getUTCDate() + 1);
    const tope = limite.toISOString().slice(0, 10);
    return [...this.vencimientos.values()]
      .filter((v) => v.propertyId === propertyId && v.estado !== "completado" && v.fechaLimite <= tope)
      .sort((a, b) => a.fechaLimite.localeCompare(b.fechaLimite) || a.tipo.localeCompare(b.tipo))
      .map((v) => ({ id: v.id, tipo: v.tipo, periodo: v.periodo, fechaLimite: v.fechaLimite, prioridad: v.prioridad, nivelMax: v.nivelMax }));
  }

  async escalarVencimientoSistema(deadlineId: string, nivel: NivelEscalamiento, notas: string): Promise<boolean> {
    this.requerirDisponible();
    const v = this.vencimientos.get(deadlineId);
    if (!v) throw Object.assign(new Error("vencimiento no encontrado"), { code: "P0002" });
    if (v.estado === "completado") return false;
    if (v.nivelMax !== null && RANGO[v.nivelMax] >= RANGO[nivel]) return false;
    v.nivelMax = nivel;
    v.estado = "escalado";
    this.escalamientos.push({ deadlineId, nivel, notas });
    return true;
  }
}
