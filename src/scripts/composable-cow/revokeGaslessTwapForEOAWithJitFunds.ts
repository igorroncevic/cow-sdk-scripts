import {
  COMPOSABLE_COW_CONTRACT_ADDRESS,
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
import { confirm, getRpcProvider, getWallet, requiredEnv } from "../../utils";
import { getCowShedSdk } from "./cowShed";
import { optionalPermitCall, permitValueForDebit } from "./optionalPermit";

const CHAIN_ID = SupportedChainId.GNOSIS_CHAIN;
const SDAI = "0xaf204776c7245bF4147c2612BF6e5972Ee483701";
const COMPOSABLE_COW_INTERFACE = new ethers.utils.Interface([
  "function remove(bytes32)",
]);
const REVOKE_TYPES = {
  Revoke: [
    { name: "id", type: "bytes32" },
    { name: "funder", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

/**
 * Gasless revoke flow for a JIT-funded TWAP.
 *
 * Three signatures are always collected:
 * 1. The funder's Poller EIP-712 revoke signature authorizes `revokeWithSignature`.
 * 2. The funder's CowShed signature authorizes the bundle that calls Poller revoke and
 *    removes the parent ComposableCoW order.
 * 3. The final CoW Protocol order signature authorizes settlement of that hook-aware order.
 * An sDAI EIP-2612 permit is a fourth signature only when the existing Vault Relayer
 * allowance cannot cover the same-token revoke order.
 *
 * The Poller and CowShed signatures are both required because the bundle is submitted by
 * the user's CowShed while the Poller schedule is funded by the user's EOA.
 */
export async function run(): Promise<void> {
  const broadcast = process.argv.includes("--broadcast");
  const provider = await getRpcProvider(CHAIN_ID);
  const funder = ethers.utils.getAddress(
    requiredEnv("FUNDER_ADDRESS"),
  ) as `0x${string}`;
  const pollerAddress = ethers.utils.getAddress(
    requiredEnv("COMPOSABLE_COW_POLLER_ADDRESS"),
  );
  const scheduleId = requiredBytes32("SCHEDULE_ID");
  const parentTwapId = requiredBytes32("PARENT_TWAP_ID");
  const wallet = await getWallet(CHAIN_ID);
  if (wallet.address.toLowerCase() !== funder.toLowerCase()) {
    throw new Error("PRIVATE_KEY does not match FUNDER_ADDRESS");
  }

  const adapter = new EthersV5Adapter({ provider, signer: wallet });
  setGlobalAdapter(adapter);
  const cowShedSdk = getCowShedSdk(adapter);
  const cowShed = cowShedSdk.getCowShedAccount(CHAIN_ID, funder);
  const poller = getComposableCowPollerContract(pollerAddress, provider);
  const token = getErc20Contract(SDAI, new ethers.VoidSigner(funder, provider));
  const [schedule, composableCow] = await Promise.all([
    poller.schedules(scheduleId),
    poller.COMPOSABLE_COW(),
  ]);
  if (
    ethers.utils.getAddress(composableCow) !==
    ethers.utils.getAddress(COMPOSABLE_COW_CONTRACT_ADDRESS[CHAIN_ID])
  ) {
    throw new Error(
      "Poller is configured for a different ComposableCoW contract",
    );
  }
  if (schedule.funder !== ethers.constants.AddressZero) {
    if (ethers.utils.getAddress(schedule.funder) !== funder) {
      throw new Error("The configured funder does not own the Poller schedule");
    }
    if (ethers.utils.getAddress(schedule.owner) !== cowShed) {
      throw new Error("The Poller schedule is not owned by the funder's CowShed");
    }
    const expectedParentTwapId = Twap.fromParams({
      handler: schedule.handler,
      salt: schedule.salt,
      staticInput: schedule.staticInput,
    }).id;
    if (parentTwapId.toLowerCase() !== expectedParentTwapId.toLowerCase()) {
      throw new Error("PARENT_TWAP_ID does not match the Poller schedule");
    }
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

  console.log({
    mode: broadcast ? "broadcast" : "dry-run",
    scheduleId,
    parentTwapId,
    funder,
    cowShed,
    deadline: deadline.toString(),
  });
  if (!broadcast) {
    console.log("Dry-run complete: no signatures or submission.");
    return;
  }
  if (
    !(await confirm(
      "Sign three requests to revoke this JIT-funded TWAP, plus a permit if its Vault Relayer allowance is insufficient?",
    ))
  ) {
    return;
  }

  // Snapshot both nonces before signing. Any intervening Poller action invalidates
  // the revoke signature, so the script checks the Poller nonce again before each quote.
  const [pollerNonce, decimals, currentAllowance] = await Promise.all([
    poller.nonces(funder),
    token.decimals(),
    token.allowance(funder, COW_VAULT_RELAYER_CONTRACT),
  ]);
  const assertRevokeReplaySafe = async () => {
    if ((await poller.nonces(funder)).eq(pollerNonce)) return;
    if (
      (await poller.schedules(scheduleId)).funder ===
      ethers.constants.AddressZero
    ) {
      console.warn(
        "Poller revocation already executed; continuing idempotently.",
      );
      return;
    }
    throw new Error(
      "Poller nonce changed before submission; rebuild and re-sign the revoke",
    );
  };

  // Required signature 1/3: the EOA signs the Poller action. The CowShed submits it later,
  // so calling `revoke` directly would fail the Poller's funder check.
  console.log("Required signature 1/3: Poller revoke authorization");
  const revokeSignature = await wallet._signTypedData(
    {
      name: "ComposableCowPoller",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: pollerAddress,
    },
    REVOKE_TYPES,
    { id: scheduleId, funder, nonce: pollerNonce, deadline },
  );
  // Required signature 2/3: CowShed revokes the Poller schedule and removes the
  // parent TWAP authorization.
  console.log("Required signature 2/3: CowShed revoke bundle");
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
      call(
        pollerAddress,
        poller.interface.encodeFunctionData("revokeWithSignature", [
          scheduleId,
          deadline,
          revokeSignature,
        ]),
      ),
      call(
        COMPOSABLE_COW_CONTRACT_ADDRESS[CHAIN_ID],
        COMPOSABLE_COW_INTERFACE.encodeFunctionData("remove", [parentTwapId]),
      ),
    ],
    deadline,
    signer: wallet,
    defaultGasLimit: 500_000n,
  });
  if (
    ethers.utils.getAddress(bundle.cowShedAccount) !== cowShed ||
    bundle.signedMulticall.value !== 0n
  ) {
    throw new Error("CowShed SDK returned an unexpected revoke call");
  }

  const validTo = Number(deadline);

  // The revoke order still needs a Vault Relayer allowance. Its exact debit
  // (sell amount plus fee) is quote-dependent, so the permit is signed after a draft quote.
  type SignedPermit = {
    owner: string;
    spender: string;
    value: string;
    nonce: string;
    deadline: string;
    v: number;
    r: string;
    s: string;
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
  const revokeOrderAppData = (signedPermit?: SignedPermit) => {
    const optionalPermit = signedPermit
      ? optionalPermitCall(SDAI, permitCalldata(signedPermit))
      : undefined;
    return {
      appCode: APP_CODE,
      metadata: {
        hooks: {
          ...(optionalPermit
            ? {
                pre: [
                  {
                    target: optionalPermit.target,
                    callData: optionalPermit.callData,
                    gasLimit: "150000",
                  },
                ],
              }
            : {}),
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
  const trade = {
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
  const sdk = new TradingSdk(
    { chainId: CHAIN_ID, signer: wallet, appCode: APP_CODE },
    {},
    adapter,
  );
  await assertRevokeReplaySafe();
  // Quote without a permit first. This avoids asking for an unnecessary fourth
  // signature when the EOA's existing Vault Relayer allowance covers the debit.
  const { quoteResults: draftQuote, postSwapOrderFromQuote: postDraftOrder } =
    await sdk.getQuote(trade, {
      quoteRequest: { validTo },
      appData: revokeOrderAppData(),
    });
  const hookFreeDebit = BigNumber.from(draftQuote.orderToSign.sellAmount).add(
    draftQuote.orderToSign.feeAmount,
  );
  let postSwapOrderFromQuote = postDraftOrder;
  const needsPermit = currentAllowance.lt(hookFreeDebit);
  if (needsPermit) {
    const [tokenName, tokenNonce] = await Promise.all([
      token.name(),
      token.nonces(funder),
    ]);
    const permitMessage = (value: BigNumber) => ({
      owner: funder,
      spender: COW_VAULT_RELAYER_CONTRACT,
      value: value.toString(),
      nonce: tokenNonce.toString(),
      deadline: deadline.toString(),
    });
    const permitDomain = {
      name: tokenName,
      version: process.env.SDAI_PERMIT_VERSION ?? "1",
      chainId: CHAIN_ID,
      verifyingContract: SDAI,
    };
    const placeholderPermit = {
      ...permitMessage(BigNumber.from(0)),
      v: 0,
      r: ethers.constants.HashZero,
      s: ethers.constants.HashZero,
    };
    const placeholderQuote = await sdk.getQuote(trade, {
      quoteRequest: { validTo },
      appData: revokeOrderAppData(placeholderPermit),
    });
    const permitDebit = BigNumber.from(
      placeholderQuote.quoteResults.orderToSign.sellAmount,
    ).add(placeholderQuote.quoteResults.orderToSign.feeAmount);
    const permitValue = permitValueForDebit(currentAllowance, permitDebit);
    // Optional signature 3/4: authorize the permit-bearing quote's exact debit.
    console.log("Optional signature 3/4: revoke-order permit");
    const message = permitMessage(permitValue);
    const permitSignature = ethers.utils.splitSignature(
      await wallet._signTypedData(permitDomain, PERMIT_TYPES, message),
    );
    const signedPermit = { ...message, ...permitSignature };
    // Rebuild with the permit hook. All economic fields must remain unchanged.
    const final = await sdk.getQuote(trade, {
      quoteRequest: { validTo },
      appData: revokeOrderAppData(signedPermit),
    });
    if (
      JSON.stringify({
        ...final.quoteResults.orderToSign,
        appData: undefined,
      }) !==
      JSON.stringify({
        ...placeholderQuote.quoteResults.orderToSign,
        appData: undefined,
      })
    ) {
      throw new Error("Final revoke quote differs from the permit draft");
    }
    postSwapOrderFromQuote = final.postSwapOrderFromQuote;
  } else {
    console.log(
      "Existing Vault Relayer allowance covers the revoke order; skipping permit signature.",
    );
  }
  await assertRevokeReplaySafe();

  // Required signature 3/3 (or signature 4/4 after a permit): authorize the final
  // CoW order, including the CowShed revoke bundle in its post-hook.
  console.log(
    needsPermit
      ? "Signature 4/4: hook-aware revoke order"
      : "Required signature 3/3: hook-aware revoke order",
  );
  const { orderId } = await postSwapOrderFromQuote();
  console.log(`Submitted: https://explorer.cow.fi/gc/orders/${orderId}`);
  console.warn(
    "Submission is not fulfillment. After settlement, clear the EOA's Poller allowance and withdraw any remaining sDAI from CowShed.",
  );
}

function requiredBytes32(name: string): string {
  const value = requiredEnv(name);
  if (!ethers.utils.isHexString(value, 32)) {
    throw new Error(`${name} must be a bytes32 hex string`);
  }
  return value;
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
