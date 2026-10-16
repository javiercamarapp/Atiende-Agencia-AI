// @vitest-environment jsdom
//
// H-03 -- <AgentesPage /> y <AprobacionesAgentesPage />: `fetch` global mockeado por ruta real contra
// apps/api/src/routes/verticals/hoteles/agentes.ts. Cubre carga, base sin migrar, roles, kill switch con motivo,
// presupuesto, y la decision de aprobaciones con motivo (DS v2: DataTable + useConfirm, nunca window.prompt).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock, Toaster: () => null }));

import { AgentesPage } from "../src/verticals/hoteles/pages/Agentes.tsx";
import { AprobacionesAgentesPage } from "../src/verticals/hoteles/pages/Aprobaciones.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import type { AgenteCatalogo, Aprobacion } from "../src/verticals/hoteles/lib/agentes-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  toastMock.success.mockClear();
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const jsonResponse = (body: unknown, ok = true, status = ok ? 200 : 500): Response => ({ ok, status, json: async () => body }) as unknown as Response;
const ctx = (role: string): HotelesShellContext => ({ apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role, staffFullName: "Demo", staffEmail: "d@example.com" });
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
const text = () => rendered!.container.textContent ?? "";
const buttons = (label: string) => Array.from(rendered!.container.querySelectorAll("button")).filter((b) => b.textContent?.trim() === label) as HTMLButtonElement[];
const dialogo = () => document.body.querySelector('[role="alertdialog"], [role="dialog"]') as HTMLElement | null;
async function pulsarEnDialogo(label: string) {
  const b = [...dialogo()!.querySelectorAll("button")].find((x) => x.textContent?.trim() === label)!;
  await act(async () => {
    b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

function agente(over: Partial<AgenteCatalogo> = {}): AgenteCatalogo {
  return {
    clave: "recepcion_whatsapp", nombre: "Recepcion (WhatsApp)", descripcion: "Atiende al huesped por WhatsApp.", gobernado: true, activo: true, estado: "activo",
    motivoPausa: null, pausadoEn: null, presupuestoUsd: 20, gastoUsd: 5, porcentajeUso: 25, llamadas: 12, tokensEntrada: 1000, tokensSalida: 200, ...over,
  };
}
function aprobacion(over: Partial<Aprobacion> = {}): Aprobacion {
  return {
    id: "a1", agente: "revenue", accion: "descuento_tarifa", resumen: "Descuento fin de semana", detalle: {}, montoCentavos: null, porcentaje: 10, destinatarios: null, contenido: null,
    estado: "pendiente", propuestaPor: null, propuestaPorAgente: true, autoaprobada: false, motivoBloqueo: null, expiraEn: "2026-06-02T12:00:00.000Z", decididaPor: null, decididaEn: null,
    motivoDecision: null, ejecutadaEn: null, referenciaEjecucion: null, creadaEn: "2026-06-01T12:00:00.000Z", ...over,
  };
}

interface Mock { agentes?: AgenteCatalogo[]; disponible?: boolean; aprobaciones?: Aprobacion[] }
function stub(m: Mock = {}) {
  const writes: { method: string; url: string; body: unknown }[] = [];
  const disponible = m.disponible ?? true;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return jsonResponse(url.includes("/agentes/") && !url.includes("plantillas") && !url.includes("politicas") && !url.includes("guardrails") ? { disponible: true, mes: "2026-06", agentes: m.agentes ?? [], agente: agente() } : aprobacion({ estado: "aprobada" }));
    }
    if (url.endsWith("/agentes")) return jsonResponse({ disponible, mes: "2026-06", agentes: m.agentes ?? [agente()] });
    if (url.endsWith("/agentes/guardrails")) return jsonResponse({ disponible, configurados: false, maxDescuentoPct: 30, maxReembolsoCentavos: 500000, maxCargoFolioCentavos: 500000, maxDestinatariosMasivo: 200, palabrasBloqueadas: ["gratis"], ventanaEnvioInicio: "08:00", ventanaEnvioFin: "21:00" });
    if (url.endsWith("/agentes/politicas")) return jsonResponse({ disponible, politicas: [{ accion: "reembolso", modo: "siempre_humano", configurada: false, umbralPorcentaje: null, umbralMontoCentavos: null, vigenciaMinutos: 1440, aprobadores: ["owner", "gm"] }], accionesAutomatizables: ["reembolso"] });
    if (url.endsWith("/agentes/plantillas")) return jsonResponse({ disponible, plantillas: [] });
    if (url.includes("/aprobaciones/a1")) return jsonResponse({ ...aprobacion(), bitacora: [{ id: "e1", tipo: "propuesta", actorId: null, sistema: true, detalle: {}, creadoEn: "2026-06-01T12:00:00.000Z" }], bitacoraVisible: true });
    if (url.includes("/aprobaciones")) return jsonResponse({ disponible, ahora: "2026-06-01T12:10:00.000Z", aprobaciones: m.aprobaciones ?? [] });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { writes };
}

describe("AgentesPage", () => {
  it("muestra el catalogo con estado, presupuesto y costo acumulado", async () => {
    stub();
    rendered = renderComponent(<AgentesPage {...ctx("frontdesk")} />);
    await settle();
    expect(text()).toContain("Recepcion (WhatsApp)");
    expect(text()).toContain("Activo");
    expect(text()).toContain("US$ 20.00");
    expect(text()).toContain("US$ 5.0000 (25 %)");
    // frontdesk lee pero no administra: ningun boton de pausa/presupuesto
    expect(buttons("Pausar")).toHaveLength(0);
    expect(buttons("Presupuesto")).toHaveLength(0);
  });

  it("un agente sin proceso que consulte su interruptor lo avisa (no promete un apagado que no apaga)", async () => {
    stub({ agentes: [agente({ clave: "reputacion", nombre: "Reputacion", gobernado: false })] });
    rendered = renderComponent(<AgentesPage {...ctx("owner")} />);
    await settle();
    expect(text()).toContain("Aún sin proceso que consulte su interruptor o presupuesto");
  });

  it("kill switch: pausar pide el motivo en un dialogo y lo manda; sin motivo no se envia", async () => {
    const { writes } = stub();
    rendered = renderComponent(<AgentesPage {...ctx("gm")} />);
    await settle();
    click(buttons("Pausar")[0]!);
    await settle();
    expect(dialogo()).not.toBeNull();
    const area = dialogo()!.querySelector("textarea")!;
    changeValue(area, "abc");
    await pulsarEnDialogo("Pausar");
    expect(writes).toHaveLength(0); // motivo de menos de 5 caracteres: el dialogo no deja continuar
    changeValue(dialogo()!.querySelector("textarea")!, "Revision de costos del mes");
    await pulsarEnDialogo("Pausar");
    await settle();
    expect(writes).toEqual([{ method: "PUT", url: "https://api.test/hoteles/prop-1/agentes/recepcion_whatsapp", body: { activo: false, motivo: "Revision de costos del mes" } }]);
  });

  it("agente pausado: se ofrece Reanudar (sin pedir motivo)", async () => {
    const { writes } = stub({ agentes: [agente({ activo: false, estado: "pausado", motivoPausa: "Auditoria" })] });
    rendered = renderComponent(<AgentesPage {...ctx("owner")} />);
    await settle();
    expect(text()).toContain("Pausado");
    expect(text()).toContain("Auditoria");
    click(buttons("Reanudar")[0]!);
    await settle();
    expect(writes).toEqual([{ method: "PUT", url: "https://api.test/hoteles/prop-1/agentes/recepcion_whatsapp", body: { activo: true } }]);
  });

  it("base sin la migracion 035: avisa y no muestra pestanas", async () => {
    stub({ disponible: false, agentes: [] });
    rendered = renderComponent(<AgentesPage {...ctx("owner")} />);
    await settle();
    expect(text()).toContain("Aún no activo en esta base de datos");
    expect(buttons("Guardrails")).toHaveLength(0);
  });
});

describe("AgentesPage -- dialogos de politica y plantilla", () => {
  const abrirTab = async (nombre: string) => {
    const tab = Array.from(rendered!.container.querySelectorAll("button, [role=tab]")).find((b) => b.textContent === nombre)!;
    await act(async () => {
      tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await settle();
  };

  it("editar una politica abre un dialogo; Cancelar no escribe y Guardar manda PUT con la vigencia", async () => {
    const { writes } = stub();
    rendered = renderComponent(<AgentesPage {...ctx("owner")} />);
    await settle();
    await abrirTab("Políticas");
    click(buttons("Editar")[0]!);
    await settle();
    expect(dialogo()!.textContent).toContain("Política: ");
    const cerrar = dialogo()!.querySelector('button[aria-label="Cerrar"]') as HTMLButtonElement;
    click(cerrar);
    await settle();
    expect(dialogo()).toBeNull();
    expect(writes).toHaveLength(0);

    click(buttons("Editar")[0]!);
    await settle();
    changeValue(dialogo()!.querySelector('input[type="number"]') as HTMLInputElement, "720");
    await act(async () => {
      dialogo()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    await settle();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "PUT", body: { modo: "siempre_humano", vigenciaMinutos: 720 } });
    expect(toastMock.success).toHaveBeenCalledWith("Política guardada.", expect.anything());
  });

  it("nueva plantilla: el dialogo manda POST con nombre y texto recortados", async () => {
    const { writes } = stub();
    rendered = renderComponent(<AgentesPage {...ctx("gm")} />);
    await settle();
    await abrirTab("Plantillas WhatsApp");
    click(buttons("Nueva plantilla")[0]!);
    await settle();
    changeValue(dialogo()!.querySelector("input")!, "bienvenida_huesped");
    changeValue(dialogo()!.querySelector("textarea")!, "  Hola, bienvenido  ");
    await act(async () => {
      dialogo()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    await settle();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "POST", body: { agente: "recepcion_whatsapp", nombre: "bienvenida_huesped", cuerpo: "Hola, bienvenido" } });
    expect(dialogo()).toBeNull();
  });
});

describe("AprobacionesAgentesPage", () => {
  it("lista lo pendiente con origen, alcance y vigencia; un bloqueado muestra su motivo", async () => {
    stub({ aprobaciones: [aprobacion(), aprobacion({ id: "a2", estado: "bloqueada", motivoBloqueo: "tope_descuento", porcentaje: 50 })] });
    rendered = renderComponent(<AprobacionesAgentesPage {...ctx("gm")} />);
    await settle();
    expect(text()).toContain("Descuento o cambio de tarifa");
    expect(text()).toContain("10 % de descuento");
    expect(text()).toContain("Agente: revenue");
    expect(text()).toContain("23 h 50 min");
    expect(text()).toContain("Excede el tope de descuento");
    expect(text()).toContain("1 pendientes");
  });

  it("aprobar pide el motivo en un dialogo (nunca window.prompt) y lo manda; el boton exige 5+ caracteres", async () => {
    const prompt = vi.spyOn(window, "prompt");
    const { writes } = stub({ aprobaciones: [aprobacion()] });
    rendered = renderComponent(<AprobacionesAgentesPage {...ctx("gm")} />);
    await settle();
    click(buttons("Aprobar")[0]!);
    await settle();
    changeValue(dialogo()!.querySelector("textarea")!, "no");
    await pulsarEnDialogo("Aprobar");
    expect(writes).toHaveLength(0);
    changeValue(dialogo()!.querySelector("textarea")!, "Ocupacion baja el fin de semana");
    await pulsarEnDialogo("Aprobar");
    await settle();
    expect(writes).toEqual([{ method: "POST", url: "https://api.test/hoteles/prop-1/aprobaciones/a1/aprobar", body: { motivo: "Ocupacion baja el fin de semana" } }]);
    expect(prompt).not.toHaveBeenCalled();
    expect(toastMock.success).toHaveBeenCalledWith("Solicitud aprobada.", expect.anything());
  });

  it("rechazar tambien exige motivo; un rol sin acceso de aprobador (housekeeping) no ve botones", async () => {
    const { writes } = stub({ aprobaciones: [aprobacion()] });
    rendered = renderComponent(<AprobacionesAgentesPage {...ctx("housekeeping")} />);
    await settle();
    expect(buttons("Aprobar")).toHaveLength(0);
    expect(buttons("Rechazar")).toHaveLength(0);
    rendered.unmount();
    rendered = renderComponent(<AprobacionesAgentesPage {...ctx("owner")} />);
    await settle();
    click(buttons("Rechazar")[0]!);
    await settle();
    changeValue(dialogo()!.querySelector("textarea")!, "Rompe la paridad con Booking");
    await pulsarEnDialogo("Rechazar");
    await settle();
    expect(writes).toEqual([{ method: "POST", url: "https://api.test/hoteles/prop-1/aprobaciones/a1/rechazar", body: { motivo: "Rompe la paridad con Booking" } }]);
  });

  it("una aprobada ofrece Ejecutar solo a owner/gm y pide la referencia; una respuesta a resena solo pide confirmar", async () => {
    const { writes } = stub({ aprobaciones: [aprobacion({ estado: "aprobada" }), aprobacion({ id: "a3", estado: "aprobada", accion: "respuesta_resena", porcentaje: null, contenido: "Gracias" })] });
    rendered = renderComponent(<AprobacionesAgentesPage {...ctx("frontdesk")} />);
    await settle();
    expect(buttons("Ejecutar")).toHaveLength(0);
    rendered.unmount();
    rendered = renderComponent(<AprobacionesAgentesPage {...ctx("owner")} />);
    await settle();
    expect(buttons("Ejecutar")).toHaveLength(2);
    click(buttons("Ejecutar")[0]!);
    await settle();
    changeValue(dialogo()!.querySelector("input, textarea") as HTMLInputElement, "tarifa-123");
    await pulsarEnDialogo("Marcar ejecutada");
    await settle();
    expect(writes).toEqual([{ method: "POST", url: "https://api.test/hoteles/prop-1/aprobaciones/a1/ejecutar", body: { referencia: "tarifa-123" } }]);
    click(buttons("Ejecutar")[1]!);
    await settle();
    await pulsarEnDialogo("Ejecutar");
    await settle();
    expect(writes[1]).toEqual({ method: "POST", url: "https://api.test/hoteles/prop-1/aprobaciones/a3/ejecutar", body: {} });
  });

  it("la bitacora se abre desde la fila", async () => {
    stub({ aprobaciones: [aprobacion()] });
    rendered = renderComponent(<AprobacionesAgentesPage {...ctx("owner")} />);
    await settle();
    click(buttons("Bitácora")[0]!);
    await settle();
    expect(text()).toContain("propuesta");
    expect(text()).toContain("(sistema)");
  });

  it("estado vacio honesto y base sin la migracion 035", async () => {
    stub({ aprobaciones: [] });
    rendered = renderComponent(<AprobacionesAgentesPage {...ctx("owner")} />);
    await settle();
    expect(text()).toContain("No hay solicitudes por decidir");
    rendered.unmount();
    stub({ disponible: false });
    rendered = renderComponent(<AprobacionesAgentesPage {...ctx("owner")} />);
    await settle();
    expect(text()).toContain("aún no están activas en esta base de datos");
    expect(text()).toContain("el agente no ejecuta acciones sensibles por su cuenta");
  });

  it("Volver (o Escape) en el dialogo de ejecutar o aprobar NUNCA escribe", async () => {
    const { writes } = stub({ aprobaciones: [aprobacion({ estado: "aprobada" }), aprobacion({ id: "a4", accion: "respuesta_resena", porcentaje: null, contenido: "Gracias" })] });
    rendered = renderComponent(<AprobacionesAgentesPage {...ctx("owner")} />);
    await settle();
    click(buttons("Ejecutar")[0]!);
    await settle();
    await pulsarEnDialogo("Volver");
    expect(dialogo()).toBeNull();
    click(buttons("Aprobar")[0]!);
    await settle();
    await act(async () => {
      dialogo()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await flushMicrotasks();
    });
    await settle();
    expect(writes).toHaveLength(0);
  });

  it("nueva solicitud: manda la llave de idempotencia y avisa que la decide otra persona", async () => {
    const { writes } = stub({ aprobaciones: [] });
    rendered = renderComponent(<AprobacionesAgentesPage {...ctx("frontdesk")} />);
    await settle();
    click(buttons("Nueva solicitud")[0]!);
    await settle();
    const inputs = Array.from(dialogo()!.querySelectorAll("input")) as HTMLInputElement[];
    changeValue(inputs.find((i) => i.type === "number")!, "12");
    changeValue(inputs.find((i) => i.placeholder.startsWith("Ej."))!, "Descuento por baja ocupacion");
    await act(async () => {
      dialogo()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    await settle();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "POST", url: "https://api.test/hoteles/prop-1/aprobaciones", body: { accion: "descuento_tarifa", resumen: "Descuento por baja ocupacion", porcentaje: 12 } });
    expect((writes[0]!.body as { llaveIdempotencia: string }).llaveIdempotencia.length).toBeGreaterThanOrEqual(8);
    expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining("otra persona con rol de aprobador debe decidirla"), expect.anything());
    expect(dialogo()).toBeNull();
  });
});
