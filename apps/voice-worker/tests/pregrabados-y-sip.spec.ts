// Pregrabados (audio local) y lectura de los atributos del participante SIP de LiveKit.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MENSAJE_IDS } from "@atiende/voice-core";
import { extraerTelefonoSipFrom } from "@atiende/domain-restaurantes";
import { escribirWav } from "../src/audio/pcm.ts";
import { cargarPregrabados } from "../src/pregrabados.ts";
import { infoDeParticipanteSip } from "../src/telefonia/sip-atributos.ts";
import { tono } from "./support/audio.ts";

let dir: string | null = null;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

describe("cargarPregrabados", () => {
  it("con los 15 WAV carga todos; la carpeta vacia los reporta TODOS como faltantes", async () => {
    dir = await mkdtemp(join(tmpdir(), "voz-pregrabados-"));
    expect((await cargarPregrabados(dir)).faltantes).toHaveLength(MENSAJE_IDS.length);
    for (const id of MENSAJE_IDS) await writeFile(join(dir, `${id}.wav`), escribirWav(tono(24_000, 50), 24_000));
    const r = await cargarPregrabados(dir);
    expect(r.faltantes).toEqual([]);
    expect(r.audios.size).toBe(15);
    expect(r.audios.get("handoff")?.hz).toBe(24_000);
  });

  it("un archivo ilegible cuenta como faltante e invalido (no se reproduce ruido)", async () => {
    dir = await mkdtemp(join(tmpdir(), "voz-pregrabados-"));
    await writeFile(join(dir, "despedida.wav"), new Uint8Array(100));
    const r = await cargarPregrabados(dir);
    expect(r.invalidos).toEqual(["despedida"]);
    expect(r.faltantes).toContain("despedida");
  });

  it("una carpeta que no existe no lanza: todos faltan", async () => {
    expect((await cargarPregrabados("/ruta/que/no/existe")).faltantes).toHaveLength(15);
  });
});

describe("infoDeParticipanteSip", () => {
  it("DNIS del trunk y origen en forma de URI SIP que `extraerTelefonoSipFrom` entiende", () => {
    const info = infoDeParticipanteSip({ "sip.phoneNumber": "+5219991234567", "sip.trunkPhoneNumber": "+529991110001" });
    expect(info.dnis).toBe("+529991110001");
    expect(extraerTelefonoSipFrom(info.sipFrom)).toBe("9991234567");
    expect(info.desviadaDesde).toBeNull();
  });

  it.each(["anonymous", "Anonymous", "unavailable", "restricted", "private"])("el origen '%s' es un llamante sin telefono", (valor) => {
    expect(extraerTelefonoSipFrom(infoDeParticipanteSip({ "sip.phoneNumber": valor }).sipFrom)).toBeNull();
  });

  it("sin origen reportado no hay telefono", () => {
    expect(infoDeParticipanteSip({}).sipFrom).toBeNull();
    expect(extraerTelefonoSipFrom(infoDeParticipanteSip({}).sipFrom)).toBeNull();
  });

  it("el desvio condicional del conmutador sale de los encabezados Diversion / History-Info", () => {
    expect(infoDeParticipanteSip({ "sip.h.Diversion": "<sip:+529991110000@conmutador>;reason=no-answer" }).desviadaDesde).toContain("conmutador");
    expect(infoDeParticipanteSip({ "sip.h.history-info": "<sip:+529991110000@c>" }).desviadaDesde).not.toBeNull();
    expect(infoDeParticipanteSip({ "sip.h.user-agent": "Twilio" }).desviadaDesde).toBeNull();
  });

  it("un valor con caracteres de control o gigante no entra: el origen sintetico no puede inyectar partes de URI", () => {
    const info = infoDeParticipanteSip({ "sip.phoneNumber": "+521999@evil;x=<y>", "sip.trunkPhoneNumber": "x".repeat(400) });
    expect(info.sipFrom).not.toContain("<y>");
    expect(info.sipFrom?.match(/@/g)).toHaveLength(1);
    expect(info.dnis).toBeNull();
  });
});
