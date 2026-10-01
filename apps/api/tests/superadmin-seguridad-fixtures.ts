// Fixture compartido de los tests de MFA / interruptores / organizaciones del
// superadmin: arma una app con los tres repos en memoria + guard de interruptores,
// y siembra superadmins reales (core + los tres repos).
import { randomUUID } from "node:crypto";
import type { InMemoryCoreRepository } from "@atiende/db";
import { InMemoryMfaRepository, InMemoryOrgAdminRepository, InMemoryPlatformSwitchRepository } from "@atiende/db";
import type { MfaRepository, OrgAdminRepository, PlatformSwitchRepository } from "@atiende/db";
import { signAccessToken } from "@atiende/core-auth";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { createPlatformSwitchGuard } from "../src/platform-switches.ts";
import { buildTestDeps } from "./fixtures.ts";

export interface SeguridadSetup {
  readonly base: Awaited<ReturnType<typeof buildTestDeps>>;
  readonly deps: AppDeps;
  readonly app: ReturnType<typeof buildApp>;
  readonly mfa: InMemoryMfaRepository;
  readonly switches: InMemoryPlatformSwitchRepository;
  readonly orgs: InMemoryOrgAdminRepository;
  superadmin(email?: string): Promise<{ id: string; email: string; token: string }>;
  staff(): Promise<{ id: string; token: string }>;
}

export interface SeguridadSetupOptions {
  readonly env?: Partial<AppDeps["env"]>;
  readonly mfaRepo?: (db: never) => MfaRepository;
  readonly platformSwitchRepo?: (db: never) => PlatformSwitchRepository;
  readonly orgAdminRepo?: (db: never) => OrgAdminRepository;
  readonly sinRepos?: boolean;
}

export async function seguridadSetup(options: SeguridadSetupOptions = {}): Promise<SeguridadSetup> {
  const base = await buildTestDeps();
  const mfa = new InMemoryMfaRepository();
  const switches = new InMemoryPlatformSwitchRepository();
  const orgs = new InMemoryOrgAdminRepository();
  orgs.seedOrganization(base.organizationId, { vertical: "restaurantes", name: "Los Taquitos de PM", slug: "los-taquitos-de-pm", status: "active" });
  const deps: AppDeps = {
    ...base.deps,
    env: { ...base.deps.env, ...options.env },
    ...(options.sinRepos
      ? {}
      : {
          mfaRepo: options.mfaRepo ?? (() => mfa),
          platformSwitchRepo: options.platformSwitchRepo ?? (() => switches),
          orgAdminRepo: options.orgAdminRepo ?? (() => orgs),
          platformSwitchGuard: createPlatformSwitchGuard(async () => (await switches.getBlocked()).blocked, { ttlMs: 60_000 }),
        }),
  };

  async function tokenFor(userId: string, email: string): Promise<string> {
    return signAccessToken({ sub: userId, org_id: "", vertical: "restaurantes", property_ids: null, email }, deps.env.jwtSecret, deps.env.accessTokenTtlSeconds);
  }

  return {
    base,
    deps,
    app: buildApp(deps),
    mfa,
    switches,
    orgs,
    async superadmin(email = `sa-${randomUUID()}@atiende.ai`) {
      const id = randomUUID();
      const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
      coreRepo.addStaff({ id, email, passwordHash: null, fullName: "Superadmin", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
      coreRepo.addPlatformSuperadmin(id);
      mfa.seedSuperadmin(id);
      switches.seedSuperadmin(id);
      orgs.seedSuperadmin(id);
      return { id, email, token: await tokenFor(id, email) };
    },
    async staff() {
      const id = randomUUID();
      return { id, token: await tokenFor(id, "staff@example.com") };
    },
  };
}

export function bearer(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}
