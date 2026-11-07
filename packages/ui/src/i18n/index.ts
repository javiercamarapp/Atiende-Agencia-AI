export { IdiomaProvider, useI18n, useT, type ContextoI18n, type IdiomaProviderProps } from "./proveedor";
export { traducir, crearTraductor, type Traductor } from "./traducir";
export { LOCALE_POR_IDIOMA } from "./tipos";
// Formato (useFormatos / crearFormatos) NO va en el barril: se importa de "@atiende/ui/i18n/formato" para no pesar en la entrada.
export type { Idioma as IdiomaUi, Mensaje, ModuloEs, Plural, Traduccion, Variables } from "./tipos";
export { CATALOGO_ES, MODULOS, cargarIdioma, catalogoDe, idiomaListo, type Catalogo, type Clave, type ModulosTraducidos } from "./mensajes";
