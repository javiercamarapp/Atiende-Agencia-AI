/** Restaurantes, grupo «clientes»: Clientes, staff, turnos, cierres, auditoria y privacidad. Un PR por grupo edita SOLO este archivo (y su par en en/), sin chocar con los demas. */
import type { restaurantesClientes } from "../clientes.ts";
import type { restaurantesClienteFicha } from "../clienteFicha.ts";
import type { restaurantesExportar } from "../exportar.ts";
import type { restaurantesStaff } from "../staff.ts";

export interface ModulosRestaurantesClientes {
  readonly restaurantesClientes: typeof restaurantesClientes;
  readonly restaurantesClienteFicha: typeof restaurantesClienteFicha;
  readonly restaurantesExportar: typeof restaurantesExportar;
  readonly restaurantesStaff: typeof restaurantesStaff;
}
