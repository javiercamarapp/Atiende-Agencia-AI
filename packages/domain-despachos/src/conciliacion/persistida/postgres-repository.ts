// D-35 + D-02 -- adaptador Postgres de la conciliación persistida (migración 021). Cada operación corre bajo `runWithSavepointFallback`:
// la sesión es UNA transacción compartida por request y un error de Postgres la deja abortada (25P02). Contra la base SIN migrar el
// 42883/42P01/42703 degrada a "no disponible" (lecturas: vacío honesto + estado) o a `ConciliacionNoDisponibleError` (escrituras);
// nunca a un 500. Los SQLSTATE de las funciones definer se traducen a errores de dominio tipados.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { leerPropuestasGuardadas } from "./propuestas-guardadas.ts";
import type { PropuestasGuardadas } from "./propuestas-guardadas.ts";
import {
  ConciliacionCfdiCanceladoError,
  ConciliacionConflictoError,
  ConciliacionDatosInvalidosError,
  ConciliacionNoDisponibleError,
  ConciliacionNoEncontradaError,
  ConciliacionPeriodoCerradoError,
  ConciliacionPilotoApagadoError,
  ConciliacionSignoInvertidoError,
  ConciliacionSinPermisoError,
  ConciliacionTopeCfdiExcedidoError,
  ConciliacionTopeExcedidoError,
} from "./types.ts";
import type {
  ConciliacionPersistidaRepository,
  LecturaConciliacion,
  MatchConciliacion,
  MovimientoGuardado,
  NuevaSugerencia,
  ParAutopiloto,
  ParConfirmar,
  SesionConciliacion,
  SesionConResumen,
  SugerenciaConciliacion,
} from "./types.ts";

const FN_PREFIX = "despachos.conciliacion_";

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** SQLSTATE de las funciones de la migración 021 -> error de dominio (sin filtrar más detalle de Postgres del necesario). */
export function traducirErrorConciliacion(err: unknown): unknown {
  const mensaje = err instanceof Error ? err.message.replace(/^conciliacion_[a-z_]+:\s*/, "") : "Datos inválidos.";
  switch (pgCode(err)) {
    case "42501":
      return new ConciliacionSinPermisoError();
    case "22023":
    case "23514":
      return new ConciliacionDatosInvalidosError(mensaje);
    case "55000": {
      const periodo = /(20\d\d-\d\d)/.exec(mensaje)?.[1] ?? "";
      return new ConciliacionPeriodoCerradoError(periodo);
    }
    case "23505":
      return new ConciliacionConflictoError();
    case "P0002":
      return new ConciliacionNoEncontradaError(mensaje);
    case "54000":
      return new ConciliacionTopeExcedidoError(mensaje);
    // Migración 025 (D-P3-11/12): SQLSTATE propios de integridad del CFDI y del piloto automático -> 409.
    case "CF001":
      return new ConciliacionCfdiCanceladoError();
    case "CF002":
      return new ConciliacionTopeCfdiExcedidoError();
    case "CF003":
      return new ConciliacionSignoInvertidoError(/dirección/.test(mensaje) ? "La dirección del CFDI (emitido/recibido) no está definida: el piloto automático no lo confirma." : undefined);
    case "CF004":
      return new ConciliacionPilotoApagadoError();
    default:
      return err;
  }
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const fechaIso = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

interface SesionRaw {
  id: string;
  property_id: string;
  periodo: string;
  cuenta: string | null;
  estado: "abierta" | "cerrada";
  creada_por: string | null;
  creada_en: string | Date;
  cerrada_en: string | Date | null;
}
const SESION_COLS = "id, property_id, periodo, cuenta, estado, creada_por, creada_en, cerrada_en";
const mapSesion = (r: SesionRaw): SesionConciliacion => ({
  id: r.id,
  propertyId: r.property_id,
  periodo: r.periodo,
  cuenta: r.cuenta,
  estado: r.estado,
  creadaPor: r.creada_por,
  creadaEn: iso(r.creada_en),
  cerradaEn: r.cerrada_en === null ? null : iso(r.cerrada_en),
});

interface MatchRaw {
  id: string;
  sesion_id: string;
  movimiento_id: string;
  invoice_id: string;
  nivel: number | null;
  confianza: string | number | null;
  origen: "motor" | "llm_aprobado" | "manual" | "autopiloto";
  confirmado_por: string | null;
  confirmado_en: string | Date;
  deshecho_por: string | null;
  deshecho_en: string | Date | null;
  motivo_deshacer: string | null;
}
const MATCH_COLS = "id, sesion_id, movimiento_id, invoice_id, nivel, confianza, origen, confirmado_por, confirmado_en, deshecho_por, deshecho_en, motivo_deshacer";
const mapMatch = (r: MatchRaw): MatchConciliacion => ({
  id: r.id,
  sesionId: r.sesion_id,
  movimientoId: r.movimiento_id,
  invoiceId: r.invoice_id,
  nivel: r.nivel === null ? null : Number(r.nivel),
  confianza: num(r.confianza),
  origen: r.origen,
  confirmadoPor: r.confirmado_por,
  confirmadoEn: iso(r.confirmado_en),
  deshechoPor: r.deshecho_por,
  deshechoEn: r.deshecho_en === null ? null : iso(r.deshecho_en),
  motivoDeshacer: r.motivo_deshacer,
});

interface SugerenciaRaw {
  id: string;
  sesion_id: string;
  movimiento_id: string;
  invoice_id: string;
  confianza: string | number;
  razon: string;
  estado: "pendiente" | "aprobada" | "rechazada";
  match_id: string | null;
  creada_en: string | Date;
  resuelta_en: string | Date | null;
}
const SUG_COLS = "id, sesion_id, movimiento_id, invoice_id, confianza, razon, estado, match_id, creada_en, resuelta_en";
const mapSugerencia = (r: SugerenciaRaw): SugerenciaConciliacion => ({
  id: r.id,
  sesionId: r.sesion_id,
  movimientoId: r.movimiento_id,
  invoiceId: r.invoice_id,
  confianza: Number(r.confianza),
  razon: r.razon,
  estado: r.estado,
  matchId: r.match_id,
  creadaEn: iso(r.creada_en),
  resueltaEn: r.resuelta_en === null ? null : iso(r.resuelta_en),
});

export class PostgresConciliacionPersistidaRepository implements ConciliacionPersistidaRepository {
  constructor(private readonly db: TenantDbSession) {}

  private lectura<T>(nombre: string, vacio: T, primary: () => Promise<T>): Promise<LecturaConciliacion<T>> {
    return runWithSavepointFallback<LecturaConciliacion<T>>({
      session: this.db,
      savepointName: `sp_conc_${nombre}`,
      primary: async () => ({ estado: "disponible", datos: await primary() }),
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ estado: "no_disponible", datos: vacio }),
    });
  }

  private async escritura<T>(nombre: string, primary: () => Promise<T>): Promise<T> {
    try {
      return await runWithSavepointFallback<T>({
        session: this.db,
        savepointName: `sp_conc_${nombre}`,
        primary,
        isRecoverable: (err) => isMigrationPendingError(err, FN_PREFIX),
        fallback: async () => {
          throw new ConciliacionNoDisponibleError();
        },
      });
    } catch (err) {
      throw traducirErrorConciliacion(err);
    }
  }

  /** Lectura que, si la tabla no existe, lanza `ConciliacionNoDisponibleError` (para rutas que no pueden devolver "vacío": detalle de una sesión). */
  private async leerOFallar<T>(nombre: string, primary: () => Promise<T>): Promise<T> {
    const r = await this.lectura<T | undefined>(nombre, undefined, primary);
    if (r.estado === "no_disponible") throw new ConciliacionNoDisponibleError();
    return r.datos as T;
  }

  crearSesion(propertyId: string, periodo: string, cuenta: string | null): Promise<{ sesion: SesionConciliacion; movimientos: number }> {
    return this.escritura("crear", async () => {
      const { rows } = await this.db.query<{ out_sesion_id: string; out_movimientos: number }>("select out_sesion_id, out_movimientos from despachos.conciliacion_sesion_crear($1::uuid, $2, $3);", [propertyId, periodo, cuenta]);
      const fila = rows[0]!;
      const s = await this.db.query<SesionRaw>(`select ${SESION_COLS} from despachos.conciliacion_sesion where id = $1;`, [fila.out_sesion_id]);
      return { sesion: mapSesion(s.rows[0]!), movimientos: Number(fila.out_movimientos) };
    });
  }

  listarSesiones(propertyId: string, limit: number): Promise<LecturaConciliacion<readonly SesionConResumen[]>> {
    return this.lectura<readonly SesionConResumen[]>("listar", [], async () => {
      const { rows } = await this.db.query<SesionRaw & { total_movimientos: string; matches_vigentes: string; sugerencias_pendientes: string }>(
        `select s.id, s.property_id, s.periodo, s.cuenta, s.estado, s.creada_por, s.creada_en, s.cerrada_en,
                (select count(*) from despachos.estado_cuenta_movimiento mv where mv.property_id = s.property_id
                   and mv.fecha >= (s.periodo || '-01')::date and mv.fecha < ((s.periodo || '-01')::date + interval '1 month')
                   and (s.cuenta is null or mv.cuenta = s.cuenta))::text as total_movimientos,
                (select count(*) from despachos.conciliacion_match m where m.sesion_id = s.id and m.deshecho_en is null)::text as matches_vigentes,
                (select count(*) from despachos.conciliacion_sugerencia g where g.sesion_id = s.id and g.estado = 'pendiente')::text as sugerencias_pendientes
           from despachos.conciliacion_sesion s where s.property_id = $1 order by s.creada_en desc limit $2;`,
        [propertyId, limit],
      );
      return rows.map((r) => ({ ...mapSesion(r), totalMovimientos: Number(r.total_movimientos), matchesVigentes: Number(r.matches_vigentes), sugerenciasPendientes: Number(r.sugerencias_pendientes) }));
    });
  }

  obtenerSesion(propertyId: string, sesionId: string): Promise<LecturaConciliacion<SesionConciliacion | null>> {
    return this.lectura<SesionConciliacion | null>("obtener", null, async () => {
      const { rows } = await this.db.query<SesionRaw>(`select ${SESION_COLS} from despachos.conciliacion_sesion where property_id = $1 and id = $2;`, [propertyId, sesionId]);
      return rows[0] ? mapSesion(rows[0]) : null;
    });
  }

  listarMovimientosSesion(sesion: SesionConciliacion): Promise<readonly MovimientoGuardado[]> {
    return this.leerOFallar("movs", async () => {
      const { rows } = await this.db.query<{ id: string; hash: string; cuenta: string | null; fecha: string | Date; descripcion: string; referencia: string | null; cargo: string | null; abono: string | null; monto: string; saldo: string | null; banco: string; formato: string }>(
        `select id, hash, cuenta, fecha, descripcion, referencia, cargo, abono, monto, saldo, banco, formato
           from despachos.estado_cuenta_movimiento
          where property_id = $1 and fecha >= ($2 || '-01')::date and fecha < (($2 || '-01')::date + interval '1 month') and ($3::text is null or cuenta = $3)
          order by fecha, renglon, id limit 5000;`,
        [sesion.propertyId, sesion.periodo, sesion.cuenta],
      );
      return rows.map((r) => ({
        id: r.id,
        hash: r.hash,
        cuenta: r.cuenta,
        fecha: fechaIso(r.fecha),
        descripcion: r.descripcion,
        referencia: r.referencia,
        cargo: num(r.cargo),
        abono: num(r.abono),
        monto: Number(r.monto),
        saldo: num(r.saldo),
        banco: r.banco,
        formato: r.formato,
      }));
    });
  }

  listarMatches(sesionId: string): Promise<readonly MatchConciliacion[]> {
    return this.leerOFallar("matches", async () => {
      const { rows } = await this.db.query<MatchRaw>(`select ${MATCH_COLS} from despachos.conciliacion_match where sesion_id = $1 order by confirmado_en, id limit 5000;`, [sesionId]);
      return rows.map(mapMatch);
    });
  }

  async obtenerMatch(propertyId: string, matchId: string): Promise<MatchConciliacion | null> {
    return this.leerOFallar("match", async () => {
      const { rows } = await this.db.query<MatchRaw>(`select ${MATCH_COLS} from despachos.conciliacion_match where property_id = $1 and id = $2;`, [propertyId, matchId]);
      return rows[0] ? mapMatch(rows[0]) : null;
    });
  }

  listarSugerencias(sesionId: string): Promise<readonly SugerenciaConciliacion[]> {
    return this.leerOFallar("sugs", async () => {
      const { rows } = await this.db.query<SugerenciaRaw>(`select ${SUG_COLS} from despachos.conciliacion_sugerencia where sesion_id = $1 order by creada_en, id limit 2000;`, [sesionId]);
      return rows.map(mapSugerencia);
    });
  }

  obtenerSugerencia(propertyId: string, sugerenciaId: string): Promise<SugerenciaConciliacion | null> {
    return this.leerOFallar("sug", async () => {
      const { rows } = await this.db.query<SugerenciaRaw>(`select ${SUG_COLS} from despachos.conciliacion_sugerencia where property_id = $1 and id = $2;`, [propertyId, sugerenciaId]);
      return rows[0] ? mapSugerencia(rows[0]) : null;
    });
  }

  invoiceIdsConciliados(propertyId: string): Promise<LecturaConciliacion<ReadonlySet<string>>> {
    return this.lectura<ReadonlySet<string>>("conciliados", new Set(), async () => {
      const { rows } = await this.db.query<{ invoice_id: string }>("select invoice_id from despachos.invoice_conciliacion where property_id = $1;", [propertyId]);
      return new Set(rows.map((r) => r.invoice_id));
    });
  }

  confirmarMatches(_propertyId: string, sesionId: string, pares: readonly ParConfirmar[]): Promise<readonly MatchConciliacion[]> {
    return this.escritura("confirmar", async () => {
      const payload = pares.map((p) => ({ movimiento_id: p.movimientoId, invoice_id: p.invoiceId, nivel: p.nivel, confianza: p.confianza, origen: p.origen }));
      const { rows } = await this.db.query<{ out_match_id: string }>("select out_match_id from despachos.conciliacion_matches_confirmar($1::uuid, $2::jsonb);", [sesionId, JSON.stringify(payload)]);
      const ids = rows.map((r) => r.out_match_id);
      const m = await this.db.query<MatchRaw>(`select ${MATCH_COLS} from despachos.conciliacion_match where id = any($1::uuid[]) order by confirmado_en, id;`, [ids]);
      return m.rows.map(mapMatch);
    });
  }

  deshacerMatch(propertyId: string, matchId: string, motivo: string): Promise<{ yaDeshecho: boolean }> {
    return this.escritura("deshacer", async () => {
      const { rows } = await this.db.query<{ out_ya_deshecho: boolean }>("select out_ya_deshecho from despachos.conciliacion_match_deshacer($1::uuid, $2::uuid, $3);", [propertyId, matchId, motivo]);
      return { yaDeshecho: rows[0]?.out_ya_deshecho === true };
    });
  }

  cerrarSesion(propertyId: string, sesionId: string): Promise<{ yaCerrada: boolean }> {
    return this.escritura("cerrar", async () => {
      const { rows } = await this.db.query<{ out_ya_cerrada: boolean }>("select out_ya_cerrada from despachos.conciliacion_sesion_cerrar($1::uuid, $2::uuid);", [propertyId, sesionId]);
      return { yaCerrada: rows[0]?.out_ya_cerrada === true };
    });
  }

  guardarSugerencias(_propertyId: string, sesionId: string, sugerencias: readonly NuevaSugerencia[]): Promise<readonly SugerenciaConciliacion[]> {
    if (sugerencias.length === 0) return Promise.resolve([]);
    return this.escritura("sugerir", async () => {
      const payload = sugerencias.map((s) => ({ movimiento_id: s.movimientoId, invoice_id: s.invoiceId, confianza: s.confianza, razon: s.razon }));
      const { rows } = await this.db.query<{ out_sugerencia_id: string }>("select out_sugerencia_id from despachos.conciliacion_sugerencias_guardar($1::uuid, $2::jsonb);", [sesionId, JSON.stringify(payload)]);
      if (rows.length === 0) return [];
      const g = await this.db.query<SugerenciaRaw>(`select ${SUG_COLS} from despachos.conciliacion_sugerencia where id = any($1::uuid[]) order by creada_en, id;`, [rows.map((r) => r.out_sugerencia_id)]);
      return g.rows.map(mapSugerencia);
    });
  }

  resolverSugerencia(propertyId: string, sugerenciaId: string, aprobar: boolean): Promise<{ estado: "aprobada" | "rechazada"; matchId: string | null }> {
    return this.escritura("resolver", async () => {
      const { rows } = await this.db.query<{ out_estado: "aprobada" | "rechazada"; out_match_id: string | null }>(
        "select out_estado, out_match_id from despachos.conciliacion_sugerencia_resolver($1::uuid, $2::uuid, $3::boolean);",
        [propertyId, sugerenciaId, aprobar],
      );
      return { estado: rows[0]!.out_estado, matchId: rows[0]!.out_match_id };
    });
  }

  leerPropuestas(sesionId: string): Promise<LecturaConciliacion<PropuestasGuardadas | null>> {
    // Columna de la migración 025: contra la base sin migrar (42703) -> "no disponible" (la ruta calcula al vuelo, como antes).
    return this.lectura<PropuestasGuardadas | null>("propuestas", null, async () => {
      const { rows } = await this.db.query<{ propuestas: unknown }>("select propuestas from despachos.conciliacion_sesion where id = $1;", [sesionId]);
      return rows[0]?.propuestas == null ? null : leerPropuestasGuardadas(rows[0].propuestas);
    });
  }

  guardarPropuestas(propertyId: string, sesionId: string, propuestas: PropuestasGuardadas): Promise<void> {
    return this.escritura("propuestas_guardar", async () => {
      await this.db.query("select despachos.conciliacion_sesion_propuestas_guardar($1::uuid, $2::uuid, $3::jsonb);", [propertyId, sesionId, JSON.stringify(propuestas)]);
    });
  }

  asegurarSesion(propertyId: string, periodo: string, cuenta: string | null): Promise<{ sesion: SesionConciliacion; creada: boolean; movimientos: number }> {
    return this.escritura("asegurar", async () => {
      const { rows } = await this.db.query<{ out_sesion_id: string; out_creada: boolean; out_movimientos: number }>("select out_sesion_id, out_creada, out_movimientos from despachos.conciliacion_sesion_asegurar($1::uuid, $2, $3);", [propertyId, periodo, cuenta]);
      const fila = rows[0]!;
      const s = await this.db.query<SesionRaw>(`select ${SESION_COLS} from despachos.conciliacion_sesion where id = $1;`, [fila.out_sesion_id]);
      return { sesion: mapSesion(s.rows[0]!), creada: fila.out_creada === true, movimientos: Number(fila.out_movimientos) };
    });
  }

  async autoconfirmarNivel1Activo(propertyId: string): Promise<boolean> {
    const r = await this.lectura<boolean>("autoconfirmar_leer", false, async () => {
      const { rows } = await this.db.query<{ activo: boolean }>("select conciliacion_autoconfirmar_nivel1 as activo from despachos.property_config where property_id = $1;", [propertyId]);
      return rows[0]?.activo === true;
    });
    return r.datos;
  }

  configurarAutoconfirmarNivel1(propertyId: string, organizationId: string, activo: boolean): Promise<boolean> {
    // Misma tabla y policies que la zona horaria (012): solo el `admin` de la organización escribe; RLS rechaza al resto (0 filas / 42501).
    return this.escritura("autoconfirmar_escribir", async () => {
      const { rows } = await this.db.query<{ property_id: string }>(
        `insert into despachos.property_config (property_id, organization_id, conciliacion_autoconfirmar_nivel1) values ($1::uuid, $2::uuid, $3::boolean)
         on conflict (property_id) do update set conciliacion_autoconfirmar_nivel1 = excluded.conciliacion_autoconfirmar_nivel1, updated_at = now()
         returning property_id;`,
        [propertyId, organizationId, activo],
      );
      return rows.length === 1;
    });
  }

  confirmarAutopiloto(_propertyId: string, sesionId: string, pares: readonly ParAutopiloto[]): Promise<readonly MatchConciliacion[]> {
    if (pares.length === 0) return Promise.resolve([]);
    return this.escritura("autopiloto", async () => {
      const payload = pares.map((p) => ({ movimiento_id: p.movimientoId, invoice_id: p.invoiceId, confianza: p.confianza }));
      const { rows } = await this.db.query<{ out_match_id: string }>("select out_match_id from despachos.conciliacion_autopiloto_confirmar($1::uuid, $2::jsonb);", [sesionId, JSON.stringify(payload)]);
      const m = await this.db.query<MatchRaw>(`select ${MATCH_COLS} from despachos.conciliacion_match where id = any($1::uuid[]) order by confirmado_en, id;`, [rows.map((r) => r.out_match_id)]);
      return m.rows.map(mapMatch);
    });
  }
}
