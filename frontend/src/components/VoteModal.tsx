import { useState } from "react";
import { Button } from "./ui/Button";
import Alert from "./ui/Alert";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./ui/Card";
import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { initializeContractClients } from "../lib/contracts";
import { relayerFetch } from "../lib/api";
import {
  generateVoteProof,
  formatProofForSoroban,
  calculateNullifier,
  type ProofInput,
} from "../lib/zkproof";
import { fetchWithProgress } from "../lib/fetchWithProgress";
import { getMerklePath } from "../lib/merkletree";
import { useOptimisticVote } from "../queries/proposalQueries";
import {
  generateDeterministicZKCredentials,
  getZKCredentials,
  storeZKCredentials,
} from "../lib/zk";
import { CheckCircle, XCircle, AlertTriangle, Loader2, X } from "lucide-react";

interface VoteModalProps {
  proposalId: number;
  eligibleRoot: bigint; // Snapshot of Merkle root when proposal was created
  voteMode: "Fixed" | "Trailing"; // Vote mode: Fixed (snapshot) or Trailing (dynamic)
  vkVersion?: number | null;
  daoId: number;
  publicKey: string;
  kit: StellarWalletsKit | null;
  onClose: () => void;
  onComplete: () => void;
}

type VoteStep = "select" | "generating" | "submitting" | "success" | "error";

export default function VoteModal({
  proposalId,
  eligibleRoot,
  voteMode,
  vkVersion: _vkVersion,
  daoId,
  publicKey,
  kit,
  onClose,
  onComplete,
}: VoteModalProps) {
  const [step, setStep] = useState<VoteStep>("select");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const { setOptimisticVote, clearPendingVote } = useOptimisticVote();

  const handleVote = async (choice: boolean) => {
    setStep("generating");
    setError(null);

    try {
      // Initialize contract clients
      const clients = initializeContractClients(publicKey);

      // Step 1: Load registration data (or regenerate from wallet)
      setProgress("Loading voting credentials...");
      let secret: string, salt: string, commitment: string, leafIndex: number;

      const cached = getZKCredentials(daoId, publicKey);

      if (!cached) {
        // Try to regenerate from wallet signature
        if (import.meta.env.DEV)
          console.log("[Vote] No cached credentials, regenerating...");

        if (!kit) {
          throw new Error(
            "You must register for voting first. Please click 'Register for Voting' button.",
          );
        }

        setProgress("Regenerating credentials from wallet signature...");
        const credentials = await generateDeterministicZKCredentials(
          kit,
          daoId,
        );

        // Get leaf index from contract
        const leafIndexResult = await clients.membershipTree.get_leaf_index({
          dao_id: BigInt(daoId),
          commitment: BigInt(credentials.commitment),
        });

        leafIndex = Number(leafIndexResult.result);
        secret = credentials.secret;
        salt = credentials.salt;
        commitment = credentials.commitment;

        // Cache for next time
        storeZKCredentials(daoId, publicKey, credentials, leafIndex);

        if (import.meta.env.DEV) console.log("[Vote] Credentials regenerated");
      } else {
        secret = cached.secret;
        salt = cached.salt;
        commitment = cached.commitment;
        leafIndex = cached.leafIndex;
      }

      if (import.meta.env.DEV)
        console.log("Using credentials (leaf index:", leafIndex, ")");

      // Step 2: Select root based on vote mode
      // Fixed mode: Use snapshot root from proposal creation
      // Trailing mode: Use current root (allows new members to vote)
      let root: bigint;
      if (voteMode === "Fixed") {
        setProgress("Using proposal snapshot root (Fixed mode)...");
        root = eligibleRoot;
        if (import.meta.env.DEV)
          console.log("Fixed mode - using snapshot root");
      } else {
        setProgress("Fetching current root (Trailing mode)...");
        const currentRootResult = await clients.membershipTree.current_root({
          dao_id: BigInt(daoId),
        });
        root = currentRootResult.result;
        if (import.meta.env.DEV)
          console.log("Trailing mode - using current root");
      }

      // Step 3: Get Merkle path from contract
      setProgress("Fetching Merkle path from tree...");
      const { pathElements, pathIndices } = await getMerklePath(
        leafIndex,
        daoId,
        publicKey,
      );

      if (import.meta.env.DEV) console.log("Merkle path computed");

      // Step 4: Compute nullifier using Poseidon hash
      // nullifier = Poseidon(secret, daoId, proposalId)
      setProgress("Computing nullifier...");
      const nullifier = await calculateNullifier(
        secret,
        daoId.toString(),
        proposalId.toString(),
      );

      // Step 4: Download circuit artifacts with progress (the proving key
      // is several MB and is the main bottleneck for perceived performance)
      const zkey = await fetchWithProgress(
        "/circuits/vote_final.zkey",
        ({ loadedBytes, totalBytes }) => {
          const pct = totalBytes
            ? Math.round((loadedBytes / totalBytes) * 100)
            : 0;
          setProgress(`Downloading proving key... ${pct}%`);
        },
      );
      const wasm = await fetchWithProgress("/circuits/vote.wasm");

      // Step 4b: Generate ZK proof
      setProgress("Generating zero-knowledge proof...");

      const proofInput: ProofInput = {
        // Public signals
        root: root.toString(),
        nullifier: nullifier.toString(),
        daoId: daoId.toString(),
        proposalId: proposalId.toString(),
        voteChoice: choice ? "1" : "0",
        commitment: commitment.toString(), // Private input - computed in circuit, not exposed publicly
        // Note: vkVersion is NOT a circuit signal - it's checked on-chain only
        // Private signals
        secret: secret.toString(),
        salt: salt.toString(),
        pathElements,
        pathIndices,
      };

      if (import.meta.env.DEV) {
        console.log("Proof input ready, generating proof...");
      }

      const { proof, publicSignals } = await generateVoteProof(
        proofInput,
        wasm,
        zkey,
      );

      // Step 4.5: Verify proof locally before submitting
      setProgress("Verifying proof locally...");
      const { verifyProofLocally } = await import("../lib/zkproof");
      const isValid = await verifyProofLocally(
        proof,
        publicSignals,
        "/circuits/verification_key.json",
      );

      if (import.meta.env.DEV)
        console.log("Local proof verification:", isValid);

      if (!isValid) {
        throw new Error(
          "Proof verification failed locally! This indicates a bug in proof generation.",
        );
      }

      // Step 5: Format proof for Soroban
      setProgress("Formatting proof...");
      const { proof_a, proof_b, proof_c } = formatProofForSoroban(proof);

      // Step 6: Submit vote through anonymous relay
      setStep("submitting");
      setProgress("Submitting anonymous vote through relay...");

      // Convert U256 to big-endian hex (U256 values use big-endian, unlike BN254 curve points which use little-endian)
      const toHexBE = (value: string | bigint): string => {
        const bigInt = typeof value === "string" ? BigInt(value) : value;
        return bigInt.toString(16).padStart(64, "0");
      };

      const requestBody = JSON.stringify({
        daoId: Number(daoId),
        proposalId: Number(proposalId),
        choice: choice,
        nullifier: toHexBE(nullifier),
        root: toHexBE(root),
        proof: {
          a: proof_a,
          b: proof_b,
          c: proof_c,
        },
      });

      // Optimistic update
      const revertOptimisticUpdate = setOptimisticVote(daoId, proposalId, choice);
      
      // Close the modal immediately to show optimistic UI state
      setStep("success");
      onComplete();

      // Submit to relay server asynchronously in background
      relayerFetch("/vote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: requestBody,
      })
      .then(async (response) => {
        if (!response.ok) {
          const errorData = await response.json();
          const errorMsg =
            errorData.error || "Failed to submit vote through relay";

          // Detect double-vote error
          if (
            errorMsg.includes("already voted") ||
            errorMsg.includes("UnreachableCodeReached")
          ) {
            alert("You have already voted on this proposal. Each member can only vote once per proposal.");
          } else {
            alert(errorMsg);
          }
          revertOptimisticUpdate();
          return;
        }

        const result = await response.json();
        if (import.meta.env.DEV)
          console.log("Vote submitted successfully:", result);
          
        clearPendingVote(daoId, proposalId);
      })
      .catch((err) => {
        console.error("Vote submission background failure:", err);
        alert("Background vote submission failed: " + (err instanceof Error ? err.message : "Network error"));
        revertOptimisticUpdate();
      });
    } catch (err) {
      setStep("error");
      let errorMsg =
        err instanceof Error ? err.message : "Failed to submit vote";

      // Detect Merkle root mismatch (joined after proposal creation)
      if (
        errorMsg.includes("Assert Failed") ||
        errorMsg.includes("Error in template Vote")
      ) {
        if (voteMode === "Fixed") {
          errorMsg =
            "Cannot vote on this proposal. You joined the DAO after this proposal was created. Only members who were present when the proposal was created can vote on it (snapshot voting).";
        } else {
          errorMsg =
            "Proof generation failed. This may indicate an issue with your voting credentials or the Merkle tree state. Please try registering for voting again.";
        }
      }

      setError(errorMsg);
      console.error("Vote submission failed:", err);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-[100] animate-fade-in"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="absolute -top-10 right-0 h-8 w-8 rounded-full text-white hover:bg-white/20"
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </Button>
        <Card className="w-full shadow-xl border-none">
          {step === "select" && (
            <>
              <CardHeader>
                <CardTitle>Cast Anonymous Vote</CardTitle>
                <CardDescription>
                  Your vote will be verified using zero-knowledge proofs to
                  ensure anonymity while proving membership.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {voteMode === "Fixed" && (
                  <Alert variant="warning" className="text-xs">
                    <AlertTriangle className="h-4 w-4" />
                    Only members present when this proposal was created can vote
                    (snapshot voting).
                  </Alert>
                )}

                <div className="grid grid-cols-2 gap-4 pt-2">
                  <Button
                    onClick={() => handleVote(true)}
                    disabled={step !== "select"}
                    variant="outline"
                    className="h-12 text-lg"
                  >
                    Vote Yes
                  </Button>
                  <Button
                    onClick={() => handleVote(false)}
                    disabled={step !== "select"}
                    variant="outline"
                    className="h-12 text-lg"
                  >
                    Vote No
                  </Button>
                </div>
              </CardContent>
            </>
          )}

          {(step === "generating" || step === "submitting") && (
            <CardContent className="py-12 flex flex-col items-center text-center space-y-4">
              <div className="relative">
                <div className="absolute inset-0 bg-primary/20 rounded-full animate-ping" />
                <div className="relative bg-background rounded-full p-4 border shadow-sm">
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                </div>
              </div>
              <div className="space-y-2">
                <h3 className="font-semibold text-lg">
                  {step === "generating"
                    ? "Generating Proof"
                    : "Submitting Vote"}
                </h3>
                <p className="text-sm text-muted-foreground max-w-[260px] mx-auto">
                  {progress}
                </p>
              </div>
              <Alert className="mt-4 bg-muted/50 border-none">
                <p className="text-xs text-muted-foreground">
                  This process uses heavy cryptography in your browser. Please
                  don't close this window.
                </p>
              </Alert>
            </CardContent>
          )}

          {step === "success" && (
            <CardContent className="py-12 flex flex-col items-center text-center space-y-4">
              <div className="h-16 w-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mb-2">
                <CheckCircle className="h-8 w-8 text-green-600 dark:text-green-400" />
              </div>
              <div className="space-y-1">
                <h3 className="font-bold text-xl">Vote Submitted!</h3>
                <p className="text-muted-foreground">
                  Your anonymous vote has been recorded on the blockchain.
                </p>
              </div>
            </CardContent>
          )}

          {step === "error" && (
            <>
              <CardHeader>
                <CardTitle className="text-destructive flex items-center gap-2">
                  <XCircle className="h-5 w-5" />
                  Error
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Alert variant="error">{error}</Alert>
                <Button
                  variant="secondary"
                  size="lg"
                  className="w-full"
                  onClick={onClose}
                >
                  Close
                </Button>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
