// D-11 -- adaptador Postgres de la cola de cobranza (migracion 017). La sesion es UNA transaccion compartida
// por request: cada operacion corre bajo `runWithSavepointFallback`, asi que contra la base SIN migrar el
// 42883/42P01/42703 degrada a `{ disponible: false }` sin dejar la transaccion abortada (25P02). Los demas
// SQLSTATE de las funciones de la migracion se traducen a errores de dominio tipados (sin filtrar mensajes de
// Postgres al cliente).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import {
  ColaCuotaExcedidaError,
  ColaEntradaInvalidaError,
  ColaEstadoInvalidoError,
  ColaNoEncontradaError,
  ColaSinAccesoError,
  ColaSinConsentimientoError,
} from "./types.ts";
import type {
  ColaCobranzaRepository,
  ColaDisponible,
  ConsentimientoWhatsApp,
  EncolarWhatsAppInput,
  FijarConsentimientoInput,
  FiltroGestiones,
  GestionCobranza,
  GestionEstado,
  GestionEstadoResolucion,
  GestionTipo,
  MensajeOutboxWhatsApp,
  NuevaGestionInput,
  OutboxWhatsAppEstado,
} from "./types.ts";

const FN_PREFIX = "cobranza_";
const MAX_FILAS = 500;

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** SQLSTATE de la migracion 017 -> error de dominio. Lo desconocido se relanza tal cual. */
function traducirError(err: unknown): unknown {
  switch (pgCode(err)) {
    case "P0002":
      return new ColaNoEncontradaError();
    case "42501":
      return new ColaSinAccesoError();
    case "54000":
      return new ColaCuotaExcedidaError();
    case "55000":
      return new ColaEstadoInvalidoError();
    case "CB001":
      return new ColaSinConsentimientoError();
    case "22023":
    case "23514":
    case "23503":
    case "23505":
      return new ColaEntradaInvalidaError();
    default:
      return err;
  }
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

interface GestionRow {
  id: string;
  receivable_id: string;
  tipo: GestionTipo;
  estado: GestionEstado;
  monto_promesa_centavos: string | number | null;
  fecha_promesa: string | null;
  fecha_seguimiento: string | null;
  nota: string | null;
  creado_en: string | Date;
  actualizado_en: string | Date;
}

export class PostgresColaCobranzaRepository implements ColaCobranzaRepository {
  constructor(private readonly db: TenantDbSession) {}

  private async ejecutar<T>(savepointName: string, fn: () => Promise<T>): Promise<ColaDisponible<T>> {
    try {
      return await runWithSavepointFallback<ColaDisponible<T>>({
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

  listarGestiones(propertyId: string, filtro: FiltroGestiones = {}) {
    return this.ejecutar("sp_cola_gestiones_listar", async () => {
      const { rows } = await this.db.query<GestionRow>(
        `select id, receivable_id, tipo, estado, monto_promesa_centavos,
                to_char(fecha_promesa, 'YYYY-MM-DD') as fecha_promesa,
                to_char(fecha_seguimiento, 'YYYY-MM-DD') as fecha_seguimiento,
                nota, creado_en, actualizado_en
           from despachos.cobranza_gestion
          where property_id = $1
            and ($2::uuid is null or receivable_id = $2::uuid)
            and ($3::text is null or estado = $3::text)
          order by creado_en desc, id
          limit ${MAX_FILAS};`,
        [propertyId, filtro.receivableId ?? null, filtro.estado ?? null],
      );
      return rows.map(
        (r): GestionCobranza => ({
          id: r.id,
          receivableId: r.receivable_id,
          tipo: r.tipo,
          estado: r.estado,
          montoPromesaCentavos: r.monto_promesa_centavos === null ? null : Number(r.monto_promesa_centavos),
          fechaPromesa: r.fecha_promesa,
          fechaSeguimiento: r.fecha_seguimiento,
          nota: r.nota,
          creadoEn: iso(r.creado_en),
          actualizadoEn: iso(r.actualizado_en),
        }),
      );
    });
  }

  crearGestion(input: NuevaGestionInput) {
    return this.ejecutar("sp_cola_gestion_crear", async () => {
      const { rows } = await this.db.query<{ id: string }>("select despachos.cobranza_gestion_crear($1, $2, $3, $4, $5::bigint, $6::date, $7::date) as id;", [
        input.propertyId,
        input.receivableId,
        input.tipo,
        input.nota,
        input.montoPromesaCentavos,
        input.fechaPromesa,
        input.fechaSeguimiento,
      ]);
      return { id: rows[0]!.id };
    });
  }

  resolverGestion(propertyId: string, gestionId: string, estado: GestionEstadoResolucion, nota: string | null) {
    return this.ejecutar("sp_cola_gestion_resolver", async () => {
      await this.db.query("select despachos.cobranza_gestion_resolver($1, $2, $3, $4);", [propertyId, gestionId, estado, nota]);
      return true as const;
    });
  }

  listarConsentimientos(propertyId: string) {
    return this.ejecutar("sp_cola_consent_listar", async () => {
      const { rows } = await this.db.query<{ rfc_receptor: string; telefono: string; estado: ConsentimientoWhatsApp["estado"]; evidencia: string | null; actualizado_en: string | Date }>(
        `select rfc_receptor, telefono, estado, evidencia, actualizado_en
           from despachos.cobranza_whatsapp_consentimiento
          where property_id = $1
          order by rfc_receptor
          limit ${MAX_FILAS};`,
        [propertyId],
      );
      return rows.map((r): ConsentimientoWhatsApp => ({ rfcReceptor: r.rfc_receptor, telefono: r.telefono, estado: r.estado, evidencia: r.evidencia, actualizadoEn: iso(r.actualizado_en) }));
    });
  }

  fijarConsentimiento(input: FijarConsentimientoInput) {
    return this.ejecutar("sp_cola_consent_fijar", async () => {
      await this.db.query("select despachos.cobranza_whatsapp_consentimiento_fijar($1, $2, $3, $4, $5);", [input.propertyId, input.rfcReceptor, input.telefono, input.estado, input.evidencia]);
      return true as const;
    });
  }

  encolarWhatsApp(input: EncolarWhatsAppInput) {
    return this.ejecutar("sp_cola_wa_encolar", async () => {
      const { rows } = await this.db.query<{ out_id: string; out_duplicado: boolean }>("select out_id, out_duplicado from despachos.cobranza_whatsapp_encolar($1, $2, $3, $4);", [
        input.propertyId,
        input.receivableId,
        input.cuerpo,
        input.dedupeKey,
      ]);
      const r = rows[0];
      if (!r) throw new ColaNoEncontradaError();
      return { id: r.out_id, duplicado: r.out_duplicado };
    });
  }

  listarOutbox(propertyId: string) {
    return this.ejecutar("sp_cola_outbox_listar", async () => {
      // Sin `telefono`: la migracion no concede esa columna al staff.
      const { rows } = await this.db.query<{ id: string; receivable_id: string; rfc_receptor: string; cuerpo: string; estado: OutboxWhatsAppEstado; creado_en: string | Date }>(
        `select id, receivable_id, rfc_receptor, cuerpo, estado, creado_en
           from despachos.cobranza_whatsapp_outbox
          where property_id = $1
          order by creado_en desc, id
          limit ${MAX_FILAS};`,
        [propertyId],
      );
      return rows.map((r): MensajeOutboxWhatsApp => ({ id: r.id, receivableId: r.receivable_id, rfcReceptor: r.rfc_receptor, cuerpo: r.cuerpo, estado: r.estado, creadoEn: iso(r.creado_en) }));
    });
  }
}
