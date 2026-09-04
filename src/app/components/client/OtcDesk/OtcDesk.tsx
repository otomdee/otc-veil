"use client";

import { useCallback, useEffect, useState } from "react";
import { hash, num, validateAndParseAddress } from "starknet";
import type { WALLET_API } from "@starknet-io/types-js";
import styles from "../../../uni.module.css";
import * as constants from "@/utils/constants";
import {
  StoredOrder,
  claimCalldata,
  fillCalldata,
  formatAmount,
  generateSecret,
  loadOrders,
  parseAmount,
  saveOrder,
  settleCalldata,
} from "@/utils/otc";
import { useStoreWallet } from "../../Wallet/walletContext";
import { useFrontendProvider } from "../provider/providerContext";
import SelectWallet from "../WalletHandle/SelectWallet";

// ─── Shared UI types ─────────────────────────────────────────────────────────

type ResultRow = { label: string; value: string; hash?: string };
type ActionResult = {
  status: "pending" | "ok" | "error";
  title: string;
  rows?: ResultRow[];
  note?: string;
};

function shortHex(h: string): string {
  try {
    const hex = num.toHex(h);
    return hex.length <= 13 ? hex : `${hex.slice(0, 7)}…${hex.slice(-4)}`;
  } catch {
    return String(h);
  }
}

function prettyStatus(finality?: string, exec?: string): string {
  const f =
    finality === "ACCEPTED_ON_L2" ? "Accepted on L2"
      : finality === "ACCEPTED_ON_L1" ? "Accepted on L1"
      : finality === "RECEIVED" ? "Received"
      : finality ?? "";
  const e = exec === "SUCCEEDED" ? "Succeeded" : exec === "REVERTED" ? "Reverted" : "";
  return [f, e].filter(Boolean).join(" · ") || "Confirmed";
}

function receiptToResult(txR: any, txH: string, label: string): ActionResult {
  const r = txR?.value ?? txR;
  const exec: string | undefined = r?.execution_status;
  const reverted = exec === "REVERTED";
  return {
    status: reverted ? "error" : "ok",
    title: reverted ? "Transaction reverted" : `${label} confirmed`,
    rows: [{ label: "Transaction", value: shortHex(txH), hash: txH }],
  };
}

function errorResult(msg: string): ActionResult {
  return { status: "error", title: "Action failed", note: msg };
}

// ─── Chain order shape (mirrors cairo Order struct serialization) ────────────

type ChainOrder = {
  orderId: string;
  sellToken: string;
  sellAmountWei: bigint;
  buyToken: string;
  buyAmountWei: bigint;
  expiry: number;
  filled: boolean;
};

function decodeGetOrder(result: string[], orderId: string): ChainOrder {
  // [sell_token, sell_amount(u128), buy_token, buy_amount(u128), expiry(u64), filled(bool)]
  return {
    orderId,
    sellToken: num.toHex(num.toBigInt(result[0])),
    sellAmountWei: num.toBigInt(result[1]),
    buyToken: num.toHex(num.toBigInt(result[2])),
    buyAmountWei: num.toBigInt(result[3]),
    expiry: Number(num.toBigInt(result[4])),
    filled: num.toBigInt(result[5]) !== 0n,
  };
}

type TabKey = "create" | "book" | "mine" | "balances";
const TABS: { key: TabKey; label: string }[] = [
  { key: "create", label: "Create order" },
  { key: "book", label: "Order book" },
  { key: "mine", label: "My orders" },
  { key: "balances", label: "Balances" },
];

export default function OtcDesk() {
  const myFrontendProviderIndex = useFrontendProvider((s) => s.currentFrontendProviderIndex);
  const myWalletAccount = useStoreWallet((s) => s.myWalletAccount);
  const connectedAddress = useStoreWallet((s) => s.address);
  const isConnected = useStoreWallet((s) => s.isConnected);

  const networkName = constants.Strk20Networks[myFrontendProviderIndex];
  const isStrk20Network = networkName !== undefined;

  const helperRaw = constants.otcHelperForIndex(myFrontendProviderIndex);
  const hasHelper = (() => {
    try {
      return BigInt(helperRaw) !== 0n;
    } catch {
      return false;
    }
  })();
  const helperHex = hasHelper ? validateAndParseAddress(helperRaw) : "";

  const tokens = constants.tokensForIndex(myFrontendProviderIndex);
  const tokenByAddr = useCallback(
    (addr: string) => constants.tokenByAddress(myFrontendProviderIndex, addr),
    [myFrontendProviderIndex]
  );
  const symbolOf = useCallback(
    (addr: string) => tokenByAddr(addr)?.symbol ?? shortHex(addr),
    [tokenByAddr]
  );

  // ── State ──
  const [tab, setTab] = useState<TabKey>("create");

  // Create-order form
  const [sellIdx, setSellIdx] = useState(0);
  const [buyIdx, setBuyIdx] = useState(1);
  const [sellAmt, setSellAmt] = useState("");
  const [buyAmt, setBuyAmt] = useState("");
  const [expiryHours, setExpiryHours] = useState("24");
  const [resultCreate, setResultCreate] = useState<ActionResult | null>(null);
  const [creating, setCreating] = useState(false);

  // Shield (deposit) form - withdrawals spend shielded pool balance, so the
  // maker must shield the sell token before the first order.
  const [shieldAmt, setShieldAmt] = useState("");
  const [resultShield, setResultShield] = useState<ActionResult | null>(null);
  const [shielding, setShielding] = useState(false);

  // Order book
  const [bookOrders, setBookOrders] = useState<ChainOrder[]>([]);
  const [bookLoading, setBookLoading] = useState(false);
  const [resultFill, setResultFill] = useState<ActionResult | null>(null);
  const [fillingId, setFillingId] = useState<string | null>(null);

  // My orders
  const [myOrders, setMyOrders] = useState<StoredOrder[]>([]);
  const [myStatuses, setMyStatuses] = useState<Record<string, ChainOrder | null>>({});
  const [mineLoading, setMineLoading] = useState(false);
  const [resultClaim, setResultClaim] = useState<ActionResult | null>(null);

  // Balances
  const [resultBalances, setResultBalances] = useState<ActionResult | null>(null);

  const provider = () => constants.myFrontendProviders[myFrontendProviderIndex];

  // ── Submit through the privacy wallet (same flow as the starter kit) ──────
  async function submit(
    actions: WALLET_API.STRK20_ACTION[],
    setResult: (r: ActionResult) => void,
    label: string
  ): Promise<string | undefined> {
    if (!myWalletAccount) {
      setResult(errorResult("No WalletAccount available."));
      return undefined;
    }
    let txH: string;
    try {
      const r = await myWalletAccount.strk20InvokeTransaction(actions);
      txH = r.transaction_hash;
    } catch (error: any) {
      const raw = error?.message ?? error?.toString?.() ?? String(error);
      const hint = /INVALID_REQUEST_PAYLOAD/i.test(raw)
        ? "\n\nHint: the wallet rejected the request before proving - most often there is no shielded balance to spend. Shield (deposit) the token into the pool first, wait a few blocks, then retry."
        : "";
      setResult(errorResult(raw + hint));
      return undefined;
    }
    setResult({
      status: "pending",
      title: "Waiting for confirmation…",
      rows: [{ label: "Transaction", value: shortHex(txH), hash: txH }],
    });
    try {
      const txR = await provider().waitForTransaction(txH, { retries: 400, retryInterval: 3000 });
      setResult(receiptToResult(txR, txH, label));
    } catch (error: any) {
      setResult({
        status: "error",
        title: "Could not confirm transaction",
        rows: [{ label: "Transaction", value: shortHex(txH), hash: txH }],
        note: error?.message ?? String(error),
      });
    }
    return txH;
  }

  // ── Chain reads ──
  const fetchOrder = useCallback(
    async (orderId: string): Promise<ChainOrder | null> => {
      try {
        const res = await provider().callContract({
          contractAddress: helperHex,
          entrypoint: "get_order",
          calldata: [orderId],
        });
        // starknet.js v10 returns the raw felt array; zeroed storage = no order.
        if (num.toBigInt(res[0]) === 0n) return null;
        return decodeGetOrder(res, orderId);
      } catch {
        return null;
      }
    },
    [helperHex, myFrontendProviderIndex]
  );

  // ── Shield (deposit public funds into the pool) ──
  async function handleShield() {
    setResultShield(null);
    if (!tokens.length || sellIdx >= tokens.length) {
      setResultShield(errorResult("Configure tokens for this network first."));
      return;
    }
    if (!connectedAddress) {
      setResultShield(errorResult("Connect a wallet first."));
      return;
    }
    const tok = tokens[sellIdx];
    const wei = parseAmount(shieldAmt || sellAmt, tok.decimals);
    if (!wei || wei <= 0n) {
      setResultShield(errorResult("Enter an amount to shield (or fill the sell amount above)."));
      return;
    }
    setShielding(true);
    try {
      await submit(
        [{ type: "deposit", token: tok.address, amount: num.toHex(wei) }],
        setResultShield,
        `Shield ${formatAmount(wei, tok.decimals)} ${tok.symbol}`
      );
    } finally {
      setShielding(false);
    }
  }

  // ── Create order (maker leg A) ──
  async function handleCreate() {
    setResultCreate(null);
    if (!tokens.length || sellIdx >= tokens.length || buyIdx >= tokens.length) {
      setResultCreate(errorResult("Configure tokens for this network first."));
      return;
    }
    const sellTok = tokens[sellIdx];
    const buyTok = tokens[buyIdx];
    const sellWei = parseAmount(sellAmt, sellTok.decimals);
    const buyWei = parseAmount(buyAmt, buyTok.decimals);
    const hours = Number(expiryHours);
    if (!hasHelper) {
      setResultCreate(errorResult(`OTC helper not deployed on ${networkName}.`));
      return;
    }
    if (!connectedAddress) {
      setResultCreate(errorResult("Connect a wallet first."));
      return;
    }
    if (!sellWei || sellWei <= 0n || !buyWei || buyWei <= 0n) {
      setResultCreate(errorResult("Enter valid amounts."));
      return;
    }
    if (!Number.isFinite(hours) || hours <= 0) {
      setResultCreate(errorResult("Expiry must be a positive number of hours."));
      return;
    }
    if (sellIdx === buyIdx) {
      setResultCreate(errorResult("Pick two different tokens."));
      return;
    }

    setCreating(true);
    try {
      const secret = generateSecret();
      // Derive the commitment through the contract so frontend math can never
      // drift from the Poseidon implementation onchain.
      const res = await provider().callContract({
        contractAddress: helperHex,
        entrypoint: "compute_order_id",
        calldata: [secret],
      });
      const orderId = num.toHex(num.toBigInt(res[0]));
      const expiryTs = Math.floor(Date.now() / 1000) + Math.floor(hours * 3600);

      const order: StoredOrder = {
        orderId,
        secret,
        network: myFrontendProviderIndex,
        sellToken: sellTok.address,
        sellAmount: sellAmt,
        buyToken: buyTok.address,
        buyAmount: buyAmt,
        expiry: expiryTs,
        createdAt: Date.now(),
      };

      const actions: WALLET_API.STRK20_ACTION[] = [
        {
          type: "withdraw",
          token: sellTok.address,
          amount: num.toHex(sellWei),
          recipient: helperHex,
        },
        {
          type: "invoke",
          contract: helperHex,
          calldata: fillCalldata({
            orderId,
            sellToken: sellTok.address,
            sellAmountWei: sellWei,
            buyToken: buyTok.address,
            buyAmountWei: buyWei,
            expiryTs,
          }),
        },
      ];

      const txH = await submit(actions, setResultCreate, `Order ${shortHex(orderId)}`);
      if (txH) {
        saveOrder({ ...order, txHash: txH });
        setSellAmt("");
        setBuyAmt("");
        setResultCreate({
          status: "ok",
          title: `Order ${shortHex(orderId)} is live`,
          rows: [
            { label: "You sell", value: `${formatAmount(sellWei, sellTok.decimals)} ${sellTok.symbol}` },
            { label: "You buy", value: `${formatAmount(buyWei, buyTok.decimals)} ${buyTok.symbol}` },
            { label: "Secret", value: "stored locally - back it up!" },
            { label: "Order", value: shortHex(orderId) },
            { label: "Transaction", value: shortHex(txH), hash: txH },
          ],
          note:
            "The secret proving you own this order lives only in this browser's localStorage.\n" +
            "Export it before clearing site data.",
        });
      }
    } catch (error: any) {
      setResultCreate(errorResult(error?.message ?? String(error)));
    } finally {
      setCreating(false);
    }
  }

  // ── Order book ──
  const refreshBook = useCallback(async () => {
    if (!hasHelper) return;
    setBookLoading(true);
    try {
      const selCreated = hash.getSelectorFromName("OrderCreated");
      const ids: string[] = [];
      let continuation: string | undefined;
      do {
        const page = await provider().getEvents({
          address: helperHex,
          keys: [[selCreated]],
          chunk_size: 1024,
          ...(continuation ? { continuation_token: continuation } : {}),
        });
        for (const ev of page.events) {
          // keys = [selector(OrderCreated), order_id (#key)]
          if (ev.keys && ev.keys.length > 1) ids.push(ev.keys[1]);
        }
        continuation = page.continuation_token;
      } while (continuation);

      const unique = Array.from(new Set(ids)).slice(0, 100);
      const now = Math.floor(Date.now() / 1000);
      const live: ChainOrder[] = [];
      for (const id of unique) {
        const ord = await fetchOrder(id);
        if (ord && !ord.filled && ord.expiry > now) live.push(ord);
      }
      setBookOrders(live.sort((a, b) => a.expiry - b.expiry));
    } catch (error: any) {
      console.error("order book load failed", error);
      setBookOrders([]);
    } finally {
      setBookLoading(false);
    }
  }, [fetchOrder, hasHelper, helperHex, myFrontendProviderIndex]);

  useEffect(() => {
    if (tab === "book") refreshBook();
  }, [tab, refreshBook]);

  // ── Fill order (taker leg B) ──
  async function handleFill(ord: ChainOrder) {
    setResultFill(null);
    if (!connectedAddress) {
      setResultFill(errorResult("Connect a wallet first."));
      return;
    }
    const buyTok = tokenByAddr(ord.buyToken);
    if (!buyTok) {
      setResultFill(errorResult(`Unknown token ${shortHex(ord.buyToken)} - add it to config.`));
      return;
    }
    setFillingId(ord.orderId);
    try {
      const actions: WALLET_API.STRK20_ACTION[] = [
        {
          type: "withdraw",
          token: ord.buyToken,
          amount: num.toHex(ord.buyAmountWei),
          recipient: helperHex,
        },
        {
          // The OPEN note credited with the sold tokens goes to the filler.
          type: "transfer",
          token: ord.sellToken,
          amount: "OPEN",
          recipient: connectedAddress,
        },
        {
          type: "invoke",
          contract: helperHex,
          calldata: settleCalldata({
            orderId: ord.orderId,
            sellToken: ord.sellToken,
            buyToken: ord.buyToken,
            buyAmountWei: ord.buyAmountWei,
            buyerNotePlaceholder: "${openNoteIds[0]}",
          }),
        },
      ];
      const txH = await submit(
        actions,
        setResultFill,
        `Fill ${symbolOf(ord.sellToken)} ← ${symbolOf(ord.buyToken)}`
      );
      if (txH) refreshBook();
    } finally {
      setFillingId(null);
    }
  }

  // ── My orders ──
  const refreshMine = useCallback(async () => {
    const stored = loadOrders().filter((o) => o.network === myFrontendProviderIndex);
    setMyOrders(stored.reverse());
    setMineLoading(true);
    const statuses: Record<string, ChainOrder | null> = {};
    for (const o of stored) {
      statuses[o.orderId] = await fetchOrder(o.orderId);
    }
    setMyStatuses(statuses);
    setMineLoading(false);
  }, [fetchOrder, myFrontendProviderIndex]);

  useEffect(() => {
    if (tab === "mine") refreshMine();
  }, [tab, refreshMine]);

  async function handleClaim(o: StoredOrder, creditToken: string) {
    setResultClaim(null);
    if (!connectedAddress) {
      setResultClaim(errorResult("Connect a wallet first."));
      return;
    }
    try {
      const actions: WALLET_API.STRK20_ACTION[] = [
        {
          // The OPEN note credited with proceeds (or refund) goes to the maker.
          type: "transfer",
          token: creditToken,
          amount: "OPEN",
          recipient: connectedAddress,
        },
        {
          type: "invoke",
          contract: helperHex,
          calldata: claimCalldata({
            secret: o.secret,
            sellerNotePlaceholder: "${openNoteIds[0]}",
          }),
        },
      ];
      await submit(actions, setResultClaim, `Claim ${shortHex(o.orderId)}`);
      refreshMine();
    } catch (error: any) {
      setResultClaim(errorResult(error?.message ?? String(error)));
    }
  }

  // ── Balances ──
  async function handleBalances() {
    setResultBalances(null);
    if (!myWalletAccount) {
      setResultBalances(errorResult("No WalletAccount available."));
      return;
    }
    try {
      const r = await myWalletAccount.strk20Balances([]);
      const arr = ((r as any)?.value ?? r) as any[];
      if (Array.isArray(arr) && arr.length) {
        const rows: ResultRow[] = arr.map((b: any) => {
          const token = b?.token ?? b?.token_address ?? b?.[0];
          const amount = b?.amount ?? b?.balance ?? b?.[1];
          const info = tokenByAddr(String(token));
          let amtStr = String(amount);
          try {
            amtStr = formatAmount(num.toBigInt(amount), info?.decimals ?? 18);
          } catch {
            /* keep raw */
          }
          return { label: info?.symbol ?? shortHex(String(token)), value: amtStr };
        });
        setResultBalances({ status: "ok", title: "Shielded balances", rows });
      } else {
        setResultBalances({
          status: "ok",
          title: "No shielded balances",
          note: "This account holds nothing in the privacy pool yet.",
        });
      }
    } catch (error: any) {
      setResultBalances(errorResult(error?.message ?? String(error)));
    }
  }

  // ── Render helpers ──
  const explorerTxUrl = (h: string) =>
    myFrontendProviderIndex === 0
      ? `https://voyager.online/tx/${h}`
      : `https://sepolia.voyager.online/tx/${h}`;

  const ResultCard = ({ r }: { r: ActionResult }) => (
    <div
      className={`${styles.receipt} ${
        r.status === "error"
          ? styles.receiptError
          : r.status === "pending"
          ? styles.receiptPending
          : styles.receiptOk
      }`}
    >
      <div className={styles.receiptHead}>
        <span className={styles.receiptIcon}>
          {r.status === "ok" ? "✓" : r.status === "error" ? "!" : "⋯"}
        </span>
        <span>{r.title}</span>
      </div>
      {r.rows?.length ? (
        <div className={styles.receiptRows}>
          {r.rows.map((row, i) => (
            <div key={i} className={styles.receiptRow}>
              <span className={styles.receiptLabel}>{row.label}</span>
              {row.hash ? (
                <a
                  className={styles.receiptLink}
                  href={explorerTxUrl(row.hash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {row.value} ↗
                </a>
              ) : (
                <span className={styles.receiptValue}>{row.value}</span>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {r.note ? <pre className={styles.receiptNote}>{r.note}</pre> : null}
    </div>
  );

  const TokenSelect = ({
    value,
    onChange,
  }: {
    value: number;
    onChange: (i: number) => void;
  }) => (
    <select
      style={{
        background: "#16181d",
        color: "#eaeaea",
        border: "1px solid #2a2d34",
        borderRadius: 8,
        padding: "8px 10px",
        fontSize: 14,
      }}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {tokens.map((t, i) => (
        <option key={t.address} value={i}>
          {t.symbol}
        </option>
      ))}
    </select>
  );

  const AmountInput = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input
      style={{
        background: "#16181d",
        color: "#eaeaea",
        border: "1px solid #2a2d34",
        borderRadius: 8,
        padding: "8px 10px",
        fontSize: 14,
        width: "100%",
      }}
      placeholder="0.00"
      inputMode="decimal"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );

  const now = Math.floor(Date.now() / 1000);

  return (
    <div className={styles.panel}>
      <div className={styles.tabs}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`${styles.tab} ${tab === t.key ? styles.tabActive : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Network + helper status */}
      <div className={styles.feeRow}>
        <span>Network</span>
        <span className={`${styles.feeVal} ${isStrk20Network ? styles.netOk : styles.netBad}`}>
          <span className={`${styles.netDot} ${isStrk20Network ? styles.netOkDot : styles.netBadDot}`} />
          {networkName ?? "Unsupported"}
        </span>
      </div>
      {!isStrk20Network && (
        <div className={styles.warn}>
          STRK20 requires Mainnet or Sepolia - switch your wallet network.
        </div>
      )}
      {isStrk20Network && !hasHelper && (
        <div className={styles.warn}>
          OTC settlement helper not deployed on {networkName}. Set
          NEXT_PUBLIC_OTC_HELPER_{networkName} in .env.local.
        </div>
      )}

      {/* ── CREATE ── */}
      {tab === "create" && (
        <>
          <div className={styles.inputBlock}>
            <div className={styles.inputLabel}>You privately sell</div>
            <div className={styles.inputMain}>
              <AmountInput value={sellAmt} onChange={setSellAmt} />
              <TokenSelect value={sellIdx} onChange={setSellIdx} />
            </div>
            <div className={styles.inputLabel} style={{ marginTop: 12 }}>
              You privately buy
            </div>
            <div className={styles.inputMain}>
              <AmountInput value={buyAmt} onChange={setBuyAmt} />
              <TokenSelect value={buyIdx} onChange={setBuyIdx} />
            </div>
            <div className={styles.subLine}>
              <span>Expires after (hours)</span>
              <input
                style={{
                  background: "#16181d",
                  color: "#eaeaea",
                  border: "1px solid #2a2d34",
                  borderRadius: 8,
                  padding: "6px 10px",
                  width: 80,
                  textAlign: "right",
                }}
                inputMode="numeric"
                value={expiryHours}
                onChange={(e) => setExpiryHours(e.target.value)}
              />
            </div>
          </div>

          {isConnected ? (
            <>
              <div className={styles.inputBlock}>
                <div className={styles.inputLabel}>Step 0 — shield sell tokens into the pool (once per token)</div>
                <div className={styles.inputMain}>
                  <AmountInput value={shieldAmt} onChange={setShieldAmt} />
                  <button
                    className={`${styles.btn} ${styles.btnGreen}`}
                    disabled={!isStrk20Network || shielding}
                    onClick={handleShield}
                  >
                    {shielding ? "Shielding…" : `Shield ${tokens[sellIdx]?.symbol ?? ""}`}
                  </button>
                </div>
                <div className={styles.subLine}>
                  <span>Listing spends shielded balance — shield first, wait a few blocks, then list. Empty uses the sell amount.</span>
                </div>
              </div>
              {resultShield ? <ResultCard r={resultShield} /> : null}
              <button
                className={styles.btnCta}
                disabled={!isStrk20Network || !hasHelper || creating}
                onClick={handleCreate}
              >
                {creating ? "Working…" : "List order"}
              </button>
            </>
          ) : (
            <SelectWallet variant="ctaBig" />
          )}

          {resultCreate ? <ResultCard r={resultCreate} /> : null}
        </>
      )}

      {/* ── BOOK ── */}
      {tab === "book" && (
        <>
          <button
            className={`${styles.btn} ${styles.btnGreen} ${styles.btnBlock}`}
            onClick={refreshBook}
            disabled={!isStrk20Network || !hasHelper || bookLoading}
          >
            {bookLoading ? "Loading…" : "Refresh open orders"}
          </button>

          {bookOrders.length === 0 && !bookLoading && (
            <div className={styles.warn}>No open orders right now.</div>
          )}

          {bookOrders.map((ord) => (
            <div
              key={ord.orderId}
              style={{
                border: "1px solid #2a2d34",
                borderRadius: 12,
                padding: "12px 16px",
                margin: "10px 0",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div>
                <div style={{ fontSize: 15 }}>
                  Sell <b>{symbolOf(ord.sellToken)}</b> {formatAmount(ord.sellAmountWei, tokenByAddr(ord.sellToken)?.decimals ?? 18)}
                  {" · "}
                  for <b>{symbolOf(ord.buyToken)}</b> {formatAmount(ord.buyAmountWei, tokenByAddr(ord.buyToken)?.decimals ?? 18)}
                </div>
                <div className={styles.subMono} style={{ marginTop: 4 }}>
                  order {shortHex(ord.orderId)} · expires{" "}
                  {Math.max(0, Math.round((ord.expiry - now) / 3600))}h
                </div>
              </div>
              {isConnected ? (
                <button
                  className={`${styles.btn} ${styles.btnGreen}`}
                  disabled={!isStrk20Network || fillingId !== null}
                  onClick={() => handleFill(ord)}
                >
                  {fillingId === ord.orderId ? "Filling…" : "Private fill"}
                </button>
              ) : (
                <SelectWallet variant="nav" />
              )}
            </div>
          ))}

          {resultFill ? <ResultCard r={resultFill} /> : null}
        </>
      )}

      {/* ── MINE ── */}
      {tab === "mine" && (
        <>
          <button
            className={`${styles.btn} ${styles.btnGreen} ${styles.btnBlock}`}
            onClick={refreshMine}
            disabled={!isStrk20Network || mineLoading}
          >
            {mineLoading ? "Checking chain…" : "Refresh my orders"}
          </button>

          {myOrders.length === 0 && (
            <div className={styles.warn}>
              No locally stored orders on this network yet.
            </div>
          )}

          {myOrders.map((o) => {
            const st = myStatuses[o.orderId];
            const expired = st ? st.expiry * 1000 < Date.now() : false;
            let statusText = "checking…";
            let action: (() => void) | null = null;
            let actionLabel = "";
            if (st === null) statusText = "not found onchain (wrong network or not yet indexed)";
            else if (st) {
              if (st.filled) statusText = "filled - awaiting your claim";
              else if (expired) {
                statusText = "expired - reclaimable";
                actionLabel = "Reclaim";
              } else statusText = "open";
            }
            if (st && !st.filled && expired) {
              action = () => handleClaim(o, st.sellToken);
            }
            return (
              <div
                key={o.orderId}
                style={{
                  border: "1px solid #2a2d34",
                  borderRadius: 12,
                  padding: "12px 16px",
                  margin: "10px 0",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <div>
                  <div style={{ fontSize: 15 }}>
                    Sold <b>{o.sellAmount}</b> {symbolOf(o.sellToken)} for <b>{o.buyAmount}</b>{" "}
                    {symbolOf(o.buyToken)}
                  </div>
                  <div className={styles.subMono} style={{ marginTop: 4 }}>
                    order {shortHex(o.orderId)} · {statusText}
                  </div>
                </div>
                {action ? (
                  <button className={`${styles.btn} ${styles.btnGreen}`} onClick={action}>
                    {actionLabel}
                  </button>
                ) : st && st.filled ? (
                  <button
                    className={`${styles.btn} ${styles.btnGreen}`}
                    onClick={() =>
                      fetchProceedsAndClaim(o)
                    }
                  >
                    Claim proceeds
                  </button>
                ) : null}
              </div>
            );
          })}

          {resultClaim ? <ResultCard r={resultClaim} /> : null}

          <div className={styles.warn} style={{ marginTop: 12 }}>
            Order secrets are stored only in this browser (localStorage). Clearing site data
            loses the ability to claim proceeds - export them from DevTools if needed.
          </div>
        </>
      )}

      {/* ── BALANCES ── */}
      {tab === "balances" && (
        <>
          {isConnected ? (
            <button
              className={styles.btnCta}
              disabled={!isStrk20Network}
              onClick={handleBalances}
            >
              Query shielded balances
            </button>
          ) : (
            <SelectWallet variant="ctaBig" />
          )}
          {resultBalances ? <ResultCard r={resultBalances} /> : null}
        </>
      )}
    </div>
  );

  // Filled orders: read remaining proceeds, then claim into an OPEN note.
  async function fetchProceedsAndClaim(o: StoredOrder) {
    try {
      const res = await provider().callContract({
        contractAddress: helperHex,
        entrypoint: "get_proceeds",
        calldata: [o.orderId],
      });
      if (num.toBigInt(res[0]) === 0n) {
        setResultClaim({
          status: "error",
          title: "Nothing left to claim",
          note: "Proceeds for this order were already claimed (or the order never settled).",
        });
        return;
      }
      const st = myStatuses[o.orderId];
      if (st) await handleClaim(o, st.buyToken);
    } catch (error: any) {
      setResultClaim(errorResult(error?.message ?? String(error)));
    }
  }
}
