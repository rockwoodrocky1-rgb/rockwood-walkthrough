import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportInputSchema } from '../shared/model';
import { reportLink } from '../server/delivery';

const calls = vi.hoisted(() => ({ report: vi.fn(), delivery: vi.fn(), client: vi.fn(), secret: vi.fn() }));
vi.mock('@aws-sdk/client-secrets-manager', () => ({ GetSecretValueCommand: class {}, SecretsManagerClient: class { send = calls.secret; } }));
vi.mock('../server/processing-worker', () => ({ processReportJob: calls.report }));
vi.mock('../server/delivery', async importOriginal => ({ ...await importOriginal<typeof import('../server/delivery')>(), workerClient: calls.client, processDelivery: calls.delivery }));

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe('workspace evidence in the shared worker', () => {
  it('accepts canonical property IDs and preserves legacy input', () => {
    const input = { sessionId: 'visit-1', notes: 'Site visit', transcript: { text: '', source: 'manual', segments: [] }, photos: [] };
    expect(reportInputSchema.parse({ ...input, projectId: '77777777-7777-4777-8777-777777777777' }).projectId).toContain('7777');
    expect(reportInputSchema.parse({ ...input, projectId: 'coral-gables' }).projectId).toBe('coral-gables');
    expect(() => reportInputSchema.parse({ ...input, projectId: 'invented-property' })).toThrow();
  });
  it('links workspace PDFs to the authenticated visit with its workspace and property', () => {
    const url = new URL(reportLink('https://rockwood-projects.vercel.app/cam', 'property', 'visit', 'workspace'));
    expect(url.pathname).toBe('/cam');
    expect(Object.fromEntries(url.searchParams)).toEqual({ report: 'visit', project: 'property', workspace: 'workspace' });
    expect(url.searchParams.has('token')).toBe(false);
  });
  it('attempts the workspace queue when legacy processing fails and disables workspace email', async () => {
    vi.stubEnv('AWS_PROCESSING_ENABLED', 'true');
    vi.stubEnv('ROCKWOOD_SERVER_SECRET_ARN', 'test-secret');
    vi.stubEnv('ROCKWOOD_AWS_REGION', 'us-east-1');
    calls.secret.mockResolvedValue({ SecretString: JSON.stringify({ SUPABASE_SECRET_KEY: 'legacy-test-key-at-least-20', WORKSPACE_SUPABASE_URL: 'https://workspace.supabase.co', WORKSPACE_SUPABASE_SECRET_KEY: 'workspace-test-key-at-least-20', WORKSPACE_CAM_URL: 'https://rockwood-projects.vercel.app/cam' }) });
    calls.client.mockImplementation(connection => connection ? 'workspace-client' : 'legacy-client');
    calls.report.mockImplementation(async client => { if (client === 'legacy-client') throw new Error('Legacy unavailable'); return { processed: true }; });
    calls.delivery.mockResolvedValue({ processed: true });
    const { handler } = await import('../server/aws-worker-entry');
    const result = await handler();
    expect(result).toEqual({ databases: [{ failed: true }, { processed: true, delivery: true }] });
    expect(calls.delivery).toHaveBeenCalledWith(undefined, 'workspace-client', { appUrl: 'https://rockwood-projects.vercel.app/cam', authenticatedLinks: true, emailEnabled: false });
  });

});
