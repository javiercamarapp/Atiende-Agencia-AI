// PostgresResumenDiarioRepository -- 2 hallazgos endurecidos del 19-sep:
//
//   (A) `listDailyOpsSummariesForSuperadmin`/`getDailyOpsSummaryForSuperadmin`
//       deben seguir RELANZANDO tal cual (nunca atrapar el error aquí adentro)
//       -- el guard real de "migración pendiente" vive en la ruta HTTP
//       (`apps/api/src/routes/superadmin-resumen.ts`), fuera de la transacción
//       que `ProductionResumenDiarioRepository` abre por llamada. Si este
//       método atrapara el error y devolviera un valor normal, `with
//       AppSession` intentaría un `COMMIT` sobre una transacción que Postgres
//       real ya dejó ABORTADA -- `AbortedTransactionCommitError` (ver el
//       comentario de cabecera de ambos métodos en `../src/resumen-diario-
//       repository.ts`). Se verifica con `AbortAwareFakeSession` (reproduce
//       25P02 de verdad, a diferencia de un doble plano) -- si este método
//       intentara silenciosamente una segunda consulta después del error, el
//       25P02 de esa segunda consulta lo delataría.
//   (B) las 3 consultas que seleccionan `fecha` (columna `date`) deben
//       castearla a `::text` -- sin el cast, el driver `pg` real la entrega
//       como objeto `Date`, no como el `string` `YYYY-MM-DD` que
//       `DailyOpsSummaryRawRow` asume (ver exigencia 6 del hallazgo).
import { describe, expect, it } from "vitest";
import { PostgresResumenDiarioRepository } from "../src/resumen-diario-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const CALLER_ID = "00000000-0000-0000-0000-0000000000f3";
const FECHA = "2026-06-15";

function undefinedFunctionError(fn: string): Error & { code: string } {
  return Object.assign(new Error(`function ${fn} does not exist`), { code: "42883" });
}

const FILA_CRUDA = {
  fecha: FECHA,
  agregados: { fecha: FECHA },
  narrativa: "Todo tranquilo.",
  generado_por: "determinista" as const,
  costo_llm_micro_usd: null,
  modelo_llm: null,
  proveedor_llm: null,
  creado_en: "2026-06-15T15:00:00.000Z",
  actualizado_en: "2026-06-15T15:00:00.000Z",
  correo_enviado_en: null,
};

describe("PostgresResumenDiarioRepository -- consultas de fecha::text (hallazgo B, exigencia 6)", () => {
  it("listDailyOpsSummariesForSuperadmin castea fecha a ::text -- pg real entregaría un objeto Date sin este cast", async () => {
    const session = new AbortAwareFakeSession([{ match: /fecha::text as fecha/i, respond: () => [FILA_CRUDA] }]);
    const repo = new PostgresResumenDiarioRepository(session);
    const rows = await repo.listDailyOpsSummariesForSuperadmin(CALLER_ID, 30);
    expect(rows).toEqual([expect.objectContaining({ fecha: FECHA })]);
  });

  it("getDailyOpsSummaryForSuperadmin castea fecha a ::text", async () => {
    const session = new AbortAwareFakeSession([{ match: /fecha::text as fecha/i, respond: () => [FILA_CRUDA] }]);
    const repo = new PostgresResumenDiarioRepository(session);
    const row = await repo.getDailyOpsSummaryForSuperadmin(CALLER_ID, FECHA);
    expect(row).toEqual(expect.objectContaining({ fecha: FECHA }));
  });

  it("getDailyOpsSummaryForSystem castea fecha a ::text", async () => {
    const session = new AbortAwareFakeSession([{ match: /fecha::text as fecha/i, respond: () => [FILA_CRUDA] }]);
    const repo = new PostgresResumenDiarioRepository(session);
    const row = await repo.getDailyOpsSummaryForSystem(FECHA);
    expect(row).toEqual(expect.objectContaining({ fecha: FECHA }));
  });
});

describe("PostgresResumenDiarioRepository -- *ForSuperadmin relanzan tal cual (hallazgo A: el guard vive en la ruta HTTP, no aquí)", () => {
  it("listDailyOpsSummariesForSuperadmin -- un 42883 real (función sin migrar) se repropaga sin atraparlo, sesión queda 'abortada' (nadie más consulta después, mismo criterio que el resto del archivo)", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.list_daily_ops_summaries_for_superadmin/, respond: () => undefinedFunctionError("core.list_daily_ops_summaries_for_superadmin(uuid, integer)") }]);
    const repo = new PostgresResumenDiarioRepository(session);
    await expect(repo.listDailyOpsSummariesForSuperadmin(CALLER_ID, 30)).rejects.toMatchObject({ code: "42883" });
  });

  it("getDailyOpsSummaryForSuperadmin -- mismo criterio, se repropaga sin atraparlo", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.get_daily_ops_summary_for_superadmin/, respond: () => undefinedFunctionError("core.get_daily_ops_summary_for_superadmin(uuid, date)") }]);
    const repo = new PostgresResumenDiarioRepository(session);
    await expect(repo.getDailyOpsSummaryForSuperadmin(CALLER_ID, FECHA)).rejects.toMatchObject({ code: "42883" });
  });

  it("getDailyOpsSummaryForSuperadmin -- un error que NO es 42883 (p. ej. 'operator does not exist') también se repropaga tal cual, sin distinción especial a este nivel (la clasificación vive en la ruta HTTP)", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.get_daily_ops_summary_for_superadmin/, respond: () => Object.assign(new Error("operator does not exist: uuid = text"), { code: "42883" }) }]);
    const repo = new PostgresResumenDiarioRepository(session);
    await expect(repo.getDailyOpsSummaryForSuperadmin(CALLER_ID, FECHA)).rejects.toThrow("operator does not exist: uuid = text");
  });
});
