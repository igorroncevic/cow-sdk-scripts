import { APP_CODE, COW_VAULT_RELAYER_CONTRACT } from "../../const";
import { COMPOSABLE_COW_POLLER_ADDRESS } from "../../const/gnosis";

import {
  SupportedChainId,
  OrderKind,
  TradingSdk,
  Twap,
  CowShedSdk,
  COMPOSABLE_COW_CONTRACT_ADDRESS,
  OrderBookApi,
} from "@cowprotocol/cow-sdk";

import { MetadataApi } from "@cowprotocol/app-data";
import { BigNumber, ethers } from "ethers";
import { confirm, debugStringify, getWallet, printQuote } from "../../utils";
import { getErc20Contract } from "../../contracts/erc20";
import { getComposableCowPollerContract } from "../../contracts/composable-cow-poller";

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

const PARTS = 2;
const TIME_BETWEEN_PARTS = 300; // seconds

// The sell=buy order's only purpose is to get the post-hook (which creates the
// TWAP) executed gaslessly via a settlement.
//
// It does NOT move the full TWAP sell amount: This is why no the recipient of the funds is still the EOA.
// as opposed to what src/scripts/composable-cow/postTwapForEOA.ts does
//
// Thanks to JIT funding, each part is pulled from the EOA right before it settles.
const SELL_BUY_ORDER_BUY_AMOUNT = "1"; // 1 wei of sDAI to buy (arrives to the EOA)

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

  const sellAmount = ethers.utils.parseUnits("0.2", twapSellToken.decimals); // total TWAP sell amount
  const sellAmountFormatted = ethers.utils.formatUnits(
    sellAmount,
    twapSellToken.decimals,
  );
  const sellBuyOrderBuyAmount = BigNumber.from(SELL_BUY_ORDER_BUY_AMOUNT); // 1 wei of sDAI

  const cowShedSdk = new CowShedSdk({
    factoryOptions: {
      factoryAddress: "0x4f4350bf2c74aacd508d598a1ba94ef84378793d",
      implementationAddress: "0x6773d5aA31A1EAD34127D564D6E258E66254EbDb",
      proxyCreationCode:
        "0x60a03461009557601f61033d38819003918201601f19168301916001600160401b0383118484101761009957808492604094855283398101031261009557610052602061004b836100ad565b92016100ad565b6080527f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc5560405161027b90816100c28239608051818181608b01526101750152f35b5f80fd5b634e487b7160e01b5f52604160045260245ffd5b51906001600160a01b03821682036100955756fe60806040526004361015610018575b3661019757610197565b5f3560e01c8063025b22bc146100375763f851a4400361000e57610116565b346101125760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101125760043573ffffffffffffffffffffffffffffffffffffffff81169081810361011257337f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff160361010d577f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc557fbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b5f80a2005b61023d565b5f80fd5b34610112575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261011257602061014e61016c565b73ffffffffffffffffffffffffffffffffffffffff60405191168152f35b33300361010d577f000000000000000000000000000000000000000000000000000000000000000090565b60ff7f68df44b1011761f481358c0f49a711192727fb02c377d697bcb0ea8ff8393ac0541615806101f0575b1561023d577ff92ee8a9000000000000000000000000000000000000000000000000000000005f5260045ffd5b507fc4d66de8000000000000000000000000000000000000000000000000000000007fffffffff000000000000000000000000000000000000000000000000000000005f351614156101c3565b5f807f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc54368280378136915af43d5f803e15610277573d5ff35b3d5ffd",
    },
  });
  const cowShed = cowShedSdk.getCowShedAccount(CHAIN_ID, eoaTrader);
  console.log("CowShed account:", cowShed);

  // Describe the flow
  console.log(
    `TWAP sell ${sellAmountFormatted} ${twapSellToken.symbol} for ${twapBuyToken.symbol} in ${PARTS} parts, funded just-in-time.
The setup is done with a gasless sell=buy order with a post-hook:
  - Sell=buy order: BUY ${SELL_BUY_ORDER_BUY_AMOUNT} wei of ${twapSellToken.symbol} with ${twapSellToken.symbol} (sell == buy), so the only thing it does is carry the post-hook.
  - Post-hook (via cow-shed): approve the Vault Relayer + create the TWAP. Owner of the TWAP is cow-shed (${cowShed}).
The EOA keeps the ${twapSellToken.symbol} and approves the ComposableCowPoller (${COMPOSABLE_COW_POLLER_ADDRESS}).
Before each part settles, the watch-tower calls poller.topUp(ctx), pulling exactly that part's sell amount from the EOA into cow-shed.`,
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

  // Build the TWAP. Owner is cow-shed (the order owner / pull destination); the
  // bought tokens are sent to the trader. `startTime` defaults to AT_MINING_TIME
  // (t0 = 0), so `createCalldata` uses `createWithContext` with the
  // CurrentBlockTimestampFactory, anchoring t0 to the settlement block. This is
  // what lets the poller's `getTradeableOrder` resolve the live part.
  const twap = Twap.fromData({
    receiver: eoaTrader,
    sellAmount: sellAmount,
    buyAmount: BigNumber.from(PARTS), // TODO: Get another quote and apply a good slippage
    numberOfParts: BigNumber.from(PARTS),
    timeBetweenParts: BigNumber.from(TIME_BETWEEN_PARTS),
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

  // Sell=buy order: a minimal sell == buy order whose sole purpose is to execute the
  // post-hook that creates the TWAP.
  // It does not move the full TWAP sell amount.
  const { quoteResults, postSwapOrderFromQuote } = await sdk.getQuote(
    {
      kind: OrderKind.BUY,
      sellToken: twapSellToken.address,
      sellTokenDecimals: twapSellToken.decimals,
      buyToken: twapSellToken.address, // sell == buy
      buyTokenDecimals: twapSellToken.decimals,
      amount: sellBuyOrderBuyAmount.toString(), // buy 1 wei of sDAI

      receiver: eoaTrader, // bought tokens stay with the trader; cow-shed needs no funds
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
  2. Approve the ComposableCowPoller to spend up to ${sellAmountFormatted} ${twapSellToken.symbol} (the full TWAP sell amount, pulled JIT).
  3. Register the JIT funding schedule on the poller (funder: your EOA, owner: cow-shed).
  4. Place the sell=buy order, whose post-hook creates the TWAP.
  ...
  5. [watch-tower] Detects the TWAP and creates each part, which settle and proceeds are sent back to the EOA. The orders are owned by cow-shed, check explorer: https://explorer.cow.fi/gc/address/${cowShed}
The watch-tower will then pull ${twapSellToken.symbol} from your EOA part by part. ok?`,
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
  await ensureAllowance({
    token: twapSellToken,
    owner: eoaTrader,
    spender: COMPOSABLE_COW_POLLER_ADDRESS,
    requiredAmount: sellAmount,
    label: "ComposableCowPoller",
  });

  // 3. Register the JIT funding schedule (only the funder may register).
  // NOTE: I could make the poller registration also accept a signature. This way, it can be also part of the sell-buy hook that creates the TWAP
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
    console.log("Register tx:", registerTx.hash);
    await registerTx.wait();
    console.log("Schedule registered");
  }

  // 4. Place the sell=buy order. Its post-hook creates the TWAP gaslessly.
  const { orderId } = await postSwapOrderFromQuote();
  console.log(
    `Sell=buy order created, id: https://explorer.cow.fi/gc/orders/${orderId}?tab=overview`,
  );
  console.log(
    `Once it settles, the TWAP (ctx ${ctx}) will be live and funded just-in-time by the watch-tower.`,
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
  console.log(`Approving ${token.symbol} for ${label}. tx:`, tx.hash);
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
