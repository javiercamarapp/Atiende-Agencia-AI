// @vitest-environment jsdom
// L-26/L-28 -- cliente web de la doble aprobacion del expediente y de la declaracion de presentacion.
import { describe, expect, it, vi } from "vitest";
import {
  approveExpedienteStage,
  declareSubmission,
  EXPEDIENTE_STAGE_LABELS,
  fetchExpedienteApprovals,
  fetchSubmission,
  instantToLocalInput,
  localInputToIso,
  readFileAsBase64,
} from "../src/verticals/licitaciones/lib/cierre-client.ts";
import { requestStepUpToken } from "../src/verticals/licitaciones/lib/two-factor-client.ts";

const BASE = "http://api.local/licitaciones/prop-1/tenders/t1";

describe("approveExpedienteStage", () => {
  it("POST .../expediente/approval con SOLO la etapa en el cuerpo y el token de step-up en x-step-up-token (nunca un hash)", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE}/expediente/approval`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ stage: "tecnica_legal" });
      expect((init!.headers as Record<string, string>)["x-step-up-token"]).toBe("su-tok");
      return new Response(JSON.stringify({ id: "a1", scope: "expediente", scopeRef: "expediente", status: "vigente", inputsHash: "h", decidedAt: "2026-10-01T10:00:00Z", stage: "tecnica_legal" }), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await approveExpedienteStage(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { stage: "tecnica_legal", stepUpToken: "su-tok" });
    expect(result.stage).toBe("tecnica_legal");
  });

  it("sin 2FA en la base (stepUpToken null) no manda la cabecera", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init!.headers as Record<string, string>)["x-step-up-token"]).toBeUndefined();
      return new Response(JSON.stringify({ id: "a1", scope: "expediente", scopeRef: "expediente", status: "vigente", inputsHash: "h", decidedAt: "x", stage: "economica" }), { status: 201 });
    }) as unknown as typeof fetch;
    await approveExpedienteStage(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { stage: "economica", stepUpToken: null });
  });

  it("propaga el mensaje real del servidor (403 misma persona, 409 falta la 1/2, 403 step-up)", async () => {
    for (const [status, message] of [
      [403, "La aprobación técnico-legal y la económica deben darlas dos personas distintas."],
      [409, "falta la aprobación técnico-legal (1/2)"],
      [403, "Esta acción requiere confirmar tu identidad con el código de tu app de autenticación."],
    ] as const) {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message }), { status })) as unknown as typeof fetch;
      await expect(approveExpedienteStage(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { stage: "economica", stepUpToken: null })).rejects.toThrow(message.slice(0, 20));
    }
  });

  it("etiquetas de las dos etapas", () => {
    expect(EXPEDIENTE_STAGE_LABELS).toEqual({ tecnica_legal: "Técnico-legal (1/2)", economica: "Económica (2/2)" });
  });
});

describe("requestStepUpToken con el alcance del expediente", () => {
  it("pide el token con scope expediente_approval", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toEqual({ scope: "expediente_approval", code: "123456" });
      return new Response(JSON.stringify({ stepUpToken: "tok-su" }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await requestStepUpToken(fetchImpl, "http://api.local", "t", "expediente_approval", { code: "123456" })).toBe("tok-su");
  });
});

describe("fetchExpedienteApprovals", () => {
  it("GET .../expediente/approvals y devuelve el estado tal cual", async () => {
    const state = { mode: "doble", stages: [{ stage: "tecnica_legal", approval: null }, { stage: "economica", approval: null }], complete: false, missing: ["tecnica_legal", "economica"] };
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(`${BASE}/expediente/approvals`);
      return new Response(JSON.stringify(state), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchExpedienteApprovals(fetchImpl, "http://api.local", "tok", "prop-1", "t1")).toEqual(state);
  });

  it("un fallo del servidor lanza con su mensaje (la pantalla lo muestra con reintento)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Convocatoria no encontrada." }), { status: 404 })) as unknown as typeof fetch;
    await expect(fetchExpedienteApprovals(fetchImpl, "http://api.local", "tok", "prop-1", "t1")).rejects.toThrow("Convocatoria no encontrada.");
  });
});

describe("fetchSubmission / declareSubmission", () => {
  it("GET .../submission: null es 'todavia no declarada' (no error)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(`${BASE}/submission`);
      return new Response("null", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchSubmission(fetchImpl, "http://api.local", "tok", "prop-1", "t1")).toBeNull();
  });

  it("POST .../submission/declare con idempotency-key, fecha ISO, notas y acuse opcional", async () => {
    const record = { id: "s1", status: "submitted", submittedAt: "2026-10-01T16:00:00.000Z", acknowledgementStorageRef: null, acknowledgementFileHash: null, notes: "folio 123", createdAt: "2026-10-01T16:05:00.000Z" };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE}/submission/declare`);
      expect((init!.headers as Record<string, string>)["idempotency-key"]).toBe("clave-1");
      expect(JSON.parse(init!.body as string)).toEqual({ submittedAt: "2026-10-01T16:00:00.000Z", notes: "folio 123", acknowledgementContentBase64: null });
      return new Response(JSON.stringify(record), { status: 201 });
    }) as unknown as typeof fetch;
    expect(await declareSubmission(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { submittedAt: "2026-10-01T16:00:00.000Z", notes: "folio 123" }, "clave-1")).toEqual(record);
  });

  it("sin clave explicita genera una distinta por llamada", async () => {
    const keys: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      keys.push((init!.headers as Record<string, string>)["idempotency-key"]!);
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    await declareSubmission(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { submittedAt: "2026-10-01T16:00:00.000Z" });
    await declareSubmission(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { submittedAt: "2026-10-01T16:00:00.000Z" });
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("422 (misma clave con otro cuerpo) y 403 (rol de solo lectura) propagan el mensaje", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "El Idempotency-Key ya fue usado con un cuerpo de solicitud distinto." }), { status: 422 })) as unknown as typeof fetch;
    await expect(declareSubmission(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { submittedAt: "2026-10-01T16:00:00.000Z" })).rejects.toThrow("Idempotency-Key");
  });
});

describe("helpers de fecha y acuse", () => {
  it("localInputToIso interpreta el datetime-local en la zona del navegador y rechaza vacio/invalido", () => {
    expect(localInputToIso("")).toBeNull();
    expect(localInputToIso("no-es-fecha")).toBeNull();
    const iso = localInputToIso("2026-10-01T10:30")!;
    expect(new Date(iso).getFullYear()).toBe(2026);
    expect(instantToLocalInput(new Date(iso))).toBe("2026-10-01T10:30");
  });

  it("readFileAsBase64 devuelve el contenido en base64 sin el prefijo data:", async () => {
    const file = new File(["acuse"], "acuse.pdf", { type: "application/pdf" });
    expect(await readFileAsBase64(file)).toBe(btoa("acuse"));
  });
});
