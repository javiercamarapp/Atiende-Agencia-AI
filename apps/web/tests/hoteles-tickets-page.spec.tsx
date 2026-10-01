// @vitest-environment jsdom
//
// H-05 -- <TicketsPage /> (tickets de huesped con SLA): `fetch` global mockeado por ruta real contra
// apps/api/src/routes/verticals/hoteles/tickets.ts. Cubre carga/vacio/base sin migrar, creacion,
// acciones por rol (cerrar con nota, escalar), la creacion desde una resena y la politica de SLA.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TicketsPage } from "../src/verticals/hoteles/pages/Tickets.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import type { ResenaPendiente, SlaEfectiva, TicketResumen } from "../src/verticals/hoteles/lib/tickets-client.ts";
import { changeValue, click, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const jsonResponse = (body: unknown, ok = true): Response => ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response;
const ctx = (role: string): HotelesShellContext => ({ apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role, staffFullName: "Demo", staffEmail: "d@example.com" });
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function ticket(over: Partial<TicketResumen> = {}): TicketResumen {
  return {
    id: "t1", habitacion: "204", resenaId: null, departamento: "maintenance", prioridad: "alta", estado: "abierto", canal: "staff", mensaje: "El aire no enfria",
    slaMinutos: 30, slaVenceEn: "2026-03-10T10:30:00.000Z", estadoSla: "en_tiempo", minutosParaVencer: 20, asignadoA: null, escaladoEn: null, escaladoARoles: [],
    notaResolucion: null, creadoEn: "2026-03-10T10:00:00.000Z", ...over,
  };
}
const SLA: SlaEfectiva[] = [
  { departamento: "frontdesk", prioridad: "alta", minutos: 30, configurada: false },
  { departamento: "frontdesk", prioridad: "media", minutos: 120, configurada: true },
];
const RESENA: ResenaPendiente = { id: "rv1", fuente: "google", texto: "Cuarto sucio", calificacion: 1, sentimiento: "muy_negativo", temas: ["limpieza"], sugerencia: { departamento: "housekeeping", prioridad: "alta" } };

interface Mock { tickets?: TicketResumen[]; disponible?: boolean; resenas?: ResenaPendiente[] }
function stub(m: Mock = {}) {
  const posts: { url: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("/tickets/resenas-pendientes")) return jsonResponse({ disponible: true, resenas: m.resenas ?? [] });
    if (method === "GET" && url.endsWith("/tickets/sla")) return jsonResponse({ disponible: true, efectiva: SLA });
    if (method === "GET" && url.includes("/hoteles/prop-1/tickets")) return jsonResponse({ disponible: m.disponible ?? true, ahora: "2026-03-10T10:10:00.000Z", tickets: m.tickets ?? [] });
    if (method !== "GET") {
      posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return jsonResponse(ticket());
    }
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, posts };
}
const buttons = (label: string) => Array.from(rendered!.container.querySelectorAll("button")).filter((b) => b.textContent?.trim() === label) as HTMLButtonElement[];
const text = () => rendered!.container.textContent ?? "";

describe("TicketsPage", () => {
  it("muestra el ticket con prioridad, departamento y el estado de SLA", async () => {
    stub({ tickets: [ticket()] });
    rendered = renderComponent(<TicketsPage {...ctx("frontdesk")} />);
    await settle();
    expect(text()).toContain("El aire no enfria");
    expect(text()).toContain("Mantenimiento");
    expect(text()).toContain("En tiempo · vence en 20 min");
    expect(text()).toContain("1 activos · 0 con SLA vencido · 0 escalados");
  });

  it("un ticket con SLA vencido se marca y se cuenta; uno escalado aparece en la pestana Escalados con sus roles", async () => {
    stub({ tickets: [ticket({ estadoSla: "vencido", minutosParaVencer: -75, estado: "escalado", escaladoARoles: ["gm", "owner"] })] });
    rendered = renderComponent(<TicketsPage {...ctx("gm")} />);
    await settle();
    expect(text()).toContain("SLA vencido · venció hace 1 h 15 min");
    expect(text()).toContain("1 con SLA vencido");
    expect(text()).toContain("Escalado a Gerencia y Dirección");
    // un ticket ya escalado no ofrece "Escalar a gerencia" otra vez
    expect(buttons("Escalar a gerencia")).toHaveLength(0);
  });

  it("base sin migracion 034: avisa y no muestra formulario ni pestanas", async () => {
    stub({ disponible: false });
    rendered = renderComponent(<TicketsPage {...ctx("owner")} />);
    await settle();
    expect(text()).toContain("aún no están activos en esta base de datos");
    expect(buttons("Registrar ticket")).toHaveLength(0);
  });

  it("estado vacio honesto", async () => {
    stub({ tickets: [] });
    rendered = renderComponent(<TicketsPage {...ctx("frontdesk")} />);
    await settle();
    expect(text()).toContain("No hay tickets activos");
  });

  it("registrar un ticket manda el mensaje (y deja departamento/prioridad automaticos) y recarga", async () => {
    const { posts } = stub({ tickets: [] });
    rendered = renderComponent(<TicketsPage {...ctx("housekeeping")} />);
    await settle();
    const input = rendered.container.querySelector("input[placeholder^='Ej.']") as HTMLInputElement;
    changeValue(input, "  Faltan toallas  ");
    await submitForm(rendered.container.querySelector("form")!);
    await settle();
    expect(posts).toEqual([{ url: "https://api.test/hoteles/prop-1/tickets", body: { mensaje: "Faltan toallas" } }]);
    expect(text()).toContain("Ticket registrado.");
  });

  it("cerrar pide la nota y la manda; cancelar pide confirmacion", async () => {
    const { posts } = stub({ tickets: [ticket()] });
    vi.spyOn(window, "prompt").mockReturnValue("Se reparo el clima");
    vi.spyOn(window, "confirm").mockReturnValue(false);
    rendered = renderComponent(<TicketsPage {...ctx("frontdesk")} />);
    await settle();
    click(buttons("Cancelar")[0]!);
    await settle();
    expect(posts).toEqual([]); // el usuario no confirmo
    click(buttons("Cerrar")[0]!);
    await settle();
    expect(posts).toEqual([{ url: "https://api.test/hoteles/prop-1/tickets/t1/cerrar", body: { nota: "Se reparo el clima" } }]);
  });

  it("acciones por rol: un departamento ajeno no ve botones; manager ve escalar", async () => {
    stub({ tickets: [ticket()] });
    rendered = renderComponent(<TicketsPage {...ctx("fnb")} />);
    await settle();
    expect(buttons("Tomar")).toHaveLength(0);
    expect(buttons("Cerrar")).toHaveLength(0);
    rendered.unmount();
    stub({ tickets: [ticket()] });
    rendered = renderComponent(<TicketsPage {...ctx("gm")} />);
    await settle();
    expect(buttons("Escalar a gerencia")).toHaveLength(1);
  });

  it("reseñas con queja: lista, sugerencia y crear ticket desde la reseña (solo roles con permiso)", async () => {
    const { posts } = stub({ tickets: [], resenas: [RESENA] });
    rendered = renderComponent(<TicketsPage {...ctx("frontdesk")} />);
    await settle();
    const tab = Array.from(rendered.container.querySelectorAll("button, [role=tab]")).find((b) => b.textContent === "Reseñas con queja")!;
    await act(async () => {
      tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      (tab as HTMLElement).click();
    });
    await settle();
    expect(text()).toContain("Cuarto sucio");
    expect(text()).toContain("Se enviará a Housekeeping con prioridad alta.");
    click(buttons("Crear ticket")[0]!);
    await settle();
    expect(posts).toEqual([{ url: "https://api.test/hoteles/prop-1/tickets/desde-resena", body: { resenaId: "rv1" } }]);
  });

  it("la pestana de resenas no existe para housekeeping", async () => {
    stub({ tickets: [] });
    rendered = renderComponent(<TicketsPage {...ctx("housekeeping")} />);
    await settle();
    expect(Array.from(rendered.container.querySelectorAll("button, [role=tab]")).some((b) => b.textContent === "Reseñas con queja")).toBe(false);
  });
});
