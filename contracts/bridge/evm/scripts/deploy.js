const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  // Deploy MockVerifier (replace with real Verifier.sol in production)
  const MockVerifier = await hre.ethers.getContractFactory("MockVerifier");
  const verifier = await MockVerifier.deploy();
  await verifier.waitForDeployment();
  const verifierAddr = await verifier.getAddress();
  console.log("MockVerifier deployed to:", verifierAddr);

  // SBT contract address on Soroban (from environment or default)
  const sbtContractAddr = process.env.SBT_CONTRACT_ADDR || "1";
  console.log("SBT contract address:", sbtContractAddr);

  // Deploy Bridge
  const Bridge = await hre.ethers.getContractFactory("Bridge");
  const bridge = await Bridge.deploy(verifierAddr, sbtContractAddr);
  await bridge.waitForDeployment();
  const bridgeAddr = await bridge.getAddress();
  console.log("Bridge deployed to:", bridgeAddr);

  // Post initial SBT root for testing
  const daoId = 1;
  const sbtRoot = hre.ethers.ZeroHash;
  // Note: In production, the relayer calls updateSbtRoot with real roots
  // await bridge.updateSbtRoot(daoId, sbtRoot);

  console.log("\nDeployment complete!");
  console.log("Verifier:", verifierAddr);
  console.log("Bridge:", bridgeAddr);
  console.log("\nNext steps:");
  console.log("1. Compile bridge.circom and generate Verifier.sol");
  console.log("2. Deploy real Verifier.sol and call bridge.setVerifier()");
  console.log("3. Relayer calls bridge.updateSbtRoot() with SBT state roots");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
