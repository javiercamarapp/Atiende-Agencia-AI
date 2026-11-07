// @vitest-environment jsdom
//
// QA R1 citas (api-caos): comportamiento de <AgendaPage /> ante carreras de respuestas, errores, reintentos de alta, borrador entre sucursales, zona
// horaria del negocio y rotulos. Ids: QA-citas-R1-caos-03/06/07/08, QA-citas-R1-viaje-16/17/19 y el truncamiento de caos-04. `fetch` global mockeado por ruta.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgendaPage } from "../src/verticals/citas/pages/Agenda.tsx";
import type { CitasShellContext } from "../src/verticals/citas/CitasShell.tsx";
import { fetchAllAppointments, MAX_AGENDA_PAGES } from "../src/verticals/citas/lib/appointments-client.ts";
import { formatTimeRange, wallTimeToIso, zonedDayKey } from "../src/verticals/citas/lib/format.ts";
import { changeValue, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
const TZ_PREVIA = process.env.TZ;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (TZ_PREVIA === undefined) delete process.env.TZ;
  else process.env.TZ = TZ_PREVIA;
});

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const CTX: CitasShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", orgId: "org-1", role: "owner", staffFullName: "Staff", staffEmail: "s@example.com" };

const cita = (id: string, startsAt = "2027-09-13T16:00:00.000Z") => ({
  id,
  property_id: "prop-1",
  provider_id: "prov-1",
  service_id: "svc-1",
  customer_id: "c-1",
  starts_at: startsAt,
  ends_at: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(),
  status: "confirmed",
  source: "web",
  notes: null,
  provider_name: "Dra. López",
  service_name: "Consulta",
  customer_name: `Paciente ${id}`,
  customer_phone: "5522223333",
});

const PROVIDER = { id: "prov-1", propertyId: "prop-1", displayName: "Dra. López", roleLabel: "Doctora", isActive: true };
const SERVICE = { id: "svc-1", name: "Consulta", durationMinutes: 30, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents: 50000, isActive: true };

type Handler = (url: string, init?: RequestInit) => Promise<Response> | Response;

/** fetch por ruta: lo que no es la lista de citas responde vacio; la lista de citas la decide `citas`. */
function stubFetch(citas: Handler, extra: Handler = () => jsonResponse({}, 404)) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("/providers")) return jsonResponse({ providers: [PROVIDER] });
    if (method === "GET" && url.includes("/services")) return jsonResponse({ services: [SERVICE] });
    if (method === "GET" && /\/waitlist(\?|$)/.test(url)) return jsonResponse({ waitlist: [] });
    if (method === "GET" && url.includes("/appointments?")) return citas(url, init);
    return extra(url, init);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function esperar(n = 4): Promise<void> {
  await act(async () => {
    for (let i = 0; i < n; i++) await flushMicrotasks();
  });
}

const boton = (texto: string): HTMLButtonElement => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim().includes(texto))! as HTMLButtonElement;

async function pulsar(texto: string): Promise<void> {
  const b = boton(texto);
  await act(async () => {
    b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("QA R1 caos citas -- Agenda: carreras y errores al cambiar de mes", () => {
  it("QA-citas-R1-caos-06: una respuesta LENTA del mes anterior no pisa el mes actual", async () => {
    let liberarLento!: (r: Response) => void;
    let llamadas = 0;
    stubFetch(() => {
      llamadas += 1;
      if (llamadas === 1) return new Promise<Response>((r) => (liberarLento = r)); // mes actual: tarda
      return jsonResponse({ appointments: [], truncated: false, next_from: null, timezone: "America/Merida" }); // mes siguiente: vacio al instante
    });
    rendered = renderComponent(<AgendaPage {...CTX} />);
    await esperar();
    await pulsar("Siguiente");
    await esperar();
    expect(rendered.container.textContent).toContain("No hay citas en este rango");
    // llega tarde la respuesta del mes anterior
    await act(async () => {
      liberarLento(jsonResponse({ appointments: [cita("viejo")], truncated: false, next_from: null, timezone: "America/Merida" }));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(rendered.container.textContent).not.toContain("Paciente viejo");
    expect(rendered.container.textContent).toContain("No hay citas en este rango");
  });

  it("QA-citas-R1-caos-07: si falla el mes siguiente se muestra el error SIN las citas del mes anterior y con Reintentar que funciona", async () => {
    let falla = false;
    stubFetch(() => (falla ? jsonResponse({ message: "Falla inyectada 503" }, 503) : jsonResponse({ appointments: [cita("a1")], truncated: false, next_from: null, timezone: "America/Merida" })));
    rendered = renderComponent(<AgendaPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Paciente a1");
    falla = true;
    await pulsar("Siguiente");
    await esperar();
    expect(rendered.container.textContent).toContain("Falla inyectada 503");
    expect(rendered.container.textContent).not.toContain("Paciente a1");
    falla = false;
    await pulsar("Reintentar");
    await esperar();
    expect(rendered.container.textContent).not.toContain("Falla inyectada 503");
    expect(rendered.container.textContent).toContain("Paciente a1");
  });
});

describe("QA R1 caos citas -- truncamiento (caos-04)", () => {
  it("fetchAllAppointments sigue next_from hasta traer todo el mes, sin duplicados", async () => {
    const paginas = [
      { appointments: [cita("a", "2027-09-01T15:00:00.000Z"), cita("b", "2027-09-02T15:00:00.000Z")], truncated: true, next_from: "2027-09-03T15:00:00.000Z", timezone: "America/Merida" },
      { appointments: [cita("c", "2027-09-03T15:00:00.000Z"), cita("d", "2027-09-04T15:00:00.000Z")], truncated: false, next_from: null, timezone: "America/Merida" },
    ];
    const desdes: string[] = [];
    const f = (async (url: string) => {
      desdes.push(new URL(url).searchParams.get("from")!);
      return jsonResponse(paginas[desdes.length - 1]);
    }) as unknown as typeof fetch;
    const r = await fetchAllAppointments(f, "https://api.test", "tok", "prop-1", { fromIso: "2027-09-01T00:00:00.000Z", toIso: "2027-10-01T00:00:00.000Z" });
    expect(r.appointments.map((a) => a.id)).toEqual(["a", "b", "c", "d"]);
    expect(desdes).toEqual(["2027-09-01T00:00:00.000Z", "2027-09-03T15:00:00.000Z"]);
    expect(r).toMatchObject({ incomplete: false, timezone: "America/Merida" });
  });

  it("un servidor que repite siempre la misma pagina truncada no deja un bucle: se corta y se avisa que la lista esta incompleta", async () => {
    let n = 0;
    const f = (async () => {
      n += 1;
      return jsonResponse({ appointments: [cita("a")], truncated: true, next_from: "2027-09-03T15:00:00.000Z", timezone: null });
    }) as unknown as typeof fetch;
    const r = await fetchAllAppointments(f, "https://api.test", "tok", "prop-1", { fromIso: "2027-09-01T00:00:00.000Z", toIso: "2027-10-01T00:00:00.000Z" });
    expect(n).toBeLessThanOrEqual(MAX_AGENDA_PAGES);
    expect(r.incomplete).toBe(true);
  });
});

describe("QA R1 caos citas -- alta manual (caos-03 y caos-08)", () => {
  async function abrirYLlenar(): Promise<HTMLFormElement> {
    await pulsar("Nueva cita");
    const d = document.body;
    changeValue(d.querySelector("#citas-nueva-proveedor") as HTMLSelectElement, "prov-1");
    changeValue(d.querySelector("#citas-nueva-servicio") as HTMLSelectElement, "svc-1");
    changeValue(d.querySelector("#citas-nueva-inicio") as HTMLInputElement, "2027-09-13T10:00");
    changeValue(d.querySelector("#citas-nueva-cliente") as HTMLInputElement, "Pedro Sánchez");
    changeValue(d.querySelector("#citas-nueva-telefono") as HTMLInputElement, "5533334444");
    return d.querySelector("#citas-nueva-cita") as HTMLFormElement;
  }

  it("QA-citas-R1-caos-03 (cliente): el reintento tras perder la respuesta manda la MISMA idempotency_key; una edicion la renueva", async () => {
    let intentos = 0;
    const f = stubFetch(
      () => jsonResponse({ appointments: [], truncated: false, next_from: null, timezone: "America/Merida" }),
      (url, init) => {
        if ((init?.method ?? "GET") === "POST" && /\/appointments$/.test(url)) {
          intentos += 1;
          if (intentos === 1) throw new TypeError("network error"); // la respuesta se perdio
          return jsonResponse({ appointment: cita("nueva") }, 201);
        }
        return jsonResponse({}, 404);
      },
    );
    rendered = renderComponent(<AgendaPage {...CTX} />);
    await esperar();
    const form = await abrirYLlenar();
    await submitForm(form);
    await esperar();
    await submitForm(form); // el staff vuelve a pulsar "Crear cita"
    await esperar();
    const posts = f.mock.calls.filter(([url, init]) => /\/appointments$/.test(url) && init?.method === "POST").map(([, init]) => JSON.parse(init!.body as string) as { idempotency_key?: string });
    expect(posts).toHaveLength(2);
    expect(posts[0]!.idempotency_key).toBeTruthy();
    expect(posts[1]!.idempotency_key).toBe(posts[0]!.idempotency_key);
  });

  it("QA-citas-R1-caos-08: cambiar de sucursal (la pagina se remonta) conserva el borrador de la cita a medio llenar", async () => {
    stubFetch(() => jsonResponse({ appointments: [], truncated: false, next_from: null, timezone: "America/Merida" }));
    rendered = renderComponent(<AgendaPage {...CTX} />);
    await esperar();
    await pulsar("Nueva cita");
    changeValue(document.body.querySelector("#citas-nueva-cliente") as HTMLInputElement, "Borrador Ana");
    changeValue(document.body.querySelector("#citas-nueva-telefono") as HTMLInputElement, "5599998888");
    rendered.unmount();
    rendered = undefined;
    // CitasShell usa contentKey={propertyId}: otra sucursal monta una pagina nueva.
    rendered = renderComponent(<AgendaPage {...CTX} propertyId="prop-2" />);
    await esperar();
    await pulsar("Nueva cita");
    expect((document.body.querySelector("#citas-nueva-cliente") as HTMLInputElement).value).toBe("Borrador Ana");
    expect((document.body.querySelector("#citas-nueva-telefono") as HTMLInputElement).value).toBe("5599998888");
  });

  it("el borrador es de UNA organizacion: otra organizacion en la misma pestana no lo ve", async () => {
    stubFetch(() => jsonResponse({ appointments: [], truncated: false, next_from: null, timezone: "America/Merida" }));
    rendered = renderComponent(<AgendaPage {...CTX} orgId="org-A" />);
    await esperar();
    await pulsar("Nueva cita");
    changeValue(document.body.querySelector("#citas-nueva-cliente") as HTMLInputElement, "Solo de A");
    rendered.unmount();
    rendered = renderComponent(<AgendaPage {...CTX} orgId="org-B" />);
    await esperar();
    await pulsar("Nueva cita");
    expect((document.body.querySelector("#citas-nueva-cliente") as HTMLInputElement).value).toBe("");
  });
});

describe("QA R1 caos -- el borrador no pasa de un staff a otro", () => {
  it("otro staff de la MISMA organizacion que inicia sesion en la misma pestana no ve el borrador del anterior", async () => {
    stubFetch(() => jsonResponse({ appointments: [], truncated: false, next_from: null, timezone: "America/Merida" }));
    rendered = renderComponent(<AgendaPage {...CTX} staffEmail="turno-manana@example.com" />);
    await esperar();
    await pulsar("Nueva cita");
    changeValue(document.body.querySelector("#citas-nueva-cliente") as HTMLInputElement, "Paciente del turno de la mañana");
    rendered.unmount();
    rendered = renderComponent(<AgendaPage {...CTX} staffEmail="turno-tarde@example.com" />);
    await esperar();
    await pulsar("Nueva cita");
    expect((document.body.querySelector("#citas-nueva-cliente") as HTMLInputElement).value).toBe("");
  });
});

describe("QA R1 viaje -- zona horaria del negocio (viaje-16), rotulos (viaje-17) y encabezados (viaje-19)", () => {
  it("QA-citas-R1-viaje-16: con el navegador en Tijuana y el negocio en Merida, la hora de pared 10:00 son 16:00Z y la Agenda pinta las horas del negocio", () => {
    process.env.TZ = "America/Tijuana";
    expect(wallTimeToIso("2027-09-13T10:00", "America/Merida")).toBe("2027-09-13T16:00:00.000Z");
    expect(formatTimeRange("2027-09-13T16:00:00.000Z", "2027-09-13T16:30:00.000Z", "America/Merida")).toMatch(/^10:00/);
    // Sin zona del negocio (servidor viejo) se conserva el comportamiento del navegador.
    expect(wallTimeToIso("2027-09-13T10:00")).toBe(new Date("2027-09-13T10:00").toISOString());
    // El dia del negocio, no el de UTC: las 19:00 de Merida ya son el dia siguiente en UTC.
    expect(zonedDayKey("2027-09-14T01:00:00.000Z", "America/Merida")).toBe("2027-09-13");
  });

  it("wallTimeToIso respeta el horario de verano (Tijuana: 10:00 del 13 de marzo UTC-8, del 15 UTC-7)", () => {
    expect(wallTimeToIso("2027-01-15T10:00", "America/Tijuana")).toBe("2027-01-15T18:00:00.000Z");
    expect(wallTimeToIso("2027-07-15T10:00", "America/Tijuana")).toBe("2027-07-15T17:00:00.000Z");
  });

  it("QA-citas-R1-viaje-16 (pantalla): el alta manual manda la hora de pared en la zona que dijo el servidor, no la del navegador", async () => {
    process.env.TZ = "America/Tijuana";
    const f = stubFetch(
      () => jsonResponse({ appointments: [cita("z1", "2027-09-13T16:00:00.000Z")], truncated: false, next_from: null, timezone: "America/Merida" }),
      (url, init) => ((init?.method ?? "GET") === "POST" && /\/appointments$/.test(url) ? jsonResponse({ appointment: cita("nueva") }, 201) : jsonResponse({}, 404)),
    );
    rendered = renderComponent(<AgendaPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toMatch(/10:00/);
    await pulsar("Nueva cita");
    const d = document.body;
    changeValue(d.querySelector("#citas-nueva-proveedor") as HTMLSelectElement, "prov-1");
    changeValue(d.querySelector("#citas-nueva-servicio") as HTMLSelectElement, "svc-1");
    changeValue(d.querySelector("#citas-nueva-inicio") as HTMLInputElement, "2027-09-14T10:00");
    changeValue(d.querySelector("#citas-nueva-cliente") as HTMLInputElement, "Zona Uno");
    changeValue(d.querySelector("#citas-nueva-telefono") as HTMLInputElement, "5511110000");
    await submitForm(d.querySelector("#citas-nueva-cita") as HTMLFormElement);
    await esperar();
    const post = f.mock.calls.find(([url, init]) => /\/appointments$/.test(url) && init?.method === "POST")!;
    expect((JSON.parse(post[1]!.body as string) as { starts_at: string }).starts_at).toBe("2027-09-14T16:00:00.000Z");
  });

  it("QA-citas-R1-viaje-17 y viaje-19: la lista de espera dice 'Sin preferencia' (no 'any') y los encabezados no capitalizan preposiciones", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "GET" && url.includes("/providers")) return jsonResponse({ providers: [PROVIDER] });
        if (method === "GET" && url.includes("/services")) return jsonResponse({ services: [SERVICE] });
        if (method === "GET" && /\/waitlist(\?|$)/.test(url)) {
          return jsonResponse({
            waitlist: [
              { id: "w1", position: 1, customer_name: "Mario", customer_phone: "5500000001", provider_id: null, service_id: null, preferred_date_from: null, preferred_date_to: null, preferred_time_window: "any", notified_count: 0, created_at: "2026-09-01T10:00:00.000Z" },
              { id: "w2", position: 2, customer_name: null, customer_phone: "5500000002", provider_id: null, service_id: null, preferred_date_from: null, preferred_date_to: null, preferred_time_window: "morning", notified_count: 0, created_at: "2026-09-01T11:00:00.000Z" },
            ],
          });
        }
        return jsonResponse({ appointments: [cita("e1")], truncated: false, next_from: null, timezone: "America/Merida" });
      }),
    );
    rendered = renderComponent(<AgendaPage {...CTX} />);
    await esperar();
    const texto = rendered.container.textContent!;
    expect(texto).toContain("Sin preferencia");
    expect(texto).toContain("Mañana");
    expect(texto).not.toMatch(/\bany\b/);
    expect(texto).toContain("Sin nombre");
    expect(rendered.container.querySelector(".capitalize")).toBeNull();
  });
});
