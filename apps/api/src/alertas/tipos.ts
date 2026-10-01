export type SeveridadAlertaSaliente = "critica" | "alta" | "media";

/** Alerta YA redactada: nada de aqui dentro debe contener secretos ni datos personales. */
export interface AlertaSaliente {
  /** Identificador estable del TIPO de alerta (p. ej. "cron_error:/internal/hoteles/night-audit").
   *  El piso por hora se cuenta por este tipo y por destino. */
  readonly tipo: string;
  readonly severidad: SeveridadAlertaSaliente;
  readonly titulo: string;
  readonly detalle: string;
  readonly href?: string;
  readonly contexto?: Record<string, unknown>;
}

export type CanalAlerta = "correo" | "webhook" | "sentry";
export type EstadoEnvioAlerta = "enviado" | "suprimido_por_limite" | "error";

export interface ResultadoCanalAlerta {
  readonly canal: CanalAlerta;
  readonly destino: string;
  readonly estado: EstadoEnvioAlerta;
  readonly detalle?: string;
}

export interface ResultadoAlerta {
  readonly resultados: readonly ResultadoCanalAlerta[];
}

export interface DespachadorAlertas {
  /** Redacta, aplica el piso por hora por (tipo, destino) y envia por cada canal configurado.
   *  NUNCA lanza ni bloquea mas alla del timeout de cada canal. */
  notificar(alerta: AlertaSaliente): Promise<ResultadoAlerta>;
}
