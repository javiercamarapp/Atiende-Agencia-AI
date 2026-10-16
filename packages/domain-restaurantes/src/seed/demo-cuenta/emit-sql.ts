// Emision a ARCHIVO .sql del seed de la cuenta demo ficticia (modo `--emit-sql=<archivo>`): un script COMPLETO, autocontenido y listo para pegar en el
// SQL Editor de Supabase (rol postgres), sin abrir ninguna conexion ni usar credenciales. Puro: solo devuelve texto.
//
// NO duplica el SQL del seed: el paso 1-N es exactamente `renderDemoCuentaPlpgsql` (`sql.ts`), con los datos como JSON inline entre delimitadores
// dollar-quote (`$dc$`) y un guardia que aborta la emision si algun dato contiene un delimitador reservado. Las comillas simples, dobles, `\` y `$$`
// dentro del JSON son inocuos: un literal entre dollar-quotes no interpreta nada.
import { renderEsquemaRequeridoDemoCuenta, renderDemoCuentaPlpgsql, normalizarOwnerEmail } from "./sql.ts";
import type { DemoCuentaPlan } from "./plan.ts";

/** Una fila de la verificacion: nombre de la metrica, consulta (conteo) y minimo esperado. */
function metricas(plan: DemoCuentaPlan): readonly { readonly nombre: string; readonly consulta: string; readonly esperado: number; readonly critica: boolean }[] {
  const slug = plan.organization.slug.replace(/'/g, "''"); // el slug ya esta validado por el plan (a-z, 0-9, guion); esto es defensa en profundidad
  const enOrg = (tabla: string, extra = "") =>
    `(select count(*)::int from ${tabla} x join core.organization o on o.id = x.organization_id where o.slug = '${slug}'${extra})`;
  return [
    { nombre: "organizaciones", consulta: "(select count(*)::int from core.organization where slug = '" + slug + "')", esperado: 1, critica: true },
    { nombre: "sucursales", consulta: enOrg("core.property"), esperado: plan.summary.branches, critica: true },
    { nombre: "productos", consulta: enOrg("restaurantes.products"), esperado: plan.summary.products, critica: true },
    {
      nombre: "precios_por_sucursal",
      consulta: `(select count(*)::int from restaurantes.branch_products bp join core.property p on p.id = bp.property_id join core.organization o on o.id = p.organization_id where o.slug = '${slug}')`,
      esperado: plan.summary.branchProducts,
      critica: true,
    },
    { nombre: "productos_alcohol_sin_domicilio", consulta: enOrg("restaurantes.products", " and x.no_domicilio"), esperado: plan.summary.alcoholProducts, critica: true },
    { nombre: "promociones", consulta: enOrg("restaurantes.promotions"), esperado: plan.summary.promotions, critica: true },
    { nombre: "zonas_de_reparto", consulta: enOrg("restaurantes.known_zone"), esperado: plan.zones.length + plan.summary.colonias, critica: true },
    { nombre: "conocimiento_publicado", consulta: enOrg("restaurantes.conocimiento_negocio", " and x.estado = 'publicado'"), esperado: plan.summary.conocimiento, critica: false },
    { nombre: "voz_deshabilitada", consulta: enOrg("restaurantes.branch_voice_config", " and not x.habilitado"), esperado: plan.summary.branches, critica: false },
  ];
}

/** `soloCriticas`: la comprobacion que revierte la transaccion se limita a lo que el seed repara en cada corrida (lo que el dueno pudo cambiar solo se informa). */
function valoresMetricas(plan: DemoCuentaPlan, soloCriticas: boolean): string {
  return metricas(plan)
    .filter((m) => m.critica || !soloCriticas)
    .map((m) => `    ('${m.nombre}', ${m.consulta}, ${m.esperado})`)
    .join(",\n");
}

/** Cabecera de comentarios: que hace, que garantiza y como revisarlo. */
function cabecera(plan: DemoCuentaPlan, ownerEmail: string | null): string {
  const s = plan.summary;
  return `-- ============================================================================================================================================
-- Seed de la cuenta DEMO FICTICIA "${plan.organization.name.replace(/[\r\n]+/g, " ")}"  (slug ${plan.organization.slug}, version ${plan.organization.seedVersion})
-- GENERADO por: npx vite-node scripts/seed-demo-cuenta/seed-demo-cuenta.ts -- --emit-sql=<archivo>   (no editar a mano; regenerar)
--
-- QUE HACE: crea (o repara) UNA organizacion de restaurantes con ${s.branches} sucursales, ${s.products} productos en ${s.categories} categorias (${s.branchProducts} precios por sucursal),
--   ${plan.zones.length + s.colonias} zonas de reparto, ${s.promotions} promociones, ${s.conocimiento} piezas de conocimiento y un agente de WhatsApp. Todo es ficticio.
--   Duenos: ${ownerEmail ? `si ya existe un usuario de staff con el correo ${ownerEmail}, se le da membresia owner (nunca se crea un usuario ni credenciales)` : "SIN dueno: no se crea ninguna membresia ni usuario. Para asignarlo despues, regenere el archivo con --owner-email=<correo> y peguelo otra vez (es seguro repetir)"}.
--   La voz se carga DESHABILITADA (sin gasto de proveedores). No genera pedidos.
--
-- ES IDEMPOTENTE: puede pegarse y ejecutarse varias veces; repite el mismo resultado y no duplica nada. Re-ejecutar repara lo que el seed controla
--   (nombres, precios, horarios, cobertura) y NO pisa decisiones del dueno (no vuelve a prender un agotado, no reactiva la voz, no reinicia contadores).
--
-- NO BORRA NADA NI TOCA OTRAS ORGANIZACIONES: todo esta acotado a la organizacion con slug '${plan.organization.slug}' (si ese slug ya existiera en otra vertical,
--   aborta). La "Taqueria Demo" vieja (slug demo-restaurantes) y la cuenta real de PM quedan intactas. El unico DELETE del script retira de
--   restaurantes.branch_products los precios que este mismo plan ya no vende, dentro de esta organizacion.
--
-- ES UNA SOLA TRANSACCION: begin ... commit. Si cualquier paso falla (esquema incompleto, conteos menores a los esperados) se revierte TODO.
--   Paso 0 revisa que la base tenga el esquema/migraciones que el seed necesita; el paso final es un SELECT de verificacion (esperado vs obtenido).
-- ============================================================================================================================================
`;
}

/**
 * Archivo .sql completo: `begin; <preflight> <seed idempotente> <comprobacion> commit; <select de verificacion>;`.
 * El SELECT de verificacion va DESPUES del commit para que sea el resultado que muestra el editor; la comprobacion previa (dentro de la transaccion)
 * aborta y revierte si los conteos son menores a los esperados.
 */
export function renderDemoCuentaArchivoSql(plan: DemoCuentaPlan, options: { readonly ownerEmail?: string | null } = {}): string {
  const owner = normalizarOwnerEmail(options.ownerEmail);
  const preflight = renderEsquemaRequeridoDemoCuenta().replace(/;\s*$/, "");
  const valoresComprobacion = valoresMetricas(plan, true);
  const valoresVerificacion = valoresMetricas(plan, false);
  return `${cabecera(plan, owner)}
begin;

-- 0) PREFLIGHT de esquema: falla (y revierte) si falta alguna columna que el seed escribe, listando la migracion que la crea.
do $preflight$
declare falta text;
begin
  select string_agg(q.faltante || ' (migracion ' || q.migracion || ')', ', ') into falta from (
${preflight}
  ) q;
  if falta is not null then
    raise exception 'La base no tiene el esquema que el seed necesita. Aplique primero las migraciones de: %', falta;
  end if;
end
$preflight$;

-- 1..N) SEED IDEMPOTENTE (mismo SQL que la CLI con --apply; datos como JSON entre dollar-quotes).
${`do $seed_dc$\n${renderDemoCuentaPlpgsql(plan, { ownerEmail: owner })}\n$seed_dc$;`}

-- COMPROBACION dentro de la transaccion: si algun conteo queda por debajo de lo esperado, se revierte todo. (Mayor o igual: el dueno puede haber agregado cosas.)
do $comprobacion$
declare mal text;
begin
  select string_agg(m.metrica || ' (obtenido ' || m.obtenido || ', esperado ' || m.esperado || ')', ', ') into mal from (values
${valoresComprobacion}
  ) as m(metrica, obtenido, esperado) where m.obtenido < m.esperado;
  if mal is not null then
    raise exception 'La verificacion del seed fallo, se revierte todo: %', mal;
  end if;
end
$comprobacion$;

commit;

-- VERIFICACION (solo lectura): una fila por concepto; "ok" debe ser true en todas.
select m.metrica, m.obtenido, m.esperado, (m.obtenido >= m.esperado) as ok from (values
${valoresVerificacion}
) as m(metrica, obtenido, esperado);
`;
}
