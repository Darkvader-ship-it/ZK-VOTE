import { useState, useEffect, useCallback } from "react";
import { RELAYER_URL } from "../lib/api";

interface ThresholdPanelProps {
  daoId: number;
  proposalId: number;
  isConnected: boolean;
  publicKey: string | null;
}

interface DkgState {
  phase: "idle" | "registration" | "commitment" | "completed";
  thresholdN: number;
  thresholdT: number;
  jointPublicKey: string | null;
  authorityCount: number;
}

interface AuthorityRegistration {
  address: string;
  name: string;
  verifierId: string;
}

interface ProtocolState {
  dkgRound?: DkgState;
  encryptedVoteCount: number;
  decryptionShareCount: number;
  isTallyDecrypted: boolean;
}

const BN254_VERIFIER_PREFIX = "did:stellar:";

export function ThresholdPanel({
  daoId,
  proposalId,
  isConnected,
  publicKey,
}: ThresholdPanelProps) {
  const [dkgState, setDkgState] = useState<DkgState>({
    phase: "idle",
    thresholdN: 3,
    thresholdT: 2,
    jointPublicKey: null,
    authorityCount: 0,
  });
  const [authorityName, setAuthorityName] = useState("");
  const [authorities, setAuthorities] = useState<AuthorityRegistration[]>([]);
  const [protocolState, setProtocolState] = useState<ProtocolState | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"setup" | "status" | "decrypt">(
    "setup",
  );

  const clearMessages = () => {
    setError(null);
    setSuccess(null);
  };

  const showError = (msg: string) => {
    setError(msg);
    setSuccess(null);
  };

  const showSuccess = (msg: string) => {
    setSuccess(msg);
    setError(null);
  };

  // Initialize the threshold protocol
  const handleInitElection = useCallback(async () => {
    if (!publicKey) return;
    clearMessages();
    setLoading(true);

    try {
      const response = await fetch(`${RELAYER_URL}/threshold/init`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Relayer-Auth": import.meta.env.VITE_RELAYER_AUTH_TOKEN || "",
        },
        body: JSON.stringify({
          daoId,
          proposalId,
          thresholdN: dkgState.thresholdN,
          thresholdT: dkgState.thresholdT,
          creator: publicKey,
        }),
      });

      const data = await response.json();
      if (!data.success) throw new Error(data.error || "Initialization failed");

      setDkgState((prev) => ({
        ...prev,
        phase: "registration",
      }));

      showSuccess("Threshold decryption initialized successfully");
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [daoId, proposalId, dkgState.thresholdN, dkgState.thresholdT, publicKey]);

  // Register as an authority
  const handleRegisterAuthority = useCallback(async () => {
    if (!publicKey || !authorityName.trim()) return;
    clearMessages();
    setLoading(true);

    const verifierId = `${BN254_VERIFIER_PREFIX}${publicKey.slice(0, 16)}`;

    try {
      const response = await fetch(
        `${RELAYER_URL}/threshold/authority/register`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Relayer-Auth": import.meta.env.VITE_RELAYER_AUTH_TOKEN || "",
          },
          body: JSON.stringify({
            daoId,
            proposalId,
            authorityAddress: publicKey,
            authorityName: authorityName.trim(),
            verifierId,
          }),
        },
      );

      const data = await response.json();
      if (!data.success) throw new Error(data.error || "Registration failed");

      setAuthorities((prev) => [
        ...prev,
        { address: publicKey, name: authorityName.trim(), verifierId },
      ]);

      setAuthorityName("");
      showSuccess("Registered as tally authority");
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [daoId, proposalId, publicKey, authorityName]);

  // Finalize DKG
  const handleFinalizeDKG = useCallback(async () => {
    clearMessages();
    setLoading(true);

    try {
      const response = await fetch(`${RELAYER_URL}/threshold/dkg/finalize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Relayer-Auth": import.meta.env.VITE_RELAYER_AUTH_TOKEN || "",
        },
        body: JSON.stringify({ daoId, proposalId }),
      });

      const data = await response.json();
      if (!data.success)
        throw new Error(data.error || "DKG finalization failed");

      setDkgState((prev) => ({
        ...prev,
        phase: "completed",
        jointPublicKey: data.jointPublicKey,
        authorityCount: data.authoritiesCount,
      }));

      showSuccess("DKG completed. Joint public key established.");
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [daoId, proposalId]);

  // Refresh protocol state
  const refreshState = useCallback(async () => {
    try {
      const response = await fetch(
        `${RELAYER_URL}/threshold/state/${daoId}/${proposalId}`,
      );
      const data = await response.json();
      if (data.success) {
        setProtocolState(data.state);
      }
    } catch {
      // Silent fail for polling
    }
  }, [daoId, proposalId]);

  // Poll for state updates
  useEffect(() => {
    if (!isConnected) return;
    const interval = setInterval(refreshState, 5000);
    return () => clearInterval(interval);
  }, [isConnected, refreshState]);

  if (!isConnected) {
    return (
      <div className="p-4 text-center text-muted-foreground">
        Connect your wallet to manage threshold decryption.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Threshold Decryption</h3>
        <span
          className={`px-3 py-1 rounded-full text-xs font-medium ${
            dkgState.phase === "completed"
              ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
              : dkgState.phase === "registration" ||
                  dkgState.phase === "commitment"
                ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
          }`}
        >
          {dkgState.phase === "completed"
            ? "Active"
            : dkgState.phase === "registration"
              ? "Registering"
              : dkgState.phase === "commitment"
                ? "DKG in Progress"
                : "Not Initialized"}
        </span>
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-2 border-b border-border/40 pb-2">
        {(["setup", "status", "decrypt"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              activeTab === tab
                ? "bg-purple-50 text-purple-700 dark:bg-purple-900/20 dark:text-purple-400 border-b-2 border-purple-500"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab === "setup"
              ? "Setup"
              : tab === "status"
                ? "Status"
                : "Decrypt"}
          </button>
        ))}
      </div>

      {/* Error/Success Messages */}
      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-lg text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="p-3 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 rounded-lg text-sm">
          {success}
        </div>
      )}

      {/* Setup Tab */}
      {activeTab === "setup" && (
        <div className="space-y-6">
          {/* Initialize */}
          {dkgState.phase === "idle" && (
            <div className="p-4 border border-border/40 rounded-lg space-y-4">
              <h4 className="font-medium">Initialize Threshold Decryption</h4>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-muted-foreground mb-1">
                    Total Authorities (n)
                  </label>
                  <input
                    type="number"
                    min={2}
                    max={32}
                    value={dkgState.thresholdN}
                    onChange={(e) =>
                      setDkgState((prev) => ({
                        ...prev,
                        thresholdN: parseInt(e.target.value) || 3,
                      }))
                    }
                    className="w-full px-3 py-2 border border-border/40 rounded-lg bg-background"
                  />
                </div>
                <div>
                  <label className="block text-sm text-muted-foreground mb-1">
                    Threshold (t)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={dkgState.thresholdN}
                    value={dkgState.thresholdT}
                    onChange={(e) =>
                      setDkgState((prev) => ({
                        ...prev,
                        thresholdT: Math.min(
                          parseInt(e.target.value) || 2,
                          prev.thresholdN,
                        ),
                      }))
                    }
                    className="w-full px-3 py-2 border border-border/40 rounded-lg bg-background"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                (t, n) = ({dkgState.thresholdT}, {dkgState.thresholdN}): Any{" "}
                {dkgState.thresholdT} of {dkgState.thresholdN} authorities can
                decrypt the tally.
              </p>
              <button
                onClick={handleInitElection}
                disabled={loading}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 text-sm"
              >
                {loading ? "Initializing..." : "Initialize Election"}
              </button>
            </div>
          )}

          {/* Authority Registration */}
          {(dkgState.phase === "registration" ||
            dkgState.phase === "commitment") && (
            <div className="p-4 border border-border/40 rounded-lg space-y-4">
              <h4 className="font-medium">Register as Tally Authority</h4>
              <div>
                <label className="block text-sm text-muted-foreground mb-1">
                  Authority Name
                </label>
                <input
                  type="text"
                  value={authorityName}
                  onChange={(e) => setAuthorityName(e.target.value)}
                  placeholder="e.g., Tally Authority 1"
                  className="w-full px-3 py-2 border border-border/40 rounded-lg bg-background"
                  maxLength={64}
                />
              </div>
              <button
                onClick={handleRegisterAuthority}
                disabled={loading || !authorityName.trim()}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 text-sm"
              >
                {loading ? "Registering..." : "Register"}
              </button>

              {authorities.length > 0 && (
                <div>
                  <h5 className="text-sm font-medium mt-4 mb-2">
                    Registered Authorities ({authorities.length})
                  </h5>
                  <div className="space-y-2">
                    {authorities.map((auth, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-800/50 rounded text-sm"
                      >
                        <span className="font-medium">{auth.name}</span>
                        <span className="text-muted-foreground text-xs font-mono">
                          {auth.address.slice(0, 12)}...
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {authorities.length >= dkgState.thresholdN && (
                <button
                  onClick={handleFinalizeDKG}
                  disabled={loading}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 text-sm"
                >
                  {loading ? "Finalizing..." : "Finalize DKG"}
                </button>
              )}
            </div>
          )}

          {/* DKG Complete */}
          {dkgState.phase === "completed" && (
            <div className="p-4 border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/10 rounded-lg">
              <h4 className="font-medium text-green-700 dark:text-green-400">
                DKG Completed
              </h4>
              <p className="text-sm mt-1 text-muted-foreground">
                Joint public key established with {dkgState.authorityCount}{" "}
                authorities.
              </p>
              {dkgState.jointPublicKey && (
                <p className="text-xs font-mono mt-2 text-muted-foreground break-all">
                  Public Key: 0x{dkgState.jointPublicKey.slice(0, 32)}...
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Status Tab */}
      {activeTab === "status" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 border border-border/40 rounded-lg">
              <div className="text-2xl font-bold">
                {protocolState?.encryptedVoteCount ?? 0}
              </div>
              <div className="text-sm text-muted-foreground">
                Encrypted Votes
              </div>
            </div>
            <div className="p-4 border border-border/40 rounded-lg">
              <div className="text-2xl font-bold">
                {protocolState?.decryptionShareCount ?? 0}
              </div>
              <div className="text-sm text-muted-foreground">
                Decryption Shares
              </div>
            </div>
          </div>

          <div className="p-4 border border-border/40 rounded-lg">
            <h4 className="font-medium mb-2">DKG Configuration</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Phase</span>
                <span>{dkgState.phase}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Threshold</span>
                <span>
                  ({dkgState.thresholdT}, {dkgState.thresholdN})
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tally Decrypted</span>
                <span>{protocolState?.isTallyDecrypted ? "Yes" : "No"}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Decrypt Tab */}
      {activeTab === "decrypt" && (
        <div className="space-y-4">
          <div className="p-4 border border-border/40 rounded-lg">
            <h4 className="font-medium mb-2">Decryption Participation</h4>
            <p className="text-sm text-muted-foreground mb-4">
              As a tally authority, you can submit your decryption share once
              voting has ended and the encrypted tally has been computed.
            </p>

            {dkgState.phase === "completed" ? (
              <div className="space-y-3">
                <div className="p-3 bg-blue-50 dark:bg-blue-900/10 rounded text-sm">
                  <p className="font-medium text-blue-700 dark:text-blue-400">
                    Ready for Decryption
                  </p>
                  <p className="text-muted-foreground mt-1">
                    The DKG is complete. Once voting ends, the encrypted tally
                    will be computed and authorities will be able to submit
                    decryption shares.
                  </p>
                </div>

                <button
                  onClick={() =>
                    showSuccess("Decryption share submitted (simulated)")
                  }
                  disabled={loading}
                  className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 text-sm"
                >
                  Submit Decryption Share
                </button>
              </div>
            ) : (
              <div className="p-3 bg-yellow-50 dark:bg-yellow-900/10 rounded text-sm">
                <p className="text-yellow-700 dark:text-yellow-400">
                  DKG must be completed before decryption can begin.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
