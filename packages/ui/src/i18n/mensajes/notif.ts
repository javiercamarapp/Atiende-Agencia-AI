import type { ModuloEs } from "../tipos.ts";

/** Campana y centro de notificaciones: viaja con su chunk (no esta en el de arranque). */
export const notif = {
  "notif.titulo": "Notificaciones",
  "notif.conAvisos": "Notificaciones: hay avisos sin leer",
  "notif.marcarTodas": "Marcar todas",
  "notif.cargando": "Cargando notificaciones",
  "notif.error": "No se pudieron cargar las notificaciones.",
  "notif.reintentar": "Volver a intentar",
  "notif.vacio": "Estás al día. No hay notificaciones.",
  "notif.sinLeer": "Sin leer",
  "notif.verTodas": "Ver todas las notificaciones",
  "notif.severidad.info": "Informativa",
  "notif.severidad.atencion": "Requiere atención",
  "notif.severidad.critica": "Crítica",
} as const satisfies ModuloEs;
