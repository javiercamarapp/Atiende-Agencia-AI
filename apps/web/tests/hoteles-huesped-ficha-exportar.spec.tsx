// @vitest-environment jsdom
//
// H-30 -- boton "Exportar datos" de la ficha del huesped (HuespedFicha.tsx): solo owner/gm lo ven, descarga JSON/CSV por la API real
// (GET .../huespedes/:id/exportar-datos?formato=) con el token del staff, y un rechazo del servidor (503 base sin migrar, 403) se muestra.
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

import { HuespedFichaPage } from "../src/verticals/hoteles/pages/HuespedFicha.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CTX: HotelesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Ana", staffEmail: "ana@example.com" };
const FICHA = {
  huesped: { id: "00000000-0000-4000-8000-000000000001", nombreCompleto: "Ana Torres", email: "ana@example.com", telefono: "5511112222" },
  resumen: { estancias: 0, noches: 0, ultimaEstancia: null, proximaLlegada: null },
  estancias: [],
  notas: { disponible: true, items: [] },
  contactos: [],
  consentimientos: [],
  identidad: { registrada: false },
  arco: { restriccion: false },
};
const GID = FICHA.huesped.id;

function stub(exportar: () => Response) {
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith(`/huespedes/${GID}/ficha`)) return { ok: true, status: 200, json: async () => FICHA } as unknown as Response;
    if (url.includes("/exportar-datos")) return exportar();
    throw new Error(`fetch inesperado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
async function esperar() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await flushMicrotasks();
  });
}
function montar(ctx: HotelesShellContext = CTX) {
  rendered = renderComponent(
    <MemoryRouter initialEntries={[`/hoteles/demo/huespedes/${GID}`]}>
      <Routes>
        <Route path="/hoteles/:orgSlug/huespedes/:guestId" element={<HuespedFichaPage {...ctx} />} />
      </Routes>
    </MemoryRouter>,
  );
}
const boton = (t: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(t)) as HTMLButtonElement | undefined;
const texto = () => rendered!.container.textContent ?? "";

describe("Exportar datos en la ficha del huesped", () => {
  it("owner y gm ven los botones; frontdesk/reservations no (el servidor igual los rechazaria con 403)", async () => {
    stub(() => ({ ok: true, status: 200, blob: async () => new Blob(["{}"]) }) as unknown as Response);
    montar();
    await esperar();
    expect(boton("Exportar datos (JSON)")).toBeTruthy();
    expect(boton("Exportar datos (CSV)")).toBeTruthy();
    expect(texto()).toContain("El documento de identidad nunca se exporta");
    rendered!.unmount();
    montar({ ...CTX, role: "gm" });
    await esperar();
    expect(boton("Exportar datos (JSON)")).toBeTruthy();
    for (const role of ["frontdesk", "reservations"]) {
      rendered!.unmount();
      montar({ ...CTX, role });
      await esperar();
      expect(boton("Exportar datos (JSON)")).toBeUndefined();
    }
  });
  it("descarga el JSON y el CSV con el formato y el token correctos y dispara la descarga con nombre de archivo", async () => {
    stub(() => ({ ok: true, status: 200, blob: async () => new Blob(["x"]) }) as unknown as Response);
    const create = vi.fn(() => "blob:test");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    });
    montar();
    await esperar();
    click(boton("Exportar datos (JSON)")!);
    await esperar();
    click(boton("Exportar datos (CSV)")!);
    await esperar();
    const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("exportar-datos"));
    expect(urls).toEqual([`https://api.test/hoteles/prop-1/huespedes/${GID}/exportar-datos?formato=json`, `https://api.test/hoteles/prop-1/huespedes/${GID}/exportar-datos?formato=csv`]);
    expect((fetchMock.mock.calls.find((c) => String(c[0]).includes("exportar-datos"))![1] as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
    expect(clicks).toEqual([`datos-huesped-${GID.slice(0, 8)}.json`, `datos-huesped-${GID.slice(0, 8)}.csv`]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledTimes(2);
  });
  it("un rechazo del servidor (base sin migrar 503) se muestra y no descarga nada", async () => {
    stub(() => ({ ok: false, status: 503, json: async () => ({ message: "La privacidad aun no esta disponible: migracion 042 pendiente." }) }) as unknown as Response);
    const create = vi.fn(() => "blob:test");
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    montar();
    await esperar();
    click(boton("Exportar datos (CSV)")!);
    await esperar();
    expect(rendered!.container.querySelector('[role="alert"]')?.textContent).toContain("migracion 042 pendiente");
    expect(create).not.toHaveBeenCalled();
    expect(boton("Exportar datos (CSV)")!.disabled).toBe(false);
  });
});
