"use client";

import { AutopilotPanel } from "@/components/terminal/AutopilotPanel";
import { LiveFeed } from "@/components/terminal/LiveFeed";

export default function AutopilotPage() {
  return (
    <div className="space-y-2">
      <AutopilotPanel full />
      <LiveFeed className="max-h-80" />
    </div>
  );
}
