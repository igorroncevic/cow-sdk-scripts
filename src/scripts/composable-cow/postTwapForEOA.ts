import { sepolia, APP_CODE } from "../../const";

import {
  SupportedChainId,
  OrderKind,
  TradingSdk,
  Twap,
  CowShedSdk,
  COMPOSABLE_COW_CONTRACT_ADDRESS,
  COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS,
  generateAppDataFromDoc,
  buildAppData,
} from "@cowprotocol/cow-sdk";

import { MetadataApi } from "@cowprotocol/app-data";
import { BigNumber, ethers } from "ethers";
import { confirm, debugStringify, getWallet, printQuote } from "../../utils";
import { getErc20Contract } from "../../contracts/erc20";
// import { latest } from "@cowprotocol/app-data";

interface Token {
  symbol: string;
  address: string;
  decimals: number;
  contract: ethers.Contract;
}

const TOKENS = {
  // Ideally, we would have sell=buy support, so this should disappear and twapSellToken should be used instead
  beforeTwapSellToken: "0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430", // EURe

  twapSellToken: "0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0", // USDC.e
  twapBuyToken: "0x177127622c4A00F3d409B75571e12cB3c8973d3c", // COW
} as const;

const PARTS = 4;

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
  const { beforeTwapSellToken, twapSellToken, twapBuyToken } =
    await getAssetsInfo({ wallet, trader: eoaTrader });

  const sellAmount = ethers.utils.parseUnits("0.1", twapSellToken.decimals); // 0.1 EURe
  const sellAmountFormatted = ethers.utils.formatUnits(
    sellAmount,
    twapSellToken.decimals
  );

  // Define trade parameters
  console.log(
    `TWAP sell ${sellAmountFormatted} ${beforeTwapSellToken.symbol} for ${twapBuyToken.symbol} in ${PARTS} parts.
To create the TWAP we we will use for this PoC an intermediate order with a post hook:
  - Buy ${sellAmountFormatted} ${twapSellToken.symbol} with ${beforeTwapSellToken.symbol}
  - Post-hook will create the TWAP using cow-shed`
  );

  // Generate app data for TWAP order
  const metadataApi = new MetadataApi();
  const twapAppData = await metadataApi.generateAppDataDoc({
    appCode: APP_CODE,
    environment: "prod",
    metadata: {},
  });
  const { appDataContent, appDataHex } = await metadataApi.getAppDataInfo(
    twapAppData
  );

  // TODO: Create TWAP + Derive shed + set shed as the destination for the TWAP
  const twap = Twap.fromData({
    // The TWAP orders sends the bought tokens to the trader
    receiver: eoaTrader,
    sellAmount: sellAmount,
    buyAmount: BigNumber.from(1), // TODO: Get another quote and apply a good slippage
    numberOfParts: BigNumber.from(PARTS),
    timeBetweenParts: BigNumber.from(1800),
    sellToken: twapSellToken.address,
    buyToken: twapBuyToken.address,
    appData: appDataHex,
  });

  console.log("TWAP params for cereation of order", {
    params: twap.leaf,
    data: debugStringify(twap.data),
    appDataContent,
  });

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

  // Get calldata and gas estimation for the approval
  const settlementContract = COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS[CHAIN_ID];
  const approveSellTokenCalldata =
    twapSellToken.contract.interface.encodeFunctionData("approve", [
      settlementContract,
      sellAmount,
    ]);
  console.log("Approve sell token calldata:", approveSellTokenCalldata);

  const approveSellTokenGasLimit =
    await twapSellToken.contract.estimateGas.approve(
      settlementContract,
      sellAmount
    );
  console.log(
    "Approve sell token gas limit:",
    approveSellTokenGasLimit.toString()
  );

  const deadline = BigInt(Math.ceil(Date.now() / 1000)) + 1800n;
  console.log(
    `Deadline: ${deadline} (${new Date(Number(deadline) * 1000).toISOString()})`
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
    });
  console.log("Signed twap calldata:", approveAndTwap);

  // Dummy order that creates the TWAP
  const { quoteResults, postSwapOrderFromQuote } = await sdk.getQuote(
    {
      // Buy the sell amount we will later use for creating the TWAP. Using Buy order, so we can be assured we know the sell amount of the TWAP
      kind: OrderKind.BUY,
      buyToken: twapSellToken.address,
      buyTokenDecimals: twapSellToken.decimals,
      amount: sellAmount.toString(),
      sellToken: twapBuyToken.address,
      sellTokenDecimals: twapSellToken.decimals,

      receiver: cowShed, // Receiver is a special shed with support for Composable Cow. See https://github.com/cowdao-grants/cow-shed/pull/53
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
              // Approve and create the TWAP
              {
                callData: approveAndTwap.data,
                gasLimit: approveAndTwapGasLimit.toString(),
                target: approveAndTwap.to,
                dappId: "cow-sdk-scripts://composable-cow/post-twap-for-eoa",
              },
            ],
          },
        },
      },
    }
  );

  // Print the quote
  printQuote(quoteResults);
  const buyAmount = quoteResults.amountsAndCosts.afterSlippage.buyAmount;

  // Ask for confirmation before posting the order
  const confirmed = await confirm(
    `You will get at least ${buyAmount} COW. ok?`
  );
  if (confirmed) {
    // TODO: Assuming the user has the approval set tot he vault relaler, if not the case, we can use approveTokenGnosis.ts (ideally, make a reusable function to approve when needed)

    // Post the order
    const { orderId } = await postSwapOrderFromQuote();

    console.log(
      `Order created, id: https://explorer.cow.fi/sepolia/orders/${orderId}?tab=overview`
    );
  }
}

async function getAssetsInfo(params: {
  wallet: ethers.Wallet;
  trader: string;
}): Promise<{
  beforeTwapSellToken: Token;
  twapSellToken: Token;
  twapBuyToken: Token;
}> {
  const { wallet } = params;

  // Get ERC20 balance for oldUnderlying using ethersjs
  const beforeTwapSellToken = await getErc20Contract(
    TOKENS.beforeTwapSellToken,
    wallet
  );
  const twapSellToken = await getErc20Contract(TOKENS.twapSellToken, wallet);
  const twapBuyToken = await getErc20Contract(TOKENS.twapBuyToken, wallet);

  const [
    beforeTwapSellTokenSymbol,
    beforeTwapSellTokenDecimals,
    twapSellTokenSymbol,
    twapSellTokenDecimals,
    twapBuyTokenSymbol,
    twapBuyTokenDecimals,
  ] = await Promise.all([
    beforeTwapSellToken.symbol(),
    beforeTwapSellToken.decimals(),
    twapSellToken.symbol(),
    twapSellToken.decimals(),
    twapBuyToken.symbol(),
    twapBuyToken.decimals(),
  ]);

  return {
    beforeTwapSellToken: {
      symbol: beforeTwapSellTokenSymbol,
      address: beforeTwapSellToken.address,
      decimals: beforeTwapSellTokenDecimals,
      contract: beforeTwapSellToken,
    },
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
