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
import { emitirNotificacion, isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { accesoAad } from "./cipher.ts";
import type { AccesoCipher, CampoAcceso } from "./cipher.ts";
import { AccesoDescifradoError, AccesoNoDisponibleError } from "./errores.ts";
import type { RentasAccesoRepository } from "./repository.ts";
import type { ErrorAccesoLiberacion, EventoAccesoRecord, ReservaAccesoRecord, EventoBitacoraAcceso, EventoOmitidoAcceso, InstruccionAcceso, LiberacionPendiente, PendienteEntregaOta, PoliticaAcceso, ReservaParaMensajeOta, ResultadoAcceso, ResultadoConfirmarPago, ResultadoEntregaManual, ResumenBarridoCifrado } from "./tipos.ts";
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

interface LiberacionLegadoRow {
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
}

interface LiberacionCifradaRow extends LiberacionLegadoRow {
  unidad_id: string;
  direccion_cifrada: string | null;
  codigo_cifrado: string | null;
  instrucciones_cifradas: string | null;
  key_version: number | null;
}

function codigoPg(err: unknown): string | undefined {
  return typeof err === "object" && err !== null ? (err as { code?: string }).code : undefined;
}

interface InstruccionRow {
  unidad_id: string;
  property_id: string;
  direccion_exacta: string | null;
  codigo_acceso: string | null;
  instrucciones: string | null;
  direccion_cifrada: string | null;
  codigo_cifrado: string | null;
  instrucciones_cifradas: string | null;
}

/** `cipher` es `null` cuando RENTAS_ACCESS_KEY no esta configurada (o `errorLlave` explica por que): las operaciones que
 *  tocan el secreto lanzan `AccesoNoDisponibleError` y la ruta responde 503, nunca texto plano ni un 500. */
export class PostgresRentasAccesoRepository implements RentasAccesoRepository {
  constructor(
    private readonly db: TenantDbSession,
    private readonly cipher: AccesoCipher | null = null,
    private readonly errorLlave: AccesoNoDisponibleError | null = null,
  ) {}

  private exigirCipher(): AccesoCipher {
    if (this.cipher) return this.cipher;
    throw this.errorLlave ?? new AccesoNoDisponibleError("llave_no_configurada");
  }

  /** Abre un campo: sobre (descifra con la AAD ligada a unidad/property/campo) o, mientras no se barra, el texto heredado. */
  private abrir(r: InstruccionRow, campo: CampoAcceso, cifrado: string | null, claro: string | null): string | null {
    if (cifrado !== null) return this.exigirCipher().decrypt(cifrado, accesoAad(r.unidad_id, r.property_id, campo));
    return claro;
  }

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
    this.exigirCipher();
    return runWithSavepointFallback<ResultadoAcceso<InstruccionAcceso | null>>({
      session: this.db,
      savepointName: "sp_acceso_instruccion_leer",
      primary: async () => {
        const { rows } = await this.db.query<InstruccionRow>(
          `select unidad_id, property_id, direccion_exacta, codigo_acceso, instrucciones, direccion_cifrada, codigo_cifrado, instrucciones_cifradas
             from rentas.acceso_instruccion where property_id = $1 and unidad_id = $2;`,
          [propertyId, unidadId],
        );
        const r = rows[0];
        if (!r) return { disponible: true, valor: null };
        const valor: InstruccionAcceso = {
          unidadId: r.unidad_id,
          direccionExacta: this.abrir(r, "direccion", r.direccion_cifrada, r.direccion_exacta) ?? "",
          codigoAcceso: this.abrir(r, "codigo", r.codigo_cifrado, r.codigo_acceso),
          instrucciones: this.abrir(r, "instrucciones", r.instrucciones_cifradas, r.instrucciones),
        };
        // Bitacora de la lectura (sin contenido): si no se puede registrar, no se entrega el secreto.
        await this.db.query(`select rentas.acceso_instruccion_registrar($1::uuid, 'lectura_admin');`, [unidadId]);
        return { disponible: true, valor };
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      // Base sin la migracion 028: las columnas cifradas no existen. Se lee el texto heredado (es lo unico que hay) y no se
      // registra bitacora (la tabla tampoco existe).
      fallback: () =>
        runWithSavepointFallback<ResultadoAcceso<InstruccionAcceso | null>>({
          session: this.db,
          savepointName: "sp_acceso_instruccion_leer_legado",
          primary: async () => {
            const { rows } = await this.db.query<{ unidad_id: string; direccion_exacta: string; codigo_acceso: string | null; instrucciones: string | null }>(
              `select unidad_id, direccion_exacta, codigo_acceso, instrucciones from rentas.acceso_instruccion where property_id = $1 and unidad_id = $2;`,
              [propertyId, unidadId],
            );
            const r = rows[0];
            return { disponible: true, valor: r ? { unidadId: r.unidad_id, direccionExacta: r.direccion_exacta, codigoAcceso: r.codigo_acceso, instrucciones: r.instrucciones } : null };
          },
          isRecoverable: (err) => isMigrationPendingError(err),
          fallback: async () => ({ disponible: false }),
        }),
    });
  }

  guardarInstruccion(organizationId: string, propertyId: string, unidadId: string, e: EntradaInstruccion, actorId: string): Promise<ResultadoAcceso<InstruccionAcceso | null>> {
    const cipher = this.exigirCipher();
    return this.conDegradacion("instruccion_guardar", async () => {
      const unidad = await this.db.query(`select 1 from rentas.unidad where id = $1 and property_id = $2;`, [unidadId, propertyId]);
      if (unidad.rows.length === 0) return null;
      const sobre = (campo: CampoAcceso, v: string | null) => (v === null ? null : cipher.encrypt(v, accesoAad(unidadId, propertyId, campo)));
      // El texto plano se anula en la misma sentencia (la migracion 028 solo permite anularlo, nunca fijarlo).
      await this.db.query(
        `insert into rentas.acceso_instruccion (unidad_id, organization_id, property_id, direccion_cifrada, codigo_cifrado, instrucciones_cifradas, key_version, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (unidad_id) do update set
           direccion_cifrada = excluded.direccion_cifrada, codigo_cifrado = excluded.codigo_cifrado, instrucciones_cifradas = excluded.instrucciones_cifradas,
           key_version = excluded.key_version, direccion_exacta = null, codigo_acceso = null, instrucciones = null,
           updated_at = now(), updated_by = excluded.updated_by;`,
        [unidadId, organizationId, propertyId, sobre("direccion", e.direccionExacta), sobre("codigo", e.codigoAcceso), sobre("instrucciones", e.instrucciones), cipher.keyVersion, actorId],
      );
      await this.db.query(`select rentas.acceso_instruccion_registrar($1::uuid, 'escritura_admin');`, [unidadId]);
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

  listarReservasProximas(propertyId: string, limite: number): Promise<ResultadoAcceso<readonly ReservaAccesoRecord[]>> {
    return this.conDegradacion("reservas_proximas", async () => {
      const { rows } = await this.db.query<{
        id: string;
        unidad_id: string;
        unidad_nombre: string;
        canal: string;
        check_in: string;
        check_out: string;
        huesped_nombre: string | null;
        pago_confirmado: boolean;
        liberada: boolean;
      }>(
        `select o.id, o.unidad_id, u.name as unidad_nombre, coalesce(c.codigo, 'manual') as canal,
                to_char(lower(o.rango), 'YYYY-MM-DD') as check_in, to_char(upper(o.rango), 'YYYY-MM-DD') as check_out,
                g.nombre as huesped_nombre, (ar.pago_confirmado_en is not null) as pago_confirmado, (ar.liberado_en is not null) as liberada
         from rentas.ocupacion o
         join rentas.unidad u on u.id = o.unidad_id
         left join rentas.property_config pc on pc.property_id = o.property_id
         left join rentas.canal c on c.id = o.canal_origen_id
         left join rentas.guest_minimo g on g.id = o.huesped_minimo_id
         left join rentas.acceso_reserva ar on ar.ocupacion_id = o.id
         where o.property_id = $1 and o.capa = 'reserva' and o.estado = 'confirmado'
           and upper(o.rango) >= (now() at time zone coalesce(pc.zona_horaria, 'America/Mexico_City'))::date
         order by lower(o.rango), o.id
         limit $2;`,
        [propertyId, limite],
      );
      return rows.map((r) => ({
        ocupacionId: r.id,
        unidadId: r.unidad_id,
        unidadNombre: r.unidad_nombre,
        canal: r.canal,
        checkIn: r.check_in,
        checkOut: r.check_out,
        huespedNombre: r.huesped_nombre,
        pagoConfirmado: r.pago_confirmado,
        liberada: r.liberada,
      }));
    });
  }

  listarPendientesEntrega(propertyId: string, limite: number): Promise<ResultadoAcceso<readonly PendienteEntregaOta[]>> {
    return this.conDegradacion("pendientes_entrega", async () => {
      // Reserva confirmada que aun no termina, con la omision registrada, SIN liberar (ni por correo ni a mano) y sin un correo valido
      // (si ya lo capturo el pre-check-in, la siguiente corrida la entrega sola y deja de ser pendiente).
      const { rows } = await this.db.query<{
        id: string;
        unidad_id: string;
        unidad_nombre: string;
        canal: string;
        check_in: string;
        check_out: string;
        huesped_nombre: string | null;
        omitida_en: string;
      }>(
        `select o.id, o.unidad_id, u.name as unidad_nombre, coalesce(c.codigo, 'manual') as canal,
                to_char(lower(o.rango), 'YYYY-MM-DD') as check_in, to_char(upper(o.rango), 'YYYY-MM-DD') as check_out,
                g.nombre as huesped_nombre,
                (select max(b.creado_en) from rentas.acceso_bitacora b where b.ocupacion_id = o.id and b.evento = 'omitida_sin_contacto')::text as omitida_en
         from rentas.ocupacion o
         join rentas.unidad u on u.id = o.unidad_id
         left join rentas.property_config pc on pc.property_id = o.property_id
         left join rentas.canal c on c.id = o.canal_origen_id
         left join rentas.guest_minimo g on g.id = o.huesped_minimo_id
         left join rentas.acceso_reserva ar on ar.ocupacion_id = o.id
         where o.property_id = $1 and o.capa = 'reserva' and o.estado = 'confirmado'
           and upper(o.rango) >= (now() at time zone coalesce(pc.zona_horaria, 'America/Mexico_City'))::date
           and ar.liberado_en is null
           and (g.contacto is null or g.contacto !~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$')
           and exists (select 1 from rentas.acceso_bitacora b where b.ocupacion_id = o.id and b.evento = 'omitida_sin_contacto')
         order by lower(o.rango), o.id
         limit $2;`,
        [propertyId, limite],
      );
      return rows.map((r) => ({
        ocupacionId: r.id,
        unidadId: r.unidad_id,
        unidadNombre: r.unidad_nombre,
        canal: r.canal,
        checkIn: r.check_in,
        checkOut: r.check_out,
        huespedNombre: r.huesped_nombre,
        omitidaEn: r.omitida_en,
      }));
    });
  }

  obtenerReservaParaMensaje(propertyId: string, ocupacionId: string): Promise<ResultadoAcceso<ReservaParaMensajeOta | null>> {
    return this.conDegradacion("reserva_mensaje", async () => {
      const { rows } = await this.db.query<{ id: string; unidad_id: string; unidad_nombre: string; check_in: string; check_out: string; huesped_nombre: string | null }>(
        `select o.id, o.unidad_id, u.name as unidad_nombre, to_char(lower(o.rango), 'YYYY-MM-DD') as check_in, to_char(upper(o.rango), 'YYYY-MM-DD') as check_out, g.nombre as huesped_nombre
         from rentas.ocupacion o
         join rentas.unidad u on u.id = o.unidad_id
         left join rentas.guest_minimo g on g.id = o.huesped_minimo_id
         where o.property_id = $1 and o.id = $2 and o.capa = 'reserva' and o.estado = 'confirmado';`,
        [propertyId, ocupacionId],
      );
      const r = rows[0];
      return r ? { ocupacionId: r.id, unidadId: r.unidad_id, unidadNombre: r.unidad_nombre, checkIn: r.check_in, checkOut: r.check_out, huespedNombre: r.huesped_nombre } : null;
    });
  }

  async marcarEntregadaManual(ocupacionId: string, propertyId: string): Promise<ResultadoEntregaManual> {
    return runWithSavepointFallback<ResultadoEntregaManual>({
      session: this.db,
      savepointName: "sp_acceso_entregada_manual",
      primary: async () => {
        // La funcion SQL deriva la property de la ocupacion; aqui se amarra la reserva a la property de la ruta (un staff con acceso a A y B no marca una de B desde A).
        const propia = await this.db.query(`select 1 from rentas.ocupacion where id = $1::uuid and property_id = $2::uuid;`, [ocupacionId, propertyId]);
        if (propia.rows.length === 0) return "no_encontrada";
        const { rows } = await this.db.query<{ nueva: boolean }>(`select rentas.acceso_marcar_entregada_manual($1::uuid) as nueva;`, [ocupacionId]);
        return rows[0]?.nueva === true ? "entregada" : "ya_entregada";
      },
      // P0002 = la reserva no existe, no esta confirmada o no es de esta property/rol (la funcion no distingue).
      isRecoverable: (err) => isMigrationPendingError(err) || codigoPg(err) === "P0002",
      fallback: async (err) => (codigoPg(err) === "P0002" ? "no_encontrada" : "no_disponible"),
    });
  }

  async avisarOmitidaSinContacto(ocupacionId: string, organizationId: string, propertyId: string): Promise<boolean> {
    // Rn-P3-09: aviso in-app, dedupe por reserva (clave = id de la reserva), sin PII en el texto. emitirNotificacion corre bajo SAVEPOINT y devuelve un
    // estado (nunca lanza por una base sin core.emit_notification); aun asi se protege: el aviso jamas puede romper la liberacion de otras reservas.
    try {
      const r = await emitirNotificacion(this.db, { evento: "rentas.acceso.omitido_sin_contacto", organizationId, propertyId, clave: ocupacionId, entidadTipo: "ocupacion", entidadId: ocupacionId });
      return r.estado === "emitida";
    } catch {
      return false;
    }
  }

  async siguienteLiberacion(excluir: readonly string[]): Promise<LiberacionPendiente | null> {
    // Camino cifrado (migracion 028). Contra una base sin migrar (42883) cae a la funcion de 025, que entrega el texto heredado.
    return runWithSavepointFallback<LiberacionPendiente | null>({
      session: this.db,
      savepointName: "sp_acceso_liberacion_cifrada",
      primary: async () => {
        const { rows } = await this.db.query<LiberacionCifradaRow>(
          `select ocupacion_id, organization_id, property_id, unidad_id, to_char(check_in, 'YYYY-MM-DD') as check_in, to_char(check_out, 'YYYY-MM-DD') as check_out,
                  unidad_nombre, tenant_nombre, huesped_nombre, huesped_contacto, tiene_instrucciones, direccion_exacta, codigo_acceso, instrucciones,
                  direccion_cifrada, codigo_cifrado, instrucciones_cifradas, key_version
             from rentas.acceso_siguiente_liberacion_cifrada($1::uuid[], now());`,
          [excluir],
        );
        const r = rows[0];
        return r ? this.aLiberacion(r) : null;
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: () => this.siguienteLiberacionLegado(excluir),
    });
  }

  private aLiberacion(r: LiberacionCifradaRow): LiberacionPendiente {
    const base = {
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
    };
    const fila: InstruccionRow = { unidad_id: r.unidad_id, property_id: r.property_id, direccion_exacta: r.direccion_exacta, codigo_acceso: r.codigo_acceso, instrucciones: r.instrucciones, direccion_cifrada: r.direccion_cifrada, codigo_cifrado: r.codigo_cifrado, instrucciones_cifradas: r.instrucciones_cifradas };
    try {
      return {
        ...base,
        direccionExacta: this.abrir(fila, "direccion", r.direccion_cifrada, r.direccion_exacta),
        codigoAcceso: this.abrir(fila, "codigo", r.codigo_cifrado, r.codigo_acceso),
        instrucciones: this.abrir(fila, "instrucciones", r.instrucciones_cifradas, r.instrucciones),
      };
    } catch (err) {
      // No se puede abrir el sobre: la reserva NO se libera ni se envia nada; el cron lo registra como error (sin contenido).
      const errorAcceso: ErrorAccesoLiberacion = err instanceof AccesoNoDisponibleError ? err.reason : err instanceof AccesoDescifradoError ? "no_descifrable" : "no_descifrable";
      return { ...base, direccionExacta: null, codigoAcceso: null, instrucciones: null, errorAcceso };
    }
  }

  private async siguienteLiberacionLegado(excluir: readonly string[]): Promise<LiberacionPendiente | null> {
    const { rows } = await this.db.query<LiberacionLegadoRow>(
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

  async cifrarPendientes(limite: number): Promise<ResumenBarridoCifrado> {
    const cipher = this.exigirCipher();
    const lectura = await runWithSavepointFallback<readonly { unidad_id: string; property_id: string; direccion_exacta: string; codigo_acceso: string | null; instrucciones: string | null }[] | null>({
      session: this.db,
      savepointName: "sp_acceso_cifrar_pendientes",
      primary: async () => {
        const r = await this.db.query<{ unidad_id: string; property_id: string; direccion_exacta: string; codigo_acceso: string | null; instrucciones: string | null }>(
          `select unidad_id, property_id, direccion_exacta, codigo_acceso, instrucciones from rentas.acceso_instruccion_pendientes_cifrar($1::int);`,
          [limite],
        );
        return r.rows;
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => null,
    });
    if (lectura === null) return { disponible: false, cifradas: 0, fallidas: 0 };
    const pendientes = lectura;
    let cifradas = 0;
    let fallidas = 0;
    for (const p of pendientes) {
      const campos: readonly [CampoAcceso, string | null][] = [["direccion", p.direccion_exacta], ["codigo", p.codigo_acceso], ["instrucciones", p.instrucciones]];
      const sobres = campos.map(([campo, valor]) => (valor === null ? null : cipher.encrypt(valor, accesoAad(p.unidad_id, p.property_id, campo))));
      // Ida y vuelta ANTES de anular el texto plano: si algo no coincide, la fila queda intacta.
      const coincide = campos.every(([campo, valor], i) => {
        const sobre = sobres[i]!;
        if (valor === null) return sobre === null;
        try {
          return cipher.decrypt(sobre, accesoAad(p.unidad_id, p.property_id, campo)) === valor;
        } catch {
          return false;
        }
      });
      if (!coincide) {
        fallidas += 1;
        continue;
      }
      // Una fila que la base rechaza (error de Postgres con SQLSTATE: CHECK, etc.) no aborta la tanda: SAVEPOINT por fila,
      // la fila cuenta como fallida y queda en claro para revision; el resto sigue.
      const aplicado = await runWithSavepointFallback<boolean | null>({
        session: this.db,
        savepointName: "sp_acceso_cifrar_fila",
        primary: async () => {
          const { rows } = await this.db.query<{ aplicado: boolean }>(`select rentas.acceso_instruccion_aplicar_cifrado($1::uuid, $2, $3, $4, $5::int) as aplicado;`, [p.unidad_id, sobres[0], sobres[1], sobres[2], cipher.keyVersion]);
          return rows[0]?.aplicado === true;
        },
        isRecoverable: (err) => typeof (err as { code?: unknown } | null)?.code === "string" && /^[0-9A-Z]{5}$/.test((err as { code: string }).code),
        fallback: async () => null,
      });
      if (aplicado === null) fallidas += 1;
      else if (aplicado) cifradas += 1;
    }
    return { disponible: true, cifradas, fallidas };
  }
}
