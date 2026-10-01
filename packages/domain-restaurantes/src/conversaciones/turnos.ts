// Validacion de la entrada de turnos de personal (PUT .../admin/turnos).
import { ConversacionesValidacionError, MIEMBROS_POR_TURNO_MAX, TURNOS_MAX } from "./types.ts";
import type { TurnoEntrada } from "./types.ts";

const HORA_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Valida un arreglo de turnos que viene de la API; lanza `ConversacionesValidacionError` con un mensaje
 * accionable y nunca normaliza en silencio. */
export function validarTurnos(raw: unknown): readonly TurnoEntrada[] {
  if (!Array.isArray(raw)) throw new ConversacionesValidacionError("turnos: se esperaba un arreglo.");
  if (raw.length > TURNOS_MAX) throw new ConversacionesValidacionError(`turnos: máximo ${TURNOS_MAX} turnos por sucursal.`);
  const nombres = new Set<string>();
  return raw.map((t, i) => {
    const etiqueta = `turnos[${i}]`;
    if (!t || typeof t !== "object") throw new ConversacionesValidacionError(`${etiqueta}: se esperaba un objeto.`);
    const o = t as Record<string, unknown>;
    const nombre = typeof o.nombre === "string" ? o.nombre.trim() : "";
    if (nombre.length < 1 || nombre.length > 60) throw new ConversacionesValidacionError(`${etiqueta}.nombre: de 1 a 60 caracteres.`);
    if (nombres.has(nombre.toLowerCase())) throw new ConversacionesValidacionError(`${etiqueta}.nombre: "${nombre}" está repetido.`);
    nombres.add(nombre.toLowerCase());
    if (!Array.isArray(o.dias) || o.dias.length < 1 || o.dias.length > 7 || o.dias.some((d) => !Number.isInteger(d) || d < 0 || d > 6) || new Set(o.dias).size !== o.dias.length) {
      throw new ConversacionesValidacionError(`${etiqueta}.dias: enteros distintos de 0 (domingo) a 6 (sábado).`);
    }
    if (typeof o.inicia !== "string" || !HORA_RE.test(o.inicia)) throw new ConversacionesValidacionError(`${etiqueta}.inicia: formato HH:MM.`);
    if (typeof o.termina !== "string" || !HORA_RE.test(o.termina)) throw new ConversacionesValidacionError(`${etiqueta}.termina: formato HH:MM.`);
    if (o.inicia === o.termina) throw new ConversacionesValidacionError(`${etiqueta}: inicia y termina no pueden ser iguales.`);
    if (!Array.isArray(o.miembros) || o.miembros.length > MIEMBROS_POR_TURNO_MAX) {
      throw new ConversacionesValidacionError(`${etiqueta}.miembros: arreglo de hasta ${MIEMBROS_POR_TURNO_MAX} personas (puede ir vacío).`);
    }
    const vistos = new Set<string>();
    const miembros = o.miembros.map((m, j) => {
      const mo = (m ?? {}) as Record<string, unknown>;
      if (typeof mo.userId !== "string" || !UUID_RE.test(mo.userId)) throw new ConversacionesValidacionError(`${etiqueta}.miembros[${j}].userId: se esperaba un UUID.`);
      if (vistos.has(mo.userId)) throw new ConversacionesValidacionError(`${etiqueta}.miembros[${j}]: la persona está repetida en el turno.`);
      vistos.add(mo.userId);
      const orden = mo.orden === undefined ? j + 1 : mo.orden;
      if (typeof orden !== "number" || !Number.isInteger(orden) || orden < 1 || orden > 5) throw new ConversacionesValidacionError(`${etiqueta}.miembros[${j}].orden: entero de 1 (principal) a 5.`);
      return { userId: mo.userId, orden };
    });
    return { nombre, dias: [...(o.dias as number[])].sort((a, b) => a - b), inicia: o.inicia, termina: o.termina, miembros };
  });
}
