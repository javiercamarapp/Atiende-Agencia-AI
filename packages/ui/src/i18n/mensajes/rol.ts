import type { ModuloEs } from "../tipos.ts";

/** Etiquetas de los roles de cada vertical (tarjeta de cuenta del Sidebar y menu de cuenta movil). */
export const rol = {
  "rol.owner": "Propietario",
  "rol.admin": "Administrador",
  "rol.staff": "Equipo",
  "rol.repartidor": "Repartidor",
  "rol.gm": "Gerente general",
  "rol.frontdesk": "Recepción",
  "rol.reservations": "Reservaciones",
  "rol.housekeeping": "Housekeeping",
  "rol.maintenance": "Mantenimiento",
  "rol.fnb": "Alimentos y bebidas",
  "rol.accountant": "Contador",
  "rol.contador": "Contador",
  "rol.auditor": "Auditor",
  "rol.readonly": "Solo lectura",
  "rol.analyst": "Analista",
  "rol.writer": "Redactor",
  "rol.reviewer": "Revisor",
  "rol.viewer": "Consulta",
  "rol.adminGestora": "Administrador gestora",
  "rol.operadorAccesoTotal": "Operador (acceso total)",
  "rol.operadorCalendarioMensajeria": "Operador (calendario y mensajes)",
  "rol.operadorSoloCalendario": "Operador (solo calendario)",
  "rol.limpieza": "Limpieza",
} as const satisfies ModuloEs;
