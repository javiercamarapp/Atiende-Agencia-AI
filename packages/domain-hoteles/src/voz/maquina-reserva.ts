// Maquina de estados de la RESERVA por voz (defensa en profundidad: el servidor y la base vuelven a aplicar todo). Impide, por llamada, las acciones
// sin el paso previo que las justifica:
//   * `crear_pre_reserva` solo despues de `cotizar_estancia` OK del MISMO tipo y fechas, y con el total EXACTO cotizado (la base lo vuelve a contrastar);
//   * una sola pre-reserva por llamada: otra habitacion o un grupo pasa a una persona (`derivar_a_humano`);
//   * `cancelar_pre_reserva` solo de una pre-reserva que se vio (`estado_pre_reserva`) o se creo en esta misma llamada.
// Estados: sin_cotizar -> cotizada -> apartada. Nunca confirma una reserva: el agente solo aparta (hold) y una persona aprueba o el pago confirma.
export type EstadoReservaVoz = "sin_cotizar" | "cotizada" | "apartada";

export interface CotizacionVoz {
  readonly tipoHabitacionId: string;
  readonly fechaLlegada: string;
  readonly fechaSalida: string;
  readonly totalCentavos: number;
}

export interface RechazoMaquina {
  readonly error: string;
  readonly mensaje: string;
}

type Args = Readonly<Record<string, unknown>>;

export class MaquinaReservaVoz {
  private cotizacion: CotizacionVoz | null = null;
  private preReservaId: string | null = null;
  private readonly vistas = new Set<string>();

  get estado(): EstadoReservaVoz {
    return this.preReservaId ? "apartada" : this.cotizacion ? "cotizada" : "sin_cotizar";
  }

  /** Rechazo si la herramienta no procede todavia; null si puede correr. */
  guardia(nombre: string, args: Args): RechazoMaquina | null {
    if (nombre === "crear_pre_reserva") {
      if (this.preReservaId) {
        return { error: "una_pre_reserva_por_llamada", mensaje: "Ya hay una pre-reserva en esta llamada. Para otra habitación o un grupo, use derivar_a_humano." };
      }
      const c = this.cotizacion;
      if (!c) {
        return { error: "falta_cotizacion", mensaje: "Cotice el tipo de cuarto con cotizar_estancia y pida al huésped que acepte el total exacto antes de apartar." };
      }
      if (args.tipo_habitacion_id !== c.tipoHabitacionId || args.fecha_llegada !== c.fechaLlegada || args.fecha_salida !== c.fechaSalida) {
        return { error: "cotizacion_distinta", mensaje: "El tipo de cuarto o las fechas no son los que se cotizaron. Vuelva a cotizar con cotizar_estancia antes de apartar." };
      }
      if (args.total_cotizado_centavos !== c.totalCentavos) {
        return { error: "total_distinto", mensaje: "El total no es el cotizado. Use exactamente el total_centavos de la cotización que el huésped aceptó." };
      }
      return null;
    }
    if (nombre === "cancelar_pre_reserva") {
      const id = args.pre_reserva_id;
      if (typeof id !== "string" || !(id === this.preReservaId || this.vistas.has(id))) {
        return { error: "falta_ver_estado", mensaje: "Consulte primero la pre-reserva con estado_pre_reserva y confirme con el huésped que desea cancelarla." };
      }
      return null;
    }
    return null;
  }

  /** La herramienta corrio (`ok` = el servidor no devolvio un error): avanza el estado. */
  alResultado(nombre: string, args: Args, resultado: unknown, ok: boolean): void {
    if (!ok) return;
    const r = (typeof resultado === "object" && resultado !== null ? resultado : {}) as Record<string, unknown>;
    if (nombre === "cotizar_estancia") {
      const cot = (r.cotizacion ?? null) as { estado?: unknown; total_centavos?: unknown } | null;
      const valida = cot?.estado === "ok" && typeof cot.total_centavos === "number" && typeof args.tipo_habitacion_id === "string" && typeof args.fecha_llegada === "string" && typeof args.fecha_salida === "string";
      this.cotizacion = valida
        ? { tipoHabitacionId: args.tipo_habitacion_id as string, fechaLlegada: args.fecha_llegada as string, fechaSalida: args.fecha_salida as string, totalCentavos: cot.total_centavos as number }
        : null;
    } else if (nombre === "crear_pre_reserva" && typeof r.pre_reserva_id === "string") {
      this.preReservaId = r.pre_reserva_id;
      this.cotizacion = null;
    } else if (nombre === "estado_pre_reserva" && typeof r.pre_reserva_id === "string") {
      this.vistas.add(r.pre_reserva_id);
    } else if (nombre === "cancelar_pre_reserva" && typeof r.pre_reserva_id === "string") {
      if (this.preReservaId === r.pre_reserva_id) this.preReservaId = null;
      this.vistas.delete(r.pre_reserva_id);
    }
  }
}
