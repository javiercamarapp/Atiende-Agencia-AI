// D-35 + D-02 -- doble en memoria de la conciliación persistida (pruebas de rutas y del dominio). Replica las reglas de la migración 021
// que las pruebas ejercen: movimiento y CFDI del cliente, movimiento dentro del periodo (y cuenta) de la sesión, un solo match vigente por
// movimiento, periodo cerrado, sesión cerrada, lote todo-o-nada, deshacer idempotente y sugerencias pendientes que nunca crean un match
// por sí solas. Lee los movimientos y los CFDI del `InMemoryDespachosRepository` (misma fuente que el libro real de la 015).
import { randomUUID } from "node:crypto";
import { estaPeriodoCerrado } from "../../cierre-mensual/engine.ts";
import type { InMemoryDespachosRepository } from "../../in-memory-repository.ts";
import {
  ConciliacionConflictoError,
  ConciliacionDatosInvalidosError,
  ConciliacionNoDisponibleError,
  ConciliacionNoEncontradaError,
  ConciliacionPeriodoCerradoError,
  ConciliacionTopeExcedidoError,
  MAX_PARES_POR_CONFIRMACION,
  MAX_SUGERENCIAS_POR_CORRIDA,
  PERIODO_RE,
  periodoDeFecha,
} from "./types.ts";
import type {
  ConciliacionPersistidaRepository,
  LecturaConciliacion,
  MatchConciliacion,
  MovimientoGuardado,
  NuevaSugerencia,
  ParConfirmar,
  SesionConciliacion,
  SesionConResumen,
  SugerenciaConciliacion,
} from "./types.ts";

export class InMemoryConciliacionPersistidaRepository implements ConciliacionPersistidaRepository {
  private readonly sesiones = new Map<string, SesionConciliacion>();
  private readonly matches = new Map<string, MatchConciliacion & { propertyId: string }>();
  private readonly sugerencias = new Map<string, SugerenciaConciliacion & { propertyId: string }>();
  /** Simula la base SIN migrar. */
  disponible = true;

  constructor(private readonly despachos: InMemoryDespachosRepository) {}

  private exigirDisponible(): void {
    if (!this.disponible) throw new ConciliacionNoDisponibleError();
  }
  private lectura<T>(vacio: T, datos: () => T): Promise<LecturaConciliacion<T>> {
    return Promise.resolve(this.disponible ? { estado: "disponible", datos: datos() } : { estado: "no_disponible", datos: vacio });
  }

  private movimientosDe(propertyId: string): MovimientoGuardado[] {
    return this.despachos.listEstadoCuentaMovimientosGuardados(propertyId).map((m) => ({
      id: m.id,
      hash: m.hash,
      cuenta: m.cuenta,
      fecha: m.fecha,
      descripcion: m.descripcion,
      referencia: m.referencia,
      cargo: m.cargo,
      abono: m.abono,
      monto: m.monto,
      saldo: m.saldo,
      banco: m.banco,
      formato: m.formato,
    }));
  }
  private movimientosEnSesion(s: SesionConciliacion): MovimientoGuardado[] {
    return this.movimientosDe(s.propertyId).filter((m) => periodoDeFecha(m.fecha) === s.periodo && (s.cuenta === null || m.cuenta === s.cuenta));
  }
  private vigentes(sesionId?: string): (MatchConciliacion & { propertyId: string })[] {
    return [...this.matches.values()].filter((m) => m.deshechoEn === null && (sesionId === undefined || m.sesionId === sesionId));
  }
  private async periodoCerrado(propertyId: string, periodo: string): Promise<boolean> {
    const [anio, mes] = periodo.split("-").map(Number);
    return estaPeriodoCerrado(await this.despachos.findPeriodoCierrePorAnioMes(propertyId, anio!, mes!));
  }

  async crearSesion(propertyId: string, periodo: string, cuenta: string | null, actorId: string): Promise<{ sesion: SesionConciliacion; movimientos: number }> {
    this.exigirDisponible();
    if (!PERIODO_RE.test(periodo)) throw new ConciliacionDatosInvalidosError("periodo con formato YYYY-MM");
    const base: SesionConciliacion = { id: randomUUID(), propertyId, periodo, cuenta: cuenta && cuenta.trim() ? cuenta.trim() : null, estado: "abierta", creadaPor: actorId, creadaEn: new Date().toISOString(), cerradaEn: null };
    const n = this.movimientosEnSesion(base).length;
    if (n === 0) throw new ConciliacionNoEncontradaError(`no hay movimientos guardados en el periodo ${periodo}`);
    this.sesiones.set(base.id, base);
    return { sesion: base, movimientos: n };
  }

  listarSesiones(propertyId: string, limit: number): Promise<LecturaConciliacion<readonly SesionConResumen[]>> {
    return this.lectura<readonly SesionConResumen[]>([], () =>
      [...this.sesiones.values()]
        .filter((s) => s.propertyId === propertyId)
        .sort((a, b) => b.creadaEn.localeCompare(a.creadaEn))
        .slice(0, limit)
        .map((s) => ({
          ...s,
          totalMovimientos: this.movimientosEnSesion(s).length,
          matchesVigentes: this.vigentes(s.id).length,
          sugerenciasPendientes: [...this.sugerencias.values()].filter((g) => g.sesionId === s.id && g.estado === "pendiente").length,
        })),
    );
  }

  obtenerSesion(propertyId: string, sesionId: string): Promise<LecturaConciliacion<SesionConciliacion | null>> {
    return this.lectura<SesionConciliacion | null>(null, () => {
      const s = this.sesiones.get(sesionId);
      return s && s.propertyId === propertyId ? s : null;
    });
  }

  async listarMovimientosSesion(sesion: SesionConciliacion): Promise<readonly MovimientoGuardado[]> {
    this.exigirDisponible();
    return this.movimientosEnSesion(sesion);
  }
  async listarMatches(sesionId: string): Promise<readonly MatchConciliacion[]> {
    this.exigirDisponible();
    return [...this.matches.values()].filter((m) => m.sesionId === sesionId).map(({ propertyId: _p, ...m }) => m);
  }
  async obtenerMatch(propertyId: string, matchId: string): Promise<MatchConciliacion | null> {
    this.exigirDisponible();
    const m = this.matches.get(matchId);
    if (!m || m.propertyId !== propertyId) return null;
    const { propertyId: _p, ...resto } = m;
    return resto;
  }
  async listarSugerencias(sesionId: string): Promise<readonly SugerenciaConciliacion[]> {
    this.exigirDisponible();
    return [...this.sugerencias.values()].filter((g) => g.sesionId === sesionId).map(({ propertyId: _p, ...g }) => g);
  }
  async obtenerSugerencia(propertyId: string, sugerenciaId: string): Promise<SugerenciaConciliacion | null> {
    this.exigirDisponible();
    const g = this.sugerencias.get(sugerenciaId);
    if (!g || g.propertyId !== propertyId) return null;
    const { propertyId: _p, ...resto } = g;
    return resto;
  }
  invoiceIdsConciliados(propertyId: string): Promise<LecturaConciliacion<ReadonlySet<string>>> {
    return this.lectura<ReadonlySet<string>>(new Set(), () => new Set(this.vigentes().filter((m) => m.propertyId === propertyId).map((m) => m.invoiceId)));
  }

  /** Validación común de un match nuevo (equivale a `conciliacion_match_insertar`). `yaEnLote`: movimientos ya aceptados en este mismo lote. */
  private async validarMatch(propertyId: string, sesion: SesionConciliacion, movimientoId: string, invoiceId: string, yaEnLote: ReadonlySet<string>): Promise<void> {
    if (sesion.estado !== "abierta") throw new ConciliacionDatosInvalidosError("la sesión está cerrada");
    const mov = this.movimientosEnSesion(sesion).find((m) => m.id === movimientoId);
    if (!mov) throw new ConciliacionDatosInvalidosError("el movimiento no pertenece a la sesión");
    const invoices = await this.despachos.listInvoices(propertyId);
    if (!invoices.some((i) => i.id === invoiceId)) throw new ConciliacionDatosInvalidosError("el CFDI no pertenece al cliente");
    if (await this.periodoCerrado(propertyId, sesion.periodo)) throw new ConciliacionPeriodoCerradoError(sesion.periodo);
    if (yaEnLote.has(movimientoId) || this.vigentes().some((m) => m.propertyId === propertyId && m.movimientoId === movimientoId)) throw new ConciliacionConflictoError();
  }

  private insertar(propertyId: string, sesionId: string, p: ParConfirmar, actorId: string): MatchConciliacion {
    const m: MatchConciliacion & { propertyId: string } = {
      id: randomUUID(),
      propertyId,
      sesionId,
      movimientoId: p.movimientoId,
      invoiceId: p.invoiceId,
      nivel: p.nivel,
      confianza: p.confianza,
      origen: p.origen,
      confirmadoPor: actorId,
      confirmadoEn: new Date().toISOString(),
      deshechoPor: null,
      deshechoEn: null,
      motivoDeshacer: null,
    };
    this.matches.set(m.id, m);
    const { propertyId: _p, ...resto } = m;
    return resto;
  }

  async confirmarMatches(propertyId: string, sesionId: string, pares: readonly ParConfirmar[], actorId: string): Promise<readonly MatchConciliacion[]> {
    this.exigirDisponible();
    const sesion = this.sesiones.get(sesionId);
    if (!sesion || sesion.propertyId !== propertyId) throw new ConciliacionNoEncontradaError("sesión no encontrada");
    if (pares.length < 1 || pares.length > MAX_PARES_POR_CONFIRMACION) throw new ConciliacionDatosInvalidosError(`de 1 a ${MAX_PARES_POR_CONFIRMACION} pares por solicitud`);
    const enLote = new Set<string>();
    for (const p of pares) {
      if (p.origen === "manual" ? p.nivel !== null || p.confianza !== null : p.nivel === null || p.confianza === null) throw new ConciliacionDatosInvalidosError("nivel y confianza no corresponden al origen");
      await this.validarMatch(propertyId, sesion, p.movimientoId, p.invoiceId, enLote);
      enLote.add(p.movimientoId);
    }
    return pares.map((p) => this.insertar(propertyId, sesionId, p, actorId));
  }

  async deshacerMatch(propertyId: string, matchId: string, motivo: string, actorId: string): Promise<{ yaDeshecho: boolean }> {
    this.exigirDisponible();
    const m = this.matches.get(matchId);
    if (!m || m.propertyId !== propertyId) throw new ConciliacionNoEncontradaError("match no encontrado");
    const limpio = motivo.trim();
    if (limpio.length < 3 || limpio.length > 500) throw new ConciliacionDatosInvalidosError("el motivo es obligatorio (3 a 500 caracteres)");
    if (m.deshechoEn !== null) return { yaDeshecho: true };
    const sesion = this.sesiones.get(m.sesionId)!;
    if (await this.periodoCerrado(propertyId, sesion.periodo)) throw new ConciliacionPeriodoCerradoError(sesion.periodo);
    this.matches.set(matchId, { ...m, deshechoPor: actorId, deshechoEn: new Date().toISOString(), motivoDeshacer: limpio });
    return { yaDeshecho: false };
  }

  async cerrarSesion(propertyId: string, sesionId: string, actorId: string): Promise<{ yaCerrada: boolean }> {
    this.exigirDisponible();
    const s = this.sesiones.get(sesionId);
    if (!s || s.propertyId !== propertyId) throw new ConciliacionNoEncontradaError("sesión no encontrada");
    if (s.estado === "cerrada") return { yaCerrada: true };
    void actorId;
    this.sesiones.set(sesionId, { ...s, estado: "cerrada", cerradaEn: new Date().toISOString() });
    return { yaCerrada: false };
  }

  async guardarSugerencias(propertyId: string, sesionId: string, sugerencias: readonly NuevaSugerencia[], _actorId?: string): Promise<readonly SugerenciaConciliacion[]> {
    this.exigirDisponible();
    const s = this.sesiones.get(sesionId);
    if (!s || s.propertyId !== propertyId) throw new ConciliacionNoEncontradaError("sesión no encontrada");
    if (s.estado !== "abierta") throw new ConciliacionDatosInvalidosError("la sesión está cerrada");
    if (sugerencias.length > MAX_SUGERENCIAS_POR_CORRIDA) throw new ConciliacionTopeExcedidoError(`hasta ${MAX_SUGERENCIAS_POR_CORRIDA} sugerencias por solicitud`);
    const nuevas: SugerenciaConciliacion[] = [];
    for (const g of sugerencias) {
      if ([...this.sugerencias.values()].some((x) => x.sesionId === sesionId && x.movimientoId === g.movimientoId && x.estado === "pendiente")) continue;
      const fila: SugerenciaConciliacion & { propertyId: string } = {
        id: randomUUID(),
        propertyId,
        sesionId,
        movimientoId: g.movimientoId,
        invoiceId: g.invoiceId,
        confianza: Math.min(100, Math.max(0, g.confianza)),
        razon: g.razon.slice(0, 500),
        estado: "pendiente",
        matchId: null,
        creadaEn: new Date().toISOString(),
        resueltaEn: null,
      };
      this.sugerencias.set(fila.id, fila);
      const { propertyId: _p, ...resto } = fila;
      nuevas.push(resto);
    }
    return nuevas;
  }

  async resolverSugerencia(propertyId: string, sugerenciaId: string, aprobar: boolean, actorId: string): Promise<{ estado: "aprobada" | "rechazada"; matchId: string | null }> {
    this.exigirDisponible();
    const g = this.sugerencias.get(sugerenciaId);
    if (!g || g.propertyId !== propertyId) throw new ConciliacionNoEncontradaError("sugerencia no encontrada");
    if (g.estado !== "pendiente") throw new ConciliacionDatosInvalidosError(`la sugerencia ya fue resuelta (${g.estado})`);
    const resuelta = new Date().toISOString();
    if (!aprobar) {
      this.sugerencias.set(sugerenciaId, { ...g, estado: "rechazada", resueltaEn: resuelta });
      return { estado: "rechazada", matchId: null };
    }
    const sesion = this.sesiones.get(g.sesionId)!;
    await this.validarMatch(propertyId, sesion, g.movimientoId, g.invoiceId, new Set());
    const match = this.insertar(propertyId, g.sesionId, { movimientoId: g.movimientoId, invoiceId: g.invoiceId, nivel: 4, confianza: g.confianza, origen: "llm_aprobado" }, actorId);
    this.sugerencias.set(sugerenciaId, { ...g, estado: "aprobada", matchId: match.id, resueltaEn: resuelta });
    return { estado: "aprobada", matchId: match.id };
  }
}
