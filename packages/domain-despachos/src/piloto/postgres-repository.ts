// Adaptador Postgres del piloto automatico (migracion 027). Todas las operaciones corren bajo `runWithSavepointFallback`: la sesion es UNA
// transaccion compartida por request (o por unidad de cron), y contra la base SIN migrar el 42883/42P01/42703 degrada a `{ disponible: false }`
// (lecturas) o `PilotoNoDisponibleError` (escrituras) sin dejar la transaccion abortada (25P02). Los demas errores de las funciones se traducen
// a errores de dominio tipados, sin filtrar mensajes de Postgres.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { EstadoModulosCierre } from "../cierre-mensual/piloto.ts";
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
  PlantillaSolicitud,
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

const FN_PREFIX = "despachos.";

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** SQLSTATE de las funciones de la 027 -> error de dominio. */
function traducirError(err: unknown): unknown {
  switch (pgCode(err)) {
    case "P0002":
      return new PilotoNoEncontradoError();
    case "22023":
    case "23514":
    case "23505":
      return new PilotoEntradaInvalidaError(err instanceof Error ? err.message.replace(/^[a-z_]+:\s*/, "") : undefined);
    case "42501":
      return new PilotoSinAccesoError();
    default:
      return err;
  }
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

export function plantillaAJson(p: PlantillaSolicitud): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.xmlEmitidos !== undefined) out.xml_emitidos = p.xmlEmitidos;
  if (p.xmlRecibidos !== undefined) out.xml_recibidos = p.xmlRecibidos;
  if (p.nomina !== undefined) out.nomina = p.nomina;
  if (p.otros !== undefined) out.otros = p.otros;
  if (p.estadosCuenta !== undefined) out.estados_cuenta = [...p.estadosCuenta];
  return out;
}

export function plantillaDeJson(j: unknown): PlantillaSolicitud {
  const o = (j && typeof j === "object" ? j : {}) as Record<string, unknown>;
  return {
    ...(typeof o.xml_emitidos === "boolean" ? { xmlEmitidos: o.xml_emitidos } : {}),
    ...(typeof o.xml_recibidos === "boolean" ? { xmlRecibidos: o.xml_recibidos } : {}),
    ...(typeof o.nomina === "boolean" ? { nomina: o.nomina } : {}),
    ...(typeof o.otros === "boolean" ? { otros: o.otros } : {}),
    ...(Array.isArray(o.estados_cuenta) ? { estadosCuenta: o.estados_cuenta.filter((x): x is string => typeof x === "string") } : {}),
  };
}

export class PostgresPilotoRepository implements PilotoRepository {
  constructor(private readonly db: TenantDbSession) {}

  private async lectura<T>(savepointName: string, fn: () => Promise<T>): Promise<PilotoDisponible<T>> {
    try {
      return await runWithSavepointFallback<PilotoDisponible<T>>({
        session: this.db,
        savepointName,
        primary: async () => ({ disponible: true, valor: await fn() }),
        isRecoverable: (err) => isMigrationPendingError(err, FN_PREFIX),
        fallback: async () => ({ disponible: false }),
      });
    } catch (err) {
      throw traducirError(err);
    }
  }

  private async lecturaNula<T>(savepointName: string, fn: () => Promise<T>): Promise<T | null> {
    const r = await this.lectura(savepointName, fn);
    return r.disponible ? r.valor : null;
  }

  private async escritura<T>(savepointName: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await runWithSavepointFallback<T>({
        session: this.db,
        savepointName,
        primary: fn,
        isRecoverable: (err) => isMigrationPendingError(err, FN_PREFIX),
        fallback: async () => {
          throw new PilotoNoDisponibleError();
        },
      });
    } catch (err) {
      throw traducirError(err);
    }
  }

  // ------------------------------------------------------------------ automatizacion
  obtenerAutomatizacion(propertyId: string): Promise<PilotoDisponible<AutomatizacionCliente>> {
    return this.lectura("sp_piloto_automatizacion", async () => {
      const { rows } = await this.db.query<{ contacto_correo: string | null; envio_reportes_cierre: boolean; solicitud_activa: boolean; solicitud_dia: number; plantilla: unknown }>(
        "select contacto_correo, envio_reportes_cierre, solicitud_activa, solicitud_dia, plantilla from despachos.cliente_automatizacion where property_id = $1;",
        [propertyId],
      );
      const r = rows[0];
      if (!r) return AUTOMATIZACION_POR_OMISION;
      return { contactoCorreo: r.contacto_correo, envioReportesCierre: r.envio_reportes_cierre === true, solicitudActiva: r.solicitud_activa !== false, solicitudDia: Number(r.solicitud_dia), plantilla: plantillaDeJson(r.plantilla) };
    });
  }

  guardarAutomatizacion(propertyId: string, a: AutomatizacionCliente): Promise<void> {
    return this.escritura("sp_piloto_automatizacion_guardar", async () => {
      await this.db.query("select despachos.cliente_automatizacion_guardar($1, $2, $3, $4, $5, $6::jsonb);", [propertyId, a.contactoCorreo, a.envioReportesCierre, a.solicitudActiva, a.solicitudDia, JSON.stringify(plantillaAJson(a.plantilla))]);
    });
  }

  // ------------------------------------------------------------------ solicitudes
  listarSolicitudes(propertyId: string, limite = 12): Promise<PilotoDisponible<readonly SolicitudDocumentos[]>> {
    return this.lectura("sp_piloto_solicitudes", async () => {
      const { rows: sols } = await this.db.query<{ id: string; property_id: string; ejercicio: number; mes: number; estado: "abierta" | "completa"; creada_en: string | Date; completada_en: string | Date | null; ultimo_recordatorio_nivel: number }>(
        "select id, property_id, ejercicio, mes, estado, creada_en, completada_en, ultimo_recordatorio_nivel from despachos.solicitud_documentos where property_id = $1 order by ejercicio desc, mes desc limit $2;",
        [propertyId, Math.min(Math.max(limite, 1), 36)],
      );
      if (sols.length === 0) return [];
      const { rows: renglones } = await this.db.query<{ id: string; solicitud_id: string; tipo: RenglonSolicitud["tipo"]; etiqueta: string; estado: EstadoRenglonSolicitud; motivo_no_aplica: string | null; documento_id: string | null; resuelto_en: string | Date | null }>(
        "select id, solicitud_id, tipo, etiqueta, estado, motivo_no_aplica, documento_id, resuelto_en from despachos.solicitud_documentos_renglon where property_id = $1 and solicitud_id = any($2::uuid[]) order by tipo, etiqueta;",
        [propertyId, sols.map((s) => s.id)],
      );
      return sols.map((s) => ({
        id: s.id,
        propertyId: s.property_id,
        ejercicio: Number(s.ejercicio),
        mes: Number(s.mes),
        estado: s.estado,
        creadaEn: iso(s.creada_en),
        completadaEn: isoOrNull(s.completada_en),
        ultimoRecordatorioNivel: Number(s.ultimo_recordatorio_nivel),
        renglones: renglones.filter((r) => r.solicitud_id === s.id).map((r) => ({ id: r.id, tipo: r.tipo, etiqueta: r.etiqueta, estado: r.estado, motivoNoAplica: r.motivo_no_aplica, documentoId: r.documento_id, resueltoEn: isoOrNull(r.resuelto_en) })),
      }));
    });
  }

  resumenSolicitudesPeriodo(ejercicio: number, mes: number): Promise<PilotoDisponible<readonly ResumenSolicitudCliente[]>> {
    return this.lectura("sp_piloto_solicitudes_resumen", async () => {
      const { rows } = await this.db.query<{ property_id: string; ejercicio: number; mes: number; estado: "abierta" | "completa"; creada_en: string | Date; total: string; pendientes: string; en_revision: string; recibidos: string; no_aplica: string }>(
        `select s.property_id, s.ejercicio, s.mes, s.estado, s.creada_en,
                count(r.id)::text as total,
                (count(r.id) filter (where r.estado = 'pendiente'))::text as pendientes,
                (count(r.id) filter (where r.estado = 'en_revision'))::text as en_revision,
                (count(r.id) filter (where r.estado = 'recibido'))::text as recibidos,
                (count(r.id) filter (where r.estado = 'no_aplica'))::text as no_aplica
           from despachos.solicitud_documentos s
           left join despachos.solicitud_documentos_renglon r on r.solicitud_id = s.id
          where s.ejercicio = $1 and s.mes = $2
          group by s.id
          order by s.property_id
          limit 2000;`,
        [ejercicio, mes],
      );
      return rows.map((r) => ({ propertyId: r.property_id, ejercicio: Number(r.ejercicio), mes: Number(r.mes), estado: r.estado, creadaEn: iso(r.creada_en), total: Number(r.total), pendientes: Number(r.pendientes), enRevision: Number(r.en_revision), recibidos: Number(r.recibidos), noAplica: Number(r.no_aplica) }));
    });
  }

  crearSolicitud(propertyId: string, ejercicio: number, mes: number): Promise<{ readonly id: string; readonly creada: boolean }> {
    return this.escritura("sp_piloto_solicitud_crear", async () => {
      const { rows } = await this.db.query<{ out_id: string; out_creada: boolean }>("select out_id, out_creada from despachos.solicitud_documentos_crear($1, $2, $3);", [propertyId, ejercicio, mes]);
      return { id: rows[0]!.out_id, creada: rows[0]!.out_creada === true };
    });
  }

  marcarRenglonNoAplica(propertyId: string, renglonId: string, motivo: string): Promise<boolean> {
    return this.escritura("sp_piloto_renglon_no_aplica", async () => {
      const { rows } = await this.db.query<{ r: boolean }>("select despachos.solicitud_renglon_no_aplica($1, $2, $3) as r;", [propertyId, renglonId, motivo]);
      return rows[0]?.r === true;
    });
  }

  reabrirRenglon(propertyId: string, renglonId: string): Promise<boolean> {
    return this.escritura("sp_piloto_renglon_reabrir", async () => {
      const { rows } = await this.db.query<{ r: boolean }>("select despachos.solicitud_renglon_reabrir($1, $2) as r;", [propertyId, renglonId]);
      return rows[0]?.r === true;
    });
  }

  vincularDocumentoStaff(propertyId: string, renglonId: string, documentoId: string): Promise<EstadoRenglonSolicitud> {
    return this.escritura("sp_piloto_renglon_vincular", async () => {
      const { rows } = await this.db.query<{ r: EstadoRenglonSolicitud }>("select despachos.solicitud_renglon_vincular_staff($1, $2, $3) as r;", [propertyId, renglonId, documentoId]);
      return rows[0]!.r;
    });
  }

  // ------------------------------------------------------------------ cierre
  estadoModulosCierre(propertyId: string, anio: number, mes: number): Promise<PilotoDisponible<EstadoModulosCierre>> {
    return this.lectura("sp_piloto_estado_modulos", async () => {
      const { rows } = await this.db.query<Record<string, unknown>>("select * from despachos.cierre_estado_modulos($1, $2, $3);", [propertyId, anio, mes]);
      const r = rows[0];
      if (!r) throw new PilotoNoEncontradoError();
      const n = (k: string): number => Number(r[k] ?? 0);
      const estado = r.out_solicitud_estado;
      const periodicidad = r.out_periodicidad;
      return {
        debeCentavos: n("out_debe_centavos"),
        haberCentavos: n("out_haber_centavos"),
        polizas: n("out_polizas"),
        polizasDescuadradas: n("out_polizas_descuadradas"),
        cfdiTotal: n("out_cfdi_total"),
        cfdiSinPoliza: n("out_cfdi_sin_poliza"),
        cfdiInvalidos: n("out_cfdi_invalidos"),
        conciliacionSesiones: n("out_conciliacion_sesiones"),
        conciliacionAbiertas: n("out_conciliacion_abiertas"),
        movimientos: n("out_movimientos"),
        movimientosConciliados: n("out_movimientos_conciliados"),
        pagosProvisionales: n("out_pagos_provisionales"),
        solicitudEstado: estado === "abierta" || estado === "completa" ? estado : null,
        solicitudPendientes: n("out_solicitud_pendientes"),
        periodicidad: periodicidad === "mensual" || periodicidad === "bimestral" ? periodicidad : null,
      };
    });
  }

  forzarCierre(propertyId: string, periodoId: string, motivo: string, validaciones: readonly string[]): Promise<boolean> {
    return this.escritura("sp_piloto_cierre_forzar", async () => {
      const { rows } = await this.db.query<{ r: boolean }>("select despachos.periodo_cierre_forzar($1, $2, $3, $4::text[]) as r;", [propertyId, periodoId, motivo, [...validaciones]]);
      return rows[0]?.r === true;
    });
  }

  crearEntrega(propertyId: string, periodoId: string): Promise<EntregaCierre> {
    return this.escritura("sp_piloto_entrega_crear", async () => {
      const { rows } = await this.db.query<{ out_id: string; out_creada: boolean; out_contacto_correo: string; out_anio: number; out_mes: number }>("select * from despachos.cierre_entrega_crear($1, $2);", [propertyId, periodoId]);
      const r = rows[0]!;
      return { id: r.out_id, creada: r.out_creada === true, contactoCorreo: r.out_contacto_correo, anio: Number(r.out_anio), mes: Number(r.out_mes) };
    });
  }

  agregarArchivoEntrega(propertyId: string, entregaId: string, tipo: TipoArchivoEntrega, nombre: string, contenido: Uint8Array): Promise<boolean> {
    return this.escritura("sp_piloto_entrega_archivo", async () => {
      const { rows } = await this.db.query<{ r: boolean }>("select despachos.cierre_entrega_archivo_agregar($1, $2, $3, $4, $5) as r;", [propertyId, entregaId, tipo, nombre, Buffer.from(contenido)]);
      return rows[0]?.r === true;
    });
  }

  marcarCorreoEntrega(propertyId: string, entregaId: string): Promise<boolean> {
    return this.escritura("sp_piloto_entrega_correo", async () => {
      const { rows } = await this.db.query<{ r: boolean }>("select despachos.cierre_entrega_marcar_correo($1, $2) as r;", [propertyId, entregaId]);
      return rows[0]?.r === true;
    });
  }

  guardarArtefacto(propertyId: string, periodoId: string, tipo: TipoArtefactoCierre, nombre: string, contenido: Uint8Array): Promise<boolean> {
    return this.escritura("sp_piloto_artefacto_guardar", async () => {
      const { rows } = await this.db.query<{ r: boolean }>("select despachos.cierre_artefacto_guardar($1, $2, $3, $4, $5) as r;", [propertyId, periodoId, tipo, nombre, Buffer.from(contenido)]);
      return rows[0]?.r === true;
    });
  }

  listarArtefactos(propertyId: string, periodoId: string): Promise<PilotoDisponible<readonly ArtefactoCierreMeta[]>> {
    return this.lectura("sp_piloto_artefactos", async () => {
      const { rows } = await this.db.query<{ id: string; periodo_cierre_id: string; tipo: TipoArtefactoCierre; nombre_archivo: string; tamano_bytes: number; creado_en: string | Date }>(
        "select id, periodo_cierre_id, tipo, nombre_archivo, tamano_bytes, creado_en from despachos.cierre_artefacto where property_id = $1 and periodo_cierre_id = $2 order by tipo;",
        [propertyId, periodoId],
      );
      return rows.map((r) => ({ id: r.id, periodoCierreId: r.periodo_cierre_id, tipo: r.tipo, nombreArchivo: r.nombre_archivo, tamanoBytes: Number(r.tamano_bytes), creadoEn: iso(r.creado_en) }));
    });
  }

  contenidoArtefacto(propertyId: string, artefactoId: string): Promise<{ readonly nombreArchivo: string; readonly contenido: Uint8Array }> {
    return this.escritura("sp_piloto_artefacto_contenido", async () => {
      const { rows } = await this.db.query<{ out_nombre_archivo: string; out_contenido: Uint8Array }>("select * from despachos.cierre_artefacto_contenido($1, $2);", [propertyId, artefactoId]);
      const r = rows[0];
      if (!r) throw new PilotoNoEncontradoError();
      return { nombreArchivo: r.out_nombre_archivo, contenido: new Uint8Array(r.out_contenido) };
    });
  }

  entregaDelPeriodo(propertyId: string, periodoId: string) {
    return this.lectura("sp_piloto_entrega_periodo", async () => {
      const { rows } = await this.db.query<{ id: string; creada_en: string | Date; correo_encolado_en: string | Date | null }>("select id, creada_en, correo_encolado_en from despachos.cierre_entrega where property_id = $1 and periodo_cierre_id = $2;", [propertyId, periodoId]);
      const e = rows[0];
      if (!e) return null;
      const { rows: archivos } = await this.db.query<{ id: string; tipo: TipoArchivoEntrega; nombre_archivo: string; tamano_bytes: number }>(
        "select id, tipo, nombre_archivo, tamano_bytes from despachos.cierre_entrega_archivo where property_id = $1 and entrega_id = $2 order by tipo;",
        [propertyId, e.id],
      );
      const meta: ArchivoEntregaMeta[] = archivos.map((a) => ({ id: a.id, tipo: a.tipo, nombreArchivo: a.nombre_archivo, tamanoBytes: Number(a.tamano_bytes) }));
      return { id: e.id, creadaEn: iso(e.creada_en), correoEncoladoEn: isoOrNull(e.correo_encolado_en), archivos: meta };
    });
  }

  // ------------------------------------------------------------------ sistema
  solicitudesPorCrear(hoy: string, limite: number): Promise<readonly SolicitudPorCrear[] | null> {
    return this.lecturaNula("sp_piloto_sol_por_crear", async () => {
      const { rows } = await this.db.query<{ out_organization_id: string; out_property_id: string; out_ejercicio: number; out_mes: number }>("select * from despachos.system_solicitudes_por_crear($1::date, $2);", [hoy, limite]);
      return rows.map((r) => ({ organizationId: r.out_organization_id, propertyId: r.out_property_id, ejercicio: Number(r.out_ejercicio), mes: Number(r.out_mes) }));
    });
  }

  crearSolicitudSistema(propertyId: string, ejercicio: number, mes: number): Promise<RegistroSolicitudSistema> {
    return this.escritura("sp_piloto_sol_crear_sistema", async () => {
      const { rows } = await this.db.query<{ out_id: string; out_creada: boolean; out_organization_id: string; out_contacto_correo: string | null; out_cliente: string; out_renglones: number }>("select * from despachos.system_solicitud_crear($1, $2, $3);", [propertyId, ejercicio, mes]);
      const r = rows[0]!;
      return { id: r.out_id, creada: r.out_creada === true, organizationId: r.out_organization_id, contactoCorreo: r.out_contacto_correo, cliente: r.out_cliente, renglones: Number(r.out_renglones) };
    });
  }

  crearEnlaceSistema(propertyId: string, tokenHash: string, etiqueta: string, dias: number): Promise<{ readonly id: string; readonly expiraEn: string }> {
    return this.escritura("sp_piloto_enlace_sistema", async () => {
      const { rows } = await this.db.query<{ out_id: string; out_expira_en: string | Date }>("select * from despachos.system_portal_enlace_crear($1, $2, $3, $4);", [propertyId, tokenHash, etiqueta, dias]);
      return { id: rows[0]!.out_id, expiraEn: iso(rows[0]!.out_expira_en) };
    });
  }

  solicitudesParaRecordatorio(hoy: string, limite: number): Promise<readonly SolicitudParaRecordatorio[] | null> {
    return this.lecturaNula("sp_piloto_sol_recordatorio", async () => {
      const { rows } = await this.db.query<{ out_id: string; out_organization_id: string; out_property_id: string; out_ejercicio: number; out_mes: number; out_nivel: number; out_pendientes: number; out_dias: number; out_contacto_correo: string | null; out_cliente: string }>(
        "select * from despachos.system_solicitudes_para_recordatorio($1::date, $2);",
        [hoy, limite],
      );
      return rows.map((r) => ({ id: r.out_id, organizationId: r.out_organization_id, propertyId: r.out_property_id, ejercicio: Number(r.out_ejercicio), mes: Number(r.out_mes), nivel: Number(r.out_nivel) as 1 | 2 | 3, pendientes: Number(r.out_pendientes), dias: Number(r.out_dias), contactoCorreo: r.out_contacto_correo, cliente: r.out_cliente }));
    });
  }

  marcarRecordatorio(solicitudId: string, nivel: 1 | 2 | 3): Promise<boolean> {
    return this.escritura("sp_piloto_sol_recordatorio_marcar", async () => {
      const { rows } = await this.db.query<{ r: boolean }>("select despachos.system_solicitud_recordatorio_marcar($1, $2) as r;", [solicitudId, nivel]);
      return rows[0]?.r === true;
    });
  }

  periodosCierreAbiertos(limite: number): Promise<readonly PeriodoCierreAbierto[] | null> {
    return this.lecturaNula("sp_piloto_periodos_abiertos", async () => {
      const { rows } = await this.db.query<{ out_periodo_id: string; out_organization_id: string; out_property_id: string; out_anio: number; out_mes: number }>("select * from despachos.system_periodos_cierre_abiertos($1);", [limite]);
      return rows.map((r) => ({ periodoId: r.out_periodo_id, organizationId: r.out_organization_id, propertyId: r.out_property_id, anio: Number(r.out_anio), mes: Number(r.out_mes) }));
    });
  }

  autocompletarTareasSistema(periodoId: string, tareaIds: readonly string[]): Promise<number> {
    return this.escritura("sp_piloto_tareas_autocompletar", async () => {
      const { rows } = await this.db.query<{ n: number }>("select despachos.system_cierre_tareas_autocompletar($1, $2::uuid[]) as n;", [periodoId, [...tareaIds]]);
      return Number(rows[0]?.n ?? 0);
    });
  }

  // ------------------------------------------------------------------ portal
  portalSolicitudes(tokenHash: string): Promise<PilotoDisponible<readonly SolicitudVistaCliente[]>> {
    return this.lectura("sp_piloto_portal_solicitudes", async () => {
      const { rows } = await this.db.query<{ r: { id: string; ejercicio: number; mes: number; estado: "abierta" | "completa"; renglones: { id: string; tipo: RenglonSolicitud["tipo"]; etiqueta: string; estado: EstadoRenglonSolicitud; motivo: string | null }[] }[] }>("select despachos.portal_cliente_solicitudes($1) as r;", [tokenHash]);
      return (rows[0]?.r ?? []).map((s) => ({ id: s.id, ejercicio: Number(s.ejercicio), mes: Number(s.mes), estado: s.estado, renglones: s.renglones.map((r) => ({ id: r.id, tipo: r.tipo, etiqueta: r.etiqueta, estado: r.estado, motivo: r.motivo })) }));
    });
  }

  portalVincular(tokenHash: string, documentoId: string, renglonId: string): Promise<PilotoDisponible<EstadoRenglonSolicitud>> {
    return this.lectura("sp_piloto_portal_vincular", async () => {
      const { rows } = await this.db.query<{ r: EstadoRenglonSolicitud }>("select despachos.portal_cliente_solicitud_vincular($1, $2, $3) as r;", [tokenHash, documentoId, renglonId]);
      return rows[0]!.r;
    });
  }

  portalReportes(tokenHash: string): Promise<PilotoDisponible<readonly EntregaPublicada[]>> {
    return this.lectura("sp_piloto_portal_reportes", async () => {
      const { rows } = await this.db.query<{ r: { anio: number; mes: number; publicada_en: string; archivos: { id: string; tipo: TipoArchivoEntrega; nombre_archivo: string; tamano_bytes: number }[] }[] }>("select despachos.portal_cliente_reportes($1) as r;", [tokenHash]);
      return (rows[0]?.r ?? []).map((e) => ({ anio: Number(e.anio), mes: Number(e.mes), publicadaEn: e.publicada_en, archivos: e.archivos.map((a) => ({ id: a.id, tipo: a.tipo, nombreArchivo: a.nombre_archivo, tamanoBytes: Number(a.tamano_bytes) })) }));
    });
  }

  portalReporteContenido(tokenHash: string, archivoId: string) {
    return this.lectura("sp_piloto_portal_reporte_contenido", async () => {
      const { rows } = await this.db.query<{ out_nombre_archivo: string; out_contenido: Uint8Array }>("select * from despachos.portal_cliente_reporte_contenido($1, $2);", [tokenHash, archivoId]);
      const r = rows[0];
      if (!r) throw new PilotoNoEncontradoError();
      return { nombreArchivo: r.out_nombre_archivo, contenido: new Uint8Array(r.out_contenido) };
    });
  }
}
