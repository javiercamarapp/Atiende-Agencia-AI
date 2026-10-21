// Reglas puras de la pantalla «Mis entregas» del chofer (PLAN-PANEL-OPERADOR §5, boceto E). Sin React ni red: se prueban solas.
// Aqui viven las decisiones de presentacion que NO debe duplicar el servidor: cuanto tiempo se queda visible un pedido recien
// entregado, cuanto falta para que expire el «Deshacer», el cambio que lleva el chofer y el destino del boton «Navegar».
import type { EntregaChofer, MotivoProblemaChofer, Semaforo } from "@atiende/domain-restaurantes/operacion";
import { VENTANA_DESHACER_ENTREGA_SEG } from "@atiende/domain-restaurantes/operacion";
import type { StatusTone } from "@atiende/ui";

/** Un pedido entregado (o con problema) desaparece de la lista 2 min despues de verse por primera vez en ese estado. */
export const VISIBLE_TRAS_ENTREGA_MS = 120_000;

export const ETIQUETA_MOTIVO_PROBLEMA: Readonly<Record<MotivoProblemaChofer, string>> = {
  direccion: "No encontré la dirección",
  no_contesto: "El cliente no contesta",
  rechazo: "Rechazó el pedido",
  otro: "Otro motivo",
};

export const TONO_SEMAFORO: Readonly<Record<Semaforo, StatusTone>> = { verde: "success", amarillo: "warning", rojo: "danger" };

/** Cambio que debe llevar el chofer; `null` si no paga con billete o el billete no cubre el total (no se inventa un cambio negativo). */
export function cambioDe(total: number, pagaCon: number | null): number | null {
  if (pagaCon === null || !Number.isFinite(pagaCon) || pagaCon < total) return null;
  return Math.round((pagaCon - total) * 100) / 100;
}

/** Segundos que quedan para deshacer (0 = ya no se puede). `null` si el servidor no dio limite. */
export function segundosParaDeshacer(puedeDeshacerHasta: string | null | undefined, ahoraMs: number): number | null {
  if (!puedeDeshacerHasta) return null;
  const limite = Date.parse(puedeDeshacerHasta);
  if (Number.isNaN(limite)) return null;
  return Math.max(0, Math.min(VENTANA_DESHACER_ENTREGA_SEG, Math.ceil((limite - ahoraMs) / 1000)));
}

/** Minutos desde que salio; si el servidor no dio `salioAt` (base sin migrar) se usa el valor que mando en `minutos`. */
export function minutosEnCamino(e: Pick<EntregaChofer, "salioAt" | "minutos">, ahoraMs: number): number {
  const salio = e.salioAt ? Date.parse(e.salioAt) : Number.NaN;
  if (Number.isNaN(salio)) return e.minutos;
  return Math.max(0, Math.floor((ahoraMs - salio) / 60_000));
}

/**
 * Registro de cuando se vio por primera vez cada pedido ya cerrado (entregado/problema). Devuelve un mapa nuevo: conserva
 * los que siguen presentes y estampa `ahoraMs` a los nuevos; descarta los que ya no vienen del servidor.
 */
export function registrarCerrados(previo: ReadonlyMap<string, number>, entregas: readonly EntregaChofer[], ahoraMs: number): Map<string, number> {
  const siguiente = new Map<string, number>();
  for (const e of entregas) {
    if (e.estado === "en_camino") continue;
    siguiente.set(e.id, previo.get(e.id) ?? ahoraMs);
  }
  return siguiente;
}

/** Lo que se pinta: las activas siempre; las cerradas solo mientras no pasen 2 min desde que se vieron cerradas. */
export function visiblesEnPantalla(entregas: readonly EntregaChofer[], cerradosVistos: ReadonlyMap<string, number>, ahoraMs: number): readonly EntregaChofer[] {
  return entregas.filter((e) => {
    if (e.estado === "en_camino") return true;
    const visto = cerradosVistos.get(e.id);
    return visto === undefined || ahoraMs - visto < VISIBLE_TRAS_ENTREGA_MS;
  });
}

/** Destino del boton «Navegar»: busqueda por la direccion escrita (el pin del cliente ya no viaja al chofer en las notas libres). */
export function urlNavegar(direccion: { readonly texto: string; readonly colonia: string | null }): string | null {
  const partes = [direccion.texto.trim(), direccion.colonia?.trim() ?? ""].filter((p) => p.length > 0);
  if (partes.length === 0) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(partes.join(", "))}`;
}

/** `tel:` solo con un E.164 estricto (`+`, sin 0 inicial, 8 a 15 digitos); se toleran espacios, parentesis, puntos y guiones. Cualquier otra cosa se rechaza (nunca se arma un enlace con texto del servidor sin validar). */
export function enlaceTelefono(telefono: string): string | null {
  const limpio = telefono.replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(limpio) ? `tel:${limpio}` : null;
}
