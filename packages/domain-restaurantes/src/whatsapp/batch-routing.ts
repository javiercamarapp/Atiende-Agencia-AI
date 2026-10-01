// Un POST firmado de Meta puede agrupar varios `entry[].changes[]`, y cada `change` trae SU propio
// `value.metadata.phone_number_id`. Resolver organizacion y sucursal una sola vez con el primer
// change (como hacia el webhook) procesa los mensajes de los demas changes con el tenant y la
// sucursal EQUIVOCADOS. Este helper parte el payload en un sub-payload por change para que cada
// mensaje se rutee con el numero que de verdad lo recibio.

export interface MetaChannelBatch {
  /** `phone_number_id` del change, o null si no lo trae. */
  readonly phoneNumberId: string | null;
  /** Payload con la forma de Meta pero con un unico entry/change, apto para `extractMetaTextMessages`. */
  readonly payload: { readonly entry: ReadonlyArray<{ readonly changes: readonly unknown[] }> };
}

export function splitMetaPayloadByChannel(payload: unknown): MetaChannelBatch[] {
  const root = payload as { entry?: unknown } | null;
  if (!root || !Array.isArray(root.entry)) return [];
  const batches: MetaChannelBatch[] = [];
  for (const entry of root.entry) {
    const changes = (entry as { changes?: unknown } | null)?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const raw = (change as { value?: { metadata?: { phone_number_id?: unknown } } } | null)?.value?.metadata?.phone_number_id;
      batches.push({ phoneNumberId: typeof raw === "string" && raw.length > 0 ? raw : null, payload: { entry: [{ changes: [change] }] } });
    }
  }
  return batches;
}
