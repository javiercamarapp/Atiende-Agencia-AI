// @vitest-environment jsdom
//
// <CfoLayout />: marco del CFO. Permisos (fail-closed), filtros sincronizados con la URL, «Todas» vs selección múltiple, conmutador Total / Por
// sucursal, pestañas, exportación (se oculta si la ruta de CFO-06 responde 404), drill-down y estados (403, base sin migrar, error con reintento).
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CfoLayout } from "../src/verticals/restaurantes/cfo/CfoLayout.tsx";
import { API, IDS, PROPIEDAD, crearApiCfo } from "./test-utils/cfo-api-simulada.ts";
import { changeValue, click, esperarHasta, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.restoreAllMocks();
});

const RANGO = "desde=2026-09-21&hasta=2026-09-27&comparar=periodo_anterior";
let ubicacion = "";
function Sonda() {
  const l = useLocation();
  ubicacion = `${l.pathname}${l.search}`;
  return null;
}
const params = () => new URLSearchParams(ubicacion.split("?")[1] ?? "");

function montar(api: ReturnType<typeof crearApiCfo>, opciones: { role?: string; url?: string } = {}) {
  rendered = renderComponent(
    <MemoryRouter initialEntries={[opciones.url ?? `/restaurantes/demo/cfo/resumen?${RANGO}`]}>
      <Sonda />
      <Routes>
        <Route path="/restaurantes/:orgSlug/cfo/*" element={<CfoLayout apiBaseUrl={API} token="tok" propertyId={PROPIEDAD} orgSlug="demo" role={opciones.role ?? "owner"} staffFullName={undefined} staffEmail="a@b.c" fetchImpl={api.fetch} hoy="2026-09-28" />} />
      </Routes>
    </MemoryRouter>,
  );
}
const texto = () => rendered!.container.textContent ?? "";
const q = (sel: string) => rendered!.container.querySelector(sel);
const cuando = (cond: () => boolean, d: string) => esperarHasta(cond, d);
const boton = (nombre: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === nombre || b.getAttribute("aria-label") === nombre) as HTMLButtonElement | undefined;
const casilla = (nombre: string) => [...document.body.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].find((i) => i.closest("label")?.textContent?.trim() === nombre);

describe("<CfoLayout /> · permisos", () => {
  it.each(["staff", "repartidor", "finanzas", "", "desconocido"])("rol «%s»: «Tu rol no tiene acceso al CFO», sin filtros y SIN pedir ninguna cifra", async (role) => {
    const api = crearApiCfo();
    montar(api, { role });
    await act(async () => {
      await Promise.resolve();
    });
    expect(texto()).toContain("Tu rol no tiene acceso al CFO");
    expect(q("[data-testid=cfo-filtros]")).toBeNull();
    expect(api.mock).not.toHaveBeenCalled();
  });

  it("owner y admin sí lo ven", async () => {
    for (const role of ["owner", "admin"]) {
      const api = crearApiCfo();
      montar(api, { role });
      await cuando(() => q("[data-testid=cfo-resumen]") !== null && q("[data-testid=hallazgo]") !== null, `resumen de ${role}`);
      expect(texto()).not.toContain("Tu rol no tiene acceso al CFO");
      rendered?.unmount();
    }
  });

  it("un 403 del API (aunque el rol local parezca válido) muestra el estado sin acceso y no pinta cifras", async () => {
    const api = crearApiCfo({ "GET /alcance": { status: 403 } });
    montar(api);
    await cuando(() => texto().includes("Tu rol no tiene acceso al CFO"), "403");
    expect(q("[data-testid=cfo-filtros]")).toBeNull();
    expect(q("[data-testid=kpi-cfo]")).toBeNull();
  });
});

describe("<CfoLayout /> · estados", () => {
  it("base sin migrar (503): estado honesto, sin cifras inventadas", async () => {
    montar(crearApiCfo({ "GET /alcance": { status: 503 } }));
    await cuando(() => texto().includes("El CFO aún no está disponible"), "no disponible");
    expect(q("[data-testid=kpi-cfo]")).toBeNull();
  });

  it("error del servidor: mensaje y «Reintentar» que vuelve a pedir y recupera", async () => {
    let falla = true;
    const api = crearApiCfo({ "GET /alcance": () => (falla ? { status: 500, cuerpo: { message: "Se cayó la consulta." } } : undefined) });
    montar(api);
    await cuando(() => texto().includes("Se cayó la consulta."), "error");
    falla = false;
    click(boton("Reintentar")!);
    await cuando(() => q("[data-testid=cfo-filtros]") !== null, "recupera");
  });

  it("una pestaña que no existe dice «Esta sección no existe» y enlaza al resumen", async () => {
    montar(crearApiCfo(), { url: `/restaurantes/demo/cfo/inventada?${RANGO}` });
    await cuando(() => texto().includes("Esta sección no existe"), "404 interno");
    expect(texto()).toContain("Ir al resumen del CFO");
  });
});

describe("<CfoLayout /> · filtros en la URL", () => {
  it("sin fechas en el enlace, completa la URL con los 7 días por defecto", async () => {
    montar(crearApiCfo(), { url: "/restaurantes/demo/cfo/resumen" });
    await cuando(() => params().get("desde") !== null, "URL completada");
    expect(params().get("desde")).toBe("2026-09-22");
    expect(params().get("hasta")).toBe("2026-09-28");
    expect(params().get("comparar")).toBe("periodo_anterior");
  });

  it("la URL manda: el rango, las sucursales y «comparar» llegan al API", async () => {
    const api = crearApiCfo();
    montar(api, { url: `/restaurantes/demo/cfo/resumen?desde=2026-09-21&hasta=2026-09-27&comparar=anio_anterior&sucursales=${IDS.T3}` });
    await cuando(() => api.peticiones("GET", "/resumen").length > 0, "pidió el resumen");
    const p = api.peticiones("GET", "/resumen")[0]!.consulta;
    expect(p.get("desde")).toBe("2026-09-21");
    expect(p.get("comparar")).toBe("anio_anterior");
    expect(p.get("sucursales")).toBe(IDS.T3);
    // El alcance se pide SIN filtro: lista todas las sucursales permitidas.
    expect(api.peticiones("GET", "/alcance")[0]!.consulta.has("sucursales")).toBe(false);
  });

  it("una sucursal ajena o borrada en el enlace NO da «sin acceso»: cae a «Todas» con aviso y el API nunca la recibe", async () => {
    const api = crearApiCfo();
    const ajena = "00000000-0000-4000-8000-0000000000ff";
    montar(api, { url: `/restaurantes/demo/cfo/resumen?${RANGO}&sucursales=${ajena}` });
    await cuando(() => q("[data-testid=hallazgo]") !== null, "resumen");
    expect(texto()).not.toContain("Tu rol no tiene acceso al CFO");
    expect(q("[data-testid=cfo-sucursal-descartada]")!.textContent).toContain("«Todas»");
    expect(q("[data-testid=filtro-sucursales]")!.textContent).toContain("Todas las sucursales");
    expect(api.peticiones("GET", "/resumen").every((r) => !r.consulta.has("sucursales"))).toBe(true);
  });

  it("mezcla de una sucursal propia y una ajena: se pide solo la propia y se avisa", async () => {
    const api = crearApiCfo();
    const ajena = "00000000-0000-4000-8000-0000000000ff";
    montar(api, { url: `/restaurantes/demo/cfo/resumen?${RANGO}&sucursales=${IDS.T3},${ajena}` });
    await cuando(() => q("[data-testid=hallazgo]") !== null, "resumen");
    expect(api.peticiones("GET", "/resumen")[0]!.consulta.get("sucursales")).toBe(IDS.T3);
    expect(q("[data-testid=cfo-sucursal-descartada]")!.textContent).toContain("solo lo que sí puedes ver");
  });

  it("sucursales con basura en la URL (`abc,<script>,../x,t1`) se descartan sin pedir nada raro", async () => {
    const api = crearApiCfo();
    montar(api, { url: `/restaurantes/demo/cfo/resumen?${RANGO}&sucursales=${encodeURIComponent("abc,<script>,../x,t1")}` });
    await cuando(() => q("[data-testid=hallazgo]") !== null, "resumen");
    expect(api.registro.every((r) => !r.consulta.has("sucursales"))).toBe(true);
  });

  it("elegir un atajo de rango cambia la URL y vuelve a pedir; «Personalizado» valida el máximo de 400 días", async () => {
    const api = crearApiCfo();
    montar(api);
    await cuando(() => q("[data-testid=filtro-rango]") !== null, "barra");
    changeValue(q("[data-testid=filtro-rango]") as HTMLSelectElement, "30d");
    await cuando(() => params().get("desde") === "2026-08-30", "URL con 30 días");
    expect(params().get("hasta")).toBe("2026-09-28");
    await cuando(() => api.peticiones("GET", "/resumen").some((r) => r.consulta.get("desde") === "2026-08-30"), "pidió con 30 d");

    changeValue(q("[data-testid=filtro-rango]") as HTMLSelectElement, "personalizado");
    await cuando(() => document.getElementById("cfo-desde") !== null, "campos de fecha");
    changeValue(document.getElementById("cfo-desde") as HTMLInputElement, "2024-01-01");
    await cuando(() => texto().includes("El rango máximo es de 400 días."), "error de rango");
    expect(params().get("desde")).toBe("2026-08-30"); // el rango inválido no se aplica
    changeValue(document.getElementById("cfo-desde") as HTMLInputElement, "2026-09-01");
    await cuando(() => params().get("desde") === "2026-09-01", "rango válido aplicado");
  });

  it("«Comparar contra» se escribe en la URL", async () => {
    montar(crearApiCfo());
    await cuando(() => q("[data-testid=filtro-comparar]") !== null, "barra");
    changeValue(q("[data-testid=filtro-comparar]") as HTMLSelectElement, "mismo_dia_semana_4");
    await cuando(() => params().get("comparar") === "mismo_dia_semana_4", "comparar en la URL");
  });

  it("«Todas» vs selección múltiple: quitar «Todas» al elegir una; elegir otra la suma; «Todas» limpia la URL", async () => {
    const api = crearApiCfo();
    montar(api);
    await cuando(() => q("[data-testid=filtro-sucursales]") !== null, "barra");
    expect(q("[data-testid=filtro-sucursales]")!.textContent).toContain("Todas las sucursales");
    click(q("[data-testid=filtro-sucursales]")!);
    await cuando(() => casilla("Todas") !== undefined, "popover");
    expect(casilla("Todas")!.checked).toBe(true);
    expect(casilla("Pensiones")!.checked).toBe(false);

    click(casilla("Prolongación Montejo")!);
    await cuando(() => params().get("sucursales") === IDS.T1, "una sucursal");
    expect(casilla("Todas")!.checked).toBe(false);
    click(casilla("Francisco de Montejo")!);
    await cuando(() => params().get("sucursales") === `${IDS.T1},${IDS.T2}`, "dos sucursales");
    expect(q("[data-testid=filtro-sucursales]")!.textContent).toContain("2 sucursales");
    await cuando(() => api.peticiones("GET", "/resumen").some((r) => r.consulta.get("sucursales") === `${IDS.T1},${IDS.T2}`), "pidió con dos");

    // Quitar la última selección regresa a «Todas».
    click(casilla("Prolongación Montejo")!);
    click(casilla("Francisco de Montejo")!);
    await cuando(() => !params().has("sucursales"), "sin sucursales");
    expect(q("[data-testid=filtro-sucursales]")!.textContent).toContain("Todas las sucursales");
  });

  it("conmutador Total / Por sucursal: se refleja en la URL y cambia la presentación de los indicadores", async () => {
    montar(crearApiCfo());
    await cuando(() => q("[data-testid=kpis]") !== null, "KPI en total");
    expect(q("table[aria-label='Indicadores por sucursal']")).toBeNull();
    click(document.body.querySelector("input[name=cfo-vista][value=sucursal]")!);
    await cuando(() => params().get("vista") === "sucursal", "vista en la URL");
    await cuando(() => q("table[aria-label='Indicadores por sucursal']") !== null, "tabla por sucursal");
    expect(q("[data-testid=kpis]")).toBeNull();
    // Una columna por sucursal más el total.
    expect([...q("table[aria-label='Indicadores por sucursal']")!.querySelectorAll("thead th")].map((th) => th.textContent?.trim())).toEqual(["Indicador", "Prolongación Montejo", "Francisco de Montejo", "Pensiones", "Victory Platz", "Altabrisa", "Galerías", "Chicxulub", "Total"]);
  });
});

describe("<CfoLayout /> · pestañas", () => {
  it("las 4 pestañas salen del registro, conservan los filtros y marcan la actual con aria-current", async () => {
    montar(crearApiCfo(), { url: `/restaurantes/demo/cfo/ventas?${RANGO}&sucursales=${IDS.T3}` });
    await cuando(() => q("[data-testid=cfo-ventas]") !== null, "ventas");
    const nav = q("nav[aria-label='Secciones del CFO']")!;
    expect([...nav.querySelectorAll("a")].map((a) => a.textContent?.trim())).toEqual(["Resumen", "Ventas", "Sucursales", "Estado de resultados"]);
    expect(nav.querySelector("a[aria-current=page]")!.textContent?.trim()).toBe("Ventas");
    const href = nav.querySelector<HTMLAnchorElement>("[data-testid=pestana-sucursales]")!.getAttribute("href")!;
    expect(href).toContain("/restaurantes/demo/cfo/sucursales?");
    expect(href).toContain(`sucursales=${IDS.T3}`);
    expect(href).toContain("desde=2026-09-21");
    // Foco visible (teclado): los enlaces de pestaña llevan anillo de foco.
    expect(nav.querySelector("a")!.className).toContain("focus-visible:ring");
    click(nav.querySelector("[data-testid=pestana-estado-resultados]")!);
    await cuando(() => q("[data-testid=cfo-pyl]") !== null, "estado de resultados");
    expect(ubicacion.startsWith("/restaurantes/demo/cfo/estado-resultados")).toBe(true);
  });
});

describe("<CfoLayout /> · exportar (CFO-06)", () => {
  it("owner ve Exportar Excel / PDF; staff no (ni siquiera entra); el botón llama a la ruta de CFO-06 con la vista de la pestaña", async () => {
    const guardados: string[] = [];
    // jsdom no trae createObjectURL/revokeObjectURL.
    (URL as unknown as { createObjectURL?: unknown }).createObjectURL ??= () => "";
    (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL ??= () => undefined;
    const crear = vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      guardados.push("blob");
      return "blob:x";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const api = crearApiCfo({ "GET /exportar": { status: 200, cuerpo: {} } });
    montar(api, { url: `/restaurantes/demo/cfo/sucursales?${RANGO}` });
    await cuando(() => boton("Exportar Excel") !== undefined, "botones de exportar");
    expect(boton("Exportar PDF")).toBeDefined();
    click(boton("Exportar Excel")!);
    await cuando(() => api.peticiones("GET", "/exportar").length === 1, "pidió exportar");
    const p = api.peticiones("GET", "/exportar")[0]!.consulta;
    expect(p.get("formato")).toBe("xlsx");
    expect(p.get("vista")).toBe("sucursales");
    expect(p.get("desde")).toBe("2026-09-21");
    await cuando(() => guardados.length === 1, "entregó el archivo");
    expect(crear).toHaveBeenCalledTimes(1);
  });

  it("si la ruta de exportación responde 404 (CFO-06 aún no está), el botón se oculta y la pantalla sigue sana", async () => {
    const api = crearApiCfo({ "GET /exportar": { status: 404 } });
    montar(api);
    await cuando(() => boton("Exportar PDF") !== undefined, "botones");
    click(boton("Exportar PDF")!);
    await cuando(() => boton("Exportar PDF") === undefined, "se ocultó");
    expect(boton("Exportar Excel")).toBeUndefined();
    expect(q("[data-testid=kpi-cfo]")).not.toBeNull();
  });
});

describe("<CfoLayout /> · admin acotado", () => {
  it("«Todas» dice «Tus N sucursales» y la lista solo trae las suyas", async () => {
    // Alcance acotado a 2 sucursales y sin «No asignado».
    const base = await (await crearApiCfo().fetch(`${API}/v1/restaurantes/${PROPIEDAD}/admin/cfo/alcance`)).json();
    const acotado = { ...base, organizacionCompleta: false, sucursales: base.sucursales.filter((s: { propertyId: string }) => [IDS.T1, IDS.T2].includes(s.propertyId as never)) };
    const api2 = crearApiCfo({ "GET /alcance": { status: 200, cuerpo: acotado } });
    montar(api2);
    await cuando(() => q("[data-testid=filtro-sucursales]") !== null, "barra");
    expect(q("[data-testid=filtro-sucursales]")!.textContent).toContain("Tus 2 sucursales");
    click(q("[data-testid=filtro-sucursales]")!);
    await cuando(() => casilla("Tus 2 sucursales") !== undefined, "popover");
    expect([...document.body.querySelectorAll("fieldset input[type=checkbox]")].map((i) => i.closest("label")?.textContent?.trim())).toEqual(["Tus 2 sucursales", "Prolongación Montejo", "Francisco de Montejo"]);
    // La lista de sucursales elegibles NO trae las que el admin no tiene (Pensiones, Altabrisa…).
    expect(document.body.querySelector("fieldset")!.textContent).not.toContain("Pensiones");
  });
});

describe("<CfoLayout /> · drill-down desde la URL", () => {
  it("?pedidos=1 abre la lista de pedidos (sin PII) con el filtro de la URL", async () => {
    const api = crearApiCfo();
    montar(api, { url: `/restaurantes/demo/cfo/ventas?${RANGO}&pedidos=1&status=cancelado` });
    await cuando(() => document.body.querySelector("[data-testid=pedidos-drill]") !== null && document.body.querySelectorAll("[data-pedido]").length > 0, "lista de pedidos");
    const pedidos = api.peticiones("GET", "/pedidos");
    expect(JSON.parse(pedidos[0]!.consulta.get("filtro")!)).toEqual({ status: "cancelado" });
    const dialogo = document.body.querySelector("[data-testid=pedidos-drill]")!;
    expect(dialogo.textContent).toContain("Cancelados");
    expect(dialogo.textContent).not.toMatch(/@|\+?\d{10}/);
    // Cierra: quita el estado del drill de la URL.
    click([...dialogo.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cerrar")!);
    await cuando(() => !params().has("pedidos"), "cerrado");
    expect(params().has("status")).toBe(false);
  });

  it("«Cargar más» pide la página siguiente con el cursor y agrega filas (hay más cuando el API trae cursor)", async () => {
    const api = crearApiCfo();
    montar(api, { url: `/restaurantes/demo/cfo/ventas?${RANGO}&pedidos=1` });
    await cuando(() => document.body.querySelectorAll("[data-pedido]").length === 25, "primera página");
    expect(document.body.querySelector("[data-testid=pedidos-conteo]")!.textContent).toContain("hay más");
    click(boton("Cargar más")!);
    await cuando(() => document.body.querySelectorAll("[data-pedido]").length === 50, "segunda página");
    const segunda = api.peticiones("GET", "/pedidos")[1]!;
    expect(segunda.consulta.get("cursor")).toMatch(/^2026-09-\d{2}\|\d+$/);
    // Sin duplicados entre páginas.
    const ids = [...document.body.querySelectorAll("[data-pedido]")].map((e) => e.getAttribute("data-pedido"));
    expect(new Set(ids).size).toBe(50);
  });
});
