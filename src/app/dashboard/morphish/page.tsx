"use client";

// MORPHISH BOARD — power-user dashboard in the uploaded reference's layout:
// command bar, KPI + Top GEM cards, probability lattice, tail ridge,
// relationship graph, micro status strip. Every number is real normalized
// app state (or labeled SAMPLE in demo mode). Live trading cannot be
// initiated here — previews only.

import { useState } from "react";
import { CommandBar } from "@/components/morphish/CommandBar";
import { KpiCard } from "@/components/morphish/KpiCard";
import { TopGemCard } from "@/components/morphish/TopGemCard";
import { LatticePanel } from "@/components/morphish/LatticePanel";
import { RidgePanel } from "@/components/morphish/RidgePanel";
import { GraphPanel } from "@/components/morphish/GraphPanel";
import { StatusStrip } from "@/components/morphish/StatusStrip";
import { MorphishDrawer, type DrawerTarget } from "@/components/morphish/MorphishDrawer";

export default function MorphishPage() {
  const [drawer, setDrawer] = useState<DrawerTarget>(null);
  const [selectedMarket, setSelectedMarket] = useState<string | undefined>();

  const openMarket = (id: string) => {
    setSelectedMarket(id);
    setDrawer({ kind: "market", id });
  };

  return (
    <div className="space-y-2">
      <CommandBar venueScope="polymarket · kalshi · coinbase(ref)" />
      <div className="grid gap-2 xl:grid-cols-2">
        <KpiCard />
        <TopGemCard onSelect={openMarket} />
      </div>
      <LatticePanel selected={selectedMarket} onSelect={openMarket} />
      <RidgePanel selected={selectedMarket} onSelect={openMarket} />
      <GraphPanel
        onSelectMarket={openMarket}
        onSelectWallet={(id) => setDrawer({ kind: "wallet", id })}
      />
      <StatusStrip />
      <MorphishDrawer target={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}
