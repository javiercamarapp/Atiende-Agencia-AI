import { describe, it, expect } from 'vitest';
import { ENDPOINT_POLICIES, resolvePolicy } from '../src/endpoint-policy.ts';

describe('ENDPOINT_POLICIES — tabla explícita fail-open/fail-closed', () => {
  it('toda fila trae failMode válido y una razón no vacía (nada de filas mudas)', () => {
    for (const [category, policy] of Object.entries(ENDPOINT_POLICIES)) {
      expect(['open', 'closed']).toContain(policy.failMode);
      expect(policy.reason.length, `categoría "${category}" sin razón documentada`).toBeGreaterThan(20);
    }
  });

  it('las superficies no-autenticadas o con efecto físico/fiscal/monetario están CERRADAS', () => {
    for (const category of ['auth:login', 'auth:password-reset', 'auth:token-issue', 'auth:accept-invite', 'mcp:locks', 'mcp:cfdi', 'billing:charge', 'admin']) {
      expect(resolvePolicy(category).failMode, category).toBe('closed');
    }
  });

  it('las acciones de un tenant ya autenticado, con otra capa como defensa real, están ABIERTAS (acotadas)', () => {
    for (const category of ['agent:gateway', 'mcp:pms', 'mcp:channel-manager', 'mcp:scheduling', 'mcp:pos', 'conversation:inbound-webhook']) {
      expect(resolvePolicy(category).failMode, category).toBe('open');
    }
  });

  it('categoría desconocida (o sin categoría) cae CERRADO por default — nunca abierto por omisión', () => {
    expect(resolvePolicy('categoria-que-no-existe').failClosed).toBe(true);
    expect(resolvePolicy(undefined).failClosed).toBe(true);
  });

  it('failClosed es la inversa exacta de failMode', () => {
    expect(resolvePolicy('auth:login').failClosed).toBe(true);
    expect(resolvePolicy('mcp:pms').failClosed).toBe(false);
  });
});
