// Etiquetas legibles de los roles de cada vertical, para la tarjeta de usuario del Sidebar (pie del
// marco de Likida: nombre + rol en mayusculas). Solo es presentacion: el rol real que decide permisos
// sigue siendo el de la sesion y el servidor es la unica autoridad (ver los *_NAV_ROLES de cada shell).
//
// Un rol que no aparece aqui (p. ej. uno nuevo del dominio) se muestra tal cual llego, nunca se inventa.
const ETIQUETAS_ROL: Readonly<Record<string, string>> = {
  // Compartidos (restaurantes, citas, licitaciones, despachos)
  owner: "Propietario",
  admin: "Administrador",
  staff: "Equipo",
  // Restaurantes
  repartidor: "Repartidor",
  // Hoteles (HOTEL_ROLES de domain-hoteles)
  gm: "Gerente general",
  frontdesk: "Recepción",
  reservations: "Reservaciones",
  housekeeping: "Housekeeping",
  maintenance: "Mantenimiento",
  fnb: "Alimentos y bebidas",
  accountant: "Contador",
  // Despachos (DESPACHOS_ROLES de domain-despachos)
  contador: "Contador",
  auditor: "Auditor",
  readonly: "Solo lectura",
  // Licitaciones (LICITACIONES_ROLES de domain-licitaciones)
  analyst: "Analista",
  writer: "Redactor",
  reviewer: "Revisor",
  viewer: "Consulta",
  // Rentas (RENTAS_VERTICAL_ROLES de domain-rentas)
  admin_gestora: "Administrador gestora",
  "operador:acceso_total": "Operador (acceso total)",
  "operador:calendario_mensajeria": "Operador (calendario y mensajes)",
  "operador:solo_calendario": "Operador (solo calendario)",
  limpieza: "Limpieza",
};

/** Etiqueta legible del rol; sin rol devuelve `undefined` y un rol desconocido se devuelve sin cambios. */
export function etiquetaRol(rol: string | undefined | null): string | undefined {
  if (!rol) return undefined;
  return ETIQUETAS_ROL[rol] ?? rol;
}
