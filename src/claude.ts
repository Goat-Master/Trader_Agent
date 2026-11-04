import { CONFIG } from "./config.js";

// Minimal Claude API call (no SDK, fewer dependencies to trust).
// Each agent asks for a JSON answer, which is parsed and validated by code.
// If a reply is cut off or unreadable, it retries once before giving up.
export async function askJson<T>(model: string, system: string, user: string): Promise<T> {
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": CONFIG.anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096, // room for any thinking plus the JSON answer
        system:
          system +
          "\n\nReply with ONE JSON object only. No markdown, no code fences, no text outside the JSON. Keep any reason field under 25 words." +
          (attempt > 1 ? " Your previous reply was cut off or invalid: answer briefly." : ""),
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { content: { type: string; text?: string }[]; stop_reason?: string };
    const text = data.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]) as T; } catch (e) { lastError = `invalid JSON: ${(e as Error).message}`; }
    } else {
      lastError = data.stop_reason === "max_tokens" ? "reply was cut off (max_tokens)" : `no JSON in reply: ${text.slice(0, 120)}`;
    }
  }
  throw new Error(lastError);
}
