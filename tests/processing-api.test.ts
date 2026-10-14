import { afterEach, describe, expect, it, vi } from "vitest";
const { member, rpc } = vi.hoisted(() => ({member: vi.fn(), rpc: vi.fn()}));
vi.mock("../server/delivery", () => ({memberClient: member}));
import { POST } from "../app/api/process/route";
import { HttpError } from "../server/api";

const workspace = "27c66179-f732-4102-835b-62c673d3e350";
const visit = "11111111-1111-4111-8111-111111111111";
const job = "22222222-2222-4222-8222-222222222222";
function configure() {
  vi.stubEnv("AI_PROVIDER", "aws"); vi.stubEnv("LIVE_AI_ENABLED", "true");
  vi.stubEnv("AWS_PROCESSING_ENABLED", "true"); vi.stubEnv("ROCKWOOD_AWS_REGION", "us-east-1");
  vi.stubEnv("AWS_BEDROCK_MODEL_ID", "test-model"); vi.stubEnv("VERCEL", "");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "public-test");
  vi.stubEnv("ALLOWED_ORIGINS", "https://rockwood.example");
  member.mockResolvedValue({client: {rpc}, userId: "user"});
}
function req(body: unknown = {workspaceId: workspace, walkthroughId: visit}, origin = "https://rockwood.example") {
  return new Request("https://rockwood.example/api/process", {method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify(body)});
}
afterEach(() => {vi.unstubAllEnvs(); vi.resetAllMocks();});
describe("Durable processing enqueue boundary", () => {
  it("stays disconnected until explicitly enabled", async () => {
    configure(); vi.stubEnv("AWS_PROCESSING_ENABLED", "false");
    expect((await POST(req())).status).toBe(503); expect(member).not.toHaveBeenCalled();
  });
  it("requires the authorized origin and a real member session", async () => {
    configure();
    expect((await POST(req(undefined,"https://other.example"))).status).toBe(403);
    expect(member).not.toHaveBeenCalled();
    member.mockRejectedValue(new HttpError(401,"Sign in again."));
    expect((await POST(req())).status).toBe(401); expect(rpc).not.toHaveBeenCalled();
  });
  it("enqueues only canonical IDs and explicit retry, never a supplied snapshot", async () => {
    configure(); rpc.mockResolvedValue({data:job,error:null});
    const response = await POST(req({workspaceId:workspace,walkthroughId:visit,retry:true,snapshot:{audio:"untrusted"},role:"owner"}));
    expect(response.status).toBe(202); expect(await response.json()).toEqual({id:job});
    expect(rpc).toHaveBeenCalledExactlyOnceWith("enqueue_report_processing",{workspace_id:workspace,walkthrough_id:visit,retry_failed:true});
  });
  it("does not echo database errors or report successful queueing on failure", async () => {
    configure(); rpc.mockResolvedValue({data:null,error:{message:"PRIVATE SQL DETAILS"}});
    const response = await POST(req()); expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain("PRIVATE");
  });
  it("rejects malformed and oversized requests before RPC", async () => {
    configure();
    await POST(req({workspaceId:"not-a-uuid",walkthroughId:visit}));
    expect((await POST(req({workspaceId:workspace,walkthroughId:visit,noise:"x".repeat(4100)}))).status).toBe(413);
    expect(rpc).not.toHaveBeenCalled();
  });
});
