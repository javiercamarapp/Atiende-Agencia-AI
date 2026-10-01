// @vitest-environment jsdom
//
// H-35 -- <FolioPage />: transferir un cargo a otro folio de la misma reserva y dividir un folio (endpoints que ya existian en
// apps/api/.../hoteles/folios.ts y no tenian boton). `fetch` global mockeado por ruta real; verifica metodo/ruta/cuerpo y que
// solo se ofrezca lo que el servidor aceptaria (cargos reales y vigentes, folios destino abiertos de la misma reserva).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { FolioPage } from "../src/verticals/hoteles/pages/Folio.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import type { FolioSummary } from "../src/verticals/hoteles/lib/folios-client.ts";
import { cargoTransferible } from "../src/verticals/hoteles/lib/folios-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

const CTX: HotelesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "frontdesk", staffFullName: "Ana", staffEmail: "ana@example.com" };

const cargo = (id: string, over: Partial<FolioSummary["cargos"][number]> = {}) => ({
  id,
  concepto: "extras" as const,
  descripcion: `Cargo ${id}`,
  monto: 100,
  impuesto: 16,
  revertidoPor: null,
  reversaDe: null,
  transferidoDe: null,
  creadoEn: "2026-09-18T10:00:00.000Z",
  ...over,
});

const FOLIO: FolioSummary = {
  id: "folio-1",
  estado: "abierto",
  reservationId: "res-1",
  etiqueta: "Hab. 101",
  esPrincipal: true,
  cerradoEn: null,
  motivoCierre: null,
  cargos: [cargo("ch-1"), cargo("ch-2", { concepto: "ab", descripcion: "Cena" }), cargo("ch-3", { concepto: "reverso", descripcion: "Reverso" }), cargo("ch-4", { revertidoPor: "ch-3" })],
  pagos: [],
  saldo: 232,
};
const OTRO: FolioSummary = { ...FOLIO, id: "folio-2", etiqueta: "Empresa", esPrincipal: false, cargos: [], saldo: 0 };
const CERRADO: FolioSummary = { ...OTRO, id: "folio-3", etiqueta: "Viejo", estado: "cerrado" };

function stubFetch(over: { hermanos?: FolioSummary[]; falla?: { url: RegExp; message: string } } = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (over.falla && method === "POST" && over.falla.url.test(url)) return json({ code: "conflict", message: over.falla.message }, 409);
    if (method === "GET" && /\/folios\/folio-1$/.test(url)) return json(FOLIO);
    if (method === "GET" && url.endsWith("/reservas/res-1/folios")) return json(over.hermanos ?? [FOLIO, OTRO, CERRADO]);
    if (method === "POST" && url.endsWith("/transferir")) return json({ id: "ch-9", folioDestinoId: "folio-2" }, 201);
    if (method === "POST" && url.endsWith("/split")) return json({ id: "folio-9", etiqueta: "Facturar aparte" }, 201);
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

const montar = () => {
  rendered = renderComponent(
    <MemoryRouter>
      <FolioPage {...CTX} folioId="folio-1" />
    </MemoryRouter>,
  );
};
async function esperar() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}
const botones = (txt: string) => [...rendered!.container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === txt);
const texto = () => rendered!.container.textContent ?? "";

describe("FolioPage -- transferir y dividir (H-35)", () => {
  it("solo ofrece Transferir en cargos reales y vigentes (no reversos ni ya reversados)", async () => {
    stubFetch();
    montar();
    await esperar();
    expect(botones("Transferir")).toHaveLength(2); // ch-1 y ch-2
  });

  it("sin otro folio abierto en la reserva no hay Transferir (los cerrados no cuentan)", async () => {
    stubFetch({ hermanos: [FOLIO, CERRADO] });
    montar();
    await esperar();
    expect(botones("Transferir")).toHaveLength(0);
  });

  it("transferir: elige el folio destino abierto, manda motivo e idempotency-key y recarga", async () => {
    stubFetch();
    montar();
    await esperar();
    await act(async () => {
      click(botones("Transferir")[0]!);
    });
    const select = rendered!.container.querySelector('select[aria-label="Folio destino"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["", "folio-2"]);
    expect(botones("Confirmar transferencia")[0]!.disabled).toBe(true);
    changeValue(select, "folio-2");
    changeValue(rendered!.container.querySelector('input[placeholder="Motivo (opcional)"]') as HTMLInputElement, "Cargo de la empresa");
    await act(async () => {
      click(botones("Confirmar transferencia")[0]!);
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    const call = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/folios/folio-1/cargos/ch-1/transferir") && init?.method === "POST")!;
    expect(JSON.parse(call[1].body as string)).toEqual({ folioDestinoId: "folio-2", motivo: "Cargo de la empresa" });
    expect((call[1].headers as Record<string, string>)["idempotency-key"]).toBeTruthy();
    expect(texto()).toContain("Cargo transferido al otro folio.");
  });

  it("un rechazo del servidor (409) se muestra tal cual", async () => {
    stubFetch({ falla: { url: /transferir$/, message: "El folio destino está cerrado." } });
    montar();
    await esperar();
    await act(async () => {
      click(botones("Transferir")[0]!);
    });
    changeValue(rendered!.container.querySelector('select[aria-label="Folio destino"]') as HTMLSelectElement, "folio-2");
    await act(async () => {
      click(botones("Confirmar transferencia")[0]!);
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(texto()).toContain("El folio destino está cerrado.");
  });

  it("dividir: exige nombre y al menos un cargo, y manda etiqueta + chargeIds", async () => {
    stubFetch();
    montar();
    await esperar();
    const form = [...rendered!.container.querySelectorAll("form")].find((f) => f.textContent?.includes("Dividir folio"))!;
    const submit = [...form.querySelectorAll("button")].find((b) => b.textContent?.includes("Crear folio"))!;
    expect(submit.disabled).toBe(true);
    const checks = [...form.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(checks).toHaveLength(2);
    await act(async () => {
      click(checks[1]!);
    });
    changeValue(form.querySelector('input[placeholder="Nombre del folio nuevo"]') as HTMLInputElement, "Facturar aparte");
    await submitForm(form);
    await esperar();
    const call = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/folios/folio-1/split") && init?.method === "POST")!;
    expect(JSON.parse(call[1].body as string)).toEqual({ etiqueta: "Facturar aparte", chargeIds: ["ch-2"] });
    expect(texto()).toContain('Folio "Facturar aparte" creado');
  });

  it("cargoTransferible refleja las reglas del servidor", () => {
    expect(cargoTransferible({ concepto: "extras", revertidoPor: null })).toBe(true);
    expect(cargoTransferible({ concepto: "reverso", revertidoPor: null })).toBe(false);
    expect(cargoTransferible({ concepto: "descuento", revertidoPor: null })).toBe(false);
    expect(cargoTransferible({ concepto: "extras", revertidoPor: "x" })).toBe(false);
  });
});
