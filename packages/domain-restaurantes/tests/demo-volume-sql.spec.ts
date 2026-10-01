// R-20 -- el SQL del seed de volumen: guardas (solo organizacion demo, solo telefonos ficticios), delimitador reservado, preflight de
// esquema y sincronia del assertions.sql del verify contra Postgres real (scripts/verify-restaurantes-demo-volumen/).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DemoVolumeSqlError, renderDemoVolumeDoBlock, renderDemoVolumePlpgsql, renderVolumePreflightSql } from "../src/seed/demo-volume-sql.ts";
import { DEMO_ORG_SLUG_POR_OMISION, SeedTargetError, parseCleanupArgs, parseVolumeArgs } from "../src/seed/target-safety.ts";
import type { DemoVolumeBatch } from "../src/seed/demo-volume.ts";
import { construirAssertions } from "../../../scripts/verify-restaurantes-demo-volumen/generar-assertions.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VACIO: DemoVolumeBatch = { customers: [], orders: [], conversations: [], handoffs: [], callbacks: [] };

describe("SQL del seed de volumen", () => {
  it("solo escribe en una organizacion MARCADA como demo y solo acepta telefonos del rango ficticio 0001", () => {
    const sql = renderDemoVolumePlpgsql("los-taquitos-de-pm-demo", VACIO);
    expect(sql).toContain("join restaurantes.demo_organization d on d.organization_id = o.id");
    expect(sql).toMatch(/raise exception 'demo-volumen: la organizacion[^']*NO esta marcada como demo/);
    expect(sql).toContain("^0001[0-9]{6}$");
    expect(sql).toMatch(/hay telefonos fuera del rango ficticio reservado/);
  });

  it("es idempotente por construccion: toda insercion deduplica (on conflict / not exists)", () => {
    const sql = renderDemoVolumePlpgsql("los-taquitos-de-pm-demo", VACIO);
    expect(sql).toMatch(/insert into restaurantes\.customers[\s\S]*?on conflict \(organization_id, phone\) do nothing/);
    expect(sql).toMatch(/insert into restaurantes\.orders[\s\S]*?on conflict \(organization_id, idempotency_key\) where idempotency_key is not null do nothing/);
    expect(sql).toMatch(/insert into restaurantes\.whatsapp_conversations[\s\S]*?on conflict \(organization_id, phone\) do nothing/);
    expect(sql).toMatch(/insert into restaurantes\.conversation_handoff[\s\S]*?where not exists/);
    expect(sql).toMatch(/insert into restaurantes\.callback_requests[\s\S]*?where not exists/);
  });

  it("rechaza slugs invalidos y datos con el delimitador reservado del bloque", () => {
    expect(() => renderDemoVolumePlpgsql("Slug'; drop table x;--", VACIO)).toThrow(DemoVolumeSqlError);
    const malo: DemoVolumeBatch = { ...VACIO, callbacks: [{ phone: "0001000001", name: "x $dv$ y", branchSlug: "a", reason: "r", message: "m", resolved: true, createdAt: "2026-09-01T00:00:00.000Z" }] };
    expect(() => renderDemoVolumePlpgsql("los-taquitos-de-pm-demo", malo)).toThrow(/delimitador/);
    expect(renderDemoVolumeDoBlock("los-taquitos-de-pm-demo", VACIO)).toMatch(/^do \$seed_volumen\$/);
  });

  it("el preflight pide las migraciones 028, 031, 033 y 036", () => {
    const sql = renderVolumePreflightSql();
    for (const m of ["028_conversaciones_handoff_turnos.sql", "031_recoger_promociones_automaticas_puentes.sql", "033_agente_config_historial_y_callbacks_estado.sql", "036_demo_organization.sql"]) expect(sql).toContain(m);
  });

  it("assertions.sql del verify esta sincronizado con los seeds (regenerar con ejecutar.mjs verify-demo-volumen)", async () => {
    const committed = readFileSync(path.join(HERE, "../../../scripts/verify-restaurantes-demo-volumen/assertions.sql"), "utf8");
    expect(committed).toBe(await construirAssertions());
  });
});

describe("argumentos de los scripts de operador", () => {
  it("seed-volumen: por omision dry-run, escala moderada y la organizacion demo; valida cada bandera", () => {
    expect(parseVolumeArgs([])).toEqual({ apply: false, confirmHost: null, help: false, orgSlug: DEMO_ORG_SLUG_POR_OMISION, escala: "moderado", dias: null, pedidosPorDia: null, semilla: null });
    expect(parseVolumeArgs(["--escala=completo", "--dias=30", "--pedidos-por-dia=50", "--semilla=7", "--apply", "--confirm-host=h"])).toMatchObject({ escala: "completo", dias: 30, pedidosPorDia: 50, semilla: 7, apply: true, confirmHost: "h" });
    expect(() => parseVolumeArgs(["--escala=gigante"])).toThrow(SeedTargetError);
    expect(() => parseVolumeArgs(["--dias=abc"])).toThrow(/entero/);
    expect(() => parseVolumeArgs(["--org-slug=Mal Slug"])).toThrow(/invalido/);
    expect(() => parseVolumeArgs(["--force"])).toThrow(/desconocido/);
  });

  it("limpiar-demo: exige --modo explicito (nunca adivina que borrar) y valida horas y slug", () => {
    expect(() => parseCleanupArgs([])).toThrow(/Falta --modo/);
    expect(parseCleanupArgs(["--modo=sesiones_widget", "--horas=24"])).toMatchObject({ modo: "sesiones_widget", horas: 24, apply: false, orgSlug: DEMO_ORG_SLUG_POR_OMISION });
    expect(parseCleanupArgs(["--help"]).help).toBe(true);
    expect(() => parseCleanupArgs(["--modo=todo", "--horas=-1"])).toThrow(/entero/);
    expect(() => parseCleanupArgs(["--modo=borrar"])).toThrow(SeedTargetError);
  });
});
