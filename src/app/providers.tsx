"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTerminal } from "@/store/terminal";

/**
 * Rehydrate the persisted terminal store AFTER mount. With skipHydration the
 * server HTML and the client's first render both use defaults (no mismatch);
 * persisted state (mode, watchlist selection) applies one paint later.
 */
function StoreHydrator() {
  useEffect(() => {
    void useTerminal.persist.rehydrate();
  }, []);
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <StoreHydrator />
      {children}
    </QueryClientProvider>
  );
}
