// 二次验证（TOTP，RFC 6238）与会话签名辅助
// 全部基于 Web Crypto（Workers 原生支持），二维码由 qrcode-generator（纯 JS）本地生成，
// otpauth 链接不经过任何第三方服务
import qrcode from "qrcode-generator";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ENC = new TextEncoder();

// ===== Base32（RFC 4648）=====
export function base32Encode(bytes) {
  let bits = 0;
  let val = 0;
  let out = "";
  for (const b of bytes) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s) {
  const clean = String(s || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  const out = [];
  let bits = 0;
  let val = 0;
  for (const ch of clean) {
    val = (val << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// 生成 160 位随机密钥（Base32，32 字符，验证器 App 通用）
export function generateTotpSecret() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

// 恒定时间比较：先各自 SHA-256 抹平长度差异，再逐字节异或
export async function safeEqual(a, b) {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", ENC.encode(String(a))),
    crypto.subtle.digest("SHA-256", ENC.encode(String(b))),
  ]);
  const ua = new Uint8Array(da);
  const ub = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

// 计算 counter 对应的 6 位 TOTP（HMAC-SHA1，30 秒步长）
export async function totpAt(secretB32, counter) {
  const keyBytes = base32Decode(secretB32);
  if (!keyBytes.length) return "";
  const msg = new ArrayBuffer(8);
  new DataView(msg).setUint32(4, counter); // 大端 64 位计数器，高 32 位恒为 0
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 1e6).padStart(6, "0");
}

// 校验 6 位验证码，允许 ±window 个时间窗（默认 ±1 = ±30s 时钟偏移容忍）
export async function verifyTotp(secretB32, code, window = 1) {
  const clean = String(code ?? "").replace(/\s+/g, "");
  if (!secretB32 || !/^\d{6}$/.test(clean)) return false;
  const counter = Math.floor(Date.now() / 30000);
  for (let i = -window; i <= window; i++) {
    const c = counter + i;
    if (c < 0) continue;
    if (await safeEqual(await totpAt(secretB32, c), clean)) return true;
  }
  return false;
}

// ===== 会话 Cookie 签名 =====
function bytesToB64url(buf) {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// HMAC-SHA256(key, payload) → base64url，用于签名会话 Cookie（key = CONFIG_TOKEN）
export async function hmacB64url(keyStr, payload) {
  const key = await crypto.subtle.importKey("raw", ENC.encode(keyStr), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToB64url(await crypto.subtle.sign("HMAC", key, ENC.encode(payload)));
}

// ===== 验证器绑定 =====
// 生成 otpauth:// 链接（Google / Microsoft Authenticator、1Password 等通用格式）
export function otpauthUri(secret, issuer = "FailoverMonitor", account = "admin") {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}

// 本地生成二维码 SVG（无外部请求，密钥不外泄）
export function qrSvg(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
}
