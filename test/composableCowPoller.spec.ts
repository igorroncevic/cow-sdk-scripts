import assert from "node:assert/strict";
import { ethers } from "ethers";

import {
  ComposableCowPoller,
  PollerSchedule,
} from "../src/scripts/composable-cow/composableCowPoller";
import {
  assertPermitValid,
  MULTICALL3,
  optionalPermitCall,
  SignedPermit,
} from "../src/scripts/composable-cow/optionalPermit";

const POLLER = "0x1111111111111111111111111111111111111111";
const HANDLER = "0x2222222222222222222222222222222222222222";
const FUNDER = "0x3333333333333333333333333333333333333333";
const OWNER = "0x4444444444444444444444444444444444444444";
const TOKEN = "0x5555555555555555555555555555555555555555";
const SALT = ethers.utils.hexZeroPad("0x01", 32);
const schedule: PollerSchedule = {
  handler: HANDLER,
  authEpoch: 7,
  funder: FUNDER,
  owner: OWNER,
  salt: SALT,
  staticInput: "0x1234",
};
const poller = new ComposableCowPoller(
  POLLER,
  new ethers.providers.JsonRpcProvider(),
);

async function main() {
  const expectedScheduleId = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["address", "address", "address", "bytes32"],
      [FUNDER, HANDLER, OWNER, SALT],
    ),
  );
  assert.equal(poller.getScheduleId(schedule), expectedScheduleId);

  const registerCall = poller.contractInterface.parseTransaction({
    data: poller.encodeRegisterFromShed(schedule),
  });
  assert.equal(registerCall.name, "registerFromShed");
  assert.equal(registerCall.args.schedule.handler, HANDLER);
  assert(registerCall.args.schedule.authEpoch.eq(schedule.authEpoch));
  assert.equal(registerCall.args.schedule.funder, FUNDER);
  assert.equal(registerCall.args.schedule.owner, OWNER);

  const revokeCall = poller.contractInterface.parseTransaction({
    data: poller.encodeRevokeFromShed(schedule),
  });
  assert.equal(revokeCall.name, "revokeFromShed");
  assert.equal(revokeCall.args.handler, HANDLER);
  assert.equal(revokeCall.args.funder, FUNDER);
  assert.equal(revokeCall.args.owner, OWNER);
  assert.equal(revokeCall.args.salt, SALT);
  assert(revokeCall.args.authEpoch.eq(schedule.authEpoch));

  const signedPermit: SignedPermit = {
    owner: FUNDER,
    spender: OWNER,
    value: "10",
    nonce: "3",
    deadline: "1800000000",
    v: 27,
    r: ethers.constants.HashZero,
    s: ethers.constants.HashZero,
  };
  const permitCall = optionalPermitCall(TOKEN, signedPermit);
  assert.equal(permitCall.target, MULTICALL3);
  const multicallInterface = new ethers.utils.Interface([
    "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
  ]);
  const [calls] = multicallInterface.decodeFunctionData(
    "aggregate3",
    permitCall.callData,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, TOKEN);
  assert.equal(calls[0].allowFailure, true);

  const permitInterface = new ethers.utils.Interface([
    "function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)",
  ]);
  const decodedPermit = permitInterface.decodeFunctionData(
    "permit",
    calls[0].callData,
  );
  assert.equal(decodedPermit.owner, FUNDER);
  assert.equal(decodedPermit.spender, OWNER);
  assert(decodedPermit.value.eq(10));

  let simulatedArgs: readonly unknown[] | undefined;
  const token = {
    callStatic: {
      permit: async (...args: readonly unknown[]) => {
        simulatedArgs = args;
      },
    },
  } as unknown as ethers.Contract;
  await assertPermitValid(token, signedPermit);
  assert.equal(simulatedArgs?.[0], FUNDER);
  assert.equal(simulatedArgs?.[1], OWNER);

  console.log("ComposableCowPoller contract adapter tests passed");
}

void main();
