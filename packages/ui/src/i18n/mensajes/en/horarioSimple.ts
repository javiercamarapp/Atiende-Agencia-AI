import type { Traduccion } from "../../tipos.ts";
import type { horarioSimple } from "../horarioSimple.ts";

export const horarioSimpleEn: Traduccion<typeof horarioSimple> = {
  "horarioSimple.modo": "Hours editor mode",
  "horarioSimple.modo.simple": "Basic",
  "horarioSimple.modo.avanzado": "Advanced",
  "horarioSimple.ayuda": "Check the days the branch is open and its hours. No days checked = no hour limit. For split shifts or a «last order» time, use Advanced.",
  "horarioSimple.noCabe.variosTurnosPorDia": "These hours have more than one shift on the same day (split shift): edit them in Advanced.",
  "horarioSimple.noCabe.ultimoPedido": "These hours have a custom «last order» time on a shift: edit them in Advanced so it isn't lost.",
  "horarioSimple.dia.0": "Sunday",
  "horarioSimple.dia.1": "Monday",
  "horarioSimple.dia.2": "Tuesday",
  "horarioSimple.dia.3": "Wednesday",
  "horarioSimple.dia.4": "Thursday",
  "horarioSimple.dia.5": "Friday",
  "horarioSimple.dia.6": "Saturday",
  "horarioSimple.abierto": "Open on {dia}",
  "horarioSimple.cerrado": "Closed",
  "horarioSimple.abre": "Opens on {dia} at",
  "horarioSimple.cierra": "Closes on {dia} at",
  "horarioSimple.cruzaMedianoche": "Closes the next day",
  "horarioSimple.invalido": "Opening and closing times can't be the same.",
  "horarioSimple.copiarATodos": "Apply to every day",
  "horarioSimple.copiarATodos.etiqueta": "Apply {dia}'s hours to every day",
};
