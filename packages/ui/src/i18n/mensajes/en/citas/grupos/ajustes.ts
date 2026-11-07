/** Ingles del grupo «ajustes» de citas (ver mensajes/citas/grupos/ajustes.ts). */
import { citasServiciosEn } from "../servicios.ts";
import { citasStaffEn } from "../staff.ts";
import { citasDisponibilidadEn } from "../disponibilidad.ts";

export const EN_CITAS_AJUSTES = {
  citasServicios: citasServiciosEn,
  citasStaff: citasStaffEn,
  citasDisponibilidad: citasDisponibilidadEn,
} as const;
