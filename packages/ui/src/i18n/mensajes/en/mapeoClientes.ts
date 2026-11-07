import type { Traduccion } from "../../tipos.ts";
import type { mapeoClientes } from "../mapeoClientes.ts";

export const mapeoClientesEn: Traduccion<typeof mapeoClientes> = {
  "mapeoClientes.titulo": "Map your columns",
  "mapeoClientes.ayuda": "We suggest this from each column's name and from what its cells contain (not AI): review it before you continue.",
  "mapeoClientes.campo.telefono": "Phone",
  "mapeoClientes.campo.nombre": "Name",
  "mapeoClientes.campo.direccion": "Address",
  "mapeoClientes.campo.colonia": "Neighborhood",
  "mapeoClientes.campo.notas": "Notes",
  "mapeoClientes.telefono.pista": "10 digits; +52 and 521 are accepted.",
  "mapeoClientes.opcion.elegir": "Choose the column…",
  "mapeoClientes.opcion.noImportar": "Don't import",
  "mapeoClientes.columna": "Column {numero}",
  "mapeoClientes.columnaConNombre": "Column {numero}: {nombre}",
  "mapeoClientes.ejemplo": "e.g. {valores}",
  "mapeoClientes.error.falta": "Choose the phone column: it identifies each customer (so nobody is duplicated).",
  "mapeoClientes.error.repetida": "That column is already used for another field.",
  "mapeoClientes.aviso.telefono": "Only {plausibles} of {conValor} cells in that column look like a phone number. Is it the right column?",
  "mapeoClientes.vista.titulo": "This is how the first rows will be read",
};
