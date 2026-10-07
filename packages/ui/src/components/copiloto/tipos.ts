// Contrato de UI del Copiloto "Chatea con tus datos" (ChatDatosShell). Duplica a proposito la forma de
// DataChatAnswer del motor (agent-core/src/data-chat/types.ts) para que packages/ui NO dependa de
// agent-core: el transporte de cada vertical traduce la respuesta del servidor a estos tipos.
// El shell no tiene datos propios: todo lo que muestra llega por el transporte.

export type CopilotoColumnaTipo = "text" | "integer" | "mxn" | "percent" | "decimal";
export type CopilotoCelda = string | number | null;

export interface CopilotoColumna {
  readonly key: string;
  readonly label: string;
  readonly kind: CopilotoColumnaTipo;
}

export interface CopilotoBloque {
  readonly tool: string;
  readonly title: string;
  readonly columns: readonly CopilotoColumna[];
  readonly rows: readonly Readonly<Record<string, CopilotoCelda>>[];
  /** Representacion que el CATALOGO eligio para este bloque (nunca el modelo). Si los datos no alcanzan para
   *  dibujarla, el bloque se muestra como tabla. `kpi`: 1 fila con 1-4 columnas numericas. */
  readonly chart?: { readonly kind: "bar" | "line" | "donut" | "kpi"; readonly x: string; readonly y: string };
  /** Mini serie por fila (`series[i]` es de `rows[i]`): se dibuja como sparkline en una columna extra. */
  readonly sparkline?: { readonly label: string; readonly series: readonly (readonly number[])[] };
  readonly truncated: boolean;
}

export interface CopilotoFuente {
  readonly tool: string;
  readonly source: string;
  readonly periodLabel?: string;
  readonly scopeLabel: string;
}

/** Estados del servidor mas dos de transporte: `apagado` (interruptor de plataforma) y `forbidden` (403 de rol). */
export type CopilotoStatus =
  | "ok"
  | "no_data"
  | "clarify"
  | "out_of_catalog"
  | "rate_limited"
  | "budget_exceeded"
  | "unavailable"
  | "invalid_input"
  | "apagado"
  | "forbidden";

export interface CopilotoRespuesta {
  readonly text: string;
  readonly status: CopilotoStatus;
  readonly blocks?: readonly CopilotoBloque[];
  readonly sources?: readonly CopilotoFuente[];
  /** Posicion del mensaje en la conversacion guardada (habilita PDF y fijar). */
  readonly seq?: number;
  /** `out_of_catalog`: preguntas que si se pueden consultar (se ofrecen como chips). */
  readonly sugerencias?: readonly string[];
  /** `rate_limited`: segundos de espera. */
  readonly reintentarEnSeg?: number;
  /** `rate_limited` por tope diario: cuantas preguntas permite el dia. */
  readonly limiteDiario?: number;
}

export type CopilotoEvento =
  | { readonly t: "paso"; readonly fase: "inicio" | "fin"; readonly herramienta: string }
  | { readonly t: "fin"; readonly respuesta: CopilotoRespuesta; readonly conversacionId?: string; readonly seq?: number }
  | { readonly t: "error"; readonly status: CopilotoStatus; readonly mensaje: string; readonly reintentarEnSeg?: number };

export interface ConversacionResumen {
  readonly id: string;
  readonly titulo: string;
  /** ISO 8601. */
  readonly actualizadaEn: string;
  readonly fijada?: boolean;
}

export interface CopilotoMensaje {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly status?: CopilotoStatus;
  readonly blocks?: readonly CopilotoBloque[];
  readonly sources?: readonly CopilotoFuente[];
  readonly seq?: number;
  readonly sugerencias?: readonly string[];
  readonly reintentarEnSeg?: number;
  readonly limiteDiario?: number;
  /** El usuario detuvo el turno: no se guarda en el servidor. */
  readonly cancelado?: boolean;
}

export interface ConversacionCompleta {
  readonly id: string;
  readonly titulo: string;
  readonly mensajes: readonly CopilotoMensaje[];
}

/** Consulta DIRECTA de un chip o tarjeta: una herramienta del catalogo cerrado con argumentos tipados (p. ej. el periodo),
 *  que el servidor ejecuta SIN llamar al modelo. El texto del chip es solo la etiqueta del mensaje; el servidor valida todo. */
export interface CopilotoDirecta {
  readonly tool: string;
  readonly args?: Readonly<Record<string, string | number>>;
}

/** "Adjuntar archivo": el transporte lo ofrece solo si su servidor tiene la ruta (CSV / Excel / PDF analizados en el backend, sin guardar el archivo). */
export interface CopilotoAdjuntosConfig {
  /** Valor del atributo `accept` del selector de archivos (extensiones permitidas, p. ej. ".csv,.xlsx,.pdf"). */
  readonly accept: string;
  /** Tamano maximo en bytes: el shell lo comprueba ANTES de subir (el servidor lo vuelve a comprobar). */
  readonly maxBytes: number;
}

export interface CopilotoTransporte {
  /** Envia una pregunta. Debe reportar `paso`/`fin`/`error` por `onEvento` (NDJSON) y/o devolver la respuesta final.
   *  Con `directa`, `pregunta` es la etiqueta del chip y la consulta se resuelve sin modelo. */
  enviar(p: {
    pregunta: string;
    conversacionId?: string;
    directa?: CopilotoDirecta;
    /** Archivo adjunto (solo si el transporte declara `adjuntos`): el servidor lo analiza y responde con el perfil del archivo; `pregunta` es la etiqueta del mensaje. */
    adjunto?: File;
    senal: AbortSignal;
    onEvento: (e: CopilotoEvento) => void;
  }): Promise<CopilotoRespuesta>;
  /** Sin `adjuntos`, el compositor no muestra el clip (nunca un boton que no hace nada). */
  readonly adjuntos?: CopilotoAdjuntosConfig;
  /** Sin `listar`, el boton Historial no se muestra (no hay historial persistido que ofrecer). */
  listar?(senal: AbortSignal): Promise<readonly ConversacionResumen[]>;
  abrir?(id: string, senal: AbortSignal): Promise<ConversacionCompleta>;
  renombrar?(id: string, titulo: string): Promise<void>;
  borrar?(id: string): Promise<void>;
  /** URL de GET del servidor que descarga el PDF del mensaje (solo sirve si NO exige un token en la cabecera). */
  urlPdf?(conversacionId: string, seq: number): string;
  /** Pide al servidor el reporte PDF del mensaje (con la sesion del usuario) y lo descarga. Rechaza con un `Error` cuyo
   *  `message` ya es legible para el usuario. Sin `urlPdf` ni `descargarPdf` no se ofrece "Descargar PDF". */
  descargarPdf?(conversacionId: string, seq: number): Promise<void>;
  /** Fija el primer bloque del mensaje en el tablero. Sin ella, no se ofrece "Fijar". */
  fijar?(conversacionId: string, seq: number, bloque: number): Promise<void>;
}

/** Error que un transporte puede lanzar para que el shell muestre el aviso del `status` correcto. */
export class CopilotoErrorTransporte extends Error {
  readonly status: CopilotoStatus;
  readonly reintentarEnSeg?: number;
  constructor(status: CopilotoStatus, mensaje: string = status, reintentarEnSeg?: number) {
    super(mensaje);
    this.name = "CopilotoErrorTransporte";
    this.status = status;
    if (reintentarEnSeg !== undefined) this.reintentarEnSeg = reintentarEnSeg;
  }
}

export interface CopilotoTextos {
  readonly titulo: string;
  readonly subtitulo: string;
  readonly nota: string;
  readonly placeholder: string;
  /** Fases del "pensando" por tiempo transcurrido: [milisegundos, texto]. */
  readonly fases: ReadonlyArray<readonly [number, string]>;
  /** Ej. "Sucursal: Centro" / "Todas tus sucursales". */
  readonly contexto?: string;
}

export interface CopilotoCategoria {
  readonly titulo: string;
  readonly preguntas: readonly string[];
}

// ---------------------------------------------------------------------------------------------------------------
// Acciones propuestas (CHAT-17, solo Copiloto de superadmin). El modelo SOLO propone: la tarjeta pide confirmacion humana (con motivo y
// verificacion MFA) y quien ejecuta es el servidor. Las verticales no pasan `acciones` y nunca ven una tarjeta.
// ---------------------------------------------------------------------------------------------------------------

export type CopilotoAccionEstado = "pendiente" | "ejecutada" | "fallida" | "cancelada" | "vencida" | "archivada";

/** Lo que viaja en el bloque `proponer_accion` de la respuesta (una fila). */
export interface CopilotoAccionPropuesta {
  readonly propuesta: string;
  readonly clase: "intent" | "interruptor";
  readonly tipo: string;
  /** Solo `interruptor`: rol del agente. */
  readonly agente?: string;
  /** Efecto legible calculado por el servidor (nunca por el modelo). */
  readonly resumen: string;
}

export interface CopilotoAccionVista {
  readonly estado: CopilotoAccionEstado;
  readonly resumen: string;
  readonly tipo: string;
}

export type CopilotoAccionFalla = "stepup_cancelado" | "conflicto" | "motivo" | "no_disponible" | "error";

/** Error que un cliente de acciones lanza para que la tarjeta muestre el aviso honesto correcto. */
export class CopilotoAccionError extends Error {
  readonly tipo: CopilotoAccionFalla;
  constructor(tipo: CopilotoAccionFalla, mensaje: string = tipo) {
    super(mensaje);
    this.name = "CopilotoAccionError";
    this.tipo = tipo;
  }
}

export interface CopilotoAccionesCliente {
  /** Estado vigente de la propuesta en el servidor (al montar la tarjeta y al reabrir una conversacion). */
  consultar(p: CopilotoAccionPropuesta, senal: AbortSignal): Promise<CopilotoAccionVista>;
  /** Confirma. Pide la verificacion MFA ANTES de enviar nada si hace falta; si la persona la cancela rechaza con `stepup_cancelado` sin haber enviado la confirmacion.
   *  `motivo` solo aplica a `interruptor` (20 caracteres como minimo). */
  confirmar(p: CopilotoAccionPropuesta, motivo: string): Promise<{ readonly estado: "ejecutada" | "fallida"; readonly mensaje?: string }>;
  /** Ruta interna de la bandeja de pendientes ("Ver pendientes"). */
  readonly enlacePendientes: string;
}

export interface ChatDatosShellProps {
  /** `pagina` (por defecto) llena la pagina; `panel` es la composicion compacta del panel lateral (400 px). */
  readonly variante?: "pagina" | "panel";
  /** Solo Copiloto de superadmin: con esto, los bloques `proponer_accion` se dibujan como tarjeta de accion. */
  readonly acciones?: CopilotoAccionesCliente;
  readonly transporte: CopilotoTransporte;
  readonly textos: CopilotoTextos;
  /** Chips en reposo (maximo 5). */
  readonly sugerencias: readonly string[];
  /** Tarjetas de la portada (3, como atiende-restaurantes). */
  readonly categorias: readonly CopilotoCategoria[];
  /** Texto exacto de un chip o pregunta de tarjeta -> consulta directa (sin modelo). Lo que no esta aqui pasa por el modelo. */
  readonly directas?: Readonly<Record<string, CopilotoDirecta>>;
  /** Nombre visible de cada herramienta del catalogo (para los pasos "en vivo"). */
  readonly etiquetasHerramienta: Readonly<Record<string, string>>;
  /** Herramienta -> ruta interna de la pantalla fuente (lista blanca: solo rutas que empiezan con "/"). */
  readonly rutasFuente?: Readonly<Record<string, string>>;
  readonly maxCaracteres: number;
  /** Vertical (p. ej. "restaurantes"): solo se usa para nombrar los archivos CSV descargados. */
  readonly vertical?: string;
  readonly uso?: { readonly pct: number; readonly etiqueta: string };
  readonly conversacionInicial?: string;
  readonly onConversacionCambia?: (id?: string) => void;
  /** Zona horaria IANA de la organizacion para agrupar el historial por dia. Por defecto, la del navegador. */
  readonly zonaHoraria?: string;
  /** Reloj inyectable (pruebas). */
  readonly ahora?: () => Date;
}

// ---------------------------------------------------------------------------------------------------------------
// Fijados (CHAT-15): resultados del Copiloto fijados en el tablero. El servidor guarda herramienta + argumentos (no cifras) y
// los RE-EJECUTA sin modelo al abrir el tablero, con el alcance actual del usuario.
// ---------------------------------------------------------------------------------------------------------------

export interface FijadoResumen {
  readonly id: string;
  readonly titulo: string;
  readonly herramienta: string;
  readonly compartido: boolean;
  /** true = el usuario actual es el autor (puede quitarlo o compartirlo). */
  readonly propio: boolean;
}

export interface FijadoResultado {
  readonly id: string;
  readonly titulo: string;
  readonly status: CopilotoStatus;
  readonly text: string;
  readonly blocks: readonly CopilotoBloque[];
  readonly sources: readonly CopilotoFuente[];
}

export type FijadosFalla = "sin_acceso" | "sin_permiso" | "no_disponible" | "error";

/** Error que un cliente de fijados lanza para que la seccion muestre el estado honesto correcto. */
export class FijadosErrorCliente extends Error {
  readonly tipo: FijadosFalla;
  constructor(tipo: FijadosFalla, mensaje: string = tipo) {
    super(mensaje);
    this.name = "FijadosErrorCliente";
    this.tipo = tipo;
  }
}

export interface FijadosCliente {
  /** `disponible: false` = el servidor todavia no tiene la funcion (base sin migrar): se dice, no se inventa una lista vacia. */
  listar(senal: AbortSignal): Promise<{ readonly disponible: boolean; readonly fijados: readonly FijadoResumen[] }>;
  /** Re-ejecucion del fijado sin modelo, con el alcance actual del usuario. */
  resultado(id: string, senal: AbortSignal): Promise<FijadoResultado>;
  quitar(id: string): Promise<void>;
  /** Solo owner/admin pueden compartir: el servidor responde `sin_permiso` si no. */
  compartir(id: string, compartido: boolean): Promise<void>;
}
