export { I18nContexto, IdiomaProvider, useI18n, useT, type ContextoI18n, type IdiomaProviderProps } from "./proveedor";
export { traducir, crearTraductor, type Traductor } from "./traducir";
export { LOCALE_POR_IDIOMA } from "./tipos";
export { idiomaActivo, localeActivo } from "./activo";
export { etiquetasTraducidas, traductorActivo } from "./traductor-activo";
// Formato (useFormatos / crearFormatos) NO va en el barril: se importa de "@atiende/ui/i18n/formato" para no pesar en la entrada.
export type { Idioma as IdiomaUi, Mensaje, ModuloEs, Plural, Traduccion, Variables } from "./tipos";
export { CATALOGO_ES, MODULOS, cargarIdioma, catalogoDe, idiomaListo, registrarModuloEs, type Catalogo, type Clave, type ModulosTraducidos } from "./mensajes";
