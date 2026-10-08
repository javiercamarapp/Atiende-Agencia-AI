// Subpath `@atiende/domain-restaurantes/cfo`: dominio puro del CFO de restaurantes (sin SQL ni I/O).
// CFO-05: puerto del repositorio, repositorio en memoria, servicio y contrato tipado de la API. El adaptador Postgres NO se reexporta aquí
// (importa `@atiende/db`, de Node, y la web importa este subpath): vive en `@atiende/domain-restaurantes/cfo/postgres`.
export * from "./tipos.ts";
export * from "./consolidar.ts";
export * from "./formulas.ts";
export * from "./estado-resultados.ts";
export * from "./segmentos.ts";
export * from "./hallazgos.ts";
export * from "./narrativa.ts";
export * from "./sr-normalizar.ts";
export * from "./repositorio.ts";
export * from "./repositorio-memoria.ts";
export * from "./servicio.ts";
export * from "./tipos-api.ts";
export { restarAnio, rangoAnterior, rangoAnioAnterior, ventanas4Semanas, rangoComparativo } from "./servicio-util.ts";
export {
  cifra,
  sinDato,
  combinarConfianza,
  divEntera,
  mulDiv,
  redondear,
  pct1,
  razon1,
  formatoCentavos,
  formatoPesos,
  formatoEntero,
  formatoPct,
  formatoMinutos,
  fechaLocal,
  expandirDias,
  // Contrato con la SQL (CFO-05): node-postgres entrega bigint/numeric como string; minutos en centésimas enteras.
  numericoSql,
  centesimas,
  sumaDecimal2,
  promedioMin1,
  difFraccionesGE,
} from "./util.ts";
