// @vitest-environment jsdom
//
// Rn-40 -- <FinanzasPage />: render por seccion (movimiento, owner statements, payouts, comisiones), roles de solo lectura,
// confirmacion de dos pasos en CADA escritura irreversible (Cancelar NO llama al servidor y deja el formulario abierto),
// error de la API con su mensaje real y los estados cargando / vacio de la tabla (DataTable).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notify } from "@atiende/ui";
import { FinanzasPage } from "../src/verticals/rentas/pages/Finanzas.tsx";
import type { LoginSession } from "../src/lib/auth-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let exito: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  exito = vi.spyOn(notify, "success").mockImplementation((() => "") as never);
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await flushMicrotasks();
  });
}
const sesion = (rol: string): LoginSession => ({ token: "tok", refreshToken: "ref", email: "s@example.com", organizations: [{ id: "org-1", slug: "gestora-demo", nombre: "Gestora", vertical: "rentas", rol }] });
const montar = (rol: string) => renderComponent(<FinanzasPage apiBaseUrl="http://api.local" token="tok" propertyId="prop-1" setPropertyId={() => {}} properties={[]} orgSlug="gestora-demo" session={sesion(rol)} />);
const json = (body: unknown, ok = true, status = 200): Response => ({ ok, status, json: async () => body }) as unknown as Response;

const RESERVA = { id: "oc-1", unidadId: "u1", capa: "reserva", rango: { inicio: "2026-11-01", fin: "2026-11-05" }, razon: "reserva", estado: "confirmada", canalCodigo: "airbnb", huespedNombre: "Ana", huespedContacto: null, createdAt: "2026-10-01T00:00:00Z" };
const MOVIMIENTO = { ocupacionId: "oc-1", moneda: "MXN", ingresoBrutoCentavos: 500000, montoRecibidoCentavos: 485000, comisionCanalCentavos: 15000, comisionCanalFuente: "regla", comisionGestorCentavos: 48500, gastosCentavos: 0, impuestosCentavos: 0, netoCentavos: 436500 };
const STATEMENT = { id: "st-1", ownerId: "own-1", propertyId: "prop-1", periodo: { inicio: "2026-10-01", fin: "2026-11-01" }, version: 1, moneda: "MXN", netoCentavos: 120000, generadoEn: "2026-11-02T18:00:00.000Z" };
const DETALLE_STATEMENT = {
  ...STATEMENT,
  motivoVersion: null,
  totales: { ingresosBrutosCentavos: 150000, comisionCanalCentavos: 10000, comisionGestorCentavos: 15000, gastosCentavos: 5000, impuestosCentavos: 0, netoCentavos: 120000 },
  lineas: [{ ocupacionId: "oc-1", tipo: "ingreso", descripcion: "Ingreso", montoCentavos: 150000 }],
};
const PAYOUT = {
  id: "po-1",
  propertyId: "prop-1",
  canalCodigo: "airbnb",
  moneda: "MXN",
  montoTotalCentavos: 250000,
  fechaPayout: "2026-11-10",
  referenciaExterna: null,
  resumen: { conciliadas: 1, pendientes: 0, discrepancias: 1 },
  lineas: [
    { ocupacionId: "oc-1", referenciaExternaReserva: "HM-1", montoCentavos: 150000, montoEsperadoCentavos: 150000, estado: "conciliado" },
    { ocupacionId: null, referenciaExternaReserva: "HM-2", montoCentavos: 100000, montoEsperadoCentavos: null, estado: "discrepancia" },
  ],
};

interface Opciones {
  readonly statements?: unknown[];
  readonly fallaMovimiento?: boolean;
  readonly pausaStatements?: Promise<void>;
  readonly escritura?: (url: string, init: RequestInit) => Response | undefined;
}
function red(o: Opciones = {}) {
  const llamadas: { url: string; method: string; body: unknown }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    llamadas.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method !== "GET") return o.escritura?.(url, init!) ?? json({}, false, 500);
    if (url.endsWith("/finanzas/reglas-comision")) return json({ reglas: [], canalesSinRegla: [], canales: [{ codigo: "airbnb", nombre: "Airbnb" }] });
    if (url.endsWith("/rentas/prop-1/unidades")) return json({ unidades: [{ id: "u1", nombre: "Suite 1" }] });
    if (url.endsWith("/unidades/u1/ocupaciones")) return json({ ocupaciones: [RESERVA] });
    if (url.endsWith("/reservas/oc-1/movimiento")) return o.fallaMovimiento ? json({ message: "Servidor caído" }, false, 500) : json(MOVIMIENTO);
    if (url.endsWith("/owners/own-1/statements")) {
      await o.pausaStatements;
      return json({ ownerId: "own-1", statements: o.statements ?? [STATEMENT] });
    }
    if (url.endsWith("/statements/st-1")) return json(DETALLE_STATEMENT);
    if (url.endsWith("/payouts/po-1")) return json(PAYOUT);
    if (url.endsWith("/payouts/no-existe")) return json({ message: "Payout no encontrado" }, false, 404);
    throw new Error(`url inesperada: ${method} ${url}`);
  });
  return { fn, mutaciones: () => llamadas.filter((l) => l.method !== "GET") };
}

const botones = () => [...document.body.querySelectorAll("button")];
const boton = (texto: string, indice = 0) => botones().filter((b) => b.textContent?.trim() === texto)[indice] as HTMLButtonElement;
const alertDialog = () => document.body.querySelector('[role="alertdialog"]');
const botonConfirmar = (texto: string) => [...alertDialog()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto) as HTMLButtonElement;
const formulario = () => document.body.querySelector('[role="dialog"]');
const campoEn = (raiz: ParentNode, etiqueta: string) => {
  const label = [...raiz.querySelectorAll("label")].find((l) => l.textContent?.includes(etiqueta))!;
  return raiz.querySelector(`#${label.getAttribute("for")}`) as HTMLInputElement;
};
const guardarDialogo = (texto: string) => [...formulario()!.querySelectorAll("button")].find((b) => b.textContent?.trim().includes(texto) && b.type === "submit") as HTMLButtonElement;

async function enviarFormulario(texto: string) {
  click(guardarDialogo(texto));
  await esperar();
}

describe("FinanzasPage -- estructura y roles", () => {
  it("un rol sin acceso no pide nada, lo explica y deja un solo h1", async () => {
    const { fn } = red();
    vi.stubGlobal("fetch", fn);
    rendered = montar("limpieza");
    await esperar();
    expect(fn).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("Sin acceso de lectura a Finanzas");
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
  });

  it("el contador ve las cuatro secciones en solo lectura (sin botones de escritura) y un solo h1", async () => {
    vi.stubGlobal("fetch", red().fn);
    rendered = montar("contador");
    await esperar();
    const t = rendered.container.textContent ?? "";
    for (const titulo of ["Comisiones de canal", "Movimiento financiero por reserva", "Owner statements", "Payouts de canal + conciliación"]) expect(t).toContain(titulo);
    expect(t).toContain("solo lectura");
    expect(boton("Registrar movimiento")).toBeUndefined();
    expect(boton("Generar statement")).toBeUndefined();
    expect(boton("Importar payout")).toBeUndefined();
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
  });

  it("la administradora ve los botones de escritura", async () => {
    vi.stubGlobal("fetch", red().fn);
    rendered = montar("admin_gestora");
    await esperar();
    expect(boton("Registrar movimiento")).toBeDefined();
    expect(boton("Generar statement")).toBeDefined();
    expect(boton("Importar payout")).toBeDefined();
  });
});

describe("FinanzasPage -- movimiento por reserva", () => {
  it("consulta el movimiento y lo muestra con el formateador unico (sin sufijo MXN)", async () => {
    vi.stubGlobal("fetch", red().fn);
    rendered = montar("contador");
    await esperar();
    click(boton("Ver movimiento registrado"));
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("$5,000.00");
    expect(t).toContain("$4,365.00");
    expect(t).not.toContain("MXN");
  });

  it("si la API falla muestra su mensaje real", async () => {
    vi.stubGlobal("fetch", red({ fallaMovimiento: true }).fn);
    rendered = montar("contador");
    await esperar();
    click(boton("Ver movimiento registrado"));
    await esperar();
    const alerta = rendered.container.querySelector('[role="alert"]');
    expect(alerta?.textContent).toContain("Servidor caído");
  });

  it("registrar: valida, pide confirmacion, Cancelar NO llama al servidor y confirmar manda el POST", async () => {
    const { fn, mutaciones } = red({ escritura: (url) => (url.endsWith("/reservas/oc-1/movimiento") ? json({ ...MOVIMIENTO, id: "m1", creadoEn: "2026-11-01" }, true, 201) : undefined) });
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(boton("Registrar movimiento"));
    await esperar();
    expect(formulario()).not.toBeNull();

    // validacion local: sin monto no hay confirmacion ni llamada
    await enviarFormulario("Registrar movimiento");
    expect(alertDialog()).toBeNull();
    expect(formulario()!.textContent).toContain("Monto bruto inválido");

    changeValue(campoEn(formulario()!, "Monto bruto"), "5000");
    changeValue(campoEn(formulario()!, "Comisión de gestor"), "10");
    await enviarFormulario("Registrar movimiento");
    expect(alertDialog()).not.toBeNull();
    expect(mutaciones()).toHaveLength(0);

    await act(async () => {
      click(botonConfirmar("Cancelar"));
      await flushMicrotasks();
    });
    expect(mutaciones()).toHaveLength(0);
    expect(formulario()).not.toBeNull();

    await enviarFormulario("Registrar movimiento");
    await act(async () => {
      click(botonConfirmar("Registrar movimiento"));
      await esperar();
    });
    expect(mutaciones()).toEqual([
      {
        url: "http://api.local/rentas/prop-1/reservas/oc-1/movimiento",
        method: "POST",
        body: { moneda: "MXN", montoBrutoCentavos: 500000, comisionGestorBasisPoints: 1000, comisionGestorBase: "bruto", gastos: [], impuestos: [] },
      },
    ]);
    expect(exito).toHaveBeenCalledWith("Movimiento registrado.");
  });

  it("si el servidor rechaza el registro, el formulario sigue abierto con el mensaje real", async () => {
    const { fn } = red({ escritura: () => json({ message: "Falta la regla de comisión del canal" }, false, 409) });
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(boton("Registrar movimiento"));
    await esperar();
    changeValue(campoEn(formulario()!, "Monto bruto"), "100");
    changeValue(campoEn(formulario()!, "Comisión de gestor"), "10");
    await enviarFormulario("Registrar movimiento");
    await act(async () => {
      click(botonConfirmar("Registrar movimiento"));
      await esperar();
    });
    expect(formulario()!.textContent).toContain("Falta la regla de comisión del canal");
    expect(exito).not.toHaveBeenCalled();
  });
});

describe("FinanzasPage -- owner statements", () => {
  async function conPropietario(rol = "admin_gestora") {
    rendered = montar(rol);
    await esperar();
    changeValue(campoEn(document.body, "Id del propietario"), "own-1");
  }

  it("lista los statements con periodo, version y neto, y abre el detalle con sus totales", async () => {
    vi.stubGlobal("fetch", red().fn);
    await conPropietario("contador");
    click(boton("Ver statements"));
    await esperar();
    const t = rendered!.container.textContent ?? "";
    expect(t).toContain("v1");
    expect(t).toContain("$1,200.00");
    click(boton("Ver detalle"));
    await esperar();
    const detalle = rendered!.container.textContent ?? "";
    expect(detalle).toContain("Statement v1");
    expect(detalle).toContain("$1,500.00");
    expect(detalle).toContain("Ingreso");
  });

  it("sin statements muestra el estado vacio de la tabla", async () => {
    vi.stubGlobal("fetch", red({ statements: [] }).fn);
    await conPropietario("contador");
    click(boton("Ver statements"));
    await esperar();
    expect(rendered!.container.textContent).toContain("Este propietario no tiene ningún statement generado todavía.");
  });

  it("mientras carga muestra el estado cargando de la tabla", async () => {
    let soltar!: () => void;
    const pausa = new Promise<void>((r) => (soltar = r));
    vi.stubGlobal("fetch", red({ pausaStatements: pausa }).fn);
    await conPropietario("contador");
    click(boton("Ver statements"));
    await esperar();
    expect(rendered!.container.querySelector("table")).toBeNull();
    expect(rendered!.container.querySelector('[aria-busy="true"], [role="status"]')).not.toBeNull();
    await act(async () => {
      soltar();
      await esperar();
    });
    expect(rendered!.container.querySelector("table")).not.toBeNull();
  });

  it("invitar al portal pide confirmacion: Cancelar no llama al servidor; confirmar muestra el token una vez", async () => {
    const { fn, mutaciones } = red({ escritura: (url) => (url.endsWith("/owners/own-1/portal-invite") ? json({ ownerId: "own-1", inviteToken: "TOKEN-UNICO-123", expiresAt: "2026-12-01T00:00:00.000Z" }, true, 201) : undefined) });
    vi.stubGlobal("fetch", fn);
    await conPropietario();
    click(boton("Invitar a este propietario"));
    await esperar();
    expect(alertDialog()).not.toBeNull();
    await act(async () => {
      click(botonConfirmar("Cancelar"));
      await flushMicrotasks();
    });
    expect(mutaciones()).toHaveLength(0);
    expect(rendered!.container.textContent).not.toContain("TOKEN-UNICO-123");

    click(boton("Invitar a este propietario"));
    await esperar();
    await act(async () => {
      click(botonConfirmar("Generar invitación"));
      await esperar();
    });
    expect(mutaciones()).toEqual([{ url: "http://api.local/rentas/prop-1/owners/own-1/portal-invite", method: "POST", body: {} }]);
    expect(rendered!.container.textContent).toContain("TOKEN-UNICO-123");
    expect(exito).toHaveBeenCalledWith("Invitación al portal creada.");
  });

  it("generar statement: con version previa exige motivo; Cancelar no llama al servidor; confirmar manda el POST", async () => {
    const { fn, mutaciones } = red({ escritura: (url) => (url.endsWith("/owners/own-1/statements") ? json({ creado: true, version: 2, id: "st-2" }, true, 201) : undefined) });
    vi.stubGlobal("fetch", fn);
    await conPropietario();
    click(boton("Ver statements"));
    await esperar();
    click(boton("Generar statement"));
    await esperar();
    changeValue(campoEn(formulario()!, "Periodo inicio"), "2026-11-01");
    changeValue(campoEn(formulario()!, "Periodo fin"), "2026-12-01");
    await enviarFormulario("Generar statement");
    expect(alertDialog()).toBeNull();
    expect(formulario()!.textContent).toContain("el motivo de la nueva versión es obligatorio");

    changeValue(campoEn(formulario()!, "Motivo de nueva versión"), "Corrección de gastos");
    await enviarFormulario("Generar statement");
    await act(async () => {
      click(botonConfirmar("Cancelar"));
      await flushMicrotasks();
    });
    expect(mutaciones()).toHaveLength(0);
    expect(formulario()).not.toBeNull();

    await enviarFormulario("Generar statement");
    await act(async () => {
      click(botonConfirmar("Generar statement"));
      await esperar();
    });
    expect(mutaciones()).toEqual([
      { url: "http://api.local/rentas/prop-1/owners/own-1/statements", method: "POST", body: { periodoInicio: "2026-11-01", periodoFin: "2026-12-01", motivoVersion: "Corrección de gastos" } },
    ]);
    expect(exito).toHaveBeenCalledWith("Statement nuevo creado: versión 2.");
  });
});

describe("FinanzasPage -- payouts", () => {
  it("consultar un payout inexistente muestra el mensaje real del servidor", async () => {
    vi.stubGlobal("fetch", red().fn);
    rendered = montar("contador");
    await esperar();
    changeValue(campoEn(document.body, "Id del payout"), "no-existe");
    click(boton("Ver payout"));
    await esperar();
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain("Payout no encontrado");
  });

  it("consultar un payout muestra la conciliacion por linea con su estado", async () => {
    vi.stubGlobal("fetch", red().fn);
    rendered = montar("contador");
    await esperar();
    changeValue(campoEn(document.body, "Id del payout"), "po-1");
    click(boton("Ver payout"));
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("$2,500.00");
    expect(t).toContain("1 conciliadas · 0 pendientes · 1 con discrepancia");
    expect(t).toContain("Conciliado");
    expect(t).toContain("Discrepancia");
    expect(t).toContain("sin match");
  });

  it("importar: valida, pide confirmacion, Cancelar no llama al servidor y confirmar manda el POST y muestra el payout", async () => {
    const { fn, mutaciones } = red({ escritura: (url) => (url.endsWith("/rentas/prop-1/payouts") ? json({ id: "po-1", creadoEn: "2026-11-10", canalCodigo: "airbnb", moneda: "MXN", montoTotalCentavos: 250000, fechaPayout: "2026-11-10", resumen: PAYOUT.resumen, lineas: PAYOUT.lineas }, true, 201) : undefined) });
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(boton("Importar payout"));
    await esperar();
    await enviarFormulario("Importar payout");
    expect(formulario()!.textContent).toContain("La fecha del payout es requerida");
    expect(alertDialog()).toBeNull();

    changeValue(campoEn(formulario()!, "Fecha de pago"), "2026-11-10");
    changeValue(formulario()!.querySelector('input[aria-label="Monto de la línea"]') as HTMLInputElement, "1500");
    await enviarFormulario("Importar payout");
    expect(alertDialog()).not.toBeNull();
    await act(async () => {
      click(botonConfirmar("Cancelar"));
      await flushMicrotasks();
    });
    expect(mutaciones()).toHaveLength(0);
    expect(formulario()).not.toBeNull();

    await enviarFormulario("Importar payout");
    await act(async () => {
      click(botonConfirmar("Importar payout"));
      await esperar();
    });
    expect(mutaciones()).toEqual([
      { url: "http://api.local/rentas/prop-1/payouts", method: "POST", body: { canalCodigo: expect.any(String), moneda: "MXN", fechaPayout: "2026-11-10", referenciaExterna: null, lineas: [{ referenciaExternaReserva: null, montoCentavos: 150000 }] } },
    ]);
    expect(exito).toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("1 conciliadas · 0 pendientes · 1 con discrepancia");
  });
});
