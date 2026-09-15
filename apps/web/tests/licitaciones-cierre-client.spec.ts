import { describe, expect, it, vi } from "vitest";
import {
  approveExpediente,
  approveProposalSection,
  assemblePackage,
  downloadPackage,
  fetchLatestPackage,
  PackageDownloadConflictError,
} from "../src/verticals/licitaciones/lib/cierre-client.ts";

describe("approveExpediente", () => {
  it("hace POST .../expediente/approval sin body de negocio (el hash se recalcula server-side)", async () => {
    const approval = { id: "appr-1", scope: "expediente" as const, scopeRef: "expediente", status: "vigente" as const, inputsHash: "hash-abc", decidedAt: "2026-01-01T00:00:00Z" };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/expediente/approval");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({});
      return new Response(JSON.stringify(approval), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await approveExpediente(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result).toEqual(approval);
  });

  it("403 (autoaprobación o rol fuera de DECISION_ROLES) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Quien redactó contenido de una sección no puede autoaprobar el expediente." }), { status: 403 })) as unknown as typeof fetch;
    await expect(approveExpediente(fetchImpl, "http://api.local", "tok", "prop-1", "t1")).rejects.toThrow("no puede autoaprobar");
  });
});

describe("approveProposalSection", () => {
  it("hace POST .../proposal/sections/:sectionKey/approval codificando el sectionKey en la URL", async () => {
    const approval = { id: "appr-2", scope: "seccion" as const, scopeRef: "seccion:economic:carta", status: "vigente" as const, inputsHash: "hash-abc", decidedAt: "2026-01-01T00:00:00Z" };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/proposal/sections/economic%3Acarta/approval");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify(approval), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await approveProposalSection(fetchImpl, "http://api.local", "tok", "prop-1", "t1", "economic:carta");
    expect(result).toEqual(approval);
  });
});

describe("assemblePackage", () => {
  it("hace POST .../package/assemble con idempotency-key y devuelve el estado tal cual", async () => {
    const status = { id: "prop-1", status: "draft" as const, draftReasons: ["checklist_no_verde:rojo"], missing: [], generatedAt: "2026-01-01T00:00:00Z", notice: "La presentación y firma las realiza el usuario; el sistema no envía ofertas." };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/package/assemble");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers["idempotency-key"]).toBeTruthy();
      return new Response(JSON.stringify(status), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await assemblePackage(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result).toEqual(status);
  });

  it("respeta un idempotency-key explícito en vez de generar uno nuevo", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["idempotency-key"]).toBe("fixed-assemble-key");
      return new Response(JSON.stringify({ id: "prop-1", status: "ready", draftReasons: [], missing: [], generatedAt: "2026-01-01T00:00:00Z", notice: "" }), { status: 200 });
    }) as unknown as typeof fetch;
    await assemblePackage(fetchImpl, "http://api.local", "tok", "prop-1", "t1", "fixed-assemble-key");
  });
});

describe("fetchLatestPackage", () => {
  it("pide GET .../package/latest y devuelve el estado tal cual", async () => {
    const status = { id: "prop-1", status: "ready" as const, draftReasons: [], missing: [], generatedAt: "2026-01-01T00:00:00Z", notice: "aviso" };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/package/latest");
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.authorization).toBe("Bearer tok");
      return new Response(JSON.stringify(status), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchLatestPackage(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result).toEqual(status);
  });

  it("404 (nunca se ensambló nada todavía) -> null, nunca lanza", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No se ha generado ningún paquete todavía para este expediente." }), { status: 404 })) as unknown as typeof fetch;
    const result = await fetchLatestPackage(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result).toBeNull();
  });

  it("otro error (500) -> sí lanza con el mensaje real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Error interno." }), { status: 500 })) as unknown as typeof fetch;
    await expect(fetchLatestPackage(fetchImpl, "http://api.local", "tok", "prop-1", "t1")).rejects.toThrow("Error interno.");
  });
});

describe("downloadPackage", () => {
  it("200 -> devuelve el blob y el filename del Content-Disposition", async () => {
    const bytes = new Uint8Array([80, 75, 3, 4]); // firma ZIP
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/package/download");
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.authorization).toBe("Bearer tok");
      return new Response(bytes, { status: 200, headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="expediente-prop-1.zip"' } });
    }) as unknown as typeof fetch;
    const result = await downloadPackage(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result.filename).toBe("expediente-prop-1.zip");
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.blob.size).toBe(bytes.length);
  });

  it("sin Content-Disposition -> cae a un filename determinista con el tenderId", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2]), { status: 200 })) as unknown as typeof fetch;
    const result = await downloadPackage(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result.filename).toBe("expediente-t1.zip");
  });

  it("409 (el 'ready' guardado ya no lo es, REQ-LIC-009) -> PackageDownloadConflictError con el detalle, nunca descarga bytes viejos", async () => {
    const conflict = { code: "conflict" as const, message: "El paquete generado quedó desactualizado.", draftReasons: ["sin_aprobacion_vigente_de_alcance_expediente"], missing: [] };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(conflict), { status: 409 })) as unknown as typeof fetch;
    await expect(downloadPackage(fetchImpl, "http://api.local", "tok", "prop-1", "t1")).rejects.toBeInstanceOf(PackageDownloadConflictError);
    const fetchImpl2 = vi.fn(async () => new Response(JSON.stringify(conflict), { status: 409 })) as unknown as typeof fetch;
    try {
      await downloadPackage(fetchImpl2, "http://api.local", "tok", "prop-1", "t1");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PackageDownloadConflictError);
      expect((err as InstanceType<typeof PackageDownloadConflictError>).conflict).toEqual(conflict);
    }
  });

  it("404 (sin paquete descargable) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No se ha generado ningún paquete descargable todavía." }), { status: 404 })) as unknown as typeof fetch;
    await expect(downloadPackage(fetchImpl, "http://api.local", "tok", "prop-1", "t1")).rejects.toThrow("No se ha generado ningún paquete descargable todavía.");
  });
});
