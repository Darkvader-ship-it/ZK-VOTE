import { useState, useEffect } from "react";

/**
 * Hook to ensure a component only renders after the client has mounted.
 * This prevents hydration mismatches when server-rendered HTML differs from client-rendered HTML.
 * 
 * Common use cases:
 * - Wallet-dependent UI (server doesn't know wallet state)
 * - LocalStorage-dependent UI (server doesn't have localStorage)
 * - Date/time formatting with local timezone (server uses UTC)
 * - Browser APIs that don't exist on server
 * 
 * @returns boolean - true only after component has mounted on client
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return mounted;
}
