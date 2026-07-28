import { MetadataApi } from "@cowprotocol/app-data";
import {
  COMPOSABLE_COW_CONTRACT_ADDRESS,
  OrderBookApi,
  OrderKind,
  SupportedChainId,
  TradingSdk,
} from "@cowprotocol/cow-sdk";
import { setGlobalAdapter } from "@cowprotocol/sdk-common";
import { Twap } from "@cowprotocol/sdk-composable";
import { EthersV5Adapter } from "@cowprotocol/sdk-ethers-v5-adapter";
import { BigNumber, ethers } from "ethers";

import { APP_CODE, COW_VAULT_RELAYER_CONTRACT } from "../../const";
import { getComposableCowPollerContract } from "../../contracts/composable-cow-poller";
import { getErc20Contract } from "../../contracts/erc20";
import { confirm, getRpcProvider, getWallet } from "../../utils";
import { getCowShedSdk } from "./cowShed";

const CHAIN_ID = SupportedChainId.GNOSIS_CHAIN;
const SDAI = "0xaf204776c7245bF4147c2612BF6e5972Ee483701";
const COW = "0x177127622c4A00F3d409B75571e12cB3c8973d3c";
const TWAP_HANDLER = "0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5";
const TWAP_PARTS = 2;
const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

// Gasless fresh-EOA proof based on postTwapForEOAWithJitFunds.ts.
// Dry-run is the default. --broadcast collects four signatures and submits one
// same-token setup order whose hooks create and fund the JIT TWAP configuration.
export async function run(): Promise<void> {
  const broadcast = process.argv.includes("--broadcast");
  const provider = await getRpcProvider(CHAIN_ID);
  const funder = ethers.utils.getAddress(
    requiredEnv("FUNDER_ADDRESS"),
  ) as `0x${string}`;
  const pollerAddress = ethers.utils.getAddress(
    requiredEnv("COMPOSABLE_COW_POLLER_ADDRESS"),
  );
  const fromBlock = Number(requiredEnv("COMPOSABLE_COW_POLLER_DEPLOYMENT_BLOCK"));
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0) {
    throw new Error(
      "COMPOSABLE_COW_POLLER_DEPLOYMENT_BLOCK must be a non-negative integer",
    );
  }

  const wallet = await getWallet(CHAIN_ID);
  if (wallet.address.toLowerCase() !== funder.toLowerCase()) {
    throw new Error("PRIVATE_KEY does not match FUNDER_ADDRESS");
  }
  const adapter = new EthersV5Adapter({ provider, signer: wallet });
  setGlobalAdapter(adapter);

  const token = getErc20Contract(SDAI, new ethers.VoidSigner(funder, provider));
  const cowShedSdk = getCowShedSdk(adapter);
  const cowShed = cowShedSdk.getCowShedAccount(CHAIN_ID, funder);
  const poller = getComposableCowPollerContract(pollerAddress, provider);
  const [decimals, registrations, currentPollerAllowance] = await Promise.all([
    token.decimals(),
    poller.queryFilter(
      poller.filters.ScheduleRegistered(null, null, funder),
      fromBlock,
    ),
    token.allowance(funder, pollerAddress),
  ]);
  const fullSellAmount = ethers.utils.parseUnits("0.2", decimals);
  if (registrations.length > 0) throw new Error("Found an existing schedule");
  if (!currentPollerAllowance.isZero()) {
    throw new Error("Found an existing allowance");
  }

  const salt = ethers.utils.hexlify(ethers.utils.randomBytes(32));
  // The ID excludes appData, so pollFunds(id) can be embedded in the TWAP's own
  // appData without creating a circular hash dependency.
  const scheduleId = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["address", "address", "address", "bytes32"],
      [funder, TWAP_HANDLER, cowShed, salt],
    ),
  );

  const metadataApi = new MetadataApi();
  const twapAppData = await metadataApi.generateAppDataDoc({
    appCode: APP_CODE,
    environment: "prod",
    metadata: {
      hooks: {
        pre: [
          {
            target: pollerAddress,
            callData: poller.interface.encodeFunctionData("pollFunds", [
              scheduleId,
            ]),
            gasLimit: "350000",
          },
        ],
      },
    },
  });
  const { appDataContent, appDataHex } =
    await metadataApi.getAppDataInfo(twapAppData);
  const partBuyAmount = BigNumber.from(
    requiredEnv("TWAP_MIN_PART_BUY_AMOUNT"),
  );

  // CowShed owns the parent TWAP, while bought COW still goes to the EOA.
  const twap = Twap.fromData(
    {
      receiver: funder,
      sellAmount: fullSellAmount.toBigInt(),
      buyAmount: partBuyAmount.mul(TWAP_PARTS).toBigInt(),
      numberOfParts: BigInt(TWAP_PARTS),
      timeBetweenParts: 120n,
      sellToken: SDAI,
      buyToken: COW,
      appData: appDataHex,
    },
    salt,
  );
  const schedule = {
    ...twap.leaf,
    funder,
    owner: cowShed,
  };
  const validTo = Math.floor(Date.now() / 1000) + 1800;
  // This small same-token order only carries the setup hooks. The EOA keeps the
  // TWAP sell funds until pollFunds pulls each part just before settlement.
  const setupTrade = {
    kind: OrderKind.SELL,
    sellToken: SDAI,
    sellTokenDecimals: decimals,
    buyToken: SDAI,
    buyTokenDecimals: decimals,
    amount: ethers.utils.parseUnits("0.01", decimals).toString(),
    receiver: funder,
    owner: funder,
    partiallyFillable: false,
    slippageBps: 0,
  };
  const [currentVaultAllowance, baseNonce, tokenName] = await Promise.all([
    token.allowance(funder, COW_VAULT_RELAYER_CONTRACT),
    token.nonces(funder),
    token.name(),
  ]);
  const setupNonce = baseNonce.toBigInt();
  // The setup-order permit consumes nonce N in its pre-hook. The Poller permit
  // executes later inside CowShed, so it must use nonce N+1.
  const domain = {
    name: tokenName,
    version: process.env.SDAI_PERMIT_VERSION ?? "1",
    chainId: CHAIN_ID,
    verifyingContract: SDAI,
  };
  const permit = (spender: string, value: bigint, nonce: bigint) => ({
    owner: funder,
    spender,
    value: value.toString(),
    nonce: nonce.toString(),
    deadline: validTo.toString(),
  });
  const pollerPermit = permit(
    pollerAddress,
    currentPollerAllowance.add(fullSellAmount).toBigInt(),
    setupNonce + 1n,
  );

  console.log(`Gasless JIT TWAP proof:
  1. Permit Poller to pull ${ethers.utils.formatUnits(fullSellAmount, decimals)} sDAI.
  2. Sign the CowShed setup bundle.
  3. Permit the setup order's VaultRelayer debit.
  4. Sign and submit the setup order.

After setup settles, each TWAP part calls pollFunds(${scheduleId}) before settlement.`);
  console.log({
    mode: broadcast ? "broadcast" : "dry-run",
    limitation: "fresh EOA with no existing Poller allowance or schedule",
    funder,
    cowShed,
    scheduleId,
    pollerPermit,
    twap: twap.leaf,
  });
  if (!broadcast) {
    console.log("Dry-run complete: no signatures or submission.");
    return;
  }
  if (
    !(await confirm(
      `Sign four setup requests, valid until ${new Date(validTo * 1000).toISOString()}?`,
    ))
  ) {
    return;
  }

  await new OrderBookApi({ chainId: CHAIN_ID }).uploadAppData(
    appDataHex,
    appDataContent,
  );
  const sdk = new TradingSdk(
    { chainId: CHAIN_ID, signer: wallet, appCode: APP_CODE },
    {},
    adapter,
  );
  type SignedPermit = ReturnType<typeof permit> & {
    v: number;
    r: string;
    s: string;
  };
  const signPermit = async (
    message: ReturnType<typeof permit>,
    number: number,
  ) => {
    console.log(`Signature ${number}/4: ${message.spender} permit`);
    const signature = await wallet._signTypedData(
      domain,
      PERMIT_TYPES,
      message,
    );
    return { ...message, ...ethers.utils.splitSignature(signature) };
  };
  const permitCalldata = (signed: SignedPermit) =>
    token.interface.encodeFunctionData("permit", [
      signed.owner,
      signed.spender,
      signed.value,
      signed.deadline,
      signed.v,
      signed.r,
      signed.s,
    ]);

  const signedPollerPermit = await signPermit(pollerPermit, 1);
  console.log("Signature 2/4: CowShed setup bundle");
  const call = (target: string, callData: string) => ({
    target,
    callData,
    value: 0n,
    isDelegateCall: false,
    allowFailure: false,
  });
  const bundle = await cowShedSdk.signCalls({
    chainId: CHAIN_ID,
    calls: [
      call(SDAI, permitCalldata(signedPollerPermit)),
      call(
        poller.address,
        poller.interface.encodeFunctionData("register", [schedule]),
      ),
      call(
        SDAI,
        token.interface.encodeFunctionData("approve", [
          COW_VAULT_RELAYER_CONTRACT,
          fullSellAmount,
        ]),
      ),
      call(COMPOSABLE_COW_CONTRACT_ADDRESS[CHAIN_ID], twap.createCalldata),
    ],
    deadline: BigInt(validTo),
    signer: wallet,
    defaultGasLimit: 500_000n,
  });
  if (
    ethers.utils.getAddress(bundle.cowShedAccount) !== cowShed ||
    bundle.signedMulticall.value !== 0n
  ) {
    throw new Error("CowShed SDK returned an unexpected setup call");
  }

  const setupOrderAppData = (signedPermit: SignedPermit) => ({
    appCode: APP_CODE,
    metadata: {
      hooks: {
        pre: [
          {
            target: SDAI,
            callData: permitCalldata(signedPermit),
            gasLimit: "100000",
          },
        ],
        post: [
          {
            target: bundle.signedMulticall.to,
            callData: bundle.signedMulticall.data,
            gasLimit: bundle.gasLimit.toString(),
          },
        ],
      },
    },
  });
  const placeholderSetupPermit = {
    ...permit(COW_VAULT_RELAYER_CONTRACT, 0n, setupNonce),
    v: 0,
    r: ethers.constants.HashZero,
    s: ethers.constants.HashZero,
  };
  const { quoteResults: draftQuote } = await sdk.getQuote(setupTrade, {
    quoteRequest: { validTo },
    appData: setupOrderAppData(placeholderSetupPermit),
  });
  const setupDebit = BigNumber.from(draftQuote.orderToSign.sellAmount).add(
    draftQuote.orderToSign.feeAmount,
  );
  const signedSetupPermit = await signPermit(
    permit(
      COW_VAULT_RELAYER_CONTRACT,
      currentVaultAllowance.add(setupDebit).toBigInt(),
      setupNonce,
    ),
    3,
  );
  console.warn(
    "PoC limitation: signatures 1-3 become executable when the final quote is requested.",
  );
  const { quoteResults: finalQuote, postSwapOrderFromQuote } =
    await sdk.getQuote(setupTrade, {
      quoteRequest: { validTo },
      appData: setupOrderAppData(signedSetupPermit),
    });
  if (
    JSON.stringify({ ...finalQuote.orderToSign, appData: undefined }) !==
    JSON.stringify({ ...draftQuote.orderToSign, appData: undefined })
  ) {
    throw new Error("Final setup quote differs from the signed permit draft");
  }

  console.log("Signature 4/4: hook-aware setup order");
  const { orderId } = await postSwapOrderFromQuote();
  console.log(`Submitted: https://explorer.cow.fi/gc/orders/${orderId}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
