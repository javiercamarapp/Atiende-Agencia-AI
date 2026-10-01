// Contrato de vercel.json para el cron de purga de la boveda de identidad (hoteles):
// una entrada diaria a las 08:00 UTC (02:00 CDMX), sin duplicados, y el handler montado
// en esa misma ruta sigue protegido con el secreto interno (401 sin secreto).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const vercel = JSON.parse(readFileSync(path.resolve(here, "..", "..", "..", "vercel.json"), "utf8")) as {
  crons?: Array<{ path: string; schedule: string }>;
  rewrites?: Array<{ source: string; destination: string }>;
};

describe("vercel.json -- cron de purga de identidad (hoteles)", () => {
  const entries = (vercel.crons ?? []).filter((c) => c.path === "/internal/hoteles/identidad-purga");

  it("declara exactamente una entrada, diaria a las 08:00 UTC (02:00 CDMX)", () => {
    expect(entries).toEqual([{ path: "/internal/hoteles/identidad-purga", schedule: "0 8 * * *" }]);
  });

  it("ningun path de cron esta duplicado y todos viven bajo /internal/ (cubierto por el rewrite a la API)", () => {
    const paths = (vercel.crons ?? []).map((c) => c.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) expect(p.startsWith("/internal/")).toBe(true);
    expect(vercel.rewrites?.some((r) => r.source === "/internal/:path*" && r.destination === "/api")).toBe(true);
  });
});
