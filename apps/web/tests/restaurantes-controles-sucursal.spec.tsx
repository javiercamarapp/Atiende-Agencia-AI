// @vitest-environment jsdom
//
// Interruptores de voz y WhatsApp + «Copiar ID» de la lista de Sucursales (paridad con el repo suelto), contra los endpoints reales:
// WhatsApp = PUT .../config/sucursales/:id/agente-whatsapp; voz = PUT .../voz/config (config completa con `habilitado` nuevo).
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ControlesSucursal } from "../src/verticals/restaurantes/components/ControlesSucursal.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

beforeAll(prepararJsdomParaRadix);

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const ORG = "org-1";
const BRANCH = "br-1";
const WA = `https://api.test/v1/restaurantes/${ORG}/admin/config/sucursales/${BRANCH}/agente-whatsapp`;
const VOZ = `https://api.test/v1/restaurantes/${BRANCH}/admin/voz/config`;
type Llamada = { method: string; url: string; body?: unknown };

function stub(calls: Llamada[], opciones: { vozConfigurada?: boolean; fallaWhatsapp?: boolean; fallaVoz?: boolean; editarVozAntesDelPut?: boolean } = {}) {
  let waActivo = true;
  let voz = { disponible: true, configurada: opciones.vozConfigurada !== false, habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "Atiende con calidez", mensajeInicial: "Hola", mensajeInicialInterrumpible: true };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url === WA && method === "GET") return json({ disponible: true, agenteActivo: waActivo });
      if (url === WA && method === "PUT") {
        if (opciones.fallaWhatsapp) return json({ message: "No se pudo guardar" }, 500);
        waActivo = (JSON.parse(init!.body as string) as { activo: boolean }).activo;
        return json({ disponible: true, agenteActivo: waActivo });
      }
      if (url === VOZ && method === "GET") {
        const r = json(voz);
        // Otra persona edita el comportamiento despues de la primera lectura (la de la carga de la lista).
        if (opciones.editarVozAntesDelPut && calls.filter((c) => c.url === VOZ && c.method === "GET").length === 1) voz = { ...voz, comportamiento: "Editado por otra persona" };
        return r;
      }
      if (url === VOZ && method === "PUT") {
        if (opciones.fallaVoz) return json({ message: "No se pudo guardar la voz" }, 500);
        const cuerpo = JSON.parse(init!.body as string) as Record<string, unknown>;
        // Esquema estricto como el servidor (parseConfig): exactamente estos campos editables; cualquier otro (p. ej. los de solo lectura disponible/configurada) es 400.
        const permitidos = ["habilitado", "proveedor", "voiceId", "comportamiento", "mensajeInicial", "mensajeInicialInterrumpible"];
        const extra = Object.keys(cuerpo).filter((k) => !permitidos.includes(k));
        const faltan = permitidos.filter((k) => !(k in cuerpo));
        if (extra.length > 0 || faltan.length > 0 || typeof cuerpo.habilitado !== "boolean" || typeof cuerpo.mensajeInicialInterrumpible !== "boolean") {
          return json({ message: `cuerpo invalido (extra: ${extra.join(",")}; faltan: ${faltan.join(",")})` }, 400);
        }
        voz = { ...voz, ...cuerpo } as typeof voz;
        return json(voz);
      }
      throw new Error(`fetch inesperado: ${method} ${url}`);
    }),
  );
}

const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
};
const interruptor = (nombre: RegExp) => [...rendered!.container.querySelectorAll<HTMLElement>('[role="switch"]')].find((e) => nombre.test(e.getAttribute("aria-label") ?? ""))!;
const render = (puedeCambiar = true) =>
  renderComponent(<ControlesSucursal apiBaseUrl="https://api.test" token="tok" propertyId={ORG} branchId={BRANCH} branchName="Centro" puedeCambiar={puedeCambiar} />);
async function pulsarEnDialogo(texto: string) {
  const b = [...document.body.querySelectorAll('[role="alertdialog"] button')].find((x) => x.textContent?.trim() === texto)!;
  await act(async () => {
    b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}

describe("controles de sucursal (voz, WhatsApp, copiar ID)", () => {
  it("owner/admin: lee el estado real y apagar WhatsApp pide confirmacion y manda PUT activo:false", async () => {
    const calls: Llamada[] = [];
    stub(calls);
    rendered = render();
    await settle();
    expect(interruptor(/WhatsApp/).getAttribute("aria-checked")).toBe("true");
    expect(interruptor(/voz/).getAttribute("aria-checked")).toBe("true");
    click(interruptor(/WhatsApp/));
    await settle();
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0); // sin confirmar no se manda nada
    await pulsarEnDialogo("Volver");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    click(interruptor(/WhatsApp/));
    await settle();
    await pulsarEnDialogo("Apagar agente");
    expect(calls.filter((c) => c.method === "PUT")).toEqual([{ method: "PUT", url: WA, body: { activo: false } }]);
    expect(interruptor(/WhatsApp/).getAttribute("aria-checked")).toBe("false");
  });

  it("apagar voz reenvia la configuracion COMPLETA con habilitado:false (el PUT reemplaza todo)", async () => {
    const calls: Llamada[] = [];
    stub(calls);
    rendered = render();
    await settle();
    click(interruptor(/voz/));
    await settle();
    await pulsarEnDialogo("Apagar agente");
    const put = calls.find((c) => c.method === "PUT" && c.url === VOZ)!;
    expect(put.body).toMatchObject({ habilitado: false, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "Atiende con calidez", mensajeInicial: "Hola" });
    expect(interruptor(/voz/).getAttribute("aria-checked")).toBe("false");
    expect(Object.keys(put.body as object).sort()).toEqual(["comportamiento", "habilitado", "mensajeInicial", "mensajeInicialInterrumpible", "proveedor", "voiceId"]);
  });

  it("apagar voz relee la config justo antes del PUT: no pisa una edicion ajena (lost-update)", async () => {
    const calls: Llamada[] = [];
    stub(calls, { editarVozAntesDelPut: true });
    rendered = render();
    await settle();
    click(interruptor(/voz/));
    await settle();
    await pulsarEnDialogo("Apagar agente");
    const idxPut = calls.findIndex((c) => c.method === "PUT" && c.url === VOZ);
    expect(calls.slice(0, idxPut).filter((c) => c.method === "GET" && c.url === VOZ)).toHaveLength(2); // carga + relectura
    expect((calls[idxPut]!.body as { comportamiento: string }).comportamiento).toBe("Editado por otra persona");
  });

  it("un fallo del servidor al apagar voz deja el interruptor encendido y avisa", async () => {
    const calls: Llamada[] = [];
    stub(calls, { fallaVoz: true });
    rendered = render();
    await settle();
    click(interruptor(/voz/));
    await settle();
    await pulsarEnDialogo("Apagar agente");
    expect(calls.some((c) => c.method === "PUT" && c.url === VOZ)).toBe(true);
    expect(interruptor(/voz/).getAttribute("aria-checked")).toBe("true");
    expect(interruptor(/voz/).hasAttribute("disabled")).toBe(false); // se libera tras el error
  });

  it("los estados de error se anuncian con role=status", async () => {
    const calls: Llamada[] = [];
    stub(calls, { vozConfigurada: false });
    rendered = render();
    await settle();
    const sinConfig = [...rendered.container.querySelectorAll('[role="status"]')].find((e) => e.textContent === "Sin configurar");
    expect(sinConfig).toBeTruthy();
  });

  it("encender no pide confirmacion; voz sin configurar queda deshabilitada y lo dice", async () => {
    const calls: Llamada[] = [];
    stub(calls, { vozConfigurada: false });
    rendered = render();
    await settle();
    expect(interruptor(/voz/).hasAttribute("disabled")).toBe(true);
    expect(rendered.container.textContent).toContain("Sin configurar");
  });

  it("un fallo del servidor al cambiar WhatsApp deja el interruptor como estaba", async () => {
    const calls: Llamada[] = [];
    stub(calls, { fallaWhatsapp: true });
    rendered = render();
    await settle();
    click(interruptor(/WhatsApp/));
    await settle();
    await pulsarEnDialogo("Apagar agente");
    expect(interruptor(/WhatsApp/).getAttribute("aria-checked")).toBe("true");
  });

  it("sin permiso (staff): no pide nada al servidor, no hay interruptores y solo queda «Copiar ID»", async () => {
    const calls: Llamada[] = [];
    stub(calls);
    rendered = render(false);
    await settle();
    expect(calls).toHaveLength(0);
    expect(rendered.container.querySelectorAll('[role="switch"]')).toHaveLength(0);
    const copiar = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Copiar ID"))!;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    click(copiar);
    await settle();
    expect(writeText).toHaveBeenCalledWith(BRANCH);
  });
});
