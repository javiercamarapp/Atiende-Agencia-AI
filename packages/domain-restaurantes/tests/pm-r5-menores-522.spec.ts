// Menores de #522 (QA-PM R5): ventana de la toma de handoff, "se lo pasan a la persona que va a recoger", "ya, no gracias a ustedes" y "Le atienden a partir de las 12".
// Con casos NEGATIVOS (futuro, condicional, negacion, pregunta, historial).
import { describe, expect, it } from "vitest";
import { corregirPromesaDeHorarioNocturno, pideUnaPersona, retractaPeticionDePersona } from "../src/whatsapp/guards.ts";
import { abreTomaDeHandoff } from "../src/whatsapp/inbound.ts";

const u = (content: string) => ({ role: "user" as const, content });
const a = (content: string) => ({ role: "assistant" as const, content });

describe("pideUnaPersona: pasar el pedido a OTRA persona no es pedir una persona del equipo", () => {
  it.each([
    "se lo pasan a la persona que va a recoger",
    "se lo pasan a la persona que pasa por el",
    "ahi se lo pasan a la persona que va a recoger mi pedido por favor",
    "le pasan el pedido a la persona que va a recoger",
  ])("%s -> NO pide persona", (t) => expect(pideUnaPersona(t)).toBe(false));
  it.each([
    "pasame con una persona",
    "quiero que me pasen a una persona",
    "me pasan con el gerente",
    "pasenme a un asesor por favor",
    "quiero hablar con una persona",
  ])("%s -> SI pide persona", (t) => expect(pideUnaPersona(t)).toBe(true));
});

describe("retractacion: 'ya, no gracias a ustedes' es un reclamo, no un 'ya no, gracias'", () => {
  it.each(["ya, no gracias a ustedes", "no gracias a ustedes", "ya no, gracias a ti nadie me atiende"])("%s -> NO es retractacion", (t) => expect(retractaPeticionDePersona(t)).toBe(false));
  it.each(["no, gracias", "ya no, gracias", "mejor sigo contigo", "bueno no, mejor sigo aqui"])("%s -> SI es retractacion", (t) => expect(retractaPeticionDePersona(t)).toBe(true));
  it("quiero una persona. ya, no gracias a ustedes -> sigue pidiendo persona", () => {
    expect(pideUnaPersona("quiero hablar con una persona, ya, no gracias a ustedes")).toBe(true);
  });
});

describe("abreTomaDeHandoff: ventana de mensajes del cliente", () => {
  it("una peticion de hace 6 mensajes (ya atendida) no abre la toma por una escalacion posterior", () => {
    const msgs = [u("quiero una persona"), a("..."), u("mensaje 2"), u("mensaje 3"), u("mensaje 4"), u("mensaje 5"), u("mensaje 6")];
    expect(abreTomaDeHandoff("cliente_lo_pide", msgs)).toBe(false);
  });
  it("la peticion dentro de los ultimos 4 mensajes del cliente (agente intercalado) sigue abriendo toma", () => {
    expect(abreTomaDeHandoff("cliente_lo_pide", [u("quiero hablar con una persona"), a("¿su nombre?"), u("Juan")])).toBe(true);
  });
  it("una retractacion posterior a la peticion cancela la toma", () => {
    expect(abreTomaDeHandoff("cliente_lo_pide", [u("quiero hablar con una persona"), a("¿su nombre?"), u("no, mejor sigo contigo")])).toBe(false);
  });
  it("negativo: un reclamo posterior ('ya, no gracias a ustedes') NO cancela la toma", () => {
    expect(abreTomaDeHandoff("cliente_lo_pide", [u("quiero hablar con una persona"), a("¿su nombre?"), u("ya, no gracias a ustedes")])).toBe(true);
  });
  it("los demas motivos conservan su regla", () => {
    expect(abreTomaDeHandoff("queja", [u("???")])).toBe(true);
  });
});

describe("corregirPromesaDeHorarioNocturno: sin sujeto, en plural impersonal", () => {
  it.each(["Le atienden a partir de las 12 del día.", "Ya avisé al gerente, le responden a partir de las 12.", "Le contestan a partir de las 12 pm."])("a las 14:00 se corrige: %s", (f) => {
    const r = corregirPromesaDeHorarioNocturno(f, 14);
    expect(r).not.toMatch(/a partir de las 12/);
    expect(r).toMatch(/en cuanto puedan/);
  });
  it.each(["Le atienden a partir de las 12 del día.", "Le atienden a partir de las 12."])("a las 8:00 (antes de abrir) se conserva: %s", (f) => {
    expect(corregirPromesaDeHorarioNocturno(f, 8)).toBe(f);
  });
  it.each(["Mañana abrimos a partir de las 12 del día.", "Los atendemos a partir de las 12.", "Si pregunta usted, le atienden a partir de las 5 pm."])("negativo: no toca %s", (f) => {
    expect(corregirPromesaDeHorarioNocturno(f, 14)).toBe(f);
  });
});
