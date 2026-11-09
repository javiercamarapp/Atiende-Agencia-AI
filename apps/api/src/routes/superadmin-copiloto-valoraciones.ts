// Back office: valoraciones «Útil / No fue útil» del Copiloto de TODAS las organizaciones (migracion 0079), solo conteos por vertical y
// organizacion. Ningun texto de pregunta ni de respuesta sale de aqui (la tabla ni siquiera los guarda).
//
// Autorizacion: el middleware de `/superadmin/*` (superadmin.ts) ya exige superadmin vigente; ademas la funcion SQL exige
// `auth.uid() = p_caller_id` y superadmin (42501), asi que no es la unica barrera. Base sin migrar (0079 pendiente): `disponible: false`, nunca 500.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { Errors } from "../errors.ts";
import type { AppDeps } from "../deps.ts";
import { VALORACIONES_NO_DISPONIBLE, parseDiasResumen, sumarFilas, type FilaResumenSql, type ResumenValoraciones } from "../data-chat/valoraciones.ts";

export interface FilaValoracionesPlataforma extends Omit<ResumenValoraciones, "disponible"> {
  readonly vertical: string;
  /** null = Copiloto de plataforma (sin organizacion). */
  readonly organizacionId: string | null;
  readonly organizacion: string | null;
}

interface FilaSql extends FilaResumenSql {
  readonly vertical: string;
  readonly organization_id: string | null;
  readonly organization_name: string | null;
}

/** Agrupa las filas `(vertical, organizacion, util, motivo, total)` en una fila por vertical y organizacion, ordenadas por «No fue útil». */
export function agruparPorOrganizacion(filas: readonly FilaSql[]): FilaValoracionesPlataforma[] {
  const grupos = new Map<string, { vertical: string; organizacionId: string | null; organizacion: string | null; filas: FilaSql[] }>();
  for (const f of filas) {
    const clave = `${f.vertical}|${f.organization_id ?? ""}`;
    const g = grupos.get(clave) ?? { vertical: f.vertical, organizacionId: f.organization_id, organizacion: f.organization_name, filas: [] };
    g.filas.push(f);
    grupos.set(clave, g);
  }
  return [...grupos.values()]
    .map((g) => ({ vertical: g.vertical, organizacionId: g.organizacionId, organizacion: g.organizacion, ...sumarFilas(g.filas) }))
    .sort((a, b) => b.noUtiles - a.noUtiles || b.utiles - a.utiles || a.vertical.localeCompare(b.vertical));
}

export function superadminCopilotoValoracionesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.get("/superadmin/copiloto/valoraciones", async (c) => {
    const dias = parseDiasResumen(c.req.query("dias"));
    const callerId = c.get("userId");
    if (!callerId) throw Errors.unauthorized();
    const datos = await deps.engine.withAppSession({ userId: callerId }, (db) =>
      runWithSavepointFallback<FilaSql[] | null>({
        session: db,
        primary: async () =>
          (
            await db.query<FilaSql>(
              `select vertical, organization_id, organization_name, util, motivo, total
                 from core.superadmin_data_chat_feedback_resumen($1::uuid, now() - make_interval(days => $2::int));`,
              [callerId, dias],
            )
          ).rows,
        isRecoverable: isMigrationPendingError,
        fallback: async () => null,
      }),
    );
    if (datos === null) return c.json({ disponible: false, mensaje: VALORACIONES_NO_DISPONIBLE, dias, total: sumarFilas([]), filas: [] });
    return c.json({ disponible: true, dias, total: sumarFilas(datos), filas: agruparPorOrganizacion(datos) });
  });

  return app;
}
