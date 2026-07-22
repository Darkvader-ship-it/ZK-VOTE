const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Bridge", function () {
  let bridge, verifier, owner, user, relayer;
  const sbtContractAddr = 12345n;
  const daoId = 1n;
  const proposalId = 1n;
  const voteChoice = 1n;
  const nullifier = 999n;
  const voteRoot = ethers.ZeroHash;
  const sbtRoot = ethers.ZeroHash;

  beforeEach(async function () {
    [owner, user, relayer] = await ethers.getSigners();

    const MockVerifier = await ethers.getContractFactory("MockVerifier");
    verifier = await MockVerifier.deploy();
    await verifier.waitForDeployment();

    const Bridge = await ethers.getContractFactory("Bridge");
    bridge = await Bridge.deploy(
      await verifier.getAddress(),
      sbtContractAddr
    );
    await bridge.waitForDeployment();

    // Post SBT root for daoId=1
    await bridge.updateSbtRoot(daoId, sbtRoot);
  });

  describe("Deployment", function () {
    it("should set admin to deployer", async function () {
      expect(await bridge.admin()).to.equal(owner.address);
    });

    it("should set verifier address", async function () {
      expect(await bridge.verifier()).to.equal(await verifier.getAddress());
    });

    it("should set SBT contract address", async function () {
      expect(await bridge.sbtContractAddr()).to.equal(sbtContractAddr);
    });

    it("should set chain ID", async function () {
      expect(await bridge.chainId()).to.equal(31337n);
    });
  });

  describe("Admin functions", function () {
    it("should update SBT root", async function () {
      const newRoot = ethers.keccak256(ethers.toUtf8Bytes("new-root"));
      await bridge.updateSbtRoot(daoId, newRoot);
      expect(await bridge.sbtRoots(daoId)).to.equal(newRoot);
    });

    it("should revert if non-admin updates SBT root", async function () {
      await expect(
        bridge.connect(user).updateSbtRoot(daoId, sbtRoot)
      ).to.be.revertedWithCustomError(bridge, "OnlyAdmin");
    });

    it("should update verifier", async function () {
      const newVerifier = user.address;
      await bridge.setVerifier(newVerifier);
      expect(await bridge.verifier()).to.equal(newVerifier);
    });

    it("should revert if non-admin updates verifier", async function () {
      await expect(
        bridge.connect(user).setVerifier(user.address)
      ).to.be.revertedWithCustomError(bridge, "OnlyAdmin");
    });

    it("should revert if setting zero address verifier", async function () {
      await expect(
        bridge.setVerifier(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(bridge, "InvalidAddress");
    });

    it("should transfer admin", async function () {
      await bridge.setAdmin(user.address);
      expect(await bridge.admin()).to.equal(user.address);
    });
  });

  describe("castVote", function () {
    // Create a mock proof (128 bytes)
    const mockProof = ethers.hexlify(ethers.randomBytes(256));

    it("should emit VoteForwarded on valid proof", async function () {
      await expect(
        bridge.castVote(
          daoId,
          proposalId,
          voteChoice,
          nullifier,
          voteRoot,
          sbtRoot,
          mockProof
        )
      )
        .to.emit(bridge, "VoteForwarded")
        .withArgs(daoId, proposalId, nullifier, voteChoice, voteRoot);
    });

    it("should mark nullifier as used", async function () {
      await bridge.castVote(
        daoId,
        proposalId,
        voteChoice,
        nullifier,
        voteRoot,
        sbtRoot,
        mockProof
      );
      expect(
        await bridge.isNullifierUsed(daoId, proposalId, nullifier)
      ).to.be.true;
    });

    it("should revert on double-voting (same nullifier)", async function () {
      await bridge.castVote(
        daoId,
        proposalId,
        voteChoice,
        nullifier,
        voteRoot,
        sbtRoot,
        mockProof
      );
      await expect(
        bridge.castVote(
          daoId,
          proposalId,
          voteChoice,
          nullifier,
          voteRoot,
          sbtRoot,
          mockProof
        )
      ).to.be.revertedWithCustomError(bridge, "NullifierUsed");
    });

    it("should revert on zero nullifier", async function () {
      await expect(
        bridge.castVote(
          daoId,
          proposalId,
          voteChoice,
          0n,
          voteRoot,
          sbtRoot,
          mockProof
        )
      ).to.be.revertedWithCustomError(bridge, "ZeroNullifier");
    });

    it("should revert on invalid vote choice", async function () {
      await expect(
        bridge.castVote(
          daoId,
          proposalId,
          2n,
          nullifier,
          voteRoot,
          sbtRoot,
          mockProof
        )
      ).to.be.revertedWithCustomError(bridge, "InvalidVoteChoice");
    });

    it("should revert when SBT root not set", async function () {
      const newDaoId = 999n;
      await expect(
        bridge.castVote(
          newDaoId,
          proposalId,
          voteChoice,
          nullifier,
          voteRoot,
          sbtRoot,
          mockProof
        )
      ).to.be.revertedWithCustomError(bridge, "SbtRootNotSet");
    });

    it("should revert when provided sbtRoot mismatches", async function () {
      const wrongRoot = ethers.keccak256(ethers.toUtf8Bytes("wrong"));
      await expect(
        bridge.castVote(
          daoId,
          proposalId,
          voteChoice,
          nullifier,
          voteRoot,
          wrongRoot,
          mockProof
        )
      ).to.be.revertedWithCustomError(bridge, "SbtRootNotSet");
    });

    it("should revert on invalid proof (mock verifier rejects)", async function () {
      await verifier.setShouldVerify(false);
      await expect(
        bridge.castVote(
          daoId,
          proposalId,
          voteChoice,
          nullifier,
          voteRoot,
          sbtRoot,
          mockProof
        )
      ).to.be.revertedWithCustomError(bridge, "InvalidProof");
    });

    it("should allow different nullifiers for same DAO+proposal", async function () {
      await bridge.castVote(
        daoId,
        proposalId,
        voteChoice,
        100n,
        voteRoot,
        sbtRoot,
        mockProof
      );
      await bridge.castVote(
        daoId,
        proposalId,
        voteChoice,
        200n,
        voteRoot,
        sbtRoot,
        mockProof
      );
      expect(await bridge.isNullifierUsed(daoId, proposalId, 100n)).to.be
        .true;
      expect(await bridge.isNullifierUsed(daoId, proposalId, 200n)).to.be
        .true;
    });
  });

  describe("Gas benchmarks", function () {
    it("castVote should use less than 500k gas", async function () {
      const mockProof = ethers.hexlify(ethers.randomBytes(256));
      const tx = await bridge.castVote(
        daoId,
        proposalId,
        voteChoice,
        nullifier,
        voteRoot,
        sbtRoot,
        mockProof
      );
      const receipt = await tx.wait();
      console.log("Gas used:", receipt.gasUsed.toString());
      expect(receipt.gasUsed).to.be.lessThan(500000n);
    });
  });
});
