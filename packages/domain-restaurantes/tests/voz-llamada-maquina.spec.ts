// Politicas de la llamada de voz (R-05 endurecimiento): barge-in, silencio, ruido, DTMF, limites de duracion y costo,
// reconexion, tool lenta, tope mensual al iniciar, caller ID del SIP From y log sin PII.
import { describe, expect, it } from "vitest";
import { CallStateMachine, LIMITES_POR_DEFECTO } from "../src/voz/llamada/maquina.ts";
import type { AccionLlamada, EventoLlamada } from "../src/voz/llamada/maquina.ts";
import { evaluarInicioLlamada } from "../src/voz/llamada/inicio.ts";
import { extraerTelefonoSipFrom } from "../src/voz/llamada/sip.ts";
import { eventoSinPII, redactarPII, referenciaLlamada } from "../src/voz/llamada/log-sin-pii.ts";
import { MENSAJES_PREGRABADOS, MENSAJE_IDS } from "../src/voz/llamada/mensajes.ts";

function correr(eventos: readonly EventoLlamada[], limites = LIMITES_POR_DEFECTO) {
  const m = new CallStateMachine(limites);
  const acciones: AccionLlamada[] = [];
  for (const e of eventos) acciones.push(...m.recibir(e));
  return { m, acciones };
}
const conectada: EventoLlamada = { tipo: "conectada" };
const pedido: EventoLlamada = { tipo: "tool_resultado", nombre: "crear_pedido", ok: true, orderId: "o-1" };

describe("barge-in", () => {
  it("si el cliente habla mientras el agente habla, se corta el audio del agente (una sola vez)", () => {
    const { acciones } = correr([conectada, { tipo: "agente_empieza" }, { tipo: "usuario_habla" }, { tipo: "usuario_habla" }]);
    expect(acciones).toEqual([{ tipo: "cortar_audio_agente" }]);
  });
  it("si el agente no habla, el cliente hablando no corta nada", () => {
    expect(correr([conectada, { tipo: "usuario_habla" }]).acciones).toEqual([]);
  });
});

describe("silencio", () => {
  it("re-pregunta dos veces, la tercera se despide y la llamada queda abandonada", () => {
    const s: EventoLlamada = { tipo: "silencio", ms: 7000 };
    const { m, acciones } = correr([conectada, s, s, s]);
    expect(acciones).toEqual([
      { tipo: "decir", mensaje: "silencio_reprompt" },
      { tipo: "decir", mensaje: "silencio_reprompt" },
      { tipo: "decir", mensaje: "silencio_despedida" },
      { tipo: "colgar", resultado: "abandonado" },
    ]);
    expect(m.estadoActual).toBe("cerrada");
  });
  it("un silencio corto no cuenta y que el cliente hable reinicia la cuenta", () => {
    const { acciones } = correr([conectada, { tipo: "silencio", ms: 3000 }, { tipo: "silencio", ms: 7000 }, { tipo: "usuario_dijo" }, { tipo: "silencio", ms: 7000 }, { tipo: "silencio", ms: 7000 }]);
    expect(acciones.filter((a) => a.tipo === "colgar")).toHaveLength(0);
  });
  it("con el pedido ya creado el silencio solo cierra con despedida (resultado pedido_creado)", () => {
    const { acciones } = correr([conectada, pedido, { tipo: "silencio", ms: 9000 }]);
    expect(acciones).toEqual([{ tipo: "decir", mensaje: "despedida" }, { tipo: "colgar", resultado: "pedido_creado" }]);
  });
});

describe("ruido y malentendidos", () => {
  it("tres ruidos seguidos cuentan como un malentendido y se pide repetir", () => {
    expect(correr([conectada, { tipo: "ruido" }, { tipo: "ruido" }, { tipo: "ruido" }]).acciones).toEqual([{ tipo: "pedir_repetir" }]);
  });
  it("dos malentendidos seguidos pasan a una persona (no_entiende) y dejan callback", () => {
    const { acciones, m } = correr([conectada, { tipo: "no_entendido" }, { tipo: "no_entendido" }]);
    expect(acciones).toEqual([
      { tipo: "pedir_repetir" },
      { tipo: "decir", mensaje: "handoff" },
      { tipo: "escalar", motivo: "no_entiende" },
      { tipo: "colgar", resultado: "escalado" },
    ]);
    expect(m.resultado).toBe("escalado");
  });
  it("hablar con claridad entre dos fallos reinicia la cuenta", () => {
    const { acciones } = correr([conectada, { tipo: "no_entendido" }, { tipo: "usuario_dijo", inteligible: true }, { tipo: "no_entendido" }]);
    expect(acciones).toEqual([{ tipo: "pedir_repetir" }, { tipo: "pedir_repetir" }]);
  });
  it("voz marcada como no inteligible se trata como ruido", () => {
    const e: EventoLlamada = { tipo: "usuario_dijo", inteligible: false };
    expect(correr([conectada, e, e, e]).acciones).toEqual([{ tipo: "pedir_repetir" }]);
  });
});

describe("DTMF opcional", () => {
  it("0 pasa a una persona, * repite, otros digitos se ignoran", () => {
    expect(correr([conectada, { tipo: "dtmf", digito: "5" }, { tipo: "dtmf", digito: "*" }]).acciones).toEqual([{ tipo: "pedir_repetir" }]);
    expect(correr([conectada, { tipo: "dtmf", digito: "0" }]).acciones).toEqual([
      { tipo: "decir", mensaje: "handoff" },
      { tipo: "escalar", motivo: "cliente_lo_pide" },
      { tipo: "colgar", resultado: "escalado" },
    ]);
  });
  it("con DTMF apagado no hace nada", () => {
    expect(correr([conectada, { tipo: "dtmf", digito: "0" }], { ...LIMITES_POR_DEFECTO, dtmf: false }).acciones).toEqual([]);
  });
});

describe("limite de duracion y de costo", () => {
  it("avisa a los 7 min (una sola vez) y corta a los 8 min con callback", () => {
    const { acciones } = correr([conectada, { tipo: "tick", segundos: 421 }, { tipo: "tick", segundos: 430 }, { tipo: "tick", segundos: 480 }]);
    expect(acciones).toEqual([
      { tipo: "decir", mensaje: "aviso_duracion" },
      { tipo: "decir", mensaje: "limite_duracion" },
      { tipo: "escalar", motivo: "no_puedo_resolver" },
      { tipo: "colgar", resultado: "escalado" },
    ]);
  });
  it("el costo acumulado que llega al tope corta la llamada; abajo del tope no", () => {
    const tope = LIMITES_POR_DEFECTO.costoMaxMicroUsd;
    const { acciones, m } = correr([conectada, { tipo: "costo", microUsd: 60_000 }, { tipo: "costo", microUsd: tope - 60_001 }]);
    expect(acciones).toEqual([]);
    expect(m.recibir({ tipo: "costo", microUsd: 1 })).toEqual([
      { tipo: "decir", mensaje: "limite_costo" },
      { tipo: "escalar", motivo: "no_puedo_resolver" },
      { tipo: "colgar", resultado: "escalado" },
    ]);
  });
  it("nunca escala un pedido ya creado: solo se despide y el resultado sigue siendo pedido_creado", () => {
    const { acciones, m } = correr([conectada, pedido, { tipo: "tick", segundos: 500 }]);
    expect(acciones).toEqual([{ tipo: "decir", mensaje: "despedida" }, { tipo: "colgar", resultado: "pedido_creado" }]);
    expect(m.resultado).toBe("pedido_creado");
  });
  it("una vez cerrada ignora todo", () => {
    const { m } = correr([conectada, { tipo: "cliente_cuelga" }]);
    expect(m.recibir({ tipo: "tick", segundos: 999 })).toEqual([]);
    expect(m.resultado).toBe("abandonado");
  });
});

describe("proveedor caido", () => {
  it("la primera caida reconecta; si vuelve, la llamada sigue", () => {
    const { acciones, m } = correr([conectada, { tipo: "proveedor_cae" }]);
    expect(acciones).toEqual([{ tipo: "reconectar", intento: 1, esperaMs: 400 }]);
    expect(m.estadoActual).toBe("reconectando");
    m.recibir({ tipo: "proveedor_vuelve" });
    expect(m.estadoActual).toBe("activa");
  });
  it("la segunda caida usa el pregrabado, deja callback (falla_sistema) y cuelga", () => {
    const { acciones } = correr([conectada, { tipo: "proveedor_cae" }, { tipo: "proveedor_vuelve" }, { tipo: "proveedor_cae" }]);
    expect(acciones.slice(1)).toEqual([
      { tipo: "decir", mensaje: "proveedor_caido" },
      { tipo: "escalar", motivo: "falla_sistema" },
      { tipo: "colgar", resultado: "escalado" },
    ]);
  });
  it("si cae despues de crear el pedido no se escala nada", () => {
    const { acciones } = correr([conectada, pedido, { tipo: "proveedor_cae" }, { tipo: "proveedor_cae" }]);
    expect(acciones.map((a) => a.tipo)).toEqual(["reconectar", "decir", "colgar"]);
    expect(acciones.at(-1)).toEqual({ tipo: "colgar", resultado: "pedido_creado" });
  });
});

describe("herramientas lentas", () => {
  it("un timeout avisa; dos seguidos pasan a una persona; un exito reinicia la cuenta", () => {
    const t: EventoLlamada = { tipo: "tool_resultado", nombre: "buscar_producto", ok: false, timeout: true };
    const ok: EventoLlamada = { tipo: "tool_resultado", nombre: "buscar_producto", ok: true };
    expect(correr([conectada, t]).acciones).toEqual([{ tipo: "decir", mensaje: "tool_timeout" }]);
    expect(correr([conectada, t, ok, t]).acciones).toEqual([{ tipo: "decir", mensaje: "tool_timeout" }, { tipo: "decir", mensaje: "tool_timeout" }]);
    expect(correr([conectada, t, t]).acciones.map((a) => a.tipo)).toEqual(["decir", "decir", "escalar", "colgar"]);
  });
  it("si el agente escala por su cuenta, la llamada se cierra al terminar de despedirse", () => {
    const { acciones, m } = correr([conectada, { tipo: "tool_resultado", nombre: "escalar_a_humano", ok: true }, { tipo: "agente_empieza" }, { tipo: "agente_termina" }]);
    expect(acciones).toEqual([{ tipo: "colgar", resultado: "escalado" }]);
    expect(m.resultado).toBe("escalado");
  });
});

describe("tope mensual al iniciar", () => {
  it("bloquea al llegar al tope, deja pasar abajo, sin tope o sin lectura del gasto", () => {
    expect(evaluarInicioLlamada({ habilitado: true, gastoMesMicroUsd: 50, topeMensualMicroUsd: 50 })).toEqual({ ok: false, razon: "tope_mensual", mensaje: "tope_mensual" });
    expect(evaluarInicioLlamada({ habilitado: true, gastoMesMicroUsd: 49, topeMensualMicroUsd: 50 })).toEqual({ ok: true });
    expect(evaluarInicioLlamada({ habilitado: true, gastoMesMicroUsd: 999, topeMensualMicroUsd: null })).toEqual({ ok: true });
    expect(evaluarInicioLlamada({ habilitado: true, gastoMesMicroUsd: null, topeMensualMicroUsd: 50 })).toEqual({ ok: true });
    expect(evaluarInicioLlamada({ habilitado: false, gastoMesMicroUsd: 0, topeMensualMicroUsd: null }).ok).toBe(false);
  });
});

describe("caller ID del SIP From", () => {
  it.each([
    ['"Ana" <sip:+5219991234567@trunk.example.com;user=phone>;tag=abc', "9991234567"],
    ["sip:5219991234567@10.0.0.1", "9991234567"],
    ["<sips:9991234567@host>", "9991234567"],
    ["tel:+52-999-123-4567", "9991234567"],
    ["sip:+529991234567@host:5060;transport=udp", "9991234567"],
  ])("extrae el telefono de %s", (from, esperado) => {
    expect(extraerTelefonoSipFrom(from)).toBe(esperado);
  });
  it.each([null, undefined, "", "sip:anonymous@anonymous.invalid", "sip:Restricted@host", "sip:12345@host", "<sip:%E0%A4%A@host>", "texto cualquiera", "sip:+14155550123@host"])("devuelve null para %s", (from) => {
    expect(extraerTelefonoSipFrom(from as string | null | undefined)).toBeNull();
  });
});

describe("log sin PII", () => {
  it("redacta telefonos, correos, direcciones y tarjetas", () => {
    const t = redactarPII("Soy Ana, mi cel es 999 123 4567, correo ana@correo.com, vivo en calle 63 numero 412 por 45, tarjeta 4111 1111 1111 1111");
    expect(t).not.toMatch(/999 123 4567|ana@correo|calle 63|4111/);
    expect(t).toMatch(/\[TELEFONO\]|\[CORREO\]|\[DIRECCION\]|\[TARJETA REDACTADA\]/);
  });
  it("solo deja pasar campos de la lista cerrada y nunca texto del cliente", () => {
    const lineas: unknown[] = [];
    eventoSinPII((l) => lineas.push(l), "tool", { herramienta: "buscar_producto", ms: 120, ok: true, texto: "quiero tacos, mi direccion es calle 1", telefono: "9991234567", motivo: "llama al 999 123 4567" });
    const s = JSON.stringify(lineas);
    expect(s).toContain("buscar_producto");
    expect(s).not.toMatch(/quiero tacos|calle 1|"telefono"|9991234567|999 123/);
  });
  it("la referencia de llamada es opaca y estable", () => {
    expect(referenciaLlamada("CA123")).toBe(referenciaLlamada("CA123"));
    expect(referenciaLlamada("CA123")).not.toContain("CA123");
  });
});

describe("mensajes pregrabados", () => {
  it("todos tratan de usted y ninguno lleva datos personales", () => {
    expect(MENSAJE_IDS.length).toBeGreaterThanOrEqual(10);
    for (const id of MENSAJE_IDS) {
      const t = MENSAJES_PREGRABADOS[id];
      expect(redactarPII(t)).toBe(t);
      expect(t).not.toMatch(/\b(t[uú]|tienes|quieres|puedes)\b/i);
    }
  });
});
