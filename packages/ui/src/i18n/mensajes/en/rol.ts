import type { Traduccion } from "../../tipos.ts";
import type { rol } from "../rol.ts";

export const rolEn: Traduccion<typeof rol> = {
  "rol.owner": "Owner",
  "rol.admin": "Admin",
  "rol.staff": "Staff",
  "rol.repartidor": "Delivery driver",
  "rol.gm": "General manager",
  "rol.frontdesk": "Front desk",
  "rol.reservations": "Reservations",
  "rol.housekeeping": "Housekeeping",
  "rol.maintenance": "Maintenance",
  "rol.fnb": "Food & beverage",
  "rol.accountant": "Accountant",
  "rol.contador": "Accountant",
  "rol.auditor": "Auditor",
  "rol.readonly": "Read-only",
  "rol.analyst": "Analyst",
  "rol.writer": "Writer",
  "rol.reviewer": "Reviewer",
  "rol.viewer": "Viewer",
  "rol.adminGestora": "Property manager admin",
  "rol.operadorAccesoTotal": "Operator (full access)",
  "rol.operadorCalendarioMensajeria": "Operator (calendar & messages)",
  "rol.operadorSoloCalendario": "Operator (calendar only)",
  "rol.limpieza": "Cleaning",
};
