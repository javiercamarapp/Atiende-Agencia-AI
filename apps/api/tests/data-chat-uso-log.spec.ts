// Medicion de uso del chat de datos (CHAT-05): una linea estructurada por turno, sin pregunta ni PII.
import { afterEach, describe, expect, it, vi } from "vitest";
import { logUsoDataChat } from "../src/data-chat/uso-log.ts";

afterEach(() => vi.restoreAllMocks());

describe("logUsoDataChat", () => {
  it("emite data_chat_uso con vertical, ruta, llamadas, escalada y costo (y el requestId del contexto)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logUsoDataChat({ get: () => "req-1" }, "citas")({ route: "escalado", llmCalls: 3, escalated: true, costUsd: 0.0008, costMicroUsd: 800, model: "openai/gpt-6-luna" });
    expect(spy).toHaveBeenCalledTimes(1);
    const linea = JSON.parse(String(spy.mock.calls[0]![0])) as Record<string, unknown>;
    expect(linea).toMatchObject({ level: "info", evento: "data_chat_uso", requestId: "req-1", vertical: "citas", route: "escalado", llmCalls: 3, escalated: true, costUsd: 0.0008, costMicroUsd: 800, model: "openai/gpt-6-luna" });
  });

  it("una consulta directa no trae modelo y solo lleva campos operativos", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logUsoDataChat({ get: () => undefined }, "hoteles")({ route: "directa", llmCalls: 0, escalated: false, costUsd: 0, costMicroUsd: 0 });
    const linea = JSON.parse(String(spy.mock.calls[0]![0])) as Record<string, unknown>;
    expect(Object.keys(linea).sort()).toEqual(["costMicroUsd", "costUsd", "escalated", "evento", "level", "llmCalls", "requestId", "route", "ts", "vertical"]);
    expect(linea.model).toBeUndefined();
  });
});
