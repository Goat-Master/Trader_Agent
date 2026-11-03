import { CONFIG } from "./config.js";

// Minimal Claude API call (no SDK, fewer dependencies to trust).
// Each agent asks for a JSON answer, which is parsed and validated by code.
export async function askJson<T>(model: string, system: string, user: string): Promise<T> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": CONFIG.anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      system: system + "\n\nReply with ONE JSON object only. No markdown, no code fences, no text outside the JSON.",
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = data.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`no JSON in reply: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]) as T;
}
