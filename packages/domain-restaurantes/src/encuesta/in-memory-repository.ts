// Repositorio en memoria de la encuesta para pruebas de API y de dominio: reproduce el contrato (apagada por defecto, una respuesta por
// pedido con first-write-wins, estado "no disponible"), NO RLS ni las definiciones SQL por zona horaria (eso lo prueba
// scripts/verify-restaurantes-encuesta-entrega/ contra Postgres real).
import {
  ENCUESTA_CALIFICACION_BAJA_MAX,
  ENCUESTA_CONFIG_DEFECTO,
  EncuestaNoDisponibleError,
} from "./encuesta.ts";
import type {
  EncuestaCandidata,
  EncuestaConfig,
  EncuestaConfigEntrada,
  EncuestaLectura,
  EncuestaPorRepartidor,
  EncuestaPorSucursal,
  EncuestaPublica,
  EncuestaRepository,
  EncuestaRespuestaResultado,
  EncuestaResumen,
} from "./encuesta.ts";

export interface EncuestaEntregaMemoria {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly orderId: string;
  readonly repartidorId: string | null;
  readonly enviadaAt: string;
  respondidaAt: string | null;
  calificacion: number | null;
  comentario: string | null;
}

export class InMemoryEncuestaRepository implements EncuestaRepository {
  /** false simula la base sin migrar. */
  disponible = true;
  readonly configs = new Map<string, EncuestaConfig>();
  readonly entregas: EncuestaEntregaMemoria[] = [];
  /** Candidatas que `candidatas` devuelve (las pruebas las siembran; la logica SQL real se prueba contra Postgres). */
  readonly pendientes: EncuestaCandidata[] = [];
  readonly nombresSucursal = new Map<string, string>();
  readonly nombresRepartidor = new Map<string, string>();
  readonly resenasPorSucursal = new Map<string, string>();

  private cfgKey(propertyId: string): string {
    return propertyId;
  }

  async leerConfig(_organizationId: string, propertyId: string): Promise<EncuestaLectura<EncuestaConfig>> {
    if (!this.disponible) return { disponible: false, valor: ENCUESTA_CONFIG_DEFECTO };
    return { disponible: true, valor: this.configs.get(this.cfgKey(propertyId)) ?? ENCUESTA_CONFIG_DEFECTO };
  }

  async guardarConfig(_organizationId: string, propertyId: string, entrada: EncuestaConfigEntrada): Promise<EncuestaConfig> {
    if (!this.disponible) throw new EncuestaNoDisponibleError();
    const cfg: EncuestaConfig = { activa: entrada.activa, esperaMin: entrada.esperaMin, resenasUrl: entrada.resenasUrl, umbralResena: entrada.umbralResena };
    this.configs.set(this.cfgKey(propertyId), cfg);
    return cfg;
  }

  async resumen(organizationId: string, desde: string, hasta: string, propertyId: string | null): Promise<EncuestaLectura<EncuestaResumen>> {
    if (!this.disponible) return { disponible: false, valor: { global: { enviadas: 0, respondidas: 0, promedio: null, distribucion: [0, 0, 0, 0, 0] }, porSucursal: [], porRepartidor: [], recientes: [] } };
    const enRango = this.entregas.filter(
      (e) => e.organizationId === organizationId && (propertyId === null || e.propertyId === propertyId) && e.enviadaAt.slice(0, 10) >= desde && e.enviadaAt.slice(0, 10) <= hasta,
    );
    const promedio = (xs: readonly EncuestaEntregaMemoria[]) => {
      const r = xs.filter((x) => x.calificacion !== null);
      return { enviadas: xs.length, respondidas: r.length, promedio: r.length === 0 ? null : Math.round((r.reduce((a, x) => a + (x.calificacion ?? 0), 0) / r.length) * 100) / 100 };
    };
    const distribucion: [number, number, number, number, number] = [0, 0, 0, 0, 0];
    for (const e of enRango) if (e.calificacion !== null) distribucion[e.calificacion - 1] = (distribucion[e.calificacion - 1] ?? 0) + 1;
    const props = [...new Set(enRango.map((e) => e.propertyId))];
    const porSucursal: EncuestaPorSucursal[] = props.map((p) => ({ propertyId: p, nombre: this.nombresSucursal.get(p) ?? p, ...promedio(enRango.filter((e) => e.propertyId === p)) }));
    const reps = [...new Set(enRango.map((e) => e.repartidorId).filter((r): r is string => r !== null))];
    const porRepartidor: EncuestaPorRepartidor[] = reps.map((r) => ({ repartidorId: r, nombre: this.nombresRepartidor.get(r) ?? "Repartidor", ...promedio(enRango.filter((e) => e.repartidorId === r)) }));
    const recientes = enRango
      .filter((e) => e.calificacion !== null && e.respondidaAt !== null)
      .sort((a, b) => (b.respondidaAt ?? "").localeCompare(a.respondidaAt ?? ""))
      .slice(0, 20)
      .map((e, i) => ({
        id: `mem-${i}-${e.orderId}`,
        pedido: null,
        propertyId: e.propertyId,
        sucursal: this.nombresSucursal.get(e.propertyId) ?? e.propertyId,
        calificacion: e.calificacion ?? 0,
        comentario: e.comentario,
        respondidaAt: e.respondidaAt ?? "",
        repartidor: e.repartidorId ? (this.nombresRepartidor.get(e.repartidorId) ?? null) : null,
      }));
    return { disponible: true, valor: { global: { ...promedio(enRango), distribucion }, porSucursal, porRepartidor, recientes } };
  }

  async candidatas(organizationId: string | null, _ahora: Date | null, limite: number): Promise<EncuestaLectura<readonly EncuestaCandidata[]>> {
    if (!this.disponible) return { disponible: false, valor: [] };
    const sinEncuesta = this.pendientes.filter((c) => (organizationId === null || c.organizationId === organizationId) && !this.entregas.some((e) => e.orderId === c.orderId));
    return { disponible: true, valor: sinEncuesta.slice(0, limite) };
  }

  async registrarEnvio(organizationId: string, orderId: string): Promise<boolean> {
    if (this.entregas.some((e) => e.orderId === orderId)) return false;
    const c = this.pendientes.find((p) => p.orderId === orderId && p.organizationId === organizationId);
    if (!c) throw new Error("pedido inexistente o no entregado");
    this.entregas.push({ organizationId, propertyId: c.propertyId, orderId, repartidorId: null, enviadaAt: new Date().toISOString(), respondidaAt: null, calificacion: null, comentario: null });
    return true;
  }

  /** Para sembrar encuestas ya enviadas. */
  sembrarEntrega(e: Omit<EncuestaEntregaMemoria, "respondidaAt" | "calificacion" | "comentario"> & Partial<Pick<EncuestaEntregaMemoria, "respondidaAt" | "calificacion" | "comentario">>): void {
    this.entregas.push({ respondidaAt: null, calificacion: null, comentario: null, ...e });
  }

  async publica(organizationId: string, orderId: string): Promise<EncuestaLectura<EncuestaPublica | null>> {
    if (!this.disponible) return { disponible: false, valor: null };
    const e = this.entregas.find((x) => x.orderId === orderId && x.organizationId === organizationId);
    if (!e) return { disponible: true, valor: null };
    return { disponible: true, valor: { sucursal: this.nombresSucursal.get(e.propertyId) ?? "Sucursal", respondida: e.respondidaAt !== null, calificacion: e.calificacion, resenasUrl: this.resenaPara(e) } };
  }

  private resenaPara(e: EncuestaEntregaMemoria): string | null {
    const cfg = this.configs.get(this.cfgKey(e.propertyId));
    const url = cfg?.resenasUrl ?? this.resenasPorSucursal.get(e.propertyId) ?? null;
    return e.calificacion !== null && url !== null && e.calificacion >= (cfg?.umbralResena ?? ENCUESTA_CONFIG_DEFECTO.umbralResena) ? url : null;
  }

  async responder(organizationId: string, orderId: string, calificacion: number, comentario: string | null): Promise<EncuestaLectura<EncuestaRespuestaResultado | null>> {
    if (!this.disponible) return { disponible: false, valor: null };
    const e = this.entregas.find((x) => x.orderId === orderId && x.organizationId === organizationId);
    if (!e) return { disponible: true, valor: { estado: "no_encontrada", propertyId: null, calificacion: null, resenasUrl: null } };
    const estado = e.respondidaAt === null ? "registrada" : "ya_respondida";
    if (estado === "registrada") {
      e.calificacion = calificacion;
      e.comentario = comentario;
      e.respondidaAt = new Date().toISOString();
    }
    return { disponible: true, valor: { estado, propertyId: e.propertyId, calificacion: e.calificacion, resenasUrl: this.resenaPara(e) } };
  }

  /** Util para pruebas: respuestas bajas (las que disparan la notificacion). */
  respuestasBajas(): number {
    return this.entregas.filter((e) => e.calificacion !== null && e.calificacion <= ENCUESTA_CALIFICACION_BAJA_MAX).length;
  }
}
