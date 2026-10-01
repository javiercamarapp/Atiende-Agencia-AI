// Rn-18 -- reglas de comision de canal configurables desde Finanzas.
//   GET   /rentas/:propertyId/finanzas/reglas-comision            reglas aplicables a la propiedad + canales sin cobertura
//   POST  /rentas/:propertyId/finanzas/reglas-comision            alta (global de la organizacion o de la propiedad)
//   PATCH /rentas/:propertyId/finanzas/reglas-comision/:reglaId   edita ya-neto, puntos base y fuente
//   POST  /rentas/:propertyId/finanzas/reglas-comision/sugeridas  siembra los valores por defecto que falten
//
// Antes, solo service_role podia insertar en rentas.regla_comision_canal: un tenant nuevo no podia registrar el
// movimiento financiero de ninguna reserva. La autoridad real de cada escritura es la funcion SQL `security
// definer` de la migracion 027 (rol admin_gestora y alcance de property verificados DENTRO de la funcion); las
// rutas solo dan el primer filtro de rol (FINANZAS_ESCRITURA_ROLES, lectura FINANZAS_LECTURA_ROLES), validan la
// forma y escriben la bitacora. Contra una base sin migrar, las escrituras responden 503 honesto (SAVEPOINT en el
// adaptador) y la lectura sigue funcionando (la tabla existe desde la migracion 003).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { FINANZAS_ESCRITURA_ROLES, FINANZAS_LECTURA_ROLES, validarEntradaActualizarRegla, validarEntradaRegla } from "@atiende/domain-rentas";
import type { ReglaComisionRecord } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { catalogoRepo, valorOError } from "./catalogo-http.ts";

function serializar(r: ReglaComisionRecord) {
  return {
    id: r.id,
    alcance: r.propertyId === null ? "organizacion" : "propiedad",
    propertyId: r.propertyId,
    canalCodigo: r.canalCodigo,
    canalNombre: r.canalNombre,
    yaNetoDeComision: r.yaNetoDeComision,
    comisionBasisPoints: r.comisionBasisPoints,
    fuente: r.fuente,
    vigenteDesde: r.vigenteDesde,
    sugerida: r.sugerida,
  };
}

function resumen(r: { canalCodigo: string; yaNetoDeComision: boolean; comisionBasisPoints: number; fuente: string }): string {
  return `${r.canalCodigo} ${r.yaNetoDeComision ? "ya neto" : `${r.comisionBasisPoints}pb`} (${r.fuente})`;
}

export function rentasFinanzasReglasComisionRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/rentas/:propertyId/finanzas/reglas-comision";
  const item = `${base}/:reglaId`;
  const sugeridas = `${base}/sugeridas`;
  // `sugeridas` también calza con `item` (:reglaId): el middleware de `item` ya la cubre, no se registra dos veces.
  for (const path of [base, item]) app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(base, async (c) => {
    assertVerticalRole(c, FINANZAS_LECTURA_ROLES);
    const repo = catalogoRepo(deps, c.get("db"));
    const [reglas, canales] = await Promise.all([repo.listarReglasComision(c.get("organizationId"), c.req.param("propertyId")), repo.listarCanales()]);
    // Un canal esta cubierto si tiene una regla global o una de esta propiedad. El canal "manual" siempre tiene
    // respaldo (default seguro de 0 pb, ver finanzas/regla-comision-por-defecto.ts), asi que no se marca sin cobertura.
    const cubiertos = new Set(reglas.map((r) => r.canalCodigo));
    const canalesSinRegla = canales.filter((ch) => ch.codigo !== "manual" && !cubiertos.has(ch.codigo)).map((ch) => ch.codigo);
    return c.json({ reglas: reglas.map(serializar), canales, canalesSinRegla });
  });

  app.post(sugeridas, async (c) => {
    assertVerticalRole(c, FINANZAS_ESCRITURA_ROLES);
    const organizationId = c.get("organizationId");
    const repo = catalogoRepo(deps, c.get("db"));
    const { creadas } = valorOError(await repo.sembrarReglasComisionPorDefecto(organizationId), "Cargar las comisiones sugeridas");
    if (creadas > 0) {
      await deps.rentasRepo(c.get("db")).registrarAuditoria({
        organizationId,
        actorUserId: c.get("userId"),
        action: "regla_comision.sugeridas_cargadas",
        entityType: "regla_comision",
        entityId: null,
        campo: "reglas",
        antes: null,
        despues: `${creadas} regla(s) sugerida(s) creada(s)`,
      });
    }
    return c.json({ creadas }, creadas > 0 ? 201 : 200);
  });

  app.post(base, async (c) => {
    assertVerticalRole(c, FINANZAS_ESCRITURA_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const validada = validarEntradaRegla(await readJsonCapped<unknown>(c.req.raw, 4 * 1024));
    if (!validada.ok) throw Errors.validation(validada.error);
    const entrada = validada.valor;

    const { id } = valorOError(await catalogoRepo(deps, c.get("db")).crearReglaComision(organizationId, propertyId, entrada), "Configurar comisiones de canal");
    await deps.rentasRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "regla_comision.creada",
      entityType: "regla_comision",
      entityId: id,
      campo: "canal,yaNeto,comisionBasisPoints,fuente",
      antes: null,
      despues: `${resumen(entrada)} alcance=${entrada.alcance}`,
    });
    return c.json({ id }, 201);
  });

  app.patch(item, async (c) => {
    assertVerticalRole(c, FINANZAS_ESCRITURA_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const reglaId = c.req.param("reglaId");
    const validada = validarEntradaActualizarRegla(await readJsonCapped<unknown>(c.req.raw, 4 * 1024));
    if (!validada.ok) throw Errors.validation(validada.error);

    const repo = catalogoRepo(deps, c.get("db"));
    // La regla debe ser global de la organizacion o de ESTA propiedad: una regla de otra propiedad se edita desde esa propiedad.
    const previa = (await repo.listarReglasComision(organizationId, propertyId)).find((r) => r.id === reglaId);
    if (!previa) throw Errors.notFound("Regla de comisión no encontrada para esta propiedad.");

    valorOError(await repo.actualizarReglaComision(reglaId, validada.valor), "Configurar comisiones de canal");
    await deps.rentasRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "regla_comision.actualizada",
      entityType: "regla_comision",
      entityId: reglaId,
      campo: "yaNeto,comisionBasisPoints,fuente",
      antes: resumen(previa),
      despues: resumen({ canalCodigo: previa.canalCodigo, ...validada.valor }),
    });
    return c.json({ id: reglaId });
  });

  return app;
}
