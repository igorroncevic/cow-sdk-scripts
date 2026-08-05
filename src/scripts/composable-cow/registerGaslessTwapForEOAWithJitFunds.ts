import { MetadataApi } from "@cowprotocol/app-data";
import {
  COMPOSABLE_COW_CONTRACT_ADDRESS,
  OrderBookApi,
  OrderKind,
  SupportedChainId,
  TradingSdk,
} from "@cowprotocol/cow-sdk";
import { areAddressesEqual, setGlobalAdapter } from "@cowprotocol/sdk-common";
import { ComposableCowPoller, Twap } from "@cowprotocol/sdk-composable";
import { EthersV5Adapter } from "@cowprotocol/sdk-ethers-v5-adapter";
import { BigNumber, ethers } from "ethers";

import { APP_CODE, COW_VAULT_RELAYER_CONTRACT } from "../../const";
import { confirm, getRpcProvider, getWallet } from "../../utils";
import { getCowShedSdk } from "./cowShed";
import {
  getPermitTokenContract,
  optionalPermitCall,
  PERMIT_TYPES,
  permitValueForDebit,
  SignedPermit,
} from "./optionalPermit";

const CHAIN_ID = SupportedChainId.GNOSIS_CHAIN;
const SDAI = "0xaf204776c7245bF4147c2612BF6e5972Ee483701";
const COW = "0x177127622c4A00F3d409B75571e12cB3c8973d3c";
const TWAP_HANDLER = "0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5";
const TWAP_PARTS = 2;

export async function run(): Promise<void> {
  const broadcast = process.argv.includes("--broadcast");
  const provider = await getRpcProvider(CHAIN_ID);
  const funder = ethers.utils.getAddress(
    requiredEnv("FUNDER_ADDRESS"),
  ) as `0x${string}`;
  const pollerAddress = ethers.utils.getAddress(
    requiredEnv("COMPOSABLE_COW_POLLER_ADDRESS"),
  );

  const wallet = await getWallet(CHAIN_ID);
  if (!areAddressesEqual(wallet.address, funder)) {
    throw new Error("PRIVATE_KEY does not match FUNDER_ADDRESS");
  }
  const adapter = new EthersV5Adapter({ provider, signer: wallet });
  setGlobalAdapter(adapter);
  const pollerSdk = new ComposableCowPoller(pollerAddress);

  const token = getPermitTokenContract(
    SDAI,
    new ethers.VoidSigner(funder, provider),
  );
  const cowShedSdk = getCowShedSdk(adapter);
  const cowShed = cowShedSdk.getCowShedAccount(CHAIN_ID, funder);
  const [decimals, currentPollerAllowance, composableCow] = await Promise.all([
    token.decimals(),
    token.allowance(funder, pollerAddress),
    pollerSdk.composableCow(),
  ]);
  if (
    !areAddressesEqual(composableCow, COMPOSABLE_COW_CONTRACT_ADDRESS[CHAIN_ID])
  ) {
    throw new Error(
      "Poller is configured for a different ComposableCoW contract",
    );
  }
  const fullSellAmount = ethers.utils.parseUnits("0.2", decimals);

  const salt = ethers.utils.hexlify(ethers.utils.randomBytes(32));
  // The ID excludes appData, so pollFunds(id) can be embedded in the TWAP's own
  // appData without creating a circular hash dependency.
  const scheduleId = pollerSdk.scheduleId({
    handler: TWAP_HANDLER,
    funder,
    owner: cowShed,
    salt,
  });

  const metadataApi = new MetadataApi();
  const twapAppData = await metadataApi.generateAppDataDoc({
    appCode: APP_CODE,
    environment: "prod",
    metadata: {
      hooks: {
        pre: [
          {
            target: pollerAddress,
            callData: pollerSdk.pollFunds(scheduleId),
            gasLimit: "350000",
          },
        ],
      },
    },
  });
  const { appDataContent, appDataHex } =
    await metadataApi.getAppDataInfo(twapAppData);
  const partBuyAmount = BigNumber.from(requiredEnv("TWAP_MIN_PART_BUY_AMOUNT"));

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
    permitValueForDebit(currentPollerAllowance, fullSellAmount).toBigInt(),
    setupNonce + 1n,
  );

  const needsPollerPermit = currentPollerAllowance.lt(fullSellAmount);
  const signatureCount = needsPollerPermit ? 5 : 4;
  console.log(`Gasless JIT TWAP registration:
  1. Authorize Poller registration.
  2. Permit Poller to pull ${ethers.utils.formatUnits(fullSellAmount, decimals)} sDAI when needed.
  3. Sign the CowShed setup bundle.
  4. Permit the setup order's VaultRelayer debit.
  5. Sign and submit the setup order.

After setup settles, each TWAP part calls pollFunds(${scheduleId}) before settlement.`);
  console.log({
    mode: broadcast ? "broadcast" : "dry-run",
    funder,
    cowShed,
    scheduleId,
    parentTwapId: twap.id,
    pollerPermit,
    twap: twap.leaf,
  });
  if (!broadcast) {
    console.log("Dry-run complete: no signatures or submission.");
    return;
  }
  if (
    !(await confirm(
      `Sign ${signatureCount} setup requests, valid until ${new Date(validTo * 1000).toISOString()}?`,
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
  const signPermit = async (
    message: ReturnType<typeof permit>,
    number: number,
  ) => {
    console.log(
      `Signature ${number}/${signatureCount}: ${message.spender} permit`,
    );
    const signature = await wallet._signTypedData(
      domain,
      PERMIT_TYPES,
      message,
    );
    return { ...message, ...ethers.utils.splitSignature(signature) };
  };
  // Authorize the CowShed to register this EOA-funded schedule.
  // The Poller consumes the EOA's nonce when the setup bundle executes.
  console.log(
    `Signature 1/${signatureCount}: Poller registration authorization`,
  );
  const pollerNonce = await pollerSdk.nonce(funder);
  const assertRegisterNonce = async () => {
    if (BigInt(await pollerSdk.nonce(funder)) !== BigInt(pollerNonce)) {
      throw new Error(
        "Poller nonce changed before submission; rebuild and re-sign the registration",
      );
    }
  };
  const registerTypedData = pollerSdk.getRegisterTypedData({
    chainId: CHAIN_ID,
    schedule,
    nonce: pollerNonce,
    deadline: BigInt(validTo),
  });
  const registerSignature = await wallet._signTypedData(
    registerTypedData.domain,
    registerTypedData.types,
    registerTypedData.message,
  );
  // If needed, let the Poller pull each TWAP part from the EOA just in time.
  const signedPollerPermit = needsPollerPermit
    ? await signPermit(pollerPermit, 2)
    : undefined;
  const optionalPollerPermit = signedPollerPermit
    ? optionalPermitCall(SDAI, signedPollerPermit)
    : undefined;
  // Authorize the exact CowShed setup calls embedded below.
  const cowShedSignatureNumber = needsPollerPermit ? 3 : 2;
  console.log(
    `Signature ${cowShedSignatureNumber}/${signatureCount}: CowShed setup bundle`,
  );
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
      ...(optionalPollerPermit
        ? [call(optionalPollerPermit.target, optionalPollerPermit.callData)]
        : []),
      call(
        pollerAddress,
        pollerSdk.registerWithSignature(
          schedule,
          BigInt(validTo),
          registerSignature,
        ),
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
    defaultGasLimit: 1_000_000n,
  });
  if (
    !areAddressesEqual(bundle.cowShedAccount, cowShed) ||
    bundle.signedMulticall.value !== 0n
  ) {
    throw new Error("CowShed SDK returned an unexpected setup call");
  }

  const setupOrderAppData = (signedPermit: SignedPermit) => {
    const optionalSetupPermit = optionalPermitCall(SDAI, signedPermit);
    return {
      appCode: APP_CODE,
      metadata: {
        hooks: {
          pre: [
            {
              target: optionalSetupPermit.target,
              callData: optionalSetupPermit.callData,
              gasLimit: "150000",
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
    };
  };
  const placeholderSetupPermit = {
    ...permit(COW_VAULT_RELAYER_CONTRACT, 0n, setupNonce),
    v: 0,
    r: ethers.constants.HashZero,
    s: ethers.constants.HashZero,
  };
  await assertRegisterNonce();
  const { quoteResults: draftQuote } = await sdk.getQuote(setupTrade, {
    quoteRequest: { validTo },
    appData: setupOrderAppData(placeholderSetupPermit),
  });
  const setupDebit = BigNumber.from(draftQuote.orderToSign.sellAmount).add(
    draftQuote.orderToSign.feeAmount,
  );
  if (!setupDebit.eq(setupTrade.amount)) {
    throw new Error("Setup quote exceeds the requested debit");
  }
  const signedSetupPermit = await signPermit(
    permit(
      COW_VAULT_RELAYER_CONTRACT,
      permitValueForDebit(currentVaultAllowance, setupDebit).toBigInt(),
      setupNonce,
    ),
    needsPollerPermit ? 4 : 3,
  );
  console.warn(
    `Warning: signatures 1-${signatureCount - 1} become executable when the final quote is requested.`,
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
  await assertRegisterNonce();

  console.log(
    `Signature ${signatureCount}/${signatureCount}: hook-aware setup order`,
  );
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
