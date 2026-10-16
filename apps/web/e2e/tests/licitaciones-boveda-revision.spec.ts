// paridad3 (L-P3-05/06/07) -- de punta a punta contra la API simulada: subir bases a la boveda (un ZIP se rechaza por su contenido),
// ver la matriz, resolver un conflicto con notas, editar una fila y que una re-extraccion la conserve, abrir la cita, editar una
// seccion (invalida la aprobacion; el autor no ve Aprobar), comentar y pedir revision.
import { expect, test } from "../helpers/fixtures.ts";
import { licitaciones } from "../mock-api/fixtures/licitaciones.ts";

const BASE = `/licitaciones/${licitaciones.orgSlug}/convocatorias/tnd-1`;
const BASES_TXT = "El licitante deberá presentar acta constitutiva original. La entrega de proposiciones será a más tardar el 15 de diciembre del 2026.";
const ACTA_TXT = "Se aclara que la entrega de proposiciones será a más tardar el 20 de diciembre del 2026.";

test.describe("licitaciones: boveda, matriz y revision @humo", () => {
  test("sube bases, ve la matriz, resuelve un conflicto, edita una fila y re-extrae sin perderla", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");
    await page.goto(`${BASE}/requisitos`);
    await page.getByRole("tab", { name: /Documentos/ }).click();

    // Un ZIP se rechaza por su CONTENIDO (el servidor lo valida), y nada queda guardado.
    await page.getByLabel("Archivo (PDF o .txt)").setInputFiles({ name: "bases.zip", mimeType: "application/zip", buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]) });
    await page.getByRole("button", { name: "Subir a la bóveda" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "no se aceptan" })).toBeVisible();
    await expect(page.getByText("Todavía no hay documentos en la bóveda")).toBeVisible();

    await page.getByLabel("Archivo (PDF o .txt)").setInputFiles({ name: "bases.txt", mimeType: "text/plain", buffer: Buffer.from(BASES_TXT) });
    await page.getByLabel("Título (opcional)").fill("Bases de la licitación");
    await page.getByRole("button", { name: "Subir a la bóveda" }).click();
    await expect(page.getByText("Documento guardado y texto extraído.")).toBeVisible();
    await expect(page.getByText("Texto extraído").first()).toBeVisible();

    await page.getByRole("button", { name: "Extraer requisitos de todos" }).click();
    await expect(page.getByText(/2 nuevos, 0 actualizados, 0 retirados/)).toBeVisible();

    // El acta de junta cambia el plazo: dos fechas distintas para el mismo tema = un conflicto abierto.
    await page.getByLabel("Tipo").selectOption("acta_junta");
    await page.getByLabel("Archivo (PDF o .txt)").setInputFiles({ name: "acta.txt", mimeType: "text/plain", buffer: Buffer.from(ACTA_TXT) });
    await page.getByRole("button", { name: "Subir a la bóveda" }).click();
    await expect(page.getByText("Documento guardado y texto extraído.")).toBeVisible();
    await page.getByRole("button", { name: "Extraer requisitos de todos" }).click();
    await expect(page.getByRole("tab", { name: "Conflictos (1)" })).toBeVisible();

    // Resolver exige notas; sin ellas no se llama a la API.
    await page.getByRole("tab", { name: "Conflictos (1)" }).click();
    await expect(page.getByTestId("conflicto-abierto")).toContainText("2 fechas límite distintas");
    await page.getByRole("button", { name: "Resolver" }).click();
    await mock.limpiarRegistro();
    await page.getByRole("button", { name: "Marcar como resuelto" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "notas de resolución" })).toBeVisible();
    expect(await mock.buscar({ metodo: "POST", ruta: "/resolve" })).toHaveLength(0);
    await page.getByLabel("Notas de resolución (obligatorias)").fill("Prevalece el acta de junta.");
    await page.getByRole("button", { name: "Marcar como resuelto" }).click();
    await expect(page.getByRole("tab", { name: "Conflictos (0)" })).toBeVisible();
    await expect(page.getByText("Notas: Prevalece el acta de junta.")).toBeVisible();

    // Edicion humana: estado, causa de desechamiento y filtro.
    await page.getByRole("tab", { name: /^Requisitos/ }).click();
    const estatus = page.getByLabel(/^Estatus de: El licitante deberá presentar acta/);
    await estatus.selectOption("en_progreso");
    await expect.poll(async () => (await mock.buscar({ metodo: "PATCH", ruta: "/requirements/" })).length).toBe(1);
    // Casilla controlada por el servidor: se marca al volver la respuesta del PATCH, no al hacer clic.
    const causa = page.getByRole("checkbox", { name: "Causa de desechamiento", exact: true }).first();
    await causa.click();
    await expect(causa).toBeChecked();
    await page.getByRole("checkbox", { name: "Solo causa de desechamiento", exact: true }).check();
    await expect(page.locator("[data-requisito]")).toHaveCount(1);
    await page.getByRole("checkbox", { name: "Solo causa de desechamiento", exact: true }).uncheck();

    // Visor de la cita: pagina y extracto del documento guardado.
    await page.getByRole("button", { name: /Ver cita · pág\. 1/ }).first().click();
    await expect(page.getByTestId("visor-cita")).toContainText("Cita: Bases de la licitación · página 1");
    await expect(page.getByTestId("visor-cita").locator("mark")).toContainText("acta constitutiva original");
    await page.getByRole("button", { name: "Cerrar el visor de la cita" }).click();

    // Re-extraer conserva lo asignado a mano (mismas filas, nada nuevo ni retirado).
    await page.getByRole("tab", { name: /Documentos/ }).click();
    await page.getByRole("button", { name: "Extraer requisitos de todos" }).click();
    await expect(page.getByText(/0 nuevos, \d+ actualizados, 0 retirados/)).toBeVisible();
    await page.getByRole("tab", { name: /^Requisitos/ }).click();
    await expect(page.getByLabel(/^Estatus de: El licitante deberá presentar acta/)).toHaveValue("en_progreso");
    vigilante.verificar();
  });

  test("editar una seccion invalida la aprobacion y el autor no ve Aprobar; comentar y pedir revision", async ({ page, iniciarSesion, vigilante }) => {
    // El admin aprueba la seccion legal desde Cierre.
    await iniciarSesion("licitaciones", "admin");
    await page.goto(`${BASE}/cierre`);
    await page.getByRole("tab", { name: "Aprobación" }).click();
    await page.getByLabel("Sección a aprobar").selectOption("technical:legal");
    await page.getByRole("button", { name: "Aprobar sección" }).click();
    await expect(page.getByText(/Sección "seccion:technical:legal" aprobada/)).toBeVisible();

    // El owner edita esa seccion: con el mismo texto no pasa nada; con otro, se invalida y queda como autor.
    await iniciarSesion("licitaciones", "owner");
    await page.goto(`${BASE}/propuesta-tecnica`);
    const seccion = page.locator('[data-seccion="technical:legal"]');
    await expect(seccion).toContainText("Aprobada");
    await expect(seccion.getByRole("button", { name: "Guardar sección" })).toBeDisabled();
    await seccion.getByRole("textbox").fill("Se acompaña acta constitutiva vigente y poder notarial.");
    await expect(seccion).toContainText("Al guardar se invalidará la aprobación vigente de la sección");
    await seccion.getByRole("button", { name: "Guardar sección" }).click();
    await expect(seccion).toContainText("Se invalidaron 1 aprobación");
    await expect(seccion).toContainText("Tú la redactaste: no puedes aprobarla");
    await expect(seccion).not.toContainText("Aprobada");

    // En Cierre, el autor no ve Aprobar para esa seccion ni para el expediente.
    await page.goto(`${BASE}/cierre`);
    await page.getByRole("tab", { name: "Aprobación" }).click();
    await page.getByLabel("Sección a aprobar").selectOption("technical:legal");
    await expect(page.getByTestId("seccion-autor")).toBeVisible();
    await expect(page.getByRole("button", { name: "Aprobar sección" })).toHaveCount(0);
    await expect(page.getByText("Editaste contenido de este expediente: debe aprobarlo otra persona").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Aprobar técnico-legal (1/2)" })).toBeDisabled();

    // Comentar y pedir revision desde la propuesta.
    await page.goto(`${BASE}/propuesta-tecnica`);
    await page.getByLabel("Comentario o nota para el revisor").fill("Falta confirmar el poder notarial.");
    await page.getByRole("button", { name: "Comentar" }).click();
    await expect(page.getByText("Comentario agregado.")).toBeVisible();
    await page.getByLabel("Comentario o nota para el revisor").fill("Listo para tu revisión.");
    await page.getByRole("button", { name: "Pedir revisión" }).click();
    await expect(page.getByText(/Revisión solicitada: los revisores recibieron el aviso/)).toBeVisible();
    await expect(page.locator("[data-comentario]")).toHaveCount(2);
    await expect(page.locator('[data-comentario="solicitud_revision"]')).toContainText("Solicitud de revisión");
    vigilante.verificar();
  });

  test("Aprobaciones: pedir la revision del expediente de una convocatoria", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");
    await page.goto(`/licitaciones/${licitaciones.orgSlug}/aprobaciones`);
    await expect(page.getByRole("heading", { name: "Pedir revisión de un expediente" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pedir revisión" })).toBeDisabled();
    await page.getByLabel("Convocatoria").selectOption("tnd-1");
    await page.getByLabel("Nota para el revisor (opcional)").fill("Revisa el anexo técnico.");
    await page.getByRole("button", { name: "Pedir revisión" }).click();
    await expect(page.getByText(/Revisión solicitada: los revisores recibieron el aviso/)).toBeVisible();
    expect(await mock.buscar({ metodo: "POST", ruta: "/proposal/request-review" })).toHaveLength(1);
    vigilante.verificar();
  });
});
