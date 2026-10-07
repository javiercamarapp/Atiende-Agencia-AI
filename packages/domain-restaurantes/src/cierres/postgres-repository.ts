// Adaptador Postgres de `CierreRepository` (migracion 041). REGLA DURA de compatibilidad con la base SIN migrar: mergear despliega el
// codigo al instante y la 041 no se aplica sola. Toda llamada corre dentro de la transaccion UNICA del request (`withAppSession`): un
// error de Postgres la deja abortada (25P02), por eso usa `runWithSavepointFallback` y degrada a "no disponible" (42883 funcion
// inexistente, 42P01 tabla, 42703 columna). Cualquier otro error se repropaga.
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { leerCierreDatos } from "./cierre.ts";
import type { CierreLectura, CierreReporte, CierreRepository, CierreSucursal, CierreTipo, GenerarCierreResultado } from "./cierre.ts";

function esBaseSinMigrar(err: unknown): boolean {
  const c = err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
  return c === "42P01" || c === "42703" || c === "42883";
}

/** `generar_cierre` rechaza (22023) un periodo que aun no termina en el dia de negocio: un estado esperado, no un fallo (QA R2 automatizacion-08). */
function esPeriodoAbierto(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return Boolean(e) && e!.code === "22023" && typeof e!.message === "string" && e!.message.includes("aun no termina");
}

let advertido = false;
function advertirNoDisponible(err: unknown): void {
  if (advertido) return;
  advertido = true;
  console.warn(
    "PostgresCierreRepository: la tabla/funcion de cierres todavia no existe en esta base (SQLSTATE 42P01/42703/42883) -- " +
      "aplica packages/domain-restaurantes/migrations/041_cierre_dia_resumen_semanal.sql (o su espejo en supabase/migrations/).",
    err,
  );
}

interface FilaCierre {
  id: string;
  tipo: CierreTipo;
  fecha_inicio: string;
  fecha_fin: string;
  zona_horaria: string;
  datos: unknown;
  generado_por: "sistema" | "staff";
  generado_at: string | Date;
}

function mapFila(r: FilaCierre): CierreReporte {
  return {
    id: r.id,
    tipo: r.tipo,
    fechaInicio: r.fecha_inicio,
    fechaFin: r.fecha_fin,
    zonaHoraria: r.zona_horaria,
    generadoPor: r.generado_por,
    generadoAt: r.generado_at instanceof Date ? r.generado_at.toISOString() : String(r.generado_at),
    datos: leerCierreDatos(typeof r.datos === "string" ? JSON.parse(r.datos) : r.datos),
  };
}

export class PostgresCierreRepository implements CierreRepository {
  constructor(private readonly db: TenantDbSession) {}

  async listar(organizationId: string, propertyId: string, tipo: CierreTipo, limite: number): Promise<CierreLectura<readonly CierreReporte[]>> {
    return runWithSavepointFallback<CierreLectura<readonly CierreReporte[]>>({
      session: this.db,
      savepointName: "sp_cierre_listar",
      primary: async () => {
        const { rows } = await this.db.query<FilaCierre>(
          `select id, tipo, to_char(fecha_inicio, 'YYYY-MM-DD') as fecha_inicio, to_char(fecha_fin, 'YYYY-MM-DD') as fecha_fin,
                  zona_horaria, datos, generado_por, generado_at
             from restaurantes.cierre_reporte
            where organization_id = $1 and property_id = $2 and tipo = $3
            order by fecha_inicio desc
            limit $4;`,
          [organizationId, propertyId, tipo, limite],
        );
        return { disponible: true, valor: rows.map(mapFila) };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async (err) => {
        advertirNoDisponible(err);
        return { disponible: false, valor: [] };
      },
    });
  }

  async generar(
    organizationId: string,
    propertyId: string,
    tipo: CierreTipo,
    fechaInicio: string,
    opciones: { readonly omitirSinActividad?: boolean } = {},
  ): Promise<GenerarCierreResultado> {
    return runWithSavepointFallback<GenerarCierreResultado>({
      session: this.db,
      savepointName: "sp_cierre_generar",
      primary: async () => {
        const { rows } = await this.db.query<FilaCierre & { creado: boolean }>(
          `select creado, id, tipo, to_char(fecha_inicio, 'YYYY-MM-DD') as fecha_inicio, to_char(fecha_fin, 'YYYY-MM-DD') as fecha_fin,
                  zona_horaria, datos, generado_por, generado_at
             from restaurantes.generar_cierre($1, $2, $3, $4::date, $5);`,
          [organizationId, propertyId, tipo, fechaInicio, opciones.omitirSinActividad === true],
        );
        const fila = rows[0];
        if (!fila || fila.id === null) return { estado: "sin_actividad" };
        return { estado: fila.creado ? "creado" : "existente", reporte: mapFila(fila) };
      },
      isRecoverable: (err) => esBaseSinMigrar(err) || esPeriodoAbierto(err),
      fallback: async (err) => {
        if (esPeriodoAbierto(err)) return { estado: "periodo_abierto" };
        advertirNoDisponible(err);
        return { estado: "no_disponible" };
      },
    });
  }

  async sucursalesParaBarrido(): Promise<CierreLectura<readonly CierreSucursal[]>> {
    return runWithSavepointFallback<CierreLectura<readonly CierreSucursal[]>>({
      session: this.db,
      savepointName: "sp_cierre_sucursales",
      primary: async () => {
        const { rows } = await this.db.query<{ organization_id: string; property_id: string; zona_horaria: string }>(
          "select organization_id, property_id, zona_horaria from restaurantes.cierre_sucursales_sistema();",
        );
        return { disponible: true, valor: rows.map((r) => ({ organizationId: r.organization_id, propertyId: r.property_id, zonaHoraria: r.zona_horaria })) };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async (err) => {
        advertirNoDisponible(err);
        return { disponible: false, valor: [] };
      },
    });
  }
}
