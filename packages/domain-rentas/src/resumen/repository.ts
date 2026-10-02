// Rn-26 -- lecturas agregadas (solo conteos y marcas de tiempo, jamás PII de huéspedes) del Resumen operativo de
// rentas. Cada método devuelve `null` cuando la base todavía no tiene la tabla/columna que consulta (migración
// pendiente): el HTTP lo traduce a "no disponible" por bloque y el resto del Resumen carga igual.
export interface LlegadasSalidasHoy {
  readonly llegadas: number;
  readonly salidas: number;
}

export interface BorradoresResumen {
  /** Borradores de mensajería en `pendiente_aprobacion` (cola de aprobación humana). */
  readonly pendientes: number;
  /** Último borrador generado por el agente LLM (`generado_por = 'agente_llm'`), o `null` si nunca hubo uno. */
  readonly ultimoBorradorIaEn: string | null;
}

export interface TareasResumen {
  /** Tareas de limpieza/mantenimiento/inspección sin completar ni cancelar. */
  readonly pendientes: number;
  /** De las anteriores, las que ya pasaron su SLA. */
  readonly vencidas: number;
  /** Creación de la última tarea nacida de un checkout (la genera el barrido automático), o `null`. */
  readonly ultimaTareaPorCheckoutEn: string | null;
}

export interface AccesoResumen {
  readonly politicaActiva: boolean;
  /** Última liberación automática de instrucciones de acceso, o `null`. */
  readonly ultimaLiberacionEn: string | null;
}

export interface RentasResumenRepository {
  /** Reservas confirmadas que llegan (`lower(rango) = fecha`) y salen (`upper(rango) = fecha`) en la fecha de calendario dada. */
  llegadasSalidas(propertyId: string, fecha: string): Promise<LlegadasSalidasHoy | null>;
  borradores(propertyId: string): Promise<BorradoresResumen | null>;
  tareas(propertyId: string, ahoraIso: string): Promise<TareasResumen | null>;
  acceso(propertyId: string): Promise<AccesoResumen | null>;
}
