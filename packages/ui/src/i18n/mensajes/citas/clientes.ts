import type { ModuloEs } from "../../tipos.ts";

/** Clientes de citas: lista con busqueda y ficha con proximas citas. Ingles: `en/citas/clientes.ts`. */
export const citasClientes = {
  "citas.clientes.errorLista": "No se pudieron cargar los clientes.",
  "citas.clientes.titulo": "Clientes",
  "citas.clientes.buscar": "Buscar cliente",
  "citas.clientes.buscarPlaceholder": "Buscar por nombre o teléfono…",
  "citas.clientes.cargandoLista": "Cargando clientes…",
  "citas.clientes.sinCoincidencias": "Ningún cliente coincide con esa búsqueda.",
  "citas.clientes.sinClientes": "Este negocio todavía no tiene clientes.",
  "citas.clientes.col.cliente": "Cliente",
  "citas.clientes.col.contacto": "Contacto",
  "citas.clientes.rango": "{desde}–{hasta} de {total}",
  "citas.clientes.errorFicha": "No se pudo cargar el cliente.",
  "citas.clientes.errorCorreo": "No se pudo guardar el correo.",
  "citas.clientes.volver": "Volver a clientes",
  "citas.clientes.cargandoFicha": "Cargando cliente…",
  "citas.clientes.correoCliente": "Correo del cliente",
  "citas.clientes.guardando": "Guardando…",
  "citas.clientes.guardar": "Guardar",
  "citas.clientes.agregarCorreo": "Agregar correo (para sincronizar con Cal.com)",
  "citas.clientes.proximas": "Próximas citas",
  "citas.clientes.sinProximas": "Sin citas próximas.",
} as const satisfies ModuloEs;
