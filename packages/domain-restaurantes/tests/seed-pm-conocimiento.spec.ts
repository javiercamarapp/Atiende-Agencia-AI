// B06: FAQ del piloto (faq-pm.md) como conocimiento publicado del negocio (migracion 053), el mismo mecanismo que usa el panel.
import { describe, expect, it } from "vitest";
import { buildPmSeedPlan, PmSeedError, renderPmSeedPlpgsql, renderSchemaPreflightSql, type PmSeedData } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
const plan = buildPmSeedPlan(data, agent);

describe("conocimiento publicado del seed de PM", () => {
  it("carga pedido incorrecto (misma sucursal), oficina matriz y redes; la lluvia NO (P-v2-20) ni nada con precio", () => {
    expect(plan.summary.conocimiento).toBe(3);
    expect(plan.conocimiento.map((c) => c.titulo)).toEqual(["Pedido incorrecto o con un problema", "Oficina matriz", "Redes sociales"]);
    const todo = JSON.stringify(plan.conocimiento);
    expect(todo).toMatch(/misma sucursal/);
    expect(todo).toMatch(/Calle 69 # 596 x 78 y 80/);
    expect(todo).toContain("facebook.com/lostaquitosdepm");
    expect(todo).toContain("instagram.com/taquitosdepm");
    expect(todo).not.toMatch(/lluvia|\$\s*\d|pesos/i);
  });

  it("el agente lo ve: quedan publicados, generales (toda la organizacion), importados y vigentes en el mundo en memoria", async () => {
    const world = await buildInMemoryPmWorld(plan);
    const entradas = await world.repo.listarConocimientoPublicado(world.organizationId, null);
    expect(entradas.map((e) => e.titulo).sort()).toEqual(["Oficina matriz", "Pedido incorrecto o con un problema", "Redes sociales"]);
    for (const e of entradas) expect(e).toMatchObject({ tipo: "faq", estado: "publicado", origen: "importado", activo: true, propertyId: null });
  });

  it("el SQL solo agrega lo que falta por titulo (no pisa lo que el dueño edito), exige la migracion 053 y no toca el documento [Auto] de colonias", () => {
    const sql = renderPmSeedPlpgsql(plan);
    expect(sql).toMatch(/insert into restaurantes\.conocimiento_negocio \(organization_id, property_id, titulo, texto, tipo, prioridad, estado, origen, activo\)/);
    expect(sql).toMatch(/where not exists \(select 1 from restaurantes\.conocimiento_negocio c where c\.organization_id = v_org and c\.property_id is null and c\.titulo = x\.titulo\)/);
    expect(sql).not.toMatch(/(update|delete from) restaurantes\.conocimiento_negocio/);
    // El documento JSON que recibe el bloque plpgsql trae las entradas (sin ellas el INSERT no cargaria nada).
    const inicio = sql.indexOf("$pm$") + 4;
    const doc = JSON.parse(sql.slice(inicio, sql.indexOf("$pm$", inicio))) as { conocimiento: Array<{ titulo: string; tipo: string; prioridad: number }> };
    expect(doc.conocimiento.map((c) => c.titulo)).toEqual(plan.conocimiento.map((c) => c.titulo));
    expect(renderSchemaPreflightSql()).toContain("053_conocimiento_negocio_y_control_agente.sql");
    expect(renderSchemaPreflightSql()).toContain("restaurantes.conocimiento_negocio.titulo");
  });

  it("rechaza conocimiento con precio, con el nombre de un producto, tipo invalido o titulo repetido (mismas reglas que el panel)", () => {
    const con = (c: Array<Record<string, unknown>>): PmSeedData => ({ ...data, conocimiento: c as unknown as PmSeedData["conocimiento"] });
    const base = { titulo: "Prueba", texto: "Texto de prueba", tipo: "faq" };
    expect(() => buildPmSeedPlan(con([{ ...base, texto: "El envio cuesta $50" }]), agent)).toThrow(PmSeedError);
    expect(() => buildPmSeedPlan(con([{ ...base, texto: "Pida los Nachos de Pastor" }]), agent)).toThrow(/producto/i);
    expect(() => buildPmSeedPlan(con([{ ...base, tipo: "otro" }]), agent)).toThrow(/tipo invalido/);
    expect(() => buildPmSeedPlan(con([base, base]), agent)).toThrow(/duplicado/);
  });
});
