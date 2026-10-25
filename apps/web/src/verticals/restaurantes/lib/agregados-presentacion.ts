// Presentacion pura de «Agregados por validar»: cronometro, nivel del SLA con el reloj de ESTE telefono, etiquetas y enlaces de contacto. Sin DOM ni red.
// El SLA (decision del dueno): la sucursal responde en <= 10 min; a los 10 el dueno y el cliente ya fueron avisados; a los 20 el sistema cierra la solicitud como vencida.
import type { EstadoAgregadoWire, MotivoRechazoAgregadoWire, NivelSlaAgregadoWire, TarjetaAgregado } from "@atiende/domain-restaurantes/operacion";

export const SLA_AVISO_SEG = 10 * 60;
export const SLA_VENCIMIENTO_SEG = 20 * 60;
/** Color del cronometro: verde hasta la mitad del plazo, ambar hasta el plazo, rojo despues. */
export const SLA_AMBAR_SEG = 5 * 60;

export const MENSAJE_AGREGADOS_NO_DISPONIBLES = "Agregados por validar todavía no está disponible en esta cuenta (falta aplicar la actualización de base de datos).";

export const OPCIONES_RECHAZO: readonly { readonly valor: MotivoRechazoAgregadoWire; readonly etiqueta: string }[] = [
  { valor: "ya_salio_de_cocina", etiqueta: "Ya salió de cocina" },
  { valor: "producto_agotado", etiqueta: "Producto agotado" },
  { valor: "pedido_en_reparto", etiqueta: "El pedido ya va en reparto" },
  { valor: "fuera_de_horario", etiqueta: "Fuera de horario" },
  { valor: "otro", etiqueta: "Otro motivo" },
];

export const ETIQUETA_MOTIVO: Readonly<Record<MotivoRechazoAgregadoWire, string>> = Object.fromEntries(OPCIONES_RECHAZO.map((o) => [o.valor, o.etiqueta])) as Record<MotivoRechazoAgregadoWire, string>;

export const ETIQUETA_ESTADO: Readonly<Record<EstadoAgregadoWire, string>> = {
  pendiente: "Por validar",
  aceptado: "Aceptado",
  rechazado: "Rechazado",
  vencido: "Vencido sin respuesta",
  cancelado_por_cliente: "El cliente lo retiró",
  no_aplicable: "El pedido ya no admitía agregados",
};

export const ETIQUETA_ESTADO_PEDIDO: Readonly<Record<string, string>> = {
  programado: "Programado",
  pending: "Recibido",
  preparando: "En preparación",
  listo_para_recoger: "Listo para recoger",
  en_camino: "En camino",
  entregado: "Entregado",
  completado: "Completado",
  cancelado: "Cancelado",
};

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
  if (s < 60) return `Hace ${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `Hace ${min} min ${String(s % 60)} s`;
  return `Hace ${Math.floor(min / 60)} h ${min % 60} min`;
}

export const TEXTO_NIVEL: Readonly<Record<NivelSlaAgregadoWire, string>> = {
  en_tiempo: "En tiempo",
  sin_respuesta: "Sin respuesta: el dueño y el cliente ya fueron avisados",
  vencido: "Plazo vencido: se cierra sola, sin aceptar",
};

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
  return pendientes > 0 && alterna ? `(${pendientes}) Agregado por validar` : tituloBase;
}

export function textoPendientes(n: number): string {
  return n === 1 ? "1 agregado por validar" : `${n} agregados por validar`;
}
