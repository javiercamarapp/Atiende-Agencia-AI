// Presentacion pura de «Agregados por validar»: cronometro, nivel del SLA con el reloj de ESTE telefono, etiquetas y enlaces de contacto. Sin DOM ni red.
// El SLA (decision del dueno): la sucursal responde en <= 10 min; a los 10 el dueno y el cliente ya fueron avisados; a los 20 el sistema cierra la solicitud como vencida.
import type { EstadoAgregadoWire, MotivoRechazoAgregadoWire, NivelSlaAgregadoWire, TarjetaAgregado } from "@atiende/domain-restaurantes/operacion";
import { etiquetasTraducidas, traductorActivo } from "@atiende/ui";
import { restaurantesAgregados } from "@atiende/ui/i18n/restaurantes/agregados";

// Etiquetas en el idioma activo (i18n): los mapas traducen en cada lectura; en espanol dan los textos de siempre.
const tr = traductorActivo(restaurantesAgregados);

export const SLA_AVISO_SEG = 10 * 60;
export const SLA_VENCIMIENTO_SEG = 20 * 60;
/** Color del cronometro: verde hasta la mitad del plazo, ambar hasta el plazo, rojo despues. */
export const SLA_AMBAR_SEG = 5 * 60;

export function mensajeAgregadosNoDisponibles(): string {
  return tr("restaurantes.agregados.noDisponible");
}

const MOTIVOS_RECHAZO: readonly MotivoRechazoAgregadoWire[] = ["ya_salio_de_cocina", "producto_agotado", "pedido_en_reparto", "fuera_de_horario", "otro"];

export const ETIQUETA_MOTIVO: Readonly<Record<MotivoRechazoAgregadoWire, string>> = etiquetasTraducidas(MOTIVOS_RECHAZO, (m) => `restaurantes.agregados.motivo.${m}` as const, restaurantesAgregados);

export const OPCIONES_RECHAZO: readonly { readonly valor: MotivoRechazoAgregadoWire; readonly etiqueta: string }[] = MOTIVOS_RECHAZO.map((valor) => ({
  valor,
  get etiqueta() {
    return ETIQUETA_MOTIVO[valor];
  },
}));

export const ETIQUETA_ESTADO: Readonly<Record<EstadoAgregadoWire, string>> = etiquetasTraducidas<EstadoAgregadoWire>(
  ["pendiente", "aceptado", "rechazado", "vencido", "cancelado_por_cliente", "no_aplicable"],
  (e) => `restaurantes.agregados.estado.${e}` as const,
  restaurantesAgregados,
);

export const ETIQUETA_ESTADO_PEDIDO: Readonly<Record<string, string>> = etiquetasTraducidas(
  ["programado", "pending", "preparando", "listo_para_recoger", "en_camino", "entregado", "completado", "cancelado"] as const,
  (e) => `restaurantes.agregados.estadoPedido.${e}` as const,
  restaurantesAgregados,
);

/** Segundos de espera ahora: los que dijo el servidor al consultar mas lo transcurrido en ESTE telefono desde esa consulta (no mezcla relojes). */
export function segundosVivos(t: Pick<TarjetaAgregado, "sla" | "estado">, consultadoEnMs: number, ahoraMs: number): number {
  if (t.estado !== "pendiente") return t.sla.segundosEspera;
  return t.sla.segundosEspera + Math.max(0, Math.floor((ahoraMs - consultadoEnMs) / 1000));
}

export function nivelDeSegundos(segundos: number): NivelSlaAgregadoWire {
  if (segundos >= SLA_VENCIMIENTO_SEG) return "vencido";
  if (segundos >= SLA_AVISO_SEG) return "sin_respuesta";
  return "en_tiempo";
}

export type ColorCronometro = "verde" | "ambar" | "rojo";
export function colorCronometro(segundos: number): ColorCronometro {
  if (segundos >= SLA_AVISO_SEG) return "rojo";
  if (segundos >= SLA_AMBAR_SEG) return "ambar";
  return "verde";
}

/** «Hace 2 min 10 s» / «Hace 45 s» / «Hace 1 h 5 min». */
export function textoCronometro(segundos: number): string {
  const s = Math.max(0, Math.floor(segundos));
  if (s < 60) return tr("restaurantes.agregados.cronometro.s", { s });
  const min = Math.floor(s / 60);
  if (min < 60) return tr("restaurantes.agregados.cronometro.min", { min, s: String(s % 60) });
  return tr("restaurantes.agregados.cronometro.h", { h: Math.floor(min / 60), min: min % 60 });
}

export const TEXTO_NIVEL: Readonly<Record<NivelSlaAgregadoWire, string>> = etiquetasTraducidas<NivelSlaAgregadoWire>(
  ["en_tiempo", "sin_respuesta", "vencido"],
  (n) => `restaurantes.agregados.nivel.${n}` as const,
  restaurantesAgregados,
);

/** Pendientes primero y la mas antigua arriba (la que mas lleva esperando). */
export function ordenarAgregados(lista: readonly TarjetaAgregado[]): readonly TarjetaAgregado[] {
  return [...lista].sort((a, b) => {
    const pa = a.estado === "pendiente" ? 0 : 1;
    const pb = b.estado === "pendiente" ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return pa === 0 ? Date.parse(a.solicitadoEn) - Date.parse(b.solicitadoEn) : Date.parse(b.resueltoEn ?? b.solicitadoEn) - Date.parse(a.resueltoEn ?? a.solicitadoEn);
  });
}

function digitos(telefono: string): string {
  return telefono.replace(/\D/g, "");
}

/** `tel:` para llamar; `null` si no hay un numero utilizable. */
export function enlaceLlamar(telefono: string | null): string | null {
  const d = telefono ? digitos(telefono) : "";
  return d.length >= 10 ? `tel:+${d.length === 10 ? "52" : ""}${d}` : null;
}

/** `https://wa.me/…` (numero nacional de 10 digitos => lada 52). `null` si no hay un numero utilizable. */
export function enlaceWhatsapp(telefono: string | null): string | null {
  const d = telefono ? digitos(telefono) : "";
  return d.length >= 10 ? `https://wa.me/${d.length === 10 ? "52" : ""}${d}` : null;
}

/** Titulo de la pestana: parpadea con «(N) Agregado por validar» mientras haya pendientes. */
export function tituloConPendientes(tituloBase: string, pendientes: number, alterna: boolean): string {
  return pendientes > 0 && alterna ? tr("restaurantes.agregados.tituloPestana", { n: pendientes }) : tituloBase;
}

export function textoPendientes(n: number): string {
  return tr("restaurantes.agregados.pendientes", { count: n });
}

