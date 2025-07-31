import {
  SupportedChainId,
  OrderSigningUtils,
  UnsignedOrder
} from "@cowprotocol/cow-sdk";
import { ethers } from "ethers";
import { confirm, getWallet } from "../../utils";
import { getErc20Contract } from "../../contracts/erc20";
import { orderHelperFactoryAbi } from "./abi/OrderHelperFactoryAbi";
import { orderHelperAbi } from "./abi/OrderHelperAbi";
import { MetadataApi } from '@cowprotocol/app-data';
import { utils } from 'ethers'
import {
  OrderBalance,
  OrderKind,
  hashOrder,
  type Order} from '@cowprotocol/contracts'
import { GPv2Settlement__factory } from "@cowprotocol/cow-sdk/dist/common/generated";


const TOKENS = {
  oldUnderlying: "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83", // USDC
  oldCollateral: "0xc6B7AcA6DE8a6044E0e32d0c841a89244A10D284", // aUSDC
  debt: "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb", // GNO
  newUnderlying: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", // WXDAI
  newCollateral: "0xd0Dd6cEF72143E22cCED4867eb0d5F2328715533", // aWXDAI
} as const;

const AAVE_POOL_ADDRESS = "0xb50201558B00496A145fE76f7424749556E326D8"; // See https://search.onaave.com/?q=sepolia
const COW_FLASHLOAN_TRACKER = "0xCB77A75B5fbb2FFE143BD05c3660b4e1fb44929D";
const COW_AAVE_BORROWER = "0x7d9C4DeE56933151Bc5C909cfe09DEf0d315CB4A";
const COW_AAVE_HELPER_FACTORY = "0x9364CA1a885CA56b357A62A8DddaFa73D85EC826";
const DEFAULT_GAS_LIMIT = "1000000"; // FIXME: This should not be necessary, it should estimate correctly!
const VALID_FOR = 1754010000;
const CHAIN_ID = SupportedChainId.GNOSIS_CHAIN;
const FLASHLOAN_FEE = "10000"; // 0.05% of the flashloan amount
const OLD_COLLATERAL_AMOUNT = "20000000";
const NEW_COLLATERAL_AMOUNT = "18000000000000000000";

export async function run() {
  const wallet = await getWallet(CHAIN_ID);
  const trader = wallet.address;

  const orderHelperFactory = new ethers.Contract(
    COW_AAVE_HELPER_FACTORY,
    orderHelperFactoryAbi,
    wallet
  );

  const orderHelperParams = [
    trader, // owner
    COW_FLASHLOAN_TRACKER,
    TOKENS.oldUnderlying,
    OLD_COLLATERAL_AMOUNT,
    TOKENS.newUnderlying,
    NEW_COLLATERAL_AMOUNT,
    VALID_FOR,
    FLASHLOAN_FEE,
    COW_AAVE_BORROWER
  ];
  console.log("Get helper contract", orderHelperParams);

  const helperContract: string = await orderHelperFactory.getOrderHelperAddress(
    ...orderHelperParams
  );

  console.log("will use helperContract", helperContract);

  const confirmed = await confirm(
    `Do you want to approve token ${TOKENS.oldCollateral} to spender ${helperContract}?`
  );
  if (confirmed) {
    const oldCollateral = getErc20Contract(TOKENS.oldCollateral, wallet);
    const tx = await oldCollateral.approve(helperContract, OLD_COLLATERAL_AMOUNT);
    await tx.wait();
    console.log("approved: ", tx.hash);
  }

  const appCode = 'aave-v3-flashloan'
  const flashLoanHint = {
    lender: AAVE_POOL_ADDRESS,
    borrower: helperContract,
    token: TOKENS.oldUnderlying,
    amount: OLD_COLLATERAL_AMOUNT, // this is actually in UNDERLYING but aave tokens are 1:1
  };
  console.log("flashLoanHint", flashLoanHint);

  // Prepare deployment of the helper contract
  const deployOrderHelperData = orderHelperFactory.interface.encodeFunctionData(
    "deployOrderHelper",
    orderHelperParams
  );

  const helperContractInstance = new ethers.Contract(
    helperContract,
    orderHelperAbi
  );
  const stringify = require('json-stringify-deterministic');
  const appDataDoc = {
    appCode: appCode,
    metadata: {
      flashloan: flashLoanHint,
      hooks: {
        pre: [
          {
            target: COW_AAVE_HELPER_FACTORY,
            callData: deployOrderHelperData,
            gasLimit: DEFAULT_GAS_LIMIT,
          },
          {
            target: helperContract,
            callData: helperContractInstance.interface.encodeFunctionData("preHook"),
            gasLimit: DEFAULT_GAS_LIMIT,
          },
        ],
        post: [
          {
            target: helperContract,
            callData: helperContractInstance.interface.encodeFunctionData("postHook"),
            gasLimit: DEFAULT_GAS_LIMIT,
          }
        ],
      }

    }
  }

  // TODO: Update the metadataApi dependency to avoid this hack
  //const metadataApi = new MetadataApi();
  const fullAppData = stringify(appDataDoc);
  console.log("fullAppData", fullAppData);

  const module = await import('ethers/lib/utils')
  const { keccak256, toUtf8Bytes } = module.default || module
  const appDataHash = keccak256(toUtf8Bytes(fullAppData))
  console.log("appDataHash", appDataHash);
  
  const order: Order = {
    sellToken: TOKENS.oldCollateral,
    buyToken: TOKENS.newCollateral,
    receiver: trader,
    feeAmount: "0",
    sellAmount: "19990000", // 20000000 - 10000
    buyAmount: "18000000000000000000",
    validTo: VALID_FOR, 
    appData: appDataHash,
    kind: OrderKind.SELL,
    partiallyFillable: false,
    sellTokenBalance: OrderBalance.ERC20,
    buyTokenBalance: OrderBalance.ERC20,
  }
  const orderHash = hashOrder(await OrderSigningUtils.getDomain(CHAIN_ID), order);
  console.log("orderHash", orderHash);

  // TODO: There should be an easier way to encode an order
  const types = [
    "address", // sellToken
    "address", // buyToken
    "address", // receiver
    "uint256", // sellAmount 
    "uint256", // buyAmount
    "uint32", // validTo
    "bytes32", // appData
    "uint256", // feeAmount
    "bytes32", // kind
    "bool", // partiallyFillable
    "bytes32", // sellTokenBalance
    "bytes32", // buyTokenBalance
  ];
  const encodedOrder = utils.defaultAbiCoder.encode(types, [
    order.sellToken,
    order.buyToken, 
    order.receiver,
    order.sellAmount,
    order.buyAmount,
    order.validTo,
    order.appData,
    order.feeAmount,
    "0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775", // order.kind
    order.partiallyFillable,
    "0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9", // order.sellTokenBalance
    "0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9", // order.buyTokenBalance
  ]);
  console.log("encodedOrder", encodedOrder);


  const signedOrder = await OrderSigningUtils.signOrder(order as UnsignedOrder, CHAIN_ID, wallet);
  console.log("signedOrder", signedOrder.signature);

  // TODO: ugly. Find a better way to encode the order+signature
  const fullSingature = utils.defaultAbiCoder.encode(
    ["tuple(address sellToken, address buyToken, address receiver, uint256 sellAmount, uint256 buyAmount, uint32 validTo, bytes32 appData, uint256 feeAmount, bytes32 kind, bool partiallyFillable, bytes32 sellTokenBalance, bytes32 buyTokenBalance)", "bytes"], 
    [
      [
        order.sellToken,
        order.buyToken, 
        order.receiver,
        order.sellAmount,
        order.buyAmount,
        order.validTo,
        order.appData,
        order.feeAmount,
        "0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775", // order.kind
        order.partiallyFillable,
        "0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9", // order.sellTokenBalance
        "0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9"
      ],
      signedOrder.signature
    ]);
  console.log("fullSignature", fullSingature);

  const data = {
    "sellToken": TOKENS.oldCollateral,
    "buyToken": TOKENS.newCollateral,
    "receiver": trader,
    "feeAmount": "0",
    "sellAmount": "19990000", // 20000000 - 10000
    "buyAmount": "18000000000000000000",
    "validTo": VALID_FOR,
    "kind": "sell",
    "partiallyFillable": false,
    "sellTokenBalance": "erc20",
    "buyTokenBalance": "erc20",
    "signingScheme": "eip1271",
    "signature": fullSingature,
    "from": helperContract.toString(),
    "quoteId": 0,
    "appData": fullAppData,
  }

  console.log("data", data);
  console.log("json", JSON.stringify(data));

  // Post the order
  const response = await fetch("https://barn.api.cow.fi/xdai/api/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(data)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
  }

  console.log("response", response);   
}
