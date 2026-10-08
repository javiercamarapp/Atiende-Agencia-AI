// Subpath `@atiende/domain-restaurantes/cfo`: dominio puro del CFO de restaurantes (sin SQL ni I/O).
// CFO-05 agregará aquí la exportación de sus repositorios; mantén este archivo como lista de reexports.
export * from "./tipos.ts";
export * from "./consolidar.ts";
export * from "./formulas.ts";
export * from "./estado-resultados.ts";
export * from "./segmentos.ts";
export * from "./hallazgos.ts";
export * from "./narrativa.ts";
export * from "./sr-normalizar.ts";
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
} from "./util.ts";
