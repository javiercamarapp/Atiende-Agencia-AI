// C-04 -- mensajes de WhatsApp editables: tipos, validacion de lo que un owner/admin puede cambiar, textos por defecto,
// vista previa y diferencias. Todo es PURO (sin base): la API lo usa para validar y previsualizar ANTES de guardar y el
// motor de recordatorios lo usa para armar el mensaje. Mismo patron que `agent-config-editor.ts` de restaurantes (#254),
// sin importar de otra vertical.
//
// Lo editable es texto corto con variables ({{nombre}}, {{hora}}, ...) que se validan contra una lista cerrada: nunca se
// guarda una variable desconocida ni se evalua nada. Los valores de cada variable se insertan en UNA sola pasada (un
// nombre de cliente con "{{" no se vuelve a expandir).

export const MENSAJE_KINDS = ["recordatorio", "confirmacion", "cancelacion", "reagendado"] as const;
export type MensajeKind = (typeof MENSAJE_KINDS)[number];

export const MENSAJE_ETIQUETAS: Readonly<Record<MensajeKind, string>> = {
  recordatorio: "Recordatorio de cita",
  confirmacion: "Confirmación de cita",
  cancelacion: "Cancelación de cita",
  reagendado: "Cita reagendada",
};

export const VARIABLES_BASE = ["nombre", "negocio", "servicio", "profesional", "fecha", "hora", "fecha_hora"] as const;
export type VariableMensaje = (typeof VARIABLES_BASE)[number] | "fecha_anterior";

/** Variables permitidas por tipo de mensaje: `fecha_anterior` solo existe al reagendar. */
export function variablesDe(kind: MensajeKind): readonly VariableMensaje[] {
  return kind === "reagendado" ? [...VARIABLES_BASE, "fecha_anterior"] : VARIABLES_BASE;
}

/** Topes (los mismos CHECK de la migracion 026). */
export const MENSAJE_LIMITES = { texto: 600, anticipacionMin: 1, anticipacionMax: 72, cuerpoWhatsapp: 1024 } as const;
export const ANTICIPACION_POR_OMISION_HORAS = 24;

export interface WhatsappMessageConfig {
  readonly reminderEnabled: boolean;
  readonly reminderText: string | null;
  readonly reminderLeadHours: number;
  readonly confirmationEnabled: boolean;
  readonly confirmationText: string | null;
  readonly cancellationEnabled: boolean;
  readonly cancellationText: string | null;
  readonly rescheduleEnabled: boolean;
  readonly rescheduleText: string | null;
  /** Hora local (0-23) desde la que se puede enviar; `null` = a cualquier hora. */
  readonly sendWindowStart: number | null;
  /** Hora local (1-24) hasta la que se puede enviar (exclusiva). */
  readonly sendWindowEnd: number | null;
}

/** Valores de fabrica: recordatorio activo con el texto de siempre, 24 h antes, a cualquier hora; los demas apagados. */
export const MENSAJES_CONFIG_POR_OMISION: WhatsappMessageConfig = {
  reminderEnabled: true,
  reminderText: null,
  reminderLeadHours: ANTICIPACION_POR_OMISION_HORAS,
  confirmationEnabled: false,
  confirmationText: null,
  cancellationEnabled: false,
  cancellationText: null,
  rescheduleEnabled: false,
  rescheduleText: null,
  sendWindowStart: null,
  sendWindowEnd: null,
};

/** Foto con version, tal como la devuelve el repositorio (`null` = nunca se configuro). */
export interface WhatsappMessageConfigRecord {
  readonly config: WhatsappMessageConfig;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

/** Resultado de guardar: nunca lanza por una base sin migrar ni por quien no es owner/admin. */
export type MensajeConfigGuardado =
  | { readonly status: "saved"; readonly version: number }
  | { readonly status: "conflict" }
  | { readonly status: "forbidden" }
  | { readonly status: "unavailable" };

export interface WhatsappMessageConfigHistoryEntry {
  readonly version: number;
  readonly accion: "actualizado" | "restablecido";
  readonly anterior: Readonly<Record<string, unknown>> | null;
  readonly nuevo: Readonly<Record<string, unknown>>;
  readonly actorId: string | null;
  readonly actorNombre: string | null;
  readonly createdAt: string;
}

// ---- Textos por defecto ----

/** Texto del recordatorio cuando el negocio no escribio uno. Con 24 h es EXACTAMENTE el de siempre (ver
 * `legacyReminderBody`); con otra anticipacion ya no se puede decir "manana", asi que usa la fecha. */
export function textoPorOmision(kind: MensajeKind, leadHours: number = ANTICIPACION_POR_OMISION_HORAS): string {
  switch (kind) {
    case "recordatorio":
      return leadHours === ANTICIPACION_POR_OMISION_HORAS
        ? "Hola {{nombre}}, le recordamos su cita mañana a las {{hora}}. ¿Puede confirmar?"
        : "Hola {{nombre}}, le recordamos su cita el {{fecha}} a las {{hora}}. ¿Puede confirmar?";
    case "confirmacion":
      return "Hola {{nombre}}, su cita de {{servicio}} con {{profesional}} quedó confirmada para el {{fecha_hora}}. ¡Le esperamos en {{negocio}}!";
    case "cancelacion":
      return "Hola {{nombre}}, su cita de {{servicio}} del {{fecha_hora}} en {{negocio}} fue cancelada. Si desea agendar otra, escríbanos.";
    case "reagendado":
      return "Hola {{nombre}}, su cita de {{servicio}} con {{profesional}} cambió de {{fecha_anterior}} a {{fecha_hora}}. ¡Le esperamos en {{negocio}}!";
  }
}

/** Cuerpo del recordatorio con el texto de siempre. La ventana del recordatorio es (ahora, ahora + 24 h], asi que una cita
 * reservada en la madrugada para la tarde del mismo dia tambien cae dentro: `dia` dice "hoy" cuando la cita es del mismo dia
 * LOCAL que el envio y "mañana" en cualquier otro caso (por omision, el texto de siempre). La hora es-MX puede terminar
 * en "p.m." / "a. m.": el punto final se escribe una sola vez. */
export function legacyReminderBody(customerName: string | null, time: string, dia: "hoy" | "mañana" = "mañana"): string {
  const greeting = customerName ? `Hola ${customerName}, ` : "Hola, ";
  return `${greeting}le recordamos su cita ${dia} a las ${time.replace(/\.+$/, "")}. ¿Puede confirmar?`;
}

/** "hoy" si `startsAt` cae en el mismo dia calendario de `timeZone` que `now`; si no, "mañana". */
export function diaDelRecordatorio(startsAt: string, now: Date, timeZone: string): "hoy" | "mañana" {
  const dia = (d: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return dia(new Date(startsAt)) === dia(now) ? "hoy" : "mañana";
}

// ---- Validacion ----

export type ResultadoValidacion<T> = { readonly ok: true; readonly valor: T } | { readonly ok: false; readonly error: string };

// Permite salto de linea (\n); rechaza cualquier otro caracter de control y los separadores de linea/parrafo unicode.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
const PLACEHOLDER = /\{\{\s*([A-Za-z_]+)\s*\}\}/g;

/** Valida UN texto de plantilla. `null`/vacio = usar el texto por defecto. */
export function validarTextoMensaje(raw: unknown, kind: MensajeKind): ResultadoValidacion<string | null> {
  const etiqueta = MENSAJE_ETIQUETAS[kind];
  if (raw === undefined || raw === null) return { ok: true, valor: null };
  if (typeof raw !== "string") return { ok: false, error: `${etiqueta}: se esperaba un texto o null.` };
  const texto = raw.replace(/\r\n?/g, "\n").trim();
  if (texto.length === 0) return { ok: true, valor: null };
  if (texto.length > MENSAJE_LIMITES.texto) return { ok: false, error: `${etiqueta}: máximo ${MENSAJE_LIMITES.texto} caracteres.` };
  if (CONTROL.test(texto)) return { ok: false, error: `${etiqueta}: contiene caracteres no permitidos.` };

  const permitidas = variablesDe(kind) as readonly string[];
  const usadas = new Set<string>();
  for (const m of texto.matchAll(PLACEHOLDER)) {
    const nombre = m[1]!.toLowerCase();
    if (!permitidas.includes(nombre)) {
      return { ok: false, error: `${etiqueta}: la variable {{${m[1]}}} no existe. Usa solo ${permitidas.map((v) => `{{${v}}}`).join(", ")}.` };
    }
    usadas.add(nombre);
  }
  // Llaves sueltas o mal cerradas: tras quitar las variables validas no debe quedar ningun "{{" ni "}}".
  if (/\{\{|\}\}/.test(texto.replace(PLACEHOLDER, ""))) {
    return { ok: false, error: `${etiqueta}: hay una variable mal escrita. El formato es {{nombre}}.` };
  }
  if (kind !== "cancelacion" && !usadas.has("hora") && !usadas.has("fecha_hora")) {
    return { ok: false, error: `${etiqueta}: debe incluir {{hora}} o {{fecha_hora}} para que el cliente sepa cuándo es su cita.` };
  }
  return { ok: true, valor: texto };
}

function booleano(raw: unknown, campo: string, porOmision: boolean): ResultadoValidacion<boolean> {
  if (raw === undefined || raw === null) return { ok: true, valor: porOmision };
  if (typeof raw !== "boolean") return { ok: false, error: `${campo}: se esperaba verdadero o falso.` };
  return { ok: true, valor: raw };
}

function enteroEnRango(raw: unknown, campo: string, min: number, max: number): ResultadoValidacion<number | null> {
  if (raw === undefined || raw === null) return { ok: true, valor: null };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    return { ok: false, error: `${campo}: un número entero entre ${min} y ${max}.` };
  }
  return { ok: true, valor: raw };
}

/** Valida el cuerpo de un guardado o de una vista previa. Todo campo ausente toma el valor de fabrica. */
export function validarConfigMensajes(raw: unknown): ResultadoValidacion<WhatsappMessageConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "El cuerpo debe ser un objeto." };
  const r = raw as Record<string, unknown>;

  const textos = {
    reminderText: validarTextoMensaje(r.reminderText, "recordatorio"),
    confirmationText: validarTextoMensaje(r.confirmationText, "confirmacion"),
    cancellationText: validarTextoMensaje(r.cancellationText, "cancelacion"),
    rescheduleText: validarTextoMensaje(r.rescheduleText, "reagendado"),
  };
  for (const t of Object.values(textos)) if (!t.ok) return t;

  const banderas = {
    reminderEnabled: booleano(r.reminderEnabled, "reminderEnabled", true),
    confirmationEnabled: booleano(r.confirmationEnabled, "confirmationEnabled", false),
    cancellationEnabled: booleano(r.cancellationEnabled, "cancellationEnabled", false),
    rescheduleEnabled: booleano(r.rescheduleEnabled, "rescheduleEnabled", false),
  };
  for (const b of Object.values(banderas)) if (!b.ok) return b;

  const anticipacion = enteroEnRango(r.reminderLeadHours, "reminderLeadHours", MENSAJE_LIMITES.anticipacionMin, MENSAJE_LIMITES.anticipacionMax);
  if (!anticipacion.ok) return anticipacion;
  const inicio = enteroEnRango(r.sendWindowStart, "sendWindowStart", 0, 23);
  if (!inicio.ok) return inicio;
  const fin = enteroEnRango(r.sendWindowEnd, "sendWindowEnd", 1, 24);
  if (!fin.ok) return fin;
  if ((inicio.valor === null) !== (fin.valor === null)) return { ok: false, error: "El horario de envío necesita hora de inicio y de fin." };
  if (inicio.valor !== null && fin.valor !== null && fin.valor <= inicio.valor) {
    return { ok: false, error: "Horario de envío: la hora de fin debe ser mayor que la de inicio." };
  }

  const v = <T>(x: ResultadoValidacion<T>): T => (x as { valor: T }).valor;
  return {
    ok: true,
    valor: {
      reminderEnabled: v(banderas.reminderEnabled),
      reminderText: v(textos.reminderText),
      reminderLeadHours: anticipacion.valor ?? ANTICIPACION_POR_OMISION_HORAS,
      confirmationEnabled: v(banderas.confirmationEnabled),
      confirmationText: v(textos.confirmationText),
      cancellationEnabled: v(banderas.cancellationEnabled),
      cancellationText: v(textos.cancellationText),
      rescheduleEnabled: v(banderas.rescheduleEnabled),
      rescheduleText: v(textos.rescheduleText),
      sendWindowStart: inicio.valor,
      sendWindowEnd: fin.valor,
    },
  };
}

// ---- Armado y vista previa ----

export type ValoresMensaje = Readonly<Partial<Record<VariableMensaje, string>>>;

// eslint-disable-next-line no-control-regex
const CONTROL_EN_VALOR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Limpia un valor que viene de datos de un cliente (nombre): sin controles, sin llaves y acotado. */
export function sanitizarValor(valor: string | null | undefined, max = 80): string {
  return (valor ?? "").replace(CONTROL_EN_VALOR, " ").replace(/[{}]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Sustituye las variables en UNA pasada. Una variable sin valor queda vacia. El resultado se acota al limite del cuerpo
 * de WhatsApp (1024). */
export function renderizarMensaje(plantilla: string, valores: ValoresMensaje): string {
  const lleno = plantilla.replace(PLACEHOLDER, (_m, nombre: string) => valores[nombre.toLowerCase() as VariableMensaje] ?? "");
  return lleno.replace(/[ \t]+\n/g, "\n").trim().slice(0, MENSAJE_LIMITES.cuerpoWhatsapp);
}

/** Plantilla efectiva de un tipo: la del negocio o la de fabrica. */
export function plantillaEfectiva(config: WhatsappMessageConfig, kind: MensajeKind): string {
  return textoPropio(config, kind) ?? textoPorOmision(kind, config.reminderLeadHours);
}

/** El texto que escribio el negocio, o `null` si usa el de fabrica. */
export function textoPropio(config: WhatsappMessageConfig, kind: MensajeKind): string | null {
  return kind === "recordatorio" ? config.reminderText : kind === "confirmacion" ? config.confirmationText : kind === "cancelacion" ? config.cancellationText : config.rescheduleText;
}

export function mensajeActivo(config: WhatsappMessageConfig, kind: MensajeKind): boolean {
  switch (kind) {
    case "recordatorio":
      return config.reminderEnabled;
    case "confirmacion":
      return config.confirmationEnabled;
    case "cancelacion":
      return config.cancellationEnabled;
    case "reagendado":
      return config.rescheduleEnabled;
  }
}

/** Valores de muestra fijos para la vista previa (nunca datos reales de clientes). */
export const VALORES_DE_MUESTRA: Required<ValoresMensaje> = {
  nombre: "María",
  negocio: "Clínica Sol",
  servicio: "Consulta general",
  profesional: "Dra. López",
  fecha: "jueves 2 de octubre",
  hora: "10:00 a. m.",
  fecha_hora: "jueves 2 de octubre, 10:00 a. m.",
  fecha_anterior: "miércoles 1 de octubre, 4:00 p. m.",
};

export interface VistaPreviaMensaje {
  readonly kind: MensajeKind;
  readonly activo: boolean;
  readonly texto: string;
  readonly esPorDefecto: boolean;
}

/** Los cuatro mensajes tal como los veria un cliente con valores de muestra. Solo lectura. */
export function previewMensajes(config: WhatsappMessageConfig): readonly VistaPreviaMensaje[] {
  return MENSAJE_KINDS.map((kind) => {
    const usaLegacy = kind === "recordatorio" && !config.reminderText && config.reminderLeadHours === ANTICIPACION_POR_OMISION_HORAS;
    const texto = usaLegacy
      ? legacyReminderBody(VALORES_DE_MUESTRA.nombre, VALORES_DE_MUESTRA.hora)
      : renderizarMensaje(plantillaEfectiva(config, kind), VALORES_DE_MUESTRA);
    return { kind, activo: mensajeActivo(config, kind), texto, esPorDefecto: textoPropio(config, kind) === null };
  });
}

// ---- Horario de envio ----

/** Hora local (0-23) de `date` en `timeZone`. */
export function horaLocal(date: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(date));
}

/** `true` si ahora se puede enviar: sin horario siempre; con horario, solo si la hora local cae en [inicio, fin). */
export function dentroDelHorarioDeEnvio(config: Pick<WhatsappMessageConfig, "sendWindowStart" | "sendWindowEnd">, now: Date, timeZone: string): boolean {
  if (config.sendWindowStart === null || config.sendWindowEnd === null) return true;
  const hora = horaLocal(now, timeZone);
  return hora >= config.sendWindowStart && hora < config.sendWindowEnd;
}

const HORA_MS = 60 * 60 * 1000;

/** Ventana de citas candidatas a recordatorio (C-14): desde AHORA hasta ahora + la anticipacion configurada (24 h de
 * fabrica). Antes era `ahora + anticipacion +- 30 min`: con el cron diario de las 14:00 UTC solo alcanzaba a las citas de
 * una hora del dia, y una cita reservada con menos de 24 h de aviso nunca entraba. Ahora cada cita entra a la ventana en
 * cuanto faltan `reminderLeadHours` y se queda hasta que empieza, asi que da igual la cadencia del cron (diaria o cada 30
 * min): ninguna cita queda entre dos corridas. El dedupe es `reminder_24h_sent_at` + la clave del outbox, no la ventana, de
 * modo que ensancharla no puede enviar dos veces. Nunca incluye citas que ya empezaron. Es una ventana de INSTANTES
 * absolutos: no depende de ninguna zona horaria (la zona de la sucursal solo decide la hora que se muestra y el horario de
 * envio, ver `dentroDelHorarioDeEnvio`). Las horas en que el horario de envio esta cerrado no necesitan ampliarla: la cita
 * sigue pendiente en cada corrida hasta que una cae dentro del horario. */
export function ventanaDeRecordatorio(now: Date, config: Pick<WhatsappMessageConfig, "reminderLeadHours">): { readonly from: Date; readonly to: Date } {
  return { from: now, to: new Date(now.getTime() + config.reminderLeadHours * HORA_MS) };
}

/** Una cita reservada hace menos de esto no recibe el recordatorio todavia: en cuanto se reserva ya esta en la ventana y
 * el aviso llegaria pegado a la propia reserva. La siguiente corrida la recoge. */
export const ANTIGUEDAD_MINIMA_RESERVA_MS = HORA_MS;

/** `true` si la cita se reservo hace menos de `ANTIGUEDAD_MINIMA_RESERVA_MS` (sin fecha de reserva o fechada en el futuro
 * no cuenta como reciente). */
export function reservaMuyReciente(createdAtIso: string | null | undefined, now: Date): boolean {
  if (!createdAtIso) return false;
  const edad = now.getTime() - Date.parse(createdAtIso);
  return Number.isFinite(edad) && edad >= 0 && edad < ANTIGUEDAD_MINIMA_RESERVA_MS;
}

// ---- Historial y diferencias ----

const ETIQUETAS_CAMPO: Readonly<Record<string, string>> = {
  reminderEnabled: "Recordatorio activo",
  reminderText: "Texto del recordatorio",
  reminderLeadHours: "Anticipación del recordatorio (horas)",
  confirmationEnabled: "Aviso de confirmación activo",
  confirmationText: "Texto de la confirmación",
  cancellationEnabled: "Aviso de cancelación activo",
  cancellationText: "Texto de la cancelación",
  rescheduleEnabled: "Aviso de reagendado activo",
  rescheduleText: "Texto del reagendado",
  sendWindowStart: "Enviar desde (hora)",
  sendWindowEnd: "Enviar hasta (hora)",
};

export interface DiferenciaCampo {
  readonly campo: string;
  readonly antes: string;
  readonly despues: string;
}

/** Foto de los campos editables (la misma forma que guarda el historial en la base). */
export function fotoConfigMensajes(config: WhatsappMessageConfig): Record<string, unknown> {
  return {
    reminderEnabled: config.reminderEnabled,
    reminderText: config.reminderText,
    reminderLeadHours: config.reminderLeadHours,
    confirmationEnabled: config.confirmationEnabled,
    confirmationText: config.confirmationText,
    cancellationEnabled: config.cancellationEnabled,
    cancellationText: config.cancellationText,
    rescheduleEnabled: config.rescheduleEnabled,
    rescheduleText: config.rescheduleText,
    sendWindowStart: config.sendWindowStart,
    sendWindowEnd: config.sendWindowEnd,
  };
}

function comoTexto(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "si" : "no";
  return String(v);
}

/** Campos que cambian entre dos fotos (`antes` = `null` si nunca se configuro: se compara contra los valores de fabrica). */
export function diferenciasConfigMensajes(antes: Readonly<Record<string, unknown>> | null, despues: Readonly<Record<string, unknown>>): readonly DiferenciaCampo[] {
  const base = antes ?? fotoConfigMensajes(MENSAJES_CONFIG_POR_OMISION);
  const out: DiferenciaCampo[] = [];
  for (const campo of Object.keys(ETIQUETAS_CAMPO)) {
    const a = comoTexto(base[campo]);
    const d = comoTexto(despues[campo]);
    if (a !== d) out.push({ campo: ETIQUETAS_CAMPO[campo]!, antes: a, despues: d });
  }
  return out;
}

/** Convierte una foto del historial (jsonb) en una configuracion, rellenando con los valores de fabrica lo que falte. */
export function configDesdeFoto(foto: Readonly<Record<string, unknown>>): WhatsappMessageConfig {
  const valido = validarConfigMensajes(foto);
  return valido.ok ? valido.valor : MENSAJES_CONFIG_POR_OMISION;
}
