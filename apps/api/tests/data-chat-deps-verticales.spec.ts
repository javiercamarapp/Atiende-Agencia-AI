// Cableado de produccion de "Chatea con tus datos" para hoteles y rentas: cada vertical usa SU lector de solo
// lectura y SU rol de gateway (apagable y con presupuesto aparte); sin gateway (sin proveedor de IA) no hay
// completion y las rutas responden "no disponible".
import { describe, expect, it } from "vitest";
import { PostgresHotelesDataChatReader } from "@atiende/domain-hoteles";
import { PostgresRentasDataChatReader } from "@atiende/domain-rentas";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { buildProductionDataChat } from "../src/data-chat/deps.ts";
import { ALL_PRODUCTION_ROLES, HOTELES_DATA_CHAT_ROLE, RENTAS_DATA_CHAT_ROLE, RESTAURANTES_DATA_CHAT_ROLE } from "../src/production/llm-gateway.ts";
import { SWITCHABLE_AGENT_ROLES } from "../src/platform-switches.ts";

const DB = {} as TenantDbSession;

describe("buildProductionDataChat — hoteles y rentas", () => {
  it("construye el lector Postgres de cada vertical sobre la sesion RLS recibida", () => {
    const d = buildProductionDataChat(undefined);
    expect(d.hotelesReader!(DB)).toBeInstanceOf(PostgresHotelesDataChatReader);
    expect(d.rentasReader!(DB)).toBeInstanceOf(PostgresRentasDataChatReader);
  });

  it("sin gateway de LLM: ninguna vertical tiene completion (las rutas dicen 'no disponible')", () => {
    const d = buildProductionDataChat(undefined);
    expect(d.completion).toBeUndefined();
  });

  it("cada vertical llama al gateway con su propio rol, carril interactivo y la organizacion del usuario", async () => {
    const calls: { role: string; tenantId: string; lane: string }[] = [];
    const gateway = {
      complete: async (input: { role: string; tenantId: string; lane: string }) => {
        calls.push({ role: input.role, tenantId: input.tenantId, lane: input.lane });
        return { text: "ok", model: "fake", tokensIn: 0, tokensOut: 0, costUsd: 0 };
      },
    };
    const d = buildProductionDataChat(gateway as never);
    const req = { system: "s", messages: [], maxOutputTokens: 10 } as never;
    await d.completion!("org-h", HOTELES_DATA_CHAT_ROLE)(req);
    await d.completion!("org-r", RENTAS_DATA_CHAT_ROLE)(req);
    await d.completion!("org-x")(req);
    expect(calls).toEqual([
      { role: HOTELES_DATA_CHAT_ROLE, tenantId: "org-h", lane: "interactive" },
      { role: RENTAS_DATA_CHAT_ROLE, tenantId: "org-r", lane: "interactive" },
      { role: RESTAURANTES_DATA_CHAT_ROLE, tenantId: "org-x", lane: "interactive" },
    ]);
  });

  it("los roles nuevos estan registrados en el gateway de produccion y en los interruptores de plataforma", () => {
    for (const role of ["hoteles:data_chat", "rentas:data_chat", "despachos:data_chat", "licitaciones:data_chat"]) {
      expect(ALL_PRODUCTION_ROLES).toContain(role);
      expect(SWITCHABLE_AGENT_ROLES).toContain(role);
    }
  });
});
