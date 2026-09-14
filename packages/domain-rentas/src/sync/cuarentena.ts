// Cuarentena de feed inaccesible/vacío/malformado — port literal de
// rentas/packages/adapters/src/sync/cuarentena.ts (repo origen, D-005, H-031).
// Funciones puras: nunca liberan noches, nunca interpretan un fallo como "el canal
// remoto no tiene reservas" — el último estado válido se congela y se emite alerta al
// superar un umbral de intentos. El software (rentas) es SIEMPRE la fuente de verdad;
// la sincronización es best-effort, nunca bloqueante (mismo principio que
// domain-citas/calendar-sync.ts para Google Calendar).

export type ResultadoCicloFetch = "exito_con_eventos" | "exito_vacio" | "fallo_red" | "fallo_parseo" | "no_modificado";

export interface EstadoFeedCanal {
  ultimaSincronizacionExitosaEn: string | null;
  enCuarentenaDesde: string | null;
  intentosFallidosConsecutivos: number;
  motivoCuarentena: string | null;
}

export const ESTADO_FEED_INICIAL: EstadoFeedCanal = {
  ultimaSincronizacionExitosaEn: null,
  enCuarentenaDesde: null,
  intentosFallidosConsecutivos: 0,
  motivoCuarentena: null,
};

export interface AlertaCuarentena {
  tipo: "cuarentena_activada" | "vacio_inesperado" | "cuarentena_persistente";
  motivo: string;
}

export interface ResultadoAplicarCiclo {
  estado: EstadoFeedCanal;
  alerta: AlertaCuarentena | null;
}

export interface OpcionesCuarentena {
  /** Nº de fallos consecutivos antes de declarar cuarentena. */
  umbralIntentosFallidos: number;
  /** Si `true`, un feed que parsea correctamente con 0 eventos, cuando previamente SÍ
   * tenía eventos activos de ese canal, genera una alerta informativa ("vacío
   * confirmado" es una señal distinta de fallo, pero igual de digna de revisión si es
   * inesperada). */
  huboEventosActivosPreviamente: boolean;
}

export const OPCIONES_CUARENTENA_POR_DEFECTO: OpcionesCuarentena = {
  umbralIntentosFallidos: 3,
  huboEventosActivosPreviamente: false,
};

export function aplicarResultadoCiclo(
  estado: EstadoFeedCanal,
  resultado: ResultadoCicloFetch,
  ahoraIso: string,
  opciones: OpcionesCuarentena = OPCIONES_CUARENTENA_POR_DEFECTO,
): ResultadoAplicarCiclo {
  if (resultado === "fallo_red" || resultado === "fallo_parseo") {
    const intentos = estado.intentosFallidosConsecutivos + 1;
    const yaEnCuarentena = estado.enCuarentenaDesde !== null;
    const cruzaUmbral = intentos >= opciones.umbralIntentosFallidos;

    const nuevoEstado: EstadoFeedCanal = {
      ...estado,
      intentosFallidosConsecutivos: intentos,
      enCuarentenaDesde: yaEnCuarentena ? estado.enCuarentenaDesde : cruzaUmbral ? ahoraIso : null,
      motivoCuarentena: cruzaUmbral ? `${intentos} intentos consecutivos de ${resultado === "fallo_red" ? "fetch" : "parseo"} fallidos` : estado.motivoCuarentena,
    };

    let alerta: AlertaCuarentena | null = null;
    if (cruzaUmbral && !yaEnCuarentena) {
      alerta = { tipo: "cuarentena_activada", motivo: nuevoEstado.motivoCuarentena! };
    } else if (yaEnCuarentena) {
      alerta = { tipo: "cuarentena_persistente", motivo: `feed sigue en cuarentena tras ${intentos} intentos` };
    }

    return { estado: nuevoEstado, alerta };
  }

  if (resultado === "no_modificado") {
    // ETag/304: sync exitosa sin cambios; resetea el contador de fallos pero no toca
    // `enCuarentenaDesde` salvo que ya no aplique.
    return {
      estado: { ...estado, ultimaSincronizacionExitosaEn: ahoraIso, intentosFallidosConsecutivos: 0, enCuarentenaDesde: null, motivoCuarentena: null },
      alerta: null,
    };
  }

  // exito_con_eventos | exito_vacio: sale de cuarentena, resetea contador.
  const nuevoEstado: EstadoFeedCanal = {
    ultimaSincronizacionExitosaEn: ahoraIso,
    enCuarentenaDesde: null,
    intentosFallidosConsecutivos: 0,
    motivoCuarentena: null,
  };

  let alerta: AlertaCuarentena | null = null;
  if (resultado === "exito_vacio" && opciones.huboEventosActivosPreviamente) {
    alerta = { tipo: "vacio_inesperado", motivo: "el feed parseó correctamente con 0 eventos, pero este canal normalmente tiene eventos activos" };
  }

  return { estado: nuevoEstado, alerta };
}
