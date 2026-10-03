// L-31 -- viaje del propietario por TODO el ciclo de licitaciones, con clics reales contra la API simulada con estado:
// alta de convocatoria -> go/no-go -> bases y requisitos -> propuesta tecnica y economica -> checklist y aprobacion por seccion ->
// doble aprobacion (con la segunda persona) -> paquete y descarga -> presentacion -> ganada -> contrato y documentos -> cobranza e
// inconformidad -> cierre de sesion. En cada paso se afirma la peticion exacta que salio (mock.buscar) y que Cancelar/Escape no escriben.
import { afirmarCancelarNoEscribe, dialogo } from "../../helpers/dialogos.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import type { Page } from "../../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../../helpers/humo.ts";
import { BASE, CODIGO_TOTP, CONCEPTO_CON_TARIFA, TENDER_ID, TENDER_TITULO, TEXTO_BASES, TEXTO_CONTRATO, rutaConvocatoria } from "../../helpers/ciclo-licitaciones.ts";
import type { ClienteMock } from "../../mock-api/cliente.ts";

function cuerpoDe(peticion: { cuerpo: unknown }): Record<string, unknown> {
  return peticion.cuerpo as Record<string, unknown>;
}

async function unaEscritura(mock: ClienteMock, metodo: string, ruta: string | RegExp): Promise<Record<string, unknown>> {
  const hechas = await mock.buscar({ metodo, ruta });
  expect(hechas, `se esperaba exactamente un ${metodo} ${String(ruta)}`).toHaveLength(1);
  return cuerpoDe(hechas[0]!);
}

async function aprobarEtapa(page: Page, boton: string, resultado: string): Promise<void> {
  await page.getByRole("button", { name: boton }).click();
  await dialogo(page, /Confirma tu identidad/).getByLabel("Código de verificación en dos pasos").fill(CODIGO_TOTP);
  await dialogo(page, /Confirma tu identidad/).getByRole("button", { name: "Aprobar" }).click();
  await expect(page.getByText(resultado)).toBeVisible();
}

test.describe("licitaciones: viaje del propietario @viaje", () => {
  test.setTimeout(240_000);

  test("del alta de la convocatoria a la cobranza, y cierre de sesion", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");

    // ---- 1. Convocatorias: lista con score y alta manual (Cancelar/Escape no escriben).
    await test.step("convocatorias: lista, alta manual y validacion", async () => {
      await page.goto(`${BASE}/convocatorias`);
      await afirmarPantallaSana(page, "convocatorias");
      await expect(page.getByRole("link", { name: TENDER_TITULO })).toBeVisible();
      await expect(page.getByText("72").first()).toBeVisible();

      const nueva = page.getByRole("button", { name: "Nueva convocatoria" });
      await afirmarCancelarNoEscribe(page, mock, nueva, { nombre: "Nueva convocatoria", verificarFoco: false }); // foco: BUG-E2E-001 (docs/QA-E2E.md)

      await nueva.click();
      const formulario = dialogo(page, "Nueva convocatoria");
      await formulario.getByRole("button", { name: "Guardar convocatoria" }).click();
      // `required` nativo: sin titulo el navegador no envia el formulario y nada sale a la red.
      expect(await mock.escrituras()).toEqual([]);
      await formulario.getByLabel("Título *").fill("Mantenimiento de parques municipales");
      await formulario.getByLabel(/Folio/).fill("LA-77/2026");
      await formulario.getByLabel("Entidad convocante").fill("Ayuntamiento de Progreso");
      await formulario.getByLabel("Presupuesto estimado (MXN)").fill("950000");
      await formulario.getByRole("button", { name: "Guardar convocatoria" }).click();
      await expect(page.getByRole("link", { name: "Mantenimiento de parques municipales" })).toBeVisible();
      const cuerpo = await unaEscritura(mock, "POST", /\/tenders$/);
      expect(cuerpo).toMatchObject({ title: "Mantenimiento de parques municipales", externalId: "LA-77/2026", contractingBody: "Ayuntamiento de Progreso", budgetAmount: 950000 });
    });

    // ---- 2. Go/No-go de la convocatoria principal.
    await test.step("go/no-go: motivos obligatorios, No-go con confirmacion y Go registrado", async () => {
      await page.goto(rutaConvocatoria());
      await expect(page.getByRole("heading", { level: 1, name: TENDER_TITULO })).toBeVisible();
      await page.getByRole("tab", { name: "Go / No-go" }).click();
      await expect(page.getByText("Sin decisiones registradas todavía.")).toBeVisible();

      await mock.limpiarRegistro();
      await page.getByRole("button", { name: "Marcar Go" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Escribe al menos un motivo" })).toBeVisible();
      expect(await mock.escrituras()).toEqual([]);

      await page.getByLabel("Motivos (uno por línea)").fill("Encaja con la especialidad de la empresa.\nHay capacidad de residente de obra.");
      await afirmarCancelarNoEscribe(page, mock, page.getByRole("button", { name: "Marcar No-go" }), { nombre: /Marcar No-go/, verificarFoco: false });

      await page.getByRole("button", { name: "Marcar Go" }).click();
      await expect(page.getByText("GO", { exact: true })).toBeVisible();
      await expect(page.getByText("Score al decidir: 72")).toBeVisible();
      expect(await unaEscritura(mock, "POST", "/go-no-go")).toEqual({ decision: "go", reasons: ["Encaja con la especialidad de la empresa.", "Hay capacidad de residente de obra."] });
      // El estatus de la ficha se recarga del servidor.
      await expect(page.getByText("Go", { exact: true }).first()).toBeVisible();
    });

    // ---- 3. Bases y requisitos.
    await test.step("requisitos: subir bases, un documento escaneado se excluye y se reporta", async () => {
      await page.getByRole("link", { name: /Subir bases y ver requisitos extraídos/ }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Requisitos de las bases" })).toBeVisible();
      await expect(page.getByText("Todavía no hay requisitos extraídos")).toBeVisible();

      await mock.limpiarRegistro();
      await expect(page.getByRole("button", { name: "Extraer requisitos" })).toBeDisabled();
      await page.getByLabel("Documentos de bases (PDF o .txt)").setInputFiles([
        { name: "bases.txt", mimeType: "text/plain", buffer: Buffer.from(TEXTO_BASES) },
        { name: "escaneado.txt", mimeType: "text/plain", buffer: Buffer.from("") },
      ]);
      // Quitar un archivo pendiente es solo estado local: no escribe.
      await page.getByRole("button", { name: "Quitar" }).nth(1).click();
      expect(await mock.escrituras()).toEqual([]);
      await page.getByLabel("Documentos de bases (PDF o .txt)").setInputFiles({ name: "escaneado.txt", mimeType: "text/plain", buffer: Buffer.from("") });
      await page.getByRole("button", { name: "Extraer requisitos" }).click();

      await expect(page.getByRole("heading", { name: "Requisitos extraídos (6)" })).toBeVisible();
      await expect(page.getByText(/1 documento\(s\) no produjeron texto extraíble/)).toBeVisible();
      await expect(page.getByText(/escaneado\.txt|"escaneado.txt"/).first()).toBeVisible();
      await expect(page.getByText("Evidencia requerida: poder notarial").first()).toBeVisible();
      const cuerpo = await unaEscritura(mock, "POST", "/requirements/extract");
      expect((cuerpo["documents"] as unknown[]).length).toBe(2);
    });

    // ---- 4. Propuesta tecnica y economica.
    await test.step("propuesta tecnica: bloqueos, mapeo de requisitos y generacion sin bloqueos", async () => {
      await page.getByRole("link", { name: /Generar propuesta técnica y mapear requisitos/ }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Propuesta técnica" })).toBeVisible();

      await mock.limpiarRegistro();
      await page.getByRole("button", { name: "Generar propuesta técnica" }).click();
      await expect(page.getByText("3 sección(es) generada(s) · 4 bloqueo(s) pendiente(s)")).toBeVisible();
      await expect(page.getByText(/Hay requisitos sin dato mapeado/)).toBeVisible();

      // Mapeo: validacion local y guardado por tema.
      const guardar = (tema: string) => page.locator("form").filter({ has: page.locator(`#mapeo-refkey-${tema}`) }).getByRole("button", { name: /mapeo$/ });
      await guardar("poder_notarial").click();
      await expect(page.getByRole("alert").filter({ hasText: "El identificador de referencia (refKey) es obligatorio." })).toBeVisible();
      for (const tema of ["poder_notarial", "acta_constitutiva", "anexo_3"]) {
        await page.locator(`#mapeo-refkey-${tema}`).fill(tema);
        await page.locator(`#mapeo-plantilla-${tema}`).fill("Se acompaña {value}.");
        await guardar(tema).click();
        await expect(page.getByText(`Guardado: Documento de empresa · refKey "${tema}".`)).toBeVisible();
      }
      const mapeos = await mock.buscar({ metodo: "PUT", ruta: "/requirement-mappings/" });
      expect(mapeos.map((m) => cuerpoDe(m)["refKey"])).toEqual(["poder_notarial", "acta_constitutiva", "anexo_3"]);

      // La condicion sin evaluar sigue bloqueando; al declarar "No aplica" la propuesta queda sin bloqueos.
      await mock.limpiarRegistro();
      await page.getByRole("button", { name: "Generar propuesta técnica" }).click();
      await expect(page.getByText("3 sección(es) generada(s) · 1 bloqueo(s) pendiente(s)")).toBeVisible();
      await page.getByRole("radio", { name: "No aplica" }).check();
      await page.getByRole("button", { name: "Generar propuesta técnica" }).click();
      await expect(page.getByText("3 sección(es) generada(s) · 0 bloqueo(s) pendiente(s)")).toBeVisible();
      await expect(page.getByText(/Condición declarada como no aplicable/)).toBeVisible();
      const generaciones = await mock.buscar({ metodo: "POST", ruta: "/proposal/technical/generate" });
      expect(generaciones).toHaveLength(2);
      const evaluaciones = cuerpoDe(generaciones[1]!)["conditionEvaluations"] as Record<string, boolean>;
      expect(Object.values(evaluaciones)).toEqual([false]);
    });

    await test.step("propuesta economica: validacion, concepto sin tarifa bloquea el total y con tarifa calcula IVA", async () => {
      await mock.limpiarRegistro();
      await page.getByRole("button", { name: "Generar propuesta económica" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Fila 1: el concepto es obligatorio." })).toBeVisible();
      expect(await mock.buscar({ metodo: "POST", ruta: "/proposal/economic/generate" })).toHaveLength(0);

      await page.locator("#economico-concepto-0").fill("Concepto sin tarifa");
      await page.getByRole("button", { name: "Generar propuesta económica" }).click();
      await expect(page.getByText("Sin total: 1 concepto(s) sin tarifa aprobada/vigente.")).toBeVisible();

      await page.locator("#economico-concepto-0").fill(CONCEPTO_CON_TARIFA);
      await page.locator("#economico-cantidad-0").fill("100");
      await page.getByRole("button", { name: "Generar propuesta económica" }).click();
      await expect(page.getByText(/Subtotal: \$150000\.00 · IVA \(16%\): \$24000\.00 · Total: \$174000\.00 MXN/)).toBeVisible();
      const ultimo = (await mock.buscar({ metodo: "POST", ruta: "/proposal/economic/generate" })).at(-1)!;
      expect(cuerpoDe(ultimo)["lineItems"]).toEqual([{ concept: CONCEPTO_CON_TARIFA, quantity: 100 }]);
    });

    // ---- 5. Cierre: checklist, aprobacion por seccion, doble aprobacion, paquete, descarga y presentacion.
    await test.step("cierre: checklist con hallazgos y luego en verde", async () => {
      await page.getByRole("link", { name: /Correr checklist, aprobar y ensamblar el paquete de cierre/ }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Cierre del expediente" })).toBeVisible();

      await mock.limpiarRegistro();
      await page.getByRole("button", { name: "Correr checklist" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Agrega al menos un archivo del paquete" })).toBeVisible();
      await page.locator("#cierre-archivos").setInputFiles({ name: "propuesta.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 simulado") });
      await page.getByRole("button", { name: "Correr checklist" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Declara al menos una firma requerida" })).toBeVisible();
      expect(await mock.buscar({ metodo: "POST", ruta: "/checklist/run" })).toHaveLength(0);

      await page.getByPlaceholder("representante_legal").fill("representante_legal");
      await page.getByRole("button", { name: "Correr checklist" }).click();
      await expect(page.getByText("Falta confirmar la firma de: representante_legal.")).toBeVisible();
      await expect(page.getByText("Faltan anexos obligatorios: anexo_3.")).toBeVisible();

      await page.getByLabel("Ya se firmó (fuera del sistema)").check();
      await page.getByLabel("Anexo 1 firmado por el representante legal.").check();
      await page.getByRole("button", { name: "Correr checklist" }).click();
      await expect(page.getByText("Todas las firmas requeridas están confirmadas.")).toBeVisible();
      await expect(page.getByText("Todos los anexos obligatorios están presentes.")).toBeVisible();
      const corridas = await mock.buscar({ metodo: "POST", ruta: "/checklist/run" });
      expect(corridas).toHaveLength(2);
      expect(cuerpoDe(corridas[1]!)).toMatchObject({ presentAnnexRefs: ["anexo_3"], requiredSignatures: [{ role: "representante_legal", userConfirmedSigned: true }] });
    });

    await test.step("cierre: aprobacion por seccion y doble aprobacion por dos personas", async () => {
      await page.getByRole("tab", { name: "Aprobación" }).click();
      await mock.limpiarRegistro();
      await page.getByLabel("Sección a aprobar").selectOption("economic:anexo");
      await page.getByRole("button", { name: "Aprobar sección" }).click();
      await expect(page.getByText(/Sección "economic:anexo" aprobada/)).toBeVisible();
      expect(await mock.buscar({ metodo: "POST", ruta: "/proposal/sections/economic%3Aanexo/approval" })).toHaveLength(1);

      await aprobarEtapa(page, "Aprobar técnico-legal (1/2)", "Técnico-legal (1/2): aprobada.");
      // La misma persona no puede dar la 2/2: otra (admin) la completa y recien entonces se ensambla.
      await expect(page.getByRole("button", { name: "Aprobar económica (2/2)" })).toBeDisabled();
      await iniciarSesion("licitaciones", "admin");
      await page.goto(rutaConvocatoria("/cierre"));
      await page.getByRole("tab", { name: "Aprobación" }).click();
      await aprobarEtapa(page, "Aprobar económica (2/2)", "Económica (2/2): aprobada.");
      await expect(page.getByText("2/2 completa").first()).toBeVisible();
      const aprobaciones = await mock.buscar({ metodo: "POST", ruta: "/expediente/approval" });
      expect(aprobaciones.map((a) => cuerpoDe(a)["stage"])).toEqual(["tecnica_legal", "economica"]);
    });

    await test.step("cierre: ensamblar, descargar el ZIP y declarar la presentacion", async () => {
      await page.getByRole("tab", { name: "Paquete final" }).click();
      await page.getByRole("button", { name: "Ensamblar paquete" }).click();
      await expect(page.getByText(/Generado .*La presentación y firma las realiza el usuario/)).toBeVisible();
      const descarga = page.waitForEvent("download");
      await page.getByRole("button", { name: "Descargar ZIP" }).click();
      expect((await descarga).suggestedFilename()).toBe(`expediente-${TENDER_ID}.zip`);
      expect(await mock.buscar({ metodo: "GET", ruta: "/package/download" })).toHaveLength(1);

      await page.getByRole("tab", { name: "Presentación" }).click();
      await page.getByLabel("Fecha y hora de la presentación").fill("2026-10-01T10:00");
      await page.getByRole("button", { name: "Declarar presentación" }).click();
      await dialogo(page, /Declarar la presentación ante el portal/).getByRole("button", { name: "Declarar presentación" }).click();
      await expect(page.getByTestId("presentacion-declarada")).toBeVisible();
      expect(await mock.buscar({ metodo: "POST", ruta: "/submission/declare" })).toHaveLength(1);
    });

    // ---- 6. Resolucion y contrato (de vuelta como propietario).
    await test.step("resolucion: motivo obligatorio, perdida cancelable y ganada registrada", async () => {
      await iniciarSesion("licitaciones", "owner");
      await page.goto(rutaConvocatoria());
      await page.getByRole("tab", { name: "Resolución" }).click();
      await mock.limpiarRegistro();
      await page.getByRole("button", { name: "Marcar ganada" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Escribe un motivo." })).toBeVisible();
      await page.getByLabel("Motivo", { exact: true }).fill("Fallo a favor de la empresa.");
      await afirmarCancelarNoEscribe(page, mock, page.getByRole("button", { name: "Marcar perdida" }), { nombre: /Marcar perdida/, verificarFoco: false });
      await page.getByRole("button", { name: "Marcar ganada" }).click();
      await dialogo(page, /Marcar ganada/).getByRole("button", { name: "Marcar ganada" }).click();
      await expect(page.getByText("GANADA", { exact: true })).toBeVisible();
      await expect(page.getByText(/es un estado terminal, no admite una nueva resolución/)).toBeVisible();
      expect(await unaEscritura(mock, "POST", "/resolution")).toEqual({ resolution: "won", reason: "Fallo a favor de la empresa." });
    });

    await test.step("contrato: registrar, metadatos, documento con campos sugeridos y recorrido del ciclo con step-up", async () => {
      await page.getByRole("link", { name: /Ver\/registrar el contrato post-adjudicación/ }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Contrato" })).toBeVisible();
      await mock.limpiarRegistro();
      await page.getByRole("button", { name: "Registrar contrato" }).click();
      await expect(page.getByText("Adjudicado").first()).toBeVisible();
      expect(await mock.buscar({ metodo: "POST", ruta: /\/contract$/ })).toHaveLength(1);

      await page.getByLabel("Número de contrato").fill("CT-2026-001");
      await page.getByLabel("Fecha de fin").fill("2027-03-31");
      await page.getByLabel("Tiene opción de renovación").check();
      await page.getByLabel("Notas de renovación").fill("Una prórroga de 6 meses.");
      await page.getByRole("button", { name: "Guardar metadatos" }).click();
      await expect(page.getByText("Guardado.")).toBeVisible();
      expect(await unaEscritura(mock, "PATCH", /\/contract$/)).toEqual({ endDate: "2027-03-31", contractNumber: "CT-2026-001", hasRenewalOption: true, renewalOptionNotes: "Una prórroga de 6 meses." });

      // Documento firmado: todo campo extraido entra como "sugerido" y se confirma o corrige explicitamente.
      await page.getByLabel("Contrato firmado (PDF o .txt)").setInputFiles({ name: "contrato.txt", mimeType: "text/plain", buffer: Buffer.from(TEXTO_CONTRATO) });
      await page.getByRole("button", { name: "Subir y extraer campos" }).click();
      await expect(page.getByText("CT-2026-001").first()).toBeVisible();
      await expect(page.getByText("Sugerido").first()).toBeVisible();
      await page.getByRole("button", { name: "Confirmar valor" }).first().click();
      await expect(page.getByText("Confirmado tal cual por")).toBeVisible();
      await page.getByLabel(/^Valor corregido de/).first().fill("19000000");
      await page.getByRole("button", { name: "Corregir" }).first().click();
      await expect(page.getByText('Corregido a "19000000"')).toBeVisible();
      const confirmaciones = await mock.buscar({ metodo: "POST", ruta: "/contract/fields/" });
      expect(confirmaciones.map((c) => cuerpoDe(c)["action"])).toEqual(["confirm", "correct"]);

      const transicionar = async (destino: string, motivo: string, codigo?: string) => {
        await page.getByLabel("Nuevo estado").selectOption(destino);
        await page.getByLabel("Motivo (obligatorio)").fill(motivo);
        if (codigo !== undefined) await page.getByLabel("Código de verificación en dos pasos").fill(codigo);
        await page.getByRole("button", { name: "Aplicar transición" }).click();
      };
      await mock.limpiarRegistro();
      // Sin motivo no hay peticion.
      await page.getByLabel("Nuevo estado").selectOption("contrato_firmado_declarado");
      await page.getByRole("button", { name: "Aplicar transición" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Escribe el motivo de la transición." })).toBeVisible();
      expect(await mock.escrituras()).toEqual([]);

      await transicionar("contrato_firmado_declarado", "Contrato firmado el 5 de octubre.");
      await expect(page.getByText("Contrato firmado (declarado)").first()).toBeVisible();
      expect(await unaEscritura(mock, "POST", "/contract/transition")).toMatchObject({ toStatus: "contrato_firmado_declarado", reason: "Contrato firmado el 5 de octubre." });

      // Rescindir exige confirmacion explicita: Cancelar y Escape no escriben.
      await page.getByLabel("Nuevo estado").selectOption("rescindido");
      await page.getByLabel("Motivo (obligatorio)").fill("Prueba de cancelacion.");
      await page.getByLabel("Código de verificación en dos pasos").fill(CODIGO_TOTP);
      await mock.limpiarRegistro();
      await afirmarCancelarNoEscribe(page, mock, page.getByRole("button", { name: "Aplicar transición" }), { nombre: /Pasar el contrato a/, verificarFoco: false });
      await expect(page.getByLabel("Nuevo estado")).toHaveValue("rescindido");
      await page.getByLabel("Nuevo estado").selectOption("");
      await page.getByLabel("Motivo (obligatorio)").fill("");

      for (const [destino, etiqueta, motivo] of [["en_ejecucion", "En ejecución", "Inicio de obra."], ["entregado", "Entregado", "Obra entregada."], ["facturado", "Facturado", "Estimaciones facturadas."]] as const) {
        await transicionar(destino, motivo);
        await expect(page.getByText(etiqueta).first()).toBeVisible();
      }
      // "Pagado" exige segundo factor: con un codigo incorrecto el servidor lo rechaza y el estado no cambia.
      await transicionar("pagado", "Pago total recibido.", "000000");
      await expect(page.getByRole("alert").filter({ hasText: /código|identidad/i })).toBeVisible();
      await expect(page.getByText("Historial (5)")).toBeVisible();
      await transicionar("pagado", "Pago total recibido.", CODIGO_TOTP);
      await expect(page.getByText("Historial (6)")).toBeVisible();
      await transicionar("cerrado", "Contrato concluido.");
      await expect(page.getByText(/es un estado terminal -- no hay transiciones disponibles/)).toBeVisible();
      const transiciones = await mock.buscar({ metodo: "POST", ruta: "/contract/transition" });
      expect(transiciones.map((t) => cuerpoDe(t)["toStatus"])).toEqual(["en_ejecucion", "entregado", "facturado", "pagado", "cerrado"]);
    });

    // ---- 7. Cobranza e inconformidad.
    await test.step("post-adjudicacion: factura, marcar pagada e inconformidad revisada", async () => {
      await page.goto(rutaConvocatoria("/post-adjudicacion"));
      await expect(page.getByRole("heading", { level: 1, name: /Post-adjudicación/ })).toBeVisible();
      await expect(page.getByText("Todavía no hay facturas registradas contra este contrato.")).toBeVisible();

      await mock.limpiarRegistro();
      await page.getByLabel("Concepto").fill("Primera estimación");
      await page.getByLabel("Monto").fill("12345.67");
      await page.getByLabel("Fecha de verificación").fill("2026-09-01");
      await page.getByRole("button", { name: "Registrar factura" }).click();
      await expect(page.getByText("Primera estimación · $12345.67")).toBeVisible();
      await expect(page.getByText("$12345.67").first()).toBeVisible();
      expect(await unaEscritura(mock, "POST", /\/contract\/invoices$/)).toMatchObject({ concepto: "Primera estimación", amount: "12345.67", invoiceVerifiedOn: "2026-09-01" });

      await page.getByRole("button", { name: "Marcar pagada" }).click();
      await expect(page.getByText(/pagada 1 de octubre de 2026/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Marcar pagada" })).toHaveCount(0);
      expect(await mock.buscar({ metodo: "POST", ruta: /\/mark-paid$/ })).toHaveLength(1);

      await page.getByRole("tab", { name: "Inconformidades" }).click();
      await page.getByLabel("Hechos (uno por línea)").fill("El fallo se notificó el 2 de octubre.");
      await page.getByLabel("Agravios (uno por línea)").fill("No se valoró la propuesta técnica.");
      await page.getByLabel("Fecha de notificación del fallo").fill("2026-10-02");
      await page.getByRole("button", { name: /Generar borrador/ }).click();
      await expect(page.getByRole("button", { name: /Marcar como revisado por abogado/ })).toBeVisible();
      await page.getByRole("button", { name: /Marcar como revisado por abogado/ }).click();
      await expect(page.getByRole("button", { name: /Marcar como revisado por abogado/ })).toHaveCount(0);
      expect(await mock.buscar({ metodo: "POST", ruta: /\/inconformidad\/.+\/mark-reviewed$/ })).toHaveLength(1);
    });

    // ---- 8. Cierre de sesion.
    await test.step("cierre de sesion: manda al login y limpia la sesion", async () => {
      await page.goto(`${BASE}/panel`);
      await mock.limpiarRegistro();
      const lateral = page.getByRole("complementary", { name: "Navegación principal" });
      await lateral.getByRole("button", { name: "Cerrar sesión" }).click();
      const confirmar = page.getByRole("alertdialog");
      if (await confirmar.isVisible().catch(() => false)) await confirmar.getByRole("button", { name: "Cerrar sesión" }).click();
      await page.waitForURL(/\/licitaciones\/login/);
      expect(await mock.buscar({ metodo: "POST", ruta: "/auth/logout" })).toHaveLength(1);
      // Sin sesion, una ruta protegida vuelve al login.
      await page.goto(`${BASE}/convocatorias`);
      await page.waitForURL(/\/licitaciones\/login/);
    });

    vigilante.verificar();
  });
});
