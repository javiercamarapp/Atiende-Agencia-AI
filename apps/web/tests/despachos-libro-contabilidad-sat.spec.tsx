// @vitest-environment jsdom
//
// D-P3-16/17/44 -- paneles reales del libro: pestaña Catálogo (código agrupador del SAT, propuesta, asignar, importar del proveedor anterior), pagos de
// complemento de pago (REP) y contabilidad electrónica (tipo de envío N/C, pólizas del periodo). Cada control llama a una ruta real (fetch simulado
// solo en la prueba) y maneja carga, error y vacío.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogoCuentasPanel } from "../src/verticals/despachos/components/CatalogoCuentasPanel.tsx";
import { ContabilidadElectronicaLibroPanel } from "../src/verticals/despachos/components/ContabilidadElectronicaLibroPanel.tsx";
import { ImportarContabilidadDialog } from "../src/verticals/despachos/components/ImportarContabilidadDialog.tsx";
import { PagosRepPanel } from "../src/verticals/despachos/components/PagosRepPanel.tsx";
import type { CuentaLibro } from "../src/verticals/despachos/lib/libro-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const API = "https://api.test";
const P = "p1";

interface Llamada {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}
let llamadas: Llamada[];
let rendered: RenderedComponent | undefined;

type Responder = (url: string, method: string, body: unknown) => Response | undefined;
function stubFetch(responder: Responder) {
  llamadas = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      llamadas.push({ url, method, body });
      return responder(url, method, body) ?? new Response(JSON.stringify({ message: "no stub" }), { status: 404 });
    }),
  );
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => flushMicrotasks());
};

beforeEach(() => {
  installMatchMediaStub();
  installMemoryLocalStorage();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const dialogo = () => document.body.querySelector('[role="dialog"]') as HTMLElement | null;
const boton = (texto: string, raiz: ParentNode = document.body) => [...raiz.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement | undefined;

const CUENTAS: CuentaLibro[] = [
  { codigo: "1020000", descripcion: "Bancos", naturaleza: "D", nivel: 1, cuentaPadre: null, codigoAgrupador: "102", propuestaCodigo: "102" },
  { codigo: "1050000", descripcion: "Clientes", naturaleza: "D", nivel: 1, cuentaPadre: null, codigoAgrupador: null, propuestaCodigo: "105" },
  { codigo: "7770000", descripcion: "Cuenta propia", naturaleza: "A", nivel: 1, cuentaPadre: null, codigoAgrupador: null, propuestaCodigo: null },
];

function montarCatalogo(opciones: { puedeGestionar?: boolean; cuentas?: CuentaLibro[] } = {}) {
  const ejecutar = vi.fn(async (accion: () => Promise<string>) => {
    await accion();
  });
  const onCambio = vi.fn();
  rendered = renderComponent(<CatalogoCuentasPanel apiBaseUrl={API} token="tok" propertyId={P} puedeGestionar={opciones.puedeGestionar ?? true} cuentas={opciones.cuentas ?? CUENTAS} ejecutar={ejecutar} onCambio={onCambio} />);
  return { ejecutar, onCambio };
}

describe("CatalogoCuentasPanel (código agrupador del SAT)", () => {
  it("señala las cuentas sin código, su nivel y su código; el XML no se genera hasta asignarlo", () => {
    stubFetch(() => undefined);
    montarCatalogo();
    const t = rendered!.container.textContent ?? "";
    expect(t).toContain("2 de 3 cuentas no tienen código agrupador del SAT");
    expect(t).toContain("el XML de contabilidad electrónica no se genera hasta asignarlo");
    expect(t).toContain("Sin código");
    expect(t).toContain("102");
  });

  it("'Aplicar la propuesta' llama a la ruta real (solo cuentas sin código con propuesta) y avisa que se valide", async () => {
    stubFetch((url, method) => (url.endsWith("/catalogo/agrupadores/proponer") && method === "POST" ? json({ aplicadas: 1, sinPropuesta: 1, nota: "x" }) : undefined));
    const { ejecutar } = montarCatalogo();
    const b = boton("Aplicar la propuesta del catálogo base (1)")!;
    expect(b).toBeDefined();
    click(b);
    await settle();
    expect(llamadas[0]).toMatchObject({ url: `${API}/despachos/${P}/libro/catalogo/agrupadores/proponer`, method: "POST" });
    expect(ejecutar).toHaveBeenCalledTimes(1);
    const mensaje = await ejecutar.mock.calls[0]![0]();
    expect(mensaje).toContain("Valídala con tu fiscalista");
  });

  it("asignar un código: valida el formato antes de enviar y luego manda la asignación", async () => {
    stubFetch((url, method) => (url.endsWith("/catalogo/agrupadores") && method === "POST" ? json({ actualizadas: 1 }) : undefined));
    const { onCambio } = montarCatalogo();
    click(boton("Asignar", document.body)!); // primera cuenta sin código: Clientes
    expect(dialogo()!.textContent).toContain("1050000");
    expect((document.getElementById("agrupador-codigo") as HTMLInputElement).value).toBe("105"); // prellenado con la propuesta
    changeValue(document.getElementById("agrupador-codigo") as HTMLInputElement, "10.5");
    await submitForm(document.getElementById("form-agrupador") as HTMLFormElement);
    expect(dialogo()!.textContent).toContain("3 dígitos");
    expect(llamadas.some((l) => l.method === "POST")).toBe(false);
    changeValue(document.getElementById("agrupador-codigo") as HTMLInputElement, "105.01");
    await submitForm(document.getElementById("form-agrupador") as HTMLFormElement);
    await settle();
    expect(llamadas[0]).toMatchObject({ method: "POST", body: { asignaciones: [{ codigo: "1050000", codigoAgrupador: "105.01" }] } });
    expect(onCambio).toHaveBeenCalled();
    expect(dialogo()).toBeNull();
  });

  it("el error del servidor al asignar (código fuera de la lista) se muestra y el diálogo sigue abierto", async () => {
    stubFetch(() => json({ code: "validation_error", message: "asignaciones[0].codigoAgrupador: debe ser un código de la lista del Anexo 24" }, 400));
    montarCatalogo();
    click(boton("Asignar")!);
    changeValue(document.getElementById("agrupador-codigo") as HTMLInputElement, "999.99");
    await submitForm(document.getElementById("form-agrupador") as HTMLFormElement);
    await settle();
    expect(dialogo()!.textContent).toContain("lista del Anexo 24");
  });

  it("alta de una subcuenta: manda nivel (el del padre + 1), cuenta padre y código SAT", async () => {
    stubFetch((_u, method) => (method === "PUT" ? json({ codigo: "1020100" }) : undefined));
    const { ejecutar } = montarCatalogo();
    changeValue(document.getElementById("cuenta-codigo") as HTMLInputElement, "1020100");
    changeValue(document.getElementById("cuenta-descripcion") as HTMLInputElement, "Bancos nacionales");
    changeValue(document.getElementById("cuenta-padre") as HTMLSelectElement, "1020000");
    changeValue(document.getElementById("cuenta-agrupador") as HTMLInputElement, "102.01");
    const form = document.getElementById("cuenta-codigo")!.closest("form") as HTMLFormElement;
    await submitForm(form);
    await settle();
    expect(ejecutar).toHaveBeenCalled();
    expect(llamadas[0]).toMatchObject({ method: "PUT", body: { codigo: "1020100", descripcion: "Bancos nacionales", naturaleza: "D", nivel: 2, cuentaPadre: "1020000", codigoAgrupador: "102.01" } });
  });

  it("todas con código: mensaje de éxito y ningún botón de propuesta; solo lectura: sin acciones de escritura", () => {
    stubFetch(() => undefined);
    montarCatalogo({ cuentas: CUENTAS.map((c) => ({ ...c, codigoAgrupador: "102" })) });
    expect(rendered!.container.textContent).toContain("Todas las cuentas tienen código agrupador del SAT");
    expect(boton("Aplicar la propuesta")).toBeUndefined();
    rendered!.unmount();
    montarCatalogo({ puedeGestionar: false });
    const t = rendered!.container.textContent ?? "";
    expect(t).not.toContain("Importar catálogo");
    expect(t).not.toContain("Guardar cuenta");
    expect(boton("Asignar")).toBeUndefined();
  });

  it("catálogo vacío: invita a sembrar el catálogo base", async () => {
    stubFetch((url, method) => (url.endsWith("/catalogo/sembrar") && method === "POST" ? json({ agregadas: 60 }) : undefined));
    const { ejecutar } = montarCatalogo({ cuentas: [] });
    click(boton("Sembrar catálogo base")!);
    await settle();
    expect(await ejecutar.mock.calls[0]![0]()).toContain("60 cuentas");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------

async function elegirArchivo(input: HTMLInputElement, contenido: string, nombre = "catalogo.xml") {
  const archivo = new File([contenido], nombre, { type: "text/xml" });
  Object.defineProperty(input, "files", { value: [archivo], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
  });
  await settle();
}

const PREVIA_CATALOGO = {
  confirmado: false,
  periodo: "2026-07",
  aceptadas: 3,
  nuevas: 2,
  actualizadas: 1,
  sinCodigoAgrupador: 1,
  rechazadasTotal: 1,
  rechazadas: [{ numCta: "1-01-001", motivo: "El número de cuenta no es numérico de 4 a 10 dígitos" }],
  advertencias: ["1 cuenta(s) traen un código agrupador que no está en la lista del Anexo 24"],
};

describe("ImportarContabilidadDialog (catálogo del proveedor anterior)", () => {
  function montar(modo: "catalogo" | "apertura") {
    const onTerminado = vi.fn();
    const onOpenChange = vi.fn();
    rendered = renderComponent(<ImportarContabilidadDialog modo={modo} open onOpenChange={onOpenChange} apiBaseUrl={API} token="tok" propertyId={P} onTerminado={onTerminado} />);
    return { onTerminado, onOpenChange };
  }

  it("elegir el archivo pide la VISTA PREVIA (nada se escribe), muestra qué importa y qué rechaza, y confirmar manda confirmar: true", async () => {
    stubFetch((url, _m, body) => {
      if (url.endsWith("/catalogo/importar")) return json((body as { confirmar?: boolean }).confirmar ? { ...PREVIA_CATALOGO, confirmado: true, agregadas: 2, actualizadas: 1 } : PREVIA_CATALOGO);
      return undefined;
    });
    const { onTerminado } = montar("catalogo");
    await elegirArchivo(document.getElementById("importar-catalogo-archivo") as HTMLInputElement, "<xml/>");
    const post1 = llamadas.filter((l) => l.method === "POST");
    expect(post1).toHaveLength(1);
    expect(post1[0]!.body).toEqual({ xml: "<xml/>" });
    const t = dialogo()!.textContent ?? "";
    expect(t).toContain("2 nuevas");
    expect(t).toContain("1 se actualizan");
    expect(t).toContain("1 rechazadas");
    expect(t).toContain("1-01-001");
    expect(t).toContain("no está en la lista del Anexo 24");
    expect(onTerminado).not.toHaveBeenCalled();

    click(boton("Importar catálogo", dialogo()!)!);
    await settle();
    const post2 = llamadas.filter((l) => l.method === "POST");
    expect(post2[post2.length - 1]!.body).toEqual({ xml: "<xml/>", confirmar: true });
    expect(dialogo()!.textContent).toContain("Catálogo importado: 2 cuenta(s) nueva(s) y 1 actualizada(s).");
    expect(onTerminado).toHaveBeenCalledTimes(1);
  });

  it("un XML rechazado por el servidor (DTD, RFC distinto...) muestra el motivo y NO permite importar", async () => {
    stubFetch(() => json({ code: "validation_error", message: "El XML no puede declarar DTD ni entidades." }, 400));
    const { onTerminado } = montar("catalogo");
    await elegirArchivo(document.getElementById("importar-catalogo-archivo") as HTMLInputElement, "<!DOCTYPE x>");
    expect(dialogo()!.textContent).toContain("El XML no puede declarar DTD ni entidades.");
    expect(boton("Importar catálogo", dialogo()!)!.disabled).toBe(true);
    expect(onTerminado).not.toHaveBeenCalled();
  });

  it("sin cuentas importables el botón queda deshabilitado", async () => {
    stubFetch(() => json({ ...PREVIA_CATALOGO, aceptadas: 0, nuevas: 0, actualizadas: 0, rechazadasTotal: 0, rechazadas: [], advertencias: [] }));
    montar("catalogo");
    await elegirArchivo(document.getElementById("importar-catalogo-archivo") as HTMLInputElement, "<xml/>");
    expect(boton("Importar catálogo", dialogo()!)!.disabled).toBe(true);
  });

  it("balanza: la vista previa dice qué póliza de apertura se registrará y confirmar la registra", async () => {
    stubFetch((url, _m, body) => {
      if (!url.endsWith("/apertura/importar")) return undefined;
      const base = { periodo: "2026-07", tipoEnvio: "N", fecha: "2026-06-30", partidas: 4, totalCentavos: 150000, concepto: "Póliza de apertura (balanza importada 2026-07)" };
      return json((body as { confirmar?: boolean }).confirmar ? { ...base, confirmado: true, folio: 1 } : { ...base, confirmado: false });
    });
    const { onTerminado } = montar("apertura");
    await elegirArchivo(document.getElementById("importar-apertura-archivo") as HTMLInputElement, "<xml/>", "balanza.xml");
    expect(dialogo()!.textContent).toContain("4 partidas por $1,500.00");
    click(boton("Registrar apertura", dialogo()!)!);
    await settle();
    expect(dialogo()!.textContent).toContain("Póliza de apertura registrada (diario, folio 1)");
    expect(onTerminado).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------

const PAGO = { pagoId: "pg1", folioFiscalRep: "22222222-2222-2222-2222-222222222222", folioFiscalCfdi: "11111111-1111-1111-1111-111111111111", fechaPago: "2026-07-28", flujo: "trasladado", numParcialidad: 1, importePagadoCentavos: 58000, ivaCentavos: 8000, poliza: null, armable: true, motivo: null };

describe("PagosRepPanel", () => {
  function montar(puedeGestionar = true) {
    const onCambio = vi.fn();
    rendered = renderComponent(<PagosRepPanel apiBaseUrl={API} token="tok" propertyId={P} periodo="2026-07" puedeGestionar={puedeGestionar} onCambio={onCambio} />);
    return { onCambio };
  }

  it("lista los pagos con su estado y Contabilizar llama a desde-rep con el REP y el pago", async () => {
    let contabilizado = false;
    stubFetch((url, method) => {
      if (url.includes("/libro/pagos-rep")) {
        return json({
          estado: "disponible",
          pagos: [contabilizado ? { ...PAGO, poliza: { id: "pol1", folio: 1, tipo: "ingreso" }, armable: false } : PAGO, { ...PAGO, pagoId: "pg2", numParcialidad: 2, armable: false, motivo: "Solo el pago de un CFDI con método PPD se contabiliza" }],
        });
      }
      if (url.endsWith("/polizas/desde-rep") && method === "POST") {
        contabilizado = true;
        return json({ folioFiscalRep: PAGO.folioFiscalRep, registradas: 1, resultados: [{ pagoId: "pg1", estado: "registrada", folio: 1 }] }, 201);
      }
      return undefined;
    });
    const { onCambio } = montar();
    await settle();
    let t = rendered!.container.textContent ?? "";
    expect(t).toContain("Cobro · parcialidad 1");
    expect(t).toContain("$580.00");
    expect(t).toContain("Sin contabilizar");
    expect(t).toContain("Solo el pago de un CFDI con método PPD");
    expect(llamadas[0]!.url).toContain("/libro/pagos-rep?periodo=2026-07");
    const botones = [...rendered!.container.querySelectorAll("button")].filter((b) => b.textContent?.includes("Contabilizar"));
    expect(botones).toHaveLength(1); // solo el armable
    click(botones[0]!);
    await settle();
    const post = llamadas.find((l) => l.method === "POST")!;
    expect(post.body).toEqual({ folioFiscalRep: PAGO.folioFiscalRep, pagoId: "pg1" });
    t = rendered!.container.textContent ?? "";
    expect(t).toContain("Póliza folio 1 registrada.");
    expect(t).toContain("Ingreso 1");
    expect(onCambio).toHaveBeenCalled();
  });

  it("periodo cerrado (error por pago) se muestra; solo lectura no ve el botón; vacío y base sin migrar son honestos", async () => {
    stubFetch((url, method) => {
      if (url.includes("/libro/pagos-rep")) return json({ estado: "disponible", pagos: [PAGO] });
      if (method === "POST") return json({ folioFiscalRep: PAGO.folioFiscalRep, registradas: 0, resultados: [{ pagoId: "pg1", estado: "error", motivo: "el periodo 2026-07 está cerrado" }] });
      return undefined;
    });
    montar();
    await settle();
    click([...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Contabilizar"))!);
    await settle();
    expect(rendered!.container.textContent).toContain("el periodo 2026-07 está cerrado");
    rendered!.unmount();

    montar(false);
    await settle();
    expect([...rendered!.container.querySelectorAll("button")].some((b) => b.textContent?.includes("Contabilizar"))).toBe(false);
    rendered!.unmount();

    stubFetch(() => json({ estado: "disponible", pagos: [] }));
    montar();
    await settle();
    expect(rendered!.container.textContent).toContain("No hay pagos de complemento de pago en este periodo");
    rendered!.unmount();

    stubFetch(() => json({ estado: "no_disponible", pagos: [] }));
    montar();
    await settle();
    expect(rendered!.container.textContent).toContain("falta aplicar la migración 028");
  });

  it("un error del servidor al cargar se muestra con reintento", async () => {
    stubFetch(() => json({ code: "internal", message: "Falló la lectura" }, 500));
    montar();
    await settle();
    expect(rendered!.container.textContent).toContain("Falló la lectura");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------

describe("ContabilidadElectronicaLibroPanel", () => {
  function montar() {
    rendered = renderComponent(<ContabilidadElectronicaLibroPanel apiBaseUrl={API} token="tok" propertyId={P} periodo="2026-07" periodoValido />);
  }
  const PAQUETE = { periodo: "2026-07", estado: "listo_para_timbrar", nota: "XML conforme al XSD 1.3", catalogo: { xml: "<c/>", sha1: "a".repeat(40), cuentas: 3 }, balanza: { xml: "<b/>", sha1: "b".repeat(40), cuadrada: true, cuentas: 2 }, resumen: { cuentas: 2, totalDebe: "1160.00", totalHaber: "1160.00", cuadrada: true, saldosAnomalos: [] } };

  it("balanza normal: pide el paquete sin FechaModBal; complementaria exige la fecha y la manda", async () => {
    stubFetch((url) => (url.includes("/contabilidad-electronica?") ? json(PAQUETE) : undefined));
    montar();
    click(boton("Generar paquete de 2026-07")!);
    await settle();
    const get1 = llamadas.find((l) => l.url.includes("/contabilidad-electronica?"))!;
    expect(get1.url).toContain("periodo=2026-07");
    expect(get1.url).not.toContain("tipoEnvio");
    expect(rendered!.container.textContent).toContain("Balanza cuadrada");
    expect(rendered!.container.textContent).toContain("SHA-1 " + "a".repeat(40));

    changeValue(document.getElementById("ce-tipo-envio") as HTMLSelectElement, "C");
    expect(boton("Generar paquete de 2026-07")!.disabled).toBe(true); // falta la fecha
    changeValue(document.getElementById("ce-fecha-mod") as HTMLInputElement, "2026-08-15");
    expect(boton("Generar paquete de 2026-07")!.disabled).toBe(false);
    llamadas.length = 0;
    click(boton("Generar paquete de 2026-07")!);
    await settle();
    expect(llamadas.find((l) => l.url.includes("/contabilidad-electronica?"))!.url).toContain("tipoEnvio=C&fechaModBal=2026-08-15");
  });

  it("cuentas sin código agrupador: el 409 del servidor se muestra tal cual (con las cuentas) y no hay descargas", async () => {
    stubFetch(() => json({ code: "catalogo_sin_codigo_agrupador", message: "El catálogo tiene 2 cuenta(s) sin código agrupador del SAT válido: asígnalo en la pestaña Catálogo antes de generar el XML. Cuentas: 1050000, 7770000." }, 409));
    montar();
    click(boton("Generar paquete de 2026-07")!);
    await settle();
    expect(rendered!.container.textContent).toContain("Cuentas: 1050000, 7770000.");
    expect(boton("Catálogo XML")).toBeUndefined();
  });

  it("pólizas del periodo: exige tipo de solicitud y número con el formato del SAT, y manda orden o trámite según el tipo", async () => {
    stubFetch((url) => (url.includes("/contabilidad-electronica/polizas") ? json({ periodo: "2026-07", tipoSolicitud: "AF", polizas: 3, xml: "<p/>", sha1: "c".repeat(40), nota: "sin complementos" }) : undefined));
    montar();
    const generar = () => boton("Generar pólizas de 2026-07")!;
    expect(generar().disabled).toBe(true);
    changeValue(document.getElementById("ce-numero") as HTMLInputElement, "abc1234567/26");
    expect(generar().disabled).toBe(false); // se normaliza a mayúsculas
    click(generar());
    await settle();
    expect(llamadas.find((l) => l.url.includes("/contabilidad-electronica/polizas"))!.url).toContain("tipoSolicitud=AF&numOrden=ABC1234567%2F26");
    expect(rendered!.container.textContent).toContain("3 póliza(s) de 2026-07");
    expect(boton("Pólizas XML")).toBeDefined();

    changeValue(document.getElementById("ce-tipo-solicitud") as HTMLSelectElement, "DE");
    expect(generar().disabled).toBe(true); // el número de orden ya no vale para un trámite
    changeValue(document.getElementById("ce-numero") as HTMLInputElement, "AB123456789012");
    expect(generar().disabled).toBe(false);
    llamadas.length = 0;
    click(generar());
    await settle();
    expect(llamadas.find((l) => l.url.includes("/contabilidad-electronica/polizas"))!.url).toContain("tipoSolicitud=DE&numTramite=AB123456789012");
  });

  it("un error del servidor al generar las pólizas se muestra", async () => {
    stubFetch(() => json({ code: "conflict", message: "El libro no tiene pólizas en 2026-07: no hay nada que declarar." }, 409));
    montar();
    changeValue(document.getElementById("ce-numero") as HTMLInputElement, "ABC1234567/26");
    click(boton("Generar pólizas de 2026-07")!);
    await settle();
    expect(rendered!.container.textContent).toContain("no hay nada que declarar");
  });
});
