// El SQL del catalogo de licitaciones se ejecuta contra Postgres REAL en
// scripts/verify-data-chat-despachos-licitaciones/assertions.sql. Este guard exige que los textos sean
// IDENTICOS (modulo espacios en blanco) para que el verify nunca pruebe una consulta distinta a la que
// corre en produccion, y fija propiedades de seguridad del SQL que un cambio descuidado podria romper.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_DATA_CHAT_SQL } from "../../src/data-chat/sql.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const assertions = readFileSync(path.resolve(here, "../../../../scripts/verify-data-chat-despachos-licitaciones/assertions.sql"), "utf8");
const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

describe("SQL de chat con datos (licitaciones): identico al que verifica scripts/verify-data-chat-despachos-licitaciones", () => {
  for (const [name, sql] of Object.entries(ALL_DATA_CHAT_SQL)) {
    it(`${name} aparece tal cual en assertions.sql`, () => {
      expect(norm(assertions)).toContain(norm(sql));
    });
  }
});

describe("SQL de chat con datos (licitaciones): propiedades de seguridad", () => {
  const all = Object.entries(ALL_DATA_CHAT_SQL);

  it("solo lectura: ninguna sentencia escribe ni hace DDL", () => {
    for (const [name, sql] of all) {
      expect(sql, name).toMatch(/^\s*(select|with)\b/i);
      expect(sql, name).not.toMatch(/\b(insert|update|delete|drop|alter|create|truncate|grant|copy)\b/i);
    }
  });

  it("parametrizado: sin interpolacion ni concatenacion de valores", () => {
    for (const [name, sql] of all) {
      expect(sql, name).not.toContain("${");
      expect(sql, name).not.toMatch(/\|\|/);
      expect(sql, name).toMatch(/\$1\b/);
    }
  });

  it("todo parametro declarado hasta el mayor $n se usa (Postgres rechaza parametros sin referenciar)", () => {
    for (const [name, sql] of all) {
      const used = new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      for (let i = 1; i <= Math.max(...used); i += 1) expect(used.has(i), `${name} no usa $${i}`).toBe(true);
    }
  });

  it("toda consulta acota por organizacion ($1) y la repite en cada JOIN de tabla de negocio (defensa en profundidad con RLS)", () => {
    for (const [name, sql] of all) {
      expect(sql, name).toMatch(/\w+\.organization_id = \$1/);
      for (const m of sql.matchAll(/join licitaciones\.\w+ (\w+) on ([^\n]+)/g)) expect(m[2], `${name} join ${m[1]}`).toMatch(/organization_id = \w+\.organization_id/);
    }
  });

  it("toda consulta tiene tope de filas (limit)", () => {
    for (const [name, sql] of all) expect(sql, name).toMatch(/limit (\$\d|\d+)/);
  });

  it("dias y 'hoy' se calculan en la fecha LOCAL del negocio ($2), nunca con current_date/now() del servidor", () => {
    for (const [name, sql] of all) {
      expect(sql, name).not.toMatch(/current_date|current_timestamp|\bnow\(\)/i);
      if (/dias_restantes|semaforo/.test(sql)) expect(sql, name).toMatch(/at time zone \$2::text/);
    }
  });

  it("el monto solo se muestra si la moneda es MXN (no se convierte ni se inventa tipo de cambio)", () => {
    for (const [name, sql] of all.filter(([, s]) => /budget_amount/.test(s))) expect(sql, name).toMatch(/case when t\.currency = 'MXN' then t\.budget_amount end/);
  });

  it("nunca selecciona documentos, requisitos, secciones ni datos de la empresa (solo campos de negocio)", () => {
    for (const [name, sql] of all) {
      expect(sql, name).not.toMatch(/tender_document|requirement_item|proposal_section|company_document|company_capability|company_signer|storage_ref|content\b|file_blob|approved_rate/i);
    }
  });

  it("las convocatorias abiertas excluyen presentadas, ganadas, perdidas, canceladas y no-go", () => {
    for (const n of ["SQL_CONVOCATORIAS_ABIERTAS", "SQL_PLAZOS_SEMAFORO"]) expect(ALL_DATA_CHAT_SQL[n], n).toContain("t.status in ('discovered', 'in_review', 'go', 'in_progress')");
  });

  it("renovaciones excluye contratos cerrados/rescindidos y sin fecha de fin", () => {
    expect(ALL_DATA_CHAT_SQL["SQL_RENOVACIONES"]).toMatch(/c\.status not in \('cerrado', 'rescindido'\)/);
    expect(ALL_DATA_CHAT_SQL["SQL_RENOVACIONES"]).toMatch(/c\.end_date is not null/);
  });
});
