// Doble en memoria de `PilotoRepository` (pruebas de API y worker sin Postgres). Reproduce la semantica de las funciones de la migracion 027:
// plantilla por cliente, idempotencia por periodo, renglones que pasan a `recibido` cuando el staff acepta el documento, recordatorios a los 3/7/10
// dias, cierre forzado solo para admin, entrega solo con opt-in y periodo cerrado, y el portal por hash de token.
import { randomUUID } from "node:crypto";
import type { EstadoModulosCierre } from "../cierre-mensual/piloto.ts";
import type { CloseTask } from "../cierre-mensual/types.ts";
import { AUTOMATIZACION_POR_OMISION, PilotoEntradaInvalidaError, PilotoNoDisponibleError, PilotoNoEncontradoError, PilotoSinAccesoError } from "./types.ts";
import type {
  ArchivoEntregaMeta,
  ArtefactoCierreMeta,
  AutomatizacionCliente,
  EntregaCierre,
  EntregaPublicada,
  EstadoRenglonSolicitud,
  PeriodoCierreAbierto,
  PilotoDisponible,
  PilotoRepository,
  RegistroSolicitudSistema,
  RenglonSolicitud,
  ResumenSolicitudCliente,
  SolicitudDocumentos,
  SolicitudParaRecordatorio,
  SolicitudPorCrear,
  SolicitudVistaCliente,
  TipoArchivoEntrega,
  TipoArtefactoCierre,
} from "./types.ts";

interface SolicitudMem {
  id: string;
  organizationId: string;
  propertyId: string;
  ejercicio: number;
  mes: number;
  estado: "abierta" | "completa";
  creadaEn: number;
  completadaEn: number | null;
  nivel: number;
  renglones: { -readonly [K in keyof RenglonSolicitud]: RenglonSolicitud[K] }[];
}
interface EnlaceMem {
  propertyId: string;
  tokenHash: string;
  etiqueta: string;
  expiraEn: number;
  revocado: boolean;
}
export interface DocumentoMem {
  id: string;
  propertyId: string;
  tokenHash: string;
  estado: "recibido" | "aceptado" | "rechazado";
}
interface EntregaMem {
  id: string;
  propertyId: string;
  periodoId: string;
  anio: number;
  mes: number;
  creadaEn: number;
  correoEncoladoEn: number | null;
  archivos: (ArchivoEntregaMeta & { contenido: Uint8Array })[];
}
interface ArtefactoMem extends ArtefactoCierreMeta {
  propertyId: string;
  contenido: Uint8Array;
}

export interface ClienteSembradoPiloto {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly razonSocial: string;
  readonly responsableAdmin?: boolean;
}
export interface PeriodoSembradoPiloto extends PeriodoCierreAbierto {
  cerrado?: boolean;
}

const MESES_RECORDATORIO: readonly [number, 1 | 2 | 3][] = [[10, 3], [7, 2], [3, 1]];

export class InMemoryPilotoRepository implements PilotoRepository {
  /** false = simula la base sin la migracion 027. */
  disponible = true;
  /** Rol del actor en las operaciones de staff (admin/contador escriben; el resto recibe PilotoSinAccesoError). */
  rolStaff: "admin" | "contador" | "auditor" | "readonly" = "admin";
  /** Propiedades a las que el actor staff NO tiene acceso (cross-tenant). */
  propiedadesAjenas = new Set<string>();
  ahora: () => number = Date.now;
  /** Hook de pruebas: como la base real, la entrega y los artefactos solo se crean sobre un periodo CERRADO (por omision, el que marca `marcarPeriodoCerrado`). */
  verificarCerrado: ((propertyId: string, periodoId: string) => Promise<boolean>) | null = null;
  /** Hook de pruebas: documentos que vive el portal (otro doble) y el piloto debe poder ligar. */
  buscarDocumentoPortal: ((documentoId: string) => DocumentoMem | undefined) | null = null;
  private docPortal(id: string): DocumentoMem | undefined {
    return this.documentos.get(id) ?? this.buscarDocumentoPortal?.(id);
  }
  private async periodoCerrado(propertyId: string, periodoId: string): Promise<boolean> {
    return this.verificarCerrado ? this.verificarCerrado(propertyId, periodoId) : (this.periodos.get(periodoId)?.cerrado ?? false);
  }

  readonly clientes = new Map<string, ClienteSembradoPiloto>();
  readonly automatizacion = new Map<string, AutomatizacionCliente>();
  readonly solicitudes: SolicitudMem[] = [];
  readonly enlaces: EnlaceMem[] = [];
  readonly documentos = new Map<string, DocumentoMem>();
  readonly estadosModulos = new Map<string, EstadoModulosCierre>();
  readonly periodos = new Map<string, PeriodoSembradoPiloto>();
  readonly tareasAutocompletadas: { periodoId: string; ids: readonly string[] }[] = [];
  readonly forzados: { propertyId: string; periodoId: string; motivo: string; validaciones: readonly string[] }[] = [];
  readonly entregas: EntregaMem[] = [];
  readonly artefactos: ArtefactoMem[] = [];
  readonly cuentasConMovimientos = new Map<string, string[]>();

  // ---- siembra
  sembrarCliente(c: ClienteSembradoPiloto): void {
    this.clientes.set(c.propertyId, c);
  }
  sembrarPeriodo(p: PeriodoSembradoPiloto): void {
    this.periodos.set(p.periodoId, p);
  }
  sembrarEstadoModulos(propertyId: string, anio: number, mes: number, e: EstadoModulosCierre): void {
    this.estadosModulos.set(`${propertyId}:${anio}-${mes}`, e);
  }
  sembrarDocumentoPortal(d: DocumentoMem): void {
    this.documentos.set(d.id, d);
  }
  /** Simula el trigger de la base: el staff acepta o rechaza el documento del portal. */
  resolverDocumentoPortal(documentoId: string, estado: "aceptado" | "rechazado"): void {
    const d = this.documentos.get(documentoId);
    if (d) d.estado = estado;
    for (const s of this.solicitudes) {
      for (const r of s.renglones) {
        if (r.documentoId !== documentoId) continue;
        if (estado === "aceptado" && (r.estado === "pendiente" || r.estado === "en_revision")) {
          r.estado = "recibido";
          r.resueltoEn = new Date(this.ahora()).toISOString();
        } else if (estado === "rechazado" && (r.estado === "en_revision" || r.estado === "recibido")) {
          r.estado = "pendiente";
          r.documentoId = null;
          r.resueltoEn = null;
        }
        this.recomputar(s);
      }
    }
  }

  // ---- internos
  private requerirDisponible(): void {
    if (!this.disponible) throw new PilotoNoDisponibleError();
  }
  private requerirEscritura(propertyId: string): ClienteSembradoPiloto {
    this.requerirDisponible();
    if (this.propiedadesAjenas.has(propertyId) || !(this.rolStaff === "admin" || this.rolStaff === "contador")) throw new PilotoSinAccesoError();
    const c = this.clientes.get(propertyId);
    if (!c) throw new PilotoSinAccesoError();
    return c;
  }
  private recomputar(s: SolicitudMem): void {
    const abierta = s.renglones.some((r) => r.estado === "pendiente" || r.estado === "en_revision");
    if (abierta) {
      s.estado = "abierta";
      s.completadaEn = null;
    } else if (s.estado !== "completa") {
      s.estado = "completa";
      s.completadaEn = this.ahora();
    }
  }
  private vista(s: SolicitudMem): SolicitudDocumentos {
    return {
      id: s.id,
      propertyId: s.propertyId,
      ejercicio: s.ejercicio,
      mes: s.mes,
      estado: s.estado,
      creadaEn: new Date(s.creadaEn).toISOString(),
      completadaEn: s.completadaEn === null ? null : new Date(s.completadaEn).toISOString(),
      ultimoRecordatorioNivel: s.nivel,
      renglones: s.renglones.map((r) => ({ ...r })),
    };
  }
  private crearInterna(organizationId: string, propertyId: string, ejercicio: number, mes: number): { s: SolicitudMem; creada: boolean } {
    const existente = this.solicitudes.find((x) => x.propertyId === propertyId && x.ejercicio === ejercicio && x.mes === mes);
    if (existente) return { s: existente, creada: false };
    const a = this.automatizacion.get(propertyId) ?? AUTOMATIZACION_POR_OMISION;
    const p = a.plantilla;
    const cuentas = p.estadosCuenta ?? this.cuentasConMovimientos.get(propertyId) ?? [];
    const renglones: SolicitudMem["renglones"] = [];
    const nuevo = (tipo: RenglonSolicitud["tipo"], etiqueta: string) => renglones.push({ id: randomUUID(), tipo, etiqueta, estado: "pendiente", motivoNoAplica: null, documentoId: null, resueltoEn: null });
    if (cuentas.length === 0) nuevo("estado_cuenta", "Estado de cuenta bancario");
    for (const c of cuentas) nuevo("estado_cuenta", `Estado de cuenta ${/^\d+$/.test(c) && c.length > 4 ? `****${c.slice(-4)}` : c}`);
    if (p.xmlEmitidos ?? true) nuevo("xml_emitidos", "CFDI emitidos del mes (XML)");
    if (p.xmlRecibidos ?? true) nuevo("xml_recibidos", "CFDI recibidos del mes (XML)");
    if (p.nomina ?? false) nuevo("nomina", "Nómina del mes");
    if (p.otros ?? false) nuevo("otros", "Otros documentos del mes");
    const s: SolicitudMem = { id: randomUUID(), organizationId, propertyId, ejercicio, mes, estado: "abierta", creadaEn: this.ahora(), completadaEn: null, nivel: 0, renglones };
    this.solicitudes.push(s);
    return { s, creada: true };
  }
  private buscarRenglon(propertyId: string, renglonId: string): { s: SolicitudMem; r: SolicitudMem["renglones"][number] } | null {
    for (const s of this.solicitudes) {
      if (s.propertyId !== propertyId) continue;
      const r = s.renglones.find((x) => x.id === renglonId);
      if (r) return { s, r };
    }
    return null;
  }

  // ---- STAFF
  async obtenerAutomatizacion(propertyId: string): Promise<PilotoDisponible<AutomatizacionCliente>> {
    if (!this.disponible) return { disponible: false };
    return { disponible: true, valor: this.automatizacion.get(propertyId) ?? AUTOMATIZACION_POR_OMISION };
  }
  async guardarAutomatizacion(propertyId: string, a: AutomatizacionCliente): Promise<void> {
    this.requerirEscritura(propertyId);
    if (a.contactoCorreo !== null && !correoValido(a.contactoCorreo)) throw new PilotoEntradaInvalidaError("correo de contacto inválido");
    if (a.envioReportesCierre && a.contactoCorreo === null) throw new PilotoEntradaInvalidaError("para enviar reportes al cerrar captura un correo de contacto");
    if (a.solicitudDia < 1 || a.solicitudDia > 28) throw new PilotoEntradaInvalidaError("el día de la solicitud va de 1 a 28");
    this.automatizacion.set(propertyId, { ...a, contactoCorreo: a.contactoCorreo === null ? null : a.contactoCorreo.toLowerCase() });
  }
  async listarSolicitudes(propertyId: string, limite = 12): Promise<PilotoDisponible<readonly SolicitudDocumentos[]>> {
    if (!this.disponible) return { disponible: false };
    return { disponible: true, valor: this.solicitudes.filter((s) => s.propertyId === propertyId).sort((a, b) => b.ejercicio - a.ejercicio || b.mes - a.mes).slice(0, limite).map((s) => this.vista(s)) };
  }
  async resumenSolicitudesPeriodo(ejercicio: number, mes: number): Promise<PilotoDisponible<readonly ResumenSolicitudCliente[]>> {
    if (!this.disponible) return { disponible: false };
    const cuenta = (s: SolicitudMem, e: EstadoRenglonSolicitud) => s.renglones.filter((r) => r.estado === e).length;
    return {
      disponible: true,
      valor: this.solicitudes
        .filter((s) => s.ejercicio === ejercicio && s.mes === mes && !this.propiedadesAjenas.has(s.propertyId))
        .map((s) => ({ propertyId: s.propertyId, ejercicio, mes, estado: s.estado, creadaEn: new Date(s.creadaEn).toISOString(), total: s.renglones.length, pendientes: cuenta(s, "pendiente"), enRevision: cuenta(s, "en_revision"), recibidos: cuenta(s, "recibido"), noAplica: cuenta(s, "no_aplica") })),
    };
  }
  async crearSolicitud(propertyId: string, ejercicio: number, mes: number): Promise<{ readonly id: string; readonly creada: boolean }> {
    const c = this.requerirEscritura(propertyId);
    if (mes < 1 || mes > 12) throw new PilotoEntradaInvalidaError("periodo inválido");
    const { s, creada } = this.crearInterna(c.organizationId, propertyId, ejercicio, mes);
    return { id: s.id, creada };
  }
  async marcarRenglonNoAplica(propertyId: string, renglonId: string, motivo: string): Promise<boolean> {
    this.requerirEscritura(propertyId);
    const m = motivo.trim();
    if (m.length < 3 || m.length > 300) throw new PilotoEntradaInvalidaError("el motivo debe tener de 3 a 300 caracteres");
    const x = this.buscarRenglon(propertyId, renglonId);
    if (!x || (x.r.estado !== "pendiente" && x.r.estado !== "en_revision")) return false;
    x.r.estado = "no_aplica";
    x.r.motivoNoAplica = m;
    x.r.resueltoEn = new Date(this.ahora()).toISOString();
    this.recomputar(x.s);
    return true;
  }
  async reabrirRenglon(propertyId: string, renglonId: string): Promise<boolean> {
    this.requerirEscritura(propertyId);
    const x = this.buscarRenglon(propertyId, renglonId);
    if (!x || x.r.estado !== "no_aplica") return false;
    x.r.estado = "pendiente";
    x.r.motivoNoAplica = null;
    x.r.resueltoEn = null;
    this.recomputar(x.s);
    return true;
  }
  async vincularDocumentoStaff(propertyId: string, renglonId: string, documentoId: string): Promise<EstadoRenglonSolicitud> {
    this.requerirEscritura(propertyId);
    const d = this.docPortal(documentoId);
    if (!d || d.propertyId !== propertyId) throw new PilotoNoEncontradoError();
    if (d.estado === "rechazado") throw new PilotoEntradaInvalidaError("un documento rechazado no cubre un renglón");
    const x = this.buscarRenglon(propertyId, renglonId);
    if (!x || x.r.estado === "recibido") throw new PilotoNoEncontradoError();
    x.r.documentoId = documentoId;
    x.r.motivoNoAplica = null;
    x.r.estado = d.estado === "aceptado" ? "recibido" : "en_revision";
    x.r.resueltoEn = x.r.estado === "recibido" ? new Date(this.ahora()).toISOString() : null;
    this.recomputar(x.s);
    return x.r.estado;
  }
  async estadoModulosCierre(propertyId: string, anio: number, mes: number): Promise<PilotoDisponible<EstadoModulosCierre>> {
    if (!this.disponible) return { disponible: false };
    if (this.propiedadesAjenas.has(propertyId)) throw new PilotoSinAccesoError();
    // Sin siembra: un periodo «sano» (nada pendiente, papel de pagos provisionales generado) para que las pruebas que no son del cierre sigan cerrando.
    const e = this.estadosModulos.get(`${propertyId}:${anio}-${mes}`);
    return {
      disponible: true,
      valor: e ?? { debeCentavos: 0, haberCentavos: 0, polizas: 0, polizasDescuadradas: 0, cfdiTotal: 0, cfdiSinPoliza: 0, cfdiInvalidos: 0, conciliacionSesiones: 0, conciliacionAbiertas: 0, movimientos: 0, movimientosConciliados: 0, pagosProvisionales: 1, solicitudEstado: null, solicitudPendientes: 0, periodicidad: "mensual" },
    };
  }
  async forzarCierre(propertyId: string, periodoId: string, motivo: string, validaciones: readonly string[]): Promise<boolean> {
    this.requerirDisponible();
    if (this.rolStaff !== "admin" || this.propiedadesAjenas.has(propertyId)) throw new PilotoSinAccesoError();
    if (motivo.trim().length < 10 || motivo.trim().length > 500) throw new PilotoEntradaInvalidaError("el motivo debe tener de 10 a 500 caracteres");
    const p = this.periodos.get(periodoId);
    if (!p || p.cerrado) return false;
    this.forzados.push({ propertyId, periodoId, motivo: motivo.trim(), validaciones });
    return true;
  }
  /** Las pruebas llaman esto cuando el cierre real (repositorio de despachos) deja el periodo cerrado. */
  marcarPeriodoCerrado(periodoId: string): void {
    const p = this.periodos.get(periodoId);
    if (p) p.cerrado = true;
  }
  async crearEntrega(propertyId: string, periodoId: string): Promise<EntregaCierre> {
    this.requerirEscritura(propertyId);
    const p = this.periodos.get(periodoId);
    if (!p || p.propertyId !== propertyId || !(await this.periodoCerrado(propertyId, periodoId))) throw new PilotoNoEncontradoError();
    const a = this.automatizacion.get(propertyId) ?? AUTOMATIZACION_POR_OMISION;
    if (!a.envioReportesCierre || a.contactoCorreo === null) throw new PilotoEntradaInvalidaError("el cliente no tiene activado el envío de reportes");
    const existente = this.entregas.find((e) => e.periodoId === periodoId);
    if (existente) return { id: existente.id, creada: false, contactoCorreo: a.contactoCorreo, anio: p.anio, mes: p.mes };
    const e: EntregaMem = { id: randomUUID(), propertyId, periodoId, anio: p.anio, mes: p.mes, creadaEn: this.ahora(), correoEncoladoEn: null, archivos: [] };
    this.entregas.push(e);
    return { id: e.id, creada: true, contactoCorreo: a.contactoCorreo, anio: p.anio, mes: p.mes };
  }
  async agregarArchivoEntrega(propertyId: string, entregaId: string, tipo: TipoArchivoEntrega, nombre: string, contenido: Uint8Array): Promise<boolean> {
    this.requerirEscritura(propertyId);
    const e = this.entregas.find((x) => x.id === entregaId && x.propertyId === propertyId);
    if (!e) throw new PilotoNoEncontradoError();
    if (contenido.length < 5 || Buffer.from(contenido.subarray(0, 5)).toString("latin1") !== "%PDF-") throw new PilotoEntradaInvalidaError("se esperaba un PDF");
    if (e.archivos.some((a) => a.tipo === tipo)) return false;
    e.archivos.push({ id: randomUUID(), tipo, nombreArchivo: nombre, tamanoBytes: contenido.length, contenido });
    return true;
  }
  async marcarCorreoEntrega(propertyId: string, entregaId: string): Promise<boolean> {
    this.requerirEscritura(propertyId);
    const e = this.entregas.find((x) => x.id === entregaId && x.propertyId === propertyId);
    if (!e || e.correoEncoladoEn !== null) return false;
    e.correoEncoladoEn = this.ahora();
    return true;
  }
  async guardarArtefacto(propertyId: string, periodoId: string, tipo: TipoArtefactoCierre, nombre: string, contenido: Uint8Array): Promise<boolean> {
    this.requerirEscritura(propertyId);
    const p = this.periodos.get(periodoId);
    if (!p || p.propertyId !== propertyId || !(await this.periodoCerrado(propertyId, periodoId))) throw new PilotoNoEncontradoError();
    if (this.artefactos.some((a) => a.periodoCierreId === periodoId && a.tipo === tipo)) return false;
    this.artefactos.push({ id: randomUUID(), propertyId, periodoCierreId: periodoId, tipo, nombreArchivo: nombre, tamanoBytes: contenido.length, creadoEn: new Date(this.ahora()).toISOString(), contenido });
    return true;
  }
  async listarArtefactos(propertyId: string, periodoId: string): Promise<PilotoDisponible<readonly ArtefactoCierreMeta[]>> {
    if (!this.disponible) return { disponible: false };
    return { disponible: true, valor: this.artefactos.filter((a) => a.propertyId === propertyId && a.periodoCierreId === periodoId).map(({ propertyId: _p, contenido: _c, ...meta }) => meta) };
  }
  async contenidoArtefacto(propertyId: string, artefactoId: string): Promise<{ readonly nombreArchivo: string; readonly contenido: Uint8Array }> {
    this.requerirEscritura(propertyId);
    const a = this.artefactos.find((x) => x.id === artefactoId && x.propertyId === propertyId);
    if (!a) throw new PilotoNoEncontradoError();
    return { nombreArchivo: a.nombreArchivo, contenido: a.contenido };
  }
  async entregaDelPeriodo(propertyId: string, periodoId: string) {
    if (!this.disponible) return { disponible: false } as const;
    const e = this.entregas.find((x) => x.propertyId === propertyId && x.periodoId === periodoId);
    return { disponible: true, valor: e ? { id: e.id, creadaEn: new Date(e.creadaEn).toISOString(), correoEncoladoEn: e.correoEncoladoEn === null ? null : new Date(e.correoEncoladoEn).toISOString(), archivos: e.archivos.map(({ contenido: _c, ...meta }) => meta) } : null } as const;
  }

  // ---- SISTEMA
  async solicitudesPorCrear(hoy: string, limite: number): Promise<readonly SolicitudPorCrear[] | null> {
    if (!this.disponible) return null;
    const [y, m, d] = hoy.split("-").map(Number) as [number, number, number];
    const prev = m === 1 ? { e: y - 1, m: 12 } : { e: y, m: m - 1 };
    return [...this.clientes.values()]
      .filter((c) => {
        const a = this.automatizacion.get(c.propertyId) ?? AUTOMATIZACION_POR_OMISION;
        return a.solicitudActiva && d >= a.solicitudDia && !this.solicitudes.some((s) => s.propertyId === c.propertyId && s.ejercicio === prev.e && s.mes === prev.m);
      })
      .slice(0, Math.min(limite, 1000))
      .map((c) => ({ organizationId: c.organizationId, propertyId: c.propertyId, ejercicio: prev.e, mes: prev.m }));
  }
  async crearSolicitudSistema(propertyId: string, ejercicio: number, mes: number): Promise<RegistroSolicitudSistema> {
    this.requerirDisponible();
    const c = this.clientes.get(propertyId);
    if (!c) throw new PilotoEntradaInvalidaError("la property no tiene ficha de cliente");
    const { s, creada } = this.crearInterna(c.organizationId, propertyId, ejercicio, mes);
    const a = this.automatizacion.get(propertyId) ?? AUTOMATIZACION_POR_OMISION;
    return { id: s.id, creada, organizationId: c.organizationId, contactoCorreo: a.contactoCorreo, cliente: c.razonSocial, renglones: s.renglones.length, etiquetas: s.renglones.map((r) => r.etiqueta) };
  }
  async crearEnlaceSistema(propertyId: string, tokenHash: string, etiqueta: string, dias: number): Promise<{ readonly id: string; readonly expiraEn: string }> {
    this.requerirDisponible();
    if (!/^(Solicitud|Reportes) \d{4}-\d{2}$/.test(etiqueta)) throw new PilotoEntradaInvalidaError("etiqueta inválida");
    for (const e of this.enlaces) if (e.propertyId === propertyId && e.etiqueta === etiqueta) e.revocado = true;
    const e: EnlaceMem = { propertyId, tokenHash, etiqueta, expiraEn: this.ahora() + dias * 86_400_000, revocado: false };
    this.enlaces.push(e);
    return { id: randomUUID(), expiraEn: new Date(e.expiraEn).toISOString() };
  }
  async solicitudesParaRecordatorio(hoy: string, limite: number): Promise<readonly SolicitudParaRecordatorio[] | null> {
    if (!this.disponible) return null;
    const hoyMs = Date.parse(`${hoy}T00:00:00Z`);
    const out: SolicitudParaRecordatorio[] = [];
    for (const s of this.solicitudes) {
      if (s.estado !== "abierta") continue;
      const dias = Math.floor((hoyMs - Date.parse(new Date(s.creadaEn).toISOString().slice(0, 10) + "T00:00:00Z")) / 86_400_000);
      const nivel = (MESES_RECORDATORIO.find(([d]) => dias >= d)?.[1] ?? 0) as 0 | 1 | 2 | 3;
      const pendientes = s.renglones.filter((r) => r.estado === "pendiente").length;
      if (nivel === 0 || pendientes === 0 || nivel <= s.nivel) continue;
      const c = this.clientes.get(s.propertyId);
      const a = this.automatizacion.get(s.propertyId) ?? AUTOMATIZACION_POR_OMISION;
      out.push({ id: s.id, organizationId: s.organizationId, propertyId: s.propertyId, ejercicio: s.ejercicio, mes: s.mes, nivel, pendientes, dias, contactoCorreo: a.contactoCorreo, cliente: c?.razonSocial ?? "Cliente" });
    }
    return out.slice(0, Math.min(limite, 1000));
  }
  async marcarRecordatorio(solicitudId: string, nivel: 1 | 2 | 3): Promise<boolean> {
    this.requerirDisponible();
    const s = this.solicitudes.find((x) => x.id === solicitudId);
    if (!s || s.estado !== "abierta" || s.nivel >= nivel) return false;
    s.nivel = nivel;
    return true;
  }
  async periodosCierreAbiertos(limite: number): Promise<readonly PeriodoCierreAbierto[] | null> {
    if (!this.disponible) return null;
    return [...this.periodos.values()].filter((p) => !p.cerrado).slice(0, limite).map(({ cerrado: _c, ...p }) => p);
  }
  readonly tareasPorPeriodo = new Map<string, CloseTask[]>();
  async tareasCierreSistema(periodoId: string): Promise<readonly CloseTask[]> {
    this.requerirDisponible();
    return (this.tareasPorPeriodo.get(periodoId) ?? []).map((t) => ({ ...t }));
  }
  async autocompletarTareasSistema(periodoId: string, tareaIds: readonly string[]): Promise<number> {
    this.requerirDisponible();
    this.tareasAutocompletadas.push({ periodoId, ids: tareaIds });
    const tareas = this.tareasPorPeriodo.get(periodoId);
    if (tareas) for (const t of tareas) if (tareaIds.includes(t.id)) Object.assign(t, { status: "done", completedAt: new Date(this.ahora()).toISOString(), completedBy: "sistema" });
    return tareaIds.length;
  }

  // ---- PORTAL
  private enlaceVigente(tokenHash: string): EnlaceMem {
    const e = this.enlaces.find((x) => x.tokenHash === tokenHash && !x.revocado && x.expiraEn > this.ahora());
    if (!e) throw new PilotoNoEncontradoError("enlace_no_valido");
    return e;
  }
  async portalSolicitudes(tokenHash: string): Promise<PilotoDisponible<readonly SolicitudVistaCliente[]>> {
    if (!this.disponible) return { disponible: false };
    const e = this.enlaceVigente(tokenHash);
    return {
      disponible: true,
      valor: this.solicitudes
        .filter((s) => s.propertyId === e.propertyId)
        .sort((a, b) => b.ejercicio - a.ejercicio || b.mes - a.mes)
        .slice(0, 3)
        .map((s) => ({ id: s.id, ejercicio: s.ejercicio, mes: s.mes, estado: s.estado, renglones: s.renglones.map((r) => ({ id: r.id, tipo: r.tipo, etiqueta: r.etiqueta, estado: r.estado, motivo: r.motivoNoAplica })) })),
    };
  }
  async portalVincular(tokenHash: string, documentoId: string, renglonId: string): Promise<PilotoDisponible<EstadoRenglonSolicitud>> {
    if (!this.disponible) return { disponible: false };
    const e = this.enlaceVigente(tokenHash);
    const d = this.docPortal(documentoId);
    if (!d || d.propertyId !== e.propertyId || d.estado === "rechazado") throw new PilotoNoEncontradoError();
    const x = this.buscarRenglon(e.propertyId, renglonId);
    if (!x || (x.r.estado !== "pendiente" && x.r.estado !== "en_revision")) throw new PilotoNoEncontradoError();
    x.r.documentoId = documentoId;
    x.r.estado = d.estado === "aceptado" ? "recibido" : "en_revision";
    x.r.resueltoEn = x.r.estado === "recibido" ? new Date(this.ahora()).toISOString() : null;
    this.recomputar(x.s);
    return { disponible: true, valor: x.r.estado };
  }
  async portalReportes(tokenHash: string): Promise<PilotoDisponible<readonly EntregaPublicada[]>> {
    if (!this.disponible) return { disponible: false };
    const en = this.enlaceVigente(tokenHash);
    return {
      disponible: true,
      valor: this.entregas.filter((x) => x.propertyId === en.propertyId).map((x) => ({ anio: x.anio, mes: x.mes, publicadaEn: new Date(x.creadaEn).toISOString(), archivos: x.archivos.map(({ contenido: _c, ...meta }) => meta) })),
    };
  }
  async portalReporteContenido(tokenHash: string, archivoId: string): Promise<PilotoDisponible<{ readonly nombreArchivo: string; readonly contenido: Uint8Array }>> {
    if (!this.disponible) return { disponible: false };
    const en = this.enlaceVigente(tokenHash);
    for (const e of this.entregas) {
      if (e.propertyId !== en.propertyId) continue;
      const a = e.archivos.find((x) => x.id === archivoId);
      if (a) return { disponible: true, valor: { nombreArchivo: a.nombreArchivo, contenido: a.contenido } };
    }
    throw new PilotoNoEncontradoError();
  }
}

/** Correo sin regex de backtracking (CodeQL js/polynomial-redos): una sola arroba, dominio con punto y sin espacios, tope de 254. */
function correoValido(correo: string): boolean {
  if (correo.length > 254 || /\s/.test(correo)) return false;
  const partes = correo.split("@");
  if (partes.length !== 2) return false;
  const [local, dominio] = partes as [string, string];
  const punto = dominio.lastIndexOf(".");
  return local.length > 0 && punto > 0 && punto < dominio.length - 1;
}
