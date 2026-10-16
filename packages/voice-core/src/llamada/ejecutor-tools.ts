// Ejecutor de herramientas de la llamada, parametrizado por el REGISTRO DE TOOLS de la vertical. Reglas que impone (defensa en
// profundidad; el servidor las vuelve a aplicar):
//   * SOLO corren las tools que el registro declara para el canal de voz; un nombre inventado por el modelo nunca llega al
//     servidor y se responde como error;
//   * el telefono NUNCA se toma de los argumentos: se quitan las claves que parezcan un telefono (el numero sale del token
//     de llamada, firmado con el caller ID del SIP From);
//   * cada llamada tiene TIMEOUT: pasado el limite se responde un error honesto al modelo y se marca `timeout` para la
//     maquina de la llamada. Una tool de escritura que expira (`herramientasInciertas`) queda como resultado INCIERTO (el
//     servidor puede haberla registrado): se le dice al modelo que no la asegure al cliente y se ofrece verificacion por una persona;
//   * se mide la latencia de cada tool (alimenta el p95 de KPI, `voice_event`).

/** Subconjunto de JSON Schema que usan las tools (mismo shape que `LlmToolDefinition.parameters`). */
export interface ToolJsonSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
}

/** Definicion de una herramienta que se le declara al proveedor de voz. */
export interface ToolDefinicion {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolJsonSchema;
}

/** El registro de tools de una vertical para el canal de voz. */
export interface RegistroToolsVoz {
  /** Las tools que el agente de voz de la vertical puede llamar (nada mas corre). */
  definiciones(): readonly ToolDefinicion[];
  /** Tools de escritura cuyo timeout deja un resultado incierto (restaurantes: `crear_pedido`; hoteles: `crear_pre_reserva`). */
  readonly herramientasInciertas: readonly string[];
  /** Lo que se le dice al modelo cuando una tool incierta expira (nombra lo que la vertical crea: el pedido, la reserva). */
  readonly mensajeIncierto: string;
  /** Maquina de estados de la vertical (defensa en profundidad; el servidor vuelve a aplicar sus reglas): se consulta ANTES de ejecutar y,
   * si devuelve un rechazo, la herramienta NO se ejecuta y el modelo recibe ese error (p. ej. "no se puede apartar sin cotizar y confirmar"). */
  guardia?(nombre: string, args: Readonly<Record<string, unknown>>): { readonly error: string; readonly mensaje: string } | null;
  /** Se avisa de cada herramienta ya ejecutada (`ok` = el servidor no devolvio error) para que la maquina de la vertical avance. */
  alResultado?(nombre: string, args: Readonly<Record<string, unknown>>, resultado: unknown, ok: boolean): void;
}

export interface ResultadoTool {
  /** Lo que se devuelve al modelo. */
  readonly resultado: unknown;
  /** El servidor no devolvio un error. */
  readonly ok: boolean;
  readonly timeout: boolean;
  /** Id de la entidad que la tool creo (pedido, reserva...), si la creo. */
  readonly entidadId: string | null;
  readonly latenciaMs: number;
}

/** Lo que el controlador de la llamada sabe y el modelo no puede decidir: el turno del CLIENTE en que se invoca la tool (numero de
 * habla inteligible del cliente en esta llamada). Permite al servidor exigir que la confirmacion llegue en un turno posterior a la cotizacion. */
export interface ContextoEjecucionTool {
  readonly turno: number | null;
}

/** Cabecera con la que el transporte HTTP informa el turno del cliente al servidor (la pone el worker, nunca el modelo). */
export const CABECERA_TURNO_LLAMADA = "x-atiende-call-turn";

/** Como se ejecuta de verdad una tool: en proceso (simulador/pruebas) o por HTTP contra la API (worker). */
export type TransporteTools = (nombre: string, args: Readonly<Record<string, unknown>>, senal: AbortSignal, contexto?: ContextoEjecucionTool) => Promise<{ readonly resultado: unknown; readonly entidadId: string | null }>;

const CLAVES_TELEFONO_RE = /^(phone|telefono|tel|celular|customer_?phone|caller_?(id|phone))$/i;

export function sanearArgumentos(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return {};
  const limpio: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (!CLAVES_TELEFONO_RE.test(k)) limpio[k] = v;
  return limpio;
}

export interface EjecutorToolsOpciones {
  readonly registro: RegistroToolsVoz;
  readonly transporte: TransporteTools;
  readonly timeoutMs: number;
  readonly ahora?: () => number;
}

export interface EjecutorTools {
  definiciones(): readonly ToolDefinicion[];
  ejecutar(nombre: string, args: unknown, contexto?: ContextoEjecucionTool): Promise<ResultadoTool>;
}

export function crearEjecutorTools(opts: EjecutorToolsOpciones): EjecutorTools {
  const ahora = opts.ahora ?? Date.now;
  const permitidas = new Set<string>(opts.registro.definiciones().map((t) => t.name));
  const inciertas = new Set<string>(opts.registro.herramientasInciertas);
  return {
    definiciones: () => opts.registro.definiciones(),
    ejecutar: (nombre, args, contexto) => ejecutarUna(nombre, args, contexto),
  };

  async function ejecutarUna(nombre: string, args: unknown, contexto?: ContextoEjecucionTool): Promise<ResultadoTool> {
    {
      const t0 = ahora();
      if (!permitidas.has(nombre)) {
        return { resultado: { error: `Herramienta desconocida: ${nombre}` }, ok: false, timeout: false, entidadId: null, latenciaMs: 0 };
      }
      const limpios = sanearArgumentos(args);
      const rechazo = opts.registro.guardia?.(nombre, limpios) ?? null;
      if (rechazo) return { resultado: { ...rechazo, bloqueada_por_flujo: true }, ok: false, timeout: false, entidadId: null, latenciaMs: 0 };
      const control = new AbortController();
      let temporizador: ReturnType<typeof setTimeout> | undefined;
      const expira = new Promise<"timeout">((resolve) => {
        temporizador = setTimeout(() => {
          control.abort();
          resolve("timeout");
        }, opts.timeoutMs);
      });
      try {
        const salida = await Promise.race([opts.transporte(nombre, limpios, control.signal, contexto), expira]);
        const latenciaMs = Math.max(0, ahora() - t0);
        if (salida === "timeout") {
          const incierto = inciertas.has(nombre);
          return {
            resultado: {
              error: incierto
                ? opts.registro.mensajeIncierto
                : "La herramienta tardó demasiado. Pida un momento al cliente e intente una vez más o pase con una persona.",
              timeout: true,
              ...(incierto ? { incierto: true } : {}),
            },
            ok: false,
            timeout: true,
            entidadId: null,
            latenciaMs,
          };
        }
        const conError = typeof salida.resultado === "object" && salida.resultado !== null && "error" in salida.resultado;
        opts.registro.alResultado?.(nombre, limpios, salida.resultado, !conError);
        return { resultado: salida.resultado, ok: !conError, timeout: false, entidadId: conError ? null : salida.entidadId, latenciaMs };
      } catch {
        if (control.signal.aborted) {
          // El transporte rechazo por el aborto ANTES de que ganara la carrera del timeout: sigue siendo un timeout, y una escritura sigue siendo INCIERTA.
          const incierto = inciertas.has(nombre);
          return {
            resultado: { error: incierto ? opts.registro.mensajeIncierto : "La herramienta tardó demasiado.", timeout: true, ...(incierto ? { incierto: true } : {}) },
            ok: false,
            timeout: true,
            entidadId: null,
            latenciaMs: Math.max(0, ahora() - t0),
          };
        }
        return { resultado: { error: "Error interno al ejecutar la herramienta" }, ok: false, timeout: false, entidadId: null, latenciaMs: Math.max(0, ahora() - t0) };
      } finally {
        if (temporizador) clearTimeout(temporizador);
      }
    }
  }
}

export interface TransporteHttpOpciones {
  /** Raiz de las rutas de la vertical (p. ej. `https://api/v1/restaurantes/<org>`), sin barra final. */
  readonly raiz: string;
  /** Ruta de cada tool, relativa a `raiz` (empieza con `/`). */
  readonly ruta: (nombre: string) => string;
  /** Cabeceras de autenticacion de la llamada (token firmado por llamada o secreto por property): nunca van en el cuerpo. */
  readonly cabeceras: Readonly<Record<string, string>>;
  /** Extrae el id de la entidad creada de la respuesta (pedido, reserva...). */
  readonly entidadId?: (nombre: string, cuerpo: unknown) => string | null;
  readonly fetchFn?: typeof fetch;
}

/** Transporte HTTP del worker: mismas rutas que el manifiesto de la vertical, sin secretos en el cuerpo. */
export function transporteHttp(opts: TransporteHttpOpciones): TransporteTools {
  const fetchFn = opts.fetchFn ?? fetch;
  let raiz = opts.raiz;
  while (raiz.endsWith("/")) raiz = raiz.slice(0, -1);
  return async (nombre, args, senal, contexto) => {
    const respuesta = await fetchFn(`${raiz}${opts.ruta(nombre)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...opts.cabeceras, ...(contexto?.turno != null ? { [CABECERA_TURNO_LLAMADA]: String(contexto.turno) } : {}) },
      body: JSON.stringify(args),
      signal: senal,
    });
    let cuerpo: unknown;
    try {
      cuerpo = await respuesta.json();
    } catch {
      cuerpo = null;
    }
    if (!respuesta.ok) {
      const mensaje = typeof cuerpo === "object" && cuerpo !== null && "message" in cuerpo && typeof (cuerpo as { message: unknown }).message === "string" ? (cuerpo as { message: string }).message : `HTTP ${respuesta.status}`;
      return { resultado: { error: mensaje }, entidadId: null };
    }
    const id = opts.entidadId?.(nombre, cuerpo) ?? null;
    return { resultado: cuerpo, entidadId: typeof id === "string" ? id : null };
  };
}
