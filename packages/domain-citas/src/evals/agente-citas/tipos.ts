// Tipos del arnes de evaluacion del agente de WhatsApp de citas (`casos.json`).
// El arnes corre SIN LLM real en CI (agente de referencia guionado + mundo simulado + graders deterministas) y con
// LLM real solo a mano (ver `real.ts`).

export type Negocio = "dental" | "barberia";

export interface CitaCliente {
  readonly id: string;
  readonly provider_id: string;
  readonly service_id: string;
  /** Hora local del negocio, "YYYY-MM-DD HH:MM". */
  readonly local: string;
  readonly status: "confirmed" | "pending" | "completed" | "cancelled" | "no_show";
}

export interface CasoEval {
  readonly id: string;
  readonly categoria: string;
  readonly negocio: Negocio;
  /** Zona IANA del negocio (America/Merida, America/Cancun, America/Mexico_City). */
  readonly tz: string;
  /** "Ahora" del caso, ISO UTC. Fijo: nunca se usa el reloj real. */
  readonly ahora: string;
  readonly cliente: { readonly telefono: string; readonly nombre: string | null; readonly citas: readonly CitaCliente[] };
  /** Horarios libres por proveedor y fecha, en hora local "HH:MM". */
  readonly disponibilidad: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  /** Horarios locales "YYYY-MM-DD HH:MM" que otra persona gana justo antes de crear/reagendar (carrera). */
  readonly carrera?: readonly string[];
  /** Mensajes del cliente, uno por turno. */
  readonly mensajes: readonly string[];
  /** Guion de la referencia: un arreglo de pasos por cada mensaje del cliente. */
  readonly guion: readonly (readonly PasoGuion[])[];
  readonly esperado: Esperado;
  readonly graders: readonly string[];
}

export type PasoGuion =
  | { readonly tool: string; readonly args?: Readonly<Record<string, unknown>> }
  | { readonly say: string };

export interface Esperado {
  readonly resultado: "cita_creada" | "cita_cancelada" | "cita_reagendada" | "cita_modificada" | "sin_cambios" | "crisis" | "arco";
  readonly herramientas_requeridas?: readonly string[];
  readonly herramientas_prohibidas?: readonly string[];
  /** true: el mensaje es una cancelacion urgente y el primer llamado debe forzar buscar_mis_citas. */
  readonly urgente?: boolean;
  /** Fechas (YYYY-MM-DD) permitidas en consultar_disponibilidad (cubre "hoy"/"manana" segun la zona). */
  readonly fechas_consulta?: readonly string[];
  /** Fragmentos (sin acentos, minusculas) que algun mensaje del agente debe contener. */
  readonly texto_debe_contener?: readonly string[];
  /** Fragmentos (sin acentos, minusculas) que ningun mensaje del agente puede contener. */
  readonly no_debe_decir?: readonly string[];
  /** Hora local "HH:MM" que el agente debe haber dicho (zona horaria correcta). */
  readonly hora_local_dicha?: readonly string[];
  /** ISO exacto de la cita final esperada (UTC). */
  readonly cita_final_utc?: string;
  /** Tipo de derecho ARCO que debe quedar registrado ("ninguno" para menu o tercero). */
  readonly arco?: "acceso" | "rectificacion" | "cancelacion" | "oposicion" | "ninguno";
}

export interface SuiteEval {
  readonly suite: string;
  readonly version: string;
  readonly casos: readonly CasoEval[];
}

export type EventoTraza =
  | { readonly t: "cliente"; readonly turno: number; readonly texto: string }
  | { readonly t: "agente"; readonly turno: number; readonly texto: string; readonly origen: "llm" | "guardrail_crisis" | "guardrail_arco" }
  | { readonly t: "tool_choice"; readonly turno: number; readonly nombre: string }
  | { readonly t: "herramienta"; readonly turno: number; readonly nombre: string; readonly args: Readonly<Record<string, unknown>>; readonly resultado: unknown };

export interface EstadoFinal {
  readonly citas: readonly { readonly id: string; readonly provider_id: string; readonly service_id: string; readonly starts_at: string; readonly status: string }[];
  readonly avisosDueno: readonly { readonly tipo: "crisis"; readonly telefono: string }[];
  readonly arcoRegistrados: readonly { readonly derecho: string; readonly telefono: string }[];
}

export interface Traza {
  readonly caso: CasoEval;
  readonly eventos: readonly EventoTraza[];
  readonly estado: EstadoFinal;
}

export interface ResultadoGrader {
  readonly grader: string;
  readonly ok: boolean;
  readonly detalle: string;
}

export interface ResultadoCaso {
  readonly casoId: string;
  readonly ok: boolean;
  readonly graders: readonly ResultadoGrader[];
}
