// Doble de OpenRouter para la simulacion: responde en el formato de Chat Completions, SIN red y SIN gasto. El LLM esta GUIONADO (decide
// por lo que dice el huesped en el turno), pero todo lo demas es el codigo real: el proveedor `OpenRouterProvider` arma la peticion, el
// `LlmGateway` real aplica presupuesto, interruptor y registro de uso, y el turn handler real ejecuta las herramientas contra Postgres.
// Los tokens son una ESTIMACION por longitud (caracteres / 4) de la peticion real y de la respuesta guionada: el ledger los marca asi.
export interface UsoLlmSimulado {
  llamadas: number;
  tokensEntrada: number;
  tokensSalida: number;
}

interface MensajeWire {
  role: string;
  content: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface PeticionWire {
  model?: string;
  messages?: MensajeWire[];
  tools?: { function: { name: string } }[];
}

export const MODELO_FALSO_PREFIJO = "openrouter.ai";

export class LlmGuionado {
  readonly uso: UsoLlmSimulado = { llamadas: 0, tokensEntrada: 0, tokensSalida: 0 };
  /** Herramientas que el guion pidio (para el ledger). */
  readonly herramientas: Record<string, number> = {};
  #ids = 0;

  /** Cierra el dia: devuelve el uso acumulado y lo reinicia. */
  cerrarDia(): { uso: UsoLlmSimulado; herramientas: Record<string, number> } {
    const out = { uso: { ...this.uso }, herramientas: { ...this.herramientas } };
    this.uso.llamadas = 0;
    this.uso.tokensEntrada = 0;
    this.uso.tokensSalida = 0;
    for (const k of Object.keys(this.herramientas)) delete this.herramientas[k];
    return out;
  }

  responder(cuerpoJson: string): Response {
    const req = JSON.parse(cuerpoJson) as PeticionWire;
    const mensajes = req.messages ?? [];
    const idxUltimoUsuario = mensajes.map((m) => m.role).lastIndexOf("user");
    const textoUsuario = idxUltimoUsuario >= 0 ? (mensajes[idxUltimoUsuario]!.content ?? "") : "";
    const resultadosDeHerramienta = mensajes.slice(idxUltimoUsuario + 1).filter((m) => m.role === "tool");
    const disponibles = new Set((req.tools ?? []).map((t) => t.function.name));
    const decision = this.#decidir(textoUsuario, resultadosDeHerramienta, disponibles);

    const entradaChars = JSON.stringify(mensajes).length + JSON.stringify(req.tools ?? []).length;
    const salidaChars = (decision.texto ?? "").length + (decision.llamada ? JSON.stringify(decision.llamada).length : 0);
    const tokensEntrada = Math.ceil(entradaChars / 4);
    const tokensSalida = Math.max(1, Math.ceil(salidaChars / 4));
    this.uso.llamadas += 1;
    this.uso.tokensEntrada += tokensEntrada;
    this.uso.tokensSalida += tokensSalida;
    if (decision.llamada) this.herramientas[decision.llamada.name] = (this.herramientas[decision.llamada.name] ?? 0) + 1;

    this.#ids += 1;
    const body = {
      id: `gen-sim-${this.#ids}`,
      model: req.model ?? "sim/modelo",
      choices: [
        {
          finish_reason: decision.llamada ? "tool_calls" : "stop",
          message: {
            role: "assistant",
            content: decision.texto ?? null,
            ...(decision.llamada ? { tool_calls: [{ id: `call_sim_${this.#ids}`, type: "function", function: { name: decision.llamada.name, arguments: JSON.stringify(decision.llamada.args) } }] } : {}),
          },
        },
      ],
      usage: { prompt_tokens: tokensEntrada, completion_tokens: tokensSalida },
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }

  #decidir(texto: string, herramientas: MensajeWire[], disponibles: Set<string>): { texto?: string; llamada?: { name: string; args: Record<string, unknown> } } {
    const t = texto.toLowerCase();
    const hechas = herramientas.length;
    const habitacion = /habitaci[oó]n (\d{3})/i.exec(texto)?.[1];
    if (/aire|fuga|no funciona|descompuest|no enfr/.test(t) && disponibles.has("crear_ticket_mantenimiento")) {
      if (hechas === 0) return { llamada: { name: "crear_ticket_mantenimiento", args: { titulo: "Falla reportada por el huesped", descripcion: texto.slice(0, 280), ...(habitacion ? { habitacion } : {}), severidad: /fuga|sin luz/.test(t) ? "alta" : "media" } } };
      return { texto: "Ya registre el reporte; mantenimiento le dara seguimiento." };
    }
    if (/pizza|hamburguesa|room service|desayuno|cena|refresco|cerveza|alerg/.test(t) && disponibles.has("crear_ticket_huesped_fnb")) {
      if (hechas === 0) return { llamada: { name: "crear_ticket_huesped_fnb", args: { mensaje: texto.slice(0, 280), ...(habitacion ? { habitacion } : {}), alergia_declarada: /alerg/.test(t) } } };
      return { texto: "Registre su pedido; la cocina lo revisa y se lo lleva." };
    }
    if (/reservar|disponibilidad|cotiz/.test(t) && disponibles.has("consultar_disponibilidad")) {
      const fechas = /(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/.exec(texto);
      if (!fechas) return { texto: "Con gusto: indiqueme fecha de llegada y de salida (AAAA-MM-DD)." };
      const [, llegada, salida] = fechas as unknown as [string, string, string];
      if (hechas === 0) return { llamada: { name: "consultar_disponibilidad", args: { fecha_llegada: llegada, fecha_salida: salida } } };
      if (hechas === 1) {
        const tipoId = primerIdDeTipo(herramientas[0]!.content);
        if (!tipoId) return { texto: "Por ahora no hay disponibilidad en esas fechas; un asesor le propone alternativas." };
        return { llamada: { name: "cotizar_estancia", args: { tipo_habitacion_id: tipoId, fecha_llegada: llegada, fecha_salida: salida } } };
      }
      if (hechas === 2 && /pre-?reserv|apartar|reservar/.test(t) && disponibles.has("crear_pre_reserva")) {
        const cot = leerJson(herramientas[1]!.content);
        const tipoId = primerIdDeTipo(herramientas[0]!.content);
        const total = numeroDe(cot, ["total_centavos", "total_cotizado_centavos", "totalCentavos"]);
        if (tipoId && total) return { llamada: { name: "crear_pre_reserva", args: { tipo_habitacion_id: tipoId, fecha_llegada: llegada, fecha_salida: salida, huespedes: 2, total_cotizado_centavos: total } } };
      }
      return { texto: "Esa es la cotizacion; si desea apartar, confirmeme y genero una pre-reserva." };
    }
    if (disponibles.has("registrar_contacto_no_operativo")) {
      if (hechas === 0) return { llamada: { name: "registrar_contacto_no_operativo", args: { motivo: "consulta general", resumen: texto.slice(0, 200) } } };
      return { texto: "Gracias; alguien del hotel le dara seguimiento." };
    }
    return { texto: "Gracias por escribirnos." };
  }
}

function leerJson(s: string | null): unknown {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function numeroDe(o: unknown, claves: string[]): number | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  for (const k of claves) if (typeof r[k] === "number") return r[k] as number;
  for (const v of Object.values(r)) {
    const n = numeroDe(v, claves);
    if (n) return n;
  }
  return null;
}

function primerIdDeTipo(contenido: string | null): string | null {
  const j = leerJson(contenido);
  const buscar = (o: unknown): string | null => {
    if (Array.isArray(o)) {
      for (const x of o) {
        const r = buscar(x);
        if (r) return r;
      }
      return null;
    }
    if (o && typeof o === "object") {
      const r = o as Record<string, unknown>;
      const id = r.tipo_habitacion_id ?? r.room_type_id ?? r.roomTypeId;
      if (typeof id === "string") return id;
      for (const v of Object.values(r)) {
        const x = buscar(v);
        if (x) return x;
      }
    }
    return null;
  };
  return buscar(j);
}
