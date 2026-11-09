import type { ModuloEs } from "../tipos.ts";

/** Paso «Mapea tus columnas» de la importacion de clientes (restaurantes). La traduccion vive en `en/mapeoClientes.ts`. */
export const mapeoClientes = {
  "mapeoClientes.titulo": "Mapea tus columnas",
  "mapeoClientes.ayuda": "Lo sugerimos por el nombre de cada columna y por lo que traen sus celdas (no es IA): revísalo antes de continuar.",
  "mapeoClientes.campo.telefono": "Teléfono",
  "mapeoClientes.campo.nombre": "Nombre",
  "mapeoClientes.campo.direccion": "Dirección",
  "mapeoClientes.campo.colonia": "Colonia",
  "mapeoClientes.campo.notas": "Notas",
  "mapeoClientes.telefono.pista": "10 dígitos; +52 y 521 se aceptan.",
  "mapeoClientes.opcion.elegir": "Elige la columna…",
  "mapeoClientes.opcion.noImportar": "No importar",
  "mapeoClientes.columna": "Columna {numero}",
  "mapeoClientes.columnaConNombre": "Columna {numero}: {nombre}",
  "mapeoClientes.ejemplo": "ej. {valores}",
  "mapeoClientes.error.falta": "Elige la columna del teléfono: es la llave del cliente (así no se duplica).",
  "mapeoClientes.error.repetida": "Esa columna ya se usa en otro dato.",
  "mapeoClientes.aviso.telefono": "Solo {plausibles} de {conValor} celdas de esa columna parecen teléfono: ¿es la columna correcta?",
  "mapeoClientes.vista.titulo": "Así se van a leer los primeros renglones",
} as const satisfies ModuloEs;
