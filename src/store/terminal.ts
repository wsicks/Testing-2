"use client";

// Client-side terminal state (Zustand). Server-authoritative settings live in
// the store behind /api/settings; this holds per-browser UI state only.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TerminalMode } from "@/lib/types";

interface TerminalState {
  mode: TerminalMode;
  setMode: (m: TerminalMode) => void;
  selectedConditionId?: string;
  selectMarket: (id?: string) => void;
  ackTerms: boolean;
  setAckTerms: (v: boolean) => void;
  feedPaused: boolean;
  setFeedPaused: (v: boolean) => void;
}

export const useTerminal = create<TerminalState>()(
  persist(
    (set) => ({
      mode: "demo",
      setMode: (mode) => set({ mode }),
      selectedConditionId: undefined,
      selectMarket: (selectedConditionId) => set({ selectedConditionId }),
      ackTerms: false,
      setAckTerms: (ackTerms) => set({ ackTerms }),
      feedPaused: false,
      setFeedPaused: (feedPaused) => set({ feedPaused }),
    }),
    {
      name: "polyquant-terminal",
      partialize: (s) => ({
        mode: s.mode === "live" ? "paper" : s.mode, // never restore into live
        ackTerms: s.ackTerms,
        selectedConditionId: s.selectedConditionId,
      }),
      // hydrate AFTER mount (see StoreHydrator in providers): synchronous
      // localStorage restore makes the client's first render differ from the
      // server HTML → React hydration errors for any user with persisted state
      skipHydration: true,
    },
  ),
);
