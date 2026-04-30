import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";

const SECRET = process.env.SHARED_PASSWORD!;

function signToken(): string {
  const payload = JSON.stringify({ exp: Date.now() + 24 * 60 * 60 * 1000 });
  const encoded = Buffer.from(payload).toString("base64url");
  const sig = crypto
    .createHmac("sha256", SECRET)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${sig}`;
}

export function verifyToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [encoded, sig] = parts;
  const expectedSig = crypto
    .createHmac("sha256", SECRET)
    .update(encoded)
    .digest("base64url");
  if (sig !== expectedSig) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString());
    return payload.exp > Date.now();
  } catch {
    return false;
  }
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { password } = req.body || {};

  if (!password) {
    return res.status(400).json({ error: "Password required" });
  }

  const expected = process.env.SHARED_PASSWORD;
  if (!expected) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const pwBuf = Buffer.from(password);
  const expBuf = Buffer.from(expected);
  if (pwBuf.length !== expBuf.length || !crypto.timingSafeEqual(pwBuf, expBuf)) {
    return res.status(401).json({ error: "Invalid password" });
  }

  const token = signToken();
  return res.status(200).json({ token });
}
