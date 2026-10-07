// Paridad3 (Rn-13, Rn-P3-15/16/17/23) -- cliente de conectividad y canales del panel de rentas
// (apps/api/src/routes/verticals/rentas/ical-conectividad.ts). Separado de las páginas para probarlo en
// entorno "node", igual que ical-sync-client.ts. Todo el wire va en snake_case y se mapea aquí a camelCase.
//   - fetchCatalogoCanales   -> GET  /rentas/:propertyId/canales/catalogo
//   - fetchMatrizConectividad-> GET  /rentas/:propertyId/conectividad
//   - fetchFeedTokens        -> GET  /rentas/:propertyId/unidades/:unidadId/feed-tokens
//   - rotarFeedToken         -> POST /rentas/:propertyId/unidades/:unidadId/canales/:canalCodigo/feed-token/rotar
//   - probarUrlFeed          -> POST /rentas/:propertyId/unidades/:unidadId/ical-feeds/probar
//   - sincronizarFeedAhora   -> POST /rentas/:propertyId/unidades/:unidadId/ical-feeds/:canalCodigo/sincronizar
import { fechaHoraEsMx } from "../../../lib/formato-fecha.ts";
import { fetchJson, sendJson } from "./admin-client.ts";

export type ViaIcal = "disponible" | "sin_evidencia" | "no_disponible";
export type ConfianzaLatencia = "alta" | "media" | "baja" | "sin_evidencia";
export type ViaHoy = "ical" | "partner" | "manual" | "sin_evidencia" | "sin_adaptador";

export interface CanalCatalogo {
  readonly codigo: string;
  readonly nombre: string;
  /** Código del canal en Atiende (airbnb/booking/vrbo/manual) si se puede conectar; `null` si no hay adaptador. */
  readonly canalAtiende: string | null;
  readonly viaHoy: ViaHoy;
  readonly viaIcal: ViaIcal;
  readonly descripcionVia: string;
  readonly latencia: { readonly texto: string; readonly confianza: ConfianzaLatencia; readonly fuente: string | null; readonly nota: string };
  readonly bloqueo: { readonly motivo: string; readonly cita: string } | null;
  readonly requisitos: readonly string[];
  readonly urlProcesoOficial: string | null;
  readonly notaAntiParidad: string;
}

interface CanalCatalogoWire {
  readonly codigo: string;
  readonly nombre: string;
  readonly canal_atiende: string | null;
  readonly via_hoy: ViaHoy;
  readonly via_ical: ViaIcal;
  readonly descripcion_via: string;
  readonly latencia: CanalCatalogo["latencia"];
  readonly bloqueo: CanalCatalogo["bloqueo"];
  readonly requisitos: readonly string[];
  readonly url_proceso_oficial: string | null;
  readonly nota_anti_paridad: string;
}

function mapCanal(w: CanalCatalogoWire): CanalCatalogo {
  return {
    codigo: w.codigo,
    nombre: w.nombre,
    canalAtiende: w.canal_atiende,
    viaHoy: w.via_hoy,
    viaIcal: w.via_ical,
    descripcionVia: w.descripcion_via,
    latencia: w.latencia,
    bloqueo: w.bloqueo,
    requisitos: w.requisitos,
    urlProcesoOficial: w.url_proceso_oficial,
    notaAntiParidad: w.nota_anti_paridad,
  };
}

export async function fetchCatalogoCanales(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly CanalCatalogo[]> {
  const body = await fetchJson<{ canales: readonly CanalCatalogoWire[] }>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/canales/catalogo`, token);
  return body.canales.map(mapCanal);
}

// ---- Matriz de conectividad ----

export type EstadoCeldaMatriz = "conectado" | "solo_import" | "solo_export" | "sin_conectar" | "pendiente" | "fallando" | "en_cuarentena";
export type EstadoImportMatriz = "sin_conectar" | "pendiente" | "ok" | "desactualizado" | "fallando" | "en_cuarentena";
export type EstadoExportMatriz = "sin_token" | "token_sin_consulta" | "consultado" | "no_disponible_aun";

export const ETIQUETA_ESTADO_CELDA: Record<EstadoCeldaMatriz, string> = {
  conectado: "Conectado",
  solo_import: "Solo importa",
  solo_export: "Solo exporta",
  sin_conectar: "Sin conectar",
  pendiente: "Pendiente de sincronizar",
  fallando: "Fallando",
  en_cuarentena: "En cuarentena",
};

export interface CeldaConectividad {
  readonly canal: string;
  readonly estado: EstadoCeldaMatriz;
  readonly import: {
    readonly estado: EstadoImportMatriz;
    readonly ultimaSincronizacionExitosaEn: string | null;
    readonly enCuarentenaDesde: string | null;
    readonly motivoCuarentena: string | null;
    readonly intentosFallidosConsecutivos: number;
  };
  readonly export: { readonly estado: EstadoExportMatriz; readonly tokenCreadoEn: string | null; readonly ultimoAccesoEn: string | null };
}

export interface UnidadConectividad {
  readonly id: string;
  readonly nombre: string;
  readonly celdas: readonly CeldaConectividad[];
}

export interface MatrizConectividad {
  readonly ahora: string;
  /** `false` = la base aún no tiene los tokens de exportación (la exportación se declara "no disponible aún"). */
  readonly tokensDisponibles: boolean;
  readonly canales: readonly CanalCatalogo[];
  readonly unidades: readonly UnidadConectividad[];
}

interface CeldaWire {
  readonly canal: string;
  readonly estado: EstadoCeldaMatriz;
  readonly import: {
    readonly estado: EstadoImportMatriz;
    readonly ultima_sincronizacion_exitosa_en: string | null;
    readonly en_cuarentena_desde: string | null;
    readonly motivo_cuarentena: string | null;
    readonly intentos_fallidos_consecutivos: number;
  };
  readonly export: { readonly estado: EstadoExportMatriz; readonly token_creado_en: string | null; readonly ultimo_acceso_en: string | null };
}

export async function fetchMatrizConectividad(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<MatrizConectividad> {
  const body = await fetchJson<{
    ahora: string;
    tokens_disponibles: boolean;
    canales: readonly CanalCatalogoWire[];
    unidades: readonly { id: string; nombre: string; celdas: readonly CeldaWire[] }[];
  }>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/conectividad`, token);
  return {
    ahora: body.ahora,
    tokensDisponibles: body.tokens_disponibles,
    canales: body.canales.map(mapCanal),
    unidades: body.unidades.map((u) => ({
      id: u.id,
      nombre: u.nombre,
      celdas: u.celdas.map((c) => ({
        canal: c.canal,
        estado: c.estado,
        import: {
          estado: c.import.estado,
          ultimaSincronizacionExitosaEn: c.import.ultima_sincronizacion_exitosa_en,
          enCuarentenaDesde: c.import.en_cuarentena_desde,
          motivoCuarentena: c.import.motivo_cuarentena,
          intentosFallidosConsecutivos: c.import.intentos_fallidos_consecutivos,
        },
        export: { estado: c.export.estado, tokenCreadoEn: c.export.token_creado_en, ultimoAccesoEn: c.export.ultimo_acceso_en },
      })),
    })),
  };
}

// ---- Tokens de exportación ----

export interface FeedTokensUnidad {
  /** `false` = la base aún no tiene la migración de tokens: solo existe la URL por UUID. */
  readonly disponible: boolean;
  /** `true` mientras la URL por UUID (deprecada) siga respondiendo. */
  readonly urlUuidActiva: boolean;
  readonly tokens: readonly { readonly canal: string; readonly creadoEn: string; readonly ultimoAccesoEn: string | null }[];
}

export async function fetchFeedTokens(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, unidadId: string): Promise<FeedTokensUnidad> {
  const body = await fetchJson<{ disponible: boolean; url_uuid_activa: boolean; tokens: readonly { canal: string; creado_en: string; ultimo_acceso_en: string | null }[] }>(
    fetchImpl,
    `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/feed-tokens`,
    token,
  );
  return { disponible: body.disponible, urlUuidActiva: body.url_uuid_activa, tokens: body.tokens.map((t) => ({ canal: t.canal, creadoEn: t.creado_en, ultimoAccesoEn: t.ultimo_acceso_en })) };
}

export interface FeedTokenRotado {
  readonly canal: string;
  /** Valor en claro: la API lo entrega UNA sola vez, aquí y nunca más. */
  readonly token: string;
  /** URL completa de exportación con el token, lista para pegar en el canal. */
  readonly url: string;
  readonly creadoEn: string;
}

export async function rotarFeedToken(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, unidadId: string, canalCodigo: string): Promise<FeedTokenRotado> {
  const body = await sendJson<{ canal: string; token: string; ruta: string; creado_en: string }>(
    fetchImpl,
    `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/canales/${canalCodigo}/feed-token/rotar`,
    token,
    "POST",
  );
  return { canal: body.canal, token: body.token, url: `${apiBaseUrl}${body.ruta}`, creadoEn: body.creado_en };
}

// ---- Probar URL ----

export type ResultadoProbarUrl =
  | { readonly ok: true; readonly eventos: number; readonly cancelados: number; readonly desde: string | null; readonly hasta: string | null }
  | { readonly ok: false; readonly tipo: "red" | "http" | "parseo"; readonly mensaje: string; readonly errores: readonly { readonly codigo: string; readonly mensaje: string }[] };

export async function probarUrlFeed(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, unidadId: string, url: string): Promise<ResultadoProbarUrl> {
  const body = await sendJson<{
    ok: boolean;
    tipo?: "red" | "http" | "parseo";
    mensaje?: string;
    eventos?: number;
    cancelados?: number;
    desde?: string | null;
    hasta?: string | null;
    errores?: readonly { codigo: string; mensaje: string }[];
  }>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/ical-feeds/probar`, token, "POST", { url });
  if (body.ok) return { ok: true, eventos: body.eventos ?? 0, cancelados: body.cancelados ?? 0, desde: body.desde ?? null, hasta: body.hasta ?? null };
  return { ok: false, tipo: body.tipo ?? "red", mensaje: body.mensaje ?? "No se pudo probar la URL.", errores: body.errores ?? [] };
}

// ---- Sincronizar ahora ----

export interface ResultadoSincronizarAhora {
  readonly ok: boolean;
  readonly resultado: string;
  readonly eventosAplicados: number;
  readonly reservasNuevas: number;
  readonly conflictosDetectados: number;
  readonly mensaje: string | null;
}

export async function sincronizarFeedAhora(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, unidadId: string, canalCodigo: string): Promise<ResultadoSincronizarAhora> {
  const body = await sendJson<{ ok: boolean; resultado: string; eventos_aplicados: number; reservas_nuevas: number; conflictos_detectados: number; mensaje?: string }>(
    fetchImpl,
    `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/ical-feeds/${canalCodigo}/sincronizar`,
    token,
    "POST",
  );
  return { ok: body.ok, resultado: body.resultado, eventosAplicados: body.eventos_aplicados, reservasNuevas: body.reservas_nuevas, conflictosDetectados: body.conflictos_detectados, mensaje: body.mensaje ?? null };
}

/** Texto corto de una sincronización manual, para mostrar bajo el botón. */
export function resumenSincronizacion(r: ResultadoSincronizarAhora): string {
  if (!r.ok) return r.mensaje ?? "No se pudo sincronizar el feed.";
  if (r.resultado === "no_modificado") return "El canal no tiene cambios desde la última vez.";
  const partes = [`${r.eventosAplicados} evento${r.eventosAplicados === 1 ? "" : "s"} aplicado${r.eventosAplicados === 1 ? "" : "s"}`];
  if (r.reservasNuevas > 0) partes.push(`${r.reservasNuevas} reserva${r.reservasNuevas === 1 ? "" : "s"} nueva${r.reservasNuevas === 1 ? "" : "s"}`);
  if (r.conflictosDetectados > 0) partes.push(`${r.conflictosDetectados} conflicto${r.conflictosDetectados === 1 ? "" : "s"} por revisar`);
  return `Sincronizado: ${partes.join(", ")}.`;
}

// ---- Asistente de conexión: pasos con evidencia real ----

export interface PasoAsistente {
  readonly id: "obtener-url-canal" | "pegar-import" | "primera-sync" | "pegar-export" | "canal-consulta";
  readonly texto: string;
  /** `true`/`false` según datos reales; `null` = paso que se hace fuera de Atiende y no se puede verificar. */
  readonly hecho: boolean | null;
  readonly evidencia: string;
}

function fechaLegible(iso: string | null): string {
  return iso ? fechaHoraEsMx(iso) : "nunca";
}

/**
 * Pasos para conectar una unidad a un canal con iCal. Cada paso verificable se marca con DATOS REALES de la matriz (feed
 * conectado, última sincronización exitosa, token creado, última consulta de la OTA); los pasos que ocurren dentro del
 * panel del canal quedan sin marca (`hecho: null`): Atiende no puede saber si ya se hicieron.
 */
export function pasosAsistente(canal: CanalCatalogo, celda: CeldaConectividad): readonly PasoAsistente[] {
  const nombre = canal.nombre;
  const imp = celda.import;
  const exp = celda.export;
  const importConectado = imp.estado !== "sin_conectar";

  let evidenciaSync: string;
  if (imp.ultimaSincronizacionExitosaEn) evidenciaSync = `Última sincronización exitosa: ${fechaLegible(imp.ultimaSincronizacionExitosaEn)}.`;
  else if (imp.estado === "en_cuarentena") evidenciaSync = `En cuarentena${imp.motivoCuarentena ? `: ${imp.motivoCuarentena}` : ""}.`;
  else if (imp.estado === "fallando") evidenciaSync = `Falla: ${imp.intentosFallidosConsecutivos} intento${imp.intentosFallidosConsecutivos === 1 ? "" : "s"} fallido${imp.intentosFallidosConsecutivos === 1 ? "" : "s"} seguido${imp.intentosFallidosConsecutivos === 1 ? "" : "s"}.`;
  else evidenciaSync = importConectado ? "Conectado, esperando la primera sincronización." : "Primero conecta la URL.";

  let evidenciaExport: string;
  if (exp.estado === "no_disponible_aun") evidenciaExport = "No disponible aún en este entorno: requiere actualizar la base de datos. Usa la URL por UUID de Sincronización iCal.";
  else if (exp.estado === "sin_token") evidenciaExport = "Todavía no generas la URL de exportación con token.";
  else evidenciaExport = `URL con token creada el ${fechaLegible(exp.tokenCreadoEn)}.`;

  return [
    {
      id: "obtener-url-canal",
      texto: `Obtén la URL del calendario iCal de esta unidad en el panel de ${nombre}.${canal.requisitos[0] ? ` ${canal.requisitos[0]}.` : ""}`,
      hecho: null,
      evidencia: "Se hace en el panel del canal: Atiende no puede verificarlo.",
    },
    {
      id: "pegar-import",
      texto: "Pégala en Atiende (Sincronización iCal, Conectar) y pruébala antes de guardar.",
      hecho: importConectado,
      evidencia: importConectado ? "Feed conectado." : "Aún no hay un feed conectado para esta unidad y canal.",
    },
    { id: "primera-sync", texto: `Atiende sincroniza el calendario de ${nombre}.`, hecho: imp.ultimaSincronizacionExitosaEn !== null, evidencia: evidenciaSync },
    {
      id: "pegar-export",
      texto: `Genera la URL de exportación de Atiende, cópiala y pégala en ${nombre} como calendario a importar.`,
      hecho: exp.estado === "token_sin_consulta" || exp.estado === "consultado",
      evidencia: evidenciaExport,
    },
    {
      id: "canal-consulta",
      texto: `${nombre} consulta el calendario de Atiende.`,
      hecho: exp.estado === "consultado",
      evidencia: exp.ultimoAccesoEn ? `Última consulta de ${nombre}: ${fechaLegible(exp.ultimoAccesoEn)}.` : `${nombre} aún no ha consultado la URL con token${canal.latencia.confianza !== "sin_evidencia" ? ` (latencia declarada: ${canal.latencia.texto})` : ""}.`,
    },
  ];
}
