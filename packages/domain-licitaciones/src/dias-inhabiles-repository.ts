// L-22 -- almacenamiento de los dias inhabiles que declara cada organizacion o convocatoria
// (tabla/funcion de la migracion 032). Modulo APARTE de `repository.ts`/`postgres-repository.ts`
// (mismo criterio que `kyc-69b-repository.ts`: archivos compartidos por varias ramas en paralelo).
//
// REGLA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: la API se despliega antes que la migracion 032.
// Cada operacion corre dentro de `runWithSavepointFallback` (SAVEPOINT / ROLLBACK TO SAVEPOINT)
// porque la sesion del request es UNA transaccion: un 42P01/42703/42883 sin savepoint la dejaria
// abortada (25P02) y el COMMIT revertiria todo en silencio. Las lecturas que alimentan un CALCULO
// DE PLAZO (`resolveCalendario`) NUNCA fallan por base sin migrar: caen al calendario oficial de
// plataforma, de modo que el pago y la inconformidad siguen calculandose (con los dias oficiales)
// aunque aun no exista la tabla. Listar y escribir lanzan `DiaInhabilNotAvailableError` y el
// llamador responde "no disponible aun" (lecturas) o 503 (escrituras). Nunca un 500.
import { randomUUID } from "node:crypto";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import {
  DiaInhabilDuplicateError,
  DiaInhabilNotAvailableError,
  buildCalendarioPlazos,
  isValidDateOnly,
  officialOnlyCalendar,
} from "./dias-inhabiles.ts";
import type { CalendarioPlazos, DiaInhabil, DiaInhabilCreateInput, DiaInhabilRecord, DiaInhabilVerificacion } from "./dias-inhabiles.ts";

export interface DiasInhabilesRepository {
  /** Dias VIGENTES de la organizacion: los de todas sus convocatorias y, si se pide `tenderId`, ademas los de esa convocatoria. Sin `tenderId` devuelve todos los de la organizacion. Lanza `DiaInhabilNotAvailableError` sin migracion. */
  list(organizationId: string, tenderId?: string | null): Promise<readonly DiaInhabilRecord[]>;
  /** Declara un dia inhabil. 23505 -> `DiaInhabilDuplicateError`; sin migracion -> `DiaInhabilNotAvailableError`. */
  create(organizationId: string, actorId: string, input: DiaInhabilCreateInput): Promise<DiaInhabilRecord>;
  /** Quita (soft delete) un dia vigente. `false` si no existe, no es de la organizacion o ya estaba quitado. */
  remove(organizationId: string, id: string): Promise<boolean>;
  /**
   * Calendario EFECTIVO para calcular un plazo: oficiales de plataforma + dias de la organizacion
   * + (si `tenderId`) los de esa convocatoria. NUNCA lanza por base sin migrar: cae al calendario
   * oficial. `sistema: true` para los barridos de cron (sin `auth.uid()`): usa la funcion de
   * solo-sistema en vez de la RLS.
   */
  resolveCalendario(organizationId: string, options?: { readonly tenderId?: string | null; readonly sistema?: boolean }): Promise<CalendarioPlazos>;
}

interface DiaRow {
  id: string;
  tender_id: string | null;
  fecha: string;
  nombre: string;
  publicado_por: string | null;
  fuente: string | null;
  verificacion: string;
  created_by: string;
  created_at: string;
}

const COLUMNS = "id, tender_id, fecha::text as fecha, nombre, publicado_por, fuente, verificacion, created_by, created_at::text as created_at";

function asVerificacion(value: string): DiaInhabilVerificacion {
  return value === "verificada" ? "verificada" : "por_validar";
}

function mapRow(r: DiaRow): DiaInhabilRecord {
  return {
    id: r.id,
    fecha: r.fecha.slice(0, 10),
    nombre: r.nombre,
    alcance: r.tender_id ? "convocatoria" : "organizacion",
    tenderId: r.tender_id,
    publicadoPor: r.publicado_por,
    fuente: r.fuente,
    verificacion: asVerificacion(r.verificacion),
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

export class PostgresDiasInhabilesRepository implements DiasInhabilesRepository {
  constructor(private readonly db: TenantDbSession) {}

  private guarded<T>(primary: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback<T>({
      session: this.db,
      primary,
      isRecoverable: isMigrationPendingError,
      fallback: async () => {
        throw new DiaInhabilNotAvailableError();
      },
    });
  }

  async list(organizationId: string, tenderId?: string | null): Promise<readonly DiaInhabilRecord[]> {
    return this.guarded(async () => {
      const { rows } =
        tenderId === undefined
          ? await this.db.query<DiaRow>(`select ${COLUMNS} from licitaciones.dia_inhabil where organization_id = $1 and eliminado_en is null order by fecha, created_at;`, [organizationId])
          : await this.db.query<DiaRow>(
              `select ${COLUMNS} from licitaciones.dia_inhabil where organization_id = $1 and eliminado_en is null and (tender_id is null or tender_id = $2) order by fecha, created_at;`,
              [organizationId, tenderId],
            );
      return rows.map(mapRow);
    });
  }

  async create(organizationId: string, actorId: string, input: DiaInhabilCreateInput): Promise<DiaInhabilRecord> {
    try {
      return await this.guarded(async () => {
        const { rows } = await this.db.query<DiaRow>(
          `insert into licitaciones.dia_inhabil (organization_id, tender_id, fecha, nombre, publicado_por, fuente, verificacion, created_by)
           values ($1, $2, $3::date, $4, $5, $6, $7, $8)
           returning ${COLUMNS};`,
          [organizationId, input.tenderId, input.fecha, input.nombre, input.publicadoPor, input.fuente, input.verificacion, actorId],
        );
        return mapRow(rows[0]!);
      });
    } catch (err) {
      // 23505 = ya hay un dia vigente para esa fecha y alcance. `guarded` ya recupero la sesion.
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") throw new DiaInhabilDuplicateError();
      throw err;
    }
  }

  async remove(organizationId: string, id: string): Promise<boolean> {
    return this.guarded(async () => {
      // Soft delete: el trigger `dia_inhabil_sello` fija `eliminado_en`/`eliminado_por`; aqui solo se
      // toca la unica columna con GRANT de UPDATE.
      const { rows } = await this.db.query<{ id: string }>(
        `update licitaciones.dia_inhabil set eliminado_en = now() where organization_id = $1 and id = $2 and eliminado_en is null returning id;`,
        [organizationId, id],
      );
      return rows.length > 0;
    });
  }

  async resolveCalendario(organizationId: string, options: { readonly tenderId?: string | null; readonly sistema?: boolean } = {}): Promise<CalendarioPlazos> {
    const tenderId = options.tenderId ?? null;
    return runWithSavepointFallback<CalendarioPlazos>({
      session: this.db,
      primary: async () => {
        let declarados: DiaInhabil[];
        if (options.sistema) {
          const { rows } = await this.db.query<{ out_fecha: string; out_tender_id: string | null; out_nombre: string; out_publicado_por: string | null; out_fuente: string | null; out_verificacion: string }>(
            `select * from licitaciones.system_list_dias_inhabiles($1::uuid);`,
            [organizationId],
          );
          declarados = rows.map((r) => ({
            fecha: r.out_fecha.slice(0, 10),
            nombre: r.out_nombre,
            alcance: r.out_tender_id ? "convocatoria" : "organizacion",
            tenderId: r.out_tender_id,
            publicadoPor: r.out_publicado_por,
            fuente: r.out_fuente,
            verificacion: asVerificacion(r.out_verificacion),
          }));
        } else {
          const { rows } = await this.db.query<DiaRow>(
            `select ${COLUMNS} from licitaciones.dia_inhabil where organization_id = $1 and eliminado_en is null and (tender_id is null or tender_id = $2::uuid);`,
            [organizationId, tenderId],
          );
          declarados = rows.map(mapRow);
        }
        return buildCalendarioPlazos({ declarados, tenderId });
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => officialOnlyCalendar(),
    });
  }
}

/** En memoria (pruebas y desarrollo sin base): misma semantica que la base (unicidad vigente, soft delete). */
export class InMemoryDiasInhabilesRepository implements DiasInhabilesRepository {
  private readonly rows: { organizationId: string; record: DiaInhabilRecord; removed: boolean }[] = [];

  async list(organizationId: string, tenderId?: string | null): Promise<readonly DiaInhabilRecord[]> {
    return this.rows
      .filter((r) => r.organizationId === organizationId && !r.removed && (tenderId === undefined || r.record.tenderId === null || r.record.tenderId === tenderId))
      .map((r) => r.record)
      .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.createdAt.localeCompare(b.createdAt));
  }

  async create(organizationId: string, actorId: string, input: DiaInhabilCreateInput): Promise<DiaInhabilRecord> {
    if (!isValidDateOnly(input.fecha)) throw new Error("fecha invalida");
    const dup = this.rows.some((r) => r.organizationId === organizationId && !r.removed && r.record.fecha === input.fecha && r.record.tenderId === input.tenderId);
    if (dup) throw new DiaInhabilDuplicateError();
    const record: DiaInhabilRecord = {
      id: randomUUID(),
      fecha: input.fecha,
      nombre: input.nombre,
      alcance: input.tenderId ? "convocatoria" : "organizacion",
      tenderId: input.tenderId,
      publicadoPor: input.publicadoPor,
      fuente: input.fuente,
      verificacion: input.verificacion,
      createdBy: actorId,
      createdAt: new Date().toISOString(),
    };
    this.rows.push({ organizationId, record, removed: false });
    return record;
  }

  async remove(organizationId: string, id: string): Promise<boolean> {
    const row = this.rows.find((r) => r.organizationId === organizationId && r.record.id === id && !r.removed);
    if (!row) return false;
    row.removed = true;
    return true;
  }

  async resolveCalendario(organizationId: string, options: { readonly tenderId?: string | null; readonly sistema?: boolean } = {}): Promise<CalendarioPlazos> {
    const declarados = await this.list(organizationId, options.tenderId ?? null);
    return buildCalendarioPlazos({ declarados, tenderId: options.tenderId ?? null });
  }
}
