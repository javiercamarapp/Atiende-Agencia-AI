import type { ModuloEs } from "../tipos.ts";

/** Modo simple del horario de una sucursal (Sucursales -> Reglas -> Horario). La traduccion vive en `en/horarioSimple.ts`. */
export const horarioSimple = {
  "horarioSimple.modo": "Modo del editor de horario",
  "horarioSimple.modo.simple": "Simple",
  "horarioSimple.modo.avanzado": "Avanzado",
  "horarioSimple.ayuda": "Marca los días que abre la sucursal y su horario. Sin días marcados = sin límite de horario. Para doble turno o «último pedido» usa Avanzado.",
  "horarioSimple.noCabe.variosTurnosPorDia": "Este horario tiene más de un turno en un mismo día (doble turno): edítalo en Avanzado.",
  "horarioSimple.noCabe.ultimoPedido": "Este horario tiene «último pedido» propio en algún turno: edítalo en Avanzado para no perderlo.",
  "horarioSimple.dia.0": "Domingo",
  "horarioSimple.dia.1": "Lunes",
  "horarioSimple.dia.2": "Martes",
  "horarioSimple.dia.3": "Miércoles",
  "horarioSimple.dia.4": "Jueves",
  "horarioSimple.dia.5": "Viernes",
  "horarioSimple.dia.6": "Sábado",
  "horarioSimple.abierto": "Abre el {dia}",
  "horarioSimple.cerrado": "Cerrado",
  "horarioSimple.abre": "Abre el {dia} a las",
  "horarioSimple.cierra": "Cierra el {dia} a las",
  "horarioSimple.cruzaMedianoche": "Cierra al día siguiente",
  "horarioSimple.invalido": "La apertura y el cierre no pueden ser iguales.",
  "horarioSimple.copiarATodos": "Aplicar a todos los días",
  "horarioSimple.copiarATodos.etiqueta": "Aplicar el horario del {dia} a todos los días",
} as const satisfies ModuloEs;
