// H-P3-03 -- corrida de los mensajes al huesped: canal, idempotencia, ventana de envio, zona horaria, opt-out, plantilla inexistente,
// base sin migrar y carrera de dos corridas. Sobre el doble en memoria (la derivacion del estado real y la concurrencia en la base se
// verifican contra Postgres real en scripts/verify-hoteles-mensajes-huesped).
import { describe, expect, it, vi } from "vitest";
import { ejecutarMensajesHuesped } from "../../src/index.ts";
import { AHORA, candidato, crearEntorno, OPCIONES, ORG, PROP, type Entorno } from "./fixtures.ts";

/** pre_llegada y post_estancia vienen APAGADOS por omision: la prueba los enciende como lo haria gerencia. */
async function encender(e: Entorno, ...eventos: Parameters<Entorno["repo"]["guardarConfig"]>[1][]): Promise<void> {
  for (const evento of eventos) await e.repo.guardarConfig(PROP, evento, { activo: true, horasAntes: null, resenaUrl: null });
}

const PLANTILLA_HOLD = { nombre: "hotel_hold_aprobado", idioma: "es_MX", variables: ["nombre", "hotel", "llegada"], estado: "aprobada" as const };

describe("ejecutarMensajesHuesped -- seleccion de canal", () => {
  it("WhatsApp con la plantilla HSM aprobada del catalogo, con los parametros en el orden que declara la plantilla", async () => {
    const e = crearEntorno();
    await e.repo.guardarPlantilla(ORG, "hold.aprobado", PLANTILLA_HOLD);
    e.repo.candidatos = [candidato()];
    const r = await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    expect(r).toMatchObject({ disponible: true, candidatos: 1, encolados: 1, porWhatsapp: 1, porCorreo: 0, noEnviados: 0 });
    const msg = e.repo.outbox[0]!;
    expect(msg.canal).toBe("whatsapp");
    expect(msg.eventType).toBe("mh.hold.aprobado");
    expect(msg.dedupeKey).toBe("mh:hold.aprobado:00000000-0000-0000-0000-0000000f1001:whatsapp");
    expect(msg.payload).toMatchObject({ to: "+525511112222", phone_number_id: "10000000000001", transaccional: true });
    const template = (msg.payload as { template: { name: string; language: string; params: string[] } }).template;
    expect(template.name).toBe("hotel_hold_aprobado");
    expect(template.language).toBe("es_MX");
    expect(template.params[0]).toBe("Ana");
    expect(template.params[1]).toBe("Hotel Brisa");
    expect(template.params[2]).toMatch(/10 de septiembre de 2031/);
    expect((msg.payload as { body: string }).body).toContain("aprobó tu pre-reserva");
  });

  it("dentro de las 24 h de Meta (el huesped escribio hace 2 h) sale texto libre, sin consultar plantilla", async () => {
    const e = crearEntorno();
    e.repo.candidatos = [candidato({ ultimaEntradaEn: "2031-07-02T18:00:00Z" })];
    const r = await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    expect(r.porWhatsapp).toBe(1);
    expect(e.repo.outbox[0]!.payload).not.toHaveProperty("template");
  });

  it("el ultimo entrante de hace 23 h 30 min ya esta fuera de la ventana segura: exige plantilla o cae a correo", async () => {
    const e = crearEntorno();
    e.repo.candidatos = [candidato({ ultimaEntradaEn: "2031-07-01T20:30:00Z" })];
    const r = await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    expect(r.porWhatsapp).toBe(0);
    expect(r.porCorreo).toBe(1);
  });

  it("sin plantilla en el catalogo: sale por correo con el mismo contenido", async () => {
    const e = crearEntorno();
    e.repo.candidatos = [candidato()];
    const r = await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    expect(r).toMatchObject({ encolados: 1, porCorreo: 1, porWhatsapp: 0 });
    const msg = e.repo.outbox[0]!;
    expect(msg.canal).toBe("email");
    expect(msg.payload).toMatchObject({ to: "ana@example.com", transaccional: true });
    expect((msg.payload as { subject: string }).subject).toBe("Pre-reserva aprobada · Hotel Brisa");
    expect((msg.payload as { html: string }).html).toContain("Hotel Brisa");
  });

  it("plantilla inexistente o NO aprobada (borrador): se trata como sin plantilla", async () => {
    const e = crearEntorno();
    await e.repo.guardarPlantilla(ORG, "hold.aprobado", { ...PLANTILLA_HOLD, estado: "borrador" });
    e.repo.candidatos = [candidato()];
    const r = await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    expect(r.porCorreo).toBe(1);
  });

  it("la plantilla pide una variable que este evento no puede llenar (enlace_resena): se descarta y sale por correo", async () => {
    const e = crearEntorno();
    await e.repo.guardarPlantilla(ORG, "hold.aprobado", { ...PLANTILLA_HOLD, variables: ["nombre", "enlace_resena"] });
    e.repo.candidatos = [candidato()];
    const r = await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    expect(r.porCorreo).toBe(1);
    expect(r.porWhatsapp).toBe(0);
  });

  it("catalogo de plantillas ausente (migracion 0050 pendiente): no rompe, sale por correo", async () => {
    const e = crearEntorno({ catalogoMigrado: false });
    e.repo.candidatos = [candidato()];
    const r = await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    expect(r).toMatchObject({ disponible: true, encolados: 1, porCorreo: 1 });
  });

  it("sin credencial de Meta en la plataforma: nada por WhatsApp aunque haya plantilla; sale por correo", async () => {
    const e = crearEntorno();
    await e.repo.guardarPlantilla(ORG, "hold.aprobado", PLANTILLA_HOLD);
    e.repo.candidatos = [candidato()];
    const r = await ejecutarMensajesHuesped(e.withTx, { ...OPCIONES, credencialMeta: false });
    expect(r).toMatchObject({ porCorreo: 1, porWhatsapp: 0 });
  });

  it("el telefono pidio BAJA (opt-out de plataforma): sale por correo y nunca por WhatsApp", async () => {
    const e = crearEntorno();
    await e.repo.guardarPlantilla(ORG, "hold.aprobado", PLANTILLA_HOLD);
    e.suprimidos.add("telefono:+525511112222");
    e.repo.candidatos = [candidato()];
    const r = await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    expect(r).toMatchObject({ porCorreo: 1, porWhatsapp: 0 });
  });

  it("opt-out y sin correo: queda NO ENVIADO con su motivo y avisa al staff", async () => {
    const e = crearEntorno();
    e.suprimidos.add("telefono:+525511112222");
    e.repo.candidatos = [candidato({ correo: null })];
    const alNoEnviados = vi.fn(async () => undefined);
    const r = await ejecutarMensajesHuesped(e.withTx, { ...OPCIONES, alNoEnviados });
    expect(r).toMatchObject({ encolados: 0, noEnviados: 1 });
    expect(e.repo.envios[0]).toMatchObject({ canal: null, motivo: "baja_whatsapp" });
    expect(e.repo.outbox).toHaveLength(0);
    expect(alNoEnviados).toHaveBeenCalledWith([{ organizationId: ORG, propertyId: PROP, cantidad: 1 }]);
  });

  it("sin telefono ni correo: no enviado por sin_contacto, y el historial lo muestra", async () => {
    const e = crearEntorno();
    e.repo.candidatos = [candidato({ telefono: null, correo: null })];
    await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    const h = await e.repo.historial(PROP, 10);
    expect(h).toMatchObject({ disponible: true });
    if (h.disponible) expect(h.valor[0]).toMatchObject({ estado: "no_enviado", canal: null, motivo: "sin_contacto", envio: null });
  });

  it("sin canal de WhatsApp configurado y sin correo: whatsapp_no_disponible", async () => {
    const e = crearEntorno();
    e.repo.candidatos = [candidato({ whatsappHabilitado: false, phoneNumberId: null, correo: null })];
    await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    expect(e.repo.envios[0]).toMatchObject({ motivo: "whatsapp_no_disponible" });
  });

  it("reserva.confirmada por correo se marca SIN encolar otro correo (ya lo cubre el correo transaccional de la reserva)", async () => {
    const e = crearEntorno();
    e.repo.candidatos = [candidato({ evento: "reserva.confirmada", refTipo: "reserva", refId: "00000000-0000-0000-0000-0000000e0001", totalCentavos: null, venceEn: null })];
    const r = await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    expect(r).toMatchObject({ encolados: 1, porCorreo: 1 });
    expect(e.repo.envios[0]).toMatchObject({ canal: "email", payload: null });
    expect(e.repo.outbox).toHaveLength(0);
  });

  it("un telefono con basura no revienta: se trata como sin telefono", async () => {
    const e = crearEntorno();
    e.repo.candidatos = [candidato({ telefono: "abc" })];
    const r = await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    expect(r.porCorreo).toBe(1);
  });
});

describe("ejecutarMensajesHuesped -- idempotencia", () => {
  it("dos corridas seguidas dejan UN solo mensaje por (referencia, evento)", async () => {
    const e = crearEntorno();
    e.repo.candidatos = [candidato()];
    const a = await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    const b = await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    expect(a.encolados).toBe(1);
    expect(b).toMatchObject({ candidatos: 0, encolados: 0 });
    expect(e.repo.outbox).toHaveLength(1);
  });

  it("dos corridas SIMULTANEAS (dos instancias del cron): exactamente una emite", async () => {
    const e = crearEntorno();
    e.repo.candidatos = [candidato(), candidato({ evento: "hold.rechazado", refId: "00000000-0000-0000-0000-0000000f1002" })];
    const [a, b] = await Promise.all([ejecutarMensajesHuesped(e.withTx, OPCIONES), ejecutarMensajesHuesped(e.withTx, OPCIONES)]);
    expect(a.encolados + b.encolados).toBe(2);
    expect(e.repo.outbox).toHaveLength(2);
    expect(e.repo.envios).toHaveLength(2);
    expect(a.yaProcesados + b.yaProcesados).toBeGreaterThanOrEqual(0);
  });

  it("el mismo huesped con dos eventos distintos recibe los dos (la marca es por evento)", async () => {
    const e = crearEntorno();
    e.repo.candidatos = [candidato(), candidato({ evento: "hold.confirmado" })];
    const r = await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    expect(r.encolados).toBe(2);
  });

  it("si el candidato ya no lo es al revalidar (otra instancia lo emitio entre listar y emitir), cuenta como ya procesado y no escribe", async () => {
    const e = crearEntorno();
    e.repo.candidatos = [candidato()];
    const original = e.repo.listarCandidatos.bind(e.repo);
    let llamadas = 0;
    e.repo.listarCandidatos = async (...args) => {
      llamadas += 1;
      return llamadas === 1 ? original(...args) : [];
    };
    const r = await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    expect(r).toMatchObject({ candidatos: 1, yaProcesados: 1, encolados: 0 });
    expect(e.repo.outbox).toHaveLength(0);
  });
});

describe("ejecutarMensajesHuesped -- ventana de envio y zona horaria", () => {
  it("un proactivo (pre_llegada) fuera de la ventana 08:00-21:00 locales se DIFIERE: no se emite y sigue siendo candidato", async () => {
    const e = crearEntorno();
    await encender(e, "pre_llegada");
    e.repo.candidatos = [candidato({ evento: "pre_llegada", refTipo: "reserva", refId: "00000000-0000-0000-0000-0000000e0002", totalCentavos: null, venceEn: null })];
    // 2031-07-03 05:00 UTC = 23:00 del 2-jul en Ciudad de Mexico (UTC-6): fuera de la ventana.
    const noche = await ejecutarMensajesHuesped(e.withTx, { ...OPCIONES, ahora: new Date("2031-07-03T05:00:00Z") });
    expect(noche).toMatchObject({ candidatos: 1, diferidos: 1, encolados: 0 });
    expect(e.repo.envios).toHaveLength(0);
    // 2031-07-03 15:00 UTC = 09:00 locales: ya esta dentro; ahora si sale.
    const manana = await ejecutarMensajesHuesped(e.withTx, { ...OPCIONES, ahora: new Date("2031-07-03T15:00:00Z") });
    expect(manana).toMatchObject({ diferidos: 0, encolados: 1 });
  });

  it("un transaccional (hold.aprobado) sale de madrugada: no espera a la manana", async () => {
    const e = crearEntorno();
    e.repo.candidatos = [candidato()];
    const r = await ejecutarMensajesHuesped(e.withTx, { ...OPCIONES, ahora: new Date("2031-07-03T08:00:00Z") });
    expect(r).toMatchObject({ diferidos: 0, encolados: 1 });
  });

  it("la zona horaria de la propiedad decide la ventana: la misma hora UTC esta fuera en Mexico y dentro en Tokio", async () => {
    const mx = crearEntorno();
    await encender(mx, "post_estancia");
    mx.repo.candidatos = [candidato({ evento: "post_estancia", refTipo: "reserva", zonaHoraria: "America/Mexico_City", resenaUrl: "https://g.page/r/x" })];
    const tokio = crearEntorno();
    await encender(tokio, "post_estancia");
    tokio.repo.candidatos = [candidato({ evento: "post_estancia", refTipo: "reserva", zonaHoraria: "Asia/Tokyo", resenaUrl: "https://g.page/r/x" })];
    // 2031-07-03 02:00 UTC = 20:00 locales... en Mexico (UTC-6) es 20:00 (dentro) -- usamos 04:00 UTC: 22:00 en Mexico (fuera), 13:00 en Tokio (dentro).
    const ahora = new Date("2031-07-03T04:00:00Z");
    expect((await ejecutarMensajesHuesped(mx.withTx, { ...OPCIONES, ahora })).diferidos).toBe(1);
    expect((await ejecutarMensajesHuesped(tokio.withTx, { ...OPCIONES, ahora })).encolados).toBe(1);
  });

  it("respeta la ventana configurada en agent_guardrail (09:30-18:00): a las 19:00 locales un proactivo espera", async () => {
    const e = crearEntorno();
    e.repo.candidatos = [candidato({ evento: "lista_espera.ofrecida", refTipo: "lista_espera", ventanaInicio: "09:30:00", ventanaFin: "18:00:00" })];
    // 2031-07-03 01:00 UTC = 19:00 locales.
    const r = await ejecutarMensajesHuesped(e.withTx, { ...OPCIONES, ahora: new Date("2031-07-03T01:00:00Z") });
    expect(r.diferidos).toBe(1);
  });
});

describe("ejecutarMensajesHuesped -- contenido sin PII filtrada ni inyeccion", () => {
  it("el nombre del huesped va escapado en el HTML del correo", async () => {
    const e = crearEntorno();
    e.repo.candidatos = [candidato({ huespedNombre: "<script>alert(1)</script> Ana" })];
    await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    const html = (e.repo.outbox[0]!.payload as { html: string }).html;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("pre_llegada lleva el enlace del aviso publico del hotel (lo pone el codigo)", async () => {
    const e = crearEntorno();
    await encender(e, "pre_llegada");
    e.repo.candidatos = [candidato({ evento: "pre_llegada", refTipo: "reserva", telefono: null })];
    await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    expect((e.repo.outbox[0]!.payload as { text: string }).text).toContain("https://app.atiende.ai/hoteles/hotel-brisa/aviso");
  });

  it("post_estancia lleva el enlace de resena configurado; sin el, el agradecimiento sale sin enlace", async () => {
    const con = crearEntorno();
    await encender(con, "post_estancia");
    con.repo.candidatos = [candidato({ evento: "post_estancia", refTipo: "reserva", telefono: null, resenaUrl: "https://g.page/r/ejemplo/review" })];
    await ejecutarMensajesHuesped(con.withTx, OPCIONES);
    expect((con.repo.outbox[0]!.payload as { text: string }).text).toContain("https://g.page/r/ejemplo/review");
    const sin = crearEntorno();
    await encender(sin, "post_estancia");
    sin.repo.candidatos = [candidato({ evento: "post_estancia", refTipo: "reserva", telefono: null })];
    await ejecutarMensajesHuesped(sin.withTx, OPCIONES);
    expect((sin.repo.outbox[0]!.payload as { text: string }).text).not.toContain("http");
  });
});

describe("ejecutarMensajesHuesped -- fallos", () => {
  it("base sin la migracion 046: disponible false, sin tocar nada y sin error", async () => {
    const e = crearEntorno({ migrado: false });
    const r = await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    expect(r).toMatchObject({ disponible: false, candidatos: 0, encolados: 0 });
  });

  it("la lista de supresion no se puede verificar: FAIL-CLOSED, el candidato no se emite y se reintenta en la siguiente corrida", async () => {
    const e = crearEntorno();
    e.repo.candidatos = [candidato()];
    e.fallaSupresion = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    expect(r).toMatchObject({ errores: 1, encolados: 0 });
    expect(e.repo.envios).toHaveLength(0);
    // Los logs llevan ids y la clase de error, nunca el telefono ni el correo.
    const registrado = JSON.stringify(err.mock.calls);
    expect(registrado).not.toContain("5511112222");
    expect(registrado).not.toContain("ana@example.com");
    err.mockRestore();
    e.fallaSupresion = false;
    expect((await ejecutarMensajesHuesped(e.withTx, OPCIONES)).encolados).toBe(1);
  });

  it("un error en un candidato no impide procesar los demas (una transaccion por unidad)", async () => {
    const e = crearEntorno();
    e.repo.candidatos = [candidato({ refId: "00000000-0000-0000-0000-0000000f2001" }), candidato({ refId: "00000000-0000-0000-0000-0000000f2002" })];
    const original = e.repo.emitir.bind(e.repo);
    let n = 0;
    e.repo.emitir = async (x) => {
      n += 1;
      if (n === 1) throw Object.assign(new Error("fallo SQL"), { code: "40001" });
      return original(x);
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await ejecutarMensajesHuesped(e.withTx, OPCIONES);
    err.mockRestore();
    expect(r).toMatchObject({ errores: 1, encolados: 1 });
  });

  it("el aviso in-app que falla no tumba la corrida", async () => {
    const e = crearEntorno();
    e.repo.candidatos = [candidato({ telefono: null, correo: null })];
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await ejecutarMensajesHuesped(e.withTx, { ...OPCIONES, alNoEnviados: async () => { throw new Error("boom"); } });
    err.mockRestore();
    expect(r).toMatchObject({ noEnviados: 1, errores: 0 });
  });

  it("un evento APAGADO por gerencia no es candidato (hold.aprobado activo=false); pre_llegada encendido si", async () => {
    const e = crearEntorno();
    await e.repo.guardarConfig(PROP, "hold.aprobado", { activo: false, horasAntes: null, resenaUrl: null });
    e.repo.candidatos = [candidato(), candidato({ evento: "pre_llegada", refTipo: "reserva", refId: "00000000-0000-0000-0000-0000000e0002" })];
    expect((await ejecutarMensajesHuesped(e.withTx, OPCIONES)).candidatos).toBe(0); // pre_llegada esta apagado por omision
    await e.repo.guardarConfig(PROP, "pre_llegada", { activo: true, horasAntes: 48, resenaUrl: null });
    expect((await ejecutarMensajesHuesped(e.withTx, OPCIONES)).candidatos).toBe(1);
  });

  it("acota la corrida a una propiedad y una referencia (disparo tras una decision del staff)", async () => {
    const e = crearEntorno();
    e.repo.candidatos = [candidato(), candidato({ refId: "00000000-0000-0000-0000-0000000f1099", propertyId: "00000000-0000-0000-0000-0000000b1b01" })];
    const r = await ejecutarMensajesHuesped(e.withTx, { ...OPCIONES, propertyId: PROP, refId: "00000000-0000-0000-0000-0000000f1001" });
    expect(r).toMatchObject({ candidatos: 1, encolados: 1 });
    expect(AHORA.toISOString()).toContain("2031");
  });
});
