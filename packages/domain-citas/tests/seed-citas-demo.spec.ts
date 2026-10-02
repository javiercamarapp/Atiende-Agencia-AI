// C-27 -- seed demo de citas: plan e invariantes, datos invalidos, SQL, salvaguardas de la CLI (rechaza correr sin banderas),
// limpieza que no toca organizaciones no demo y sincronia de assertions.sql. Postgres real: scripts/verify-citas-demo/.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  buildCitasSeedPlan,
  CITA_ESTADOS,
  CitasSeedError,
  ESPERA_ESTADOS,
  planDeNegocio,
  renderCitasSchemaPreflightSql,
  renderCitasSeedDoBlock,
  renderCitasSeedPlpgsql,
  telefonoFicticio,
} from "../src/seed/citas-demo.ts";
import { NEGOCIOS_DEMO } from "../src/seed/citas-demo-data.ts";
import type { DatosNegocio } from "../src/seed/citas-demo-data.ts";
import { construirAssertions } from "../../../scripts/verify-citas-demo/generar-assertions.ts";
import { assertBanderasDeEscritura, parseLimpiarArgs, parseSeedArgs, SeedTargetError } from "../../../scripts/seed-citas-demo/args.ts";
import { ejecutarLimpieza } from "../../../scripts/seed-citas-demo/limpiar-demo.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const dental = (): DatosNegocio => clone(NEGOCIOS_DEMO[0]!);

describe("plan del seed", () => {
  const plan = buildCitasSeedPlan();

  it("2 negocios demo (clinica dental y barberia) con catalogo, profesionales, excepciones, clientes, citas y lista de espera", () => {
    expect(plan.summary).toMatchObject({ negocios: 2, servicios: 8, proveedores: 6, clientes: 20, citas: 49, espera: 10 });
    expect(plan.negocios.map((n) => [n.slug, n.rubro])).toEqual([["clinica-dental-sonrisa-demo", "dental"], ["barberia-el-filo-demo", "barberia"]]);
    for (const n of plan.negocios) {
      expect(n.excepciones.length).toBeGreaterThanOrEqual(2);
      expect(n.proveedores.every((p) => p.reglas.length > 0)).toBe(true);
    }
  });

  it("cada negocio tiene citas en los 5 estados (incluido no_show) y lista de espera en los 5 estados", () => {
    for (const n of plan.negocios) {
      expect(new Set(n.citas.map((c) => c.estado))).toEqual(new Set(CITA_ESTADOS));
      expect(new Set(n.espera.map((w) => w.estado))).toEqual(new Set(ESPERA_ESTADOS));
    }
    expect(plan.summary.citasPorEstado.no_show).toBeGreaterThan(0);
  });

  it("todo es ficticio: correos @example.test, telefonos de lada reservada 5200 y unicos por negocio", () => {
    for (const n of plan.negocios) {
      expect(n.clientes.every((c) => /^[^@]+@example\.test$/.test(c.email))).toBe(true);
      const tels = [...n.clientes.map((c) => c.telefono), ...n.espera.map((w) => w.telefono)];
      expect(tels.every((t) => /^5200\d{6}$/.test(t))).toBe(true);
      expect(new Set(tels).size).toBe(tels.length);
    }
    expect(telefonoFicticio(1, 0)).toBe("5200101000");
  });

  it("pasado y futuro: las citas pasadas son completed/no_show/cancelled y las futuras confirmed/pending/cancelled; la semana en curso queda libre", () => {
    for (const n of plan.negocios) {
      for (const c of n.citas) {
        expect(c.semana).not.toBe(0);
        if (c.semana < 0) expect(["completed", "no_show", "cancelled"]).toContain(c.estado);
        else expect(["confirmed", "pending", "cancelled"]).toContain(c.estado);
      }
    }
  });

  it("las llaves de idempotencia son sha256 deterministas y unicas", () => {
    const llaves = plan.negocios.flatMap((n) => n.citas.map((c) => c.idempotencyKey));
    expect(llaves.every((k) => /^[0-9a-f]{64}$/.test(k))).toBe(true);
    expect(new Set(llaves).size).toBe(llaves.length);
    expect(buildCitasSeedPlan().negocios[0]!.citas[0]!.idempotencyKey).toBe(llaves[0]);
  });
});

describe("validacion de datos (nunca se escribe a medias)", () => {
  const rechaza = (mutar: (d: DatosNegocio) => void, mensaje: RegExp) => {
    const d = dental();
    mutar(d);
    expect(() => planDeNegocio(d, 0)).toThrow(CitasSeedError);
    expect(() => planDeNegocio(d, 0)).toThrow(mensaje);
  };
  interface Editable { clientes: { nombre: string; email: string }[]; citas: Record<string, unknown>[] }
  const editable = (d: DatosNegocio) => d as unknown as Editable;

  it("un correo que no es @example.test, un slug sin -demo y una cita fuera de horario se rechazan", () => {
    rechaza((d) => { editable(d).clientes[0]!.email = "real@gmail.com"; }, /@example\.test/);
    rechaza((d) => { (d as { slug: string }).slug = "clinica-dental-sonrisa"; }, /-demo/);
    rechaza((d) => { editable(d).citas[0]!.hora = "23:00"; }, /fuera del horario/);
  });

  it("empalmes de agenda, estados imposibles, la semana en curso y proveedores o servicios inexistentes se rechazan", () => {
    rechaza((d) => { editable(d).citas[1]!.dow = 1; editable(d).citas[1]!.hora = "09:15"; editable(d).citas[1]!.semana = -3; editable(d).citas[1]!.estado = "completed"; }, /se empalma/);
    rechaza((d) => { editable(d).citas[0]!.estado = "confirmed"; }, /cita pasada/);
    rechaza((d) => { editable(d).citas[15]!.estado = "completed"; }, /cita futura/);
    rechaza((d) => { editable(d).citas[0]!.semana = 0; }, /semana en curso/);
    rechaza((d) => { editable(d).citas[0]!.proveedor = "Dr. Inexistente"; }, /proveedor inexistente/);
    rechaza((d) => { editable(d).citas[0]!.servicio = "Cirugia inventada"; }, /servicio inexistente|no ofrece/);
  });

  it("una cita activa en un dia cerrado del profesional se rechaza, y faltar un estado de cita o de lista de espera tambien", () => {
    rechaza((d) => { Object.assign(editable(d).citas[15]!, { proveedor: "Dra. Ana Lozano", servicio: "Limpieza dental", semana: 1, dow: 3, hora: "09:00", estado: "confirmed" }); }, /dia cerrado/);
    rechaza((d) => { editable(d).citas = editable(d).citas.filter((c) => c.estado !== "no_show"); }, /no_show/);
    rechaza((d) => { (d as { espera: unknown }).espera = d.espera.filter((w) => w.estado !== "expired"); }, /expired/);
  });

  it("dos negocios con el mismo slug se rechazan", () => {
    expect(() => buildCitasSeedPlan([dental(), dental()])).toThrow(/slug repetido/);
  });
});

describe("SQL del seed", () => {
  const plan = buildCitasSeedPlan();
  const sql = renderCitasSeedDoBlock(plan, { ownerEmail: "Dueno@Ejemplo.com" });

  it("es un bloque anonimo idempotente: cuentas solo demo, owner existente, llave de idempotencia y hora local por zona horaria", () => {
    expect(sql.startsWith("do $seed_citas$")).toBe(true);
    expect(sql).toContain("lower(email) = 'dueno@ejemplo.com'");
    expect(sql).toContain("on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing");
    expect(sql).toContain("at time zone v_tz");
    expect(sql).toContain("no es una cuenta demo de citas; no se toca");
    expect(sql).toContain("no existe un usuario de staff");
    expect(sql).not.toMatch(/using\s*\(\s*true\s*\)/i);
    expect(sql).not.toMatch(/insert into core\.staff_user/i);
  });

  it("valida el correo del owner y la fecha base antes de generar SQL (sin inyeccion)", () => {
    expect(() => renderCitasSeedPlpgsql(plan, { ownerEmail: "x'; drop table core.organization; --@a.com" })).toThrow(/ownerEmail/);
    expect(() => renderCitasSeedPlpgsql(plan, { ownerEmail: "a@b.com", fechaBase: "2026-03-04'; --" })).toThrow(/fechaBase/);
    expect(renderCitasSeedPlpgsql(plan, { ownerEmail: "a@b.com", fechaBase: "2026-03-04" })).toContain("'2026-03-04'::date");
  });

  it("el preflight pide la migracion 030 y las tablas base", () => {
    const pre = renderCitasSchemaPreflightSql();
    expect(pre).toContain("citas.demo_organization");
    expect(pre).toContain("citas.demo_limpiar(uuid)");
    expect(pre).toContain("030_citas_demo_organization");
  });

  it("la migracion 030 y su espejo en supabase/migrations son byte-identicos", () => {
    const a = readFileSync(path.join(REPO, "packages/domain-citas/migrations/030_citas_demo_organization.sql"));
    const b = readFileSync(path.join(REPO, "supabase/migrations/20240101000279_030_citas_demo_organization.sql"));
    expect(a.equals(b)).toBe(true);
  });
});

describe("salvaguardas de los argumentos", () => {
  it("el seed rechaza argumentos desconocidos, correos o fechas invalidas, y escribir sin --confirmar o sin --owner-email", () => {
    expect(() => parseSeedArgs(["--apply"])).toThrow(SeedTargetError);
    expect(() => parseSeedArgs(["--owner-email=no-es-correo"])).toThrow(/correo/);
    expect(() => parseSeedArgs(["--fecha-base=ayer"])).toThrow(/YYYY-MM-DD/);
    expect(() => assertBanderasDeEscritura(parseSeedArgs([]))).toThrow(/Sin --confirmar/);
    expect(() => assertBanderasDeEscritura(parseSeedArgs(["--confirmar"]))).toThrow(/--owner-email/);
    expect(() => assertBanderasDeEscritura(parseSeedArgs(["--owner-email=a@b.com"]))).toThrow(/Sin --confirmar/);
    expect(() => assertBanderasDeEscritura(parseSeedArgs(["--confirmar", "--owner-email=a@b.com"]))).not.toThrow();
  });

  it("la limpieza exige indicar que organizaciones (o --todas) y rechaza slugs invalidos", () => {
    expect(() => parseLimpiarArgs([])).toThrow(/--org-slug/);
    expect(() => parseLimpiarArgs(["--org-slug=Mala Org"])).toThrow(/invalido/);
    expect(parseLimpiarArgs(["--todas"]).slugs).toEqual(["clinica-dental-sonrisa-demo", "barberia-el-filo-demo"]);
    expect(parseLimpiarArgs(["--org-slug=x-demo"]).confirmar).toBe(false);
  });
});

function correr(script: string, args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync("node", ["--experimental-strip-types", "--no-warnings", path.join(REPO, "scripts/seed-citas-demo", script), ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

describe("CLI del seed (sin base: todo se rechaza antes de conectar)", () => {
  it("sin banderas es dry-run: imprime el plan, no abre conexion y sale con 0 aunque haya SEED_DATABASE_URL", () => {
    const r = correr("seed-citas-demo.ts", [], { SEED_DATABASE_URL: "postgresql://postgres@127.0.0.1:1/no_existe" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("DRY-RUN");
    expect(r.out).toContain("25 citas");
  });

  it("--owner-email solo (sin --confirmar) sigue siendo dry-run", () => {
    const r = correr("seed-citas-demo.ts", ["--owner-email=a@b.com"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("DRY-RUN");
  });

  it("--confirmar sin --owner-email se rechaza (codigo 2)", () => {
    const r = correr("seed-citas-demo.ts", ["--confirmar"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--owner-email");
  });

  it("--confirmar --owner-email sin SEED_DATABASE_URL se rechaza, y DATABASE_URL a proposito se ignora", () => {
    const r = correr("seed-citas-demo.ts", ["--confirmar", "--owner-email=a@b.com"], { DATABASE_URL: "postgresql://postgres@127.0.0.1:1/x" });
    expect(r.code).toBe(2);
    expect(r.out).toContain("SEED_DATABASE_URL");
  });

  it("contra una base remota exige --confirm-host (y que coincida) antes de conectar", () => {
    const base = ["--confirmar", "--owner-email=a@b.com"];
    const url = { SEED_DATABASE_URL: "postgresql://postgres@db.ejemplo.supabase.co:5432/postgres" };
    const sin = correr("seed-citas-demo.ts", base, url);
    expect(sin.code).toBe(2);
    expect(sin.out).toContain("NO es local");
    const otro = correr("seed-citas-demo.ts", [...base, "--confirm-host=otro.host"], url);
    expect(otro.code).toBe(2);
    expect(otro.out).toContain("no coincide");
  });

  it("argumentos desconocidos se rechazan", () => {
    expect(correr("seed-citas-demo.ts", ["--apply"]).code).toBe(2);
  });

  it("la limpieza sin organizaciones indicadas, sin URL o sin --confirm-host remoto se rechaza antes de conectar", () => {
    expect(correr("limpiar-demo.ts", []).code).toBe(2);
    expect(correr("limpiar-demo.ts", ["--todas"]).out).toContain("SEED_DATABASE_URL");
    const r = correr("limpiar-demo.ts", ["--todas", "--confirmar"], { SEED_DATABASE_URL: "postgresql://postgres@db.ejemplo.supabase.co:5432/postgres" });
    expect(r.code).toBe(2);
    expect(r.out).toContain("NO es local");
  });
});

describe("limpieza: solo organizaciones marcadas como demo", () => {
  function clienteFalso(orgs: Record<string, { id: string; demo: boolean }>) {
    const sqls: { sql: string; params: unknown[] }[] = [];
    return {
      sqls,
      async query(sql: string, params: unknown[] = []) {
        sqls.push({ sql, params });
        if (sql.includes("from core.organization o")) {
          const o = orgs[String(params[0])];
          return { rows: o ? [o] : [] };
        }
        if (sql.includes("citas.demo_limpiar")) return { rows: [{ demo_limpiar: { organizacion_borrada: true } }] };
        return { rows: [{ citas: 3, clientes: 2, espera: 1 }] };
      },
    };
  }
  const silencio = { log: vi.fn(), error: vi.fn() };

  it("una organizacion sin marca demo NO se limpia: no se llama a demo_limpiar y el codigo de salida es 4", async () => {
    const c = clienteFalso({ "clinica-real": { id: "id-real", demo: false } });
    const code = await ejecutarLimpieza(c, { slugs: ["clinica-real"], confirmar: true }, silencio);
    expect(code).toBe(4);
    expect(c.sqls.some((s) => s.sql.includes("citas.demo_limpiar"))).toBe(false);
    expect(c.sqls.some((s) => /\bdelete\b/i.test(s.sql))).toBe(false);
  });

  it("una organizacion demo se limpia solo con --confirmar; en dry-run solo cuenta", async () => {
    const orgs = { "barberia-el-filo-demo": { id: "id-demo", demo: true } };
    const dry = clienteFalso(orgs);
    expect(await ejecutarLimpieza(dry, { slugs: ["barberia-el-filo-demo"], confirmar: false }, silencio)).toBe(0);
    expect(dry.sqls.some((s) => s.sql.includes("citas.demo_limpiar"))).toBe(false);
    const real = clienteFalso(orgs);
    expect(await ejecutarLimpieza(real, { slugs: ["barberia-el-filo-demo"], confirmar: true }, silencio)).toBe(0);
    const llamada = real.sqls.find((s) => s.sql.includes("citas.demo_limpiar"))!;
    expect(llamada.params).toEqual(["id-demo"]);
  });

  it("mezcla de una demo y una real: limpia la demo, se niega a la real y reporta 4", async () => {
    const c = clienteFalso({ "barberia-el-filo-demo": { id: "id-demo", demo: true }, "clinica-real": { id: "id-real", demo: false } });
    const code = await ejecutarLimpieza(c, { slugs: ["clinica-real", "barberia-el-filo-demo", "no-existe"], confirmar: true }, silencio);
    expect(code).toBe(4);
    const llamadas = c.sqls.filter((s) => s.sql.includes("citas.demo_limpiar"));
    expect(llamadas.map((l) => l.params[0])).toEqual(["id-demo"]);
  });
});

describe("assertions.sql del verificador", () => {
  it("el archivo commiteado coincide con lo que genera el seed (si el seed cambia, hay que regenerarlo)", () => {
    const commiteado = readFileSync(path.join(REPO, "scripts/verify-citas-demo/assertions.sql"), "utf8");
    expect(commiteado).toBe(construirAssertions());
  });
});
