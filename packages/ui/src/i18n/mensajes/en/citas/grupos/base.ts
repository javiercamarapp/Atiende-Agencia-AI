/** Ingles del grupo «base» de citas (ver mensajes/citas/grupos/base.ts). */
import { citasComunEn } from "../comun.ts";
import { citasResumenEn } from "../resumen.ts";
import { citasClientesEn } from "../clientes.ts";
import { citasAgendaEn } from "../agenda.ts";

export const EN_CITAS_BASE = {
  citasComun: citasComunEn,
  citasResumen: citasResumenEn,
  citasClientes: citasClientesEn,
  citasAgenda: citasAgendaEn,
} as const;
