import { num, shortString, CallData, hash } from "starknet";

// ─── Domain tags (must mirror cairo/src/otc_settlement.cairo) ────────────────

export const ORDER_COMMITMENT_TAG = shortString.encodeShortString("OTC_ORDER_V1");
export const OP_FILL = shortString.encodeShortString("FILL");
export const OP_SETTLE = shortString.encodeShortString("SETTLE");
export const OP_CLAIM = shortString.encodeShortString("CLAIM");

// ─── Secrets & order ids ─────────────────────────────────────────────────────

// Random 250-bit felt secret, hex-encoded. Never leaves the browser except in
// the CLAIM invoke calldata (the wallet signs it into the private tx).
export function generateSecret(): string {
  const bytes = new Uint8Array(31); // 248 bits < felt252 modulus
  crypto.getRandomValues(bytes);
  return num.toHex("0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
}

// Local fallback for order id; the contract's compute_order_id view is the
// source of truth and is used when a provider is available.
export function orderIdFromSecret(secret: string): string {
  return hash.computePoseidonHashOnElements([ORDER_COMMITMENT_TAG, num.toBigInt(secret)]);
}

// ─── Local order book (maker-side secrets live here only) ────────────────────

export type StoredOrder = {
  orderId: string;
  secret: string;
  network: number; // frontend provider index (0 mainnet, 2 sepolia)
  sellToken: string;
  sellAmount: string; // decimal string, human units
  buyToken: string;
  buyAmount: string;
  expiry: number; // unix seconds
  createdAt: number;
  txHash?: string;
};

const LS_KEY = "otc-veil/orders/v1";

export function loadOrders(): StoredOrder[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(LS_KEY) ?? "[]") as StoredOrder[];
  } catch {
    return [];
  }
}

export function saveOrder(order: StoredOrder) {
  if (typeof window === "undefined") return;
  const all = loadOrders().filter((o) => o.orderId !== order.orderId);
  all.push(order);
  window.localStorage.setItem(LS_KEY, JSON.stringify(all));
}

export function updateOrder(orderId: string, patch: Partial<StoredOrder>) {
  if (typeof window === "undefined") return;
  const all = loadOrders();
  const idx = all.findIndex((o) => o.orderId === orderId);
  if (idx >= 0) {
    all[idx] = { ...all[idx], ...patch };
    window.localStorage.setItem(LS_KEY, JSON.stringify(all));
  }
}

export function removeOrder(orderId: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    LS_KEY,
    JSON.stringify(loadOrders().filter((o) => o.orderId !== orderId))
  );
}

// ─── privacy_invoke calldata builders ────────────────────────────────────────
// Layout mirrors IOtcSettlement::privacy_invoke:
//   (operation, order_id, sell_token, sell_amount, buy_token, buy_amount,
//    expiry, note_id_buyer, note_id_seller, secret)
//
// "OPEN" and "${openNoteIds[i]}" are literal placeholder strings substituted by
// the privacy-enabled wallet during action assembly - never hex-normalize them.

export function fillCalldata(p: {
  orderId: string;
  sellToken: string;
  sellAmountWei: bigint;
  buyToken: string;
  buyAmountWei: bigint;
  expiryTs: number;
}): string[] {
  return [
    OP_FILL,
    num.toHex(num.toBigInt(p.orderId)),
    num.toHex(num.toBigInt(p.sellToken)),
    num.toHex(p.sellAmountWei),
    num.toHex(num.toBigInt(p.buyToken)),
    num.toHex(p.buyAmountWei),
    num.toHex(p.expiryTs),
    "0",
    "0",
    "0",
  ];
}

export function settleCalldata(p: {
  orderId: string;
  sellToken: string;
  buyToken: string;
  buyAmountWei: bigint;
  buyerNotePlaceholder: string; // "${openNoteIds[0]}"
}): string[] {
  return [
    OP_SETTLE,
    num.toHex(num.toBigInt(p.orderId)),
    num.toHex(num.toBigInt(p.sellToken)),
    "0x0",
    num.toHex(num.toBigInt(p.buyToken)),
    num.toHex(p.buyAmountWei),
    "0x0",
    p.buyerNotePlaceholder,
    "0x0",
    "0x0",
  ];
}

export function claimCalldata(p: {
  secret: string;
  sellerNotePlaceholder: string; // "${openNoteIds[0]}"
}): string[] {
  return [OP_CLAIM, "0x0", "0x0", "0x0", "0x0", "0x0", "0x0", "0x0", p.sellerNotePlaceholder, num.toHex(num.toBigInt(p.secret))];
}

// ─── Amount helpers ──────────────────────────────────────────────────────────

export function parseAmount(human: string, decimals: number): bigint | null {
  try {
    const clean = human.trim();
    if (!/^\d*(\.\d*)?$/.test(clean) || clean === "" || clean === ".") return null;
    const [whole, frac = ""] = clean.split(".");
    if (frac.length > decimals) return null;
    const base = 10n ** BigInt(decimals);
    return BigInt(whole || "0") * base + BigInt((frac + "0".repeat(decimals)).slice(0, decimals));
  } catch {
    return null;
  }
}

export function formatAmount(wei: bigint, decimals: number): string {
  const whole = wei / 10n ** BigInt(decimals);
  const frac = (wei % 10n ** BigInt(decimals))
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  const s = frac ? `${whole}.${frac}` : `${whole}`;
  return s.length > 12 ? Number(s).toPrecision(8) : s;
}
