import { createHmac, randomBytes } from "node:crypto";
import { CONFIG } from "./config.js";
import { log } from "./store.js";

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

// Posts a tweet with the official X API v2 (OAuth 1.0a user context). Dry mode only logs it.
export async function postTweet(text: string): Promise<string> {
  const url = "https://api.x.com/2/tweets";
  const o: Record<string, string> = {
    oauth_consumer_key: CONFIG.x.apiKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: CONFIG.x.accessToken,
    oauth_version: "1.0",
  };
  const paramStr = Object.keys(o).sort().map((k) => `${enc(k)}=${enc(o[k])}`).join("&");
  const base = ["POST", enc(url), enc(paramStr)].join("&");
  o.oauth_signature = createHmac("sha1", `${enc(CONFIG.x.apiSecret)}&${enc(CONFIG.x.accessSecret)}`).update(base).digest("base64");
  const auth = "OAuth " + Object.keys(o).sort().map((k) => `${enc(k)}="${enc(o[k])}"`).join(", ");

  const res = await fetch(url, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error(`X API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { data: { id: string } };
  log("tweet.posted", { id: j.data.id, text });
  return j.data.id;
}
