import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** N=2^15, r=8, p=3. Keep memory hard derivations bounded at the service boundary. */
const derive = (password: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });

export async function hashPassword(password: string): Promise<string> {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 128
  )
    throw new Error("密码需要 12–128 个字符");
  const salt = randomBytes(16).toString("hex");
  return `scrypt-v1:${salt}:${(await derive(password, salt)).toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  if (typeof password !== "string" || password.length > 128) return false;
  const match = /^scrypt-v1:([a-f0-9]{32}):([a-f0-9]{128})$/.exec(hash);
  // Unknown users still execute the expensive path; no fast account enumeration.
  const actual = await derive(password, match?.[1] ?? "0".repeat(32));
  const expected = Buffer.from(match?.[2] ?? "0".repeat(128), "hex");
  return timingSafeEqual(actual, expected) && Boolean(match);
}
