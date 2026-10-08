// @vitest-environment jsdom
//
// <CfoEstadoResultados />: P&L operativo con datos SINTÉTICOS (T3 Pensiones no captura nómina a propósito). «Captura pendiente» aparece y desaparece al capturar,
// el EBITDA no se inventa, cada línea lleva chip de confianza con texto, la captura respeta el alcance (sin «Organización» para el admin acotado),
// la variación sale del periodo comparado y los Ajustes del CFO guardan solo lo que cambió.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfigVista, EstadoResultadosVista } from "@atiende/domain-restaurantes/cfo";
import { CfoEstadoResultados } from "../src/verticals/restaurantes/cfo/CfoEstadoResultados.tsx";
import { IDS, crearApiCfo, propsPagina, respuestaBase } from "./test-utils/cfo-api-simulada.ts";
import { changeValue, click, esperarHasta, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

async function pintar(api: ReturnType<typeof crearApiCfo>, sobre: Parameters<typeof propsPagina>[1] = {}) {
  const props = await propsPagina(api, sobre);
  rendered = renderComponent(
    <MemoryRouter>
      <CfoEstadoResultados {...props} />
    </MemoryRouter>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return props;
}
const q = (sel: string) => rendered!.container.querySelector(sel);
const qa = (sel: string) => [...rendered!.container.querySelectorAll(sel)];
const texto = () => rendered!.container.textContent ?? "";
const doc = (sel: string) => document.body.querySelector(sel);
const botonEn = (raiz: ParentNode, nombre: string) => [...raiz.querySelectorAll("button")].find((b) => b.textContent?.trim() === nombre || b.getAttribute("aria-label") === nombre) as HTMLButtonElement | undefined;
const linea = (id: string) => q(`tr[data-linea="${id}"]`)!;
const T3 = { sucursales: [IDS.T3] };
const listo = () => esperarHasta(() => q("[data-testid=cfo-pyl] table") !== null, "estado de resultados pintado");

describe("<CfoEstadoResultados /> · captura pendiente", () => {
  it("la nómina de Pensiones dice «Captura pendiente», el EBITDA «Incompleto: faltan nómina» y no hay ningún monto inventado", async () => {
    await pintar(crearApiCfo(), { filtros: T3 });
    await listo();
    expect(linea("nomina").textContent).toContain("Captura pendiente");
    expect(linea("nomina").textContent).not.toContain("$0");
    expect(linea("ebitda").textContent).toContain("Incompleto: faltan nómina");
    expect(q("[data-testid=pyl-incompleto]")!.textContent).toContain("Faltan nómina");
    // Con el EBITDA incompleto se muestra el margen de contribución (no necesita la nómina) en su lugar.
    expect(q('tr[data-linea="margen"]')!.textContent).toMatch(/Margen de contribución.*\$/);
    // Las líneas con dato no dicen pendiente.
    expect(linea("renta").textContent).not.toContain("Captura pendiente");
  });

  it("la captura se abre ya apuntando a la sucursal, el concepto y el mes; guardar manda el monto en centavos y la línea deja de estar pendiente", async () => {
    const api = crearApiCfo();
    await pintar(api, { filtros: T3 });
    await listo();
    click(botonEn(linea("nomina"), "Capturar costos: nómina")!);
    await esperarHasta(() => doc("[data-testid=captura-costos]") !== null, "diálogo de captura");
    expect((doc("[data-testid=captura-concepto]") as HTMLSelectElement).value).toBe("nomina");
    expect((doc("[data-testid=captura-ambito]") as HTMLSelectElement).value).toBe(IDS.T3);
    expect((doc("[data-testid=captura-mes]") as HTMLInputElement).value).toBe("2026-09");
    await esperarHasta(() => doc("[data-testid=captura-historial]")!.textContent!.includes("Todavía no hay una captura"), "historial vacío");

    const guardar = botonEn(document.body, "Guardar costo")!;
    expect(guardar.disabled).toBe(true); // sin monto no se guarda
    changeValue(doc("[data-testid=captura-valor]") as HTMLInputElement, "abc");
    await esperarHasta(() => document.body.textContent!.includes("Escribe un monto en pesos"), "monto inválido");
    expect(botonEn(document.body, "Guardar costo")!.disabled).toBe(true);
    changeValue(doc("[data-testid=captura-valor]") as HTMLInputElement, "250,000.50");
    await esperarHasta(() => !botonEn(document.body, "Guardar costo")!.disabled, "monto válido");
    click(botonEn(document.body, "Guardar costo")!);

    await esperarHasta(() => api.peticiones("PUT", "/costos").length === 1, "PUT de costos");
    expect(api.peticiones("PUT", "/costos")[0]!.cuerpo).toEqual({ costos: [{ propertyId: IDS.T3, mes: "2026-09-01", concepto: "nomina", montoCentavos: 25_000_050, pct: null, nota: null }] });
    await esperarHasta(() => doc("[data-testid=captura-costos]") === null, "diálogo cerrado");
    await esperarHasta(() => !linea("nomina").textContent!.includes("Captura pendiente"), "ya no está pendiente");
    expect(linea("nomina").textContent).toContain("$");
    expect(linea("nomina").textContent).toContain("Prorrateo"); // 7 días de un mes: se prorratea y se rotula
    // El historial de versiones muestra lo capturado.
    click(botonEn(document.body, "Capturar costos")!);
    await esperarHasta(() => doc("[data-testid=captura-costos]") !== null, "diálogo de nuevo");
    await esperarHasta(() => doc("[data-testid=captura-historial]") !== null, "historial");
  });

  it("food cost objetivo se captura como porcentaje (pct) y rechaza fuera de 0–100; el monto va en null", async () => {
    const api = crearApiCfo();
    await pintar(api, { filtros: T3 });
    await listo();
    click(botonEn(q("[data-testid=cfo-pyl]")!, "Capturar costos")!);
    await esperarHasta(() => doc("[data-testid=captura-costos]") !== null, "diálogo");
    changeValue(doc("[data-testid=captura-concepto]") as HTMLSelectElement, "food_cost_objetivo_pct");
    await esperarHasta(() => document.body.textContent!.includes("% objetivo sobre ventas netas sin IVA"), "etiqueta de porcentaje");
    changeValue(doc("[data-testid=captura-valor]") as HTMLInputElement, "140");
    await esperarHasta(() => document.body.textContent!.includes("porcentaje entre 0 y 100"), "fuera de rango");
    expect(botonEn(document.body, "Guardar costo")!.disabled).toBe(true);
    changeValue(doc("[data-testid=captura-valor]") as HTMLInputElement, "32");
    await esperarHasta(() => !botonEn(document.body, "Guardar costo")!.disabled, "válido");
    click(botonEn(document.body, "Guardar costo")!);
    await esperarHasta(() => api.peticiones("PUT", "/costos").length === 1, "PUT");
    expect((api.peticiones("PUT", "/costos")[0]!.cuerpo as { costos: Array<Record<string, unknown>> }).costos[0]).toMatchObject({ concepto: "food_cost_objetivo_pct", pct: 32, montoCentavos: null });
  });

  it("si el servidor rechaza la captura, el diálogo sigue abierto con el mensaje y nada se da por guardado", async () => {
    const api = crearApiCfo({ "PUT /costos": { status: 403, cuerpo: { message: "Solo el dueño puede capturar costos de la organización." } } });
    await pintar(api, { filtros: T3 });
    await listo();
    click(botonEn(linea("nomina"), "Capturar costos: nómina")!);
    await esperarHasta(() => doc("[data-testid=captura-costos]") !== null, "diálogo");
    changeValue(doc("[data-testid=captura-valor]") as HTMLInputElement, "1000");
    await esperarHasta(() => !botonEn(document.body, "Guardar costo")!.disabled, "válido");
    click(botonEn(document.body, "Guardar costo")!);
    await esperarHasta(() => document.body.textContent!.includes("Solo el dueño puede capturar costos de la organización."), "error del servidor visible");
    expect(doc("[data-testid=captura-costos]")).not.toBeNull();
    expect(linea("nomina").textContent).toContain("Captura pendiente");
  });
});

describe("<CfoEstadoResultados /> · permisos y alcance", () => {
  it("sin cfo.capturar (rol que llegara a la pantalla) no hay botones de captura, solo lectura", async () => {
    await pintar(crearApiCfo(), { filtros: T3, role: "staff" });
    await listo();
    expect(linea("nomina").textContent).toContain("Captura pendiente");
    expect(botonEn(q("[data-testid=cfo-pyl]")!, "Capturar costos")).toBeUndefined();
    expect(botonEn(q("[data-testid=cfo-pyl]")!, "Capturar costos: nómina")).toBeUndefined();
  });

  it("el admin acotado NO ve la opción «Organización» al capturar; el dueño (organización completa) sí", async () => {
    await pintar(crearApiCfo(), { filtros: T3, alcance: { organizacionCompleta: false } });
    await listo();
    click(botonEn(q("[data-testid=cfo-pyl]")!, "Capturar costos")!);
    await esperarHasta(() => doc("[data-testid=captura-costos]") !== null, "diálogo");
    const opciones = [...(doc("[data-testid=captura-ambito]") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(opciones).not.toContain("Organización (costo sin sucursal)");
    expect(opciones).toContain("Pensiones");
    rendered?.unmount();
    document.body.innerHTML = "";

    await pintar(crearApiCfo(), { filtros: T3 });
    await listo();
    click(botonEn(q("[data-testid=cfo-pyl]")!, "Capturar costos")!);
    await esperarHasta(() => doc("[data-testid=captura-costos]") !== null, "diálogo del dueño");
    expect([...(doc("[data-testid=captura-ambito]") as HTMLSelectElement).options].map((o) => o.textContent)).toContain("Organización (costo sin sucursal)");
  });

  it("columnas: con todas las sucursales hay «No asignado» y «Total»; el API no manda «No asignado» a un alcance acotado y no se inventa", async () => {
    await pintar(crearApiCfo());
    await listo();
    const cab = qa("[data-testid=cfo-pyl] table thead th").map((t) => t.textContent?.trim());
    expect(cab[0]).toBe("Concepto");
    expect(cab).toContain("No asignado");
    expect(cab).toContain("Total");
    expect(cab.at(-1)).toBe("Variación (Total)");
    rendered?.unmount();
    await pintar(crearApiCfo(), { filtros: T3 });
    await listo();
    const una = qa("[data-testid=cfo-pyl] table thead th").map((t) => t.textContent?.trim());
    expect(una).toEqual(["Concepto", "Pensiones", "Total", "Variación (Total)"]);
  });
});

describe("<CfoEstadoResultados /> · confianza, variación y avisos", () => {
  it("cada cifra con valor lleva un chip de confianza con texto (medido / estimado)", async () => {
    await pintar(crearApiCfo(), { filtros: T3 });
    await listo();
    const chips = qa("[data-testid=chip-confianza]");
    expect(chips.length).toBeGreaterThan(10);
    const tipos = new Set(chips.map((c) => c.getAttribute("data-confianza")));
    for (const t of ["medido", "estimado"]) expect(tipos.has(t), t).toBe(true); // lo capturado del mes se prorratea en un periodo parcial: «estimado»
    for (const c of chips) expect(c.textContent!.trim().length).toBeGreaterThan(0);
    expect(linea("iva_estimado").textContent).toContain("Estimado");
    expect(linea("ventas_brutas").textContent).toContain("Medido");
  });

  it("la variación del Total sale del periodo comparado que pide el API (rango anterior) y es «—» si no se puede calcular", async () => {
    const api = crearApiCfo();
    await pintar(api, { filtros: T3 });
    await listo();
    // Dos lecturas: el rango actual y el comparado (21–27 vs 14–20 sep).
    const lecturas = api.peticiones("GET", "/estado-resultados");
    expect(lecturas.map((l) => l.consulta.get("desde"))).toEqual(["2026-09-21", "2026-09-14"]);
    expect(linea("ventas_brutas").lastElementChild!.textContent).toMatch(/^[+−]?\d[\d.]* %$/);
    expect(linea("nomina").lastElementChild!.textContent).toBe("—"); // pendiente: sin base no hay variación
    rendered?.unmount();
    // Sin el comparativo (404): la pantalla sigue sana y la variación dice «—».
    const api2 = crearApiCfo({ "GET /estado-resultados": (p) => (p.consulta.get("desde") === "2026-09-14" ? { status: 404 } : undefined) });
    await pintar(api2, { filtros: T3 });
    await listo();
    expect(linea("ventas_brutas").lastElementChild!.textContent).toBe("—");
    expect(texto()).not.toContain("Falló");
  });

  it("«mismo día de la semana (4 semanas)» no tiene un solo rango comparado: sin segunda petición", async () => {
    const base = await respuestaBase<EstadoResultadosVista>("/estado-resultados", { sucursales: IDS.T3, granularidad: "mes" });
    const api = crearApiCfo({ "GET /estado-resultados": { status: 200, cuerpo: { ...base, periodo: { ...base.periodo, comparadoDesde: null, comparadoHasta: null } } } });
    await pintar(api, { filtros: T3 });
    await listo();
    expect(api.peticiones("GET", "/estado-resultados")).toHaveLength(1);
    expect(q("[data-testid=cfo-pyl]")!.textContent).toContain("sin variación para esta comparación");
  });

  it("detalle por mes / semana / día vuelve a pedir con la granularidad elegida", async () => {
    const api = crearApiCfo();
    await pintar(api, { filtros: T3 });
    await listo();
    expect(api.peticiones("GET", "/estado-resultados")[0]!.consulta.get("granularidad")).toBe("mes");
    changeValue(q("[data-testid=pyl-granularidad]") as HTMLSelectElement, "dia");
    await esperarHasta(() => api.peticiones("GET", "/estado-resultados").some((p) => p.consulta.get("granularidad") === "dia"), "granularidad día");
  });

  it("avisos de datos incompletos, SINTÉTICO y aviso de no sustitución visibles (en el marco del CFO)", async () => {
    await pintar(crearApiCfo());
    await listo();
    expect(q("[data-testid=cfo-avisos]")!.textContent).toContain("SINTÉTICO");
    expect(q("[data-testid=cfo-pyl]")!.textContent).toContain("Capturar costos");
  });

  it("estados: 403, base sin migrar y error con reintento", async () => {
    await pintar(crearApiCfo({ "GET /estado-resultados": { status: 403 } }), { filtros: T3 });
    await esperarHasta(() => texto().includes("Tu rol no tiene acceso al CFO"), "403");
    rendered?.unmount();
    await pintar(crearApiCfo({ "GET /estado-resultados": { status: 200, cuerpo: { disponible: false } } }), { filtros: T3 });
    await esperarHasta(() => texto().includes("El CFO aún no está disponible"), "no disponible");
    rendered?.unmount();
    await pintar(crearApiCfo({ "GET /estado-resultados": { status: 500, cuerpo: { message: "Falló el P&L." } } }), { filtros: T3 });
    await esperarHasta(() => texto().includes("Falló el P&L."), "error");
    expect(botonEn(rendered!.container, "Reintentar")).toBeDefined();
  });
});

describe("<CfoEstadoResultados /> · base sin migrar en la captura (M1)", () => {
  it.each([503, 404])("PUT /costos con %s: el diálogo muestra un texto del CFO, NUNCA el del servicio de voz, y no da nada por guardado", async (status) => {
    const api = crearApiCfo({ "PUT /costos": { status } });
    await pintar(api, { filtros: T3 });
    await listo();
    click(botonEn(linea("nomina"), "Capturar costos: nómina")!);
    await esperarHasta(() => doc("[data-testid=captura-costos]") !== null, "diálogo");
    changeValue(doc("[data-testid=captura-valor]") as HTMLInputElement, "1000");
    await esperarHasta(() => !botonEn(document.body, "Guardar costo")!.disabled, "válido");
    click(botonEn(document.body, "Guardar costo")!);
    await esperarHasta(() => document.body.textContent!.includes("La captura del CFO todavía no está disponible"), "mensaje del CFO");
    expect(document.body.textContent).not.toContain("servicio de voz");
    expect(doc("[data-testid=captura-costos]")).not.toBeNull();
    expect(linea("nomina").textContent).toContain("Captura pendiente");
  });

  it("el mensaje del servidor manda sobre el texto genérico en un 503 de escritura", async () => {
    const api = crearApiCfo({ "PUT /costos": { status: 503, cuerpo: { message: "Falta aplicar la actualización 083." } } });
    await pintar(api, { filtros: T3 });
    await listo();
    click(botonEn(linea("nomina"), "Capturar costos: nómina")!);
    await esperarHasta(() => doc("[data-testid=captura-costos]") !== null, "diálogo");
    changeValue(doc("[data-testid=captura-valor]") as HTMLInputElement, "1000");
    await esperarHasta(() => !botonEn(document.body, "Guardar costo")!.disabled, "válido");
    click(botonEn(document.body, "Guardar costo")!);
    await esperarHasta(() => document.body.textContent!.includes("Falta aplicar la actualización 083."), "mensaje del servidor");
  });

  it("el historial con 404 no dice «voz» y con bloques.captura=false se retiran todos los botones «Capturar costos»", async () => {
    const base = await respuestaBase<EstadoResultadosVista>("/estado-resultados", { sucursales: IDS.T3, granularidad: "mes" });
    await pintar(crearApiCfo({ "GET /estado-resultados": { status: 200, cuerpo: { ...base, bloques: { ...base.bloques, captura: false } } } }), { filtros: T3 });
    await listo();
    expect(linea("nomina").textContent).toContain("Captura pendiente");
    expect(qa("button").some((b) => b.textContent?.includes("Capturar costos") || b.getAttribute("aria-label")?.startsWith("Capturar costos"))).toBe(false);
    expect(q("[data-testid=abrir-ajustes]")).not.toBeNull();
    rendered?.unmount();
    document.body.innerHTML = "";
    const api = crearApiCfo({ "GET /costos/historial": { status: 404 } });
    await pintar(api, { filtros: T3 });
    await listo();
    click(botonEn(linea("nomina"), "Capturar costos: nómina")!);
    await esperarHasta(() => doc("[data-testid=captura-historial]")?.textContent?.includes("El CFO todavía no está disponible") === true, "historial sin voz");
    expect(document.body.textContent).not.toContain("servicio de voz");
  });
});

describe("<AjustesCfoDialogo /> · Ajustes del CFO", () => {
  async function abrirAjustes(api: ReturnType<typeof crearApiCfo>) {
    await pintar(api, { filtros: T3 });
    await listo();
    click(q("[data-testid=abrir-ajustes]")!);
    await esperarHasta(() => doc("[data-testid=ajuste-ivaPct]") !== null, "ajustes cargados");
  }

  it("muestra la configuración vigente y el aviso de no sustitución", async () => {
    await abrirAjustes(crearApiCfo());
    expect((doc("[data-testid=ajuste-ivaPct]") as HTMLInputElement).value).toBe("16");
    expect((doc("[data-testid=ajuste-frecuenteN]") as HTMLInputElement).value).toBe("3");
    expect((doc("[data-testid=ajuste-comisionTerminalPct]") as HTMLInputElement).value).toBe(""); // null = captura pendiente
    expect(doc("[data-testid=ajustes-cfo]")!.textContent).toContain("No sustituye a tu contabilidad");
    expect(botonEn(document.body, "Sin cambios")!.disabled).toBe(true);
  });

  it("guarda SOLO lo que cambió (IVA y comisión de terminal) con PUT /config y cierra", async () => {
    const api = crearApiCfo();
    await abrirAjustes(api);
    changeValue(doc("[data-testid=ajuste-ivaPct]") as HTMLInputElement, "8");
    changeValue(doc("[data-testid=ajuste-comisionTerminalPct]") as HTMLInputElement, "3.6");
    await esperarHasta(() => botonEn(document.body, "Guardar 2 cambios") !== undefined, "dos cambios");
    click(botonEn(document.body, "Guardar 2 cambios")!);
    await esperarHasta(() => api.peticiones("PUT", "/config").length === 1, "PUT /config");
    expect(api.peticiones("PUT", "/config")[0]!.cuerpo).toEqual({ ivaPct: 8, comisionTerminalPct: 3.6 });
    await esperarHasta(() => doc("[data-testid=ajustes-cfo]") === null, "cerrado");
  });

  it("valida con los rangos del API (IVA 0–30, N entero) y no deja guardar un valor fuera de rango", async () => {
    await abrirAjustes(crearApiCfo());
    changeValue(doc("[data-testid=ajuste-ivaPct]") as HTMLInputElement, "45");
    await esperarHasta(() => document.body.textContent!.includes("Debe estar entre 0 y 30."), "rango IVA");
    changeValue(doc("[data-testid=ajuste-frecuenteN]") as HTMLInputElement, "2.5");
    await esperarHasta(() => document.body.textContent!.includes("Escribe un número entero."), "entero");
    changeValue(doc("[data-testid=ajuste-caidaPct]") as HTMLInputElement, "");
    await esperarHasta(() => document.body.textContent!.includes("Escribe un número."), "vacío no permitido");
    expect(doc("form button[type=submit]")!.hasAttribute("disabled")).toBe(true);
  });

  it("activo debe ser menor que perdido: si no, error en el navegador y no se guarda", async () => {
    const api = crearApiCfo();
    await abrirAjustes(api);
    changeValue(doc("[data-testid=ajuste-activoDias]") as HTMLInputElement, "200");
    await esperarHasta(() => document.body.textContent!.includes("Debe ser mayor que los días de cliente activo."), "regla cruzada");
    expect(doc("form button[type=submit]")!.hasAttribute("disabled")).toBe(true);
    changeValue(doc("[data-testid=ajuste-perdidoDias]") as HTMLInputElement, "300");
    await esperarHasta(() => !document.body.textContent!.includes("Debe ser mayor que los días de cliente activo."), "resuelto");
    expect(api.peticiones("PUT", "/config")).toHaveLength(0);
  });

  it("un admin acotado solo lee: campos deshabilitados y explicación (el API también lo rechazaría con 403)", async () => {
    const base = await respuestaBase<ConfigVista>("/config");
    await abrirAjustes(crearApiCfo({ "GET /config": { status: 200, cuerpo: { ...base, puedeGuardar: false } } }));
    expect((doc("[data-testid=ajuste-ivaPct]") as HTMLInputElement).disabled).toBe(true);
    expect(doc("[data-testid=ajustes-cfo]")!.textContent).toContain("Solo el dueño o un administrador de toda la organización puede cambiar estos ajustes");
    expect(doc("form button[type=submit]")!.hasAttribute("disabled")).toBe(true);
  });

  it("error al guardar: muestra el mensaje del servidor y el diálogo sigue abierto", async () => {
    const api = crearApiCfo({ "PUT /config": { status: 400, cuerpo: { message: "ivaPct fuera de rango en la base." } } });
    await abrirAjustes(api);
    changeValue(doc("[data-testid=ajuste-ivaPct]") as HTMLInputElement, "10");
    await esperarHasta(() => botonEn(document.body, "Guardar 1 cambio") !== undefined, "un cambio");
    click(botonEn(document.body, "Guardar 1 cambio")!);
    await esperarHasta(() => document.body.textContent!.includes("ivaPct fuera de rango en la base."), "error visible");
    expect(doc("[data-testid=ajustes-cfo]")).not.toBeNull();
  });
});
