import { describe, expect, it } from "vitest";
import { InMemoryRentasMensajeriaRepository } from "../../src/mensajeria/in-memory-repository.ts";

async function seedConversacion(repo: InMemoryRentasMensajeriaRepository, propertyId = "prop-1") {
  return repo.insertConversacion({
    organizationId: "org-1",
    propertyId,
    unidadId: "unidad-1",
    canal: "airbnb",
    propiedadNombre: "Casa Sol",
    huespedNombre: "Ana",
    fechaCheckIn: "2026-01-10",
    fechaCheckOut: "2026-01-15",
    reservaConfirmada: true,
  });
}

describe("InMemoryRentasMensajeriaRepository — conversaciones/mensajes", () => {
  it("insertConversacion + findConversacion resuelven el contexto congelado en la fila", async () => {
    const repo = new InMemoryRentasMensajeriaRepository();
    const creada = await seedConversacion(repo);
    const encontrada = await repo.findConversacion("prop-1", creada.id);
    expect(encontrada).toEqual(creada);
  });

  it("findConversacion aislado por property — una conversación de otra property nunca resuelve", async () => {
    const repo = new InMemoryRentasMensajeriaRepository();
    const creada = await seedConversacion(repo, "prop-1");
    expect(await repo.findConversacion("prop-OTRA", creada.id)).toBeNull();
  });

  it("listConversaciones filtra por unidad cuando se pide", async () => {
    const repo = new InMemoryRentasMensajeriaRepository();
    const a = await seedConversacion(repo);
    await repo.insertConversacion({ organizationId: "org-1", propertyId: "prop-1", unidadId: "unidad-2", canal: "vrbo", propiedadNombre: "Casa Luna" });
    const soloUnidad1 = await repo.listConversaciones("prop-1", "unidad-1");
    expect(soloUnidad1.map((c) => c.id)).toEqual([a.id]);
  });

  it("findMensajeEntrante exige que el mensaje sea entrante y pertenezca a la conversación", async () => {
    const repo = new InMemoryRentasMensajeriaRepository();
    const conv = await seedConversacion(repo);
    const entrante = await repo.insertMensaje({ conversacionId: conv.id, direccion: "entrante", origen: "simulador", texto: "hola" });
    const saliente = await repo.insertMensaje({ conversacionId: conv.id, direccion: "saliente", origen: "simulador", texto: "hola de vuelta" });

    expect(await repo.findMensajeEntrante(conv.id, entrante.id)).not.toBeNull();
    expect(await repo.findMensajeEntrante(conv.id, saliente.id)).toBeNull(); // es saliente, no entrante
    expect(await repo.findMensajeEntrante("otra-conversacion", entrante.id)).toBeNull();
  });
});

describe("InMemoryRentasMensajeriaRepository — borradores", () => {
  it("insertBorrador queda SIEMPRE en pendiente_aprobacion", async () => {
    const repo = new InMemoryRentasMensajeriaRepository();
    const conv = await seedConversacion(repo);
    const borrador = await repo.insertBorrador({ conversacionId: conv.id, canal: "airbnb", texto: "Hola", generadoPor: "motor_borrador" });
    expect(borrador.estado).toBe("pendiente_aprobacion");
    expect(borrador.aprobadoPor).toBeNull();
  });

  it("findBorrador aislado por property — vía la conversación dueña", async () => {
    const repo = new InMemoryRentasMensajeriaRepository();
    const conv = await seedConversacion(repo, "prop-1");
    const borrador = await repo.insertBorrador({ conversacionId: conv.id, canal: "airbnb", texto: "Hola", generadoPor: "motor_borrador" });
    expect(await repo.findBorrador("prop-1", borrador.id)).not.toBeNull();
    expect(await repo.findBorrador("prop-OTRA", borrador.id)).toBeNull();
  });

  it("marcarBorradorAprobadoYEnviado deja estado enviado con los datos de aprobación", async () => {
    const repo = new InMemoryRentasMensajeriaRepository();
    const conv = await seedConversacion(repo);
    const borrador = await repo.insertBorrador({ conversacionId: conv.id, canal: "airbnb", texto: "Hola", generadoPor: "motor_borrador" });
    const mensaje = await repo.insertMensaje({ conversacionId: conv.id, direccion: "saliente", origen: "simulador", texto: "Hola" });

    const actualizado = await repo.marcarBorradorAprobadoYEnviado({ id: borrador.id, aprobadoPor: "usuario-1", textoFinal: "Hola (validado)", redactado: false, mensajeEnviadoId: mensaje.id });
    expect(actualizado.estado).toBe("enviado");
    expect(actualizado.aprobadoPor).toBe("usuario-1");
    expect(actualizado.texto).toBe("Hola (validado)");
    expect(actualizado.mensajeEnviadoId).toBe(mensaje.id);
  });

  it("marcarBorradorRechazado deja estado rechazado con motivo", async () => {
    const repo = new InMemoryRentasMensajeriaRepository();
    const conv = await seedConversacion(repo);
    const borrador = await repo.insertBorrador({ conversacionId: conv.id, canal: "airbnb", texto: "Hola", generadoPor: "motor_borrador" });
    const actualizado = await repo.marcarBorradorRechazado({ id: borrador.id, rechazadoPor: "usuario-1", motivo: "tono" });
    expect(actualizado.estado).toBe("rechazado");
    expect(actualizado.motivoRechazo).toBe("tono");
  });

  it("tocarBorradorParaAuditoria actualiza actualizadoEn sin cambiar el estado", async () => {
    const repo = new InMemoryRentasMensajeriaRepository();
    const conv = await seedConversacion(repo);
    const borrador = await repo.insertBorrador({ conversacionId: conv.id, canal: "airbnb", texto: "Hola", generadoPor: "motor_borrador" });
    await new Promise((r) => setTimeout(r, 2));
    await repo.tocarBorradorParaAuditoria(borrador.id);
    const releido = await repo.findBorrador(conv.propertyId, borrador.id);
    expect(releido!.estado).toBe("pendiente_aprobacion");
    expect(releido!.actualizadoEn).not.toBe(borrador.actualizadoEn);
  });
});

describe("InMemoryRentasMensajeriaRepository — plantillas", () => {
  it("insertPlantilla por defecto queda sin aprobar por el tenant", async () => {
    const repo = new InMemoryRentasMensajeriaRepository();
    const plantilla = await repo.insertPlantilla({ organizationId: "org-1", evento: "confirmacion", idioma: "es", canal: null, cuerpo: "Hola {{nombre}}" });
    expect(plantilla.aprobadaPorTenant).toBe(false);
    expect(plantilla.activa).toBe(true);
  });

  it("updatePlantilla puede aprobarla explícitamente sin tocar el resto de campos", async () => {
    const repo = new InMemoryRentasMensajeriaRepository();
    const plantilla = await repo.insertPlantilla({ organizationId: "org-1", evento: "check_in", idioma: "es", canal: "airbnb", cuerpo: "Bienvenido" });
    const actualizada = await repo.updatePlantilla({ id: plantilla.id, organizationId: "org-1", aprobadaPorTenant: true });
    expect(actualizada!.aprobadaPorTenant).toBe(true);
    expect(actualizada!.cuerpo).toBe("Bienvenido");
  });

  it("updatePlantilla de otra organización nunca resuelve (aislamiento por tenant)", async () => {
    const repo = new InMemoryRentasMensajeriaRepository();
    const plantilla = await repo.insertPlantilla({ organizationId: "org-1", evento: "check_in", idioma: "es", canal: null, cuerpo: "Bienvenido" });
    expect(await repo.updatePlantilla({ id: plantilla.id, organizationId: "org-OTRA", activa: false })).toBeNull();
  });

  it("listPlantillas filtra por evento/idioma/canal", async () => {
    const repo = new InMemoryRentasMensajeriaRepository();
    await repo.insertPlantilla({ organizationId: "org-1", evento: "confirmacion", idioma: "es", canal: "airbnb", cuerpo: "A" });
    await repo.insertPlantilla({ organizationId: "org-1", evento: "confirmacion", idioma: "en", canal: "airbnb", cuerpo: "B" });
    await repo.insertPlantilla({ organizationId: "org-1", evento: "check_out", idioma: "es", canal: null, cuerpo: "C" });

    const soloEsConfirmacion = await repo.listPlantillas("org-1", { evento: "confirmacion", idioma: "es" });
    expect(soloEsConfirmacion).toHaveLength(1);
    expect(soloEsConfirmacion[0]!.cuerpo).toBe("A");
  });
});
