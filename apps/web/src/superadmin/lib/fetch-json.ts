// fetch JSON del back office de plataforma con step-up (compartido por las pantallas de Gasto de API).
import { fetchConStepUp } from "./stepup.ts";

export async function fetchJson<T>(apiBaseUrl: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetchConStepUp(apiBaseUrl, token, `${apiBaseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "No se pudo completar la solicitud.");
  }
  return res.json() as Promise<T>;
}
