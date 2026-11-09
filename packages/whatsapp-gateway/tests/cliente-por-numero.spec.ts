// Credenciales de Meta por organizacion (migracion 0090): el envio elige el token por el numero REMITENTE. Un numero con
// credencial propia sale con el cliente de ESE token; uno sin credencial, con el de plataforma (comportamiento de siempre).
import { describe, expect, it } from "vitest";
import { WhatsAppConfigError, WhatsAppSendError } from "../src/errors.ts";
import { WhatsAppGraphClientPorNumero } from "../src/providers/cliente-por-numero.ts";
import { FakeWhatsAppGraphClient } from "../src/providers/fake-graph-client.ts";

const mensaje = (phoneNumberId: string) => ({ to: "+5219991234567", phoneNumberId, body: "Hola" });

function armar(tokens: Readonly<Record<string, string>>, conPlataforma = true) {
  const plataforma = new FakeWhatsAppGraphClient();
  const creados = new Map<string, FakeWhatsAppGraphClient>();
  const cliente = new WhatsAppGraphClientPorNumero({
    ...(conPlataforma ? { plataforma } : {}),
    resolutor: { tokenDeNumero: async (pn) => tokens[pn] ?? null },
    crearCliente: (token) => {
      const c = new FakeWhatsAppGraphClient();
      creados.set(token, c);
      return c;
    },
  });
  return { cliente, plataforma, creados };
}

describe("WhatsAppGraphClientPorNumero", () => {
  it("un numero sin credencial propia sale con el cliente de plataforma (sin cambio)", async () => {
    const { cliente, plataforma, creados } = armar({});
    const r = await cliente.sendMessage(mensaje("111"));
    expect(r.providerMessageId).toBe("fake-msg-0");
    expect(plataforma.sent).toHaveLength(1);
    expect(creados.size).toBe(0);
  });

  it("un numero con credencial propia sale con el cliente de SU token, nunca con el de plataforma", async () => {
    const { cliente, plataforma, creados } = armar({ "222": "token-pm" });
    await cliente.sendMessage(mensaje("222"));
    expect(plataforma.sent).toHaveLength(0);
    expect(creados.get("token-pm")?.sent.map((m) => m.phoneNumberId)).toEqual(["222"]);
  });

  it("reutiliza el cliente del mismo token y crea otro al rotar", async () => {
    const tokens: Record<string, string> = { "222": "token-1" };
    const { cliente, creados } = armar(tokens);
    await cliente.sendMessage(mensaje("222"));
    await cliente.sendMessage(mensaje("222"));
    expect(creados.size).toBe(1);
    tokens["222"] = "token-2";
    await cliente.sendMessage(mensaje("222"));
    expect(creados.get("token-2")?.sent).toHaveLength(1);
  });

  it("sin credencial propia ni token de plataforma: error de configuracion (no reintentable), no un envio fingido", async () => {
    const { cliente } = armar({}, false);
    await expect(cliente.sendMessage(mensaje("111"))).rejects.toBeInstanceOf(WhatsAppConfigError);
  });

  it("si no se puede leer la credencial, el error es reintentable y NO cae al token de plataforma", async () => {
    const plataforma = new FakeWhatsAppGraphClient();
    const cliente = new WhatsAppGraphClientPorNumero({
      plataforma,
      resolutor: {
        tokenDeNumero: async () => {
          throw new Error("base caida");
        },
      },
      crearCliente: () => new FakeWhatsAppGraphClient(),
    });
    const err = await cliente.sendMessage(mensaje("222")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WhatsAppSendError);
    expect((err as WhatsAppSendError).retryable).toBe(true);
    expect((err as Error).message).not.toMatch(/base caida/);
    expect(plataforma.sent).toHaveLength(0);
  });
});
