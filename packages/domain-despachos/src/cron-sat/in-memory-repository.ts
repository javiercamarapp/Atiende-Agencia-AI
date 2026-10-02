// Doble en memoria de `CronSatRepository` (pruebas de los crons sin Postgres). Reproduce la semantica de las funciones SQL de la
// migracion 022: `cancelado` es terminal, `pendiente` solo anota el intento, el reintento respeta la ventana y el escalamiento es
// idempotente por nivel.
import type { EstadoSatCfdi } from "../cfdi/modelo-cfdi.ts";
import type { NivelEscalamiento } from "../vencimientos/engine.ts";
import { CronSatNoDisponibleError } from "./types.ts";
import type { CfdiPendienteEstatusSat, ClienteFichaSistema, CronSatRepository, EfosAfectadoSistema, RegistroEstatusSat, VencimientoPorEscalar } from "./types.ts";

const RANGO: Readonly<Record<NivelEscalamiento, number>> = { nivel_1: 1, nivel_2: 2, nivel_3: 3, nivel_4: 4 };

type CfdiSembrado = { -readonly [K in keyof CfdiPendienteEstatusSat]: CfdiPendienteEstatusSat[K] } & {
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

  sembrarCfdi(c: Omit<CfdiPendienteEstatusSat, "estadoSat"> & { estadoSat?: EstadoSatCfdi; intentadoEn?: number | null }): void {
    this.cfdi.set(c.invoiceId, { ...c, estadoSat: c.estadoSat ?? "pendiente", intentadoEn: c.intentadoEn ?? null, verificadoEn: null, creadoEn: ++this.secuencia });
  }
  estadoCfdi(invoiceId: string): { estadoSat: EstadoSatCfdi; intentadoEn: number | null; verificadoEn: number | null } {
    const c = this.cfdi.get(invoiceId)!;
    return { estadoSat: c.estadoSat, intentadoEn: c.intentadoEn, verificadoEn: c.verificadoEn };
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

  async listarCfdiPendientesEstatusSat(limite: number, reintentoDias: number): Promise<readonly CfdiPendienteEstatusSat[] | null> {
    if (!this.disponible) return null;
    const corte = Date.now() - reintentoDias * 86_400_000;
    return [...this.cfdi.values()]
      .filter((c) => c.estadoSat !== "cancelado" && (c.intentadoEn === null || c.intentadoEn < corte))
      .sort((a, b) => (a.intentadoEn ?? 0) - (b.intentadoEn ?? 0) || a.creadoEn - b.creadoEn)
      .slice(0, Math.min(limite, 500))
      .map(({ intentadoEn: _i, verificadoEn: _v, creadoEn: _c, ...c }) => c);
  }

  async registrarEstatusSatSistema(invoiceId: string, estado: EstadoSatCfdi): Promise<RegistroEstatusSat> {
    this.requerirDisponible();
    const c = this.cfdi.get(invoiceId);
    if (!c) throw Object.assign(new Error("CFDI no encontrado"), { code: "P0002" });
    const anterior = c.estadoSat;
    c.intentadoEn = Date.now();
    if (estado !== "pendiente" && anterior !== "cancelado") {
      c.estadoSat = estado;
      c.verificadoEn = Date.now();
    }
    return { organizationId: c.organizationId, propertyId: c.propertyId, estadoAnterior: anterior, estadoNuevo: c.estadoSat, cambioACancelado: anterior !== "cancelado" && c.estadoSat === "cancelado" };
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
