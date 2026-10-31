// Decision PURA de una alerta: enviar por WhatsApp a quien, o degradar al panel y decir POR QUE. Sin reloj ni red: el reloj entra como argumento.
import { toWhatsAppRecipient } from "../phone.ts";
import type { AlertaSucursalConfig, DecisionAlerta, VentanaHorario } from "./tipos.ts";

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutosDe = (hhmm: string): number | null => {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const DIAS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Dia de semana (0 = domingo) y minuto del dia en la zona de la sucursal. `null` si la zona no es valida. */
export function relojLocal(ahora: Date, zona: string): { readonly dia: number; readonly minuto: number } | null {
  try {
    const partes = new Intl.DateTimeFormat("en-US", { timeZone: zona, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(ahora);
    const dia = DIAS.indexOf(partes.find((p) => p.type === "weekday")?.value ?? "");
    const h = Number(partes.find((p) => p.type === "hour")?.value);
    const m = Number(partes.find((p) => p.type === "minute")?.value);
    if (dia < 0 || !Number.isFinite(h) || !Number.isFinite(m)) return null;
    return { dia, minuto: h * 60 + m };
  } catch {
    return null;
  }
}

/** `true` si `ahora` cae en alguna ventana. Sin horario, o con zona/ventanas ilegibles, es `true`: ante la duda SE AVISA (nunca silencio por un dato mal capturado). */
export function dentroDeHorario(horario: readonly VentanaHorario[] | null, zona: string, ahora: Date): boolean {
  if (horario === null || horario.length === 0) return true;
  const t = relojLocal(ahora, zona);
  if (t === null) return true;
  const validas = horario.filter((v) => minutosDe(v.desde) !== null && minutosDe(v.hasta) !== null && Array.isArray(v.dias));
  if (validas.length === 0) return true;
  for (const v of validas) {
    const d = minutosDe(v.desde) as number;
    const h = minutosDe(v.hasta) as number;
    if (d === h) {
      if (v.dias.includes(t.dia)) return true; // desde == hasta: todo el dia
    } else if (d < h) {
      if (v.dias.includes(t.dia) && t.minuto >= d && t.minuto < h) return true;
    } else {
      // cruza la medianoche: la parte nocturna pertenece al dia en que empezo
      if (v.dias.includes(t.dia) && t.minuto >= d) return true;
      if (v.dias.includes((t.dia + 6) % 7) && t.minuto < h) return true;
    }
  }
  return false;
}

/** Orden de las razones de degradacion: de la mas basica a la mas fina, para que el panel diga siempre la primera que el dueno puede corregir. */
export function decidirAlerta(config: AlertaSucursalConfig, ahora: Date): DecisionAlerta {
  if (!config.activa) return { accion: "panel", motivo: "alertas_apagadas" };
  if (config.destinatarios.length === 0) return { accion: "panel", motivo: "sin_destinatarios" };
  const destinos = [...new Set(config.destinatarios.map((d) => toWhatsAppRecipient(d.telefono)).filter((t): t is string => typeof t === "string" && t.length > 0))];
  if (destinos.length === 0) return { accion: "panel", motivo: "destinatarios_invalidos" };
  if (!config.phoneNumberIdAviso) return { accion: "panel", motivo: "sin_numero_aviso" };
  if (!config.plantillaNombre) return { accion: "panel", motivo: "sin_plantilla" };
  if (!config.plantillaAprobada) return { accion: "panel", motivo: "plantilla_no_aprobada" };
  if (!dentroDeHorario(config.horario, config.zonaHoraria, ahora)) return { accion: "panel", motivo: "fuera_de_horario" };
  return { accion: "enviar", destinatarios: destinos };
}
