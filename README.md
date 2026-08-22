# OTC Veil

**Trustless, private OTC settlement on Starknet.** List and fill large trades through the [STRK20](https://strk20.starknet.io) privacy pool: no desk holds your funds, settlement is atomic, and no chain observer can link the two counterparties.

Built for the [STRK20 Private Sprint](https://strk20.starknet.io/hackathon) (Aug 14–31, 2026), answering the official [Private OTC Settlement RFP](https://strk20.starknet.io/rfp/private-otc-settlement).

## How it works

A trade is two private transactions against the live STRK20 pool, coordinated by a minimal Cairo anonymizer contract (`OtcSettlement`) that the pool calls atomically via `privacy_invoke`:

```
Maker (seller)                          Taker (buyer)
────────────────                        ─────────────────────────────
1. FILL                                 2. SETTLE
   shield sell tokens into the             shield buy tokens into the
   helper against an order                 helper; sold tokens are
                                           credited back as a private
3. CLAIM                                   note to the buyer - atomic
   reveal the secret preimage;             with payment
   net proceeds are credited
   back as a private note
```

- **No intermediary ever holds discretionary power.** Funds are locked in the helper contract, released only by the protocol logic.
- **Identities stay hidden.** The pool is `msg.sender`; the chain never sees either party's address in the settlement path.
- **The order secret never leaves the maker's browser** except inside the signed private claim transaction.
- **Expired orders are reclaimable** by the maker via the same secret-gated exit.
- **Fees**: 10 bps on the buy leg, collected by the treasury through a plain public transfer (fee flows are public by design).

### Hidden vs visible

| Element | Hidden | Visible |
| --- | --- | --- |
| Maker / taker identities | Yes - pool is the caller | |
| The relationship between them | Yes | |
| Compliance history | Selectively, via viewing keys | |
| Order terms (tokens, amounts, expiry) | | Yes - open orders must be discoverable |
| That a settlement occurred | | Yes |

## Repository layout

```
cairo/               Scarb package: OtcSettlement anonymizer + 13 unit tests
  src/otc_settlement.cairo
  src/tests.cairo
src/
  utils/constants.ts RPC providers, token config, helper addresses per network
  utils/otc.ts       secrets, calldata builders, local order store
  app/components/client/OtcDesk/OtcDesk.tsx   main UI
```

## Run it

```bash
yarn install
cp .env.example .env.local    # add an Alchemy key + deployed helper address
yarn dev                      # http://localhost:3000
```

Requires a privacy-enabled wallet ([Ready](https://www.ready.co/)) connected to Starknet mainnet or Sepolia.

### Deploy the helper contract yourself

```bash
cd cairo && scarb build

# declare (Sepolia example) then deploy through UDC with constructor args:
#   privacy_contract: the STRK20 pool address
#   treasury: your fee treasury address
```

The STRK20 pool lives at `0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a` on Starknet mainnet.

### Tests

```bash
cd cairo && snforge test      # 13 tests covering fill/settle/claim/reclaim/fees/access control
```

## Security notes

This is a hackathon build: the helper contract has no external audit. Read [`cairo/src/otc_settlement.cairo`](cairo/src/otc_settlement.cairo) before trusting it with size. Known simplifications:

- Exact-fill only (partial fills are future work).
- Order secrets live in browser localStorage; losing them forfeits unclaimed proceeds.
- The taker trusts the order book UI for terms display; the contract enforces exact terms regardless.

## License

MIT
