// Fase 10 — suscripción real de la Agenda a Supabase Realtime. `client` es
// inyectable (mismo criterio que `fetchImpl` en el resto de este panel, ver
// citas-appointments-client.spec.ts) para probar esto en entorno "node" sin
// abrir un WebSocket real: el fake reproduce solo la forma encadenable real de
// `SupabaseClient.channel(...).on(...).subscribe()` que subscribeToAppointmentChanges
// usa de verdad (ver realtime-client.ts).
import { describe, expect, it, vi } from "vitest";
import { appointmentsChangesFilter, appointmentsChannelName, subscribeToAppointmentChanges } from "../src/verticals/citas/lib/realtime-client.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("appointmentsChannelName / appointmentsChangesFilter", () => {
  it("arma el nombre de canal y el filtro reales a partir del organization_id", () => {
    expect(appointmentsChannelName("org-1")).toBe("agenda-org-1");
    expect(appointmentsChangesFilter("org-1")).toBe("organization_id=eq.org-1");
  });
});

function fakeSupabaseClient() {
  const setAuth = vi.fn();
  const on = vi.fn();
  const subscribe = vi.fn();
  const removeChannel = vi.fn();
  let registeredCallback: (() => void) | null = null;

  const channelHandle = {
    on: (...args: unknown[]) => {
      on(...args);
      registeredCallback = args[2] as () => void;
      return channelHandle;
    },
    subscribe: () => {
      subscribe();
      return channelHandle;
    },
  };

  const channel = vi.fn(() => channelHandle);

  const client = {
    realtime: { setAuth },
    channel,
    removeChannel,
  } as unknown as SupabaseClient;

  return { client, setAuth, channel, on, subscribe, removeChannel, channelHandle, fireChange: () => registeredCallback?.() };
}

describe("subscribeToAppointmentChanges", () => {
  it("autoriza con el access token real y se suscribe al canal/filtro de la organización", () => {
    const fake = fakeSupabaseClient();

    subscribeToAppointmentChanges("org-1", "tok-real", () => {}, fake.client);

    expect(fake.setAuth).toHaveBeenCalledWith("tok-real");
    expect(fake.channel).toHaveBeenCalledWith("agenda-org-1");
    expect(fake.on).toHaveBeenCalledWith("postgres_changes", { event: "*", schema: "citas", table: "appointments", filter: "organization_id=eq.org-1" }, expect.any(Function));
    expect(fake.subscribe).toHaveBeenCalledTimes(1);
  });

  it("dispara onChange cuando llega un evento — nunca con el payload real, solo la señal de refetch", () => {
    const fake = fakeSupabaseClient();
    const onChange = vi.fn();

    subscribeToAppointmentChanges("org-1", "tok-real", onChange, fake.client);
    fake.fireChange();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith();
  });

  it("la función de limpieza hace removeChannel del canal real suscrito", () => {
    const fake = fakeSupabaseClient();

    const unsubscribe = subscribeToAppointmentChanges("org-1", "tok-real", () => {}, fake.client);
    unsubscribe();

    expect(fake.removeChannel).toHaveBeenCalledWith(fake.channelHandle);
  });

  it("sin cliente configurado (Realtime no disponible en este deploy) es no-op y no truena", () => {
    const unsubscribe = subscribeToAppointmentChanges("org-1", "tok-real", () => {}, null);
    expect(() => unsubscribe()).not.toThrow();
  });
});
