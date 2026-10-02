// D-25 -- aviso in-app de pagos provisionales por vencer: una emision por organizacion por dia con la cantidad (sin PII), base sin migrar
// (SAVEPOINT, no emite y no rompe), una emision fallida no afecta a las demas organizaciones, y el cron de cobranza lo invoca sin alterar su respuesta.
import { describe, expect, it } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { avisarPagosProvisionalesPorVencer } from "../src/routes/verticals/despachos/pagos-provisionales-aviso.ts";
import type { AppDeps } from "../src/deps.ts";

interface Emision {
  readonly organizationId: string;
  readonly evento: string;
  readonly cuerpo: string;
  readonly dedupeKey: string;
  readonly enlace: string;
  readonly roles: readonly string[] | null;
}

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function depsFalsas(opciones: { filas?: { out_organization_id: string; out_cantidad: number }[]; errorLectura?: Error; orgQueFalla?: string }) {
  const emisiones: Emision[] = [];
  const llamadasSql: string[] = [];
  const sesion: TenantDbSession = {
    exec: async (sql: string) => {
      llamadasSql.push(sql.trim().toLowerCase());
    },
    query: async <T,>(sql: string, params?: unknown[]) => {
      llamadasSql.push(sql.trim().toLowerCase().slice(0, 60));
      if (/system_pagos_provisionales_por_vencer/.test(sql)) {
        if (opciones.errorLectura) throw opciones.errorLectura;
        return { rows: (opciones.filas ?? []) as unknown as T[] };
      }
      if (/core\.emit_notification/.test(sql)) {
        const p = params ?? [];
        if (opciones.orgQueFalla && p[0] === opciones.orgQueFalla) throw pgError("XX000", "falla simulada de la base");
        emisiones.push({ organizationId: String(p[0]), evento: String(p[2]), cuerpo: String(p[6]), dedupeKey: String(p[10]), enlace: String(p[7]), roles: (p[11] as string[] | null) ?? null });
        return { rows: [{ emit_notification: 1 }] as unknown as T[] };
      }
      throw new Error(`consulta inesperada: ${sql}`);
    },
  };
  const engine: TenancyEngine = { withAppSession: async (_claims, fn) => fn(sesion) };
  return { deps: { engine } as unknown as AppDeps, emisiones, llamadasSql };
}

describe("avisarPagosProvisionalesPorVencer", () => {
  it("emite una por organizacion con la cantidad, a contadores, con dedupe por dia y sin PII", async () => {
    const { deps, emisiones } = depsFalsas({ filas: [{ out_organization_id: "org-a", out_cantidad: 3 }, { out_organization_id: "org-b", out_cantidad: 1 }] });
    const r = await avisarPagosProvisionalesPorVencer(deps, "2026-08-15");
    expect(r).toEqual({ estado: "ok", organizaciones: 2, emitidas: 2 });
    expect(emisiones).toHaveLength(2);
    expect(emisiones[0]).toMatchObject({
      organizationId: "org-a",
      evento: "despachos.pago_provisional.por_vencer",
      cuerpo: "Por vencer en los próximos 3 días: 3.",
      dedupeKey: "despachos.pago_provisional.por_vencer:org-a:2026-08-15",
      enlace: "/despachos/{orgSlug}/pagos-provisionales",
      roles: ["contador"],
    });
    expect(emisiones.map((e) => e.cuerpo).join(" ")).not.toMatch(/@|\d{7,}/);
  });

  it("sin obligaciones por vencer no emite nada", async () => {
    const { deps, emisiones } = depsFalsas({ filas: [] });
    expect(await avisarPagosProvisionalesPorVencer(deps, "2026-08-15")).toEqual({ estado: "ok", organizaciones: 0, emitidas: 0 });
    expect(emisiones).toHaveLength(0);
  });

  it("una organizacion con cantidad cero no emite", async () => {
    const { deps, emisiones } = depsFalsas({ filas: [{ out_organization_id: "org-a", out_cantidad: 0 }] });
    await avisarPagosProvisionalesPorVencer(deps, "2026-08-15");
    expect(emisiones).toHaveLength(0);
  });

  it("REGLA DURA: base sin la migracion 020 (42883 de la funcion) -> no_disponible, sin emitir y con SAVEPOINT recuperado", async () => {
    const { deps, emisiones, llamadasSql } = depsFalsas({ errorLectura: pgError("42883", "function despachos.system_pagos_provisionales_por_vencer(date, integer) does not exist") });
    const r = await avisarPagosProvisionalesPorVencer(deps, "2026-08-15");
    expect(r).toEqual({ estado: "no_disponible", organizaciones: 0, emitidas: 0 });
    expect(emisiones).toHaveLength(0);
    expect(llamadasSql.some((s) => s.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("un error real de la lectura (no de migracion) se propaga: el cron lo registra, no lo esconde", async () => {
    const { deps } = depsFalsas({ errorLectura: pgError("42501", "permission denied") });
    await expect(avisarPagosProvisionalesPorVencer(deps, "2026-08-15")).rejects.toMatchObject({ code: "42501" });
  });

  it("una emision que falla no afecta a las demas organizaciones", async () => {
    const { deps, emisiones } = depsFalsas({ filas: [{ out_organization_id: "org-a", out_cantidad: 1 }, { out_organization_id: "org-b", out_cantidad: 2 }], orgQueFalla: "org-a" });
    const r = await avisarPagosProvisionalesPorVencer(deps, "2026-08-15");
    expect(r).toEqual({ estado: "ok", organizaciones: 2, emitidas: 1 });
    expect(emisiones.map((e) => e.organizationId)).toEqual(["org-b"]);
  });
});
