// Reactivacion de clientes inactivos (autopiloto 2): acceso TypeScript a la migracion 052 (consentimiento de marketing, configuracion,
// campanas borrador -> aprobacion con un clic, atribucion). Toda la regla de negocio vive en SQL (SECURITY DEFINER con guard de rol/sistema);
// aqui solo se llama, se tipa y se degrada contra la base SIN migrar.
//
// Base sin migrar (SQLSTATE 42883/42P01/42703): CADA llamada va en su propio SAVEPOINT (`runWithSavepointFallback`): una lectura devuelve
// `disponible: false` con lista vacia (estado honesto "no disponible aun"), una escritura de sistema (consentimiento, borradores) devuelve
// "no disponible" sin romper el pedido ni el webhook que la invoca, y las acciones del panel lanzan `MarketingNoDisponibleError` (503).
// Los errores de negocio de la base (P0001: requiere_tarifa, requiere_marketing_activo, requiere_nuevo_borrador, requiere_plantilla_aprobada, requiere_whatsapp_conectado, tope_mensual_excedido,
// campana_no_aprobable) salen como `MarketingRechazadoError` con su codigo: el panel los muestra como "requiere X", nunca como un 500.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion, isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";

export const SEGMENTOS_MARKETING = ["inactivo_30", "inactivo_60", "inactivo_90"] as const;
export type SegmentoMarketing = (typeof SEGMENTOS_MARKETING)[number];
export type EstadoCampana = "borrador" | "aprobada" | "rechazada" | "expirada";
export type CodigoRechazoMarketing = "requiere_tarifa" | "requiere_marketing_activo" | "requiere_nuevo_borrador" | "requiere_plantilla_aprobada" | "requiere_whatsapp_conectado" | "tope_mensual_excedido" | "campana_no_aprobable";

const CODIGOS_RECHAZO: ReadonlySet<string> = new Set<CodigoRechazoMarketing>(["requiere_tarifa", "requiere_marketing_activo", "requiere_nuevo_borrador", "requiere_plantilla_aprobada", "requiere_whatsapp_conectado", "tope_mensual_excedido", "campana_no_aprobable"]);

export class MarketingNoDisponibleError extends Error {
  constructor() {
    super("Las campañas de reactivación todavía no están disponibles en esta base de datos (falta aplicar la migración 052).");
    this.name = "MarketingNoDisponibleError";
  }
}

export class MarketingRechazadoError extends Error {
  constructor(readonly codigo: CodigoRechazoMarketing) {
    super(codigo);
    this.name = "MarketingRechazadoError";
  }
}

/** La base rechazo por permisos (42501): campana ajena, inexistente o usuario sin rol owner/admin. No distingue los casos a proposito. */
export class MarketingSinAccesoError extends Error {
  constructor() {
    super("Sin acceso a las campañas de esta organización.");
    this.name = "MarketingSinAccesoError";
  }
}

export class MarketingParametrosError extends Error {
  constructor() {
    super("Valores de configuración de marketing inválidos.");
    this.name = "MarketingParametrosError";
  }
}

function sqlstate(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** Errores de la base que se traducen a un error tipado (despues del ROLLBACK TO SAVEPOINT). */
function traducir(err: unknown): never {
  if (isMigrationPendingError(err)) throw new MarketingNoDisponibleError();
  const code = sqlstate(err);
  if (code === "42501") throw new MarketingSinAccesoError();
  if (code === "22023") throw new MarketingParametrosError();
  if (code === "P0001") {
    const mensaje = err instanceof Error ? err.message : "";
    if (CODIGOS_RECHAZO.has(mensaje)) throw new MarketingRechazadoError(mensaje as CodigoRechazoMarketing);
  }
  throw err;
}

const esTraducible = (err: unknown): boolean => isMigrationPendingError(err) || ["42501", "22023", "P0001"].includes(sqlstate(err) ?? "");

export interface ConfigMarketing {
  readonly activo: boolean;
  readonly tarifaCentavos: number | null;
  readonly topeMensualCentavos: number | null;
  readonly minimoSegmento: number;
  readonly plantillaNombre: string | null;
  readonly plantillaIdioma: string;
  /** Requisitos reales para poder enviar (estado honesto): nunca se muestran como funcionales sin cumplirse. */
  readonly hayPromocionVigente: boolean;
  readonly plantillaAprobada: boolean;
  readonly whatsappConectado: boolean;
  readonly gastadoMesCentavos: number;
  readonly consentimientosVigentes: number;
}

export interface CampanaMarketing {
  readonly id: string;
  readonly segmento: SegmentoMarketing;
  readonly estado: EstadoCampana;
  readonly conteo: number;
  readonly conteoControl: number;
  readonly costoEstimadoCentavos: number | null;
  readonly promoNombre: string;
  readonly promoCodigo: string;
  readonly creadaAt: string;
  readonly decididaAt: string | null;
  readonly encolados: number | null;
  readonly enviados: number;
  /** Clientes tratados / del grupo de control que volvieron a pedir en los 7 dias siguientes a la aprobacion. */
  readonly recompraTratados: number;
  readonly recompraControl: number;
  readonly ingresoTratados: number;
  readonly ventanaCerrada: boolean;
}

export interface LecturaMarketing<T> {
  /** `false` = la base aun no tiene la migracion 052. */
  readonly disponible: boolean;
  readonly valor: T;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numONull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

export async function leerConfigMarketing(session: TenantDbSession, organizationId: string): Promise<LecturaMarketing<ConfigMarketing | null>> {
  return runWithSavepointFallback<LecturaMarketing<ConfigMarketing | null>>({
    session,
    savepointName: "sp_marketing_config_leer",
    primary: async () => {
      const { rows } = await session.query<Record<string, unknown>>(`select * from restaurantes.marketing_config_leer($1::uuid);`, [organizationId]);
      const r = rows[0];
      if (!r) return { disponible: true, valor: null };
      return {
        disponible: true,
        valor: {
          activo: r.activo === true,
          tarifaCentavos: numONull(r.tarifa_centavos),
          topeMensualCentavos: numONull(r.tope_mensual_centavos),
          minimoSegmento: num(r.minimo_segmento),
          plantillaNombre: (r.plantilla_nombre as string | null) ?? null,
          plantillaIdioma: String(r.plantilla_idioma),
          hayPromocionVigente: r.hay_promocion_vigente === true,
          plantillaAprobada: r.plantilla_aprobada === true,
          whatsappConectado: r.whatsapp_conectado === true,
          gastadoMesCentavos: num(r.gastado_mes_centavos),
          consentimientosVigentes: num(r.consentimientos_vigentes),
        },
      };
    },
    isRecoverable: esTraducible,
    fallback: async (err) => {
      if (isMigrationPendingError(err)) return { disponible: false, valor: null };
      return traducir(err);
    },
  });
}

export interface EntradaConfigMarketing {
  readonly activo: boolean;
  readonly tarifaCentavos: number | null;
  readonly topeMensualCentavos: number | null;
  readonly minimoSegmento: number;
  readonly plantillaNombre: string | null;
  readonly plantillaIdioma: string;
}

export async function guardarConfigMarketing(session: TenantDbSession, organizationId: string, c: EntradaConfigMarketing): Promise<void> {
  await runWithSavepointFallback<void>({
    session,
    savepointName: "sp_marketing_config_guardar",
    primary: async () => {
      await session.query(`select restaurantes.marketing_guardar_config($1::uuid, $2::boolean, $3::int, $4::int, $5::int, $6::text, $7::text);`, [
        organizationId,
        c.activo,
        c.tarifaCentavos,
        c.topeMensualCentavos,
        c.minimoSegmento,
        c.plantillaNombre,
        c.plantillaIdioma,
      ]);
    },
    isRecoverable: esTraducible,
    fallback: async (err) => traducir(err),
  });
}

export async function listarCampanas(session: TenantDbSession, organizationId: string): Promise<LecturaMarketing<readonly CampanaMarketing[]>> {
  return runWithSavepointFallback<LecturaMarketing<readonly CampanaMarketing[]>>({
    session,
    savepointName: "sp_marketing_campanas_listar",
    primary: async () => {
      const { rows } = await session.query<Record<string, unknown>>(`select * from restaurantes.marketing_resumen_campanas($1::uuid);`, [organizationId]);
      return {
        disponible: true,
        valor: rows.map((r) => ({
          id: String(r.campana_id),
          segmento: r.segmento as SegmentoMarketing,
          estado: r.estado as EstadoCampana,
          conteo: num(r.conteo),
          conteoControl: num(r.conteo_control),
          costoEstimadoCentavos: numONull(r.costo_estimado_centavos),
          promoNombre: String(r.promo_nombre),
          promoCodigo: String(r.promo_codigo),
          creadaAt: iso(r.creada_at),
          decididaAt: r.decidida_at === null || r.decidida_at === undefined ? null : iso(r.decidida_at),
          encolados: numONull(r.encolados),
          enviados: num(r.enviados),
          recompraTratados: num(r.recompra_tratados),
          recompraControl: num(r.recompra_control),
          ingresoTratados: num(r.ingreso_tratados),
          ventanaCerrada: r.ventana_cerrada === true,
        })),
      };
    },
    isRecoverable: esTraducible,
    fallback: async (err) => {
      if (isMigrationPendingError(err)) return { disponible: false, valor: [] };
      return traducir(err);
    },
  });
}

export interface ResultadoDecision {
  readonly estado: "aprobada" | "rechazada";
  readonly encolados: number;
  readonly control: number;
}

/** Aprobar (encola en messaging_outbox) o rechazar (no envia nada) una campana. Idempotente en la base. */
export async function decidirCampana(session: TenantDbSession, campanaId: string, aprobar: boolean): Promise<ResultadoDecision> {
  return runWithSavepointFallback<ResultadoDecision>({
    session,
    savepointName: "sp_marketing_campana_decidir",
    primary: async () => {
      const { rows } = await session.query<{ estado: string; encolados: number | string; control: number | string }>(`select * from restaurantes.marketing_decidir_campana($1::uuid, $2::boolean);`, [campanaId, aprobar]);
      const r = rows[0];
      if (!r) throw new MarketingSinAccesoError();
      return { estado: r.estado === "aprobada" ? "aprobada" : "rechazada", encolados: num(r.encolados), control: num(r.control) };
    },
    isRecoverable: esTraducible,
    fallback: async (err) => traducir(err),
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Escrituras de SISTEMA (checkout web, webhook de WhatsApp): nunca lanzan ni rompen el flujo que las invoca.
// ---------------------------------------------------------------------------------------------------------------------------------
export type ResultadoConsentimiento = "registrado" | "sin_cambio" | "no_disponible" | "error";

export async function registrarConsentimientoMarketing(
  session: TenantDbSession,
  input: { readonly organizationId: string; readonly customerId: string; readonly otorgar: boolean; readonly fuente: "checkout_web" | "agente_whatsapp" | "baja_whatsapp" | "panel" },
): Promise<ResultadoConsentimiento> {
  try {
    return await runWithSavepointFallback<ResultadoConsentimiento>({
      session,
      savepointName: "sp_marketing_consentimiento",
      primary: async () => {
        const { rows } = await session.query<{ cambio: boolean }>(`select restaurantes.marketing_registrar_consentimiento($1::uuid, $2::uuid, 'whatsapp', $3::boolean, $4::text) as cambio;`, [input.organizationId, input.customerId, input.otorgar, input.fuente]);
        return rows[0]?.cambio === true ? "registrado" : "sin_cambio";
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => "no_disponible",
    });
  } catch {
    return "error";
  }
}

/** BAJA/ALTO por WhatsApp: revoca el consentimiento de marketing de ese telefono y mata los mensajes de campana aun pendientes. */
export interface ResultadoBajaMarketing {
  readonly estado: "revocado" | "sin_cambio" | "no_disponible" | "error";
  readonly revocados: number;
}

export async function revocarMarketingPorTelefono(session: TenantDbSession, organizationId: string, telefono: string): Promise<ResultadoBajaMarketing> {
  try {
    return await runWithSavepointFallback<ResultadoBajaMarketing>({
      session,
      savepointName: "sp_marketing_baja",
      primary: async () => {
        const { rows } = await session.query<{ revocados: number | string }>(`select restaurantes.marketing_revocar_por_telefono($1::uuid, $2::text) as revocados;`, [organizationId, telefono]);
        const revocados = num(rows[0]?.revocados);
        return { estado: revocados > 0 ? ("revocado" as const) : ("sin_cambio" as const), revocados };
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ estado: "no_disponible" as const, revocados: 0 }),
    });
  } catch {
    return { estado: "error", revocados: 0 };
  }
}

export interface BorradorGenerado {
  readonly campanaId: string;
  readonly organizationId: string;
  readonly segmento: SegmentoMarketing;
  readonly conteo: number;
  readonly costoEstimadoCentavos: number | null;
}

export interface ResultadoBorradores {
  readonly disponible: boolean;
  readonly borradores: number;
  readonly avisos: { readonly emitidas: number; readonly sinNuevas: number; readonly errores: number };
}

const DIAS_DEL_SEGMENTO: Readonly<Record<SegmentoMarketing, number>> = { inactivo_30: 30, inactivo_60: 60, inactivo_90: 90 };

/** Tick (diario en la practica; idempotente por organizacion+segmento+dia): arma los borradores y avisa en la campana a owner/admin. SOLO sistema. */
export async function generarBorradoresMarketing(session: TenantDbSession, now: Date = new Date()): Promise<ResultadoBorradores> {
  const lectura = await runWithSavepointFallback<{ readonly disponible: boolean; readonly filas: readonly BorradorGenerado[] }>({
    session,
    savepointName: "sp_marketing_borradores",
    primary: async () => {
      const { rows } = await session.query<Record<string, unknown>>(`select campana_id, organization_id, segmento, conteo, costo_estimado_centavos from restaurantes.marketing_generar_borradores($1::timestamptz);`, [now.toISOString()]);
      return {
        disponible: true,
        filas: rows.map((r) => ({ campanaId: String(r.campana_id), organizationId: String(r.organization_id), segmento: r.segmento as SegmentoMarketing, conteo: num(r.conteo), costoEstimadoCentavos: numONull(r.costo_estimado_centavos) })),
      };
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => ({ disponible: false, filas: [] }),
  });
  let emitidas = 0;
  let sinNuevas = 0;
  let errores = 0;
  for (const b of lectura.filas) {
    // Sin PII: solo el conteo y los dias del segmento. Dedupe: un aviso por campana.
    const r = await emitirNotificacion(session, {
      evento: "restaurantes.marketing.borrador_listo",
      organizationId: b.organizationId,
      clave: b.campanaId,
      parametros: { conteo: b.conteo, dias: DIAS_DEL_SEGMENTO[b.segmento] },
      entidadTipo: "marketing_campana",
      entidadId: b.campanaId,
    });
    if (r.estado === "emitida") emitidas += 1;
    else if (r.estado === "sin_nuevas" || r.estado === "no_disponible") sinNuevas += 1;
    else errores += 1;
  }
  return { disponible: lectura.disponible, borradores: lectura.filas.length, avisos: { emitidas, sinNuevas, errores } };
}
