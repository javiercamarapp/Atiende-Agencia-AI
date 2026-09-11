// Agregador de las 3 rutas Hono elegidas para Fase 1 del vertical citas — mismo
// patrón de montaje que hotelesRoutes en apps/api/src/app.ts.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { AppDeps } from "../../../deps.ts";
import { citasAppointmentsRoutes } from "./appointments.ts";
import { citasAppointmentsLifecycleRoutes } from "./appointments-lifecycle.ts";
import { citasRemindersRoutes } from "./reminders.ts";

export function citasRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.route("/", citasAppointmentsRoutes(deps));
  app.route("/", citasAppointmentsLifecycleRoutes(deps));
  app.route("/", citasRemindersRoutes(deps));
  return app;
}
