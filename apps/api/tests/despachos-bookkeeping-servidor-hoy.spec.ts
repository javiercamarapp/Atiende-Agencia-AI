// REQ-r6 (seguimiento de PR #164, punto 1 -- LADO SERVIDOR): el default de `fecha` de
// `POST .../bookkeeping/poliza` (cuando el caller no la manda) usaba el día UTC del
// proceso -- corrido un día adelante del real en CDMX entre las 18:00 y las 23:59 hora
// local (Vercel corre con TZ=UTC). Mismo bug ya corregido del lado del navegador en PR
// #164 (`Bookkeeping.tsx`, commit `056c28d`) -- este cierra la contraparte de servidor.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

afterEach(() => {
  vi.useRealTimers();
});

// 2026-01-02T04:00:00Z = 2026-01-01T22:00:00 en America/Mexico_City (UTC-6 fijo).
const INSTANTE_22H_CDMX_DIA_1 = "2026-01-02T04:00:00.000Z";

describe("POST /despachos/:propertyId/bookkeeping/poliza -- default de `fecha` usa el día de NEGOCIO", () => {
  it("sin `fecha` en el body, a las 22:00 CDMX, la póliza se genera con el día real (2026-01-01), no el día UTC (2026-01-02)", async () => {
    const app = buildApp(ctx.deps);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_22H_CDMX_DIA_1));

    const res = await app.request(
      `/despachos/${ctx.propertyId}/bookkeeping/poliza`,
      authedJson(ctx.staff.contador.token, {
        tenantId: "tenant-prueba",
        clasificaciones: [
          {
            cfdiUuid: "11111111-1111-1111-1111-111111111111",
            rfcEmisor: "CON950820K12",
            rfcReceptor: "XAXX010101000",
            descripcion: "Renta de oficina",
            subtotal: 1000,
            iva: 160,
            total: 1160,
            tasaIva: 0.16,
            tipoCfdi: "I",
            categoria: "renta_oficina",
            confidence: 0.95,
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { polizas: { poliza: { fecha: string } | null; errores: string[] }[] };
    const [resultado] = body.polizas;
    expect(resultado?.poliza).not.toBeNull();
    expect(resultado?.poliza?.fecha).toBe("2026-01-01");
    expect(resultado?.poliza?.fecha).not.toBe("2026-01-02");
  });
});
