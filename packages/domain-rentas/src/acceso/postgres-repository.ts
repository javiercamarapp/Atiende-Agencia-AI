// Rn-04 -- adaptador Postgres del puerto de acceso, sobre el TenantDbSession del request
// (staff, RLS real) o de la sesión de sistema del cron (auth.uid() NULL).
//
// Base sin migrar (migración 025 pendiente: SQLSTATE 42883/42P01/42703): las operaciones
// de STAFF devuelven `disponible: false` (la ruta responde "aún no disponible", nunca un
// 500). Como la sesión es UNA transacción por request y Postgres la deja ABORTADA tras el
// error (25P02), esa degradación corre bajo SAVEPOINT (runWithSavepointFallback). Las
// operaciones de SISTEMA no degradan aquí: dejan subir el error y el cron (una
// transacción por reserva, ver ./liberacion.ts) decide.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { RentasAccesoRepository } from "./repository.ts";
import type { EventoAccesoRecord, EventoBitacoraAcceso, EventoOmitidoAcceso, InstruccionAcceso, LiberacionPendiente, PoliticaAcceso, ResultadoAcceso, ResultadoConfirmarPago } from "./tipos.ts";
import type { EntradaInstruccion, EntradaPolitica } from "./validacion.ts";

interface PoliticaRow {
  property_id: string;
  activo: boolean;
  horas_antes_checkin: number;
  hora_checkin: string;
  exigir_pago: boolean;
  ota_cuenta_como_pagada: boolean;
}

const COLUMNAS_POLITICA = `property_id, activo, horas_antes_checkin, to_char(hora_checkin, 'HH24:MI') as hora_checkin, exigir_pago, ota_cuenta_como_pagada`;

const aPolitica = (r: PoliticaRow): PoliticaAcceso => ({
  propertyId: r.property_id,
  activo: r.activo,
  horasAntesCheckin: r.horas_antes_checkin,
  horaCheckin: r.hora_checkin,
  exigirPago: r.exigir_pago,
  otaCuentaComoPagada: r.ota_cuenta_como_pagada,
});

function codigoPg(err: unknown): string | undefined {
  return typeof err === "object" && err !== null ? (err as { code?: string }).code : undefined;
}

export class PostgresRentasAccesoRepository implements RentasAccesoRepository {
  constructor(private readonly db: TenantDbSession) {}

  private async conDegradacion<T>(nombre: string, primary: () => Promise<T>): Promise<ResultadoAcceso<T>> {
    return runWithSavepointFallback<ResultadoAcceso<T>>({
      session: this.db,
      savepointName: `sp_acceso_${nombre}`,
      primary: async () => ({ disponible: true, valor: await primary() }),
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ disponible: false }),
    });
  }

  obtenerPolitica(propertyId: string): Promise<ResultadoAcceso<PoliticaAcceso | null>> {
    return this.conDegradacion("politica_leer", async () => {
      const { rows } = await this.db.query<PoliticaRow>(`select ${COLUMNAS_POLITICA} from rentas.acceso_politica where property_id = $1;`, [propertyId]);
      return rows[0] ? aPolitica(rows[0]) : null;
    });
  }

  guardarPolitica(organizationId: string, propertyId: string, e: EntradaPolitica, actorId: string): Promise<ResultadoAcceso<PoliticaAcceso>> {
    return this.conDegradacion("politica_guardar", async () => {
      const { rows } = await this.db.query<PoliticaRow>(
        `insert into rentas.acceso_politica (property_id, organization_id, activo, horas_antes_checkin, hora_checkin, exigir_pago, ota_cuenta_como_pagada, updated_by)
         values ($1, $2, $3, $4, $5::time, $6, $7, $8)
         on conflict (property_id) do update set
           activo = excluded.activo, horas_antes_checkin = excluded.horas_antes_checkin, hora_checkin = excluded.hora_checkin,
           exigir_pago = excluded.exigir_pago, ota_cuenta_como_pagada = excluded.ota_cuenta_como_pagada, updated_at = now(), updated_by = excluded.updated_by
         returning ${COLUMNAS_POLITICA};`,
        [propertyId, organizationId, e.activo, e.horasAntesCheckin, e.horaCheckin, e.exigirPago, e.otaCuentaComoPagada, actorId],
      );
      return aPolitica(rows[0]!);
    });
  }

  obtenerInstruccion(propertyId: string, unidadId: string): Promise<ResultadoAcceso<InstruccionAcceso | null>> {
    return this.conDegradacion("instruccion_leer", async () => {
      const { rows } = await this.db.query<{ unidad_id: string; direccion_exacta: string; codigo_acceso: string | null; instrucciones: string | null }>(
        `select unidad_id, direccion_exacta, codigo_acceso, instrucciones from rentas.acceso_instruccion where property_id = $1 and unidad_id = $2;`,
        [propertyId, unidadId],
      );
      const r = rows[0];
      return r ? { unidadId: r.unidad_id, direccionExacta: r.direccion_exacta, codigoAcceso: r.codigo_acceso, instrucciones: r.instrucciones } : null;
    });
  }

  guardarInstruccion(organizationId: string, propertyId: string, unidadId: string, e: EntradaInstruccion, actorId: string): Promise<ResultadoAcceso<InstruccionAcceso | null>> {
    return this.conDegradacion("instruccion_guardar", async () => {
      const unidad = await this.db.query(`select 1 from rentas.unidad where id = $1 and property_id = $2;`, [unidadId, propertyId]);
      if (unidad.rows.length === 0) return null;
      await this.db.query(
        `insert into rentas.acceso_instruccion (unidad_id, organization_id, property_id, direccion_exacta, codigo_acceso, instrucciones, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (unidad_id) do update set
           direccion_exacta = excluded.direccion_exacta, codigo_acceso = excluded.codigo_acceso, instrucciones = excluded.instrucciones, updated_at = now(), updated_by = excluded.updated_by;`,
        [unidadId, organizationId, propertyId, e.direccionExacta, e.codigoAcceso, e.instrucciones, actorId],
      );
      return { unidadId, direccionExacta: e.direccionExacta, codigoAcceso: e.codigoAcceso, instrucciones: e.instrucciones };
    });
  }

  async confirmarPago(ocupacionId: string, confirmado: boolean): Promise<ResultadoConfirmarPago> {
    return runWithSavepointFallback<ResultadoConfirmarPago>({
      session: this.db,
      savepointName: "sp_acceso_confirmar_pago",
      primary: async () => {
        await this.db.query(`select rentas.confirmar_pago_reserva($1::uuid, $2::boolean);`, [ocupacionId, confirmado]);
        return confirmado ? "confirmado" : "revocado";
      },
      // P0002 = la reserva no existe o no es de esta property/rol (la función no distingue).
      isRecoverable: (err) => isMigrationPendingError(err) || codigoPg(err) === "P0002",
      fallback: async (err) => (codigoPg(err) === "P0002" ? "no_encontrada" : "no_disponible"),
    });
  }

  listarBitacora(propertyId: string, limite: number): Promise<ResultadoAcceso<readonly EventoAccesoRecord[]>> {
    return this.conDegradacion("bitacora", async () => {
      const { rows } = await this.db.query<{ id: string; ocupacion_id: string; evento: EventoBitacoraAcceso; canal: string | null; creado_en: string }>(
        `select id, ocupacion_id, evento, canal, creado_en::text from rentas.acceso_bitacora where property_id = $1 order by creado_en desc, id desc limit $2;`,
        [propertyId, limite],
      );
      return rows.map((r) => ({ id: r.id, ocupacionId: r.ocupacion_id, evento: r.evento, canal: r.canal, creadoEn: r.creado_en }));
    });
  }

  async siguienteLiberacion(excluir: readonly string[]): Promise<LiberacionPendiente | null> {
    const { rows } = await this.db.query<{
      ocupacion_id: string;
      organization_id: string;
      property_id: string;
      check_in: string;
      check_out: string;
      unidad_nombre: string;
      tenant_nombre: string;
      huesped_nombre: string | null;
      huesped_contacto: string | null;
      tiene_instrucciones: boolean;
      direccion_exacta: string | null;
      codigo_acceso: string | null;
      instrucciones: string | null;
    }>(
      `select ocupacion_id, organization_id, property_id, to_char(check_in, 'YYYY-MM-DD') as check_in, to_char(check_out, 'YYYY-MM-DD') as check_out,
              unidad_nombre, tenant_nombre, huesped_nombre, huesped_contacto, tiene_instrucciones, direccion_exacta, codigo_acceso, instrucciones
       from rentas.acceso_siguiente_liberacion($1::uuid[], now());`,
      [excluir],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      ocupacionId: r.ocupacion_id,
      organizationId: r.organization_id,
      propertyId: r.property_id,
      checkIn: r.check_in,
      checkOut: r.check_out,
      unidadNombre: r.unidad_nombre,
      tenantNombre: r.tenant_nombre,
      huespedNombre: r.huesped_nombre,
      huespedContacto: r.huesped_contacto,
      tieneInstrucciones: r.tiene_instrucciones,
      direccionExacta: r.direccion_exacta,
      codigoAcceso: r.codigo_acceso,
      instrucciones: r.instrucciones,
    };
  }

  async marcarLiberada(ocupacionId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ nueva: boolean }>(`select rentas.acceso_marcar_liberada($1::uuid, 'email') as nueva;`, [ocupacionId]);
    return rows[0]?.nueva === true;
  }

  async registrarEvento(ocupacionId: string, evento: EventoOmitidoAcceso): Promise<boolean> {
    const { rows } = await this.db.query<{ nuevo: boolean }>(`select rentas.acceso_registrar_evento($1::uuid, $2, $3) as nuevo;`, [ocupacionId, evento, evento === "error_envio" ? "email" : null]);
    return rows[0]?.nuevo === true;
  }
}
