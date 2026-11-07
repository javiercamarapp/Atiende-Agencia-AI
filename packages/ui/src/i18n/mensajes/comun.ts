import type { ModuloEs } from "../tipos.ts";
import { registrarModuloEs } from "./index.ts";

/** Textos transversales (estados, acciones genericas, idioma). La traduccion vive en `en/comun.ts`. */
export const comun = {
  "comun.idioma.etiqueta": "Idioma de la interfaz",
  "comun.idioma.es": "Español (ES)",
  "comun.idioma.en": "English (EN)",
  "comun.cargando": "Cargando…",
  "comun.reintentar": "Reintentar",
  "comun.cancelar": "Cancelar",
  "comun.guardar": "Guardar",
  "comun.cerrar": "Cerrar",
  "comun.confirmar": "Confirmar",
  "comun.error.generico": "Algo salió mal. Inténtalo de nuevo.",
  "comun.sinDatos": "Sin datos aún",
  "comun.resultados": { one: "{count} resultado", other: "{count} resultados" },
  "comun.volver": "Volver",
  "comun.deshacer": "Deshacer",
  "comun.ver": "Ver",
  "comun.obligatorio": " (obligatorio)",
  "comun.cerrarAviso": "Cerrar aviso",
  "comun.migas": "Migas de pan",
  "comun.error.titulo": "No se pudo cargar la información",
  "comun.error.servidor": "Ocurrió un problema al conectar con el servidor. Verifica la conexión e inténtalo de nuevo.",
  "comun.error.integracion": "No se pudo conectar con {integracion}. Verifica la conexión e inténtalo de nuevo.",
  "comun.error.pendienteCredenciales": "{integracion} está pendiente de credenciales. Conecta la integración para ver datos reales aquí.",
  "comun.error.etiquetaPendiente": "Pendiente de credenciales",
  "comun.comoLeerEsto": "¿Cómo leer esto?",
} as const satisfies ModuloEs;

registrarModuloEs(comun);
