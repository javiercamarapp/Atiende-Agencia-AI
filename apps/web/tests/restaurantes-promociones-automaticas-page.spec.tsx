// @vitest-environment jsdom
//
// PM PR-4: <PromocionesPage /> crea promociones automaticas (2x1 del lunes) y el combo de cortesia del martes
// (solo recoger) con los campos que valida el servidor.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromocionesPage } from "../src/verticals/restaurantes/pages/Promociones.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "t", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "G", staffEmail: "g@example.com" };
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const PRODUCTOS = ["nachos", "agua-1", "agua-2"].map((id) => ({ id, categoryId: null, categoryName: null, name: id, description: null, price: 10, imageUrl: null, isPopular: false, isAvailable: true, displayOrder: 0, searchKeywords: [], branch: null }));

function stub(existing: unknown[] = []) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/admin/products")) return json({ products: PRODUCTOS });
    if (method === "GET" && url.endsWith("/admin/promotions")) return json({ promotions: existing });
    if (method === "POST" && url.endsWith("/admin/promotions")) return json({ promotion: { id: "n", ...JSON.parse(init!.body as string) } });
    throw new Error(`fetch inesperado: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function abrir() {
  rendered = renderComponent(
    <MemoryRouter>
      <PromocionesPage {...CTX} />
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
  const btn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Crear un código nuevo"))!;
  await act(async () => {
    click(btn);
  });
}
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement;
const post = () => fetchMock.mock.calls.find(([, init]) => init?.method === "POST");

function seleccionar(select: HTMLSelectElement, values: string[]) {
  for (const o of [...select.options]) o.selected = values.includes(o.value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("PromocionesPage -- promociones automaticas", () => {
  it("2x1 del lunes: automatica, solo recoger, lunes, sin valor", async () => {
    stub();
    await abrir();
    changeValue(q("#promocion-codigo") as HTMLInputElement, "LUNES2X1");
    changeValue(q("#promocion-nombre") as HTMLInputElement, "Lunes 2x1");
    changeValue(q("#promocion-tipo") as HTMLSelectElement, "bogo");
    expect(document.body.querySelector("#promocion-valor")).toBeNull();
    changeValue(q("#promocion-canal") as HTMLSelectElement, "recoger");
    await act(async () => {
      click(q("#promocion-auto"));
      click(q('[data-testid="promocion-dia-1"]'));
    });
    await submitForm(q("#restaurantes-promocion-nueva") as HTMLFormElement);
    expect(JSON.parse(post()![1].body as string)).toMatchObject({ code: "LUNES2X1", type: "bogo", value: 1, channels: ["recoger"], autoApply: true, daysOfWeek: [1] });
  });

  it("automatica sin canal no se envia: avisa", async () => {
    stub();
    await abrir();
    changeValue(q("#promocion-codigo") as HTMLInputElement, "AUTO");
    changeValue(q("#promocion-nombre") as HTMLInputElement, "Auto");
    changeValue(q("#promocion-tipo") as HTMLSelectElement, "bogo");
    await act(async () => {
      click(q("#promocion-auto"));
    });
    await submitForm(q("#restaurantes-promocion-nueva") as HTMLFormElement);
    expect(post()).toBeUndefined();
    expect(document.body.textContent).toContain("necesita un canal");
  });

  it("combo de cortesia del martes: disparadores, aguas y piezas", async () => {
    stub();
    await abrir();
    changeValue(q("#promocion-codigo") as HTMLInputElement, "MARTESNACHOS");
    changeValue(q("#promocion-nombre") as HTMLInputElement, "Martes nachos");
    changeValue(q("#promocion-tipo") as HTMLSelectElement, "cortesia");
    changeValue(q("#promocion-canal") as HTMLSelectElement, "recoger");
    await act(async () => {
      click(q("#promocion-auto"));
      click(q('[data-testid="promocion-dia-2"]'));
      seleccionar(q("#promocion-productos") as HTMLSelectElement, ["nachos"]);
      seleccionar(q("#promocion-cortesia") as HTMLSelectElement, ["agua-1", "agua-2"]);
    });
    await submitForm(q("#restaurantes-promocion-nueva") as HTMLFormElement);
    expect(JSON.parse(post()![1].body as string)).toMatchObject({
      type: "cortesia",
      value: 1,
      autoApply: true,
      channels: ["recoger"],
      daysOfWeek: [2],
      productIds: ["nachos"],
      courtesyProductIds: ["agua-1", "agua-2"],
      courtesyQuantity: 2,
    });
  });

  it("cortesia sin listas no se envia", async () => {
    stub();
    await abrir();
    changeValue(q("#promocion-codigo") as HTMLInputElement, "CORTESIA");
    changeValue(q("#promocion-nombre") as HTMLInputElement, "Cortesia");
    changeValue(q("#promocion-tipo") as HTMLSelectElement, "cortesia");
    await submitForm(q("#restaurantes-promocion-nueva") as HTMLFormElement);
    expect(post()).toBeUndefined();
  });

  it("la lista muestra badges de automatica y canal", async () => {
    stub([{ id: "p", code: "LUNES2X1", name: "Lunes", description: null, type: "bogo", value: 1, minOrderTotal: null, startsAt: null, endsAt: null, daysOfWeek: [1], startTime: null, endTime: null, maxUses: null, timesUsed: 0, isActive: true, channels: ["recoger"], autoApply: true, createdAt: "", updatedAt: "" }]);
    rendered = renderComponent(
      <MemoryRouter>
        <PromocionesPage {...CTX} />
      </MemoryRouter>,
    );
    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });
    const t = rendered.container.textContent!;
    expect(t).toContain("Automática");
    expect(t).toContain("Solo recoger");
    expect(t).toContain("2x1");
  });
});
