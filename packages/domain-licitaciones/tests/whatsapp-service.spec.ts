import { describe, expect, it } from "vitest";
import { InMemoryWhatsAppRepository, enqueueDeadlineReminderWhatsApp, enqueueTenderNotices, parseActionButtonId, requestGoNoGoDecisionsByWhatsApp, sha256TokenHash } from "../src/index.ts";

const ORG = "org-a";
const TENDER = { id: "tender-1", title: "Suministro de papeleria", deadlineLabel: "15 oct" };

function seed(): InMemoryWhatsAppRepository {
  const repo = new InMemoryWhatsAppRepository();
  const base = { notifyPlazos: true, notifyConvocatorias: true, notifyFallos: true, notifyDecisiones: true };
  return Object.assign(repo, {
    async seed() {
      for (const [user, phone, role] of [["u-analyst", "+525500000001", "analyst"], ["u-viewer", "+525500000002", "viewer"], ["u-pending", "+525500000003", "owner"]] as const) {
        await repo.upsertContact(ORG, user, { phoneE164: phone, ...base });
        repo.setRole(user, role);
      }
      for (const phone of ["+525500000001", "+525500000002"]) {
        repo.actorUserId = null;
        const c = [...repo.contacts.values()].find((x) => x.phoneE164 === phone)!;
        repo.actorUserId = c.userId;
        await repo.requestConsent(ORG);
        await repo.confirmOptIn(phone);
      }
      repo.actorUserId = null;
    },
  });
}

describe("requestGoNoGoDecisionsByWhatsApp", () => {
  it("solo pide la decision a contactos ACTIVOS con rol go/no-go; el viewer y el pendiente no reciben botones", async () => {
    const repo = seed() as InMemoryWhatsAppRepository & { seed(): Promise<void> };
    await repo.seed();
    const res = await requestGoNoGoDecisionsByWhatsApp(repo, { organizationId: ORG, tender: TENDER });
    expect(res).toEqual({ requested: 1, alreadyPending: 0, eligible: 1 });
    const row = repo.outbox.find((r) => r.eventType === "decision_request")!;
    expect((row.payload as { to: string }).to).toBe("+525500000001");
    const buttons = (row.payload as { buttons: { id: string }[] }).buttons;
    expect(buttons).toHaveLength(2);
    // en la base solo vive el HASH de cada token, nunca el token en claro
    for (const b of buttons) {
      const token = parseActionButtonId(b.id)!;
      expect(repo.tokens.has(sha256TokenHash(token))).toBe(true);
      expect(repo.tokens.has(token)).toBe(false);
    }
  });

  it("es idempotente: una segunda solicitud con tokens vigentes no duplica mensajes", async () => {
    const repo = seed() as InMemoryWhatsAppRepository & { seed(): Promise<void> };
    await repo.seed();
    await requestGoNoGoDecisionsByWhatsApp(repo, { organizationId: ORG, tender: TENDER });
    const second = await requestGoNoGoDecisionsByWhatsApp(repo, { organizationId: ORG, tender: TENDER });
    expect(second).toEqual({ requested: 0, alreadyPending: 1, eligible: 1 });
    expect(repo.outbox.filter((r) => r.eventType === "decision_request")).toHaveLength(1);
  });

  it("la expiracion se fija en el futuro y respeta el tope de 7 dias", async () => {
    const repo = seed() as InMemoryWhatsAppRepository & { seed(): Promise<void> };
    await repo.seed();
    const now = new Date("2026-10-01T12:00:00.000Z");
    await requestGoNoGoDecisionsByWhatsApp(repo, { organizationId: ORG, tender: TENDER, now: () => now, ttlHours: 9999 });
    const [t] = [...repo.tokens.values()];
    expect(t!.expiresAt).toBeGreaterThan(now.getTime());
    expect(t!.expiresAt - now.getTime()).toBeLessThan(7 * 24 * 3_600_000);
  });
});

describe("avisos", () => {
  it("un aviso por contacto activo con el tema habilitado; repetir el mismo hecho no duplica", async () => {
    const repo = seed() as InMemoryWhatsAppRepository & { seed(): Promise<void> };
    await repo.seed();
    expect(await enqueueTenderNotices(repo, { organizationId: ORG, kind: "fallo", tender: TENDER, dedupeRef: "tender-1" })).toBe(2);
    expect(await enqueueTenderNotices(repo, { organizationId: ORG, kind: "fallo", tender: TENDER, dedupeRef: "tender-1" })).toBe(0);
  });

  it("un contacto que apago el tema no recibe el aviso", async () => {
    const repo = seed() as InMemoryWhatsAppRepository & { seed(): Promise<void> };
    await repo.seed();
    await repo.upsertContact(ORG, "u-viewer", { phoneE164: "+525500000002", notifyPlazos: false, notifyConvocatorias: true, notifyFallos: true, notifyDecisiones: true });
    // (cambiar el telefono reinicia el opt-in, pero aqui es el MISMO numero: sigue activo)
    expect(repo.contacts.get(`${ORG}:u-viewer`)!.status).toBe("activo");
    const n = await enqueueDeadlineReminderWhatsApp(repo, ORG, [
      { id: "r1", organizationId: ORG, tenderId: "t1", submissionDeadline: "2026-10-04T00:00:00Z", daysRemaining: 2, message: 'La convocatoria "X" vence el 2026-10-04.', createdAt: "", acknowledgedAt: null, acknowledgedBy: null },
    ]);
    expect(n).toBe(1);
    expect(repo.outbox.at(-1)!.payload).toMatchObject({ to: "+525500000001" });
    expect((repo.outbox.at(-1)!.payload as { body: string }).body).toContain("Faltan 2 dia(s)");
  });

  it("cambiar el telefono reinicia el consentimiento (vuelve a pendiente)", async () => {
    const repo = seed() as InMemoryWhatsAppRepository & { seed(): Promise<void> };
    await repo.seed();
    await repo.upsertContact(ORG, "u-analyst", { phoneE164: "+525500009999", notifyPlazos: true, notifyConvocatorias: true, notifyFallos: true, notifyDecisiones: true });
    expect(repo.contacts.get(`${ORG}:u-analyst`)!.status).toBe("pendiente");
  });
});

describe("consumo de token (reglas del repositorio en memoria, espejo de la funcion SQL)", () => {
  async function issue(repo: InMemoryWhatsAppRepository): Promise<{ hash: string; token: string }> {
    await requestGoNoGoDecisionsByWhatsApp(repo, { organizationId: ORG, tender: TENDER });
    const row = repo.outbox.find((r) => r.eventType === "decision_request")!;
    const token = parseActionButtonId((row.payload as { buttons: { id: string }[] }).buttons[0]!.id)!;
    return { token, hash: sha256TokenHash(token) };
  }

  it("un solo uso: mismo mensaje = duplicado (idempotente); otro mensaje = ya_usado (replay)", async () => {
    const repo = seed() as InMemoryWhatsAppRepository & { seed(): Promise<void> };
    await repo.seed();
    const { hash } = await issue(repo);
    repo.actorUserId = "u-analyst";
    expect((await repo.consumeActionToken(hash, "+525500000001", "wamid.1")).result).toBe("ok");
    expect((await repo.consumeActionToken(hash, "+525500000001", "wamid.1")).result).toBe("duplicado");
    expect((await repo.consumeActionToken(hash, "+525500000001", "wamid.2")).result).toBe("ya_usado");
  });

  it("otro usuario, otro telefono, expirado, baja y rol revocado se rechazan sin consumir", async () => {
    const repo = seed() as InMemoryWhatsAppRepository & { seed(): Promise<void> };
    await repo.seed();
    const { hash } = await issue(repo);
    repo.actorUserId = "u-viewer";
    expect((await repo.consumeActionToken(hash, "+525500000002", "m1")).result).toBe("no_encontrado");
    repo.actorUserId = "u-analyst";
    expect((await repo.consumeActionToken(hash, "+525599999999", "m2")).result).toBe("telefono_distinto");
    repo.setRole("u-analyst", "viewer");
    expect((await repo.consumeActionToken(hash, "+525500000001", "m3")).result).toBe("rol_insuficiente");
    repo.setRole("u-analyst", "analyst");
    await repo.optOutByPhone("+525500000001");
    expect((await repo.consumeActionToken(hash, "+525500000001", "m4")).result).toBe("contacto_inactivo");
    // nada de lo anterior lo consumio: tras reactivar, el titular aun puede usarlo
    repo.actorUserId = "u-analyst";
    await repo.requestConsent(ORG);
    await repo.confirmOptIn("+525500000001");
    expect((await repo.consumeActionToken(hash, "+525500000001", "m5")).result).toBe("ok");
  });

  it("expirado", async () => {
    const repo = seed() as InMemoryWhatsAppRepository & { seed(): Promise<void> };
    await repo.seed();
    const { hash } = await issue(repo);
    repo.actorUserId = "u-analyst";
    repo.now = () => Date.now() + 48 * 3_600_000;
    expect((await repo.consumeActionToken(hash, "+525500000001", "m1")).result).toBe("expirado");
  });
});
