// C-04 -- validacion, armado, vista previa, diferencias y horario de envio de los mensajes de WhatsApp editables.
import { describe, expect, it } from "vitest";
import {
  ANTICIPACION_POR_OMISION_HORAS,
  MENSAJES_CONFIG_POR_OMISION,
  VALORES_DE_MUESTRA,
  configDesdeFoto,
  dentroDelHorarioDeEnvio,
  diferenciasConfigMensajes,
  fotoConfigMensajes,
  legacyReminderBody,
  previewMensajes,
  renderizarMensaje,
  sanitizarValor,
  textoPorOmision,
  validarConfigMensajes,
  validarTextoMensaje,
  reservaMuyReciente,
  ventanaDeRecordatorio,
} from "../src/whatsapp/message-config.ts";

describe("validarTextoMensaje", () => {
  it("acepta un texto con variables validas y lo recorta", () => {
    expect(validarTextoMensaje("  Hola {{nombre}}, es a las {{hora}}  ", "recordatorio")).toEqual({ ok: true, valor: "Hola {{nombre}}, es a las {{hora}}" });
  });

  it("vacio o null significa 'usar el texto por defecto'", () => {
    expect(validarTextoMensaje("   ", "recordatorio")).toEqual({ ok: true, valor: null });
    expect(validarTextoMensaje(null, "confirmacion")).toEqual({ ok: true, valor: null });
    expect(validarTextoMensaje(undefined, "confirmacion")).toEqual({ ok: true, valor: null });
  });

  it("rechaza una variable desconocida y dice cuales existen", () => {
    const r = validarTextoMensaje("Hola {{apellido}} a las {{hora}}", "recordatorio");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("{{apellido}}");
  });

  it("{{fecha_anterior}} solo existe al reagendar", () => {
    expect(validarTextoMensaje("Antes {{fecha_anterior}}, ahora {{fecha_hora}}", "reagendado").ok).toBe(true);
    expect(validarTextoMensaje("Antes {{fecha_anterior}}, ahora {{fecha_hora}}", "confirmacion").ok).toBe(false);
  });

  it("rechaza llaves sueltas o mal cerradas", () => {
    expect(validarTextoMensaje("Hola {{nombre a las {{hora}}", "recordatorio").ok).toBe(false);
    expect(validarTextoMensaje("Hola {nombre} {{hora}} }}", "recordatorio").ok).toBe(false);
  });

  it("exige hora o fecha_hora salvo en la cancelacion", () => {
    expect(validarTextoMensaje("Hola {{nombre}}", "recordatorio").ok).toBe(false);
    expect(validarTextoMensaje("Hola {{nombre}}", "confirmacion").ok).toBe(false);
    expect(validarTextoMensaje("Hola {{nombre}}, su cita fue cancelada", "cancelacion").ok).toBe(true);
  });

  it("borde: 600 caracteres si, 601 no", () => {
    const base = "{{hora}} ";
    expect(validarTextoMensaje(base + "a".repeat(600 - base.length), "recordatorio").ok).toBe(true);
    expect(validarTextoMensaje(base + "a".repeat(601 - base.length), "recordatorio").ok).toBe(false);
  });

  it("permite saltos de linea pero no otros caracteres de control", () => {
    expect(validarTextoMensaje("Hola\n{{hora}}", "recordatorio").ok).toBe(true);
    expect(validarTextoMensaje("Hola\u0007{{hora}}", "recordatorio").ok).toBe(false);
    expect(validarTextoMensaje("Hola {{hora}}", "recordatorio").ok).toBe(false);
  });

  it("rechaza un valor que no es texto", () => {
    expect(validarTextoMensaje(42, "recordatorio").ok).toBe(false);
  });
});

describe("validarConfigMensajes", () => {
  it("un objeto vacio toma los valores de fabrica", () => {
    expect(validarConfigMensajes({})).toEqual({ ok: true, valor: MENSAJES_CONFIG_POR_OMISION });
  });

  it("rechaza algo que no es un objeto", () => {
    expect(validarConfigMensajes(null).ok).toBe(false);
    expect(validarConfigMensajes([]).ok).toBe(false);
    expect(validarConfigMensajes("x").ok).toBe(false);
  });

  it("anticipacion: 1 y 72 si; 0, 73, 1.5 y '12' no", () => {
    expect(validarConfigMensajes({ reminderLeadHours: 1 }).ok).toBe(true);
    expect(validarConfigMensajes({ reminderLeadHours: 72 }).ok).toBe(true);
    for (const malo of [0, 73, 1.5, "12", -3]) expect(validarConfigMensajes({ reminderLeadHours: malo }).ok).toBe(false);
  });

  it("horario de envio: ambos o ninguno, fin mayor que inicio, rangos 0-23 / 1-24", () => {
    expect(validarConfigMensajes({ sendWindowStart: 9, sendWindowEnd: 20 }).ok).toBe(true);
    expect(validarConfigMensajes({ sendWindowStart: 0, sendWindowEnd: 24 }).ok).toBe(true);
    expect(validarConfigMensajes({ sendWindowStart: 9 }).ok).toBe(false);
    expect(validarConfigMensajes({ sendWindowEnd: 20 }).ok).toBe(false);
    expect(validarConfigMensajes({ sendWindowStart: 20, sendWindowEnd: 9 }).ok).toBe(false);
    expect(validarConfigMensajes({ sendWindowStart: 9, sendWindowEnd: 9 }).ok).toBe(false);
    expect(validarConfigMensajes({ sendWindowStart: 24, sendWindowEnd: 24 }).ok).toBe(false);
    expect(validarConfigMensajes({ sendWindowStart: 0, sendWindowEnd: 25 }).ok).toBe(false);
  });

  it("las banderas deben ser booleanas", () => {
    expect(validarConfigMensajes({ confirmationEnabled: "si" }).ok).toBe(false);
    const r = validarConfigMensajes({ confirmationEnabled: true, cancellationEnabled: true, rescheduleEnabled: true, reminderEnabled: false });
    expect(r.ok && r.valor.confirmationEnabled && r.valor.cancellationEnabled && r.valor.rescheduleEnabled && !r.valor.reminderEnabled).toBe(true);
  });

  it("el error de un texto invalido se propaga con el nombre del mensaje", () => {
    const r = validarConfigMensajes({ cancellationText: "Hola {{inventada}}" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Cancelación");
  });
});

describe("renderizarMensaje", () => {
  it("sustituye en una sola pasada: un valor con llaves NO se vuelve a expandir", () => {
    const hostil = sanitizarValor("{{hora}} Mallory");
    expect(hostil).not.toContain("{");
    expect(renderizarMensaje("Hola {{nombre}} a las {{hora}}", { nombre: "{{hora}}", hora: "10:00" })).toBe("Hola {{hora}} a las 10:00");
  });

  it("una variable sin valor queda vacia y el resultado se acota a 1024", () => {
    expect(renderizarMensaje("A{{servicio}}B", {})).toBe("AB");
    expect(renderizarMensaje("x".repeat(2000), {}).length).toBe(1024);
  });

  it("tolera espacios dentro de las llaves y mayusculas", () => {
    expect(renderizarMensaje("{{ Nombre }}", { nombre: "Ana" })).toBe("Ana");
  });
});

describe("sanitizarValor", () => {
  it("quita controles y llaves, junta espacios y acota", () => {
    expect(sanitizarValor("  Ana\u0000\n  {Lopez}  ")).toBe("Ana Lopez");
    expect(sanitizarValor("a".repeat(200), 80).length).toBe(80);
    expect(sanitizarValor(null)).toBe("");
  });
});

describe("texto por defecto y compatibilidad", () => {
  it("el recordatorio de siempre (golden): con y sin nombre", () => {
    expect(legacyReminderBody("María", "10:00 a. m.")).toBe("Hola María, le recordamos su cita mañana a las 10:00 a. m. ¿Puede confirmar?");
    expect(legacyReminderBody(null, "10:00 a. m.")).toBe("Hola, le recordamos su cita mañana a las 10:00 a. m. ¿Puede confirmar?");
  });

  it("el default de 24 h dice 'mañana'; con otra anticipacion usa la fecha", () => {
    expect(textoPorOmision("recordatorio", ANTICIPACION_POR_OMISION_HORAS)).toContain("mañana");
    expect(textoPorOmision("recordatorio", 12)).toContain("{{fecha}}");
    expect(textoPorOmision("recordatorio", 12)).not.toContain("mañana");
  });

  it("todos los textos por defecto pasan su propia validacion", () => {
    for (const kind of ["recordatorio", "confirmacion", "cancelacion", "reagendado"] as const) {
      expect(validarTextoMensaje(textoPorOmision(kind), kind).ok).toBe(true);
    }
  });
});

describe("previewMensajes", () => {
  it("con la configuracion de fabrica el recordatorio es el de siempre y los demas estan apagados", () => {
    const p = previewMensajes(MENSAJES_CONFIG_POR_OMISION);
    expect(p.map((x) => x.kind)).toEqual(["recordatorio", "confirmacion", "cancelacion", "reagendado"]);
    expect(p[0]!.texto).toBe(legacyReminderBody(VALORES_DE_MUESTRA.nombre, VALORES_DE_MUESTRA.hora));
    expect(p.map((x) => x.activo)).toEqual([true, false, false, false]);
    expect(p.every((x) => x.esPorDefecto)).toBe(true);
  });

  it("usa el texto propio con valores de muestra, nunca datos reales", () => {
    const p = previewMensajes({ ...MENSAJES_CONFIG_POR_OMISION, confirmationEnabled: true, confirmationText: "Listo {{nombre}}: {{servicio}} el {{fecha_hora}}" });
    const conf = p.find((x) => x.kind === "confirmacion")!;
    expect(conf.texto).toBe("Listo María: Consulta general el jueves 2 de octubre, 10:00 a. m.");
    expect(conf.esPorDefecto).toBe(false);
    expect(conf.activo).toBe(true);
  });
});

describe("horario de envio", () => {
  const ventana = { sendWindowStart: 9, sendWindowEnd: 20 } as const;

  it("sin horario siempre se puede enviar", () => {
    expect(dentroDelHorarioDeEnvio({ sendWindowStart: null, sendWindowEnd: null }, new Date("2026-09-13T03:00:00Z"), "America/Merida")).toBe(true);
  });

  it("usa la hora LOCAL del negocio, no la del servidor (UTC): 15:00Z es 09:00 en Merida", () => {
    expect(dentroDelHorarioDeEnvio(ventana, new Date("2026-09-13T15:00:00Z"), "America/Merida")).toBe(true);
    expect(dentroDelHorarioDeEnvio(ventana, new Date("2026-09-13T14:59:00Z"), "America/Merida")).toBe(false);
  });

  it("el fin es exclusivo: a las 20:00 locales ya no", () => {
    expect(dentroDelHorarioDeEnvio(ventana, new Date("2026-09-14T01:59:00Z"), "America/Merida")).toBe(true); // 19:59
    expect(dentroDelHorarioDeEnvio(ventana, new Date("2026-09-14T02:00:00Z"), "America/Merida")).toBe(false); // 20:00
  });

  it("0-24 equivale a todo el dia", () => {
    const todo = { sendWindowStart: 0, sendWindowEnd: 24 };
    expect(dentroDelHorarioDeEnvio(todo, new Date("2026-09-13T06:00:00Z"), "America/Merida")).toBe(true); // 00:00 local
    expect(dentroDelHorarioDeEnvio(todo, new Date("2026-09-14T05:59:00Z"), "America/Merida")).toBe(true); // 23:59 local
  });
});

describe("ventanaDeRecordatorio (C-14)", () => {
  const now = new Date("2026-09-13T16:00:00.000Z");

  it("con la configuracion de fabrica es (ahora, ahora + 24 h]: ya no es una franja de 1 h alrededor de las 24 h", () => {
    const { from, to } = ventanaDeRecordatorio(now, MENSAJES_CONFIG_POR_OMISION);
    expect(from.toISOString()).toBe("2026-09-13T16:00:00.000Z");
    expect(to.toISOString()).toBe("2026-09-14T16:00:00.000Z");
  });

  it("anticipacion distinta mueve solo el final de la ventana", () => {
    const { from, to } = ventanaDeRecordatorio(now, { ...MENSAJES_CONFIG_POR_OMISION, reminderLeadHours: 2 });
    expect(from.toISOString()).toBe("2026-09-13T16:00:00.000Z");
    expect(to.toISOString()).toBe("2026-09-13T18:00:00.000Z");
  });

  it("nunca incluye citas que ya empezaron, tenga o no horario de envio", () => {
    expect(ventanaDeRecordatorio(now, { reminderLeadHours: 1 }).from.getTime()).toBe(now.getTime());
  });
});

describe("reservaMuyReciente (C-14)", () => {
  const now = new Date("2026-09-13T16:00:00.000Z");
  it("una reserva de hace menos de 1 h es reciente; de hace 1 h o mas, no", () => {
    expect(reservaMuyReciente("2026-09-13T15:30:00.000Z", now)).toBe(true);
    expect(reservaMuyReciente("2026-09-13T15:00:00.000Z", now)).toBe(false);
    expect(reservaMuyReciente("2026-09-12T10:00:00.000Z", now)).toBe(false);
  });
  it("sin fecha, ilegible o fechada en el futuro no cuenta como reciente (nunca bloquea un recordatorio por un dato raro)", () => {
    expect(reservaMuyReciente(null, now)).toBe(false);
    expect(reservaMuyReciente(undefined, now)).toBe(false);
    expect(reservaMuyReciente("no-es-fecha", now)).toBe(false);
    expect(reservaMuyReciente("2026-09-13T17:00:00.000Z", now)).toBe(false);
  });
});

describe("historial y diferencias", () => {
  it("sin version anterior compara contra los valores de fabrica", () => {
    const despues = fotoConfigMensajes({ ...MENSAJES_CONFIG_POR_OMISION, reminderLeadHours: 12, confirmationEnabled: true });
    const d = diferenciasConfigMensajes(null, despues);
    expect(d.map((x) => x.campo)).toEqual(["Anticipación del recordatorio (horas)", "Aviso de confirmación activo"]);
    expect(d[1]).toMatchObject({ antes: "no", despues: "si" });
  });

  it("sin cambios no hay diferencias; vacio y null cuentan igual", () => {
    const foto = fotoConfigMensajes(MENSAJES_CONFIG_POR_OMISION);
    expect(diferenciasConfigMensajes(foto, foto)).toEqual([]);
    expect(diferenciasConfigMensajes({ ...foto, reminderText: "" }, foto)).toEqual([]);
  });

  it("configDesdeFoto reconstruye una configuracion valida y cae a la de fabrica si la foto es invalida", () => {
    const cfg = { ...MENSAJES_CONFIG_POR_OMISION, reminderLeadHours: 6, sendWindowStart: 8, sendWindowEnd: 18 };
    expect(configDesdeFoto(fotoConfigMensajes(cfg))).toEqual(cfg);
    expect(configDesdeFoto({ reminderLeadHours: 999 })).toEqual(MENSAJES_CONFIG_POR_OMISION);
  });
});
