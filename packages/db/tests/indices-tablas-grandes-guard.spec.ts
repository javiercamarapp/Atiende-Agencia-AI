import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TABLAS_GRANDES, revisarIndicesTablasGrandes } from "../../../scripts/verify-indices-tablas-grandes/check-indices-tablas-grandes.ts";

// Ola 4 (G2): un `create index` normal sobre una tabla grande toma un lock SHARE que
// bloquea INSERT/UPDATE durante todo el build (el outbox deja de encolar, el agente
// deja de guardar mensajes). Desde la versión 20240101000900 toda migración que cree
// un índice sobre una tabla grande debe (a) fijar lock_timeout y (b) tener su gemelo
// `create index concurrently` en scripts/indices-concurrentes/, que se corre ANTES
// (fuera de transacción) para que la migración sea un no-op.

const temps: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(d);
  return d;
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop() as string, { recursive: true, force: true });
});

function arbol(migracion: string, concurrente?: string): { migrationsDir: string; concurrentesDir: string } {
  const root = tmp("idx-grandes-");
  const migrationsDir = path.join(root, "supabase", "migrations");
  const concurrentesDir = path.join(root, "scripts", "indices-concurrentes");
  mkdirSync(migrationsDir, { recursive: true });
  mkdirSync(concurrentesDir, { recursive: true });
  writeFileSync(path.join(migrationsDir, "20240101000950_0200_x.sql"), migracion);
  if (concurrente !== undefined) writeFileSync(path.join(concurrentesDir, "0200_x.sql"), concurrente);
  return { migrationsDir, concurrentesDir };
}

describe("revisarIndicesTablasGrandes", () => {
  it("rechaza un create index sobre una tabla grande sin lock_timeout ni gemelo concurrente", () => {
    const { migrationsDir, concurrentesDir } = arbol("create index foo_idx on rentas.mensaje (conversacion_id, creado_en);\n");
    const problemas = revisarIndicesTablasGrandes(migrationsDir, concurrentesDir);
    expect(problemas.map((p) => p.motivo).sort()).toEqual(["sin_gemelo_concurrente", "sin_lock_timeout"]);
    expect(problemas[0]?.indice).toBe("foo_idx");
  });

  it("acepta el patrón completo: lock_timeout + if not exists + gemelo concurrently con el mismo nombre", () => {
    const { migrationsDir, concurrentesDir } = arbol(
      "set lock_timeout = '5s';\ncreate index if not exists foo_idx on core.authz_audit_log (organization_id);\nreset lock_timeout;\n",
      "create index concurrently if not exists foo_idx on core.authz_audit_log (organization_id);\n",
    );
    expect(revisarIndicesTablasGrandes(migrationsDir, concurrentesDir)).toEqual([]);
  });

  it("detecta tablas *_audit_log y *outbox de cualquier esquema", () => {
    const { migrationsDir, concurrentesDir } = arbol(
      "set lock_timeout = '5s';\ncreate index a_idx on hoteles.fraude_audit_log (x);\ncreate index b_idx on licitaciones.whatsapp_outbox (y);\n",
    );
    expect(revisarIndicesTablasGrandes(migrationsDir, concurrentesDir).map((p) => p.indice)).toEqual(["a_idx", "b_idx"]);
  });

  it("ignora tablas chicas y migraciones anteriores al corte (000900)", () => {
    const root = tmp("idx-grandes-viejo-");
    const migrationsDir = path.join(root, "m");
    mkdirSync(migrationsDir);
    writeFileSync(path.join(migrationsDir, "20240101000166_022_x.sql"), "create index z on rentas.audit_log (a);\n");
    writeFileSync(path.join(migrationsDir, "20240101000950_0200_y.sql"), "create index w on core.organization (a);\n");
    expect(revisarIndicesTablasGrandes(migrationsDir, path.join(root, "nada"))).toEqual([]);
  });

  it("un gemelo sin `concurrently` no cuenta", () => {
    const { migrationsDir, concurrentesDir } = arbol(
      "set lock_timeout = '5s';\ncreate index if not exists foo_idx on core.llm_usage_daily (role);\n",
      "create index if not exists foo_idx on core.llm_usage_daily (role);\n",
    );
    expect(revisarIndicesTablasGrandes(migrationsDir, concurrentesDir).map((p) => p.motivo)).toEqual(["sin_gemelo_concurrente"]);
  });

  it("la lista de tablas grandes cubre las del alcance de Ola 4", () => {
    for (const t of ["rentas.mensaje", "core.llm_usage_daily", "core.billing_webhook_log", "x.audit_log", "core.authz_audit_log", "citas.messaging_outbox"]) {
      expect(TABLAS_GRANDES.some((re) => re.test(t)), t).toBe(true);
    }
  });

  it("el árbol real del repo cumple la política", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    expect(revisarIndicesTablasGrandes(path.join(repoRoot, "supabase", "migrations"), path.join(repoRoot, "scripts", "indices-concurrentes"))).toEqual([]);
  });
});
