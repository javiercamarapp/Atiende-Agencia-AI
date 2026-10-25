// Minimo de datos personales para el personal de mostrador (`staff`: cajero/encargado). Dueño y administrador ven todo (el CFO y la
// exportacion ya son suyos); el repartidor tiene su propia superficie enmascarada (repartidor-orders.ts).
//
// Regla: el `staff` necesita el telefono mientras el pedido esta vivo (confirmar, avisar, llamar) y no despues. En pedidos terminados,
// en el listado de clientes y en la ficha ve solo los ultimos 4 digitos y nunca el correo. Es defensa en profundidad del lado servidor:
// la UI solo pinta lo que recibe.
//
// Alcance (revisado): el listado de clientes y la ficha ya salen SIEMPRE enmascarados para el `staff` (mas estricto que el pedido vivo). Excepciones
// deliberadas y documentadas: (a) el pedido VIVO conserva el telefono completo para el staff, que necesita confirmar y avisar; (b) las solicitudes de
// contacto («callbacks», conversaciones-admin.ts) llevan el telefono completo para MANAGER_ROLES porque su unico fin es devolver la llamada;
// (c) las solicitudes ARCO (privacidad.ts) son solo owner/admin. Defensa en profundidad pendiente en base: ver la nota de la migracion 097 sobre
// las policies de SELECT de orders/customers.
import type { Context } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { maskPhone } from "@atiende/domain-restaurantes";

const ESTADOS_TERMINADOS: readonly string[] = ["entregado", "completado", "cancelado", "no_recogido"];

/** `true` cuando quien consulta debe ver el minimo de PII (rol `staff`). Un rol desconocido tambien (fail-closed). */
export function vistaMinimaPii(c: Context<CoreAuthHonoEnv>): boolean {
  const rol = c.get("verticalRole");
  return rol !== "owner" && rol !== "admin";
}

export function telefonoDePedido(minima: boolean, phone: string, status: string): string {
  return minima && ESTADOS_TERMINADOS.includes(status) ? maskPhone(phone) : phone;
}

export function correoDePedido<T extends string | null>(minima: boolean, email: T): T | null {
  return minima ? null : email;
}

export function telefonoDeCliente(minima: boolean, phone: string): string {
  return minima ? maskPhone(phone) : phone;
}
