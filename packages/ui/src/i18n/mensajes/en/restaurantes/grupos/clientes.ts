/** Ingles del grupo «clientes» de restaurantes (ver mensajes/restaurantes/grupos/clientes.ts). */
import { restaurantesClientesEn } from "../clientes.ts";
import { restaurantesClienteFichaEn } from "../clienteFicha.ts";
import { restaurantesExportarEn } from "../exportar.ts";
import { restaurantesStaffEn } from "../staff.ts";

export const EN_RESTAURANTES_CLIENTES = {
  restaurantesClientes: restaurantesClientesEn,
  restaurantesClienteFicha: restaurantesClienteFichaEn,
  restaurantesExportar: restaurantesExportarEn,
  restaurantesStaff: restaurantesStaffEn,
} as const;
