import { APP_CODE, COW_VAULT_RELAYER_CONTRACT } from "../../const";
import { COMPOSABLE_COW_POLLER_ADDRESS } from "../../const/gnosis";

import {
  SupportedChainId,
  OrderKind,
  TradingSdk,
  Twap,
  COMPOSABLE_COW_CONTRACT_ADDRESS,
  OrderBookApi,
} from "@cowprotocol/cow-sdk";

import { MetadataApi } from "@cowprotocol/app-data";
import { BigNumber, ethers } from "ethers";
import {
  confirm,
  debugStringify,
  getExplorerUrl,
  getWallet,
  printQuote,
} from "../../utils";
import { getErc20Contract } from "../../contracts/erc20";
import { getComposableCowPollerContract } from "../../contracts/composable-cow-poller";
import { getCowShedSdk } from "./cowShed";

const DEFAULT_GAS_LIMIT = 500_000n;

interface Token {
  symbol: string;
  address: string;
  decimals: number;
  contract: ethers.Contract;
}

const TOKENS = {
  twapSellToken: "0xaf204776c7245bF4147c2612BF6e5972Ee483701", // sDAI
  twapBuyToken: "0x177127622c4A00F3d409B75571e12cB3c8973d3c", // COW
} as const;

const TWAP_PARTS = 2;
const TWAP_TIME_BETWEEN_PARTS = 60; // 60s
const TWAP_SLIPPAGE_BPS = 1000; // 10%

const CHAIN_ID = SupportedChainId.GNOSIS_CHAIN;

export async function run() {
  const wallet = await getWallet(CHAIN_ID);
  const eoaTrader = wallet.address as `0x${string}`;

  // Initialize the SDK with the wallet
  const sdk = new TradingSdk({
    chainId: CHAIN_ID,
    signer: wallet, // Use a signer
    appCode: APP_CODE,
  });

  // Get some info about the assets
  const { twapSellToken, twapBuyToken } = await getAssetsInfo({ wallet });

  // First order (sell=buy order):
  //   The sell=buy order'sonly purpose is to get the post-hook (which creates the
  //   TWAP) executed gaslessly via a settlement.
  //
  //   It does NOT move the full TWAP sell amount: This is why no the recipient of the funds is still the EOA.
  //   as opposed to what src/scripts/composable-cow/postTwapForEOA.ts does
  //
  //   Thanks to JIT funding, each part is pulled from the EOA right before it settles.
  const firstOrderBuyAmount = BigNumber.from("1"); // sell=buy order: Buy 1 wei of sDAI

  // TWAP Order:
  const fullSellAmount = ethers.utils.parseUnits("0.2", twapSellToken.decimals); // TWAP order: Sell a total of 0.2 sDAI
  const fullSellAmountFormatted = ethers.utils.formatUnits(
    fullSellAmount,
    twapSellToken.decimals,
  );

  const partSellAmount = fullSellAmount.div(TWAP_PARTS);
  const partSellAmountFormatted = ethers.utils.formatUnits(
    partSellAmount,
    twapSellToken.decimals,
  );

  const cowShedSdk = getCowShedSdk();
  const cowShed = cowShedSdk.getCowShedAccount(CHAIN_ID, eoaTrader);
  console.log("CowShed account:", cowShed);

  // Describe the flow
  console.log(
    `TWAP sell ${fullSellAmountFormatted} ${twapSellToken.symbol} for ${twapBuyToken.symbol} in ${TWAP_PARTS} parts (funded just-in-time).

The setup is done with a gasless sell=buy order with a post-hook:
  - Sell=buy order: BUY 1 wei of ${twapSellToken.symbol} with ${twapSellToken.symbol} (sell == buy)
  - Order executes a post-hook (via cow-shed): 
      - Approve the Vault Relayer
      - Create the TWAP. Owner of the TWAP is cow-shed (${cowShed}).
      - Technically, we can include more things here which are left out of this PoC but are a good idea for the production flow:
         - Approve the ComposableCowPoller 
         - Register the JIT funding schedule on ComposableCowPoller

The EOA keeps the 1 wei of ${twapSellToken.symbol}, which means that the EOA is the recipient of the first order.
The order will have the side-effects described above. 

Watch Tower will detect the TWAP and create each part, which will settle and send the proceeds back to the EOA.
Before each part settles, the hook calls poller.topUp(ctx), pulling exactly that part's sell amount from the EOA into cow-shed.
`,
  );

  // Generate app data for TWAP order
  const metadataApi = new MetadataApi();
  const twapAppData = await metadataApi.generateAppDataDoc({
    appCode: APP_CODE,
    environment: "prod",
    metadata: {},
  });
  const { appDataContent: twapAppDataContent, appDataHex: twapAppDataHex } =
    await metadataApi.getAppDataInfo(twapAppData);

  const orderBookApi = new OrderBookApi({
    chainId: CHAIN_ID,
  });

  // Quote a single part (sell token -> buy token) to derive a sensible buy amount
  // limit. We pass our slippage tolerance so `afterSlippage.buyAmount` is the
  // minimum we are willing to receive per part. The TWAP's total buy amount is
  // then that per-part minimum scaled by the number of parts.
  const { quoteResults: partQuote } = await sdk.getQuote({
    kind: OrderKind.SELL,
    sellToken: twapSellToken.address,
    sellTokenDecimals: twapSellToken.decimals,
    buyToken: twapBuyToken.address,
    buyTokenDecimals: twapBuyToken.decimals,
    amount: partSellAmount.toString(),
    owner: eoaTrader,
    slippageBps: TWAP_SLIPPAGE_BPS,
  });
  // Expected amount (net of costs, before slippage) and the minimum we will sign
  // (after slippage), both per part and scaled to the whole TWAP.
  const expectedPartBuyAmount = BigNumber.from(
    partQuote.amountsAndCosts.afterNetworkCosts.buyAmount,
  );
  const partBuyAmount = BigNumber.from(
    partQuote.amountsAndCosts.afterSlippage.buyAmount,
  );
  const expectedTwapBuyAmount = expectedPartBuyAmount.mul(TWAP_PARTS);
  const twapBuyAmount = partBuyAmount.mul(TWAP_PARTS);
  const fmt = (amount: BigNumber) =>
    `${ethers.utils.formatUnits(amount, twapBuyToken.decimals)} ${twapBuyToken.symbol}`;
  console.log(
    `TWAP buy amount per part: ~${fmt(expectedPartBuyAmount)} expected, ${fmt(partBuyAmount)} min (after ${TWAP_SLIPPAGE_BPS / 100}% slippage).
TWAP buy amount total: ~${fmt(expectedTwapBuyAmount)} expected, ${fmt(twapBuyAmount)} min.`,
  );

  // Build the TWAP. Owner is cow-shed (the order owner / pull destination); the
  // bought tokens are sent to the trader. `startTime` defaults to AT_MINING_TIME
  // (t0 = 0), so `createCalldata` uses `createWithContext` with the
  // CurrentBlockTimestampFactory, anchoring t0 to the settlement block. This is
  // what lets the poller's `getTradeableOrder` resolve the live part.
  const twap = Twap.fromData({
    receiver: eoaTrader,
    sellAmount: fullSellAmount,
    buyAmount: twapBuyAmount,
    numberOfParts: BigNumber.from(TWAP_PARTS),
    timeBetweenParts: BigNumber.from(TWAP_TIME_BETWEEN_PARTS),
    sellToken: twapSellToken.address,
    buyToken: twapBuyToken.address,
    appData: twapAppDataHex,
  });

  // `ctx == ComposableCoW.hash(params) == twap.id` is the key both the cabinet
  // and the poller schedule are stored under.
  const ctx = twap.id;
  const { handler, staticInput } = twap.leaf;

  console.log("TWAP context (ctx):", ctx);
  console.log("TWAP params for creation of order", {
    twapParams: twap.leaf,
    twapData: debugStringify(twap.data),
    twapAppDataContent: twapAppDataContent,
  });

  console.log("Uploading TWAP app data to API...");
  await orderBookApi.uploadAppData(twapAppDataHex, twapAppDataContent);

  // Post-hook: approve the Vault Relayer (so each part can settle from cow-shed)
  // and create the TWAP. Both are fund-less calls, so cow-shed never needs to
  // hold the full TWAP sell amount up front.
  const approveSellTokenCalldata =
    twapSellToken.contract.interface.encodeFunctionData("approve", [
      COW_VAULT_RELAYER_CONTRACT,
      ethers.constants.MaxUint256,
    ]);

  const deadline = BigInt(Math.ceil(Date.now() / 1000)) + 1800n;
  console.log(
    `Deadline: ${deadline} (${new Date(Number(deadline) * 1000).toISOString()})`,
  );

  const { signedMulticall: approveAndTwap, gasLimit: approveAndTwapGasLimit } =
    await cowShedSdk.signCalls({
      chainId: CHAIN_ID,
      calls: [
        {
          callData: approveSellTokenCalldata,
          target: twapSellToken.address,
          value: 0n,
          isDelegateCall: false,
          allowFailure: true,
        },
        {
          callData: twap.createCalldata,
          target: COMPOSABLE_COW_CONTRACT_ADDRESS[CHAIN_ID],
          value: 0n,
          isDelegateCall: false,
          allowFailure: true,
        },
      ],
      deadline,
      signer: wallet,
      defaultGasLimit: DEFAULT_GAS_LIMIT,
    });
  console.log("Signed approve+twap calldata:", approveAndTwap);

  // Sell=buy order (so, it's a no-operation order)
  // Both sellToken and buyOrder matches the TWAP's sellToken
  // The post-hook that creates the TWAP.
  // It does not move the full TWAP sell amount:
  //   - This is why the trade amount tries to be minimal (BUY 1 wei, for whatever the quote endpoint said I need to pay for gas)
  //   - Because funds don't arrive to cow-shed, the recipient can be the EOA (this is where the 1 wei is bought)
  //   - The funds will be pulled in follow up order's hook (orders will automatically be created by watch-tower)
  const { quoteResults, postSwapOrderFromQuote } = await sdk.getQuote(
    {
      kind: OrderKind.BUY,
      sellToken: twapSellToken.address,
      sellTokenDecimals: twapSellToken.decimals,
      buyToken: twapSellToken.address, // sell == buy
      buyTokenDecimals: twapSellToken.decimals,
      amount: firstOrderBuyAmount.toString(), // buy 1 wei of sDAI
      receiver: eoaTrader, // bought tokens stay with the trader; cow-shed needs no funds until each part is settled
      owner: eoaTrader,
      partiallyFillable: false,
      validFor: 1800,
    },
    {
      appData: {
        appCode: APP_CODE,
        metadata: {
          hooks: {
            post: [
              // Approve the Vault Relayer and create the TWAP
              {
                callData: approveAndTwap.data,
                gasLimit: approveAndTwapGasLimit.toString(),
                target: approveAndTwap.to,
                dappId:
                  "cow-sdk-scripts://composable-cow/post-twap-for-eoa-jit",
              },
            ],
          },
        },
      },
    },
  );

  // Print the quote
  printQuote(quoteResults);

  // Ask for confirmation before doing anything on-chain
  const confirmed = await confirm(
    `This will:
  1. Approve the Vault Relayer to spend ${twapSellToken.symbol} (for the sell=buy order).
  2. Approve the ComposableCowPoller to spend up to ${fullSellAmountFormatted} ${twapSellToken.symbol} (the full TWAP sell amount, pulled JIT).
  3. Register the JIT funding schedule on the poller (funder: your EOA, owner: cow-shed).
  4. Place the sell=buy order, whose post-hook creates the TWAP.
  ...
  5. [watch-tower] Detects the TWAP and creates each part, which settle and proceeds are sent back to the EOA. 

🥳 Each part will poll ${partSellAmountFormatted} ${twapSellToken.symbol} from your EOA before filling.

Your EOA will receive: ~${fmt(expectedTwapBuyAmount)} (expected), at least ${fmt(twapBuyAmount)} (min, after ${TWAP_SLIPPAGE_BPS / 100}% slippage) across the ${TWAP_PARTS} parts.

ok?`,
  );
  if (!confirmed) {
    console.log("Aborted");
    return;
  }

  // 1. Approve the Vault Relayer for the sell=buy order's sell token (the max the
  //    sell=buy order could spend to buy 1 wei, i.e. mostly the fee).
  await ensureAllowance({
    token: twapSellToken,
    owner: eoaTrader,
    spender: COW_VAULT_RELAYER_CONTRACT,
    requiredAmount: BigNumber.from(
      quoteResults.amountsAndCosts.afterSlippage.sellAmount,
    ),
    label: "Vault Relayer",
  });

  // 2. Approve the poller to pull the full TWAP sell amount from the EOA over time
  //    NOTE: For permit tokens, we can include the permit call as part of the first order
  await ensureAllowance({
    token: twapSellToken,
    owner: eoaTrader,
    spender: COMPOSABLE_COW_POLLER_ADDRESS,
    requiredAmount: fullSellAmount,
    label: "ComposableCowPoller",
  });

  // 3. Register the JIT funding schedule (only the funder may register).
  // NOTE: We could make the poller registration also accept a signature.
  // This way, this part can always be chained as part of the first-order post-hook and we don't need this transaction
  const poller = getComposableCowPollerContract(
    COMPOSABLE_COW_POLLER_ADDRESS,
    wallet,
  );
  const existing = await poller.schedules(ctx);
  if (existing.funder !== ethers.constants.AddressZero) {
    console.log(
      `Schedule already registered for ctx ${ctx} (funder: ${existing.funder}). Skipping register.`,
    );
  } else {
    console.log("Registering JIT funding schedule on the poller...");
    const registerTx = await poller.register(ctx, {
      handler,
      funder: eoaTrader,
      owner: cowShed,
      staticInput,
    });
    console.log("Register tx:", getExplorerUrl(CHAIN_ID, registerTx.hash));
    await registerTx.wait();
    console.log("Schedule registered");
  }

  // 4. Place the sell=buy order. Its post-hook creates the TWAP gaslessly.
  const { orderId } = await postSwapOrderFromQuote();
  console.log(
    `Sell=buy order created, id: https://explorer.cow.fi/gc/orders/${orderId}?tab=overview`,
  );
  console.log(
    `Once it settles, the TWAP (ctx ${ctx}) will be live and funded (just-in-time). 
    
Monitor parts in https://explorer.cow.fi/gc/address/${cowShed}`,
  );
}

async function ensureAllowance(params: {
  token: Token;
  owner: string;
  spender: string;
  requiredAmount: BigNumber;
  label: string;
}) {
  const { token, owner, spender, requiredAmount, label } = params;
  const allowance: BigNumber = await token.contract.allowance(owner, spender);
  console.log(
    `Allowance for ${label}: ${ethers.utils.formatUnits(
      allowance,
      token.decimals,
    )} ${token.symbol}`,
  );
  if (allowance.gte(requiredAmount)) {
    return;
  }

  console.log(`Approving ${token.symbol} for ${label}...`);
  const tx = await token.contract.approve(spender, ethers.constants.MaxUint256);
  console.log(
    `Approving ${token.symbol} for ${label}. tx:`,
    getExplorerUrl(CHAIN_ID, tx.hash),
  );
  await tx.wait();
  console.log(`${token.symbol} approved for ${label}`);
}

async function getAssetsInfo(params: { wallet: ethers.Wallet }): Promise<{
  twapSellToken: Token;
  twapBuyToken: Token;
}> {
  const { wallet } = params;

  const twapSellToken = await getErc20Contract(TOKENS.twapSellToken, wallet);
  const twapBuyToken = await getErc20Contract(TOKENS.twapBuyToken, wallet);

  const [
    twapSellTokenSymbol,
    twapSellTokenDecimals,
    twapBuyTokenSymbol,
    twapBuyTokenDecimals,
  ] = await Promise.all([
    twapSellToken.symbol(),
    twapSellToken.decimals(),
    twapBuyToken.symbol(),
    twapBuyToken.decimals(),
  ]);

  return {
    twapSellToken: {
      symbol: twapSellTokenSymbol,
      address: twapSellToken.address,
      decimals: twapSellTokenDecimals,
      contract: twapSellToken,
    },
    twapBuyToken: {
      symbol: twapBuyTokenSymbol,
      address: twapBuyToken.address,
      decimals: twapBuyTokenDecimals,
      contract: twapBuyToken,
    },
  };
}
