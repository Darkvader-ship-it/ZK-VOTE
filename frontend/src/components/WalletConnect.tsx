import { useState } from "react";
import { useMounted } from "../hooks/useMounted";
import { Button, Card, Banner } from "@stellar/design-system";
import { isFreighterInstalled, FREIGHTER_INSTALL_URL } from "../services/freighter";

interface WalletConnectProps {
  onConnect: () => Promise<void>;
  onDisconnect: () => void;
  publicKey: string | null;
  isConnected: boolean;
  networkWarning?: string | null;
}

export default function WalletConnect({
  onConnect,
  onDisconnect,
  publicKey,
  isConnected,
  networkWarning,
}: WalletConnectProps) {
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const mounted = useMounted();
  const hasFreighter = typeof window !== "undefined" && isFreighterInstalled();

  const handleConnect = async () => {
    try {
      setError(null);
      setConnecting(true);
      await onConnect();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect wallet");
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = () => {
    onDisconnect();
  };

  const truncateAddress = (addr: string) => {
    return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
  };

  if (!mounted) {
    // Return placeholder during SSR to prevent hydration mismatch
    return (
      <Card variant="primary">
        <h3 className="text-lg font-semibold mb-2">Connect Wallet</h3>
        <p className="text-muted-foreground mb-4">
          Connect your Stellar wallet (Freighter, xBull, Albedo, etc.) to interact
          with the DAO.
        </p>
        <Button
          variant="primary"
          size="md"
          isFullWidth
          disabled
        >
          Connect Wallet
        </Button>
      </Card>
    );
  }

  if (isConnected && publicKey) {
    return (
      <div className="space-y-2">
        {networkWarning && (
          <Banner variant="warning">
            <p className="text-sm font-medium">{networkWarning}</p>
          </Banner>
        )}
        <Banner variant="success">
          <div className="flex items-center justify-between w-full">
            <div>
              <h3 className="text-lg font-semibold mb-1">Wallet Connected</h3>
              <p className="font-mono text-sm">{truncateAddress(publicKey)}</p>
            </div>
            <Button variant="destructive" size="md" onClick={handleDisconnect}>
              Disconnect
            </Button>
          </div>
        </Banner>
      </div>
    );
  }

  return (
    <Card variant="primary">
      <h3 className="text-lg font-semibold mb-2">Connect Wallet</h3>
      <p className="text-muted-foreground mb-4">
        Connect your Stellar wallet (Freighter, xBull, Albedo, etc.) to interact
        with the DAO.
      </p>
      {!hasFreighter && (
        <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-md">
          <p className="text-sm font-medium text-amber-600 dark:text-amber-400 mb-2">
            Freighter wallet not detected.
          </p>
          <a
            href={FREIGHTER_INSTALL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-xs font-semibold text-primary underline hover:text-primary/80"
          >
            Install Freighter Extension &rarr;
          </a>
        </div>
      )}
      {error && (
        <div className="mb-4">
          <Banner variant="error">{error}</Banner>
        </div>
      )}
      <Button
        variant="primary"
        size="md"
        isFullWidth
        onClick={handleConnect}
        disabled={connecting}
        isLoading={connecting}
      >
        {connecting ? "Connecting..." : "Connect Wallet"}
      </Button>
    </Card>
  );
}
