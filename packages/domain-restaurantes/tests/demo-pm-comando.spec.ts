// DEMO-PM -- el comando unico `npm run demo:pm` (scripts/seed-pm-demo/demo-pm.mjs): plan de pasos, salvaguardas y orden. La carga real
// contra Postgres (dos corridas idempotentes + verificacion) se ejecuto contra una base local efimera; el SQL que carga vive en
// scripts/verify-restaurantes-demo-volumen (escenarios V18/V19).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Paso {
  readonly id: string;
  readonly argv: string[];
  readonly conexion: boolean;
}
interface Modulo {
  parseDemoPmArgs(argv: string[]): { apply: boolean; confirmHost: string | null; ownerEmail: string | null; dias: number | null; conservarSesiones: boolean; verificar: boolean; apiUrl: string | null; help: boolean };
  planDemoPm(args: ReturnType<Modulo["parseDemoPmArgs"]>): Paso[];
  main(argv: string[]): number;
}
const cargar = async (): Promise<Modulo> => (await import(new URL("../../../scripts/seed-pm-demo/demo-pm.mjs", import.meta.url).href)) as Modulo;
const ids = (p: Paso[]) => p.map((x) => x.id);

describe("demo-pm (comando unico)", () => {
  it("por omision es DRY-RUN: ningun paso lleva --apply y el orden es seed -> limpiar volumen -> volumen t7 -> limpiar sesiones -> verificar", async () => {
    const m = await cargar();
    const plan = m.planDemoPm(m.parseDemoPmArgs([]));
    expect(ids(plan)).toEqual(["seed", "limpiar-volumen", "volumen", "limpiar-sesiones", "verificar"]);
    // Solo el seed del negocio y el volumen generan en memoria sin conexion; los de base llevan `conexion` y no corren en dry-run.
    expect(plan.filter((p) => p.conexion).map((p) => p.id)).toEqual(["limpiar-volumen", "limpiar-sesiones", "verificar"]);
    const sinConexion = plan.filter((p) => !p.conexion);
    for (const p of sinConexion) expect(p.argv).not.toContain("--apply");
    expect(plan[0]!.argv).toContain("--demo");
    expect(plan[2]!.argv).toContain("--perfil=t7");
  });

  it("con --apply propaga --apply y --confirm-host a TODOS los pasos que escriben (y --owner-email solo al seed)", async () => {
    const m = await cargar();
    const plan = m.planDemoPm(m.parseDemoPmArgs(["--apply", "--confirm-host=db.ejemplo.co", "--owner-email=due@ejemplo.com", "--dias=28"]));
    for (const id of ["seed", "limpiar-volumen", "volumen", "limpiar-sesiones"]) {
      const p = plan.find((x) => x.id === id)!;
      expect(p.argv, id).toContain("--apply");
      expect(p.argv, id).toContain("--confirm-host=db.ejemplo.co");
    }
    expect(plan.find((p) => p.id === "seed")!.argv).toContain("--owner-email=due@ejemplo.com");
    expect(plan.filter((p) => p.argv.includes("--owner-email=due@ejemplo.com"))).toHaveLength(1);
    expect(plan.find((p) => p.id === "volumen")!.argv).toContain("--dias=28");
    // La verificacion es de solo lectura: nunca recibe --apply.
    expect(plan.find((p) => p.id === "verificar")!.argv).not.toContain("--apply");
  });

  it("la limpieza del volumen va ANTES de regenerarlo (re-ejecutar otro dia no duplica ni desfasa) y solo toca modos de demo", async () => {
    const m = await cargar();
    const plan = m.planDemoPm(m.parseDemoPmArgs(["--apply"]));
    expect(ids(plan).indexOf("limpiar-volumen")).toBeLessThan(ids(plan).indexOf("volumen"));
    expect(plan.find((p) => p.id === "limpiar-volumen")!.argv).toContain("--modo=volumen");
    expect(plan.find((p) => p.id === "limpiar-sesiones")!.argv).toContain("--modo=sesiones_widget");
    for (const p of plan) expect(p.argv.join(" ")).not.toContain("--modo=todo");
  });

  it("--conservar-sesiones omite el borrado de ensayos del widget; --verificar es solo lectura y sin pasos de carga", async () => {
    const m = await cargar();
    expect(ids(m.planDemoPm(m.parseDemoPmArgs(["--conservar-sesiones"])))).not.toContain("limpiar-sesiones");
    const v = m.planDemoPm(m.parseDemoPmArgs(["--verificar", "--api-url=https://api.ejemplo.com"]));
    expect(ids(v)).toEqual(["verificar"]);
    expect(v[0]!.argv).toContain("--api-url=https://api.ejemplo.com");
  });

  it("rechaza combinaciones peligrosas o desconocidas", async () => {
    const m = await cargar();
    expect(() => m.parseDemoPmArgs(["--verificar", "--apply"])).toThrow(/solo lectura/);
    expect(() => m.parseDemoPmArgs(["--api-url=https://x"])).toThrow(/--verificar/);
    expect(() => m.parseDemoPmArgs(["--dias=0"])).toThrow(/entero/);
    expect(() => m.parseDemoPmArgs(["--modo=todo"])).toThrow(/desconocido/);
    expect(m.main(["--modo=todo"])).toBe(2);
  });

  it("el script npm existe y apunta al comando", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["demo:pm"]).toBe("node scripts/seed-pm-demo/demo-pm.mjs");
    expect(pkg.scripts["demo:verificar"]).toContain("verificar-demo.ts");
  });
});
