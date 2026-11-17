// Image-generation model discovery for the icon generator.
//
// Provider model IDs churn quickly (OpenAI shut gpt-image-1 down on
// 2026-10-23; Gemini's *-image-preview IDs went in June 2026), so the app
// doesn't rely on a hard-coded list alone. Settings → Icons asks the
// provider which image models the user's key can see, and icon generation
// falls back to one of them when the saved model has been retired.

export type ImageProvider = 'openai' | 'gemini';

export interface ImageModelOption {
  id: string;
  label: string;
}

/** Thrown for a non-2xx provider response so callers can inspect it. */
export class ImageApiError extends Error {
  constructor(
    readonly provider: ImageProvider,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${provider === 'openai' ? 'OpenAI' : 'Gemini'} API error (${status}): ${extractMessage(body)}`);
  }
}

/** Pull the human-readable message out of a provider's JSON error body,
 * falling back to the raw text. Both providers use `{ error: { message } }`. */
function extractMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed?.error?.message === 'string') return parsed.error.message;
  } catch { /* not JSON */ }
  return body.trim().slice(0, 500);
}

/** True when the response says the requested model doesn't exist or isn't
 * available — the only case where silently switching models is right.
 * Auth, quota, billing and safety errors must surface unchanged. */
export function isModelUnavailable(err: unknown): err is ImageApiError {
  if (!(err instanceof ImageApiError)) return false;
  if (err.status === 404) return true;
  if (err.provider !== 'openai' || err.status !== 400) return false;
  try {
    const parsed = JSON.parse(err.body) as { error?: { param?: unknown; code?: unknown } };
    return parsed?.error?.param === 'model' || parsed?.error?.code === 'model_not_found';
  } catch {
    return false;
  }
}

async function getJson(url: string, headers: Record<string, string>, provider: ImageProvider): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new ImageApiError(provider, response.status, await response.text());
  return response.json();
}

/** Image models visible to this API key, best candidates first. */
export async function listImageModels(provider: ImageProvider, apiKey: string): Promise<ImageModelOption[]> {
  if (!apiKey) return [];

  if (provider === 'openai') {
    const data = await getJson(
      'https://api.openai.com/v1/models',
      { Authorization: `Bearer ${apiKey}` },
      provider,
    ) as { data?: { id: string; created?: number }[] };
    return (data.data ?? [])
      .filter((m) => /^(gpt-image|chatgpt-image)/.test(m.id))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .map((m) => ({ id: m.id, label: m.id }));
  }

  const data = await getJson(
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
    { 'x-goog-api-key': apiKey },
    provider,
  ) as { models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] };
  return (data.models ?? [])
    .map((m) => ({ ...m, id: m.name.replace(/^models\//, '') }))
    .filter((m) =>
      (m.supportedGenerationMethods ?? []).includes('generateContent') &&
      (/image|nano-banana/i.test(m.id) || /nano banana/i.test(m.displayName ?? '')))
    // Stable before preview, then newest-looking ID first.
    .sort((a, b) =>
      Number(/preview/.test(a.id)) - Number(/preview/.test(b.id)) ||
      b.id.localeCompare(a.id, undefined, { numeric: true }))
    .map((m) => ({ id: m.id, label: m.displayName ? `${m.displayName} (${m.id})` : m.id }));
}

/** First listed model that isn't the one that just failed. */
export function pickReplacement(models: ImageModelOption[], failed: string): string | null {
  return models.find((m) => m.id !== failed)?.id ?? null;
}
