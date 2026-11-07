import type { Traduccion } from "../../tipos.ts";
import type { notif } from "../notif.ts";

export const notifEn: Traduccion<typeof notif> = {
  "notif.titulo": "Notifications",
  "notif.conAvisos": "Notifications: you have unread alerts",
  "notif.marcarTodas": "Mark all as read",
  "notif.cargando": "Loading notifications",
  "notif.error": "Notifications couldn't be loaded.",
  "notif.reintentar": "Try again",
  "notif.vacio": "You're all caught up. No notifications.",
  "notif.sinLeer": "Unread",
  "notif.verTodas": "View all notifications",
  "notif.severidad.info": "Info",
  "notif.severidad.atencion": "Needs attention",
  "notif.severidad.critica": "Critical",
};
