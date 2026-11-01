// Adaptador Postgres del ciclo operativo del pedido (migraciones 170, 171 y 172). REGLA DURA de compatibilidad con la base SIN migrar: mergear despliega el
// codigo al instante y las migraciones no se aplican solas. Toda llamada corre dentro de la transaccion UNICA del request/unidad, asi que cada operacion usa
// `runWithSavepointFallback`; ante 42883 (funcion), 42P01 (tabla) o 42703 (columna) las lecturas degradan a `disponible: false` y las escrituras lanzan
// `CicloNoDisponibleError` (503 honesto). 42501 / 22023 / P0404 / P0409 se traducen a errores tipados; cualquier otro error se repropaga.
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { RECORDATORIO_POR_OMISION } from "./reglas.ts";
import type { ConfigRecordatorio, EncuestaCruda, MotivoOmision, MotivoRechazo, TiemposCrudos } from "./reglas.ts";
import {
  CicloAccesoError,
  CicloConflictoError,
  CicloNoDisponibleError,
  CicloNoEncontradoError,
  CicloValidacionError,
} from "./tipos.ts";
import type {
  CandidatoEncuesta,
  CandidatoRecordatorio,
  CicloPedidoRepository,
  ConfigEncuesta,
  EstadoEsperadoEncuesta,
  LecturaCiclo,
  ResultadoAceptar,
  ResultadoComentarEncuesta,
  ResultadoDespachar,
  ResultadoEntregarStaff,
  ResultadoRechazar,
  ResultadoResponderEncuesta,
} from "./tipos.ts";

function codigo(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** Traduce los errores de regla de la base a errores tipados que la ruta HTTP convierte en 403/404/409/422. */
function traducir(err: unknown): never {
  const c = codigo(err);
  const msg = err instanceof Error ? err.message : String(err);
  if (c === "42501") throw new CicloAccesoError(msg);
  if (c === "22023" || c === "P0422") throw new CicloValidacionError(msg);
  if (c === "P0404") throw new CicloNoEncontradoError(msg);
  if (c === "P0409") throw new CicloConflictoError(msg);
  throw err;
}

const num = (v: unknown): number => Number(v);
const numONulo = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoONulo = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));
function registroNumerico(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = Number(x);
  return out;
}

export class PostgresCicloPedidoRepository implements CicloPedidoRepository {
  constructor(private readonly db: TenantDbSession) {}

  private async lectura<T>(nombre: string, vacio: T, fn: () => Promise<T>): Promise<LecturaCiclo<T>> {
    return runWithSavepointFallback<LecturaCiclo<T>>({
      session: this.db,
      savepointName: `sp_ciclo_${nombre}`,
      primary: async () => ({ disponible: true, valor: await fn() }),
      isRecoverable: isMigrationPendingError,
      fallback: async () => ({ disponible: false, valor: vacio }),
    });
  }

  private async escritura<T>(nombre: string, fn: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback<T>({
      session: this.db,
      savepointName: `sp_ciclo_${nombre}`,
      primary: async () => {
        try {
          return await fn();
        } catch (err) {
          // Los errores de regla se traducen DENTRO del primario para que el savepoint ya revierta y la sesion quede utilizable.
          if (isMigrationPendingError(err)) throw err;
          return traducir(err);
        }
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => {
        throw new CicloNoDisponibleError("Esta función requiere actualizar la base de datos (migraciones 170 a 172).");
      },
    });
  }

  // ---- 170 ----
  async aceptar(organizationId: string, orderId: string, minutos: number): Promise<ResultadoAceptar> {
    return this.escritura("aceptar", async () => {
      const { rows } = await this.db.query<{ r: Record<string, unknown> }>("select restaurantes.pedido_aceptar($1::uuid, $2::uuid, $3::int) as r;", [organizationId, orderId, minutos]);
      const r = rows[0]!.r;
      return { resultado: r.resultado === "ya_aplicado" ? "ya_aplicado" : "aceptado", aceptadoAt: iso(r.aceptado_at), tiempoPrometidoMin: num(r.tiempo_prometido_min) };
    });
  }

  async rechazar(organizationId: string, orderId: string, motivo: MotivoRechazo, nota: string | null): Promise<ResultadoRechazar> {
    return this.escritura("rechazar", async () => {
      const { rows } = await this.db.query<{ r: Record<string, unknown> }>("select restaurantes.pedido_rechazar($1::uuid, $2::uuid, $3::text, $4::text) as r;", [organizationId, orderId, motivo, nota]);
      const r = rows[0]!.r;
      return { resultado: r.resultado === "ya_aplicado" ? "ya_aplicado" : "rechazado", rechazadoAt: iso(r.rechazado_at), motivo: String(r.motivo) as MotivoRechazo };
    });
  }

  async despachar(organizationId: string, orderId: string, repartidorId: string, etaMin: number): Promise<ResultadoDespachar> {
    return this.escritura("despachar", async () => {
      const { rows } = await this.db.query<{ r: Record<string, unknown> }>("select restaurantes.despachar_pedido($1::uuid, $2::uuid, $3::uuid, $4::int) as r;", [organizationId, orderId, repartidorId, etaMin]);
      const r = rows[0]!.r;
      const resultado = r.resultado === "ya_aplicado" ? "ya_aplicado" : r.resultado === "reasignado" ? "reasignado" : "despachado";
      return { resultado, salioAt: isoONulo(r.salio_at), repartidorId: String(r.repartidor_id) };
    });
  }

  async entregarStaff(organizationId: string, orderId: string, ocurrioEn: Date | null, cobrado: number | null): Promise<ResultadoEntregarStaff> {
    return this.escritura("entregar_staff", async () => {
      const { rows } = await this.db.query<{ r: Record<string, unknown> }>("select restaurantes.pedido_entregar_staff($1::uuid, $2::uuid, $3::timestamptz, $4::numeric) as r;", [
        organizationId,
        orderId,
        ocurrioEn ? ocurrioEn.toISOString() : null,
        cobrado,
      ]);
      const r = rows[0]!.r;
      return {
        resultado: r.resultado === "ya_aplicado" ? "ya_aplicado" : "entregado",
        entregadoAt: iso(r.entregado_at),
        salioAt: isoONulo(r.salio_at),
        minutosDesdeAceptado: numONulo(r.minutos_desde_aceptado),
        tiempoPrometidoMin: numONulo(r.tiempo_prometido_min),
      };
    });
  }

  async tiempos(organizationId: string, propertyId: string, desde: Date, hasta: Date): Promise<LecturaCiclo<TiemposCrudos | null>> {
    return this.lectura<TiemposCrudos | null>("tiempos", null, async () => {
      const { rows } = await this.db
        .query<{ r: Record<string, unknown> }>("select restaurantes.operacion_tiempos($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz) as r;", [organizationId, propertyId, desde.toISOString(), hasta.toISOString()])
        .catch((e) => (isMigrationPendingError(e) ? Promise.reject(e) : traducir(e)));
      const r = rows[0]?.r;
      if (!r) return null;
      return {
        pedidos: num(r.pedidos),
        aceptados: num(r.aceptados),
        rechazados: num(r.rechazados),
        entregadosConPromesa: num(r.entregados_con_promesa),
        aTiempo: num(r.a_tiempo),
        realMinProm: numONulo(r.real_min_prom),
        prometidoMinProm: numONulo(r.prometido_min_prom),
        aceptacionSegProm: numONulo(r.aceptacion_seg_prom),
        salidaMinProm: numONulo(r.salida_min_prom),
        rechazosPorMotivo: registroNumerico(r.rechazos_por_motivo),
      };
    });
  }

  // ---- 171 ----
  async leerConfigEncuesta(organizationId: string, propertyId: string): Promise<LecturaCiclo<ConfigEncuesta>> {
    return this.lectura<ConfigEncuesta>("encuesta_config_leer", { habilitada: false, linkResena: null }, async () => {
      const { rows } = await this.db
        .query<{ habilitada: boolean; link_resena: string | null }>("select habilitada, link_resena from restaurantes.encuesta_config_leer($1::uuid, $2::uuid);", [organizationId, propertyId])
        .catch((e) => (isMigrationPendingError(e) ? Promise.reject(e) : traducir(e)));
      return { habilitada: rows[0]?.habilitada === true, linkResena: rows[0]?.link_resena ?? null };
    });
  }

  async guardarConfigEncuesta(organizationId: string, propertyId: string, config: ConfigEncuesta): Promise<void> {
    await this.escritura("encuesta_config_guardar", async () => {
      await this.db.query("select restaurantes.encuesta_config_guardar($1::uuid, $2::uuid, $3::boolean, $4::text);", [organizationId, propertyId, config.habilitada, config.linkResena]);
    });
  }

  async candidatasEncuesta(ahora: Date, limite: number): Promise<LecturaCiclo<readonly CandidatoEncuesta[]>> {
    return this.lectura<readonly CandidatoEncuesta[]>("encuesta_candidatas", [], async () => {
      const { rows } = await this.db.query<Record<string, unknown>>("select * from restaurantes.encuesta_candidatas($1::timestamptz, $2::int);", [ahora.toISOString(), limite]);
      return rows.map((r) => ({
        orderId: String(r.order_id),
        organizationId: String(r.organization_id),
        propertyId: String(r.property_id),
        customerPhone: String(r.customer_phone),
        deliveredAt: iso(r.delivered_at),
        zonaHoraria: r.zona_horaria === null || r.zona_horaria === undefined ? null : String(r.zona_horaria),
        phoneHash: String(r.phone_hash),
        ultimoEntranteAt: isoONulo(r.ultimo_entrante_at),
        ultimaEncuestaAt: isoONulo(r.ultima_encuesta_at),
        optOut: r.opt_out === true,
        consentimiento: r.consentimiento === true,
        linkResena: r.link_resena === null || r.link_resena === undefined ? null : String(r.link_resena),
      }));
    });
  }

  async reservarEncuesta(organizationId: string, orderId: string, phoneHash: string, estado: "enviada" | "omitida", omitidoMotivo: MotivoOmision | null, canal: "texto" | "plantilla" | null): Promise<boolean> {
    return this.escritura("encuesta_reservar", async () => {
      const { rows } = await this.db.query<{ ok: boolean }>("select restaurantes.encuesta_reservar($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text) as ok;", [
        organizationId,
        orderId,
        phoneHash,
        estado,
        omitidoMotivo,
        canal,
      ]);
      return rows[0]?.ok === true;
    });
  }

  async estadoEsperadoEncuesta(organizationId: string, phoneHash: string, ahora: Date): Promise<LecturaCiclo<EstadoEsperadoEncuesta>> {
    return this.lectura<EstadoEsperadoEncuesta>("encuesta_estado_para", "ninguna", async () => {
      const { rows } = await this.db.query<{ e: string }>("select restaurantes.encuesta_estado_para($1::uuid, $2::text, $3::timestamptz) as e;", [organizationId, phoneHash, ahora.toISOString()]);
      const e = rows[0]?.e;
      return e === "calificacion" || e === "comentario" ? e : "ninguna";
    });
  }

  async responderEncuesta(organizationId: string, phoneHash: string, calificacion: number, ahora: Date): Promise<ResultadoResponderEncuesta> {
    return this.escritura("encuesta_responder", async () => {
      const { rows } = await this.db.query<{ r: Record<string, unknown> }>("select restaurantes.encuesta_responder($1::uuid, $2::text, $3::int, $4::timestamptz) as r;", [organizationId, phoneHash, calificacion, ahora.toISOString()]);
      const r = rows[0]!.r;
      if (r.resultado !== "respondida") return { resultado: "sin_encuesta" };
      return {
        resultado: "respondida",
        encuestaId: String(r.encuesta_id),
        orderId: String(r.order_id),
        propertyId: String(r.property_id),
        orderNumber: numONulo(r.order_number),
        linkResena: r.link_resena === null || r.link_resena === undefined ? null : String(r.link_resena),
      };
    });
  }

  async comentarEncuesta(organizationId: string, phoneHash: string, comentario: string, ahora: Date): Promise<ResultadoComentarEncuesta> {
    return this.escritura("encuesta_comentar", async () => {
      const { rows } = await this.db.query<{ r: Record<string, unknown> }>("select restaurantes.encuesta_comentar($1::uuid, $2::text, $3::text, $4::timestamptz) as r;", [organizationId, phoneHash, comentario, ahora.toISOString()]);
      const r = rows[0]!.r;
      if (r.resultado !== "comentada") return { resultado: "sin_encuesta" };
      return { resultado: "comentada", encuestaId: String(r.encuesta_id), orderId: String(r.order_id), propertyId: String(r.property_id), calificacion: num(r.calificacion) };
    });
  }

  async registrarBajaEncuesta(organizationId: string, phoneHash: string): Promise<boolean> {
    return this.escritura("encuesta_optout", async () => {
      const { rows } = await this.db.query<{ ok: boolean }>("select restaurantes.encuesta_optout_registrar($1::uuid, $2::text) as ok;", [organizationId, phoneHash]);
      return rows[0]?.ok === true;
    });
  }

  async metricasEncuesta(organizationId: string, propertyId: string, desde: Date, hasta: Date): Promise<LecturaCiclo<EncuestaCruda | null>> {
    return this.lectura<EncuestaCruda | null>("encuesta_metricas", null, async () => {
      const { rows } = await this.db
        .query<{ r: Record<string, unknown> }>("select restaurantes.encuesta_metricas($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz) as r;", [organizationId, propertyId, desde.toISOString(), hasta.toISOString()])
        .catch((e) => (isMigrationPendingError(e) ? Promise.reject(e) : traducir(e)));
      const r = rows[0]?.r;
      if (!r) return null;
      return {
        enviadas: num(r.enviadas),
        respondidas: num(r.respondidas),
        omitidas: num(r.omitidas),
        conComentario: num(r.con_comentario),
        sumaCalificacion: num(r.suma_calificacion),
        bajas: num(r.bajas),
        distribucion: registroNumerico(r.distribucion),
        omitidasPorMotivo: registroNumerico(r.omitidas_por_motivo),
        optouts: num(r.optouts),
      };
    });
  }

  // ---- 172 ----
  async leerConfigRecordatorio(organizationId: string, propertyId: string): Promise<LecturaCiclo<ConfigRecordatorio>> {
    return this.lectura<ConfigRecordatorio>("recordatorio_config_leer", RECORDATORIO_POR_OMISION, async () => {
      const { rows } = await this.db
        .query<{ habilitado: boolean; primero_min: number; repetir_min: number; maximo: number }>(
          "select habilitado, primero_min, repetir_min, maximo from restaurantes.recordatorio_pedido_config_leer($1::uuid, $2::uuid);",
          [organizationId, propertyId],
        )
        .catch((e) => (isMigrationPendingError(e) ? Promise.reject(e) : traducir(e)));
      const r = rows[0];
      return r ? { habilitado: r.habilitado === true, primeroMin: num(r.primero_min), repetirMin: num(r.repetir_min), maximo: num(r.maximo) } : RECORDATORIO_POR_OMISION;
    });
  }

  async guardarConfigRecordatorio(organizationId: string, propertyId: string, config: ConfigRecordatorio): Promise<void> {
    await this.escritura("recordatorio_config_guardar", async () => {
      await this.db.query("select restaurantes.recordatorio_pedido_config_guardar($1::uuid, $2::uuid, $3::boolean, $4::int, $5::int, $6::int);", [
        organizationId,
        propertyId,
        config.habilitado,
        config.primeroMin,
        config.repetirMin,
        config.maximo,
      ]);
    });
  }

  async candidatosRecordatorio(ahora: Date): Promise<LecturaCiclo<readonly CandidatoRecordatorio[]>> {
    return this.lectura<readonly CandidatoRecordatorio[]>("recordatorio_candidatos", [], async () => {
      const { rows } = await this.db.query<Record<string, unknown>>("select * from restaurantes.recordatorios_pedido_candidatos($1::timestamptz);", [ahora.toISOString()]);
      return rows.map((r) => ({
        orderId: String(r.order_id),
        organizationId: String(r.organization_id),
        propertyId: String(r.property_id),
        orderNumber: num(r.order_number),
        numeroRecordatorio: num(r.numero_recordatorio),
        maximo: num(r.maximo),
        minutos: num(r.minutos),
      }));
    });
  }
}
