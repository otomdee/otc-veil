import { ProviderInterface, RpcProvider } from "starknet";

// ─── Tokens ──────────────────────────────────────────────────────────────────
// Mainnet addresses verified onchain (symbol() calls); Sepolia needs env config.

export const addrSTRK =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
export const addrUSDC =
  "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8";

export type TokenInfo = { address: string; symbol: string; decimals: number };

export const TOKENS: Record<number, TokenInfo[]> = {
  // Mainnet (frontend provider index 0)
  0: [
    { address: addrSTRK, symbol: "STRK", decimals: 18 },
    { address: addrUSDC, symbol: "USDC", decimals: 6 },
  ],
  // Sepolia (frontend provider index 2) - set NEXT_PUBLIC_SEPOLIA_TOKENS as
  // "0xaddr:SYMBOL:decimals,0xaddr:SYMBOL:decimals" to configure test tokens.
  2: [],
};

// Parse NEXT_PUBLIC_SEPOLIA_TOKENS once at module load.
if (process.env.NEXT_PUBLIC_SEPOLIA_TOKENS) {
  try {
    TOKENS[2] = process.env.NEXT_PUBLIC_SEPOLIA_TOKENS.split(",")
      .map((entry) => {
        const [address, symbol, decimals] = entry.trim().split(":");
        return { address, symbol, decimals: Number(decimals ?? 18) };
      })
      .filter((t) => t.address && t.symbol);
  } catch {
    /* leave Sepolia unconfigured */
  }
}

export function tokensForIndex(index: number): TokenInfo[] {
  return TOKENS[index] ?? [];
}

export function tokenByAddress(index: number, address: string): TokenInfo | undefined {
  const lower = address.toLowerCase();
  return tokensForIndex(index).find(
    (t) => BigInt(t.address) === BigInt(address) || t.address.toLowerCase() === lower
  );
}

// ─── Frontend RPC providers ──────────────────────────────────────────────────
// The STRK20 privacy pool lives on Mainnet (0) and Sepolia (2); index 1 is a
// spare public testnet endpoint. NEXT_PUBLIC_PROVIDER_URL is your Alchemy key.

function alchemyUrl(network: "mainnet" | "sepolia"): string {
  const v = process.env.NEXT_PUBLIC_PROVIDER_URL ?? "";
  if (v.startsWith("http")) return v;
  const base =
    network === "mainnet"
      ? "https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_10/"
      : "https://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_10/";
  return base + v;
}

export const myFrontendProviders: ProviderInterface[] = [
  new RpcProvider({ nodeUrl: alchemyUrl("mainnet") }),
  new RpcProvider({ nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_7" }),
  new RpcProvider({ nodeUrl: alchemyUrl("sepolia") }),
];

// ─── OTC settlement helper ───────────────────────────────────────────────────
// Deployed per-network from cairo/src/otc_settlement.cairo. "0x0" = not yet
// deployed on that network - paste your deployment into .env.local:
//   NEXT_PUBLIC_OTC_HELPER_MAINNET / NEXT_PUBLIC_OTC_HELPER_SEPOLIA

export const OtcHelperMainnet =
  process.env.NEXT_PUBLIC_OTC_HELPER_MAINNET ?? "0x0";
export const OtcHelperSepolia =
  process.env.NEXT_PUBLIC_OTC_HELPER_SEPOLIA ?? "0x0";

export function otcHelperForIndex(index: number): string {
  if (index === 0) return OtcHelperMainnet;
  if (index === 2) return OtcHelperSepolia;
  return "0x0";
}

// Frontend provider indices where the STRK20 privacy pool is available.
export const Strk20Networks: Record<number, string> = { 0: "MAINNET", 2: "SEPOLIA" };
