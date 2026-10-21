// "Listo para produccion" de una organizacion (go-live G-05/G-16):
//   GET /superadmin/organizaciones/:organizationId/preflight -- lista de verificaciones por area (entorno, crons, equipo, canal, privacidad, voz,
//                                                               datos, monitoreo) con estado ok | falta | aviso | no_aplica, detalle sin secretos y
//                                                               como resolver cada una (texto + enlace relativo a la pantalla que lo arregla).
//
// SOLO LECTURA y solo superadmin: la autenticacion y el gateo de `/superadmin/*` (rol superadmin real, bitacora de denegaciones, step-up)
// corren antes (routes/superadmin.ts); el calculo vive en `../superadmin-preflight/verificaciones.ts` (funciones puras, probadas sin base).
// Esta ruta solo LEE: latidos de crons (la misma funcion que /superadmin/salud), el equipo (core.list_org_team_for_superadmin, 0053), los hechos
// de datos (core.get_org_preflight_restaurantes_for_superadmin, 0057), el factor MFA del consultante y el env del proceso (solo nombres y
// booleanos: ningun valor sale en la respuesta).
//
// Compatibilidad con la base sin migrar: cada fuente falla POR SEPARADO (SAVEPOINT en su repositorio, o try/catch en su propia sesion) y su
// verificacion sale `aviso` con la razon; nunca un 500 ni un "todo bien" por falta de dato.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { Errors } from "../errors.ts";
import { construirEstadoCrons } from "./superadmin-salud.ts";
import { AREAS_PREFLIGHT, evaluarPreflight } from "../superadmin-preflight/verificaciones.ts";
import type { FuentePreflight } from "../superadmin-preflight/verificaciones.ts";
import type { CronConEstado } from "../salud/motor.ts";
import type { AppDeps } from "../deps.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Lectura de un repositorio -> fuente del calculo; `null` = el despliegue no inyecta ese repositorio (no disponible). */
function aFuente<T>(r: { readonly ok: true; readonly data: T } | { readonly ok: false; readonly razon: "no_migrado" | "error" } | null): FuentePreflight<T> {
  if (r === null) return { estado: "no_disponible" };
  return r.ok ? { estado: "ok", dato: r.data } : { estado: r.razon };
}

export function superadminPreflightRoutes(deps: AppDeps, opciones: { readonly ahora?: () => Date; readonly env?: Readonly<Record<string, string | undefined>> } = {}): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const ahora = opciones.ahora ?? (() => new Date());

  async function leerCrons(callerId: string): Promise<readonly CronConEstado[] | null> {
    try {
      const heartbeats = await deps.saludRepo.listCronHeartbeatsForSuperadmin(callerId);
      return construirEstadoCrons(heartbeats, ahora());
    } catch {
      return null;
    }
  }

  async function leerMfa(callerId: string): Promise<boolean | null> {
    const repo = deps.mfaRepo;
    if (!repo) return null;
    try {
      const { availability, factor } = await deps.engine.withAppSession({ userId: null }, (db) => repo(db).getFactor(callerId));
      return availability === "not_migrated" ? null : factor?.status === "active";
    } catch {
      return null;
    }
  }

  app.get("/superadmin/organizaciones/:organizationId/preflight", async (c) => {
    const callerId = c.get("userId");
    const organizationId = c.req.param("organizationId");
    if (!UUID_RE.test(organizationId)) throw Errors.notFound("Organización no encontrada.");

    const organizaciones = await deps.coreRepo.listAllOrganizationsForSuperadmin(callerId);
    const org = organizaciones.find((o) => o.id === organizationId);
    if (!org) throw Errors.notFound("Organización no encontrada.");

    // Hechos y equipo: UNA sesion del caller; cada repositorio protege su lectura con su propio SAVEPOINT.
    const equipoRepo = deps.orgEquipoRepo;
    const preflightRepo = deps.orgPreflightRepo;
    const [{ equipo, hechos }, crons, mfaDelConsultante] = await Promise.all([
      deps.engine.withAppSession({ userId: callerId }, async (db) => ({
        equipo: aFuente(equipoRepo ? await equipoRepo(db).leer(callerId, organizationId) : null),
        hechos: aFuente(preflightRepo ? await preflightRepo(db).hechos(callerId, organizationId) : null),
      })),
      leerCrons(callerId),
      leerMfa(callerId),
    ]);

    const resultado = evaluarPreflight({
      organizacion: { id: org.id, nombre: org.name, slug: org.slug, vertical: org.vertical, estado: org.status },
      env: opciones.env ?? process.env,
      crons,
      equipo,
      hechos,
      mfaDelConsultante,
    });

    return c.json({
      organizacion: { id: org.id, nombre: org.name, slug: org.slug, vertical: org.vertical, estado: org.status },
      generadoEn: ahora().toISOString(),
      resumen: resultado.resumen,
      fuentes: { crons: crons === null ? "error" : "ok", equipo: equipo.estado, datos: hechos.estado, mfa: mfaDelConsultante === null ? "no_disponible" : "ok" },
      areas: AREAS_PREFLIGHT.map((area) => ({ area, verificaciones: resultado.verificaciones.filter((v) => v.area === area) })),
    });
  });

  return app;
}
