// L-31 -- el ciclo de licitaciones por ROL (domain-licitaciones/roles.ts): lo que cada rol ve y puede en cada paso. El servidor es la
// autoridad; la SPA oculta o explica lo que rechazaria, y un rol sin permiso nunca manda la peticion. El estado de partida (go, bases
// extraidas, mapeos, contrato) lo siembra el propietario contra la API simulada; todo lo que se afirma sobre la UI son clics reales.
import { afirmarCancelarNoEscribe } from "../../helpers/dialogos.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../../helpers/humo.ts";
import { ApiCiclo, BASE, TENDER_TITULO, rutaConvocatoria } from "../../helpers/ciclo-licitaciones.ts";
import { seccionesDelPanel } from "../../helpers/navegacion.ts";

test.describe("licitaciones: ciclo por rol @viaje", () => {
  test.setTimeout(120_000);

  test("viewer: lectura en todo el ciclo, ninguna escritura y sin 'Staff'", async ({ page, iniciarSesion, mock, vigilante }) => {
    const api = new ApiCiclo(mock);
    await api.dejarGanada();
    await api.extraerRequisitos();
    await api.mapearTodo();
    await api.crearContrato();
    await iniciarSesion("licitaciones", "viewer");
    await mock.limpiarRegistro();

    await page.goto(`${BASE}/convocatorias`);
    await afirmarPantallaSana(page, "convocatorias (viewer)");
    await expect(page.getByRole("link", { name: TENDER_TITULO })).toBeVisible();
    await expect(page.getByRole("button", { name: "Nueva convocatoria" })).toHaveCount(0);
    // Staff solo para owner/admin: ni en el menu de escritorio ni en la hoja "Más" de movil.
    const secciones = await seccionesDelPanel(page);
    expect(secciones.length).toBeGreaterThanOrEqual(9);
    expect(secciones.map((e) => e.href).filter((h) => h.endsWith("/staff"))).toEqual([]);

    await page.goto(rutaConvocatoria());
    await page.getByRole("tab", { name: "Go / No-go" }).click();
    await expect(page.getByText("Tu rol (viewer) no puede tomar decisiones go/no-go.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Marcar Go" })).toHaveCount(0);
    await page.getByRole("tab", { name: "Resolución" }).click();
    await expect(page.getByText(/ya se resolvió como ganada/)).toBeVisible();

    await page.goto(rutaConvocatoria("/requisitos"));
    await expect(page.getByText("Tu rol (viewer) no puede subir documentos de bases")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Requisitos extraídos (6)" })).toBeVisible();

    await page.goto(rutaConvocatoria("/propuesta-tecnica"));
    await expect(page.getByText("Tu rol (viewer) no puede generar la propuesta técnica")).toBeVisible();
    await expect(page.getByText("Tu rol (viewer) no puede configurar el mapeo de cumplimiento")).toBeVisible();
    await expect(page.getByText("Tu rol (viewer) no puede generar la propuesta económica")).toBeVisible();

    await page.goto(rutaConvocatoria("/cierre"));
    await expect(page.getByText("Tu rol (viewer) no puede correr el checklist")).toBeVisible();
    await page.getByRole("tab", { name: "Aprobación" }).click();
    await expect(page.getByText("Tu rol (viewer) no puede aprobar secciones")).toBeVisible();
    await expect(page.getByText("Tu rol (viewer) no puede aprobar: solo propietario, administrador o analista.").first()).toBeVisible();
    await page.getByRole("tab", { name: "Paquete final" }).click();
    await expect(page.getByText("Tu rol (viewer) no puede ensamblar el paquete.")).toBeVisible();
    await page.getByRole("tab", { name: "Presentación" }).click();
    await expect(page.getByText("Tu rol (viewer) no puede declarar la presentación")).toBeVisible();

    await page.goto(rutaConvocatoria("/contrato"));
    await expect(page.getByText("Tu rol (viewer) no puede editar los metadatos del contrato.")).toBeVisible();
    await expect(page.getByLabel("Número de contrato")).toBeDisabled();
    await expect(page.getByText("Tu rol (viewer) no puede transicionar el contrato.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Aplicar transición" })).toBeDisabled();
    await expect(page.getByText("Tu rol (viewer) no puede subir documentos del contrato.")).toBeVisible();

    await page.goto(rutaConvocatoria("/post-adjudicacion"));
    await expect(page.getByText("Tu rol (viewer) no puede registrar ni marcar facturas")).toBeVisible();
    await expect(page.getByRole("button", { name: "Registrar factura" })).toHaveCount(0);

    expect(await mock.escrituras(), "un viewer nunca escribe").toEqual([]);
    vigilante.verificar();
  });

  test("writer: redacta (bases, propuestas, checklist, contrato) pero no decide ni aprueba", async ({ page, iniciarSesion, mock, vigilante }) => {
    const api = new ApiCiclo(mock);
    await api.decidirGo();
    await api.extraerRequisitos();
    await iniciarSesion("licitaciones", "writer");
    await mock.limpiarRegistro();

    await page.goto(`${BASE}/convocatorias`);
    await expect(page.getByRole("button", { name: "Nueva convocatoria" })).toBeVisible();

    await page.goto(rutaConvocatoria());
    await page.getByRole("tab", { name: "Go / No-go" }).click();
    await expect(page.getByText("Tu rol (writer) no puede tomar decisiones go/no-go.")).toBeVisible();
    await page.getByRole("tab", { name: "Resolución" }).click();
    await expect(page.getByText(/Tu rol \(writer\) no puede marcar una convocatoria ganada\/perdida/)).toBeVisible();

    await page.goto(rutaConvocatoria("/requisitos"));
    await expect(page.getByLabel("Documentos de bases (PDF o .txt)")).toBeVisible();

    await page.goto(rutaConvocatoria("/propuesta-tecnica"));
    await expect(page.getByText("Tu rol (writer) no puede configurar el mapeo de cumplimiento")).toBeVisible();
    await page.getByRole("button", { name: "Generar propuesta técnica" }).click();
    await expect(page.getByText(/sección\(es\) generada\(s\)/)).toBeVisible();
    await page.locator("#economico-concepto-0").fill("Concepto sin tarifa");
    await page.getByRole("button", { name: "Generar propuesta económica" }).click();
    await expect(page.getByText("Sin total: 1 concepto(s) sin tarifa aprobada/vigente.")).toBeVisible();
    expect((await mock.buscar({ metodo: "POST", ruta: "/proposal/technical/generate" })).length).toBe(1);
    expect(await mock.buscar({ metodo: "PUT", ruta: "/requirement-mappings/" })).toHaveLength(0);

    await page.goto(rutaConvocatoria("/cierre"));
    await expect(page.getByRole("button", { name: "Correr checklist" })).toBeVisible();
    await page.getByRole("tab", { name: "Aprobación" }).click();
    await expect(page.getByText("Tu rol (writer) no puede aprobar secciones")).toBeVisible();
    await expect(page.getByRole("button", { name: "Aprobar técnico-legal (1/2)" })).toBeDisabled();
    await page.getByRole("tab", { name: "Paquete final" }).click();
    await expect(page.getByRole("button", { name: "Ensamblar paquete" })).toBeVisible();

    // Contrato: puede registrarlo y editar metadatos, pero no las transiciones de decision.
    await page.goto(rutaConvocatoria("/contrato"));
    await page.getByRole("button", { name: "Registrar contrato" }).click();
    await expect(page.getByLabel("Número de contrato")).toBeEnabled();
    await expect(page.getByRole("option", { name: /Rescindido \(requiere rol de decisión\)/ })).toBeDisabled();
    await page.getByLabel("Nuevo estado").selectOption("contrato_firmado_declarado");
    await expect(page.getByRole("button", { name: "Aplicar transición" })).toBeEnabled();
    await page.getByLabel("Motivo (obligatorio)").fill("Contrato firmado.");
    await page.getByRole("button", { name: "Aplicar transición" }).click();
    await expect(page.getByText("Historial (2)")).toBeVisible();

    expect(await mock.buscar({ metodo: "POST", ruta: "/go-no-go" })).toHaveLength(0);
    expect(await mock.buscar({ metodo: "POST", ruta: "/expediente/approval" })).toHaveLength(0);
    vigilante.verificar();
  });

  test("reviewer: decide go/no-go y revisa la inconformidad, pero no resuelve ni mapea ni aprueba", async ({ page, iniciarSesion, mock, vigilante }) => {
    const api = new ApiCiclo(mock);
    await api.dejarGanada();
    await api.crearContrato();
    await api.extraerRequisitos();
    await api.llamar("POST", "/tenders/tnd-1/inconformidad", { hechos: ["Hecho."], agravios: ["Agravio."], pruebas: [], falloNotifiedOn: "2026-10-02", bajoTratados: false });
    await iniciarSesion("licitaciones", "reviewer");
    await mock.limpiarRegistro();

    await page.goto(rutaConvocatoria("/propuesta-tecnica"));
    await expect(page.getByText("Tu rol (reviewer) no puede configurar el mapeo de cumplimiento")).toBeVisible();

    await page.goto(rutaConvocatoria("/cierre"));
    await page.getByRole("tab", { name: "Aprobación" }).click();
    await expect(page.getByText("Tu rol (reviewer) no puede aprobar secciones")).toBeVisible();

    await page.goto(rutaConvocatoria("/post-adjudicacion"));
    await page.getByRole("tab", { name: "Inconformidades" }).click();
    await page.getByRole("button", { name: /Marcar como revisado por abogado/ }).click();
    await expect(page.getByRole("button", { name: /Marcar como revisado por abogado/ })).toHaveCount(0);
    expect(await mock.buscar({ metodo: "POST", ruta: /\/mark-reviewed$/ })).toHaveLength(1);

    // Go/No-go SI le corresponde al reviewer: en una convocatoria nueva (sin resolver) registra su decision con confirmacion en No-go.
    await page.goto(`${BASE}/convocatorias/tnd-2`);
    await page.getByRole("tab", { name: "Go / No-go" }).click();
    await page.getByLabel("Motivos (uno por línea)").fill("Fuera del giro de la empresa.");
    await afirmarCancelarNoEscribe(page, mock, page.getByRole("button", { name: "Marcar No-go" }), { nombre: /Marcar No-go/, verificarFoco: false });
    await page.getByRole("button", { name: "Marcar No-go" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Marcar No-go" }).click();
    await expect(page.getByText("NO-GO", { exact: true })).toBeVisible();
    const decisiones = await mock.buscar({ metodo: "POST", ruta: "/go-no-go" });
    expect(decisiones).toHaveLength(1);
    expect(decisiones[0]!.cuerpo).toEqual({ decision: "no_go", reasons: ["Fuera del giro de la empresa."] });

    // Ganada/perdida es de DECISION_ROLES: el reviewer no ve el formulario.
    await page.goto(rutaConvocatoria());
    await page.getByRole("tab", { name: "Resolución" }).click();
    await expect(page.getByRole("button", { name: "Marcar perdida" })).toHaveCount(0);
    expect(await mock.buscar({ metodo: "POST", ruta: "/resolution" })).toHaveLength(0);
    vigilante.verificar();
  });

  test("analyst: resuelve, mapea y aprueba por seccion, pero no marca la inconformidad como revisada", async ({ page, iniciarSesion, mock, vigilante }) => {
    const api = new ApiCiclo(mock);
    await api.decidirGo();
    await api.extraerRequisitos();
    await api.crearContrato();
    await api.llamar("POST", "/tenders/tnd-1/inconformidad", { hechos: ["Hecho."], agravios: ["Agravio."], pruebas: ["Prueba."], falloNotifiedOn: "2026-10-02", bajoTratados: false });
    await iniciarSesion("licitaciones", "analyst");
    await mock.limpiarRegistro();

    await page.goto(rutaConvocatoria());
    await page.getByRole("tab", { name: "Resolución" }).click();
    await page.getByLabel("Motivo", { exact: true }).fill("Fallo a favor de la empresa.");
    await page.getByRole("button", { name: "Marcar ganada" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Marcar ganada" }).click();
    await expect(page.getByText("GANADA", { exact: true })).toBeVisible();
    expect(await mock.buscar({ metodo: "POST", ruta: "/resolution" })).toHaveLength(1);

    await page.goto(rutaConvocatoria("/propuesta-tecnica"));
    await page.locator("#mapeo-refkey-poder_notarial").fill("poder_notarial");
    await page.locator("#mapeo-plantilla-poder_notarial").fill("Se acompaña {value}.");
    await page.locator("form").filter({ has: page.locator("#mapeo-refkey-poder_notarial") }).getByRole("button", { name: "Guardar mapeo" }).click();
    await expect(page.getByText('Guardado: Documento de empresa · refKey "poder_notarial".')).toBeVisible();
    expect(await mock.buscar({ metodo: "PUT", ruta: "/requirement-mappings/poder_notarial" })).toHaveLength(1);

    await page.goto(rutaConvocatoria("/cierre"));
    await page.getByRole("tab", { name: "Aprobación" }).click();
    await page.getByRole("button", { name: "Aprobar sección" }).click();
    await expect(page.getByText(/Sección "technical:tecnica" aprobada/)).toBeVisible();

    await page.goto(rutaConvocatoria("/post-adjudicacion"));
    await page.getByRole("tab", { name: "Inconformidades" }).click();
    await expect(page.getByText("Tu rol (analyst) no puede marcar un borrador como revisado -- solo owner/admin/reviewer.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Marcar como revisado por abogado/ })).toHaveCount(0);
    expect(await mock.buscar({ metodo: "POST", ruta: /\/mark-reviewed$/ })).toHaveLength(0);
    vigilante.verificar();
  });
});
