// Etiquetas legibles de los roles de cada vertical, para la tarjeta de usuario del Sidebar (pie del
// marco de Likida: nombre + rol en mayusculas). Solo es presentacion: el rol real que decide permisos
// sigue siendo el de la sesion y el servidor es la unica autoridad (ver los *_NAV_ROLES de cada shell).
//
// Un rol que no aparece aqui (p. ej. uno nuevo del dominio) se muestra tal cual llego, nunca se inventa.
import { registrarModuloEs, traducir, type Clave, type Traductor } from "@atiende/ui";
import { rol as modRol } from "@atiende/ui/i18n/rol";

/** Clave del catalogo i18n (packages/ui/src/i18n/mensajes/rol.ts) de cada rol conocido. */
export const CLAVES_ROL: Readonly<Record<string, Clave>> = {
  owner: "rol.owner",
  admin: "rol.admin",
  staff: "rol.staff",
  repartidor: "rol.repartidor",
  gm: "rol.gm",
  frontdesk: "rol.frontdesk",
  reservations: "rol.reservations",
  housekeeping: "rol.housekeeping",
  maintenance: "rol.maintenance",
  fnb: "rol.fnb",
  accountant: "rol.accountant",
  contador: "rol.contador",
  auditor: "rol.auditor",
  readonly: "rol.readonly",
  analyst: "rol.analyst",
  writer: "rol.writer",
  reviewer: "rol.reviewer",
  viewer: "rol.viewer",
  admin_gestora: "rol.adminGestora",
  "operador:acceso_total": "rol.operadorAccesoTotal",
  "operador:calendario_mensajeria": "rol.operadorCalendarioMensajeria",
  "operador:solo_calendario": "rol.operadorSoloCalendario",
  limpieza: "rol.limpieza",
};

/**
 * Etiqueta legible del rol; sin rol devuelve `undefined` y un rol desconocido se devuelve sin cambios. Con `t` (i18n ES/EN) sale en
 * el idioma de la consola; sin `t`, en espanol (compatibilidad con quien aun no pasa el traductor).
 */
export function etiquetaRol(rol: string | undefined | null, t?: Traductor): string | undefined {
  if (!rol) return undefined;
  const clave = Object.hasOwn(CLAVES_ROL, rol) ? CLAVES_ROL[rol] : undefined;
  if (!clave) return rol;
  registrarModuloEs(modRol);
  return t ? t(clave) : traducir("es", clave);
}
