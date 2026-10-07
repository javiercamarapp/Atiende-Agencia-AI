// Alerta al dueño «WhatsApp silencioso»: el numero de la organizacion deja de recibir mensajes justo cuando suele recibirlos (webhook roto, numero
// caido, token revocado sin error visible). El candidato lo decide la base (`restaurantes.whatsapp_silencio_candidatos`, migracion 052, SOLO sistema):
// 0 mensajes entrantes en la ventana (60 min por omision) cuando el mismo dia de la semana y hora de las 4 semanas previas promediaron al menos 3 por
// ventana, con trafico en 3 de las 4 semanas. El horario de servicio se infiere de ese historico (no lee branch_policy.horario). Los umbrales son
// configurables por organizacion (`alertas_duenio_config`). Idempotente: UNA alerta por organizacion y dia de Merida (el reloj es el inyectado).
//
// Corre como unidad independiente del tick existente /internal/restaurantes/promover-programados (su propia sesion de sistema). Base sin la 052:
// el candidato lanza 42883 dentro de un SAVEPOINT y devuelve `disponible: false`.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion, isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { diaMerida } from "./dia.ts";

export interface CandidatoSilencio {
  readonly organizationId: string;
  /** Promedio de mensajes por ventana del mismo dia y hora en las 4 semanas previas. */
  readonly mensajesHistorico: number;
  readonly ventanaMin: number;
}

export interface ResultadoSilencio {
  readonly disponible: boolean;
  readonly candidatos: number;
  readonly emitidas: number;
  readonly sinNuevas: number;
  readonly errores: number;
}

const SIN_BARRIDO: ResultadoSilencio = { disponible: false, candidatos: 0, emitidas: 0, sinNuevas: 0, errores: 0 };

export async function barrerSilencioWhatsapp(session: TenantDbSession, options: { readonly now: Date }): Promise<ResultadoSilencio> {
  const lectura = await runWithSavepointFallback<{ readonly disponible: boolean; readonly filas: readonly CandidatoSilencio[] }>({
    session,
    savepointName: "sp_whatsapp_silencio",
    primary: async () => {
      const { rows } = await session.query<{ organization_id: string; mensajes_historico: string | number; ventana_min: string | number }>(
        `select organization_id, mensajes_historico, ventana_min from restaurantes.whatsapp_silencio_candidatos($1::timestamptz);`,
        [options.now.toISOString()],
      );
      return { disponible: true, filas: rows.map((r) => ({ organizationId: r.organization_id, mensajesHistorico: Number(r.mensajes_historico), ventanaMin: Number(r.ventana_min) })) };
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => ({ disponible: false, filas: [] }),
  });
  if (!lectura.disponible) return SIN_BARRIDO;
  const dia = diaMerida(options.now);
  let emitidas = 0;
  let sinNuevas = 0;
  let errores = 0;
  for (const c of lectura.filas) {
    const r = await emitirNotificacion(session, {
      evento: "restaurantes.whatsapp.silencio",
      organizationId: c.organizationId,
      clave: dia,
      parametros: { mensajes: Math.round(c.mensajesHistorico), ventana: c.ventanaMin },
    });
    if (r.estado === "emitida") emitidas += 1;
    else if (r.estado === "sin_nuevas" || r.estado === "no_disponible") sinNuevas += 1;
    else errores += 1;
  }
  return { disponible: true, candidatos: lectura.filas.length, emitidas, sinNuevas, errores };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Umbrales por organizacion (alertas_duenio_config): lectura con los valores por omision conservadores y guardado por la funcion del panel.
// ---------------------------------------------------------------------------------------------------------------------------------
export interface UmbralesAlertasDuenio {
  readonly silencioActivo: boolean;
  /** Ventana sin mensajes entrantes (minutos). */
  readonly silencioVentanaMin: number;
  /** Promedio historico minimo de mensajes por ventana (mismo dia y hora, 4 semanas previas) para considerar silencio inusual. */
  readonly silencioHistoricoMin: number;
  /** `true` si la organizacion ya guardo una configuracion propia; `false` = valores por omision. */
  readonly configurado: boolean;
}

export const UMBRALES_ALERTAS_POR_OMISION: UmbralesAlertasDuenio = { silencioActivo: true, silencioVentanaMin: 60, silencioHistoricoMin: 3, configurado: false };

export class AlertasDuenioNoDisponibleError extends Error {
  constructor() {
    super("Los umbrales de alertas todavía no están disponibles en esta base de datos (falta aplicar la migración 052).");
    this.name = "AlertasDuenioNoDisponibleError";
  }
}

export class AlertasDuenioSinAccesoError extends Error {
  constructor() {
    super("Sin acceso a los umbrales de alertas de esta organización.");
    this.name = "AlertasDuenioSinAccesoError";
  }
}

export class AlertasDuenioParametrosError extends Error {
  constructor() {
    super("Umbrales de alertas inválidos.");
    this.name = "AlertasDuenioParametrosError";
  }
}

function sqlstate(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

export async function leerUmbralesAlertasDuenio(session: TenantDbSession, organizationId: string): Promise<{ readonly disponible: boolean; readonly umbrales: UmbralesAlertasDuenio }> {
  return runWithSavepointFallback<{ readonly disponible: boolean; readonly umbrales: UmbralesAlertasDuenio }>({
    session,
    savepointName: "sp_alertas_duenio_config_leer",
    primary: async () => {
      const { rows } = await session.query<{ silencio_activo: boolean; silencio_ventana_min: number | string; silencio_historico_min: number | string }>(
        `select silencio_activo, silencio_ventana_min, silencio_historico_min from restaurantes.alertas_duenio_config where organization_id = $1::uuid;`,
        [organizationId],
      );
      const r = rows[0];
      return { disponible: true, umbrales: r ? { silencioActivo: r.silencio_activo === true, silencioVentanaMin: Number(r.silencio_ventana_min), silencioHistoricoMin: Number(r.silencio_historico_min), configurado: true } : UMBRALES_ALERTAS_POR_OMISION };
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => ({ disponible: false, umbrales: UMBRALES_ALERTAS_POR_OMISION }),
  });
}

export async function guardarUmbralesAlertasDuenio(session: TenantDbSession, organizationId: string, u: Pick<UmbralesAlertasDuenio, "silencioActivo" | "silencioVentanaMin" | "silencioHistoricoMin">): Promise<void> {
  await runWithSavepointFallback<void>({
    session,
    savepointName: "sp_alertas_duenio_config_guardar",
    primary: async () => {
      await session.query(`select restaurantes.alertas_duenio_guardar_config($1::uuid, $2::boolean, $3::int, $4::numeric);`, [organizationId, u.silencioActivo, u.silencioVentanaMin, u.silencioHistoricoMin]);
    },
    isRecoverable: (err) => isMigrationPendingError(err) || ["42501", "22023"].includes(sqlstate(err) ?? ""),
    fallback: async (err) => {
      if (isMigrationPendingError(err)) throw new AlertasDuenioNoDisponibleError();
      if (sqlstate(err) === "42501") throw new AlertasDuenioSinAccesoError();
      throw new AlertasDuenioParametrosError();
    },
  });
}
