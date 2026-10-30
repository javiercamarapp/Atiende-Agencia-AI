// Rn-33 -- seed demo de rentas: plan e invariantes, datos invalidos, SQL, salvaguardas de la CLI (no escribe sin banderas, base no local
// exige confirmacion de produccion) y sincronia de assertions.sql. Postgres real: scripts/verify-rentas-seed/.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VARIABLES_PLANTILLA } from "../src/mensajes-automaticos/variables.ts";
import {
  buildRentasSeedPlan,
  renderRentasLimpiarDoBlock,
  renderRentasSchemaPreflightSql,
  renderRentasSeedDoBlock,
  renderRentasSeedPlpgsql,
  RentasSeedError,
  VARIABLES_PLANTILLA_SOPORTADAS,
} from "../src/seed/rentas-demo.ts";
import { ANCLA_FIXTURES_ICS, DATOS_RENTAS_DEMO, SLUG_DEMO_RENTAS } from "../src/seed/rentas-demo-data.ts";
import type { DatosRentasDemo } from "../src/seed/rentas-demo-data.ts";
import { construirAssertions } from "../../../scripts/verify-rentas-seed/generar-assertions.ts";
import { cargarFixturesIcs } from "../../../scripts/seed-rentas-demo/seed-rentas-demo.ts";
import { assertBanderasDeEscritura, assertObjetivoPermitido, describirObjetivo, parseSeedArgs, SeedTargetError } from "../../../scripts/seed-rentas-demo/args.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const fixtures = cargarFixturesIcs();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const datos = (): { -readonly [K in keyof DatosRentasDemo]: DatosRentasDemo[K] } => clone(DATOS_RENTAS_DEMO) as never;
const mal = (d: object) => () => buildRentasSeedPlan(fixtures, d as DatosRentasDemo);

describe("plan del seed", () => {
  const plan = buildRentasSeedPlan(fixtures);

  it("una gestora con 3 propiedades, 5 unidades, 3 propietarios, 3 feeds, 21 reservas y todo lo que pide Rn-33", () => {
    expect(plan.summary).toEqual({
      propiedades: 3,
      unidades: 5,
      propietarios: 3,
      feeds: 3,
      reservasImportadas: 8,
      reservasDirectas: 13,
      bloqueos: 1,
      conflictosAbiertos: 1,
      tareas: 5,
      incidencias: 1,
      plantillas: 5,
      plantillasAprobadas: 2,
      borradoresPendientes: 2,
      reglasComision: 4,
      movimientosFinancieros: 9,
    });
    expect(plan.organizacion.slug).toBe(SLUG_DEMO_RENTAS);
  });

  it("marca de cuenta demo sin SQL: slug demo-, nombres (demo), correos @example.test, contactos con lada 00 y URLs .invalid", () => {
    expect(plan.organizacion.slug.startsWith("demo-")).toBe(true);
    expect(plan.organizacion.nombre).toContain("(demo)");
    for (const p of plan.propiedades) expect(p.nombre).toContain("(demo)");
    for (const p of plan.propietarios) expect(p.email).toMatch(/@example\.test$/);
    for (const r of plan.reservas.filter((x) => x.origen === "directa")) expect(r.contacto).toMatch(/^\+52 00 /);
    for (const f of plan.feeds) expect(new URL(f.url).hostname.endsWith(".invalid")).toBe(true);
  });

  it("las reservas importadas salen de los .ics con el parser real: 8 UIDs, fechas relativas a la ancla y canal del feed", () => {
    const importadas = plan.reservas.filter((r) => r.origen === "ical");
    expect(importadas.map((r) => r.externalId).sort()).toEqual([
      "demo-abnb-0001@airbnb.example",
      "demo-abnb-0002@airbnb.example",
      "demo-abnb-0003@airbnb.example",
      "demo-abnb-0004@airbnb.example",
      "demo-bkg-0001@booking.example",
      "demo-bkg-0002@booking.example",
      "demo-vrbo-0001@vrbo.example",
      "demo-vrbo-0002@vrbo.example",
    ]);
    expect(ANCLA_FIXTURES_ICS).toBe("2026-01-05");
    const a3 = importadas.find((r) => r.externalId === "demo-abnb-0003@airbnb.example")!;
    expect(a3).toMatchObject({ canal: "airbnb", desde: 9, noches: 3, unidad: "Depto 1" });
    expect(importadas.find((r) => r.externalId === "demo-bkg-0001@booking.example")).toMatchObject({ canal: "booking", desde: 0, noches: 2 });
    expect(importadas.find((r) => r.externalId === "demo-abnb-0001@airbnb.example")!.dtstamp).toBe("2026-01-01T12:00:00Z");
  });

  it("hay llegada y salida HOY, reservas pasadas, de hoy y futuras, y ninguna se empalma en su unidad", () => {
    expect(plan.reservas.some((r) => r.desde === 0)).toBe(true);
    expect(plan.reservas.some((r) => r.desde + r.noches === 0)).toBe(true);
    expect(plan.reservas.some((r) => r.desde < 0 && r.desde + r.noches <= 0)).toBe(true);
    expect(plan.reservas.some((r) => r.desde > 0)).toBe(true);
    const porUnidad = new Map<string, typeof plan.reservas[number][]>();
    for (const r of plan.reservas) porUnidad.set(`${r.propiedad}|${r.unidad}`, [...(porUnidad.get(`${r.propiedad}|${r.unidad}`) ?? []), r]);
    for (const lista of porUnidad.values()) {
      const o = [...lista].sort((a, b) => a.desde - b.desde);
      for (let i = 1; i < o.length; i++) expect(o[i]!.desde).toBeGreaterThanOrEqual(o[i - 1]!.desde + o[i - 1]!.noches);
    }
  });

  it("el conflicto abierto cruza una reserva importada con el bloqueo de mantenimiento", () => {
    const r = plan.reservas.find((x) => x.externalId === plan.conflicto.reservaExternalId)!;
    const b = plan.bloqueos.find((x) => x.externalId === plan.conflicto.bloqueoExternalId)!;
    expect(r.origen).toBe("ical");
    expect(b.razon).toBe("MANTENIMIENTO");
    expect(r.desde < b.desde + b.noches && b.desde < r.desde + r.noches).toBe(true);
  });

  it("solo las reservas ya terminadas traen movimiento y el motor real lo calcula: neto = recibido - comision del gestor - gastos", () => {
    const con = plan.reservas.filter((r) => r.financiero !== null);
    expect(con).toHaveLength(9);
    for (const r of con) {
      expect(r.desde + r.noches).toBeLessThanOrEqual(0);
      const f = r.financiero!;
      expect(f.netoCentavos).toBe(f.montoRecibidoCentavos - f.comisionGestorCentavos - f.gastosCentavos);
      expect(f.comisionCanalFuente).toMatch(/^Demo:/);
    }
    // Airbnb (ya neto) no vuelve a restar la comision de canal; Vrbo (800 bps) si.
    const airbnb = con.find((r) => r.canal === "airbnb")!.financiero!;
    expect(airbnb.comisionCanalCentavos).toBe(0);
    expect(airbnb.montoRecibidoCentavos).toBe(airbnb.brutoCentavos);
    const vrbo = con.find((r) => r.canal === "vrbo")!.financiero!;
    expect(vrbo.comisionCanalCentavos).toBe(Math.round(vrbo.brutoCentavos * 0.08));
  });

  it("las variables de plantilla soportadas del seed son EXACTAMENTE las del dominio (el seed no puede importar el dominio completo)", () => {
    expect([...VARIABLES_PLANTILLA_SOPORTADAS].sort()).toEqual(VARIABLES_PLANTILLA.map((v) => v.nombre).sort());
  });
});

describe("datos invalidos: el plan falla ANTES de escribir nada", () => {
  it("correo de propietario que no es @example.test", () => {
    const d = datos();
    d.propietarios = [{ ...d.propietarios[0]!, email: "real@gmail.com" }, ...d.propietarios.slice(1)];
    expect(mal(d)).toThrow(/@example\.test/);
  });

  it("reserva directa que se empalma con una importada", () => {
    const d = datos();
    d.reservasDirectas = [...d.reservasDirectas, { clave: "x", propiedad: "Casa del Mar (demo)", unidad: "Depto 1", desde: 10, noches: 2, huesped: "Xavier Demo", conFinanciero: false }];
    expect(mal(d)).toThrow(/se empalma/);
  });

  it("reserva por debajo de la estancia minima de la unidad", () => {
    const d = datos();
    d.reservasDirectas = [...d.reservasDirectas, { clave: "x", propiedad: "Villa Los Pinos (demo)", unidad: "Villa", desde: 40, noches: 1, huesped: "Xavier Demo", conFinanciero: false }];
    expect(mal(d)).toThrow(/estancia minima/);
  });

  it("movimiento financiero en una reserva que aun no termina", () => {
    const d = datos();
    d.reservasDirectas = d.reservasDirectas.map((r) => (r.clave === "d2" ? { ...r, conFinanciero: true } : r));
    expect(mal(d)).toThrow(/ya terminada/);
  });

  it("falta el .ics de un feed", () => {
    expect(() => buildRentasSeedPlan({}, DATOS_RENTAS_DEMO)).toThrow(/falta el fixture/);
  });

  it("un .ics con un evento cancelado o con hora no es una reserva demo", () => {
    const cancelado = { ...fixtures, "vrbo-loft-centro-loft-a.ics": fixtures["vrbo-loft-centro-loft-a.ics"]!.replace("STATUS:CONFIRMED", "STATUS:CANCELLED") };
    expect(() => buildRentasSeedPlan(cancelado)).toThrow(/cancelado/);
    const conHora = { ...fixtures, "vrbo-loft-centro-loft-a.ics": fixtures["vrbo-loft-centro-loft-a.ics"]!.replace("DTSTART;VALUE=DATE:20251231", "DTSTART:20251231T150000Z") };
    expect(() => buildRentasSeedPlan(conHora)).toThrow(/dia completo/);
  });

  it("conflicto abierto que no se cruza, plantilla con variable desconocida, propietario o unidad inexistente", () => {
    const sinCruce = datos();
    sinCruce.bloqueos = sinCruce.bloqueos.map((b) => ({ ...b, desde: 30 }));
    expect(mal(sinCruce)).toThrow(/no se cruzan/);
    const plantilla = datos();
    plantilla.plantillas = [{ evento: "check_in", cuerpo: "Hola {{codigo_de_la_puerta}}", aprobada: true }];
    expect(mal(plantilla)).toThrow(/variables no soportadas/);
    const dueno = datos();
    dueno.propiedades = [{ ...dueno.propiedades[0]!, unidades: [{ ...dueno.propiedades[0]!.unidades[0]!, propietario: "nadie" }] }, ...dueno.propiedades.slice(1)];
    expect(mal(dueno)).toThrow(/propietario inexistente/);
    const unidad = datos();
    unidad.tareas = [{ ...unidad.tareas[0]!, unidad: "Fantasma" }, ...unidad.tareas.slice(1)];
    expect(mal(unidad)).toThrow(/unidad inexistente/);
  });

  it("falta la regla de comision de un canal", () => {
    const d = datos();
    d.reglasComision = d.reglasComision.filter((r) => r.canal !== "vrbo");
    expect(mal(d)).toThrow(RentasSeedError);
  });
});

describe("SQL del seed", () => {
  const plan = buildRentasSeedPlan(fixtures);

  it("el bloque exige un correo de dueño valido y nunca inyecta texto del usuario", () => {
    expect(() => renderRentasSeedPlpgsql(plan, { ownerEmail: "no es correo" })).toThrow(/ownerEmail/);
    expect(() => renderRentasSeedPlpgsql(plan, { ownerEmail: "x'; drop table core.staff_user; --@a.co" })).toThrow(/ownerEmail/);
    const sql = renderRentasSeedDoBlock(plan, { ownerEmail: "Duena@Example.test" });
    expect(sql).toContain("lower(email) = 'duena@example.test'");
    expect(sql.startsWith("do $seed_rentas$")).toBe(true);
  });

  it("no crea credenciales ni toca otra vertical: aborta si el dueño no existe o el slug es de otra vertical", () => {
    const sql = renderRentasSeedPlpgsql(plan, { ownerEmail: "duena@example.test" });
    expect(sql).toContain("no existe un usuario de staff");
    expect(sql).toContain("ya existe y no es de rentas");
    expect(sql).not.toMatch(/insert into core\.staff_user/i);
    expect(sql).not.toMatch(/password/i);
  });

  it("el preflight lista tablas y columnas que el seed necesita, y la limpieza solo borra la organizacion demo", () => {
    expect(renderRentasSchemaPreflightSql()).toContain("rentas.sembrar_reglas_comision_base");
    const limpiar = renderRentasLimpiarDoBlock();
    expect(limpiar).toContain(`slug = '${SLUG_DEMO_RENTAS}' and vertical = 'rentas'`);
    expect(limpiar).toContain("o2.organization_id <> v_org");
  });

  it("assertions.sql de scripts/verify-rentas-seed esta sincronizado con el seed y los .ics (regenerar con generar-assertions.ts)", () => {
    expect(readFileSync(path.join(REPO, "scripts/verify-rentas-seed/assertions.sql"), "utf8")).toBe(construirAssertions());
  });
});

function correr(script: string, args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  try {
    // Ruta absoluta del propio Node y entorno MINIMO: la CLI no hereda ninguna variable (ni DATABASE_URL) del proceso de prueba.
    const out = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", path.join(REPO, "scripts/seed-rentas-demo", script), ...args], {
      env: { ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

describe("salvaguardas de la CLI", () => {
  it("sin banderas es un dry-run: imprime el plan y no abre ninguna conexion", () => {
    const r = correr("seed-rentas-demo.ts", []);
    expect(r.code).toBe(0);
    expect(r.out).toContain("DRY-RUN: no se toco ninguna base");
    expect(r.out).toContain("3 propiedades, 5 unidades, 3 propietarios");
    expect(correr("seed-rentas-demo.ts", ["--dry-run"]).code).toBe(0);
  });

  it("--confirmar sin --owner-email aborta (el seed no crea credenciales); sin SEED_DATABASE_URL tambien", () => {
    const sinDueno = correr("seed-rentas-demo.ts", ["--confirmar"], { SEED_DATABASE_URL: "postgresql://postgres@127.0.0.1:5432/x" });
    expect(sinDueno.code).toBe(2);
    expect(sinDueno.out).toContain("--owner-email");
    const sinUrl = correr("seed-rentas-demo.ts", ["--confirmar", "--owner-email=a@example.test"]);
    expect(sinUrl.code).toBe(2);
    expect(sinUrl.out).toContain("SEED_DATABASE_URL");
    // DATABASE_URL jamas se lee.
    const soloDatabaseUrl = correr("seed-rentas-demo.ts", ["--confirmar", "--owner-email=a@example.test"], { DATABASE_URL: "postgresql://postgres@127.0.0.1:5432/x" });
    expect(soloDatabaseUrl.code).toBe(2);
  });

  it("una base que parece produccion aborta sin --confirmar-produccion y sin el host exacto, ANTES de conectar", () => {
    const url = { SEED_DATABASE_URL: "postgresql://postgres@db.proyecto.supabase.co:5432/postgres" };
    const a = correr("seed-rentas-demo.ts", ["--confirmar", "--owner-email=a@example.test"], url);
    expect(a.code).toBe(2);
    expect(a.out).toContain("parece produccion");
    const b = correr("seed-rentas-demo.ts", ["--confirmar", "--owner-email=a@example.test", "--confirmar-produccion"], url);
    expect(b.code).toBe(2);
    expect(b.out).toContain("--confirm-host");
    const c = correr("seed-rentas-demo.ts", ["--confirmar", "--owner-email=a@example.test", "--confirmar-produccion", "--confirm-host=otro.host"], url);
    expect(c.code).toBe(2);
    expect(c.out).toContain("no coincide");
  });

  it("la limpieza tambien es dry-run por omision y aplica las mismas salvaguardas", () => {
    expect(correr("limpiar-demo.ts", []).out).toContain("DRY-RUN");
    const r = correr("limpiar-demo.ts", ["--confirmar"], { SEED_DATABASE_URL: "postgresql://postgres@db.proyecto.supabase.co:5432/postgres" });
    expect(r.code).toBe(2);
    expect(r.out).toContain("parece produccion");
  });

  it("parseo de argumentos: desconocidos, correo invalido y --dry-run con --confirmar son errores", () => {
    expect(() => parseSeedArgs(["--apply"])).toThrow(SeedTargetError);
    expect(() => parseSeedArgs(["--owner-email=no-es-correo"])).toThrow(/correo/);
    expect(() => parseSeedArgs(["--dry-run", "--confirmar"])).toThrow(/excluyentes/);
    expect(() => assertBanderasDeEscritura(parseSeedArgs(["--owner-email=a@example.test"]))).toThrow(/--confirmar/);
    expect(() => assertBanderasDeEscritura(parseSeedArgs(["--confirmar"]))).toThrow(/--owner-email/);
    expect(() => assertBanderasDeEscritura(parseSeedArgs(["--confirmar", "--owner-email=a@example.test"]))).not.toThrow();
  });

  it("una base local no exige confirmacion de produccion; una remota si", () => {
    expect(() => assertObjetivoPermitido(describirObjetivo("postgresql://postgres@127.0.0.1:5432/x"), { confirmHost: null, confirmarProduccion: false })).not.toThrow();
    expect(() => assertObjetivoPermitido(describirObjetivo("postgresql://postgres@db.x.supabase.co:5432/x"), { confirmHost: "db.x.supabase.co", confirmarProduccion: false })).toThrow(/produccion/);
    expect(() => assertObjetivoPermitido(describirObjetivo("postgresql://postgres@db.x.supabase.co:5432/x"), { confirmHost: "db.x.supabase.co", confirmarProduccion: true })).not.toThrow();
  });
});
