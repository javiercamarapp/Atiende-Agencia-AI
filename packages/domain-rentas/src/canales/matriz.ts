// Paridad3 Rn-P3-16 -- matriz de conectividad: filas = unidades, columnas = canales con feed iCal. Cada
// celda sale de DATOS REALES (feeds del monitor de sync y tokens de exportación con su último acceso);
// ninguna celda se infiere ni se marca "conectado" a mano. Función pura (sin red ni base).
import { clasificarSaludFeed, type FeedMonitorRecord } from "../sync/monitor.ts";
import type { FeedTokenEstado } from "../sync/tipos.ts";

/** Estado de la mitad "importar" (Atiende lee el iCal del canal). */
export type EstadoImportMatriz = "sin_conectar" | "pendiente" | "ok" | "desactualizado" | "fallando" | "en_cuarentena";
/** Estado de la mitad "exportar" (el canal lee el iCal de Atiende), medido por consultas reales de la OTA al token. */
export type EstadoExportMatriz = "sin_token" | "token_sin_consulta" | "consultado" | "no_disponible_aun";

/** Estado resumido de la celda. */
export type EstadoCeldaMatriz = "conectado" | "solo_import" | "solo_export" | "sin_conectar" | "pendiente" | "fallando" | "en_cuarentena";

export interface UnidadMatriz {
  readonly id: string;
  readonly nombre: string;
}

export interface CeldaMatriz {
  readonly unidadId: string;
  readonly canal: string;
  readonly estado: EstadoCeldaMatriz;
  readonly import: {
    readonly estado: EstadoImportMatriz;
    readonly ultimaSincronizacionExitosaEn: string | null;
    readonly enCuarentenaDesde: string | null;
    readonly motivoCuarentena: string | null;
    readonly intentosFallidosConsecutivos: number;
  };
  readonly export: {
    readonly estado: EstadoExportMatriz;
    readonly tokenCreadoEn: string | null;
    readonly ultimoAccesoEn: string | null;
  };
}

export interface EntradaMatrizConectividad {
  readonly unidades: readonly UnidadMatriz[];
  /** Códigos de canal con feed iCal (columnas), en el orden a mostrar. */
  readonly canales: readonly string[];
  readonly feeds: readonly FeedMonitorRecord[];
  /** `null` = la base todavía no tiene los tokens (migración 037): la exportación se declara "no disponible aún". */
  readonly tokens: readonly FeedTokenEstado[] | null;
  readonly ahoraMs: number;
}

function estadoImport(feed: FeedMonitorRecord | undefined, ahoraMs: number): EstadoImportMatriz {
  if (!feed) return "sin_conectar";
  switch (clasificarSaludFeed(feed, ahoraMs)) {
    case "inactivo":
      return "sin_conectar";
    case "en_cuarentena":
      return "en_cuarentena";
    case "en_backoff":
      return "fallando";
    case "sin_sincronizar":
      return "pendiente";
    case "desactualizado":
      return "desactualizado";
    case "ok":
      return "ok";
  }
}

function resumir(imp: EstadoImportMatriz, exp: EstadoExportMatriz): EstadoCeldaMatriz {
  if (imp === "en_cuarentena") return "en_cuarentena";
  if (imp === "fallando") return "fallando";
  const importa = imp === "ok" || imp === "desactualizado";
  const exporta = exp === "consultado";
  if (importa && exporta) return "conectado";
  if (importa) return "solo_import";
  if (imp === "pendiente") return "pendiente";
  if (exporta) return "solo_export";
  return "sin_conectar";
}

export function calcularMatrizConectividad(entrada: EntradaMatrizConectividad): CeldaMatriz[] {
  const feedPorClave = new Map<string, FeedMonitorRecord>();
  for (const f of entrada.feeds) feedPorClave.set(`${f.unidadId}:${f.canalCodigo}`, f);
  const tokenPorClave = new Map<string, FeedTokenEstado>();
  for (const t of entrada.tokens ?? []) tokenPorClave.set(`${t.unidadId}:${t.canalCodigo}`, t);

  const celdas: CeldaMatriz[] = [];
  for (const unidad of entrada.unidades) {
    for (const canal of entrada.canales) {
      const clave = `${unidad.id}:${canal}`;
      const feed = feedPorClave.get(clave);
      const token = tokenPorClave.get(clave);
      const imp = estadoImport(feed, entrada.ahoraMs);
      const exp: EstadoExportMatriz = entrada.tokens === null ? "no_disponible_aun" : !token ? "sin_token" : token.ultimoAccesoEn ? "consultado" : "token_sin_consulta";
      const activo = feed !== undefined && feed.activo;
      celdas.push({
        unidadId: unidad.id,
        canal,
        estado: resumir(imp, exp),
        import: {
          estado: imp,
          ultimaSincronizacionExitosaEn: activo ? feed.ultimaSincronizacionExitosaEn : null,
          enCuarentenaDesde: activo ? feed.enCuarentenaDesde : null,
          motivoCuarentena: activo ? feed.motivoCuarentena : null,
          intentosFallidosConsecutivos: activo ? feed.intentosFallidosConsecutivos : 0,
        },
        export: { estado: exp, tokenCreadoEn: token?.creadoEn ?? null, ultimoAccesoEn: token?.ultimoAccesoEn ?? null },
      });
    }
  }
  return celdas;
}
