// Agrupación del chat como WhatsApp: por cada mensaje, si abre grupo (lleva cola) y la etiqueta de fecha que lo antecede (null si no toca).
// Abre grupo el primer mensaje, el que cambia de remitente (o sigue a un mensaje de sistema) y el que estrena día. «Hoy» para el día actual.
import { fechaCortaEsMx } from "../../../lib/formato-fecha.ts";

export interface MensajeAgrupable {
  readonly rol: "cliente" | "agente" | "sistema";
  readonly hora: Date;
}
export interface MarcaGrupo {
  readonly primero: boolean;
  readonly separador: string | null;
}

export function agruparMensajes(mensajes: readonly MensajeAgrupable[], zona: string | undefined, ahora: Date = new Date()): readonly MarcaGrupo[] {
  const hoy = fechaCortaEsMx(ahora, zona);
  return mensajes.map((m, i) => {
    const previo = mensajes[i - 1];
    const dia = fechaCortaEsMx(m.hora, zona);
    const separador = !previo || fechaCortaEsMx(previo.hora, zona) !== dia ? (dia === hoy ? "Hoy" : dia) : null;
    return { primero: !previo || previo.rol !== m.rol || previo.rol === "sistema" || separador !== null, separador };
  });
}
