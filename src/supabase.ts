import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;
export function getSupabase(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  client ??= createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
    global: {
      fetch: async (input, init) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        init?.signal?.addEventListener("abort", abort, { once: true });
        if (init?.signal?.aborted) controller.abort();
        const timer = setTimeout(abort, 60_000);
        try {
          const response = await fetch(input, {
            ...init,
            signal: controller.signal,
          });
          const body =
            response.status === 204 ? null : await response.arrayBuffer();
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } finally {
          clearTimeout(timer);
          init?.signal?.removeEventListener("abort", abort);
        }
      },
    },
  });
  return client;
}
