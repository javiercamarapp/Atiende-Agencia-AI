import type { Traduccion } from "../../../tipos.ts";
import type { citasClientes } from "../../citas/clientes.ts";

export const citasClientesEn: Traduccion<typeof citasClientes> = {
  "citas.clientes.errorLista": "Couldn't load the customers.",
  "citas.clientes.titulo": "Customers",
  "citas.clientes.buscar": "Search customers",
  "citas.clientes.buscarPlaceholder": "Search by name or phone…",
  "citas.clientes.cargandoLista": "Loading customers…",
  "citas.clientes.sinCoincidencias": "No customers match that search.",
  "citas.clientes.sinClientes": "This business doesn't have any customers yet.",
  "citas.clientes.col.cliente": "Customer",
  "citas.clientes.col.contacto": "Contact",
  "citas.clientes.rango": "{desde}–{hasta} of {total}",
  "citas.clientes.errorFicha": "Couldn't load the customer.",
  "citas.clientes.errorCorreo": "Couldn't save the email.",
  "citas.clientes.volver": "Back to customers",
  "citas.clientes.cargandoFicha": "Loading customer…",
  "citas.clientes.correoCliente": "Customer email",
  "citas.clientes.guardando": "Saving…",
  "citas.clientes.guardar": "Save",
  "citas.clientes.agregarCorreo": "Add email (to sync with Cal.com)",
  "citas.clientes.proximas": "Upcoming appointments",
  "citas.clientes.sinProximas": "No upcoming appointments.",
};
